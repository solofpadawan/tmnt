// Port of the Simpsons test_spec_jitter.js (0c274cb) to TMNT. Spectator playout under a bad network (netsim on the host<->spectator link only):
// stalls / freezes / fps and the audio FIFO underruns of the REAL assemble/audio_worklet.js (driven at 48 kHz, fed by the real TMNT sound board
// exactly like game.js: netAudio -> soundTo -> {pcm} on confirmed frames only, board reloaded from the host's state on a resync).
// The host plus --guests N bot players (default 2, links lat/jit/loss = --glat/--gjit/--gloss per direction, default 40/15/1: the spectator can only advance
// as fast as the slowest player's input reaches the host), so nothing but the spectator link is noisy. VIRTUAL TIME: deterministic, independent of box load.
// node test/test_spec_jitter.js [webdir=assemble] [--secs 60] [--lat 100] [--jit 30] [--loss 3] [--spike 600] [--json out.json] [--label name] [--nospec 1]
//   --tickjit P: every machine (host, players) skips a tick with probability P and runs 2 on the next one (rAF cadence jitter of a real browser)
//   lat/jit are per direction (RTT = 2*lat, RTT jitter = +-2*jit): the defaults are RTT 200 ms +-60 ms, 3% loss (unreliable channel), a 600 ms spike every ~12 s.
//   --freeze S: the HOST stops ticking (background tab, rAF stopped) for S seconds, 20 s after the spectator joined; reports when spec.specWaiting() (the spectator's
//     "Waiting for the host" overlay predicate) went true / false. Without --freeze it must never be true (join prebuffer, jitter, 600 ms spikes).
//   --nospec 1: no spectator at all (host + players only): used to prove the host / player path is byte-identical between builds.
// Old build for A/B: pass the old build's assemble dir (e.g. /workspace/tmnt-audiofix-20261110-2058/assemble); it has no specBuf / SPEC_AUDIO.
'use strict';
const path = require('path'), fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const argv = process.argv.slice(2), opt = { secs: 60, lat: 100, jit: 30, loss: 3, spike: 600, json: '', label: '', guests: 2, glat: 40, gjit: 15, gloss: 1, tickjit: 0, nospec: 0, freeze: 0 }; let webdir = path.join(__dirname, '../assemble');
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = typeof opt[k] === 'number' ? +argv[++i] : argv[++i]; } else webdir = argv[i]; }
let VT = 1000; const timers = []; let tseq = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => VT }, configurable: true, writable: true });
globalThis.setTimeout = (fn, ms) => { const o = { t: VT + Math.max(0, ms || 0), fn, seq: tseq++ }; timers.push(o); return o; };
globalThis.clearTimeout = o => { const i = timers.indexOf(o); if (i >= 0) timers.splice(i, 1); };
function runTimers(upTo) { for (;;) { let b = -1; for (let i = 0; i < timers.length; i++) if (timers[i].t <= upTo && (b < 0 || timers[i].t < timers[b].t || (timers[i].t === timers[b].t && timers[i].seq < timers[b].seq))) b = i; if (b < 0) return; const o = timers.splice(b, 1)[0]; const keep = VT; VT = Math.max(VT, o.t); o.fn(); VT = Math.max(keep, VT); } }
// Deterministic PRNGs. Every link gets its OWN stream (and the rAF tick jitter another one), selected around each link.send, so what the spectator sends
// (a different amount of hash / ack traffic when its playout timing differs) can never shift the random draws of the host <-> player links:
// host and players then run the exact same simulation in an A/B pair (no shared-RNG butterfly effect), which is what the identity check below relies on.
function mkRng(seed) { let r = seed | 0; return () => { r |= 0; r = r + 0x6D2B79F5 | 0; let t = Math.imul(r ^ r >>> 15, 1 | r); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let curRng = mkRng(12345); Math.random = () => curRng(); const rngTick = mkRng(777); let linkSeed = 1000;
function seedLinks(a, b) { for (const l of [a, b]) { const r = mkRng(linkSeed++), send = l.send; l.send = (o, rel) => { const k = curRng; curRng = r; try { return send(o, rel); } finally { curRng = k; } }; } }
const W = path.resolve(webdir);
const Machine = require(path.join(W, 'sim/tmnt.js')), Snd = require(path.join(W, 'sim/tmntsound.js')), IN = require(path.join(W, 'input.js')), SNAP = require(path.join(W, 'net/snap.js'));
const SSES = require(path.join(W, 'net/session.js')), { Session } = SSES, LINK = require(path.join(W, 'net/link.js'));
globalThis.btoa ??= s => Buffer.from(s, 'binary').toString('base64'); globalThis.atob ??= s => Buffer.from(s, 'base64').toString('binary');
const RS = require('./romzip.js').loadRomset();
const STEP = 1000 / 59.1856;
// ---- one TMNT "game.js" per peer that needs sound: machine + sound board + sndPos, same code as game.js soundTo / netAudio / netExt / netAudioResync
function game(sink) {
  const m = new Machine(RS); m.powerOn(); const snd = new Snd(RS, 48000), buf = new Float32Array(4096); let pos = 0;
  const G = { m, snd, get pos() { return pos; },
    soundTo(end, cyc) { if (end > pos) snd.push(m.sndSlice(pos, end)); const n = snd.render(buf, buf.length, Snd.zOf(cyc)); if (n && sink) sink(buf.slice(0, n)); pos = end; m.trimSound(pos); },
    netStep: (fi, f) => { IN.applyFrame(m, fi, true); m.step(); },
    netAudio: after => G.soundTo(after.nsnd, Machine.nowOf(after)),
    netExt: () => ({ board: snd.save(), pos }),
    netAudioResync(s) { if (s && s.ext && s.ext.board) snd.load(s.ext.board); if (s && s.nsnd != null) pos = s.nsnd; },
    localFrame() { IN.applyFrame(m, new Uint8Array(4), true); m.step(); G.soundTo(m.sndEnd(), m.now()); } };
  return G;
}
function bot(seed) { let x = seed * 2654435761 >>> 0, cur = 0, hold = 0, n = 0; return () => {
  n++; if (n % 600 === 30) return IN.COIN; if (n % 600 === 90 || n % 600 === 100) return IN.ATTACK;
  if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, IN.L, IN.R, IN.ATTACK, IN.R | IN.ATTACK, IN.JUMP][(x >>> 16) % 6]; hold = 8; }
  return cur; }; }
