class VideoAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(sampleRate * 8);
    this.length = 0;
    this.offset = 0;
    this.quiet = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ stopped: true });
      }
    };
  }

  flush() {
    if (!this.length) return;
    const audio = this.buffer.slice(0, this.length);
    this.port.postMessage({ audio, offset: this.offset / sampleRate }, [audio.buffer]);
    this.offset += this.length;
    this.length = 0;
    this.quiet = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (this.stopped || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.buffer[this.length++] = value;
      this.quiet = Math.abs(value) < 0.006 ? this.quiet + 1 : 0;
      // ponytail: noisy speech may split at 8 seconds; add overlap if clipped words become a problem.
      if (this.length === this.buffer.length || (this.length >= sampleRate * 2 && this.quiet >= sampleRate * 0.35)) this.flush();
    }
    return true;
  }
}
registerProcessor("video-audio", VideoAudio);
