// AudioWorklet: plays the mono PCM the main thread renders from the TMNT sound board (sim/tmntsound.js) after every
// emulated frame. Simple FIFO: keeps ~TARGET samples of latency, silence while starved (paused / hidden tab), and
// drops the excess if the main thread runs ahead (clock drift / catch-up bursts).
// processorOptions.test (?audiotest=1): never drops, and records every sample received and every sample output
// (port message {cmd:'dump'} returns {rx, tx} Float32Arrays) so tests can check the played stream sample-for-sample.
// port message {cfg:{target,max,gain,clamp}} (spectators only, game.js wkSync): a bigger FIFO cushion for the spectator playout buffer (net/session.js SPEC_AUDIO)
// and, with gain > 0, a bounded rate nudge (linear interpolation, speed 1 +- clamp, proportional to (fill - target) / target * gain) that slowly steers the
// fill back to the target instead of dropping audio. Without a cfg (players, local play, ?audiotest=1) TARGET / MAX and the plain FIFO below apply unchanged.
'use strict';
const TARGET = 2400, MAX = 9600;
class TMNTAudio extends AudioWorkletProcessor {
  constructor(o) {
    super(); this.q = []; this.off = 0; this.n = 0; this.hold = true; this.target = TARGET; this.max = MAX; this.gain = 0; this.clamp = 0; this.frac = 0;
    this.test = !!(o && o.processorOptions && o.processorOptions.test); this.rx = []; this.tx = [];
    this.port.onmessage = e => {
      if (e.data.cfg) { this.target = e.data.cfg.target | 0 || TARGET; this.max = e.data.cfg.max | 0 || MAX; this.gain = +e.data.cfg.gain || 0; this.clamp = +e.data.cfg.clamp || 0; this.frac = 0; return; }
      if (e.data.pcm) { this.q.push(e.data.pcm); this.n += e.data.pcm.length; if (this.test) this.rx.push(e.data.pcm); }
      else if (e.data.cmd === 'dump') { const cat = a => { const o = new Float32Array(a.reduce((s, b) => s + b.length, 0)); let p = 0; for (const b of a) { o.set(b, p); p += b.length; } return o; };
        this.port.postMessage({ rx: cat(this.rx), tx: cat(this.tx), queued: this.n }); }
    };
  }
  process(inputs, outputs) {
    const L = outputs[0][0], R = outputs[0][1];
    while (!this.test && this.n > this.max) { const b = this.q[0], k = b.length - this.off; if (this.n - k < this.target) break; this.q.shift(); this.off = 0; this.n -= k; }
    if (this.hold && this.n < this.target) { L.fill(0); if (R) R.fill(0); return true; }
    this.hold = false;
    if (this.gain > 0 && !this.test) { // spectator: rate-nudged read (see above)
      const st = 1 + Math.max(-this.clamp, Math.min(this.clamp, (this.n - this.target) / this.target * this.gain));
      for (let i = 0; i < L.length; i++) {
        if (this.n < 2) { L.fill(0, i); this.hold = true; this.frac = 0; break; }
        const b = this.q[0], a = b[this.off], c = this.off + 1 < b.length ? b[this.off + 1] : this.q[1][0];
        L[i] = a + (c - a) * this.frac;
        this.frac += st; let k = Math.floor(this.frac); this.frac -= k;
        while (k > 0 && this.q.length) { const h = this.q[0], left = h.length - this.off; if (k >= left) { k -= left; this.n -= left; this.q.shift(); this.off = 0; } else { this.off += k; this.n -= k; k = 0; } }
      }
      if (R) R.set(L);
      return true;
    }
    let i = 0;
    for (; i < L.length; i++) {
      if (!this.q.length) { L.fill(0, i); this.hold = true; break; }
      const b = this.q[0]; L[i] = b[this.off++]; this.n--;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    if (this.test && i) this.tx.push(L.slice(0, i)); // only samples taken from the FIFO (not starvation silence)
    if (R) R.set(L);
    return true;
  }
}
registerProcessor('tmnt-audio', TMNTAudio);
