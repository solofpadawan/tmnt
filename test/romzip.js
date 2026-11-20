// node helper (test only): read stage/roms/tmnt.zip (local only, never in git / shareable zips), check CRCs, build the ROM regions (assemble/romset.js)
'use strict';
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const RS = require('../assemble/romset.js');
function crc32(u8) { let c = -1; for (let i = 0; i < u8.length; i++) { c ^= u8[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; }
function unzip(buf) {
  let e = buf.length - 22; while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = new Map();
  for (let i = 0; i < n; i++) {
    const m = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const crc = buf.readUInt32LE(p + 16); p += 46 + nl + xl + cl;
    const s = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(s, s + cs);
    out.set(crc >>> 0, m === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
  }
  return out;
}
function loadRomset(zip = path.join(__dirname, '../stage/roms/tmnt.zip')) {
  const files = unzip(fs.readFileSync(zip)), raw = {};
  for (const [name, crc] of Object.entries(RS.NEED)) {
    const f = files.get(crc); if (!f) throw new Error('missing ' + name);
    const u = new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length));
    if (crc32(u) !== crc) throw new Error('bad crc ' + name); raw[name] = u;
  }
  return RS.build(raw);
}
module.exports = { loadRomset };
