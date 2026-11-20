// TMNT (Konami GX963, MAME set "tmnt", World 4 Players ver. X) machine: 68000 + Konami video glue, following MAME
// tmnt.cpp (tmnt_main_map, tmnt machine config) and the K052109 / K051960+K051937 devices.
// Deterministic, integer-only: one 68000 cycle counter (8 MHz, 135168 cycles per 384x264 frame at 6 MHz pixel clock).
// The whole state (CPU registers + RAMs + chip registers) is save()/load()-able (rollback netcode later).
// Sound board: sim/tmntsound.js, driven one-way by soundLog ([68000 cycle, latch byte or 0x100 = Z80 IRQ]).

(function (G) {
  'use strict';
  const M68K = typeof require !== 'undefined' ? require('./m68k.js') : G.M68K;
  const FRAME = 135168;          // 8 MHz / (6 MHz / (384 * 264))
  const RESET_CYC = 34;
  // scalar slots
  const S_CYC0 = 0, S_FRAME = 1, S_LAST = 2, S_IRQ5M = 3, S_RMRD = 4, S_PRI = 5, S_ADDRMAP = 6, S_SCROLLCTL = 7, S_ROMSUB = 8,
    S_TILEFLIP = 9, S_CRB = 10 /*10..13*/, S_CTL51 = 14, S_SHCFG = 15, S_SROMB = 16 /*16..18*/, S_BUSY = 19, S_LATCH = 20,
    S_COUNT = 21, S_ROMOFS = 22, S_LEN = 24;

  function Machine(rs) { // rs = TMNTROM.build(...) result
    this.rom = rs.prog; this.tileRom = rs.tileRom; this.spriteRom = rs.spriteRom;
    this.wram = new Uint8Array(0x4000);
    this.pal = new Uint8Array(0x800);         // palette byte RAM (umask 0x00ff), entry n = pal[2n]<<8 | pal[2n+1]
    this.k109 = new Uint8Array(0x6000);       // K052109 RAM
    this.k960 = new Uint8Array(0x400);        // K051960 sprite RAM
    this.sbuf = new Uint8Array(0x400);        // sprite buffer (copied at vblank)
    this.s = new Int32Array(S_LEN);
    // inputs, active low: P1..P4 (KONAMI16_LSB: 0 left 1 right 2 up 3 down 4 attack 5 jump 7 start), COINS, DSW1-3
    this.inputs = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5e, 0xff]);
    this.soundLog = []; this.sndBase = 0;      // soundLog[i] is event entry sndBase+i (absolute index, see trimSound)
    this.cpu = new M68K.CPU(this.makeBus());
    this.cpu.ephase = () => this.ephase();
    this.unmapped = null;
  }
  Machine.FRAME = FRAME;
  Machine.prototype.now = function () { return (this.s[S_CYC0] + FRAME - this.cpu.R[24]) | 0; };
  Machine.prototype.ephase = function () { return ((((this.s[S_FRAME] - 1) % 10) * (FRAME % 10) + FRAME - this.cpu.R[24]) % 10 + 20) % 10; };
  Machine.prototype.powerOn = function () {
    this.wram.fill(0); this.pal.fill(0); this.k109.fill(0); this.k960.fill(0); this.sbuf.fill(0); this.s.fill(0); this.soundLog.length = 0; this.sndBase = 0;
    const R = this.cpu.R; R.fill(0); this.cpu.reset();
    this.s[S_CYC0] = -FRAME; this.s[S_FRAME] = 1; R[24] = -RESET_CYC;
  };
  // Advance one frame: run the 68000 up to the next vblank start. Render after step() (MAME draws the frame before the
  // vblank callbacks run), then the next step() applies vblank: IRQ5 (if enabled) and the K051960 sprite DMA.
  Machine.prototype.step = function () {
    const R = this.cpu.R, s = this.s;
    if (s[S_FRAME] > 1) this.vblank();
    s[S_CYC0] += FRAME; R[24] += FRAME;
    this.cpu.run();
    s[S_FRAME]++;
  };
  Machine.prototype.vblank = function () {
    const s = this.s, R = this.cpu.R;
    if (s[S_IRQ5M]) { R[26] = 5; }
    if (!(s[S_CTL51] & 0x10)) {
      this.sbuf.set(this.k960); let a = 0; for (let i = 0; i < 0x400; i += 8) a += this.sbuf[i] >> 7;
      s[S_BUSY] = (s[S_CYC0] + FRAME + Math.floor(((a * 32 + (128 - a) * 18) * 4) / 3)) | 0;
    }
  };
  Machine.prototype.frame = function () { return this.s[S_FRAME]; };

  // ---------------- K052109 ----------------
  Machine.prototype.k109r = function (o) {
    const s = this.s;
    if (!s[S_RMRD]) return this.k109[o];
    let code = (o & 0x1fff) >> 5; const color = s[S_ROMSUB], bank = s[S_CRB + ((color & 0x0c) >> 2)] >> 2;
    code |= ((color & 0x03) << 8) | ((color & 0x10) << 6) | ((color & 0x0c) << 9) | (bank << 13); // tmnt_tile_callback
    return this.tileRom[((code << 5) + (o & 0x1f)) & 0xfffff];
  };
  Machine.prototype.k109w = function (o, d) {
    const s = this.s; this.k109[o] = d;
    if ((o & 0x1fff) < 0x1800) return;
    if (o === 0x1c00) s[S_ADDRMAP] = d;
    else if (o === 0x1c80) s[S_SCROLLCTL] = d;
    else if (o === 0x1d80) { s[S_CRB] = d & 15; s[S_CRB + 1] = d >> 4; }
    else if (o === 0x1e00 || o === 0x3e00) s[S_ROMSUB] = d;
    else if (o === 0x1e80) s[S_TILEFLIP] = d & 7;
    else if (o === 0x1f00) { s[S_CRB + 2] = d & 15; s[S_CRB + 3] = d >> 4; }
    // 0x1d00 irq control: the K052109 IRQ lines are not connected on TMNT
  };
  // ---------------- K051960 / K051937 ----------------
  Machine.prototype.fetchSpr = function (off) {
    const s = this.s, addr = s[S_ROMOFS] + (s[S_SROMB] << 8) + ((s[S_SROMB + 1] & 3) << 16);
    let code = (addr & 0x3ffe0) >> 5; const off1 = addr & 0x1f, color = ((s[S_SROMB + 1] & 0xfc) >> 2) + ((s[S_SROMB + 2] & 3) << 6);
    code |= (color & 0x10) << 9;
    return this.spriteRom[((code << 7) | (off1 << 2) | off) & 0x1fffff];
  };
  Machine.prototype.k937r = function (o) {
    const s = this.s;
    if ((s[S_CTL51] & 0x20) && (o & 4)) return this.fetchSpr(o & 3);
    if (o === 0) return ((this.now() - s[S_BUSY]) | 0) < 0 ? 1 : 0;
    return 0;
  };
  Machine.prototype.k937w = function (o, d) {
    const s = this.s;
    if (o === 0) s[S_CTL51] = d; else if (o === 1) s[S_SHCFG] = d & 7; else if (o >= 2 && o < 5) s[S_SROMB + o - 2] = d;
  };
  Machine.prototype.k960r = function (o) {
    if (this.s[S_CTL51] & 0x20) { this.s[S_ROMOFS] = (o & 0x3fc) >> 2; return this.fetchSpr(o & 3); }
    return this.k960[o];
  };
  // ---------------- 0x0a0000 control ----------------
  Machine.prototype.ctlW = function (d) {
    const s = this.s;
    if (s[S_LAST] === 8 && !(d & 8)) { s[S_COUNT]++; this.soundLog.push(this.now(), 0x100); } // Z80 IRQ (HOLD_LINE)
    s[S_LAST] = d & 8;
    s[S_IRQ5M] = d & 0x20; if (!s[S_IRQ5M] && this.cpu.R[26] === 5) this.cpu.R[26] = 0;
    s[S_RMRD] = (d >> 7) & 1;
  };

  // ---------------- bus ----------------
  Machine.prototype.makeBus = function () {
    const self = this, rom = this.rom, wram = this.wram, pal = this.pal, inp = this.inputs;
    // byte-level device access (a = full address)
    function devR8(a) {
      if (a >= 0x080000 && a < 0x081000) return (a & 1) ? pal[(a - 0x080000) >> 1] : 0;
      if (a >= 0x100000 && a < 0x108000) { const w = (a - 0x100000) >> 1, o = ((w & 0x3000) >> 1) | (w & 0x7ff); return (a & 1) ? self.k109r(o + 0x2000) : self.k109r(o); }
      if (a >= 0x140400 && a < 0x140800) return self.k960r(a - 0x140400);
      if (a >= 0x140000 && a < 0x140008) return self.k937r(a & 7);
      if (a >= 0x0a0000 && a < 0x0a0020) {
        if (!(a & 1)) return 0;
        switch (a & 0x1e) { case 0: return inp[4]; case 2: return inp[0]; case 4: return inp[1]; case 6: return inp[2]; case 0x14: return inp[3];
          case 0x10: return inp[5]; case 0x12: return inp[6]; case 0x18: return inp[7]; }
      }
      if (!self.unmapped) self.unmapped = 'read ' + a.toString(16) + ' pc ' + self.cpu.R[27].toString(16);
      return 0;
    }
    function devW8(a, d) {
      if (a >= 0x080000 && a < 0x081000) { if (a & 1) pal[(a - 0x080000) >> 1] = d; return; }
      if (a >= 0x100000 && a < 0x108000) { const w = (a - 0x100000) >> 1, o = ((w & 0x3000) >> 1) | (w & 0x7ff); self.k109w((a & 1) ? o + 0x2000 : o, d); return; }
      if (a >= 0x140400 && a < 0x140800) { self.k960[a - 0x140400] = d; return; }
      if (a >= 0x140000 && a < 0x140008) { self.k937w(a & 7, d); return; }
      if (a === 0x0a0001) { self.ctlW(d); return; }
      if (a === 0x0a0000) { return; }
      if (a === 0x0a0009) { self.s[S_LATCH] = d; self.soundLog.push(self.now(), d); return; }
      if (a === 0x0a0010 || a === 0x0a0011) return; // watchdog
      if (a === 0x0c0001) { self.s[S_PRI] = (d & 0x0c) >> 2; return; }
      if (a === 0x0c0000) return;
      if (!self.unmapped) self.unmapped = 'write ' + a.toString(16) + ' pc ' + self.cpu.R[27].toString(16);
    }
    function rw(a) {
      a &= 0xfffffe;
      if (a < 0x60000) return (rom[a] << 8) | rom[a + 1];
      if (a >= 0x60000 && a < 0x64000) { a -= 0x60000; return (wram[a] << 8) | wram[a + 1]; }
      if (a >= 0x100000 && a < 0x108000) { const w = (a - 0x100000) >> 1, o = ((w & 0x3000) >> 1) | (w & 0x7ff); return self.k109r(o) << 8; } // MAME noA12_r: word access -> upper byte only
      return (devR8(a) << 8) | devR8(a + 1);
    }
    function rb(a) {
      a &= 0xffffff;
      if (a < 0x60000) return rom[a];
      if (a >= 0x60000 && a < 0x64000) return wram[a - 0x60000];
      return devR8(a);
    }
    function ww(a, d) {
      a &= 0xfffffe;
      if (a >= 0x60000 && a < 0x64000) { a -= 0x60000; wram[a] = d >> 8; wram[a + 1] = d; return; }
      if (a < 0x60000) return;
      if (a >= 0x100000 && a < 0x108000) { const w = (a - 0x100000) >> 1, o = ((w & 0x3000) >> 1) | (w & 0x7ff); self.k109w(o, (d >> 8) & 0xff); return; } // MAME: word write -> upper byte only
      if (a === 0x0a0000) { self.ctlW(d & 0xff); return; }
      if (a === 0x0c0000) { self.s[S_PRI] = (d & 0x0c) >> 2; return; }
      if (a === 0x0a0010) return;
      devW8(a, (d >> 8) & 0xff); devW8(a + 1, d & 0xff);
    }
    function wb(a, d) {
      a &= 0xffffff; d &= 0xff;
      if (a >= 0x60000 && a < 0x64000) { wram[a - 0x60000] = d; return; }
      if (a < 0x60000) return;
      if (a === 0x0a0000 || a === 0x0a0001) { self.ctlW(d); return; } // 16-bit handler, byte write: data replicated on both lanes
      if (a === 0x0c0000 || a === 0x0c0001) { self.s[S_PRI] = (d & 0x0c) >> 2; return; }
      devW8(a, d);
    }
    const rl = a => ((rw(a) << 16) | rw(a + 2)) >>> 0;
    const wl = (a, d) => { ww(a, d >>> 16); ww(a + 2, d & 0xffff); };
    return { rb, rw, rl, wb, ww, wl };
  };
  // video state for the renderer
  Machine.prototype.video = function () {
    const s = this.s;
    return { k109: this.k109, pal: this.pal, sbuf: this.sbuf, pri: s[S_PRI], addrmap: s[S_ADDRMAP], scrollctl: s[S_SCROLLCTL],
      tileflip: s[S_TILEFLIP], crb: s.subarray(S_CRB, S_CRB + 4), ctl51: s[S_CTL51], shcfg: s[S_SHCFG] };
  };
  Machine.prototype.save = function () {
    return { R: this.cpu.R.slice(), wram: this.wram.slice(), pal: this.pal.slice(), k109: this.k109.slice(), k960: this.k960.slice(),
      sbuf: this.sbuf.slice(), s: this.s.slice(), inputs: this.inputs.slice(), nsnd: this.sndBase + this.soundLog.length };
  };
  Machine.prototype.load = function (st) {
    this.cpu.R.set(st.R); this.wram.set(st.wram); this.pal.set(st.pal); this.k109.set(st.k109); this.k960.set(st.k960);
    this.sbuf.set(st.sbuf); this.s.set(st.s); this.inputs.set(st.inputs);
    // sound log: a snapshot of this run (rollback) truncates the log; a foreign one (joining a room) restarts it there
    const k = (st.nsnd | 0) - this.sndBase;
    if (k >= 0 && k <= this.soundLog.length) this.soundLog.length = k; else { this.soundLog.length = 0; this.sndBase = st.nsnd | 0; }
  };
  // log entries before absolute index n were consumed by the sound board: drop them (keeps the log short)
  Machine.prototype.trimSound = function (n) { const k = n - this.sndBase; if (k > 4096) { this.soundLog.splice(0, k); this.sndBase = n; } };
  Machine.prototype.sndEnd = function () { return this.sndBase + this.soundLog.length; };
  Machine.prototype.sndSlice = function (a, b) { return this.soundLog.slice(a - this.sndBase, b - this.sndBase); };
  // 68000 cycle at the end of a saved state (for TMNTSound.zOf)
  Machine.nowOf = function (st) { return (st.s[S_CYC0] + FRAME - st.R[24]) | 0; };
  if (typeof module !== 'undefined') module.exports = Machine; else G.TMNTMachine = Machine;
})(typeof window !== 'undefined' ? window : globalThis);
