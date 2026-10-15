const $ = id => document.getElementById(id);
const activePhases = ["loading", "recording", "finishing"];
let records = [];
let selected = null;
let session = null;
let requesting = false;
let commandError = "";
let setup = null;
let revealedSelection = null;

function languageName(code) { return code === "it" ? "Italian" : "English"; }
function translatedLanguage(code) { return code === "it" ? "en" : "it"; }
function currentRecord() { return records.find(record => record.id === selected); }
function showError(message) { $("error").textContent = message; $("error").hidden = !message; }

// Scroll only the library box, and only when the selection changes, so live updates don't fight the user's scrolling.
function revealSelectedVideo() {
  const library = $("library");
  const row = library.querySelector('[aria-pressed="true"]');
  if (!row || selected === revealedSelection) return;
  revealedSelection = selected;
  if (row.offsetTop < library.scrollTop) library.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > library.scrollTop + library.clientHeight) library.scrollTop = row.offsetTop + row.offsetHeight - library.clientHeight;
}

function render() {
  const active = session && activePhases.includes(session.phase);
  const translating = records.find(record => record.id === session?.id)?.translate !== false;
  $("start").hidden = Boolean(active);
  $("start").disabled = requesting || !setup?.ok;
  $("setup").hidden = !setup || setup.ok;
  $("setup-detail").textContent = setup?.error || "";
  $("language").disabled = Boolean(active) || requesting;
  $("stop").hidden = !active;
  $("stop").disabled = requesting || session?.phase === "finishing";
  const labels = {
    loading: `Loading your local ${translating ? "models" : "transcription model"}. Keep the audio playing; it is being captured.`,
    recording: `${translating ? "Transcribing and translating" : "Transcribing English"}. Everything is saved automatically.`,
    finishing: "Finishing captured audio. You can close this panel.",
    saved: "Saved to your video library.",
    error: "Recording stopped. Previously saved text is in your library."
  };
  $("status").textContent = labels[session?.phase] || "Open audio or video, then start. Text is saved automatically.";
  if (session?.pending > 1 && active) $("status").textContent += ` ${session.pending} audio clips waiting.`;
  showError(commandError || session?.error || "");
  $("count").textContent = records.length;
  const query = $("search").value.toLocaleLowerCase();
  const filtered = records.filter(record => record.title.toLocaleLowerCase().includes(query));
  const focusedVideo = document.activeElement?.dataset.recordId;
  const libraryScroll = $("library").scrollTop;
  $("library").replaceChildren();
  for (const record of filtered) {
    const button = document.createElement("button");
    button.className = "video";
    button.dataset.recordId = record.id;
    button.setAttribute("aria-pressed", String(record.id === selected));
    const title = document.createElement("strong");
    title.textContent = record.title;
    const meta = document.createElement("span");
    const mode = record.translate === false ? `${languageName(record.language)} transcript` : `${languageName(record.language)} → ${languageName(translatedLanguage(record.language))}`;
    meta.textContent = `${mode} · ${new Date(record.createdAt).toLocaleDateString()}`;
    button.append(title, meta);
    button.addEventListener("click", () => { selected = record.id; render(); });
    $("library").append(button);
    if (record.id === focusedVideo) button.focus({ preventScroll: true });
  }
  $("library").scrollTop = libraryScroll;
  revealSelectedVideo();
  $("empty").hidden = filtered.length > 0;
  $("empty").textContent = records.length ? "No videos match your search." : "Your transcripts will live here. Open a saved video to read its text.";
  const record = currentRecord();
  $("detail").hidden = !record;
  if (!record) return;
  $("video-title").textContent = record.title;
  $("video-meta").textContent = new Date(record.createdAt).toLocaleString();
  $("original-label").textContent = `${languageName(record.language)} · ${record.translate === false ? "Transcript" : "Original"}`;
  $("translation-section").hidden = record.translate === false;
  $("translation-label").textContent = `${languageName(translatedLanguage(record.language))} · Translation`;
  $("original").lang = record.language;
  $("translation").lang = translatedLanguage(record.language);
  $("original").textContent = record.chunks.map(chunk => chunk.original).filter(Boolean).join("\n\n") || "Waiting for speech…";
  $("translation").textContent = record.chunks.map(chunk => chunk.translation).filter(Boolean).join("\n\n") || "The translation will appear here.";
  $("delete").disabled = Boolean(active && session.id === record.id);
  $("download").disabled = !record.chunks.some(chunk => chunk.original);
}

async function refresh() {
  const storage = await chrome.storage.local.get(null);
  records = Object.entries(storage).filter(([key]) => key.startsWith("record:")).map(([, record]) => record)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  session = storage.session;
  if (!records.some(record => record.id === selected)) selected = records[0]?.id || null;
  render();
}

async function command(type) {
  commandError = "";
  requesting = true;
  render();
  try {
    const mode = $("language").value;
    const response = await chrome.runtime.sendMessage({ type, language: mode === "en-only" ? "en" : mode, translate: mode !== "en-only" });
    if (!response?.ok) throw new Error(response?.error || "Chrome could not reach the recorder.");
    if (response.id) selected = response.id;
    await refresh();
  } catch (error) { commandError = error.message; }
  finally { requesting = false; render(); }
}

async function checkSetup() {
  $("recheck").disabled = true;
  try { setup = await chrome.runtime.sendMessage({ type: "check" }); }
  catch (error) { setup = { ok: false, error: error.message }; }
  finally { $("recheck").disabled = false; render(); }
}

$("recheck").addEventListener("click", checkSetup);
$("start").addEventListener("click", () => command("start"));
$("stop").addEventListener("click", () => command("stop"));
$("search").addEventListener("input", render);
$("delete").addEventListener("click", async () => {
  const record = currentRecord();
  if (!record || !confirm(`Delete "${record.title}" and its saved text?`)) return;
  try { await chrome.storage.local.remove("record:" + record.id); await refresh(); }
  catch (error) { showError(error.message); }
});
$("download").addEventListener("click", () => {
  const record = currentRecord();
  if (!record) return;
  let text = `${record.title}\n${record.url}\n\n${languageName(record.language)} ${record.translate === false ? "transcript" : "original"}\n\n${record.chunks.map(chunk => chunk.original).filter(Boolean).join("\n\n")}\n`;
  if (record.translate !== false) text += `\n${languageName(translatedLanguage(record.language))} translation\n\n${record.chunks.map(chunk => chunk.translation).filter(Boolean).join("\n\n")}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${record.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "video-transcript"}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") refresh().catch(error => showError(error.message)); });
refresh().catch(error => showError(error.message));
checkSetup();
