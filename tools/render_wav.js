// node tools/render_wav.js <frames> <out.wav> [rate]: run the machine headless and render the sound board to a mono 16-bit WAV
'use strict';
const fs = require('fs');
const { loadRomset } = require('./romzip.js');
const Machine = require('../web/sim/tmnt.js'), Snd = require('../web/sim/tmntsound.js');
const N = +process.argv[2] || 1200, file = process.argv[3] || 'run/out/ours.wav', hz = +process.argv[4] || 48000;
const rs = loadRomset(), m = new Machine(rs); m.powerOn();
const sb = new Snd(rs, hz);
const t0 = Date.now();
for (let f = 0; f < N; f++) m.step();
sb.push(m.soundLog);
const total = Math.floor(N * 135168 / 8e6 * hz), buf = new Float32Array(total);
sb.render(buf, total, Infinity);
const pcm = Buffer.alloc(44 + total * 2);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + total * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(hz, 24); pcm.writeUInt32LE(hz * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) { let v = Math.round(buf[i] * 32768); v = v < -32768 ? -32768 : v > 32767 ? 32767 : v; pcm.writeInt16LE(v, 44 + 2 * i); }
fs.writeFileSync(file, pcm);
console.log('frames', N, 'samples', total, 'ms', Date.now() - t0, JSON.stringify(sb.dbg));
