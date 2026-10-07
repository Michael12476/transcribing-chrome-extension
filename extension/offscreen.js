let recording = null;

function encodeAudio(audio) {
  const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

async function event(state, data) {
  const response = await chrome.runtime.sendMessage({ type: "event", id: state.id, ...data });
  if (!response?.ok) throw new Error(response?.error || "Chrome could not save the transcript.");
}

function status(state, phase) {
  return event(state, { event: "status", phase, pending: state.queue.length + Number(state.busy), error: state.error });
}

function releaseAudio(state) {
  state.stream?.getTracks().forEach(track => track.stop());
  state.node?.disconnect();
  state.context?.close().catch(console.error);
  state.playback?.close().catch(console.error);
}

async function fail(state, error) {
  if (state.failed) return;
  state.failed = true;
  state.error = error.message || String(error);
  releaseAudio(state);
  state.port?.disconnect();
  await status(state, "error").catch(console.error);
  recording = null;
}

async function pump(state) {
  if (state.failed || state.busy || !state.ready) return;
  if (!state.queue.length) {
    if (state.stopped) {
      await status(state, state.error ? "error" : "saved");
      state.completed = true;
      state.port.disconnect();
      recording = null;
    }
    return;
  }
  state.busy = true;
  state.current = state.queue.shift();
  state.port.postMessage({ type: "audio", pcm: encodeAudio(state.current.audio), offset: state.current.offset });
  await status(state, state.stopping ? "finishing" : "recording");
}

async function stop(state) {
  if (state.stopping) return;
  state.stopping = true;
  await status(state, "finishing");
  if (state.node) state.node.port.postMessage("stop");
  else {
    state.stopped = true;
    releaseAudio(state);
    if (!state.ready) { state.completed = true; state.port?.disconnect(); recording = null; await status(state, "saved"); }
    else await pump(state);
  }
}

async function start(message) {
  if (recording) throw new Error("A video is already being recorded.");
  const state = { id: message.id, language: message.language, queue: [], busy: false, ready: false, stopping: false, stopped: false, error: "" };
  recording = state;
  try {
    state.port = chrome.runtime.connect({ name: "video-transcript-model" });
    state.port.onDisconnect.addListener(() => {
      const nativeError = chrome.runtime.lastError?.message;
      if (!state.completed && !state.failed) fail(state, new Error(nativeError || "The local model closed unexpectedly. Run install.ps1 again, then retry."));
    });
    state.port.onMessage.addListener(message => {
      (async () => {
        if (state.failed) return;
        if (message.type === "error") throw new Error(message.error);
        if (message.type === "ready") {
          state.ready = true;
          await status(state, state.stopping ? "finishing" : "recording");
          await pump(state);
        } else if (message.type === "result") {
          await event(state, { event: "chunk", chunk: { offset: message.offset, duration: message.duration, original: message.original, translation: message.translation } });
          state.busy = false;
          await status(state, state.stopping ? "finishing" : "recording");
          await pump(state);
        }
      })().catch(error => fail(state, error));
    });
    state.port.postMessage({ type: "init", language: state.language, translate: message.translate });
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: message.streamId } }, video: false
    });
    if (state.failed || state.stopping) { releaseAudio(state); return; }
    // Chrome mutes the captured tab. This connection preserves normal playback.
    state.playback = new AudioContext();
    state.playback.createMediaStreamSource(state.stream).connect(state.playback.destination);
    state.context = new AudioContext({ sampleRate: 16000 });
    const source = state.context.createMediaStreamSource(state.stream);
    await state.context.audioWorklet.addModule("audio-worklet.js");
    if (state.failed || state.stopping) { releaseAudio(state); return; }
    state.node = new AudioWorkletNode(state.context, "video-audio");
    const mute = state.context.createGain();
    mute.gain.value = 0;
    source.connect(state.node).connect(mute).connect(state.context.destination);
    state.node.port.onmessage = ({ data }) => {
      (async () => {
        if (state.failed) return;
        if (data.stopped) {
          state.stopped = true;
          releaseAudio(state);
          await pump(state);
          return;
        }
        state.queue.push(data);
        if (state.queue.length >= 12 && !state.stopping) {
          state.error = "The model fell behind. Recording stopped; captured audio is being saved. Play more slowly for the next recording.";
          await stop(state);
        }
        await pump(state);
      })().catch(error => fail(state, error));
    };
    state.stream.getAudioTracks()[0].addEventListener("ended", () => stop(state).catch(error => fail(state, error)));
    await Promise.all([state.context.resume(), state.playback.resume()]);
  } catch (error) {
    await fail(state, error);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
  const operation = message.type === "start" ? start(message) : message.type === "stop" && recording ? stop(recording) : Promise.resolve();
  operation.then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
  return true;
});
