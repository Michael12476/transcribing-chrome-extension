// Node's standard library only. Checks saved text and the audio recorder's final partial chunk.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function checkStorage() {
  let listener;
  let connect;
  let startup;
  let actionClick;
  let openedWindow;
  let panelBehavior;
  let offscreenCreated = 0;
  let activeTab = { id: 42, windowId: 7, title: "Audio-only sample", url: "http://127.0.0.1:8876/" };
  const loggedErrors = [];
  const timers = [];
  const storage = { session: { id: "video", phase: "recording" }, "record:video": { id: "video", chunks: [] } };
  const get = async key => structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, storage[k]])));
  const chrome = {
    runtime: { getURL: file => "chrome-extension://test/" + file, getContexts: async () => [],
      onStartup: { addListener: fn => { startup = fn; } },
      onMessage: { addListener: fn => { listener = fn; } }, onConnect: { addListener: fn => { connect = fn; } } },
    action: { onClicked: { addListener: fn => { actionClick = fn; } } },
    sidePanel: { setPanelBehavior: async options => { panelBehavior = options; }, open: async options => { openedWindow = options.windowId; } },
    storage: { local: { get, set: async values => Object.assign(storage, structuredClone(values)) } },
    tabs: { query: async () => [activeTab], onRemoved: { addListener: () => {} } },
    offscreen: { createDocument: async () => { offscreenCreated++; } },
    tabCapture: { getMediaStreamId: async options => { assert.equal(options.targetTabId, 42); return "stream"; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "extension/background.js"), "utf8"), { chrome, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, crypto: require("node:crypto").webcrypto, console: { ...console, error: error => loggedErrors.push(error) } });
  function port(name, url) {
    return { name, sender: { url }, messages: [], postMessage(message) { this.messages.push(message); },
      disconnect() { this.closed = true; this.disconnectHandler?.(); },
      onMessage: { addListener(fn) { this.receive = fn; } },
      onDisconnect: { addListener(fn) { this.receive = fn; } } };
  }
  const forbidden = port("video-transcript-model", "https://example.com");
  connect(forbidden);
  assert.equal(forbidden.closed, true);
  const native = port();
  chrome.runtime.connectNative = name => { assert.equal(name, "local.video_transcripts"); return native; };
  const recorder = port("video-transcript-model", "chrome-extension://test/offscreen.html");
  connect(recorder);
  recorder.onMessage.receive({ type: "init", language: "it" });
  assert.equal(native.messages[0].language, "it");
  native.onMessage.receive({ type: "ready" });
  assert.equal(recorder.messages[0].type, "ready");
  recorder.onDisconnect.receive();
  assert.equal(native.closed, true);
  const send = (message, url = "chrome-extension://test/offscreen.html") => new Promise(resolve => {
    const handled = listener(message, { url }, resolve);
    if (!handled) resolve(undefined);
  });
  assert.equal(panelBehavior.openPanelOnActionClick, false);
  actionClick(activeTab);
  assert.equal(openedWindow, 7);
  assert.equal(await send({ type: "event", event: "chunk", id: "video", chunk: { original: "bad" } }, "https://example.com"), undefined);
  await Promise.all([
    send({ type: "event", event: "chunk", id: "video", chunk: { original: "Ciao", translation: "Hello" } }),
    send({ type: "event", event: "chunk", id: "video", chunk: { original: "Come stai?", translation: "How are you?" } }),
    send({ type: "event", event: "chunk", id: "old-video", chunk: { original: "ignored" } })
  ]);
  assert.equal(storage["record:video"].chunks.length, 2);
  assert.equal(storage["record:video"].chunks[1].translation, "How are you?");
  await startup();
  assert.equal(storage.session.phase, "error");
  assert.equal(storage["record:video"].chunks.length, 2);
  await send({ type: "event", event: "status", id: "video", phase: "saved", pending: 0 });
  assert.equal(storage.session.phase, "saved");
  delete storage["record:video"];
  assert.equal((await send({ type: "event", event: "chunk", id: "video", chunk: {} })).ok, false);
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0].message, /saved video is missing/);
  delete storage.session;
  const panel = "chrome-extension://test/panel.html";
  activeTab = { id: 42 }; // Chrome hides the URL before activeTab is granted.
  assert.match((await send({ type: "start", language: "en" }, panel)).error, /not granted access/);
  // Let the worker's finally reset starting before the next simulated message.
  await new Promise(resolve => setImmediate(resolve));
  // Without install.ps1, Chrome cannot find the host and the panel must show the setup steps.
  const missingHost = port();
  chrome.runtime.connectNative = () => missingHost;
  const checking = send({ type: "check" }, panel);
  assert.equal(JSON.stringify(missingHost.messages), JSON.stringify([{ type: "check" }]));
  chrome.runtime.lastError = { message: "Specified native messaging host not found." };
  missingHost.onDisconnect.receive();
  delete chrome.runtime.lastError;
  assert.equal(JSON.stringify(await checking), JSON.stringify({ type: "setup", ok: false, error: "No local model is set up yet." }));
  // A host that never answers must time out instead of leaving Start disabled forever.
  const stalledHost = port();
  chrome.runtime.connectNative = () => stalledHost;
  const stalled = send({ type: "check" }, panel);
  timers.at(-1)();
  assert.match((await stalled).error, /did not answer/);
  assert.equal(stalledHost.closed, true);
  activeTab = { id: 42, url: "chrome://extensions/" };
  assert.match((await send({ type: "start", language: "en" }, panel)).error, /cannot capture this page/);
  assert.equal(offscreenCreated, 0);
  assert.equal(storage.session, undefined);
  await new Promise(resolve => setImmediate(resolve));
  activeTab = { id: 42, title: "Audio-only sample", url: "http://127.0.0.1:8876/" };
  chrome.runtime.sendMessage = async message => {
    assert.equal(message.streamId, "stream");
    assert.equal(message.translate, true);
    return { ok: true };
  };
  const started = await send({ type: "start", language: "en" }, panel);
  assert.equal(started.ok, true);
  assert.equal(offscreenCreated, 1);
  assert.equal(storage["record:" + started.id].title, "Audio-only sample");
  assert.equal(storage.session.tabId, 42);
  assert.equal(storage["record:" + started.id].translate, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await send({ type: "start", language: "en", translate: "false" }, panel)).error, /valid transcription mode/);
  await new Promise(resolve => setImmediate(resolve));
  delete storage.session;
  chrome.runtime.sendMessage = async message => {
    assert.equal(message.language, "en");
    assert.equal(message.translate, false);
    return { ok: true };
  };
  const transcript = await send({ type: "start", language: "en", translate: false }, panel);
  assert.equal(transcript.ok, true);
  await send({ type: "event", event: "chunk", id: transcript.id, chunk: { original: "Hello", translation: "" } });
  await send({ type: "event", event: "status", id: transcript.id, phase: "saved", pending: 0 });
  assert.equal(storage["record:" + transcript.id].translate, false);
  assert.equal(storage["record:" + transcript.id].chunks[0].original, "Hello");
  assert.equal(storage.session.phase, "saved");
}

