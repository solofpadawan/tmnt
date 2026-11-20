// Voice chat between the players of a room (web only; never part of the simulation, snapshots, hashes or inputs).
//
// TOPOLOGY (star, like the rest of netplay: guests only talk to the host). Every host<->guest RTCPeerConnection carries
// 4 audio transceivers (sendrecv, created by the guest in its offer, so no renegotiation is ever needed), one per player
// slot: transceiver N always carries the voice of the player in slot N.
//   - the host's own mic goes out on transceiver 0 of every link;
//   - a guest in slot S sends its mic on transceiver S of its single link (to the host);
//   - the host RELAYS: when guest S speaks, the host plays transceiver S locally and forwards that same remote track
//     to every other link on transceiver S (sender.replaceTrack(remoteTrack)). Each listener therefore gets one separate
//     stream per speaker (per-player mute and the speaker icon work), and nobody receives its own voice (no echo).
//     Spectators are guests without a slot: they receive all 4 transceivers and never send (no mic button).
//   - "speaking" state travels on the reliable DataChannel as {t:'vs', on:0|1} (guest->host) and {t:'vs', s:slot, on}
//     (host->others). It drives the speaker icons and tells the host when to open/close the relay.
// BANDWIDTH: nothing is sent while nobody speaks. The sender runs a voice-activity detector (AudioWorklet RMS when available, otherwise AnalyserNode;
// adaptive floor, 300 ms hangover); outside speech sender.replaceTrack(null) stops the RTP stream completely (the host closes the
// relay the same way). Opus mono, in-band FEC, maxaveragebitrate + encodings[0].maxBitrate = 28 kbps. ICE servers
// (STUN + TURN from ?a=ice) are the ones of the netplay PeerConnection, voice rides on the same connection.
// DUCKING: while the voice of another (unmuted) player is playing locally, the game's master gain node (game.js:
// TMNTG.audio.duck) drops to DUCK_GAIN and returns to 1 afterwards (setTargetAtTime, no clicks). The emulated sound itself is untouched.
// ?voice=0 disables all of it (tests / troubleshooting).
(function (G) {
  'use strict';
  const NS = 4;
  const DUCK_GAIN = 0.65;                // game sound level while another player's voice is heard (~-3.7 dB; 0.4 hid quiet instruments)
  const DUCK_ATTACK_MS = 80, DUCK_RELEASE_MS = 500, DUCK_HANG_MS = 300, RX_THR = 0.008;
  const VAD_MIN = 0.015, VAD_HANG_MS = 300, TICK_MS = 25;
  const MAX_BITRATE = 28000;
  const VOL_KEY = 'tmnt_voice_vol';
  const off = (() => { try { return new URLSearchParams(location.search).get('voice') === '0'; } catch (e) { return false; } })();
  const supported = !off && typeof RTCPeerConnection !== 'undefined' && !!RTCPeerConnection.prototype.addTransceiver;
  const now = () => performance.now();

  let vadModCtx = null, vadModP = null;
  function loadVad(ctx) {
    if (!ctx || !ctx.audioWorklet) return Promise.resolve(false);
    if (vadModCtx === ctx && vadModP) return vadModP;
    vadModCtx = ctx;
    const url = 'net/voice-vad-worklet.js' + ((typeof window !== 'undefined' && window.TMNTV_STAMP) ? '?v=' + window.TMNTV_STAMP : '');
    vadModP = ctx.audioWorklet.addModule(url).then(() => true).catch(e => {
      console.warn('[tmnt-voice] vad worklet', e && e.message); vadModP = null; vadModCtx = null; return false;
    });
    return vadModP;
  }

  // ---------- SDP: Opus mono + FEC + bitrate cap on every audio m-line ----------
  function mungeOpus(sdp) {
    const want = { stereo: '0', 'sprop-stereo': '0', useinbandfec: '1', maxaveragebitrate: String(MAX_BITRATE) };
    return sdp.split(/(?=^m=)/m).map(sec => {
      if (!/^m=audio /.test(sec)) return sec;
      const m = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/im.exec(sec); if (!m) return sec;
      const pt = m[1], re = new RegExp('^a=fmtp:' + pt + ' ([^\\r\\n]*)', 'm');
      const cur = re.exec(sec), kv = {};
      if (cur) for (const p of cur[1].split(';')) { const i = p.indexOf('='); if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
      Object.assign(kv, want);
      const line = 'a=fmtp:' + pt + ' ' + Object.keys(kv).map(k => k + '=' + kv[k]).join(';');
      if (cur) return sec.replace(re, line);
      const cr = m[0].endsWith('\r');
      return sec.replace(m[0], m[0].replace(/\r$/, '') + (cr ? '\r\n' : '\n') + line + (cr ? '\r' : ''));
    }).join('');
  }

  // ---------- per-PeerConnection audio (attached by transport.js rtcLink) ----------
  function attachPc(pc, initiator) {
    if (!supported) return null;
    const vx = { txs: [], cur: [null, null, null, null], bad: false };
    try {
      if (initiator) for (let i = 0; i < NS; i++) vx.txs.push(pc.addTransceiver('audio', { direction: 'sendrecv' }));
    } catch (e) { return null; }
    // responder: take the transceivers created by the remote offer (m-line order = slot order) and make them sendrecv
    vx.adopt = () => {
      if (initiator) return;
      const a = pc.getTransceivers().filter(x => x.receiver && x.receiver.track && x.receiver.track.kind === 'audio');
      if (a.length === NS) { vx.txs = a; for (const x of a) { try { x.direction = 'sendrecv'; } catch (e) {} } } else { vx.txs = []; vx.bad = true; }
    };
    vx.mungeDesc = d => ({ type: d.type, sdp: mungeOpus(d.sdp) });
    // usable once the answer is applied and our 4 m-lines are active (an old peer answers with rejected m-lines)
    vx.usable = () => vx.txs.length === NS && !vx.bad && vx.txs.every(x => x.mid != null && x.currentDirection && x.currentDirection !== 'stopped' && !x.stopped);
    vx.rx = s => (vx.txs[s] && vx.txs[s].receiver.track) || null;
    vx.tuned = false;
    vx.tune = () => { if (vx.tuned || !vx.usable()) return; vx.tuned = true;
      for (const x of vx.txs) { try { const p = x.sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]; p.encodings[0].maxBitrate = MAX_BITRATE; x.sender.setParameters(p).catch(() => {}); } catch (e) {} } };
    // set what transceiver s sends (a MediaStreamTrack or null = no RTP at all)
    vx.setTx = (s, track) => { if (!vx.usable() || vx.cur[s] === track) return; vx.tune(); vx.cur[s] = track; vx.txs[s].sender.replaceTrack(track).catch(e => { vx.cur[s] = undefined; console.warn('[tmnt-voice] replaceTrack', e.message); }); };
    return vx;
  }

  const loadVol = () => { try { const v = parseFloat(localStorage.getItem(VOL_KEY)); return v >= 0 && v <= 1 ? v : 1; } catch (e) { return 1; } };

  // ---------- Voice: one per Session ----------
  function Voice(session, o) {
    this.s = session; this.onchange = (o && o.onchange) || (() => {});
    this.micOn = false; this.err = null; this.selfOn = false; this.level = 0; this.stream = null; this.track = null;
    this.speaking = [false, false, false, false]; this.mute = [false, false, false, false]; this.vol = loadVol();
    this.audios = [null, null, null, null]; this.an = [null, null, null, null]; this.heard = [0, 0, 0, 0]; this.rxLevel = [0, 0, 0, 0];
    this.floor = 0; this.lastVoice = 0; this.routed = -1; this.ducking = false; this.duckNode = null; this.duckSince = 0; this.ctx = null;
    this.stats = { duckOn: 0, duckOff: 0 }; this.lastNameCheck = 0;
    session.voice = this;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  const P = Voice.prototype;
  P.mySlot = function () { return this.s.spec ? -1 : this.s.slot; };
  P.linkVx = function (L) { return L && L.link && L.link.vx && L.link.vx.usable() ? L.link.vx : null; };
  P.hostLink = function (slot) { return this.s.links.find(L => L.slot === slot && !L.spec) || null; };
  P.canMic = function () { return !this.s.spec && this.s.slot >= 0; };

  // ----- microphone -----
  P.toggleMic = async function () { if (this.micOn) { this.disableMic(); return; } await this.enableMic(); };
  P.enableMic = async function () {
    this.err = null;
    if (!this.canMic()) return;
    if (this.s.role === 'guest' && !this.linkVx(this.s.links[0])) { this.err = 'unavail'; this.onchange('mic'); return; }
    if (G.TMNTG && G.TMNTG.ensureAudio) await G.TMNTG.ensureAudio();
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { this.err = 'insecure'; this.onchange('mic'); return; }
    let stream;
    try { stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }); }
    catch (e) { const n = e && e.name; this.err = n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' ? 'nomic' : 'fail'; console.warn('[tmnt-voice] getUserMedia', n); this.onchange('mic'); return; }
    if (this.dead) { for (const t of stream.getTracks()) t.stop(); return; }
    this.stream = stream; this.track = stream.getAudioTracks()[0];
    if (!this.track) { for (const t of stream.getTracks()) t.stop(); this.err = 'nomic'; this.onchange('mic'); return; }
    this.track.onended = () => { if (this.track) { this.err = 'fail'; this.disableMic(); } };
    const ctx = this.audioCtx(); this.micSrc = ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.floor = 0; this.lastVoice = 0; this.vadNode = null; this.micAn = null; this.micBuf = null;
    const ok = await loadVad(ctx);
    if (ok) {
      try {
        this.vadNode = new AudioWorkletNode(ctx, 'tmnt-vad');
        this.micSrc.connect(this.vadNode);
        this.vadNode.port.onmessage = e => {
          const d = e.data; if (!d || this.dead || !this.micOn) return;
          if (d.rms != null) this.level = d.rms;
          if (d.changed) this.setSelf(!!d.on);
        };
      } catch (e) { console.warn('[tmnt-voice] vad worklet node', e && e.message); this.vadNode = null; }
    }
    if (!this.vadNode) {
      this.micAn = ctx.createAnalyser(); this.micAn.fftSize = 1024; this.micSrc.connect(this.micAn); this.micBuf = new Float32Array(this.micAn.fftSize);
    }
    this.micOn = true; this.onchange('mic');
  };
  P.disableMic = function () {
    this.setSelf(false);
    if (this.stream) for (const t of this.stream.getTracks()) { t.onended = null; try { t.stop(); } catch (e) {} }
    try { this.micSrc && this.micSrc.disconnect(); } catch (e) {}
    try { this.vadNode && this.vadNode.disconnect(); } catch (e) {}
    if (this.vadNode && this.vadNode.port) this.vadNode.port.onmessage = null;
    this.stream = this.track = this.micSrc = this.micAn = this.micBuf = this.vadNode = null; this.micOn = false; this.level = 0; this.onchange('mic');
  };
  P.gameAc = function () { return G.TMNTG && G.TMNTG.audio && G.TMNTG.audio.ac ? G.TMNTG.audio.ac : null; };
  P.audioCtx = function () {
    if (G.TMNTG && G.TMNTG.startAudio) G.TMNTG.startAudio().catch(() => {});
    const gac = this.gameAc();
    if (gac) {
      this.ctx = gac; this._ownCtx = false;
      if (gac.state === 'suspended') gac.resume().catch(() => {});
      return gac;
    }
    if (!this.ctx) { const C = G.AudioContext || G.webkitAudioContext; this.ctx = new C({ sampleRate: 48000, latencyHint: 'interactive' }); this._ownCtx = true; }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  };

  // our own speech on/off: open/close the outgoing RTP and tell the others
  P.setSelf = function (on) {
    const s = this.s; on = !!on && this.micOn;
    const slot = this.mySlot();
    if (!on && !this.selfOn) return;
    if (on && slot < 0) return;
    if (!on && this.routed >= 0) this.route(this.routed, null);
    if (on) { this.route(slot, this.track); }
    this.selfOn = on; this.routed = on ? slot : -1;
    if (slot >= 0) this.speaking[slot] = on;
    if (s.role === 'host') { for (const L of s.links) L.link.send({ t: 'vs', s: 0, on: on ? 1 : 0 }, true); }
    else if (s.links[0]) s.links[0].link.send({ t: 'vs', on: on ? 1 : 0 }, true);
    this.onchange('speak');
  };
  // put `track` (or null) on the transceiver of `slot` of every link we send our mic on
  P.route = function (slot, track) {
    const s = this.s;
    if (s.role === 'host') { for (const L of s.links) { const vx = this.linkVx(L); if (vx) vx.setTx(0, track); } }
    else { const vx = this.linkVx(s.links[0]); if (vx) vx.setTx(slot, track); }
  };

  // ----- messages {t:'vs'} (called by session.js) -----
  P.onMsg = function (L, msg) {
    const s = this.s, on = !!msg.on;
    if (s.role === 'host') { if (L.spec || L.slot < 1) return; this.remote(L.slot, on, L); }
    else { if (L !== s.links[0]) return; const sl = msg.s | 0; if (sl < 0 || sl >= NS || sl === this.mySlot()) return; this.remote(sl, on, null); }
  };
  P.remote = function (slot, on, from) {
    if (this.speaking[slot] === on) return;
    this.speaking[slot] = on;
    if (from) { // host: open/close the relay of this guest's voice towards everybody else
      const tr = on && from.link.vx && from.link.vx.usable() ? from.link.vx.rx(slot) : null;
      for (const O of this.s.links) { if (O === from) continue; O.link.send({ t: 'vs', s: slot, on: on ? 1 : 0 }, true); const vx = this.linkVx(O); if (vx) vx.setTx(slot, tr); }
    }
    if (on) this.ensurePlay(slot);
    this.onchange('speak');
  };
  // a guest left (host side) / link closed
  P.onDrop = function (L) {
    if (this.s.role === 'host' && L.slot > 0 && this.speaking[L.slot]) { this.remote(L.slot, false, L); }
    if (this.s.role === 'host') { for (const O of this.s.links) { const vx = this.linkVx(O); if (vx && L.slot > 0) vx.setTx(L.slot, null); } }
    if (L.slot > 0 && this.audios[L.slot]) this.dropPlay(L.slot);
  };

  // ----- playback of the other players (Web Audio on the game AudioContext; muted <audio> only keeps the WebRTC track alive) -----
  // The muted <audio> pulls the remote WebRTC track so the host can replaceTrack() the same track to other guests.
  // A MediaStreamSource-only graph without <audio> (tried in a 1014 draft) received RTP but played silence and
  // broke the host relay. Chromium also silences a MediaStreamSource that shares its track with a muted <audio>
  // (20261110-voice-0946), so the Web Audio graph uses track.clone(); mute/unmute is instant via GainNode
  // (gain 0 or vol) and never flips el.muted.
  P.srcTrack = function (slot) {
    if (this.s.role === 'host') { const L = this.hostLink(slot); const vx = L && this.linkVx(L); return vx ? vx.rx(slot) : null; }
    const vx = this.linkVx(this.s.links[0]); return vx ? vx.rx(slot) : null;
  };
  P.ensurePlay = function (slot) {
    const tr = this.srcTrack(slot); if (!tr) return;
    if (G.TMNTG && G.TMNTG.startAudio) G.TMNTG.startAudio().catch(() => {});
    const ctx = this.audioCtx();
    let a = this.audios[slot];
    if (a && a.track === tr && a.ctx === ctx) { if (a.el && a.el.paused) a.el.play().catch(() => {}); return; }
    this.dropPlay(slot);
    const el = new Audio(); el.autoplay = true; el.srcObject = new MediaStream([tr]); el.muted = true; el.volume = 0;
    let clone = null; try { clone = tr.clone(); } catch (e) {}
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([clone || tr])), g = ctx.createGain(), an = ctx.createAnalyser();
      an.fftSize = 1024; g.gain.value = this.mute[slot] ? 0 : this.vol;
      src.connect(g); g.connect(an); g.connect(ctx.destination);
      a = this.audios[slot] = { el, track: tr, clone, src, gain: g, ctx };
      this.an[slot] = { src, an, buf: new Float32Array(1024) };
    } catch (e) {
      console.warn('[tmnt-voice] play', e.message);
      a = this.audios[slot] = { el, track: tr, clone, ctx };
    }
    if (el.paused) el.play().catch(() => {});
  };
  P.dropPlay = function (slot) {
    const a = this.audios[slot];
    if (a) {
      try { a.gain && a.gain.disconnect(); } catch (e) {}
      try { a.src && a.src.disconnect(); } catch (e) {}
      try { if (a.el) { a.el.pause(); a.el.srcObject = null; } } catch (e) {}
      if (a.clone) try { a.clone.stop(); } catch (e) {}
    }
    const n = this.an[slot]; if (n) { try { n.src && n.src.disconnect(); } catch (e) {} }
    this.audios[slot] = this.an[slot] = null; this.heard[slot] = 0;
  };
  P.setVolume = function (v) {
    v = Math.max(0, Math.min(1, +v || 0)); this.vol = v; try { localStorage.setItem(VOL_KEY, String(v)); } catch (e) {}
    for (let sl = 0; sl < NS; sl++) {
      const a = this.audios[sl]; if (!a) continue;
      if (a.gain) a.gain.gain.value = this.mute[sl] ? 0 : v;
      else if (a.el && !a.gain) a.el.volume = v;
    }
  };
  P.setMute = function (slot, m) {
    this.mute[slot] = !!m;
    const a = this.audios[slot];
    if (a && a.gain) a.gain.gain.value = m ? 0 : this.vol;
    else if (a && a.el) a.el.muted = !!m;
    this.onchange('mute');
  };

  // ----- ducking of the game sound -----
  P.setDuck = function (on) {
    this.ducking = on; this.duckSince = now(); if (on) this.stats.duckOn++; else this.stats.duckOff++;
    this.applyDuck();
    this.onchange('duck');
  };
  P.applyDuck = function () {
    const d = G.TMNTG && G.TMNTG.audio && G.TMNTG.audio.duck; if (!d) return;
    this.duckNode = d; const t = d.context.currentTime, on = this.ducking;
    d.gain.cancelScheduledValues(t); d.gain.setValueAtTime(d.gain.value, t);
    d.gain.setTargetAtTime(on ? DUCK_GAIN : 1, t, (on ? DUCK_ATTACK_MS : DUCK_RELEASE_MS) / 3000); // time constant: ~95% reached after 3 tau
  };

  // ----- 25 ms tick: mic VAD, received level (icon-independent) -> ducking -----
  P.tick = function () {
    if (this.dead) return;
    const t = now();
    if (this.micOn) {
      if (this.s.spec || this.s.slot < 0) { this.disableMic(); }
      else {
        if (!this.vadNode && this.micAn) {
          this.micAn.getFloatTimeDomainData(this.micBuf); let sum = 0; for (let i = 0; i < this.micBuf.length; i++) sum += this.micBuf[i] * this.micBuf[i];
          const rms = Math.sqrt(sum / this.micBuf.length); this.level = rms;
          const thr = Math.max(VAD_MIN, this.floor * 3);
          if (rms > thr) { this.lastVoice = t; if (!this.selfOn) this.setSelf(true); }
          else { this.floor = this.floor ? this.floor * 0.98 + rms * 0.02 : rms; if (this.selfOn && t - this.lastVoice > VAD_HANG_MS) this.setSelf(false); }
        }
        if (this.selfOn && this.s.role === 'host') this.route(0, this.track); // links that connected while we were talking
        else if (this.selfOn && this.routed !== this.mySlot()) { const ns = this.mySlot(); if (this.routed >= 0) this.route(this.routed, null); this.routed = ns; this.route(ns, this.track); this.speaking[ns] = true; }
      }
    }
    // received voice of OTHER players, not muted, voice volume > 0
    let heard = false;
    for (let sl = 0; sl < NS; sl++) {
      if (this.speaking[sl] && sl !== this.mySlot()) this.ensurePlay(sl);
      const n = this.an[sl]; if (!n || sl === this.mySlot() || this.mute[sl] || this.vol <= 0.001) continue;
      n.an.getFloatTimeDomainData(n.buf); let sum = 0; for (let i = 0; i < n.buf.length; i++) sum += n.buf[i] * n.buf[i];
      const rms = Math.sqrt(sum / n.buf.length); this.rxLevel[sl] = rms; if (rms > RX_THR) this.heard[sl] = t;
      if (t - this.heard[sl] < DUCK_HANG_MS) heard = true;
    }
    if (heard !== this.ducking) this.setDuck(heard);
    else if (this.ducking !== undefined && G.TMNTG && G.TMNTG.audio && G.TMNTG.audio.duck && G.TMNTG.audio.duck !== this.duckNode) this.applyDuck(); // audio started after the voice
    if (t - this.lastNameCheck > 1000) { this.lastNameCheck = t; const nm = this.s.names(); for (let sl = 0; sl < NS; sl++) if (!nm[sl] && this.mute[sl]) this.setMute(sl, false); }
  };

  P.stop = function () {
    this.dead = true; clearInterval(this.timer); this.disableMic();
    for (let i = 0; i < NS; i++) this.dropPlay(i);
    if (this.ducking) { this.ducking = false; this.applyDuck(); }
    const gac = this.gameAc && this.gameAc();
    if (this._ownCtx && this.ctx && this.ctx !== gac) { try { this.ctx.close(); } catch (e) {} }
    this.ctx = null; this.s.voice = null;
  };
  P.gain = function () { const d = G.TMNTG && G.TMNTG.audio && G.TMNTG.audio.duck; return d ? d.gain.value : null; };

  G.TMNTVOICE = { Voice, attachPc, mungeOpus, supported, DUCK_GAIN, MAX_BITRATE, VAD_HANG_MS, NS };
})(typeof window !== 'undefined' ? window : globalThis);
