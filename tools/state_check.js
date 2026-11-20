// node tools/state_check.js [N] [M]: full machine state determinism (68000 + Z80 + RAMs + video chips + sound board).
// Plays a 4-player script (coins, joins, random moves) to frame N, saves the machine AND the sound board, packs both
// with net/snap.js (as sent to a joining peer), runs M frames recording every frame's pixels (render.js) and the PCM,
// then (a) restores into the same objects and (b) unpacks into a FRESH machine + board, reruns the same M frames,
// and requires identical frame hashes, state hashes and audio samples. Also checks a rollback-style rewind mid-run.
'use strict';
const { loadRomset } = require('./romzip.js');
const Machine = require('../web/sim/tmnt.js'), Snd = require('../web/sim/tmntsound.js'), V = require('../web/render.js');
const IN = require('../web/input.js'), SNAP = require('../web/net/snap.js');
const N = +process.argv[2] || 2400, M = +process.argv[3] || 600;
const rs = loadRomset(); V.setGfx(rs.tiles, rs.sprites);
function script(f) {
  const o = new Uint8Array(4);
  for (let p = 0; p < 4; p++) {
    if (f >= 600 + 30 * p && f < 608 + 30 * p) o[p] |= 0x40;
    if (f >= 760 + 30 * p && f < 768 + 30 * p) o[p] |= 0x10;
    if (f > 1900) { const x = (Math.imul(Math.floor(f / 17) + 101 * p, 2654435761) >>> 0) >>> 11; o[p] |= [0, 1, 2, 4, 8, 16, 32, 17, 34][x % 9]; }
  }
  return o;
}
function rig(m, sb) {
  const fb = new Uint32Array(320 * 224), buf = new Float32Array(4096); let pos = m.sndEnd();
  return { m, sb, step(f) {
    IN.applyFrame(m, script(f), true); m.step();
    sb.push(m.sndSlice(pos, m.sndEnd())); pos = m.sndEnd(); m.trimSound(pos);
    const n = sb.render(buf, buf.length, Snd.zOf(m.now()));
    V.render(m.video(), fb); return { px: SNAP.hash(fb), st: SNAP.hash(m.save()), pcm: buf.slice(0, n) };
  }, setPos(p) { pos = p; } };
}
const m = new Machine(rs); m.powerOn(); const sb = new Snd(rs, 48000), R = rig(m, sb);
let t0 = Date.now();
for (let f = 1; f <= N; f++) R.step(f);
const saved = { m: m.save(), snd: sb.save() }, blob = SNAP.pack(saved);
const runM = r => { const out = []; for (let f = N + 1; f <= N + M; f++) out.push(r.step(f)); return out; };
const A = runM(R);
m.load(saved.m); sb.load(saved.snd); R.setPos(saved.m.nsnd); const B = runM(R);
const u = SNAP.unpack(blob), m2 = new Machine(rs); m2.powerOn(); m2.load(u.m); const sb2 = new Snd(rs, 48000); sb2.load(u.snd);
const R2 = rig(m2, sb2); const C = runM(R2);
function cmp(X, Y, name) {
  let fd = 0, sd = 0, ad = 0, an = 0, first = -1;
  for (let i = 0; i < X.length; i++) {
    if (X[i].px !== Y[i].px) { fd++; if (first < 0) first = N + 1 + i; }
    if (X[i].st !== Y[i].st) sd++;
    const a = X[i].pcm, b = Y[i].pcm; if (a.length !== b.length) ad += Math.max(a.length, b.length); else for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) ad++;
    an += a.length;
  }
  console.log(`${name}: ${X.length} frames, ${fd} frame diffs, ${sd} state-hash diffs, ${ad}/${an} audio sample diffs${first >= 0 ? ' first frame ' + first : ''}`);
  return fd + sd + ad;
}
let bad = cmp(A, B, 'restore same objects') + cmp(A, C, 'restore packed into fresh machine');
// rollback-style: from the restored machine, rewind 8 frames several times (machine only, as the netcode does)
m.load(saved.m); sb.load(saved.snd); R.setPos(saved.m.nsnd);
const D = []; let f = N + 1;
while (f <= N + M) {
  const k = Math.min(8, N + M - f + 1), s0 = m.save();
  // speculative run with different (wrong) inputs, then rewind and run the real ones
  for (let i = 0; i < k; i++) { IN.applyFrame(m, new Uint8Array([3, 12, 48, 0x40]), true); m.step(); }
  m.load(s0);
  for (let i = 0; i < k; i++) D.push(R.step(f++));
}
bad += cmp(A, D, 'speculate+rewind every 8 frames');
const bytes = blob.length, wav = A.reduce((s, x) => s + x.pcm.length, 0);
console.log(`state blob ${bytes} bytes (machine+board), audio ${wav} samples, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(bad ? 'FAIL' : 'OK');
process.exit(bad ? 1 : 0);
