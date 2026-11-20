// node tools/run_frames.js 1500 [more frames...]: boot the machine headless, write run/out/ours/<frame>.png
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { loadRomset } = require('./romzip.js');
const Machine = require('../web/sim/tmnt.js'), V = require('../web/render.js');
function png(file, w, h, rgba) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3; raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const frames = process.argv.slice(2).map(Number).sort((a, b) => a - b);
const rs = loadRomset(); V.setGfx(rs.tiles, rs.sprites);
const m = new Machine(rs); m.powerOn();
const out = new Uint32Array(320 * 224), dir = path.join(__dirname, '../run/out/ours'); fs.mkdirSync(dir, { recursive: true });
const t0 = Date.now(); let f = 0;
for (const want of frames) {
  while (f < want) { m.step(); f++; }
  V.render(m.video(), out); png(path.join(dir, want + '.png'), 320, 224, new Uint8Array(out.buffer));
  console.log('frame', want, 'pc', m.cpu.R[16].toString(16), m.unmapped || '');
}
console.log('ms/frame', ((Date.now() - t0) / f).toFixed(2));
