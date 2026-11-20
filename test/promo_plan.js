// Promo video, step 0: plan the 4 players' inputs offline (node, real emulator, no RAM writes).
// From power-on: attract runs untouched, at frame C every player inserts 3 coins in their own slot (3 credits) and
// presses attack to join. During play a greedy search picks, every CH frames, one action per player among random
// candidates; each candidate is simulated CH + LA frames ahead and is thrown out if any turtle loses a life, reaches
// 0 energy or loses more than MAXHIT energy (big damage). Score = camera scroll (k052109 layer x scroll) + damage
// dealt to enemies (object slots 12-23 energy) + spread between the turtles (x and depth) - screen-edge penalty.
// Attack/hit animations are not deaths: only lives (0x101+8p) and energy (obj+8) are read.
// usage: node test/promo_plan.js [END=3200] [SEED=1] [OUT=/tmp/tmnt_promo/plan.json]
'use strict';
const fs = require('fs');
const { loadRomset } = require('../tools/romzip.js');
const Machine = require('../web/sim/tmnt.js'), IN = require('../web/input.js');
const END = +process.argv[2] || 3200, SEED = +process.argv[3] || 1, OUT = process.argv[4] || '/tmp/tmnt_promo/plan.json';
const C = 1700, CH = 8, LA = 56, NC = 48, MAXHIT = 1;
const L = 1, R = 2, U = 4, D = 8, A = 0x10, J = 0x20, COIN = 0x40;
const rs = loadRomset(), m = new Machine(rs); m.powerOn(); const w = m.wram;
let f = 0; const plan = [];
const step = fi => { f++; IN.applyFrame(m, fi, true); m.step(); };
const push = fi => { step(fi); plan.push(Array.from(fi)); };
const obj = (i, k) => w[0x2000 + 0x50 * i + k];
const pl = p => { const o = 0x2000 + 0x50 * p; return { x: (w[o + 12] << 8 | w[o + 13]) - 96, z: w[o + 14] << 8 | w[o + 15], e: w[o + 8], l: w[0x101 + 8 * p] }; };
const scroll = () => m.k109[0x3a00] + 256 * m.k109[0x3a01];
let rnd = (SEED * 2654435761) >>> 0; const rand = n => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return (rnd >>> 8) % n; };
// coins + join
while (f < C + 200) { const fi = new Uint8Array(4), k = f + 1 - C;
  for (let p = 0; p < 4; p++) { if ([0, 12, 24].some(a => k >= a + 3 * p && k < a + 3 * p + 4)) fi[p] = COIN; if (k >= 160 + 4 * p && k < 168 + 4 * p) fi[p] = A; }
  push(fi); }
while (w[1] !== 2 || !(obj(0, 0) & 0x80)) push(new Uint8Array(4));
const START = f; console.log('gameplay from frame', START);
const DIRS = [R, R, R | U, R | D, U, D, L, L | U, L | D, 0, R, R | U, R | D];
const MODS = [0, A, A, A, J, J | A, 0];
const frameIn = (acts, k) => { const fi = new Uint8Array(4); for (let s = 0; s < 4; s++) { let a = acts[s];
  if ((a & A) && ((k >> 2) & 1)) a &= ~A; if ((a & J) && k > 3) a &= ~J; fi[s] = a; } return fi; };
const enemyE = () => { const e = []; for (let i = 12; i < 24; i++) e.push(obj(i, 0) & 0x80 ? obj(i, 8) : -1); return e; };
let lastS = scroll(), scr = 0;
const dS = (s, l) => { let d = (s - l + 0x10000) & 0xffff; return d > 0x8000 ? 0 : d; };
function evalCand(acts) {
  const st = m.save(), f0 = f, p0 = [0, 1, 2, 3].map(pl); let ls = lastS, sc = 0, dmg = 0, e0 = enemyE(), ok = true;
  for (let k = 0; k < CH + LA; k++) {
    step(frameIn(k < CH ? acts : acts.map(a => a & ~J), k));
    const s = scroll(); sc += dS(s, ls); ls = s;
    const e1 = enemyE(); for (let i = 0; i < 12; i++) if (e0[i] >= 0) dmg += e1[i] < 0 ? 2 : Math.max(0, e0[i] - e1[i]); e0 = e1;
    for (let p = 0; p < 4; p++) { const q = pl(p); if (q.l < p0[p].l || q.e === 0 || p0[p].e - q.e > MAXHIT) { ok = false; break; } }
    if (!ok) break;
  }
  const ps = [0, 1, 2, 3].map(pl); let spread = 0, edge = 0;
  for (let i = 0; i < 4; i++) { for (let j = i + 1; j < 4; j++) spread += Math.min(40, Math.abs(ps[i].x - ps[j].x)) + Math.min(24, Math.abs(ps[i].z - ps[j].z)) * 1.5;
    if (ps[i].x < 24 || ps[i].x > 244) edge += 40; }
  m.load(st); f = f0; return ok ? sc * 40 + dmg * 60 + spread - edge : -1e9;
}
let fails = 0, back = 0;
while (f < END) {
  let best = null, bs = -1e9;
  for (let c = 0; c < NC; c++) { const acts = [0, 1, 2, 3].map(() => DIRS[rand(DIRS.length)] | MODS[rand(MODS.length)]); const s = evalCand(acts) + rand(8); if (s > bs) { bs = s; best = acts; } }
  if (bs <= -1e9) { // dead end: back up a few chunks and retry with other random draws
    fails++; back = Math.min(back + 2, 12); const to = Math.max(START, f - back * CH);
    if (fails > 400) { console.log('giving up at', f); break; }
    plan.length = to; m.powerOn(); f = 0; for (const r of plan) step(Uint8Array.from(r)); lastS = scroll(); continue;
  }
  back = Math.max(0, back - 1);
  for (let k = 0; k < CH; k++) { push(frameIn(best, k)); const s = scroll(); scr += dS(s, lastS); lastS = s; }
  if (f % 100 < CH) console.log(f, 'scroll', scroll(), 'fails', fails, [0, 1, 2, 3].map(p => { const q = pl(p); return `${q.x},${q.z} e${q.e}`; }).join(' | '));
}
fs.writeFileSync(OUT, JSON.stringify({ C, START, plan })); console.log('done', f, 'scroll', scroll(), 'fails', fails);
