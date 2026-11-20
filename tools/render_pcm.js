// node tools/render_pcm.js <frames> <out.f32>: the sound stream exactly as the browser produces it (game.js
// soundFrame: push the event log and render up to the safe point after every frame), raw little-endian Float32.
'use strict';
const fs = require('fs');
const { loadRomset } = require('./romzip.js');
const Machine = require('../web/sim/tmnt.js'), Snd = require('../web/sim/tmntsound.js');
const N = +process.argv[2] || 1500, file = process.argv[3] || 'run/out/node.f32';
const rs = loadRomset(), m = new Machine(rs); m.powerOn();
const sb = new Snd(rs, 48000), buf = new Float32Array(4096), out = [];
let pos = 0;
for (let f = 0; f < N; f++) {
  m.inputs.set([0xff, 0xff, 0xff, 0xff, 0xff], 0); m.step();
  if (m.soundLog.length > pos) { sb.push(m.soundLog.slice(pos)); pos = m.soundLog.length; }
  const n = sb.render(buf, buf.length, Snd.zOf(m.now())); if (n) out.push(buf.slice(0, n));
}
const all = new Float32Array(out.reduce((s, b) => s + b.length, 0)); let p = 0; for (const b of out) { all.set(b, p); p += b.length; }
fs.writeFileSync(file, Buffer.from(all.buffer)); console.log('frames', N, 'samples', all.length);
