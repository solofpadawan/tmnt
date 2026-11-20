// Mic voice-activity detector, off the main thread. Same rules as voice.js AnalyserNode fallback:
// RMS over ~1024 samples, adaptive floor (thr = max(0.015, 3*floor), floor += 0.02 of the quiet RMS
// about every 25 ms), 300 ms hangover. Posts {rms, on, changed} to the Voice instance, which is the
// only place that may call replaceTrack / the DataChannel. Fallback: voice.js keeps the setInterval path
// if AudioWorklet is missing or addModule fails.
'use strict';
const VAD_MIN = 0.015, VAD_HANG = 300, TARGET = 1024;
class TmntVad extends AudioWorkletProcessor {
  constructor() {
    super();
    this.floor = 0; this.lastVoice = 0; this.speaking = false;
    this.acc = 0; this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      let s = 0; for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
      this.acc += s; this.n += ch.length;
    }
    if (this.n < TARGET) return true;
    const rms = Math.sqrt(this.acc / this.n);
    this.acc = 0; this.n = 0;
    const t = currentTime * 1000;
    const thr = Math.max(VAD_MIN, this.floor * 3);
    let on = this.speaking;
    if (rms > thr) { this.lastVoice = t; on = true; }
    else {
      this.floor = this.floor ? this.floor * 0.98 + rms * 0.02 : rms;
      if (t - this.lastVoice > VAD_HANG) on = false;
    }
    const changed = on !== this.speaking;
    this.speaking = on;
    this.port.postMessage({ rms, on, changed });
    return true;
  }
}
registerProcessor('tmnt-vad', TmntVad);
