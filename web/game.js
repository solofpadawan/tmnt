// TMNT remake: the original 68000 program on the emulated board (sim/tmnt.js), drawn by render.js at 320x224,
// fixed step at 6,000,000/(384*264) = 59.1856 Hz, shown through gfx.js (WebGL CRT + original 16:9 bezel).
// Opens straight into the game: ROMs come from the IndexedDB cache, or the player picks their zip once (romload.js).
// Inputs: input.js (4 players, keyboard + gamepads, F1 to remap). ?pause=1 starts paused (TMNTG.runTo(n) for tests),
// ?sound=0 no sound, ?audiotest=1 the worklet records what it receives and plays (tests).
// The AudioContext is created when the machine is ready and stays silent until a user gesture resumes it;
// a small i18n "Clique para ativar o som" / "Click to enable sound" hint is shown only while the context is suspended or interrupted.
'use strict';
const W = 320, H = 224, HZ = 6000000 / (384 * 264), STEP = 1000 / HZ;
const cv = document.getElementById('screen'), ctx = cv.getContext('2d');
const img = ctx.createImageData(W, H), fb = new Uint32Array(img.data.buffer);
const q = new URLSearchParams(location.search);
let m = null, frame = 0, paused = !!q.get('pause'), acc = 0, last = performance.now();
TMNTIN.attach(window); TMNTGFX.layout();
// sound: the board runs on the main thread from the machine's one-way event log; PCM goes to an AudioWorklet FIFO
let snd = null, sndPos = 0, actx = null, anode = null, duck = null, audio = null;
const sndBuf = new Float32Array(4096), AT = !!q.get('audiotest');
// sndPos = absolute index (m.sndBase-relative log, see Machine.trimSound) of the next event for the board
function soundTo(end, cyc) {
  if (snd) {
    if (end > sndPos) snd.push(m.sndSlice(sndPos, end));
    const n = snd.render(sndBuf, sndBuf.length, TMNTSound.zOf(cyc));
    if (anode && n) anode.port.postMessage({ pcm: sndBuf.slice(0, n) });
  }
  sndPos = end; m.trimSound(sndPos);
}
function soundFrame() { soundTo(m.sndEnd(), m.now()); }
// ---- netplay (net/ui.js): the session owns the stepping; netStep(fi, f) runs every (re)simulated frame. Only confirmed
// frames (never rolled back) reach the sound board: netAudio(snap after the frame). A full state (joining) carries the
// host's board state (netExt), loaded by netAudioResync, so every peer hears the same stream.
let net = null;
function netStep(fi, f) { TMNTIN.applyFrame(m, fi, true); m.step(); frame = f; }
// spectator audio FIFO: bigger cushion (net/session.js SPEC_AUDIO); players / promoted spectators go back to the worklet defaults
let wkSpec = false;
function wkSync() { const sp = !!(net && net.session && net.session.spec); if (!anode || sp === wkSpec || !window.TMNTSESSION) return; wkSpec = sp; anode.port.postMessage({ cfg: sp ? TMNTSESSION.SPEC_AUDIO : TMNTSESSION.PLAYER_AUDIO }); }
// spectator-only "Waiting for the host..." overlay (net/session.js specWaiting: no new confirmed frame for ~3 s, i.e. the host's tab is in the background).
// Evaluated after each spectator tick (no timer of its own); hidden as soon as frames resume. Players, the host and the desktop build (app:) never show it.
let waitEl = null;
function waitHostText() { try { if (typeof t === 'function') return t('net.waitHost'); } catch (e) {} return 'Waiting for the host\u2026'; }
function syncWaitHost() {
  const s = net && net.session, on = !!(s && s.spec === true && s.specWaiting && location.protocol !== 'app:' && s.specWaiting());
  if (!waitEl) {
    if (!on) return;
    waitEl = document.createElement('div'); waitEl.id = 'spwait'; waitEl.setAttribute('role', 'status');
    waitEl.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:13;pointer-events:none;text-align:center;background:rgba(4,18,8,.88);color:#ffe9a8;border:2px solid #3fae3a;border-radius:10px;padding:8px 16px;font:700 clamp(16px,1.7vw,32px) system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:90vw;letter-spacing:.02em';
    document.body.appendChild(waitEl);
  }
  if (on) { const tx = waitHostText(); if (waitEl.textContent !== tx) waitEl.textContent = tx; }
  waitEl.style.display = on ? 'block' : 'none';
}
function netAudio(after) { soundTo(after.nsnd, TMNTMachine.nowOf(after)); }
function netExt() { return { board: snd ? snd.save() : null, pos: sndPos }; }
let pendingResync = null, unlockEl = null, audioStarting = null;
function soundWanted() { return q.get('sound') !== '0'; }
function unlockText() { try { if (typeof t === 'function') return t('sound.unlock'); } catch (e) {} return 'Click to enable sound'; }
function audioBlocked() {
  const ac = audio && audio.ac;
  if (!ac || !soundWanted()) return false;
  return ac.state === 'suspended' || ac.state === 'interrupted';
}
function syncUnlockHint() {
  const show = audioBlocked();
  if (!unlockEl) {
    if (!show) return;
    unlockEl = document.createElement('div');
    unlockEl.id = 'sndhint';
    unlockEl.setAttribute('role', 'status');
    // TMNT green theme (same family as #nphint.fb), centered over the game
    unlockEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:13;pointer-events:none;text-align:center;background:rgba(4,18,8,.88);color:#ffe9a8;border:2px solid #3fae3a;border-radius:10px;padding:8px 16px;font:700 16px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:90vw;letter-spacing:.02em';
    document.body.appendChild(unlockEl);
  }
  unlockEl.textContent = unlockText();
  unlockEl.style.display = show ? 'block' : 'none';
}
function applyNetAudioResync(snap) {
  if (!snap) return;
  if (snd && snap.ext && snap.ext.board) snd.load(snap.ext.board);
  if (snap.nsnd != null) sndPos = snap.nsnd;
}
// A host state is applied to the board the moment it arrives (as before). It is parked in pendingResync ONLY while the board does not exist yet,
// and applied once when the board is created (boot). It is never replayed when the AudioWorklet node is created: with a browser-blocked AudioContext
// that happens at the first click, possibly minutes after joining, and the join-time state was stale by then (spectator board diverged from the host's).
function netAudioResync(snap) {
  if (!snd) { pendingResync = snap; return; }
  pendingResync = null;
  applyNetAudioResync(snap);
}
// One AudioContext for the game and voice chat. The worklet feeds a master GainNode (duck) then the destination;
// voice.js only moves duck.gain (1 when nobody is talking). gain=1 is a no-op on the stream (audiotest still
// records the worklet output, before the GainNode). Created when the machine is ready; stays silent until a
// user gesture resumes it. The unlock hint is shown only while the context is suspended or interrupted.
function attachDuck(ac) {
  if (duck && duck.context === ac) return duck;
  duck = ac.createGain(); duck.gain.value = 1;
  duck.connect(ac.destination);
  return duck;
}
function ensureCtx() {
  if (!soundWanted()) return null;
  if (audio && audio.ac) return audio.ac;
  if (actx && actx.createGain) {
    attachDuck(actx);
    if (!audio) audio = { ac: actx, duck, node: anode, ready: !!anode };
    return actx;
  }
  const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  actx = ac;
  attachDuck(ac);
  audio = { ac, duck, node: null, ready: false };
  ac.addEventListener('statechange', syncUnlockHint);
  return ac;
}
async function startAudio() {
  if (!soundWanted()) return null;
  const ac = ensureCtx(); if (!ac) return null;
  if (ac.state === 'suspended' || ac.state === 'interrupted') { try { await ac.resume(); } catch (e) {} }
  if (!audio.ready) {
    if (!audioStarting) {
      audioStarting = (async () => {
        try {
          await ac.audioWorklet.addModule('audio_worklet.js' + (window.TMNTV_STAMP ? '?v=' + window.TMNTV_STAMP : ''));
          if (audio.ready) return;
          anode = new AudioWorkletNode(ac, 'tmnt-audio', { outputChannelCount: [2], processorOptions: { test: AT } });
          anode.connect(duck);
          audio.node = anode; audio.ready = true;
        } catch (e) {
          console.warn('audio off:', e);
          audioStarting = null;
        }
      })();
    }
    try { await audioStarting; } catch (e) { audioStarting = null; throw e; }
  }
  syncUnlockHint();
  return ac;
}
for (const ev of ['keydown', 'pointerdown']) addEventListener(ev, () => { startAudio().catch(e => console.warn('audio', e)); }, true);
try { if (window.i18next && i18next.on) i18next.on('languageChanged', syncUnlockHint); } catch (e) {}
function stepOne(fi) { frame++; TMNTIN.applyFrame(m, fi || TMNTIN.sample()); m.step(); soundFrame(); }
let ldOn = !!window.TMNTLOADING; // loading overlay (loading.js): removed on the first drawn game frame
function draw() { TMNTV.render(m.video(), fb); ctx.putImageData(img, 0, 0); TMNTGFX.present(img); if (window.TMNTCHAT) TMNTCHAT.draw(m); if (ldOn) { ldOn = false; TMNTLOADING.done(); } }
const msStep = [];
function tickOnce() {
  const t0 = performance.now();
  if (net && net.active()) { wkSync(); const fi = TMNTIN.sample(); net.tick(fi[0] | fi[1] | fi[2] | fi[3]); syncWaitHost(); } else { stepOne(); if (waitEl) syncWaitHost(); }
  msStep.push(performance.now() - t0); if (msStep.length > 240) msStep.shift();
}
function loop(t) {
  if (m && !paused) { acc += t - last; let n = 0; while (acc >= STEP && n < 4) { tickOnce(); acc -= STEP; n++; } if (acc > 100) acc = 0; if (n) draw(); }
  else if (m && window.TMNTCHAT) TMNTCHAT.draw(m);
  last = t; requestAnimationFrame(loop);
}
async function boot() {
  if (q.get('audiotest')) await startAudio(); // tests: headless runs with --autoplay-policy=no-user-gesture-required
  const rs = await TMNTLOAD.ensure(); TMNTV.setGfx(rs.tiles, rs.sprites);
  m = new TMNTMachine(rs); m.powerOn(); frame = 0;
  if (soundWanted()) {
    snd = new TMNTSound(rs, (actx && actx.sampleRate) || 48000); sndPos = 0;
    if (pendingResync) { applyNetAudioResync(pendingResync); pendingResync = null; } // a state that arrived before the board existed
    if (window.TMNTLOADING) TMNTLOADING.stage('sound'); // AudioContext + AudioWorklet module (runs in parallel with the first frames)
    ensureCtx();
    startAudio().catch(e => console.warn('audio', e));
  }
  syncUnlockHint();
  TMNTGFX.layout(); last = performance.now(); acc = 0; window.TMNTG.ready = true; readyRes();
  if (paused && window.TMNTLOADING) TMNTLOADING.done(); // ?pause=1 (tests): no frame is drawn until runTo(), nothing left to wait for
}
let readyRes; const whenReady = new Promise(r => { readyRes = r; });
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
window.TMNTG = { ready: false, whenReady, get machine() { return m; }, get net() { return net; }, set net(v) { net = v; },
  netStep, netAudio, netExt, netAudioResync, get frameNo() { return frame; }, set frameNo(v) { frame = v; }, msPerFrame: () => avg(msStep), draw: () => draw(),
  get board() { return snd; }, frame: () => frame, pause(p) { paused = p; last = performance.now(); acc = 0; },
  // tests: run to frame n with live inputs, or with a per-frame FrameInput script fn(frame) -> [p1,p2,p3,p4]
  runTo(n, script) { while (frame < n) stepOne(script ? Uint8Array.from(script(frame + 1)) : null); draw(); return frame; },
  audioCmd(cmd) { return new Promise(res => { if (!anode) return res(null); anode.port.onmessage = e => res(e.data); anode.port.postMessage({ cmd }); }); },
  ports: () => m.inputs.slice(0, 5), get actx() { return actx; },
  get audio() { return audio; }, get specAudio() { return wkSpec; }, get waitHostShown() { return !!(waitEl && waitEl.style.display === 'block'); }, startAudio, ensureAudio: startAudio };
boot().catch(e => {
  console.error(e);
  if (window.TMNTLOADING) TMNTLOADING.error(e && e.message ? e.message : e); // same box, same place, stays visible
  else document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;color:#f88;z-index:40">${e.message}</pre>`);
});
requestAnimationFrame(loop);
