// Promo video, step 2: check the recorded session and render its audio.
//  - every peer's recorded (confirmed) inputs agree with each other and with the plan
//  - every peer's state hashes (every 10 confirmed frames) agree with the host's, and with an offline node replay
//    from power-on with the host's inputs; the F0 snapshot of every peer hashes the same as the replay at F0-1
//  - audio for frames [A, B) from the game's own sound board (tmntsound.js, same path as the page), 48 kHz WAV
// usage: node test/promo_verify.js A B [dir=/tmp/tmnt_promo]
'use strict';
const fs = require('fs');
const { loadRomset } = require('../tools/romzip.js');
const Machine = require('../web/sim/tmnt.js'), Snd = require('../web/sim/tmntsound.js'), IN = require('../web/input.js'), SNAP = require('../web/net/snap.js');
const A = +process.argv[2], B = +process.argv[3], DIR = process.argv[4] || '/tmp/tmnt_promo';
const P = [0, 1, 2, 3].map(i => JSON.parse(fs.readFileSync(`${DIR}/live_p${i}.json`)));
const plan = JSON.parse(fs.readFileSync(`${DIR}/plan.json`)).plan;
const H = P[0], last = Math.min(plan.length, ...P.map(d => d.conf)); let bad = 0;
for (let f = 1; f <= last; f++) {
  const h = H.rec[f]; if (!h) { console.log('host missing frame', f); bad++; break; }
  const want = plan[f - 1].map((v, s) => f >= H.join[s] ? v : 0);
  if (h.join() !== want.join()) { if (bad < 5) console.log('plan differs at', f, h, want); bad++; }
  for (let i = 1; i < 4; i++) { const g = P[i].rec[f]; if (g && g.join() !== h.join()) { if (bad < 5) console.log('peer', i, 'input differs at', f); bad++; } }
}
const cmpPeers = []; for (let i = 1; i < 4; i++) { let n = 0, d = 0; for (const f in P[i].hash) if (H.hash[f] !== undefined) { n++; if (H.hash[f] !== P[i].hash[f]) d++; } cmpPeers.push({ peer: i, compared: n, diffs: d }); bad += d; }
console.log('peer hash checks vs host', JSON.stringify(cmpPeers));
const rs = loadRomset(), m = new Machine(rs); m.powerOn(); const sb = new Snd(rs, 48000); let pos = m.sndEnd();
const buf = new Float32Array(4096), pcm = []; let nrep = 0, drep = 0, snapOk = [];
const snapH = P.map(d => SNAP.hash(SNAP.unpack(Uint8Array.from(d.snap)).m));
for (let f = 1; f < B; f++) {
  IN.applyFrame(m, Uint8Array.from(H.rec[f]), true); m.step();
  sb.push(m.sndSlice(pos, m.sndEnd())); pos = m.sndEnd(); m.trimSound(pos);
  const n = sb.render(buf, buf.length, Snd.zOf(m.now())); if (f >= A) pcm.push(buf.slice(0, n));
  if (f % 10 === 0 && H.hash[f] !== undefined) { nrep++; if (SNAP.hash(m.save()) !== H.hash[f]) drep++; }
  if (f === H.F0 - 1) { const r = SNAP.hash(m.save()); snapOk = snapH.map(x => x === r); }
}
bad += drep + snapOk.filter(x => !x).length;
console.log('offline replay vs host hashes', nrep, 'compared,', drep, 'diffs; F0 snapshots match replay:', snapOk.join(','));
const N = pcm.reduce((s, x) => s + x.length, 0), out = Buffer.alloc(44 + N * 2); let o = 44;
for (const x of pcm) for (const v of x) { out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(v * 32767 + 0.5))), o); o += 2; }
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
out.writeUInt32LE(48000, 24); out.writeUInt32LE(96000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 2, 40);
fs.writeFileSync(`${DIR}/audio_${A}_${B}.wav`, out); console.log('audio', N, 'samples =', (N / 48000).toFixed(3), 's for', B - A, 'frames');
console.log(bad ? 'FAIL ' + bad : 'OK'); process.exit(bad ? 1 : 0);
