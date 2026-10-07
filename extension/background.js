const panelUrl = chrome.runtime.getURL("panel.html");
const offscreenUrl = chrome.runtime.getURL("offscreen.html");
const activePhases = ["loading", "recording", "finishing"];
let writes = Promise.resolve();
let starting = false;

// An action click grants activeTab; clicking inside an already-open panel does not.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});

// Offscreen pages can capture audio, but Chrome only allows native messaging in the worker.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "video-transcript-model" || port.sender?.url !== offscreenUrl) { port.disconnect(); return; }
  const native = chrome.runtime.connectNative("local.video_transcripts");
  let closed = false;
  port.onMessage.addListener(message => { if (!closed) native.postMessage(message); });
  native.onMessage.addListener(message => { if (!closed) port.postMessage(message); });
  port.onDisconnect.addListener(() => { closed = true; native.disconnect(); });
  native.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    if (closed) return;
    closed = true;
    port.postMessage({ type: "error", error: error || "The local transcription model closed unexpectedly." });
    port.disconnect();
  });
});

// Ask the native host whether the user's own model is installed. Missing host = setup not run yet.
function checkSetup() {
  return new Promise(resolve => {
    const native = chrome.runtime.connectNative("local.video_transcripts");
    let answered = false;
    const finish = result => { if (answered) return; answered = true; clearTimeout(timer); resolve(result); native.disconnect(); };
    // A stalled host must not leave the panel waiting forever.
    const timer = setTimeout(() => finish({ type: "setup", ok: false, error: "The local model helper did not answer. Run install.ps1 again." }), 30000);
    native.onMessage.addListener(finish);
    native.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || "The local model helper closed.";
      finish({ type: "setup", ok: false, error: /not found/i.test(error) ? "No local model is set up yet." : error });
    });
    native.postMessage({ type: "check" });
  });
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl]
  });
  return contexts.length > 0;
}

chrome.runtime.onStartup.addListener(async () => {
  const { session } = await chrome.storage.local.get("session");
  if (session && activePhases.includes(session.phase) && !await hasOffscreen()) {
    await chrome.storage.local.set({ session: { ...session, phase: "error", pending: 0, error: "Chrome closed during recording. Saved text is in your library; start again to capture more." } });
  }
});

async function start(language, translate = true) {
  if (!["it", "en"].includes(language)) throw new Error("Choose Italian or English.");
  if (typeof translate !== "boolean") throw new Error("Choose a valid transcription mode.");
  const { session } = await chrome.storage.local.get("session");
  if (session && activePhases.includes(session.phase)) {
    if (await hasOffscreen()) throw new Error("A video is already being transcribed.");
    await chrome.storage.local.set({ session: { ...session, phase: "error", error: "Chrome stopped the recording. Saved text is still in your library." } });
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Select the tab you want to transcribe, then open this extension from its toolbar icon.");
  if (!tab.url) throw new Error("Chrome has not granted access to this tab. Click the Video transcripts icon in the toolbar or puzzle menu while on this tab, then press Start again.");
  if (!/^https?:\/\//.test(tab.url)) throw new Error("Chrome cannot capture this page. Open a website with audio or video, then click the extension icon there.");
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["USER_MEDIA"],
    justification: "Capture the chosen video tab and send its audio to the local transcription model."
  });
  const id = crypto.randomUUID();
  const record = { id, title: tab.title || "Untitled video", url: tab.url, language, translate, createdAt: new Date().toISOString(), chunks: [] };
  await chrome.storage.local.set({
    ["record:" + id]: record,
    session: { id, phase: "loading", pending: 0, error: "", tabId: tab.id }
  });
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", id, language, translate, streamId });
    if (!response?.ok) throw new Error(response?.error || "The recorder could not start.");
  } catch (error) {
    await chrome.storage.local.set({ session: { id, phase: "error", pending: 0, error: error.message } });
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
    throw error;
  }
  return { id };
}

async function saveEvent(message) {
  const { session } = await chrome.storage.local.get("session");
  if (!session || session.id !== message.id) return;
  if (message.event === "chunk") {
    const key = "record:" + session.id;
    const { [key]: record } = await chrome.storage.local.get(key);
    if (!record) throw new Error("The saved video is missing. Recording stopped to protect your transcript.");
    record.chunks.push(message.chunk);
    await chrome.storage.local.set({ [key]: record });
  } else if (message.event === "status") {
    await chrome.storage.local.set({ session: { ...session, phase: message.phase, pending: message.pending, error: message.error || "" } });
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === "offscreen") return;
  if (sender.url === offscreenUrl && message.type === "event") {
    const saved = writes.then(() => saveEvent(message));
    writes = saved.catch(console.error);
    saved.then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (sender.url !== panelUrl) return;
  if (message.type === "check") {
    checkSetup().then(respond);
    return true;
  }
  if (message.type === "start") {
    if (starting) { respond({ ok: false, error: "The recorder is starting." }); return; }
    starting = true;
    start(message.language, message.translate)
      .then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }))
      .finally(() => { starting = false; });
    return true;
  }
  if (message.type === "stop") {
    if (starting) { respond({ ok: false, error: "The recorder is starting. Try Stop again in a moment." }); return; }
    (async () => {
      if (await hasOffscreen()) {
        const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
        if (!response?.ok) throw new Error(response?.error || "The recording could not stop.");
      } else {
        const { session } = await chrome.storage.local.get("session");
        if (session) await chrome.storage.local.set({ session: { ...session, phase: "error", pending: 0, error: "The recorder closed. Previously saved text is in your library." } });
      }
    })().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { session } = await chrome.storage.local.get("session");
  if (session?.tabId === tabId && activePhases.includes(session.phase) && await hasOffscreen()) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(console.error);
  }
});
