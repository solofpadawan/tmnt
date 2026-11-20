// TMNT (MAME set 'tmnt', World 4 Players ver. X): builds the machine's ROM regions from the user's own ROM files,
// exactly as MAME tmnt.cpp ROM_START(tmnt) + init_tmnt do. Shared by node tools/tests and the browser loader.
// No ROM data lives in this file; only names and CRC32s.
(function (G) {
  'use strict';
  const NEED = { '963-x23.j17': 0xa9549004, '963-x24.k17': 0xe5cc9067, '963-x21.j15': 0x5789cf92, '963-x22.k15': 0x0a74e277,
    '963e20.g13': 0x1692a6d6, '963a28.h27': 0xdb4769a8, '963a29.k27': 0x8069cd2e, '963a17.h4': 0xb5239a44, '963a15.k4': 0x1f324eed,
    '963a18.h6': 0xdd51adef, '963a16.k6': 0xd4bd9984, '963a30.g7': 0xabd82680, '963a26.c13': 0xe2ac3063, '963a27.d18': 0x2dfd674b,
    '963a25.d5': 0xfca078c7 };
  function load16b(out, base, ev, od) { for (let i = 0; i < ev.length; i++) { out[base + 2 * i] = ev[i]; out[base + 2 * i + 1] = od[i]; } }
  function load32w(out, base, a, b) { for (let i = 0; i < a.length; i += 2) { const o = base + 2 * i; out[o] = a[i]; out[o + 1] = a[i + 1]; out[o + 2] = b[i]; out[o + 3] = b[i + 1]; } }
  // MAME chunky_to_planar: bitswap<32>(31,27,23,19,15,11,7,3, 30,26,...,2, 29,...,1, 28,...,0) on little-endian u32
  const SW = []; for (let g = 3; g >= 0; g--) for (let k = 7; k >= 0; k--) SW.push(4 * k + g);
  function c2p(u8) {
    const u = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2); // box/browsers are little-endian
    for (let i = 0; i < u.length; i++) { const d = u[i]; let r = 0; for (let j = 0; j < 32; j++) r |= ((d >>> SW[j]) & 1) << (31 - j); u[i] = r >>> 0; }
  }
  const PICK = [[3,3,3,3,3,3,3,3],[0,0,5,5,5,5,5,5],[1,1,0,0,0,7,7,7],[2,2,1,1,1,0,0,9],[4,4,2,2,2,1,1,0],
    [5,6,4,4,4,2,2,1],[6,5,6,6,6,4,4,2],[7,7,7,7,8,6,6,4],[8,8,8,8,7,8,8,6],[9,9,9,9,9,9,9,8]];
  function unscramble(u8, prom) {
    const g = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2), t = g.slice();
    for (let A = 0; A < g.length; A++) {
      const e = prom[(A & 0x7f800) >> 11] & 7; let B = A & 0x7fc00;
      for (let i = 0; i < 10; i++) B |= ((A >> PICK[i][e]) & 1) << i;
      g[A] = t[B];
    }
  }
  // gfx layouts (planes {24,16,8,0}: pen bit 3 = byte 3 of each 32-bit row, leftmost pixel = bit 7)
  function rowTo(s, g, d, o) { const b0 = s[g], b1 = s[g + 1], b2 = s[g + 2], b3 = s[g + 3];
    for (let x = 0; x < 8; x++) { const k = 7 - x; d[o + x] = ((b3 >> k) & 1) << 3 | ((b2 >> k) & 1) << 2 | ((b1 >> k) & 1) << 1 | ((b0 >> k) & 1); } }
  function decodeTiles(rom) { const n = rom.length / 4, out = new Uint8Array(n * 8); for (let r = 0; r < n; r++) rowTo(rom, r * 4, out, r * 8); return out; }
  function decodeSprites(rom) { const n = rom.length / 128, out = new Uint8Array(n * 256);
    for (let c = 0; c < n; c++) for (let q = 0; q < 4; q++) for (let y = 0; y < 8; y++)
      rowTo(rom, c * 128 + q * 32 + y * 4, out, c * 256 + ((q >> 1) * 8 + y) * 16 + (q & 1) * 8);
    return out; }
  // raw: name -> Uint8Array (checked by the caller against NEED)
  function build(raw) {
    const prog = new Uint8Array(0x60000);
    load16b(prog, 0, raw['963-x23.j17'], raw['963-x24.k17']); load16b(prog, 0x40000, raw['963-x21.j15'], raw['963-x22.k15']);
    const trom = new Uint8Array(0x100000); load32w(trom, 0, raw['963a28.h27'], raw['963a29.k27']); c2p(trom);
    const srom = new Uint8Array(0x200000); load32w(srom, 0, raw['963a17.h4'], raw['963a15.k4']); load32w(srom, 0x100000, raw['963a18.h6'], raw['963a16.k6']);
    c2p(srom); unscramble(srom, raw['963a30.g7']);
    return { prog, tileRom: trom, spriteRom: srom, tiles: decodeTiles(trom), sprites: decodeSprites(srom),
      z80: raw['963e20.g13'], k007232: raw['963a26.c13'], upd: raw['963a27.d18'], title: raw['963a25.d5'] };
  }
  const api = { NEED, build };
  if (typeof module !== 'undefined') module.exports = api; else G.TMNTROM = api;
})(typeof window !== 'undefined' ? window : globalThis);
