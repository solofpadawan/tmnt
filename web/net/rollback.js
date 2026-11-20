// Input-only rollback over the deterministic Machine (sim/tmnt.js). Transport-agnostic: the session (net.js) feeds
// remote inputs with addRemote() and calls tick() once per emulated frame.
//  - frame F = number of the next frame to simulate; snaps[F] = Machine.save() taken just before simulating F.
//  - every slot s has a window [join[s], leave[s]) in which it plays; outside it its input is 0 and needs no network.
//  - local input is scheduled DELAY frames ahead; missing remote input is predicted by repeating the slot's last known one.
//  - a remote input that differs from the prediction used -> load snaps[f] and re-simulate up to the present.
//  - confirmed C = last frame whose inputs are all known (and simulated): never rolled back again; its sound log is
//    released to the audio player (onAudio), and every HASH_EVERY frames its state hash is reported (onHash).
//    onConfirm(f, snapAfterF) is a read-only observer of each confirmed frame (net/highscore.js reads the score RAM from it).
(function (G) {
  'use strict';
  const SNAP = typeof require !== 'undefined' ? require('./snap.js') : G.TMNTSNAP;
  const NS = 4, INF = 0x7fffffff;
  function Rollback(m, o) {
    this.m = m; this.step = o.step; this.slot = o.slot; this.delay = o.delay ?? 2; this.maxRoll = o.maxRoll ?? 8;
    this.hashEvery = o.hashEvery ?? 60; this.onHash = o.onHash || null; this.onAudio = o.onAudio || null; this.onConfirm = o.onConfirm || null;
    this.stats = { frames: 0, rollbacks: 0, rolledFrames: 0, maxRollback: 0, stalls: 0, resims: 0, msSim: 0, msSave: 0, msLoad: 0 };
    this.reset(o.frame, o.join || [o.frame, INF, INF, INF], o.leave || [INF, INF, INF, INF]);
  }
  const P = Rollback.prototype;
  P.reset = function (F, join, leave) {
    this.frame = F; this.join = join.slice(); this.leave = leave.slice();
    this.inp = [new Map(), new Map(), new Map(), new Map()]; this.known = [F - 1, F - 1, F - 1, F - 1];
    this.used = new Map(); this.snaps = new Map(); this.confirmed = F - 1; this.rollTo = INF;
    this.latch = 0; this.prevLocal = 0; // rising edges waiting for a frame store() actually accepts
    for (let s = 0; s < NS; s++) this.bump(s);
  };
  P.setRoster = function (join, leave) { // host's table (join/leave frames); a change may invalidate predictions
    for (let s = 0; s < NS; s++) if (this.join[s] !== join[s] || this.leave[s] !== leave[s]) {
      const lo = Math.min(this.join[s], join[s], this.leave[s], leave[s]);
      this.join[s] = join[s]; this.leave[s] = leave[s]; this.bump(s); if (lo < this.frame) this.rollTo = Math.min(this.rollTo, Math.max(lo, this.confirmed + 1));
    }
  };
  // inputs before a slot's join frame are 0 by definition: start its contiguous 'known' run there
  P.bump = function (s) {
    if (this.join[s] !== INF && this.known[s] < this.join[s] - 1) this.known[s] = this.join[s] - 1;
    while (this.inp[s].has(this.known[s] + 1)) this.known[s]++;
  };
  P.active = function (s, f) { return f >= this.join[s] && f < this.leave[s]; };
  P.knownTo = function (s) { // all inputs of s up to this frame are final
    if (this.leave[s] !== INF && this.known[s] >= this.leave[s] - 1) return INF;
    if (this.join[s] === INF) return INF;
    return Math.max(this.known[s], this.join[s] - 1);
  };
  P.input = function (s, f) {
    if (!this.active(s, f)) return 0;
    const v = this.inp[s].get(f); if (v !== undefined) return v;
    const k = this.known[s]; return k >= this.join[s] ? (this.inp[s].get(k) ?? 0) : 0;
  };
  P.store = function (s, f, v) {
    if (f <= this.confirmed || this.inp[s].has(f)) return false;
    this.inp[s].set(f, v & 0xff);
    while (this.inp[s].has(this.known[s] + 1)) this.known[s]++;
    const u = this.used.get(f); if (u && u[s] !== (this.active(s, f) ? (v & 0xff) : 0)) this.rollTo = Math.min(this.rollTo, f);
    return true;
  };
  P.addRemote = function (s, f0, bytes) { for (let i = 0; i < bytes.length; i++) this.store(s, f0 + i, bytes[i]); };
  // One local sample. Rising edges stay latched until store() inserts a frame, then land on that first
  // frame only. After the horizon exists, each call schedules a single new frame: growing `delay` must not
  // copy one tap across the frames that later samples will fill. The first call (nothing scheduled yet)
  // still fills [frame, frame+delay] so prediction has a real buffer.
  P.addLocal = function (v) {
    const s = this.slot; if (s < 0) return false;
    v &= 0xff;
    const rise = v & ~this.prevLocal; this.prevLocal = v;
    if (rise) this.latch = (this.latch | rise) & 0xff;
    const t = this.frame + this.delay;
    let f = Math.max(this.known[s] + 1, this.frame);
    if (f > t) return false;
    const end = this.known[s] < this.frame ? t : f;
    let placed = false;
    for (; f <= end; f++) {
      const out = placed ? v : ((v | this.latch) & 0xff);
      if (!this.store(s, f, out)) continue;
      if (!placed) this.latch = 0;
      placed = true;
    }
    return placed;
  };
  P.sim = function (f) {
    let t = performance.now(); this.snaps.set(f, this.m.save()); this.stats.msSave += performance.now() - t;
    const fi = new Uint8Array(NS); for (let s = 0; s < NS; s++) fi[s] = this.input(s, f);
    this.used.set(f, fi); t = performance.now(); this.step(fi, f); this.stats.msSim += performance.now() - t;
  };
  P.canAdvance = function () { return this.frame - this.confirmed <= this.maxRoll; };
  // simulate frame `frame` (after any pending rollback); returns false on a stall (too far ahead of confirmed input)
  P.advance = function () {
    this.doRollback();
    if (!this.canAdvance()) { this.stats.stalls++; this.confirm(); return false; }
    this.sim(this.frame++); this.stats.frames++; this.confirm(); return true;
  };
  P.doRollback = function () {
    if (this.rollTo >= this.frame) { this.rollTo = INF; return; }
    const f0 = this.rollTo, n = this.frame - f0; this.rollTo = INF;
    let t = performance.now(); this.m.load(this.snaps.get(f0)); this.stats.msLoad += performance.now() - t;
    for (let f = f0; f < this.frame; f++) this.sim(f);
    this.stats.rollbacks++; this.stats.rolledFrames += n; this.stats.maxRollback = Math.max(this.stats.maxRollback, n);
  };
  P.confirm = function () {
    let c = this.frame - 2; for (let s = 0; s < NS; s++) c = Math.min(c, this.knownTo(s));
    if (this.rollTo !== INF) c = Math.min(c, this.rollTo - 1);
    while (this.confirmed < c) {
      const f = ++this.confirmed, after = this.snaps.get(f + 1);
      if (this.onHash && f % this.hashEvery === 0) this.onHash(f, SNAP.hash(after));
      if (this.onAudio) this.onAudio(after);
      if (this.onConfirm) { try { this.onConfirm(f, after); } catch (e) { console.warn('onConfirm', e); } } // read-only observer of the confirmed state (online highscore report, net/highscore.js)
      this.snaps.delete(f); this.used.delete(f);
      for (let s = 0; s < NS; s++) if (this.inp[s].has(f - 64)) this.inp[s].delete(f - 64);
    }
  };
  // a guest's full-state reload: state = snaps[F] of the host, inputs from the host, own inputs kept
  P.loadState = function (F, snap, join, leave, inputs) {
    const mine = []; if (this.slot >= 0) for (const [f, v] of this.inp[this.slot]) if (f >= F) mine.push([f, v]);
    this.m.load(snap); if (this.m.snd && snap.snd) this.m.snd.rebase(snap.snd.nlog);
    this.reset(F, join, leave);
    for (let s = 0; s < NS; s++) if (inputs[s]) this.addRemote(s, inputs[s][0], inputs[s][1]);
    for (const [f, v] of mine) this.store(this.slot, f, v);
    if (mine.length) this.prevLocal = mine[mine.length - 1][1] & 0xff; // a held button must not look like a fresh edge
  };
  // the host's state for a (re)joining guest: the oldest kept snapshot (confirmed + 1) and all inputs since
  P.exportState = function () {
    const F = this.confirmed + 1, inputs = [];
    for (let s = 0; s < NS; s++) { const b = []; for (let f = F; f <= this.known[s]; f++) b.push(this.inp[s].get(f) ?? 0); inputs.push([F, b]); }
    return { F, snap: this.snaps.get(F) || this.m.save(), join: this.join.slice(), leave: this.leave.slice(), inputs };
  };
  // inputs of slot s from frame f0 (for sending), at most n
  P.range = function (s, f0, n) { const b = []; for (let f = f0; f <= this.known[s] && b.length < n; f++) b.push(this.inp[s].get(f) ?? 0); return b; };
  const api = { Rollback, INF };
  if (typeof module !== 'undefined') module.exports = api; else G.TMNTROLL = api;
})(typeof window !== 'undefined' ? window : globalThis);