async function checkRecorder(translate) {
  let listener;
  const events = [];
  const ports = [];
  const contexts = [];
  const track = { stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  class Context {
    constructor(options) { this.sampleRate = options?.sampleRate || 48000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; contexts.push(this); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  let worklet;
  class Worklet {
    constructor() {
      worklet = this;
      Object.assign(this, node());
      this.port = { postMessage: command => {
        if (command === "stop") {
          this.port.onmessage({ data: { audio: new Float32Array(8000), offset: 2 } });
          this.port.onmessage({ data: { stopped: true } });
        }
      } };
    }
  }
  const chrome = { runtime: {
    id: "test", onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async message => { events.push(message); return { ok: true }; },
    connect: options => {
      assert.equal(options.name, "video-transcript-model");
      const port = { sent: [], postMessage(message) { this.sent.push(message); }, disconnect() { this.closed = true; },
        onMessage: { addListener(fn) { this.receive = fn; } }, onDisconnect: { addListener(fn) { this.receive = fn; } } };
      ports.push(port);
      return port;
    }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "extension/offscreen.js"), "utf8"), {
    chrome, console, navigator: { mediaDevices: { getUserMedia: async () => stream } },
    AudioContext: Context, AudioWorkletNode: Worklet, Uint8Array, btoa: value => Buffer.from(value, "binary").toString("base64")
  });
  const send = message => new Promise(resolve => listener({ target: "offscreen", ...message }, { id: "test" }, resolve));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  assert.equal((await send({ type: "start", id: "one", language: "en", translate, streamId: "stream" })).ok, true);
  assert.equal(contexts[0].sampleRate, 48000);
  assert.equal(contexts[1].sampleRate, 16000);
  const model = ports[0];
  assert.equal(model.sent[0].type, "init");
  assert.equal(model.sent[0].translate, translate);
  model.onMessage.receive({ type: "ready" });
  await tick();
  worklet.port.onmessage({ data: { audio: new Float32Array(32000), offset: 0 } });
  await tick();
  assert.equal(model.sent[1].type, "audio");
  await send({ type: "stop" });
  await tick();
  assert.equal(model.sent.length, 2); // The partial clip waits for the active inference.
  model.onMessage.receive({ type: "result", offset: 0, duration: 2, original: "Hello", translation: "Ciao" });
  await tick();
  assert.equal(model.sent[2].offset, 2);
  model.onMessage.receive({ type: "result", offset: 2, duration: 0.5, original: "Thanks", translation: "Grazie" });
  await tick();
  assert.equal(events.filter(message => message.event === "chunk").length, 2);
  assert.equal(events.at(-1).phase, "saved");
  assert.equal(model.closed, true);
  assert.equal(track.stopped, true);
  assert.ok(contexts.every(context => context.closed));
}

function checkAudio() {
  let Processor;
  class Base { constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(message) }; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "extension/audio-worklet.js"), "utf8"), {
    AudioWorkletProcessor: Base, sampleRate: 16000, Float32Array,
    registerProcessor: (_name, type) => { Processor = type; }
  });
  const processor = new Processor();
  const frame = new Float32Array(128).fill(0.2);
  for (let i = 0; i < 1000; i++) processor.process([[frame, frame]]);
  assert.equal(processor.messages.length, 1);
  assert.equal(processor.messages[0].audio.length, 128000);
  assert.equal(processor.messages[0].offset, 0);
  processor.process([[frame, frame]]);
  processor.port.onmessage({ data: "stop" });
  assert.equal(processor.messages[1].audio.length, 128);
  assert.equal(processor.messages[1].offset, 8);
  assert.equal(processor.messages[2].stopped, true);
  processor.process([[frame, frame]]);
  assert.equal(processor.messages.length, 3);
}

(async () => {
  await checkStorage();
  checkAudio();
  await checkRecorder(true);
  await checkRecorder(false);
  console.log("Native relay, saved transcript, full-quality playback, audio timing, and final clip save checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