// ---- the real audio worklet, consumed in real time at 48 kHz
let Proc = null;
vm.runInNewContext(fs.readFileSync(path.join(W, 'audio_worklet.js'), 'utf8'), { AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: 48000, Float32Array, Math, Int16Array });
const wk = new Proc({ processorOptions: { test: false } }); const aud = { under: 0, over: 0, msgs: 0, fillMin: 1e9, fillMax: 0, t0: 0, blocks: 0, dropped: 0, started: false };
// (a block consumes 128 samples, up to ~131 with the +-2 % nudge: anything above 140 in one block is a dropped chunk)
const outs = [[new Float32Array(128), new Float32Array(128)]];
function wkPost(d) { wk.port.onmessage({ data: d }); aud.msgs++; }
function wkRun(t) {
  if (!aud.t0) aud.t0 = t; const want = Math.floor((t - aud.t0) * 48 / 128);
  while (aud.blocks < want) { const was = !wk.hold, n0 = wk.n; wk.process(null, outs); aud.blocks++; if (was && wk.hold) aud.under++; if (n0 - wk.n > 140) { aud.over++; aud.dropped += n0 - wk.n - 130; } if (!wk.hold) { aud.fillMin = Math.min(aud.fillMin, wk.n); aud.fillMax = Math.max(aud.fillMax, wk.n); } }
}
// ---- peers
const specSim = { lat: opt.lat, jit: opt.jit, loss: opt.loss }, specSim2 = { lat: opt.lat, jit: opt.jit, loss: opt.loss };
const IGN = () => {};
const hg = game(null); for (let i = 0; i < 80; i++) hg.localFrame();
const host = new Session({ m: hg.m, step: hg.netStep, role: 'host', frame: 81, name: 'Host', onAudio: hg.netAudio, ext: hg.netExt, onEvent: IGN });
const hostHashes = []; { const o = host.rb.onHash; host.rb.onHash = (f, h) => { hostHashes.push([f, h]); o(f, h); }; } // fingerprint of the host's confirmed state every 60 frames
const peers = [{ s: host, input: bot(1) }];
for (let i = 0; i < opt.guests; i++) { const g = game(null); const s = new Session({ m: g.m, step: g.netStep, role: 'guest', name: 'G' + i, onEvent: IGN }); const gs = () => ({ lat: opt.glat, jit: opt.gjit, loss: opt.gloss }), [a, b] = LINK.pair(gs(), gs()); seedLinks(a, b); host.addLink(a); s.addLink(b); peers.push({ s, input: bot(i + 2) }); }
// spectator: the sound board is a real one; PCM chunks (per confirmed frame) go to the worklet like game.js audioOut; per-frame PCM hashes are kept for the A/B identity check
const pcmByFrame = new Map(); let specCfgPosted = false, spec = null, sg = null;
if (!opt.nospec) {
  sg = game(p => { const f = spec.rb.confirmed; pcmByFrame.set(f, crypto.createHash('sha256').update(Buffer.from(p.buffer, p.byteOffset, p.byteLength)).digest('hex').slice(0, 16)); wkPost({ pcm: p.slice() }); });
  spec = new Session({ m: sg.m, step: sg.netStep, role: 'guest', name: 'Olho', watch: true, onAudio: sg.netAudio, onEvent: e => { if (e.t === 'state') sg.netAudioResync(e.snap); } });
  const [sa, sb] = LINK.pair(specSim, specSim2); seedLinks(sa, sb); host.addLink(sa); spec.addLink(sb);
}
// ---- measurements
const M = { ticks: 0, frames: 0, zero: 0, runs3: 0, runs: [], longest: 0, adv: [], t0: 0 }; let run = 0, lastAdvT = 0, started = false, spikes = 0, nextSpike = 0;
const lagS = [], gapsMs = [], SPEC_AUDIO_OK = !!SSES.SPEC_AUDIO;
let T0 = 0;
function onSpecTick(t, done) {
  if (!started) { if (spec.spec && !specCfgPosted && SPEC_AUDIO_OK) { specCfgPosted = true; wkPost({ cfg: SSES.SPEC_AUDIO }); } if (!spec.spec || !spec.rb || !spec.rb.frame) return; started = true; M.t0 = t; lastAdvT = t; nextSpike = t + 8000; }
  M.ticks++; M.adv.push([+(t - M.t0).toFixed(1), done]);
  if (done > 0) { M.frames += done; if (run >= 1) { M.zero += run; } if (run * STEP > 50) { M.runs3++; } if (run) M.runs.push(run); M.longest = Math.max(M.longest, (t - lastAdvT)); gapsMs.push(t - lastAdvT); lastAdvT = t; run = 0; } else run++;
}
const WF = { t0: 0, shownAt: 0, hiddenAt: 0, ticksShown: 0, ticksShownOutsideFreeze: 0 }; const wall0 = Date.now(); let hostStarted = 0;
// async main loop: Session.sendState flushes through queueMicrotask, which needs a real yield per tick (virtual time does not advance meanwhile)
(async () => {
for (;;) {
  await Promise.resolve();
  VT += STEP; runTimers(VT); const t = VT;
  if (!opt.nospec && started && opt.spike > 0) {
    if (t >= nextSpike && !specSim.spike) { specSim.spike = specSim2.spike = t + opt.spike; specSim.lat = specSim2.lat = opt.lat + 500; spikes++; }
    if (specSim.spike && t >= specSim.spike) { specSim.spike = specSim2.spike = 0; specSim.lat = specSim2.lat = opt.lat; nextSpike = t + 12000; }
  }
  const frozen = opt.freeze > 0 && started && VT - M.t0 >= 20000 && VT - M.t0 < 20000 + opt.freeze * 1000; if (frozen && !WF.t0) WF.t0 = VT;
  for (const p of peers) { if (frozen && p.s === host) continue; if (opt.tickjit > 0) { if (p.owe) { p.owe = 0; p.s.tick(p.input()); } else if (rngTick() < opt.tickjit) { p.owe = 1; continue; } } p.s.tick(p.input()); }
  if (opt.nospec) { if (!hostStarted) hostStarted = t; if (t - hostStarted > opt.secs * 1000) break; continue; }
  const d = spec.tick(0); onSpecTick(VT, d || 0);
  if (spec.specWaiting) { const w = spec.specWaiting(); if (w) { WF.ticksShown++; if (!WF.shownAt) WF.shownAt = VT; if (!frozen && !(WF.t0 && !WF.hiddenAt)) WF.ticksShownOutsideFreeze++; } else if (WF.shownAt && !WF.hiddenAt && !frozen) WF.hiddenAt = VT; }
  if (started && VT - M.t0 > 8000) lagS.push(host.rb.frame - spec.rb.frame); // lag behind the host once the join prebuffer is long gone
  wkRun(VT);
  if (started && VT - M.t0 > opt.secs * 1000) break;
  if (VT > (opt.secs + 60) * 1000) { console.log("spectator never started", JSON.stringify({ hostFrame: host.rb.frame, specSpec: spec.spec, specRb: !!spec.rb, links: host.links.length, specRes: spec.stats.resyncs, VT })); process.exit(2); }
}
finish();
})();
function pct(a, p) { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; }
function finish() {
  const hostSide = { frame: host.rb.frame, confirmed: host.rb.confirmed, stateHash: SNAP.hash(host.m.save()), delay: host.delay, rollbacks: host.rb.stats.rollbacks, rolledFrames: host.rb.stats.rolledFrames, stalls: host.rb.stats.stalls, hostDesyncs: host.stats.desyncs, hashChecks: host.stats.hashChecks, confirmedHashes: hostHashes.length, confirmedHashDigest: crypto.createHash('sha256').update(JSON.stringify(hostHashes)).digest('hex').slice(0, 16),
    players: peers.slice(1).map(p => ({ frame: p.s.rb.frame, rollbacks: p.s.rb.stats.rollbacks, stalls: p.s.rb.stats.stalls, stateHash: SNAP.hash(p.s.m.save()) })) };
  if (opt.nospec) { const r = { label: opt.label || webdir, secs: opt.secs, host: hostSide, hostHashes }; console.log(JSON.stringify(r, null, 1)); if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(r)); process.exit(0); }
  const zeroAfter = M.adv.filter(([t, n]) => t >= 4000 && n === 0).length, secs = (VT - M.t0) / 1000, st = spec.rb.stats, pb = spec.specBuf ? spec.specBuf() : null;
  const res = { label: opt.label || webdir, wallS: +((Date.now() - wall0) / 1000).toFixed(1), secs: +secs.toFixed(1), net: { rttMs: 2 * opt.lat, rttJitterMs: 2 * opt.jit, loss: opt.loss, spikes, spikeMs: opt.spike },
    ticksPerSec: +(M.ticks / secs).toFixed(2), hostFps: +(host.rb.stats.frames / secs).toFixed(1), fps: +(M.frames / secs).toFixed(2), frames: M.frames, specStallsStat: st.stalls, zeroTicks: M.zero, zeroTicksAfter4s: zeroAfter, freezes50ms: M.runs3, longestGapMs: +M.longest.toFixed(0), p99GapMs: +pct(gapsMs, 0.99).toFixed(0), p999GapMs: +pct(gapsMs, 0.999).toFixed(0),
    audio: { underruns: aud.under, overruns: aud.over, droppedSamples: aud.dropped, fillMinSamples: aud.fillMin, fillMaxSamples: aud.fillMax }, resyncs: spec.stats.resyncs, specDesyncs: host.stats.specDesyncs, specHashChecks: host.stats.specHashChecks, hostDesyncs: host.stats.desyncs,
    specLagFrames: host.rb.frame - spec.rb.frame, lag: { minFrames: Math.min(...lagS), p50Frames: pct(lagS, 0.5), p95Frames: pct(lagS, 0.95), maxFrames: Math.max(...lagS), minMs: Math.round(Math.min(...lagS) * STEP), p50Ms: Math.round(pct(lagS, 0.5) * STEP), maxMs: Math.round(Math.max(...lagS) * STEP) }, playout: pb, waitHost: { ticksShown: WF.ticksShown, shownAfterFreezeMs: WF.t0 && WF.shownAt ? Math.round(WF.shownAt - WF.t0) : null, hiddenAfterResumeMs: WF.hiddenAt && WF.t0 ? Math.round(WF.hiddenAt - (WF.t0 + opt.freeze * 1000)) : null, shownWhileHostRunning: WF.ticksShownOutsideFreeze }, host: hostSide, pcmFrames: pcmByFrame.size };
  // PCM identity: hash of the per-frame PCM digests in frame order (A/B scripts compare the common prefix of frames)
  res.pcmDigest = [...pcmByFrame.entries()].sort((a, b) => a[0] - b[0]);
  console.log(JSON.stringify(Object.assign({}, res, { pcmDigest: undefined, pcmFirst: res.pcmDigest.length ? res.pcmDigest[0][0] : null, pcmLast: res.pcmDigest.length ? res.pcmDigest[res.pcmDigest.length - 1][0] : null }), null, 1));
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(Object.assign({ adv: M.adv, hostHashes }, res)));
  process.exit(0);
}
