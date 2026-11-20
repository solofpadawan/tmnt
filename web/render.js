// TMNT video renderer (MAME tmnt.cpp screen_update): K052109 tilemaps (layer 2 opaque, 1, 0) + K051960 sprites
// (between layers 1/2 or 1/0 by the priority latch), xBGR_555 palette, shadows at factor 0.75.
// Draws a 384x264 bitmap and outputs the visible 320x224 (x 0..319, lines 16..239).
'use strict';
const TMNTV = (() => {
  const BW = 384, BH = 264, W = 320, H = 224, NPEN = 1024;
  let tiles = null, sprites = null;
  const bmp = new Int32Array(BW * BH);
  function setGfx(t, s) { tiles = t; sprites = s; }
  const LCB = [0, 32, 40], SCB = 16;
  const tcode = new Int32Array(2048), tcol = new Int32Array(2048), tfy = new Uint8Array(2048), rs = new Int32Array(256), cs = new Int32Array(64);
  function layer(v, l, opaque) {
    const ram = v.k109, cb = 0x800 * l, v1 = 0x2000 + 0x800 * l, v2 = 0x4000 + 0x800 * l;
    for (let i = 0; i < 2048; i++) {
      let color = ram[cb + i], code = ram[v1 + i] + 256 * ram[v2 + i];
      let bank = v.crb[(color & 0x0c) >> 2];
      if (!(v.addrmap & 0x40)) color = (color & 0xf3) | ((bank & 3) << 2);
      bank >>= 2;
      tfy[i] = (color & 2) && (v.tileflip & 4) ? 1 : 0;
      code |= ((color & 3) << 8) | ((color & 0x10) << 6) | ((color & 0x0c) << 9) | (bank << 13);
      tcode[i] = (code & 0x7fff) * 64; tcol[i] = (LCB[l] + ((color & 0xe0) >> 5)) * 16;
    }
    let mode = 0, yscroll = 0, xscroll0 = 0, xo = 96;
    if (l) {
      const sc = (v.scrollctl >> ((l - 1) * 3)) & 7, m = l === 2 ? 0x2000 : 0, sy = 0x1800 | m, sx = 0x1a00 | m;
      const rows = [1, 1, 32, 256][sc & 3], cols = sc & 4 ? 64 : 1;
      yscroll = ram[sy + 12]; xscroll0 = ram[sx] + 256 * ram[sx + 1]; xo = 90;
      if (rows > 1) {
        mode = 1; const mask = rows === 256 ? 0xff : 0xf8;
        for (let o = 0; o < 256; o++) { const q = o & mask; rs[(o + yscroll) & 0xff] = ram[sx + 2 * q] + 256 * ram[sx + 2 * q + 1]; }
      } else if (cols > 1) {
        mode = 2; for (let o = 0; o < 64; o++) cs[(o + (xscroll0 >> 3)) & 0x3f] = ram[sy + o];
      }
    }
    for (let y = 16; y < 240; y++) {
      let ty = (y + (mode === 2 ? 0 : yscroll)) & 255;
      const xs = xo + (mode === 1 ? rs[ty] : xscroll0), row = y * BW;
      for (let x = 0; x < W; x++) {
        const tx = (x + xs) & 511;
        if (mode === 2) ty = (y + cs[tx >> 3]) & 255;
        const ti = (ty >> 3) * 64 + (tx >> 3);
        const py = tfy[ti] ? 7 - (ty & 7) : ty & 7;
        const p = tiles[tcode[ti] + py * 8 + (tx & 7)];
        if (p || opaque) bmp[row + x] = tcol[ti] + p;
      }
    }
  }
  const XO = [0, 1, 4, 5, 16, 17, 20, 21], YO = [0, 2, 8, 10, 32, 34, 40, 42], SW = [1, 2, 1, 2, 4, 2, 4, 8], SH = [1, 1, 2, 2, 2, 4, 4, 8];
  const ZY = [0x00,0x01,0x03,0x05,0x07,0x09,0x0a,0x0c,0x0e,0x0f,0x11,0x12,0x14,0x15,0x16,0x18,0x19,0x1a,0x1c,0x1d,0x1e,0x1f,0x20,0x21,
    0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x29,0x2a,0x2b,0x2c,0x2d,0x2e,0x2e,0x2f,0x30,0x31,0x31,0x32,0x33,0x34,0x34,0x35,0x36,
    0x36,0x37,0x38,0x38,0x39,0x39,0x3a,0x3b,0x3b,0x3c,0x3c,0x3d,0x3d,0x3e,0x3e,0x3f];
  // MAME drawgfx(zoom) of one 16x16 cell, transtable: pen 0 none, pen 15 shadow if shadow, else source; clip 0..319 x 16..239
  function cell(c, color, fx, fy, sx, sy, zw, zh, shadow) {
    const tb = (c & 0x3fff) * 256;
    if (zw <= 0 || zh <= 0) return;
    const dxs = Math.floor((16 << 16) / zw), dys = Math.floor((16 << 16) / zh);
    for (let yy = 0; yy < zh; yy++) {
      const Y = sy + yy; if (Y < 16 || Y >= 240) continue;
      const srow = tb + (((fy ? (zh - 1 - yy) * dys : yy * dys)) >> 16) * 16, row = Y * BW;
      for (let xx = 0; xx < zw; xx++) {
        const X = sx + xx; if (X < 0 || X >= W) continue;
        const p = sprites[srow + ((fx ? (zw - 1 - xx) * dxs : xx * dxs) >> 16)];
        if (!p) continue;
        const i = row + X;
        if (p === 15 && shadow) { if (bmp[i] < NPEN) bmp[i] += NPEN; } else bmp[i] = color + p;
      }
    }
  }
  function spritesDraw(v) {
    const b = v.sbuf, sorted = new Int32Array(128).fill(-1);
    for (let offs = 0; offs < 0x400; offs += 8) if (b[offs] & 0x80) sorted[b[offs] & 0x7f] = offs;
    for (let pc = 0; pc < 128; pc++) {
      const offs = sorted[pc]; if (offs < 0) continue;
      let code = b[offs + 2] + ((b[offs + 1] & 0x1f) << 8), color = b[offs + 3];
      const shadow = !(v.shcfg & 4) && ((v.shcfg & 2) || (color & 0x80));
      code |= (color & 0x10) << 9; color = (SCB + (color & 0x0f)) * 16;
      const size = b[offs + 1] >> 5, w = SW[size], h = SH[size];
      if (w >= 2) code &= ~1; if (h >= 2) code &= ~2; if (w >= 4) code &= ~4; if (h >= 4) code &= ~8; if (w >= 8) code &= ~0x10; if (h >= 8) code &= ~0x20;
      let ox = (256 * b[offs + 6] + b[offs + 7]) & 0x1ff, oy = 256 - ((256 * b[offs + 4] + b[offs + 5]) & 0x1ff);
      let flipx = b[offs + 6] & 2 ? 1 : 0, flipy = b[offs + 4] & 2 ? 1 : 0;
      const zoomx = (0x10000 / 128 | 0) * (128 - ((b[offs + 6] & 0xfc) >> 2));
      let zoomy = 128 - ZY[(b[offs + 4] & 0xfc) >> 2];
      for (let i = 0; i < 3; i++) if (h <= (1 << i)) zoomy = ((zoomy + 1) / 2) | 0;
      zoomy *= (8 / h) | 0; zoomy = (0x10000 / 128 | 0) * zoomy;
      if (v.ctl51 & 8) { ox = 512 - ((zoomx * w) >> 12) - ox; oy = 256 - ((zoomy * h) >> 12) - oy; flipx ^= 1; flipy ^= 1; }
      const plain = zoomx === 0x10000 && zoomy === 0x10000;
      for (let y = 0; y < h; y++) {
        const sy = plain ? oy + 16 * y : oy + ((zoomy * y + 2048) >> 12), zh = plain ? 16 : oy + ((zoomy * (y + 1) + 2048) >> 12) - sy;
        for (let x = 0; x < w; x++) {
          const sx = plain ? ox + 16 * x : ox + ((zoomx * x + 2048) >> 12), zw = plain ? 16 : ox + ((zoomx * (x + 1) + 2048) >> 12) - sx;
          const c = code + (flipx ? XO[w - 1 - x] : XO[x]) + (flipy ? YO[h - 1 - y] : YO[y]);
          // MAME zoom drawgfx: dest size = (scale*16 + 0x8000) >> 16 with scale = (zw<<16)/16 -> zw
          cell(c, color, flipx, flipy, (sx & 0x1ff) - 96, sy, zw, zh, shadow);
        }
      }
    }
  }
  const lut = new Uint32Array(2 * NPEN);
  function render(v, out /* Uint32Array 320*224 RGBA */) {
    layer(v, 2, true);
    if (v.pri & 1) spritesDraw(v);
    layer(v, 1, false);
    if (!(v.pri & 1)) spritesDraw(v);
    layer(v, 0, false);
    const pal = v.pal, c5 = x => (x << 3) | (x >> 2);
    for (let p = 0; p < NPEN; p++) {
      const w = (pal[2 * p] << 8) | pal[2 * p + 1], r = c5(w & 31), g = c5((w >> 5) & 31), b = c5((w >> 10) & 31);
      lut[p] = 0xff000000 | (b << 16) | (g << 8) | r;
      const s = x => Math.trunc(x * 0.75);
      lut[NPEN + p] = 0xff000000 | (s(b) << 16) | (s(g) << 8) | s(r);
    }
    for (let y = 0; y < H; y++) { const s = (y + 16) * BW, d = y * W; for (let x = 0; x < W; x++) out[d + x] = lut[bmp[s + x]]; }
  }
  return { setGfx, render, W, H };
})();
if (typeof module !== 'undefined') module.exports = TMNTV;
