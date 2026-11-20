// Netplay session (star topology: every guest talks only to the host, who relays inputs). Transport-agnostic: a link
// is { send(obj, reliable), onmsg(obj), onclose(), close() } (see link.js); the game loop calls tick(localInput).
// Host: slot 0, owns the roster (join/leave frame per slot) and the reference state hashes; a guest that joins
// (or desyncs) gets the host's confirmed snapshot. Guests keep their frame near the host's estimated frame.
(function (G) {
  'use strict';
  const NODE = typeof require !== 'undefined';
  const RB = NODE ? require('./rollback.js') : G.TMNTROLL, SNAP = NODE ? require('./snap.js') : G.TMNTSNAP;
  const { Rollback, INF } = RB, NS = 4, MAXSPEC = 4;
  const now = () => performance.now();
  // Chat (outside the simulation: never touches the rollback inputs, snapshots or hashes). Plain text only, 60 chars.
  const CHAT_MAX = 60, CHAT_GAP = 700, CHAT_WIN = 10000, CHAT_PER_WIN = 5;
  function sanitize(t) { return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX).trim(); }
  const NICK_MAX = 12;
  // Default display names: use i18next when available (browser), else keep pt-BR (node tests / old clients).
  function i18nName(key, fallback, opts) {
    try {
      const tt = (typeof globalThis !== 'undefined' && globalThis.SSRI18N && globalThis.SSRI18N.tOr) ? globalThis.SSRI18N.tOr
        : (typeof G !== 'undefined' && G.SSRI18N && G.SSRI18N.tOr) ? G.SSRI18N.tOr : null;
      if (tt) return tt(key, fallback, opts);
      if (typeof globalThis !== 'undefined' && typeof globalThis.t === 'function' && globalThis.SSRI18N && globalThis.SSRI18N.ready)
        return globalThis.t(key, opts);
    } catch (e) {}
    return fallback;
  }

  function cleanNick(t) { return sanitize(t).replace(/[^\p{L}\p{N} _.!?'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NICK_MAX).trim(); }
  function RateLimit() { this.t = []; }
  RateLimit.prototype.ok = function (t) { this.t = this.t.filter(x => t - x < CHAT_WIN); if (this.t.length >= CHAT_PER_WIN || (this.t.length && t - this.t[this.t.length - 1] < CHAT_GAP)) return false; this.t.push(t); return true; };
  // Input delay, in frames. Adaptive: one-way lag plus two frames of margin, clamped. ?delay=N pins a client
  // (delayOption) and that client neither follows nor advertises. The host picks the max of its own measurement
  // and each seated guest's advertised want; guests copy the host's `dy` so every player schedules the same horizon.
  const DELAY_MIN = 2, DELAY_MAX = 24, DELAY_HOLD_MS = 2000;
  function delayFromRtt(rtt, step) {
    const s = step || (1000 / 59.1856);
    if (!(rtt > 0) || !(s > 0)) return DELAY_MIN;
    return Math.max(DELAY_MIN, Math.min(DELAY_MAX, Math.round((rtt / 2) / s) + DELAY_MIN));
  }
  function delayOption(raw) {
    if (raw === undefined || raw === null || raw === '') return { explicitDelay: false, delay: DELAY_MIN };
    const n = +raw;
    if (!Number.isFinite(n)) return { explicitDelay: false, delay: DELAY_MIN };
    return { explicitDelay: true, delay: Math.max(0, Math.min(DELAY_MAX, n | 0)) };
  }
  const b64 = { enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
    dec(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; } };
  function Session(o) {
    this.m = o.m; this.step = o.step; this.role = o.role; this.STEP = o.stepMs || 1000 / 59.1856;
    this.explicitDelay = !!o.explicitDelay; this.watch = !!o.watch; this._delayDropAt = 0;
    const pinned = delayOption(this.explicitDelay ? String(o.delay ?? DELAY_MIN) : '');
    this.delay = this.explicitDelay ? pinned.delay : (o.delay ?? DELAY_MIN);
    this.maxRoll = o.maxRoll != null ? o.maxRoll : (this.explicitDelay ? 8 : Math.max(8, this.delay + 8));
    this.hashEvery = o.hashEvery ?? 60; this.joinLead = o.joinLead ?? 30;
    this.name = cleanNick(o.name || ''); this.links = []; this.rb = null; this.slot = -1; this.ev = o.onEvent || (() => {}); this.audio = o.onAudio || null; this.ext = o.ext || null; // ext(): extra state sent with a full state (TMNT: the sound board)
    this.chatRl = [new RateLimit(), new RateLimit(), new RateLimit(), new RateLimit()];
    this.hashes = new Map(); this.stats = { resyncs: 0, desyncs: 0, hashChecks: 0, sent: 0, recv: 0, bytesState: 0, specDesyncs: 0, specHashChecks: 0 };
    // spectators (pt40u): no input slot (slot -1), simulate only fully confirmed frames; host caps them at MAXSPEC
    this.wasSpec = !!o.watch; this.onConfirmed = null; // wasSpec: ever a spectator (never reports a highscore); onConfirmed(f, snap): read-only observer of confirmed frames (net/highscore.js)
    this.spec = false; this.vaga = false; this.specList = []; this.specRl = new RateLimit(); this.nextSid = 1;
    if (this.role === 'host') this.startRb(o.frame, 0, [o.frame, INF, INF, INF], [INF, INF, INF, INF]);
  }
  const P = Session.prototype;
  P.startRb = function (F, slot, join, leave) {
    this.slot = slot;
    this.rb = new Rollback(this.m, { step: this.step, slot, delay: this.delay, maxRoll: this.maxRoll, hashEvery: this.hashEvery, frame: F, join, leave,
      onHash: (f, h) => this.onHash(f, h), onAudio: s => this.audio && this.audio(s), onConfirm: (f, snap) => this.onConfirmed && this.onConfirmed(f, snap) });
  };
  P.addLink = function (link) {
    const L = { link, slot: -1, spec: false, sid: 0, rl: null, hc: 0, dc: 0, ack: [-1, -1, -1, -1], rtt: 0, want: 0, f: 0, fT: 0, lastPing: 0, echo: 0, echoT: 0, lastState: -1e9, name: '' };
    this.links.push(L);
    if (this.voice) this.voice.onLink && this.voice.onLink(L);
    link.onmsg = msg => this.onMsg(L, msg);
    link.onclose = () => this.drop(L);
    if (this.role === 'guest') link.send(this.watch ? { t: 'hello', name: this.name || '', watch: 1 } : { t: 'hello', name: this.name || '' }, true);
    return L;
  };
  P.drop = function (L) {
    const i = this.links.indexOf(L); if (i < 0) return; this.links.splice(i, 1); this.invalidateNames();
    if (this.voice) try { this.voice.onDrop(L); } catch (e) { console.warn('voice', e); }
    if (this.role === 'host' && L.slot > 0 && this.rb) {
      const rb = this.rb, leave = rb.leave.slice(); leave[L.slot] = Math.max(rb.known[L.slot] + 1, rb.join[L.slot]); rb.setRoster(rb.join, leave);
    }
    if (this.role === 'host' && L.spec) { this.ev({ t: 'specleft', name: L.name }); this.sendWho(); return; }
    this.ev({ t: this.role === 'host' ? 'left' : 'hostgone', slot: L.slot });
    if (this.role === 'host') this.sendWho();
  };
  // host: spectator names to everyone (reliable, on change)
  // nicknames per slot (host: own name + links; guest: from the host's 'who')
  P.invalidateNames = function () { this._names = null; this.namesGen = (this.namesGen | 0) + 1; };
  P.names = function () {
    if (this.role !== 'host') return this.nameList || ['', '', '', ''];
    if (this._names) return this._names;
    const n = [this.name || i18nName('net.defaultHost', 'Jogador 1'), '', '', '']; for (const l of this.links) if (l.slot > 0) n[l.slot] = l.name || i18nName('net.playerN', 'Jogador ' + (l.slot + 1), { n: l.slot + 1 });
    return (this._names = n);
  };
  P.setName = function (x) { this.name = cleanNick(x); this.invalidateNames(); if (this.role === 'host') this.sendWho(); else if (this.links[0]) this.links[0].link.send({ t: 'nick', name: this.name }, true); };
  P.spectators = function () { return this.role === 'host' ? this.links.filter(l => l.spec).map(l => l.name) : this.specList; };
  P.sendWho = function () { const sp = this.spectators(); const pl = this.names(); for (const L of this.links) L.link.send({ t: 'who', sp, pl }, true); this.ev({ t: 'who' }); };
  // host: give link L a player slot s (new guest or promoted spectator)
  P.seat = function (L, s) {
    const rb = this.rb, join = rb.join.slice(), leave = rb.leave.slice(), was = L.spec;
    L.slot = s; L.spec = false; L.ack = [-1, -1, -1, -1]; this.invalidateNames(); join[s] = rb.frame + this.joinLead; leave[s] = INF; rb.setRoster(join, leave);
    rb.inp[s].clear(); rb.known[s] = join[s] - 1;
    this.sendState(L); this.ev({ t: was ? 'promoted' : 'joined', slot: s, name: L.name }); if (was) this.sendWho();
  };
  // guest: room was full, watch instead / spectator: take a free player slot
  P.watch = function () { const L = this.links[0]; if (L) L.link.send({ t: 'hello', name: this.name || '', watch: 1 }, true); };
  P.promote = function () { const L = this.links[0]; if (L && this.spec && this.vaga) { this.vaga = false; L.link.send({ t: 'promote' }, true); return true; } return false; };
  P.freeSlot = function () { for (let s = 1; s < NS; s++) if (!this.links.some(l => l.slot === s) && (this.rb.join[s] === INF || this.rb.leave[s] !== INF)) return s; return -1; };
  // Pack+send a full state off the simulation tick (SNAP.pack + base64 of ~45 KB of RAM).
  // Mid-tick callers (desync resync from onHash during rb.advance) only queue the link; flushState runs
  // after the current tick / task (queueMicrotask), so tickOnce is not blocked. Wire format unchanged.
  P.sendState = function (L) {
    if (!L) return;
    if (!this._stQ) this._stQ = [];
    if (this._stQ.indexOf(L) < 0) this._stQ.push(L);
    if (this._stSched) return;
    this._stSched = true;
    const later = () => { this._stSched = false; this.flushState(); };
    if (this._inTick) this._stAfterTick = true;
    else if (typeof queueMicrotask === 'function') queueMicrotask(later);
    else setTimeout(later, 0);
  };
  P.flushState = function () {
    const q = this._stQ; this._stQ = null; if (!q || !this.rb) return;
    for (let i = 0; i < q.length; i++) this._emitState(q[i]);
  };
  P._emitState = function (L) {
    if (this.links.indexOf(L) < 0) return;
    const st = this.rb.exportState(), bin = SNAP.pack(this.ext ? Object.assign({ ext: this.ext() }, st.snap) : st.snap);
    this.stats.bytesState += bin.length; L.lastState = now();
    L.link.send({ t: 'state', slot: L.slot, F: st.F, join: st.join, leave: st.leave, inputs: st.inputs, snap: b64.enc(bin), hf: this.rb.frame }, true);
  };
  P.onMsg = function (L, msg) {
    this.stats.recv++;
    const t = now();
    if (msg.p !== undefined) { L.echo = msg.p; L.echoT = t; if (msg.e) { const r = t - msg.e - (msg.ed || 0); L.rtt = L.rtt ? L.rtt * 0.9 + r * 0.1 : r; } }
    if (msg.f !== undefined) { L.f = msg.f; L.fT = t; }
    switch (msg.t) {
      case 'i': {
        if (msg.a) L.ack = msg.a;
        if (this.role === 'host' && !L.spec && L.slot > 0 && typeof msg.dw === 'number' && msg.dw >= DELAY_MIN && msg.dw <= DELAY_MAX) L.want = msg.dw | 0;
        if (typeof msg.dy === 'number' && this.role !== 'host') this.applyNetDelay(msg.dy);
        if (this.role === 'host' && !this.explicitDelay) this.applyNetDelay(this.agreedDelay());
        if (!this.rb) return;
        if (this.role === 'host') { if (L.slot > 0 && msg.d && msg.d[L.slot]) this.rb.addRemote(L.slot, msg.d[L.slot][0], msg.d[L.slot][1]); }
        else { if (msg.v !== undefined && this.spec) { const v = !!msg.v; if (v !== this.vaga) { this.vaga = v; this.ev({ t: 'vaga', v }); } }
          if (msg.r) this.rb.setRoster(msg.r[0], msg.r[1]); for (const s in msg.d) if (+s !== this.slot) this.rb.addRemote(+s, msg.d[s][0], msg.d[s][1]); }
        break;
      }
      case 'hello': { // host: a guest wants in
        if (this.role !== 'host') return;
        if (L.slot > 0 || L.spec) return;
        L.name = cleanNick(msg.name); this.invalidateNames(); const s = this.freeSlot();
        if (s >= 0 && !msg.watch) { this.seat(L, s); this.sendWho(); break; }
        const nspec = this.links.filter(l => l.spec).length;
        if (!msg.watch || nspec >= MAXSPEC) { L.link.send({ t: 'full', watch: nspec < MAXSPEC ? 1 : 0 }, true); return; }
        L.spec = true; L.sid = this.nextSid++; L.rl = new RateLimit(); if (!L.name) L.name = i18nName('net.spectatorN', 'Espectador ' + L.sid, { n: L.sid }); L.autoName = !msg.name; this.invalidateNames();
        this.sendState(L); this.ev({ t: 'spectator', name: L.name }); this.sendWho();
        break;
      }
      case 'promote': { // host: a spectator takes a free slot (first come first served)
        if (this.role !== 'host' || !L.spec) return;
        const s = this.freeSlot(); if (s < 0) return; // the 'v' flag in the next input message tells it the slot is gone
        this.seat(L, s); break;
      }
      case 'who': if (this.role !== 'host') { this.specList = (msg.sp || []).map(x => sanitize(x).slice(0, 20)).slice(0, MAXSPEC); this.nameList = [0, 1, 2, 3].map(i => cleanNick((msg.pl || [])[i])); this.invalidateNames(); this.ev({ t: 'who' }); } break;
      case 'nick': if (this.role === 'host') { const n = cleanNick(msg.name); L.name = n || (L.spec ? i18nName('net.spectatorN', 'Espectador ' + L.sid, { n: L.sid }) : ''); this.invalidateNames(); this.sendWho(); } break;
      case 'state': { // guest: (re)load the host's state
        const snap = SNAP.unpack(b64.dec(msg.snap));
        if (!this.rb) this.startRb(msg.F, msg.slot, msg.join, msg.leave);
        if (this.rb.slot !== msg.slot && msg.slot >= 0) this.rb.inp[msg.slot].clear(); // promoted: drop the old player's relayed inputs
        this.slot = this.rb.slot = msg.slot; this.spec = msg.slot < 0; if (this.spec) this.wasSpec = true; if (!this.spec) this.vaga = false;
        this.rb.loadState(msg.F, snap, msg.join, msg.leave, msg.inputs);
        L.f = msg.hf; L.fT = t;
        if (this.spec) this.specPlayoutReset(true); else this.pb = null; // spectator: rebuffer from the new state (keeps the learned cushion); a promoted spectator plays normally
        this.stats.resyncs++; this.ev({ t: 'state', slot: msg.slot, F: msg.F, snap });
        break;
      }
      case 'h': { // host: a guest's hash of a confirmed frame
        if (this.role !== 'host') return;
        const mine = this.hashes.get(msg.f);
        if (mine === undefined) { (L.pend || (L.pend = [])).push([msg.f, msg.h]); return; }
        this.checkHash(L, msg.f, msg.h, mine);
        break;
      }
      case 'vs': if (this.voice) this.voice.onMsg(L, msg); break; // voice activity flag (web voice chat, net/voice.js); ignored when voice is off/unknown
      case 'full': this.ev({ t: 'full', watch: !!msg.watch }); break;
      case 'c': { // chat: guest -> host (slot taken from the link, not the message) -> relayed to every other guest
        const x = sanitize(msg.x); if (!x) return;
        if (this.role === 'host') {
          if (L.spec) { // spectator line: tagged with its name, never on a character
            if (!L.rl.ok(t)) return;
            for (const o of this.links) if (o !== L && (o.slot > 0 || o.spec)) o.link.send({ t: 'c', s: -1, n: L.name, x }, true);
            this.ev({ t: 'chat', slot: -1, name: L.name, text: x }); return;
          }
          if (L.slot < 1 || !this.chatRl[L.slot].ok(t)) return;
          for (const o of this.links) if (o !== L && (o.slot > 0 || o.spec)) o.link.send({ t: 'c', s: L.slot, x }, true);
          this.ev({ t: 'chat', slot: L.slot, text: x });
        } else {
          const s = msg.s | 0;
          if (s === -1) { if (L === this.links[0]) this.ev({ t: 'chat', slot: -1, name: sanitize(msg.n).slice(0, 20) || i18nName('net.spectator', 'Espectador'), text: x }); }
          else if (s >= 0 && s < NS && s !== this.slot) this.ev({ t: 'chat', slot: s, text: x });
        }
        break;
      }
    }
  };
  P.checkHash = function (L, f, h, mine) {
    if (L.spec) this.stats.specHashChecks++; else this.stats.hashChecks++;
    L.hc++; if (h === mine) return;
    L.dc++; if (L.spec) this.stats.specDesyncs++; else this.stats.desyncs++; this.ev({ t: 'desync', slot: L.slot, spec: L.spec, f });
    if (now() - L.lastState > 2000) this.sendState(L);
  };
  P.onHash = function (f, h) {
    if (this.role === 'host') {
      this.hashes.set(f, h); this.hashes.delete(f - 60 * this.hashEvery);
      for (const L of this.links) if (L.pend) { L.pend = L.pend.filter(([pf, ph]) => { if (pf === f) { this.checkHash(L, pf, ph, h); return false; } return pf > f; }); }
    } else { const L = this.links[0]; if (L) L.link.send({ t: 'h', f, h }, false); this.lastHash = [f, h]; }
  };
  // estimated current frame of the host (guest side)
  P.hostFrame = function () { const L = this.links[0]; return L ? L.f + (now() - L.fT + L.rtt / 2) / this.STEP : 0; };
  // one real-time tick: returns the number of frames simulated
  P.tick = function (local) {
    this._inTick = true;
    try {
      if (this.role === 'host') this.applyNetDelay(this.agreedDelay());
      if (!this.rb) { this.sendAll(); return 0; }
      if (this.spec) return this.specTick();
      let n = 1;
      if (this.role === 'guest') {
        const d = this.hostFrame() - this.rb.frame;
        n = d > 8 ? Math.min(12, Math.floor(d)) : d > 1.5 ? 2 : d < -1.5 ? 0 : 1;
      }
      let done = 0;
      for (let i = 0; i < n; i++) { this.rb.addLocal(local); if (this.rb.advance()) done++; }
      if (!n) this.rb.addLocal(local);
      this.sendAll(); return done;
    } finally {
      this._inTick = false;
      if (this._stAfterTick) {
        this._stAfterTick = false;
        const flush = () => this.flushState();
        if (typeof queueMicrotask === 'function') queueMicrotask(flush);
        else setTimeout(flush, 0);
      }
    }
  };
  // ---- spectator playout (jitter) buffer. SPECTATORS ONLY: players and the host never run this (no input delay / rollback / RTT / hash change).
  // (port of the Simpsons 0c274cb design). A spectator only simulates frames whose inputs are all known (host-confirmed), so any network jitter used
  // to turn straight into a stall. Now the view runs `c` frames behind the newest known frame: avail = known - frame + 1 is the cushion, and a small
  // controller keeps it near `c`:
  //  - start (join / resync / after an underrun): hold until `need` frames are buffered (a few hundred ms), then play at 1 frame per tick;
  //  - speed trim: the smoothed cushion (EMA ~0.5 s) is compared with `c`; outside a dead band the playout runs a little faster / slower by an
  //    accumulator (at most +-2 % -> an extra frame or a held frame every ~1-2 s, never a burst);
  //  - target `c`: an underrun (avail 0) grows it by 4 at once (and rebuffers), a near miss (avail <= 1) by 1; when the minimum cushion of a whole
  //    window stayed above SAFE frames it shrinks by 1 (at most one step per window, ~4 s). c stays in [MIN, MAX] = [9, 30] frames (~150-500 ms);
  //  - a huge surplus (tab was in the background, the input burst after a stall) is drained fast but bounded (<= 6 frames per tick).
  const PB = { START: 14, MIN: 9, MAX: 30, SAFE: 4, GROW_UNDERRUN: 4, WIN_MS: 4000, DEAD: 1.5, KP: 0.01, UP: 0.02, DOWN: 0.02, EMA: 0.03, BURST_OVER: 16, PREBUF_MAX_MS: 1500, WAIT_HOST_MS: 3000 };
  P.specPlayoutReset = function (keepTarget) {
    const old = this.pb, c = keepTarget && old ? old.c : PB.START, t = now();
    this.pb = { c, playing: false, need: Math.min(c, Math.max(PB.SAFE + 2, Math.ceil(c * 0.9))), since: t, acc: 0, ema: c, min: Infinity, winT: t, grows: old ? old.grows : 0, shrinks: old ? old.shrinks : 0, underruns: old ? old.underruns : 0, nearMiss: old ? old.nearMiss : 0, holds: old ? old.holds : 0, extras: old ? old.extras : 0, bursts: old ? old.bursts : 0, prebuf: old ? old.prebuf : 0, avail: 0, kMax: -1, kT: t };
    return this.pb;
  };
  P.specBuf = function () { const b = this.pb; return b ? { c: b.c, cMs: Math.round(b.c * this.STEP), avail: b.avail, ema: +b.ema.toFixed(1), playing: b.playing, grows: b.grows, shrinks: b.shrinks, underruns: b.underruns, nearMiss: b.nearMiss, holds: b.holds, extras: b.extras, bursts: b.bursts, prebuf: b.prebuf } : null; };
  // true when this spectator has seen NO new host-confirmed frame for WAIT_HOST_MS (~3 s): the host stopped producing frames (its tab is in the background, rAF stopped).
  // Read-only, evaluated by game.js after each spectator tick (no timer of its own); a join prebuffer or a jitter underrun never gets there (frames keep arriving).
  P.specWaiting = function () { const b = this.pb; return !!(this.spec && this.rb && b && now() - b.kT > PB.WAIT_HOST_MS); };
  // spectator: only frames whose inputs are all known (never predicts, never rolls back), through the playout buffer above
  P.specTick = function () {
    const rb = this.rb; let k = INF; for (let s = 0; s < NS; s++) k = Math.min(k, rb.knownTo(s));
    const pb = this.pb || this.specPlayoutReset(false), t = now();
    const avail = Math.min(k - rb.frame + 1, 1e6); pb.avail = avail;
    if (k > pb.kMax) { pb.kMax = k; pb.kT = t; } // newest host-confirmed frame seen and when (specWaiting)
    let n = 0;
    if (!pb.playing) { // (re)buffering: nothing to simulate until the cushion is there (or the wait got too long and something is available)
      if (avail >= pb.need || (avail >= 1 && t - pb.since > PB.PREBUF_MAX_MS)) { pb.playing = true; pb.acc = 0; pb.ema = avail; pb.min = Infinity; pb.winT = t; } else pb.prebuf++;
    }
    if (pb.playing) {
      if (avail <= 0) { // underrun: the only thing counted as a stall
        rb.stats.stalls++; pb.underruns++; pb.grows++; pb.c = Math.min(PB.MAX, pb.c + PB.GROW_UNDERRUN);
        pb.playing = false; pb.since = t; pb.need = Math.min(pb.c, Math.max(PB.SAFE + 2, Math.ceil(pb.c * 0.6))); pb.winT = t; pb.min = Infinity;
        rb.confirm(); this.sendAll(); return 0;
      }
      if (avail <= 1 && pb.min > 1) { pb.nearMiss++; if (pb.c < PB.MAX) { pb.c++; pb.grows++; } }
      pb.min = Math.min(pb.min, avail); pb.ema += (avail - pb.ema) * PB.EMA;
      if (t - pb.winT >= PB.WIN_MS) { // window over: shrink one step when the cushion never got near empty
        if (pb.min > PB.SAFE && pb.c > PB.MIN) { pb.c--; pb.shrinks++; }
        pb.winT = t; pb.min = Infinity;
      }
      const e = pb.ema - pb.c;
      if (avail - pb.c > PB.BURST_OVER) { n = Math.min(6, avail - pb.c - 8); pb.bursts++; pb.acc = 0; } // far ahead: drain quickly (bounded)
      else {
        const sp = Math.abs(e) <= PB.DEAD ? 1 : 1 + Math.max(-PB.DOWN, Math.min(PB.UP, PB.KP * (e - Math.sign(e) * PB.DEAD)));
        pb.acc += sp; n = Math.floor(pb.acc); pb.acc -= n;
        if (n > 1) pb.extras++; else if (n < 1) pb.holds++;
      }
      n = Math.max(0, Math.min(n, avail));
    }
    let done = 0; for (let i = 0; i < n; i++) { rb.sim(rb.frame++); rb.stats.frames++; done++; }
    rb.confirm(); this.sendAll(); return done;
  };
  P.sendAll = function () {
    const t = now(), rb = this.rb;
    for (const L of this.links) {
      const msg = { t: 'i', f: rb ? rb.frame : 0, p: t };
      if (!this.explicitDelay && !this.spec) msg.dw = this.wantDelay();
      if (this.role === 'host' && !this.explicitDelay) msg.dy = this.delay;
      if (L.echoT) { msg.e = L.echo; msg.ed = t - L.echoT; }
      if (rb) {
        msg.a = rb.known.slice(); msg.d = {};
        if (this.spec) { L.link.send(msg, false); this.stats.sent++; continue; } // a spectator has no inputs to send
        if (this.role === 'host' && L.spec) msg.v = this.freeSlot() >= 0 ? 1 : 0;
        for (let s = 0; s < NS; s++) {
          if (this.role === 'host' ? s === L.slot : s !== this.slot) continue;
          if (rb.join[s] === INF) continue;
          const f0 = Math.max(L.ack[s] + 1, rb.join[s]);
          if (f0 <= rb.known[s]) msg.d[s] = [f0, rb.range(s, f0, 48)];
        }
        if (this.role === 'host') msg.r = [rb.join, rb.leave];
      }
      L.link.send(msg, false); this.stats.sent++;
    }
  };
  // send a chat line from this player; returns the sanitized text (null if empty, not in a slot yet or rate limited)
  P.chat = function (text) {
    const x = sanitize(text); if (!x) return null;
    if (this.spec) {
      if (!this.specRl.ok(now()) || !this.links[0]) return null;
      this.links[0].link.send({ t: 'c', s: -1, x }, true); this.ev({ t: 'chat', slot: -1, name: this.name || 'Você', text: x, self: true }); return x;
    }
    if (this.slot < 0 || !this.chatRl[this.slot].ok(now())) return null;
    const msg = { t: 'c', s: this.slot, x };
    for (const L of this.links) if (this.role === 'guest' || L.slot > 0 || L.spec) L.link.send(msg, true);
    this.ev({ t: 'chat', slot: this.slot, text: x, self: true });
    return x;
  };
  P.peers = function () { return this.links.map(L => ({ slot: L.slot, spec: L.spec, name: L.name, rtt: Math.round(L.rtt), hc: L.hc, dc: L.dc })); };
  // Worst smoothed RTT among players (spectators and empty seats do not count). Guests measure the host link.
  P.wantDelay = function () {
    if (this.spec) return this.delay;
    let rtt = 0;
    for (const L of this.links) {
      if (L.spec) continue;
      if (this.role === 'host' && !(L.slot > 0)) continue;
      if (L.rtt > rtt) rtt = L.rtt;
    }
    return delayFromRtt(rtt, this.STEP);
  };
  // Host authority: own measurement, or higher if a seated guest asked for more. Guests do not invent a delay.
  P.agreedDelay = function () {
    let d = this.wantDelay();
    if (this.role === 'host') for (const L of this.links) if (!L.spec && L.slot > 0 && L.want > d) d = L.want;
    return Math.max(DELAY_MIN, Math.min(DELAY_MAX, d | 0));
  };
  // Host smooths the agreed horizon (raise immediately, hold DELAY_HOLD_MS before a drop) and publishes it as `dy`.
  // Guests and spectators snap to that value so they never run a different delay than the one the host already settled.
  // Already-stored frames are left alone: store() does not overwrite.
  P.applyNetDelay = function (d) {
    if (this.explicitDelay) return;
    d = d | 0; if (d < DELAY_MIN || d > DELAY_MAX) d = Math.max(DELAY_MIN, Math.min(DELAY_MAX, d));
    if (this.role === 'host') {
      const t = now();
      if (d > this.delay) { this.delay = d; this._delayDropAt = t + DELAY_HOLD_MS; }
      else if (d < this.delay) { if (t < this._delayDropAt) return; this.delay = d; }
      else return;
    } else if (d !== this.delay) this.delay = d;
    else return;
    this.maxRoll = Math.max(8, this.delay + 8);
    if (this.rb) { this.rb.delay = this.delay; this.rb.maxRoll = this.maxRoll; }
  };
  // audio FIFO settings for a spectator (game.js posts them to the worklet): ~90 ms of cushion, a roomier drop threshold and a bounded (+-2 %) rate nudge, so the
  // playout trim and an occasional held/extra frame never drain or overfill it. Players keep the worklet defaults (TARGET 2400 / MAX 9600 samples at 48 kHz = 50 / 200 ms).
  const SPEC_AUDIO = { target: 4320, max: 14400, gain: 0.1, clamp: 0.02 }, PLAYER_AUDIO = { target: 2400, max: 9600, gain: 0, clamp: 0 };
  const api = { SPEC_AUDIO, PLAYER_AUDIO, PB, Session, b64, sanitize, cleanNick, RateLimit, CHAT_MAX, MAXSPEC, NICK_MAX, delayFromRtt, delayOption, DELAY_MIN, DELAY_MAX };
  if (NODE) module.exports = api; else G.TMNTSESSION = api;
})(typeof window !== 'undefined' ? window : globalThis);
