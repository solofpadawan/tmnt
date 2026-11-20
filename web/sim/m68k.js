// MC68000 core as a code generator. genOp(op, ctx) returns the JS source of one instruction; the runtime compiles one
// function per opcode lazily (interpreter) and tools/translate68k compiles whole basic blocks of the program ROM with
// the extension words folded in (ctx.ext). Same generator for both, so both behave identically.
// All state lives in one Int32Array (snapshot = copy it): see the R_* indices. Integer-only, no Math.random/Date.
// Cycle counts follow the MC68000 user manual tables (as MAME's m68000 core), checked against MAME debugger traces.
'use strict';
(function (G) {
  const R_PC = 16, R_SR = 17, R_X = 18, R_N = 19, R_Z = 20, R_V = 21, R_C = 22, R_OSP = 23, R_ICNT = 24, R_STOP = 25, R_IPL = 26, R_PPC = 27, R_IDLY = 28, R_N_REGS = 32;
  // R[0..7] D0-D7, R[8..15] A0-A7 (A7 = active stack), R_SR = SR system byte bits (T,S,I2-I0; CCR kept in R_X..R_C as 0/1),
  // R_OSP = the inactive stack pointer, R_ICNT = cycles left in the current slice, R_IPL = pending interrupt level.
  const MASK = ['0xff', '0xffff', '0xffffffff'], MSB = ['0x80', '0x8000', '0x80000000'], SZB = [1, 2, 4];
  const sx = (v, s) => s === 0 ? `((${v})<<24>>24)` : s === 1 ? `((${v})<<16>>16)` : `((${v})|0)`;
  const um = (v, s) => s === 2 ? `((${v})>>>0)` : `((${v})&${MASK[s]})`;
  function hex(n) { return '0x' + (n >>> 0).toString(16); }

  // ctx: { ext: null | (offsetInWords) => word, pc0 (address of opcode, static mode) }
  function Gen(op, ctx) {
    this.op = op; this.ctx = ctx || {}; this.code = []; this.cyc = 0; this.nw = 1; this.tmp = 0; this.ok = true;
  }
  Gen.prototype.t = function () { return 'v' + (this.tmp++); };
  Gen.prototype.emit = function (s) { this.code.push(s); };
  // fetch next extension word (unsigned 16) as expression
  Gen.prototype.ext16 = function () {
    const k = this.nw++;
    if (this.ctx.ext) return hex(this.ctx.ext(k));
    const v = this.t(); this.emit(`const ${v}=rw(R[16]);R[16]+=2;`); return v;
  };
  Gen.prototype.ext32 = function () {
    if (this.ctx.ext) { const k = this.nw; this.nw += 2; return hex(((this.ctx.ext(k) << 16) | this.ctx.ext(k + 1)) >>> 0); }
    const h = this.ext16(), l = this.ext16(); const v = this.t(); this.emit(`const ${v}=((${h}<<16)|${l})>>>0;`); return v;
  };
  // current PC value (address of the extension word about to be fetched) as expression
  Gen.prototype.pcHere = function () {
    if (this.ctx.ext) return hex(this.ctx.pc0 + 2 * this.nw);
    const v = this.t(); this.emit(`const ${v}=R[16];`); return v;
  };
  // brief extension word index: d8(An,Xn)
  Gen.prototype.idx = function (base) {
    const w = this.ext16(); const v = this.t();
    if (this.ctx.ext) {
      const wv = this.ctx.ext(this.nw - 1), r = (wv >> 12) & 15, l = (wv >> 11) & 1, d8 = (wv << 24) >> 24;
      const xi = l ? `R[${r}]` : `(R[${r}]<<16>>16)`;
      this.emit(`const ${v}=(${base}+${xi}+(${d8}))>>>0;`);
    } else {
      this.emit(`const ${v}=(${base}+((${w}&0x800)?R[(${w}>>12)&15]:(R[(${w}>>12)&15]<<16>>16))+((${w}<<24)>>24))>>>0;`);
    }
    return v;
  };
  // Effective address. Returns {kind:'d'|'a'|'m'|'i', reg, addr(expr), val(expr for imm)}; calc cycles added to this.cyc
  // per the EA calculation table (b/w vs l). For (An)+/-(An) the register update is emitted here.
  Gen.prototype.ea = function (mode, reg, s, opts) {
    opts = opts || {}; const L = s === 2;
    if (mode === 0) return { kind: 'd', reg };
    if (mode === 1) return { kind: 'a', reg };
    if (mode === 2) { this.cyc += L ? 8 : 4; const v = this.t(); this.emit(`const ${v}=R[${8 + reg}]>>>0;`); return { kind: 'm', addr: v }; }
    if (mode === 3) {
      this.cyc += L ? 8 : 4; const v = this.t(); const st = (s === 0 && reg === 7) ? 2 : SZB[s];
      this.emit(`const ${v}=R[${8 + reg}]>>>0;R[${8 + reg}]=(R[${8 + reg}]+${st})|0;`); return { kind: 'm', addr: v };
    }
    if (mode === 4) {
      this.cyc += opts.noPreDecPenalty ? (L ? 8 : 4) : (L ? 10 : 6); const v = this.t(); const st = (s === 0 && reg === 7) ? 2 : SZB[s];
      this.emit(`R[${8 + reg}]=(R[${8 + reg}]-${st})|0;const ${v}=R[${8 + reg}]>>>0;`); return { kind: 'm', addr: v };
    }
    if (mode === 5) { this.cyc += L ? 12 : 8; const d = this.ext16(); const v = this.t(); this.emit(`const ${v}=(R[${8 + reg}]+(${d}<<16>>16))>>>0;`); return { kind: 'm', addr: v }; }
    if (mode === 6) { this.cyc += L ? 14 : 10; return { kind: 'm', addr: this.idx(`R[${8 + reg}]`) }; }
    if (mode === 7) {
      if (reg === 0) { this.cyc += L ? 12 : 8; const d = this.ext16(); const v = this.t(); this.emit(`const ${v}=((${d}<<16>>16)>>>0)&0xffffff;`); return { kind: 'm', addr: v }; }
      if (reg === 1) { this.cyc += L ? 16 : 12; const a = this.ext32(); return { kind: 'm', addr: a }; }
      if (reg === 2) { this.cyc += L ? 12 : 8; const p = this.pcHere(); const d = this.ext16(); const v = this.t(); this.emit(`const ${v}=(${p}+(${d}<<16>>16))>>>0;`); return { kind: 'm', addr: v, pcrel: 1 }; }
      if (reg === 3) { this.cyc += L ? 14 : 10; const p = this.pcHere(); return { kind: 'm', addr: this.idx(p), pcrel: 1 }; }
      if (reg === 4) {
        this.cyc += L ? 8 : 4;
        if (s === 2) return { kind: 'i', val: this.ext32() };
        const w = this.ext16(); return { kind: 'i', val: s === 0 ? `(${w}&0xff)` : w };
      }
    }
    this.ok = false; return { kind: 'x' };
  };
  // address-only EA (lea/pea/jmp/jsr/movem): no calc cycles added
  Gen.prototype.eaAddr = function (mode, reg) {
    const c = this.cyc; const e = this.ea(mode, reg, 1); this.cyc = c; return e;
  };
  Gen.prototype.read = function (e, s) {
    if (e.kind === 'd') return s === 2 ? `(R[${e.reg}]>>>0)` : `(R[${e.reg}]&${MASK[s]})`;
    if (e.kind === 'a') return s === 2 ? `(R[${8 + e.reg}]>>>0)` : `(R[${8 + e.reg}]&${MASK[s]})`;
    if (e.kind === 'i') return e.val;
    const v = this.t(); this.emit(`const ${v}=${['rb', 'rw', 'rl'][s]}(${e.addr});`); return v;
  };
  Gen.prototype.write = function (e, s, val) {
    if (e.kind === 'd') {
      if (s === 2) this.emit(`R[${e.reg}]=${val};`);
      else this.emit(`R[${e.reg}]=(R[${e.reg}]&${s === 0 ? '~0xff' : '~0xffff'})|(${val});`);
    } else if (e.kind === 'a') this.emit(`R[${8 + e.reg}]=${val};`);
    else this.emit(`${['wb', 'ww', 'wl'][s]}(${e.addr},${val});`);
  };
  Gen.prototype.nz = function (v, s) { this.emit(`R[19]=(${v}&${MSB[s]})?1:0;R[20]=(${v})?0:1;`); };
  Gen.prototype.logic = function (v, s) { this.nz(v, s); this.emit('R[21]=0;R[22]=0;'); };
  Gen.prototype.flagsAdd = function (src, dst, res, s, isX) { // res unmasked sum
    const r = this.t();
    this.emit(`const ${r}=${um(res, s)};`);
    this.emit(`R[22]=R[18]=(${res})>${MASK[s]}?1:0;R[21]=((${src}^${r})&(${dst}^${r})&${MSB[s]})?1:0;R[19]=(${r}&${MSB[s]})?1:0;`);
    this.emit(isX ? `if(${r})R[20]=0;` : `R[20]=${r}?0:1;`);
    return r;
  };
  Gen.prototype.flagsSub = function (src, dst, res, s, isX, noX) { // res = dst - src (unmasked, may be negative)
    const r = this.t();
    this.emit(`const ${r}=${um(res, s)};`);
    this.emit(`R[22]=${noX ? '' : 'R[18]='}(${res})<0?1:0;R[21]=((${src}^${dst})&(${r}^${dst})&${MSB[s]})?1:0;R[19]=(${r}&${MSB[s]})?1:0;`);
    this.emit(isX ? `if(${r})R[20]=0;` : `R[20]=${r}?0:1;`);
    return r;
  };
  // condition code test expression
  function cond(cc) {
    return ['1', '0', '(!R[22]&&!R[20])', '(R[22]||R[20])', '!R[22]', 'R[22]', '!R[20]', 'R[20]', '!R[21]', 'R[21]', '!R[19]', 'R[19]',
      '(R[19]===R[21])', '(R[19]!==R[21])', '(!R[20]&&R[19]===R[21])', '(R[20]||R[19]!==R[21])'][cc];
  }

  function genOp(op, ctx) {
    const g = new Gen(op, ctx);
    const r = decode(g, op);
    if (r === false || !g.ok) return null;
    return { code: g.code.join(''), cyc: g.cyc, words: g.nw, flow: g.flow || 0 };
  }
  // g.flow: 0 = falls through, 1 = control transfer (block ends), 2 = may raise exception / change SR (block ends)

  function decode(g, op) {
    const hi = op >> 12, m = (op >> 3) & 7, rr = op & 7, rx = (op >> 9) & 7, opm = (op >> 6) & 7;
    switch (hi) {
      case 0: return grp0(g, op, m, rr, rx, opm);
      case 1: case 2: case 3: return move(g, op, [0, 0, 2, 1][hi], m, rr, rx, opm);
      case 4: return grp4(g, op, m, rr, rx, opm);
      case 5: return grp5(g, op, m, rr, rx, opm);
      case 6: return bcc(g, op);
      case 7: if (op & 0x100) return false; g.cyc += 4; g.emit(`R[${rx}]=${(op << 24) >> 24};R[19]=${(op & 0x80) ? 1 : 0};R[20]=${(op & 0xff) ? 0 : 1};R[21]=0;R[22]=0;`); return true;
      case 8: return grp8c(g, op, m, rr, rx, opm, 'or');
      case 9: return addsub(g, op, m, rr, rx, opm, 'sub');
      case 11: return grpB(g, op, m, rr, rx, opm);
      case 12: return grp8c(g, op, m, rr, rx, opm, 'and');
      case 13: return addsub(g, op, m, rr, rx, opm, 'add');
      case 14: return shift(g, op, m, rr, rx, opm);
      default: return false; // line A / line F
    }
  }
  function isMemAlterable(m, r) { return m >= 2 && !(m === 7 && r > 1); }
  function isDataAlterable(m, r) { return m === 0 || isMemAlterable(m, r); }
  function validEA(m, r) { return m < 7 || r <= 4; }

  function move(g, op, s, m, rr, rx, opm) {
    if (!validEA(m, rr)) return false;
    if (s === 0 && m === 1) return false;
    const dm = opm, dr = rx;
    g.cyc += 4;
    const se = g.ea(m, rr, s); const v = g.read(se, s);
    if (dm === 1) { // movea
      if (s === 0) return false;
      g.write({ kind: 'a', reg: dr }, 2, s === 1 ? sx(v, 1) : `${v}|0`); return true;
    }
    if (!isDataAlterable(dm, dr)) return false;
    const de = g.ea(dm, dr, s, { noPreDecPenalty: true });
    // flags are set before the write
    g.logic(v, s); g.write(de, s, v); return true;
  }

  function grp0(g, op, m, rr, rx, opm) {
    if (op & 0x100 || (op & 0xf00) === 0x800) { // bit ops (dynamic: op&0x100 ; static: 0x08xx)
      if ((op & 0x138) === 0x108) { // movep
        const s = (op & 0x40) ? 2 : 1, toMem = op & 0x80;
        const d = g.ext16(); const a = g.t(); g.emit(`const ${a}=(R[${8 + rr}]+(${d}<<16>>16))>>>0;`);
        g.cyc += s === 2 ? 24 : 16;
        if (toMem) {
          if (s === 2) g.emit(`wb(${a},R[${rx}]>>>24);wb(${a}+2,(R[${rx}]>>16)&0xff);wb(${a}+4,(R[${rx}]>>8)&0xff);wb(${a}+6,R[${rx}]&0xff);`);
          else g.emit(`wb(${a},(R[${rx}]>>8)&0xff);wb(${a}+2,R[${rx}]&0xff);`);
        } else {
          if (s === 2) g.emit(`R[${rx}]=(rb(${a})<<24)|(rb(${a}+2)<<16)|(rb(${a}+4)<<8)|rb(${a}+6);`);
          else g.emit(`R[${rx}]=(R[${rx}]&~0xffff)|(rb(${a})<<8)|rb(${a}+2);`);
        }
        return true;
      }
      const dyn = op & 0x100, kind = (op >> 6) & 3; // 0 btst 1 bchg 2 bclr 3 bset
      let bit;
      if (dyn) bit = `R[${rx}]`; else { if (m === 7 && rr === 4) return false; bit = `(${g.ext16()}&0xff)`; }
      if (m === 1) return false;
      if (kind === 0 ? !validEA(m, rr) : !isDataAlterable(m, rr)) return false;
      if (m === 7 && rr === 4 && !dyn) return false;
      if (m === 0) {
        const b = g.t(); g.emit(`const ${b}=${bit}&31;`);
        g.emit(`R[20]=(R[${rr}]>>>${b})&1?0:1;`);
        if (kind === 1) g.emit(`R[${rr}]^=1<<${b};`); else if (kind === 2) g.emit(`R[${rr}]&=~(1<<${b});`); else if (kind === 3) g.emit(`R[${rr}]|=1<<${b};`);
        // btst Dn: 6 (dyn) / 10 (static); bchg/bset: 6/8 +2 if bit>=16; bclr 8/10 (+2 if bit>=16)
        const base = dyn ? [6, 6, 8, 6][kind] : [10, 10, 12, 10][kind];
        g.cyc += base;
        if (kind !== 0) g.emit(`if(${b}>=16)R[24]-=2;`);
        return true;
      }
      const e = g.ea(m, rr, 0); const v = g.read(e, 0); const b = g.t(); g.emit(`const ${b}=${bit}&7;`);
      g.emit(`R[20]=(${v}>>${b})&1?0:1;`);
      if (kind === 1) g.write(e, 0, `${v}^(1<<${b})`); else if (kind === 2) g.write(e, 0, `${v}&~(1<<${b})`); else if (kind === 3) g.write(e, 0, `(${v}|(1<<${b}))&0xff`);
      g.cyc += (dyn ? 4 : 8) + (kind ? 4 : 0);
      return true;
    }
    // immediate ops: 0x00 ori, 0x02 andi, 0x04 subi, 0x06 addi, 0x0a eori, 0x0c cmpi
    const kind = (op >> 9) & 7, s = (op >> 6) & 3;
    if (s === 3) return false;
    if ((kind === 0 || kind === 1 || kind === 5) && m === 7 && rr === 4) { // to CCR / SR
      if (s === 2) return false;
      const w = g.ext16(); g.cyc += 20; g.flow = 2;
      const fn = ['|', '&', '', '', '', '^'][kind];
      if (s === 0) g.emit(`X.setCCR(X.getCCR()${fn}(${w}&0xff));`);
      else g.emit(`if(!(R[17]&0x2000)){X.priv();}else{X.setSR(X.getSR()${fn}${w});}`);
      return true;
    }
    if (kind === 7 || kind === 4) return false;
    if (kind === 6 ? !(validEA(m, rr) && m !== 1 && !(m === 7 && rr === 4)) : !isDataAlterable(m, rr)) return false;
    const imm = s === 2 ? g.ext32() : (s === 1 ? g.ext16() : `(${g.ext16()}&0xff)`);
    const e = g.ea(m, rr, s); const v = g.read(e, s);
    if (m === 0) g.cyc += s === 2 ? (kind === 6 ? 14 : 16) : 8;
    else g.cyc += kind === 6 ? (s === 2 ? 12 : 8) : (s === 2 ? 20 : 12);
    if (kind === 0 || kind === 1 || kind === 5) {
      const r = g.t(); g.emit(`const ${r}=${s === 2 ? `((${v}${['|', '&', '', '', '', '^'][kind]}${imm})>>>0)` : `(${v}${['|', '&', '', '', '', '^'][kind]}${imm})`};`);
      g.logic(r, s); g.write(e, s, r); return true;
    }
    if (kind === 2) { const r = g.flagsSub(imm, v, `${v}-${imm}`, s); g.write(e, s, r); return true; }
    if (kind === 3) { const r = g.flagsAdd(imm, v, `${v}+${imm}`, s); g.write(e, s, r); return true; }
    if (kind === 6) { g.flagsSub(imm, v, `${v}-${imm}`, s, false, true); return true; }
    return false;
  }

  function grp4(g, op, m, rr, rx, opm) {
    if (op === 0x4e71) { g.cyc += 4; return true; }
    if (op === 0x4e75) { g.cyc += 16; g.flow = 1; g.emit('R[16]=rl(R[15]>>>0);R[15]=(R[15]+4)|0;'); return true; }
    if (op === 0x4e73) { g.cyc += 20; g.flow = 2; g.emit('if(!(R[17]&0x2000)){X.priv();}else{const s=rw(R[15]>>>0),p=rl((R[15]+2)>>>0);R[15]=(R[15]+6)|0;X.setSR(s);R[16]=p;}'); return true; }
    if (op === 0x4e77) { g.cyc += 20; g.flow = 1; g.emit('X.setCCR(rw(R[15]>>>0)&0xff);R[16]=rl((R[15]+2)>>>0);R[15]=(R[15]+6)|0;'); return true; }
    if (op === 0x4e70) { g.cyc += 132; g.emit('if(!(R[17]&0x2000))X.priv();else X.reset();'); g.flow = 2; return true; }
    if (op === 0x4e72) { const w = g.ext16(); g.cyc += 4; g.flow = 2; g.emit(`if(!(R[17]&0x2000)){X.priv();}else{X.setSR(${w});R[25]=1;}`); return true; }
    if (op === 0x4e76) { g.cyc += 4; g.flow = 2; g.emit('if(R[21])X.trap(7);'); return true; }
    if ((op & 0xfff0) === 0x4e40) { g.cyc += 4; g.flow = 2; g.emit(`X.trap(${32 + (op & 15)});`); return true; }
    if ((op & 0xfff8) === 0x4e50) { // link
      const d = g.ext16(); g.cyc += 16;
      g.emit(`R[15]=(R[15]-4)|0;wl(R[15]>>>0,R[${8 + rr}]>>>0);R[${8 + rr}]=R[15];R[15]=(R[15]+(${d}<<16>>16))|0;`); return true;
    }
    if ((op & 0xfff8) === 0x4e58) { g.cyc += 12; g.emit(`R[15]=R[${8 + rr}];R[${8 + rr}]=rl(R[15]>>>0);R[15]=(R[15]+4)|0;`); return true; }
    if ((op & 0xfff0) === 0x4e60) { // move usp
      g.cyc += 4; g.flow = 2;
      if (op & 8) g.emit(`if(!(R[17]&0x2000))X.priv();else R[${8 + rr}]=R[23];`); else g.emit(`if(!(R[17]&0x2000))X.priv();else R[23]=R[${8 + rr}];`);
      return true;
    }
    if ((op & 0xffc0) === 0x4e80 || (op & 0xffc0) === 0x4ec0) { // jsr / jmp
      if (!(m === 2 || m === 5 || m === 6 || m === 7 && rr <= 3)) return false;
      const isJsr = !(op & 0x40); const e = g.eaAddr(m, rr);
      const t = { 2: 0, 5: 2, 6: 6, 70: 2, 71: 4, 72: 2, 73: 6 }[m === 7 ? 70 + rr : m];
      g.cyc += (isJsr ? 16 : 8) + t; g.flow = 1;
      if (isJsr) { const ret = g.pcHere(); g.emit(`R[15]=(R[15]-4)|0;wl(R[15]>>>0,${ret});`); }
      g.emit(`R[16]=${e.addr};`); return true;
    }
    if ((op & 0xf1c0) === 0x41c0) { // lea
      if (!(m === 2 || m === 5 || m === 6 || m === 7 && rr <= 3)) return false;
      const e = g.eaAddr(m, rr); g.cyc += { 2: 4, 5: 8, 6: 12, 70: 8, 71: 12, 72: 8, 73: 12 }[m === 7 ? 70 + rr : m];
      g.emit(`R[${8 + rx}]=${e.addr}|0;`); return true;
    }
    if ((op & 0xf1c0) === 0x4180) { // chk.w
      if (!validEA(m, rr) || m === 1) return false;
      const e = g.ea(m, rr, 1); const v = g.read(e, 1); g.cyc += 10; g.flow = 2;
      g.emit(`{const d=R[${rx}]<<16>>16,b=${sx(v, 1)};R[20]=(R[${rx}]&0xffff)?0:1;R[21]=0;R[22]=0;if(d<0){R[19]=1;R[24]-=0;X.trap(6);}else if(d>b){R[19]=0;X.trap(6);}}`);
      return true;
    }
    if ((op & 0xffc0) === 0x4840) { // pea / swap
      if (m === 0) { g.cyc += 4; g.emit(`R[${rr}]=(R[${rr}]>>>16)|(R[${rr}]<<16);`); g.logic(`R[${rr}]`, 2); return true; }
      if (!(m === 2 || m === 5 || m === 6 || m === 7 && rr <= 3)) return false;
      const e = g.eaAddr(m, rr); g.cyc += { 2: 12, 5: 16, 6: 20, 70: 16, 71: 20, 72: 16, 73: 20 }[m === 7 ? 70 + rr : m];
      g.emit(`R[15]=(R[15]-4)|0;wl(R[15]>>>0,${e.addr});`); return true;
    }
    if ((op & 0xfeb8) === 0x4880) { // ext
      g.cyc += 4;
      if (op & 0x40) { g.emit(`R[${rr}]=R[${rr}]<<16>>16;`); g.logic(`R[${rr}]`, 2); }
      else { g.emit(`R[${rr}]=(R[${rr}]&~0xffff)|((R[${rr}]<<24>>24)&0xffff);`); g.logic(`(R[${rr}]&0xffff)`, 1); }
      return true;
    }
    if ((op & 0xfb80) === 0x4880) return movem(g, op, m, rr);
    if ((op & 0xffc0) === 0x40c0) { // move from sr
      if (!isDataAlterable(m, rr)) return false;
      const e = g.ea(m, rr, 1); if (m !== 0) g.read(e, 1); g.cyc += m === 0 ? 6 : 8; g.write(e, 1, 'X.getSR()'); return true;
    }
    if ((op & 0xffc0) === 0x44c0 || (op & 0xffc0) === 0x46c0) { // move to ccr / sr
      if (!validEA(m, rr) || m === 1) return false;
      const e = g.ea(m, rr, 1); const v = g.read(e, 1); g.cyc += 12; g.flow = 2;
      if ((op & 0xffc0) === 0x44c0) g.emit(`X.setCCR(${v}&0xff);`);
      else g.emit(`if(!(R[17]&0x2000))X.priv();else X.setSR(${v});`);
      return true;
    }
    if ((op & 0xffc0) === 0x4ac0) { // tas
      if (!isDataAlterable(m, rr)) return false;
      const e = g.ea(m, rr, 0); const v = g.read(e, 0); g.cyc += m === 0 ? 4 : 10; g.logic(v, 0); g.write(e, 0, `${v}|0x80`); return true;
    }
    const s = (op >> 6) & 3;
    if (s === 3) return false;
    const k = (op >> 8) & 15; // 0 negx 2 clr 4 neg 6 not 10 tst
    if (k === 10) { if (!validEA(m, rr) || (s === 0 && m === 1) || m === 1) return false; const e = g.ea(m, rr, s); const v = g.read(e, s); g.cyc += 4; g.logic(v, s); return true; }
    if (k === 8 && s === 0) { // nbcd
      if (!isDataAlterable(m, rr)) return false;
      const e = g.ea(m, rr, 0); const v = g.read(e, 0); g.cyc += m === 0 ? 6 : 8;
      const r = g.t(); g.emit(`const ${r}=X.sbcd(${v},0);`); g.write(e, 0, r); return true;
    }
    if (!(k === 0 || k === 2 || k === 4 || k === 6) || !isDataAlterable(m, rr)) return false;
    const e = g.ea(m, rr, s); const v = g.read(e, s);
    g.cyc += m === 0 ? (s === 2 ? 6 : 4) : (s === 2 ? 12 : 8);
    if (k === 2) { g.emit('R[19]=0;R[20]=1;R[21]=0;R[22]=0;'); g.write(e, s, '0'); return true; }
    if (k === 6) { const r = g.t(); g.emit(`const ${r}=${um('~' + v, s)};`); g.logic(r, s); g.write(e, s, r); return true; }
    if (k === 4) { const r = g.flagsSub(v, '0', `0-${v}`, s); g.write(e, s, r); return true; }
    const r = g.flagsSub(v, '0', `0-${v}-R[18]`, s, true); g.write(e, s, r); return true;
  }

  function movem(g, op, m, rr) {
    const toReg = op & 0x400, L = op & 0x40, s = L ? 2 : 1;
    const mask = g.ctx.ext ? g.ctx.ext(g.nw) : null; const mw = g.ext16();
    if (toReg ? !(m === 2 || m === 3 || m === 5 || m === 6 || (m === 7 && rr <= 3)) : !(m === 2 || m === 4 || m === 5 || m === 6 || (m === 7 && rr <= 1))) return false;
    let base;
    if (m === 3 || m === 4) { base = g.t(); g.emit(`let ${base}=R[${8 + rr}]>>>0;`); }
    else { const e = g.eaAddr(m, rr); base = g.t(); g.emit(`let ${base}=${e.addr};`); }
    const eaC = { 2: 0, 3: 0, 4: 0, 5: 4, 6: 6, 70: 4, 71: 8, 72: 4, 73: 6 }[m === 7 ? 70 + rr : m];
    g.cyc += (toReg ? 12 : 8) + eaC;
    const per = L ? 8 : 4; const n = g.t();
    // registers transferred: count at runtime
    g.emit(`let ${n}=0;`);
    if (toReg) {
      g.emit(`for(let i=0;i<16;i++)if(${mw}&(1<<i)){R[i]=${L ? `rl(${base})` : `rw(${base})<<16>>16`};${base}=(${base}+${SZB[s]})>>>0;${n}++;}`);
      if (m === 3) g.emit(`R[${8 + rr}]=${base}|0;`);
      g.emit(`rw(${base});`); // the 68000 does one extra word read
    } else if (m === 4) {
      g.emit(`for(let i=0;i<16;i++)if(${mw}&(1<<i)){${base}=(${base}-${SZB[s]})>>>0;${L ? `wl(${base},R[15-i]>>>0)` : `ww(${base},R[15-i]&0xffff)`};${n}++;}R[${8 + rr}]=${base}|0;`);
    } else {
      g.emit(`for(let i=0;i<16;i++)if(${mw}&(1<<i)){${L ? `wl(${base},R[i]>>>0)` : `ww(${base},R[i]&0xffff)`};${base}=(${base}+${SZB[s]})>>>0;${n}++;}`);
    }
    if (mask !== null) { let c = 0; for (let i = 0; i < 16; i++) if (mask & (1 << i)) c++; g.cyc += per * c; }
    else g.emit(`R[24]-=${per}*${n};`);
    return true;
  }

  function grp5(g, op, m, rr, rx, opm) {
    const s = (op >> 6) & 3;
    if (s === 3) {
      const cc = (op >> 8) & 15;
      if (m === 1) { // dbcc
        const d = g.ext16(); const p = g.pcHere(); g.flow = 1;
        // pc for target = address of displacement word
        const tgt = g.ctx.ext ? hex(g.ctx.pc0 + 2 + ((g.ctx.ext(1) << 16) >> 16)) : `(${p}-2+(${d}<<16>>16))>>>0`;
        g.emit(`if(${cond(cc)}){R[24]-=12;R[16]=${p};}else{const c=((R[${rr}]&0xffff)-1)&0xffff;R[${rr}]=(R[${rr}]&~0xffff)|c;if(c===0xffff){R[24]-=14;R[16]=${p};}else{R[24]-=10;R[16]=${tgt};}}`);
        return true;
      }
      if (!isDataAlterable(m, rr)) return false;
      const e = g.ea(m, rr, 0);
      if (m === 0) { g.emit(`if(${cond(cc)}){R[24]-=6;R[${rr}]|=0xff;}else{R[24]-=4;R[${rr}]&=~0xff;}`); return true; }
      g.read(e, 0); g.cyc += 8; g.write(e, 0, `(${cond(cc)}?0xff:0)`); return true;
    }
    const q = rx || 8, sub = op & 0x100;
    if (m === 1) { if (s === 0) return false; g.cyc += 8; g.emit(`R[${8 + rr}]=(R[${8 + rr}]${sub ? '-' : '+'}${q})|0;`); return true; }
    if (!isDataAlterable(m, rr)) return false;
    const e = g.ea(m, rr, s); const v = g.read(e, s);
    g.cyc += m === 0 ? (s === 2 ? 8 : 4) : (s === 2 ? 12 : 8);
    const r = sub ? g.flagsSub(q, v, `${v}-${q}`, s) : g.flagsAdd(q, v, `${v}+${q}`, s);
    g.write(e, s, r); return true;
  }

  function bcc(g, op) {
    const cc = (op >> 8) & 15; let d8 = (op << 24) >> 24; g.flow = 1;
    const base = g.pcHere(); // address after opcode
    let tgt;
    if (d8 === 0) { const d = g.ext16(); tgt = g.ctx.ext ? hex(g.ctx.pc0 + 2 + ((g.ctx.ext(1) << 16) >> 16)) : `(${base}+(${d}<<16>>16))>>>0`; }
    else tgt = g.ctx.ext ? hex(g.ctx.pc0 + 2 + d8) : `(${base}+${d8})>>>0`;
    const after = g.pcHere();
    if (cc === 1) { // bsr
      g.cyc += 18; g.emit(`R[15]=(R[15]-4)|0;wl(R[15]>>>0,${after});R[16]=${tgt};`); return true;
    }
    if (cc === 0) { g.cyc += 10; g.emit(`R[16]=${tgt};`); return true; }
    g.emit(`if(${cond(cc)}){R[24]-=10;R[16]=${tgt};}else{R[24]-=${d8 === 0 ? 12 : 8};R[16]=${after};}`);
    return true;
  }

  function grp8c(g, op, m, rr, rx, opm, kind) { // or / and (+ divu/divs, mulu/muls, abcd/sbcd, exg)
    if (opm === 3 || opm === 7) { // div (8) / mul (c)
      if (!validEA(m, rr) || m === 1) return false;
      const e = g.ea(m, rr, 1); const v = g.read(e, 1); const sgn = opm === 7;
      if (kind === 'and') {
        g.cyc += 38;
        if (sgn) g.emit(`{const a=R[${rx}]<<16>>16,b=${sx(v, 1)},r=Math.imul(a,b);R[${rx}]=r;let x=((b<<1)^b)&0xffff,n=0;while(x){n+=x&1;x>>>=1;}R[24]-=2*n;R[19]=r<0?1:0;R[20]=r?0:1;R[21]=0;R[22]=0;}`);
        else g.emit(`{const a=R[${rx}]&0xffff,b=${v},r=Math.imul(a,b)>>>0;R[${rx}]=r|0;let x=b,n=0;while(x){n+=x&1;x>>>=1;}R[24]-=2*n;R[19]=(r>>>31);R[20]=r?0:1;R[21]=0;R[22]=0;}`);
        return true;
      }
      g.flow = 2;
      if (sgn) g.emit(`X.divs(${rx},${sx(v, 1)});`); else g.emit(`X.divu(${rx},${v});`);
      return true;
    }
    if ((op & 0x1f0) === 0x100) { // abcd/sbcd
      const fn = kind === 'and' ? 'abcd' : 'sbcd';
      if (op & 8) { g.cyc += 18; g.emit(`{R[${8 + rr}]=(R[${8 + rr}]-${rr === 7 ? 2 : 1})|0;const s=rb(R[${8 + rr}]>>>0);R[${8 + rx}]=(R[${8 + rx}]-${rx === 7 ? 2 : 1})|0;const d=rb(R[${8 + rx}]>>>0);wb(R[${8 + rx}]>>>0,X.${fn}(s,d));}`); }
      else { g.cyc += 6; g.emit(`R[${rx}]=(R[${rx}]&~0xff)|X.${fn}(R[${rr}]&0xff,R[${rx}]&0xff);`); }
      return true;
    }
    if (kind === 'and' && (op & 0x130) === 0x100 && (opm === 5 || opm === 6) && m <= 1) { // exg
      const k = (op >> 3) & 0x1f; g.cyc += 6;
      const a = k === 8 ? rx : k === 9 ? 8 + rx : k === 17 ? rx : -1, b = k === 8 ? rr : 8 + rr;
      if (a < 0) return false;
      g.emit(`{const t=R[${a}];R[${a}]=R[${b}];R[${b}]=t;}`); return true;
    }
    const s = opm & 3, toEA = opm & 4;
    const sym = kind === 'or' ? '|' : '&';
    if (!toEA) {
      if (!validEA(m, rr) || m === 1) return false;
      const e = g.ea(m, rr, s); const v = g.read(e, s);
      g.cyc += s === 2 ? ((m === 0 || (m === 7 && rr === 4)) ? 8 : 6) : 4;
      const r = g.t(); g.emit(`const ${r}=${s === 2 ? `((R[${rx}]${sym}${v})>>>0)` : `((R[${rx}]&${MASK[s]})${sym}${v})`};`);
      g.logic(r, s); g.write({ kind: 'd', reg: rx }, s, r); return true;
    }
    if (!isMemAlterable(m, rr)) return false;
    const e = g.ea(m, rr, s); const v = g.read(e, s); g.cyc += s === 2 ? 12 : 8;
    const r = g.t(); g.emit(`const ${r}=${s === 2 ? `((R[${rx}]${sym}${v})>>>0)` : `((R[${rx}]&${MASK[s]})${sym}${v})`};`);
    g.logic(r, s); g.write(e, s, r); return true;
  }

  function addsub(g, op, m, rr, rx, opm, kind) {
    const add = kind === 'add';
    if (opm === 3 || opm === 7) { // adda/suba
      const s = opm === 7 ? 2 : 1; if (!validEA(m, rr)) return false;
      const e = g.ea(m, rr, s); const v = g.read(e, s);
      g.cyc += s === 2 ? ((m <= 1 || (m === 7 && rr === 4)) ? 8 : 6) : 8;
      g.emit(`R[${8 + rx}]=(R[${8 + rx}]${add ? '+' : '-'}${s === 1 ? sx(v, 1) : v})|0;`); return true;
    }
    const s = opm & 3;
    if ((op & 0x130) === 0x100) { // addx/subx
      if (op & 8) {
        g.cyc += s === 2 ? 30 : 18; const st = SZB[s];
        const sa = g.t(), da = g.t();
        g.emit(`R[${8 + rr}]=(R[${8 + rr}]-${s === 0 && rr === 7 ? 2 : st})|0;const ${sa}=${['rb', 'rw', 'rl'][s]}(R[${8 + rr}]>>>0);R[${8 + rx}]=(R[${8 + rx}]-${s === 0 && rx === 7 ? 2 : st})|0;const ${da}=${['rb', 'rw', 'rl'][s]}(R[${8 + rx}]>>>0);`);
        const r = add ? g.flagsAdd(sa, da, `${da}+${sa}+R[18]`, s, true) : g.flagsSub(sa, da, `${da}-${sa}-R[18]`, s, true);
        g.emit(`${['wb', 'ww', 'wl'][s]}(R[${8 + rx}]>>>0,${r});`); return true;
      }
      g.cyc += s === 2 ? 8 : 4;
      const sv = g.read({ kind: 'd', reg: rr }, s), dv = g.read({ kind: 'd', reg: rx }, s);
      const a = g.t(), b = g.t(); g.emit(`const ${a}=${sv},${b}=${dv};`);
      const r = add ? g.flagsAdd(a, b, `${b}+${a}+R[18]`, s, true) : g.flagsSub(a, b, `${b}-${a}-R[18]`, s, true);
      g.write({ kind: 'd', reg: rx }, s, r); return true;
    }
    if (!(opm & 4)) { // <ea> op Dn -> Dn
      if (!validEA(m, rr) || (s === 0 && m === 1)) return false;
      const e = g.ea(m, rr, s); const v = g.read(e, s);
      g.cyc += s === 2 ? ((m <= 1 || (m === 7 && rr === 4)) ? 8 : 6) : 4;
      const dv = g.t(); g.emit(`const ${dv}=${g.read({ kind: 'd', reg: rx }, s)};`);
      const r = add ? g.flagsAdd(v, dv, `${dv}+${v}`, s) : g.flagsSub(v, dv, `${dv}-${v}`, s);
      g.write({ kind: 'd', reg: rx }, s, r); return true;
    }
    if (!isMemAlterable(m, rr)) return false;
    const e = g.ea(m, rr, s); const v = g.read(e, s); g.cyc += s === 2 ? 12 : 8;
    const sv = g.t(); g.emit(`const ${sv}=${g.read({ kind: 'd', reg: rx }, s)};`);
    const r = add ? g.flagsAdd(sv, v, `${v}+${sv}`, s) : g.flagsSub(sv, v, `${v}-${sv}`, s);
    g.write(e, s, r); return true;
  }

  function grpB(g, op, m, rr, rx, opm) {
    if (opm === 3 || opm === 7) { // cmpa
      const s = opm === 7 ? 2 : 1; if (!validEA(m, rr)) return false;
      const e = g.ea(m, rr, s); const v = g.read(e, s); g.cyc += 6;
      const sv = g.t(); g.emit(`const ${sv}=${s === 1 ? sx(v, 1) + '>>>0' : v};`);
      g.flagsSub(sv, `(R[${8 + rx}]>>>0)`, `(R[${8 + rx}]>>>0)-${sv}`, 2, false, true); return true;
    }
    const s = opm & 3;
    if (!(opm & 4)) { // cmp
      if (!validEA(m, rr) || (s === 0 && m === 1)) return false;
      const e = g.ea(m, rr, s); const v = g.read(e, s); g.cyc += s === 2 ? 6 : 4;
      const dv = g.t(); g.emit(`const ${dv}=${g.read({ kind: 'd', reg: rx }, s)};`);
      g.flagsSub(v, dv, `${dv}-${v}`, s, false, true); return true;
    }
    if (m === 1) { // cmpm
      g.cyc += s === 2 ? 20 : 12;
      const se = g.ea(3, rr, s); g.cyc -= s === 2 ? 8 : 4; const sv = g.read(se, s);
      const de = g.ea(3, rx, s); g.cyc -= s === 2 ? 8 : 4; const dv = g.read(de, s);
      g.flagsSub(sv, dv, `${dv}-${sv}`, s, false, true); return true;
    }
    if (!isDataAlterable(m, rr)) return false; // eor
    const e = g.ea(m, rr, s); const v = g.read(e, s);
    g.cyc += m === 0 ? (s === 2 ? 8 : 4) : (s === 2 ? 12 : 8);
    const r = g.t(); g.emit(`const ${r}=${s === 2 ? `((R[${rx}]^${v})>>>0)` : `((R[${rx}]&${MASK[s]})^${v})`};`);
    g.logic(r, s); g.write(e, s, r); return true;
  }

  function shift(g, op, m, rr, rx, opm) {
    const s = (op >> 6) & 3; let type, left = op & 0x100, cnt, e, v, reg = false;
    if (s === 3) { // memory, word, by 1
      if ((op & 0x800) || !isMemAlterable(m, rr)) return false;
      type = (op >> 9) & 3; e = g.ea(m, rr, 1); v = g.read(e, 1); cnt = '1'; g.cyc += 8;
      const r = shiftCore(g, type, left, v, cnt, 1, true); g.write(e, 1, r); return true;
    }
    type = (op >> 3) & 3; reg = true;
    if (op & 0x20) { cnt = g.t(); g.emit(`const ${cnt}=R[${rx}]&63;`); }
    else cnt = String(rx || 8);
    v = g.read({ kind: 'd', reg: rr }, s);
    g.cyc += s === 2 ? 8 : 6;
    g.emit(`R[24]-=2*${cnt};`);
    const r = shiftCore(g, type, left, v, cnt, s, false);
    g.write({ kind: 'd', reg: rr }, s, r); return true;
  }
  // generic shift with loop: exact flags for all counts
  function shiftCore(g, type, left, v, cnt, s, mem) {
    const r = g.t(); const M = MASK[s], B = MSB[s];
    g.emit(`let ${r}=${v};{let n=${cnt},c=0,vv=0;`);
    if (type === 0) { // as
      if (left) g.emit(`for(let i=0;i<n;i++){c=(${r}&${B})?1:0;const o=${r};${r}=${s === 2 ? `(${r}<<1)>>>0` : `(${r}<<1)&${M}`};if((o^${r})&${B})vv=1;}`);
      else g.emit(`const sg=${r}&${B};for(let i=0;i<n;i++){c=${r}&1;${r}=${s === 2 ? `((${r}>>>1)|sg)>>>0` : `(${r}>>>1)|sg`};}`);
      g.emit(`if(n){R[22]=R[18]=c;}else R[22]=0;R[21]=vv;`);
    } else if (type === 1) { // ls
      if (left) g.emit(`for(let i=0;i<n;i++){c=(${r}&${B})?1:0;${r}=${s === 2 ? `(${r}<<1)>>>0` : `(${r}<<1)&${M}`};}`);
      else g.emit(`for(let i=0;i<n;i++){c=${r}&1;${r}=${r}>>>1;}`);
      g.emit(`if(n){R[22]=R[18]=c;}else R[22]=0;R[21]=0;`);
    } else if (type === 2) { // rox
      g.emit(`let x=R[18];`);
      if (left) g.emit(`for(let i=0;i<n;i++){c=(${r}&${B})?1:0;${r}=${s === 2 ? `((${r}<<1)|x)>>>0` : `((${r}<<1)|x)&${M}`};x=c;}`);
      else g.emit(`for(let i=0;i<n;i++){c=${r}&1;${r}=${s === 2 ? `((${r}>>>1)|(x?${B}:0))>>>0` : `(${r}>>>1)|(x?${B}:0)`};x=c;}`);
      g.emit(`R[18]=x;R[22]=x;R[21]=0;`);
    } else { // ro
      if (left) g.emit(`for(let i=0;i<n;i++){c=(${r}&${B})?1:0;${r}=${s === 2 ? `((${r}<<1)|c)>>>0` : `((${r}<<1)|c)&${M}`};}`);
      else g.emit(`for(let i=0;i<n;i++){c=${r}&1;${r}=${s === 2 ? `((${r}>>>1)|(c?${B}:0))>>>0` : `(${r}>>>1)|(c?${B}:0)`};}`);
      g.emit(`R[22]=n?c:0;R[21]=0;`);
    }
    g.emit(`R[19]=(${r}&${B})?1:0;R[20]=${r}?0:1;}`);
    return r;
  }

  // ---------------- runtime ----------------
  // CPU(bus): bus = {rb,rw,rl,wb,ww,wl, iack(level)->vector or -1 for autovector}
  function CPU(bus) {
    this.R = new Int32Array(R_N_REGS); this.bus = bus; this.ops = new Array(65536); this.blocks = null; // blocks: Map pc -> fn
    const R = this.R, self = this;
    const X = this.X = {
      getCCR: () => (R[R_X] << 4) | (R[R_N] << 3) | (R[R_Z] << 2) | (R[R_V] << 1) | R[R_C],
      setCCR: v => { R[R_X] = (v >> 4) & 1; R[R_N] = (v >> 3) & 1; R[R_Z] = (v >> 2) & 1; R[R_V] = (v >> 1) & 1; R[R_C] = v & 1; },
      getSR: () => (R[R_SR] & 0xa700) | X.getCCR(),
      setSR: v => {
        const olds = R[R_SR] & 0x2000; X.setCCR(v & 0xff); R[R_SR] = v & 0xa700;
        if ((v & 0x2000) !== olds) { const t = R[15]; R[15] = R[R_OSP]; R[R_OSP] = t; }
      },
      priv: () => self.exception(8, R[R_PPC], 34),
      trap: v => self.exception(v, R[R_PC], v === 6 ? 40 : v === 7 ? 34 : 34),
      reset: () => { if (bus.reset) bus.reset(); },
      // BCD per Musashi (V is "undefined" on the 68000; Musashi's formula)
      abcd: (s, d) => { let r = (s & 15) + (d & 15) + R[R_X]; let v = ~r; if (r > 9) r += 6; r += (s & 0xf0) + (d & 0xf0);
        const c = r > 0x99 ? 1 : 0; if (c) r -= 0xa0; v &= r; R[R_X] = R[R_C] = c; R[R_V] = (v >> 7) & 1; R[R_N] = (r >> 7) & 1;
        r &= 0xff; if (r) R[R_Z] = 0; return r; },
      sbcd: (s, d) => { let r = ((d & 15) - (s & 15) - R[R_X]) >>> 0; let v = ~r; if (r > 9) r = (r - 6) >>> 0; r = (r + (d & 0xf0) - (s & 0xf0)) >>> 0;
        let c = 0; if (r > 0x99) { r = (r + 0xa0) >>> 0; c = 1; } R[R_N] = c; R[R_X] = R[R_C] = c; r &= 0xff; R[R_V] = ((v & r) >> 7) & 1;
        if (r) R[R_Z] = 0; return r; },
      divu: (rx, src) => {
        if (src === 0) { self.exception(5, R[R_PC], 38); return; }
        const dv = R[rx] >>> 0;
        // timing per J. Cwik
        let cyc;
        if ((dv >>> 16) >= src) { cyc = 10; R[R_V] = 1; R[R_N] = 1; R[R_C] = 0; R[R_ICNT] -= cyc; return; }
        { let mc = 38; const hd = (src << 16) >>> 0; let d = dv; for (let i = 0; i < 15; i++) { const t = d; d = (d * 2) >>> 0; if (t & 0x80000000) d = (d - hd) >>> 0; else { mc += 2; if (d >= hd) { d = (d - hd) >>> 0; mc--; } } } cyc = mc * 2; }
        const q = Math.floor(dv / src), rm = dv - q * src;
        R[rx] = ((rm << 16) | q) | 0; R[R_N] = (q >> 15) & 1; R[R_Z] = q ? 0 : 1; R[R_V] = 0; R[R_C] = 0; R[R_ICNT] -= cyc;
      },
      divs: (rx, src) => {
        if (src === 0) { self.exception(5, R[R_PC], 38); return; }
        const dv = R[rx] | 0; let mc = 6; if (dv < 0) mc++;
        const ad = Math.abs(dv), as = Math.abs(src);
        if ((ad / 65536 | 0) >= as && Math.floor(ad / 65536) >= as) { R[R_ICNT] -= (mc + 2) * 2; R[R_V] = 1; R[R_N] = 1; R[R_C] = 0; return; }
        let aq = Math.floor(ad / as) >>> 0; mc += 55;
        if (src >= 0) { if (dv >= 0) mc--; else mc++; }
        for (let i = 0; i < 15; i++) { if (!(aq & 0x8000)) mc++; aq = (aq << 1) & 0xffff; }
        R[R_ICNT] -= mc * 2;
        const q = Math.trunc(dv / src), rm = dv - q * src;
        if (q > 32767 || q < -32768) { R[R_V] = 1; R[R_N] = 1; R[R_C] = 0; return; }
        R[rx] = ((rm & 0xffff) << 16) | (q & 0xffff); R[R_N] = q < 0 ? 1 : 0; R[R_Z] = q ? 0 : 1; R[R_V] = 0; R[R_C] = 0;
      },
    };
  }
  CPU.prototype.compileOp = function (op) {
    const r = genOp(op, null);
    if (!r) return this.ops[op] = function () { this_cpu_illegal(op); };
    const b = this.bus;
    const f = new Function('R', 'rb', 'rw', 'rl', 'wb', 'ww', 'wl', 'X', `return function(){${r.code}R[24]-=${r.cyc};}`)(this.R, b.rb, b.rw, b.rl, b.wb, b.ww, b.wl, this.X);
    return this.ops[op] = f;
  };
  CPU.prototype.exception = function (vec, pc, cyc) {
    const R = this.R, X = this.X; const sr = X.getSR();
    if (!(R[R_SR] & 0x2000)) { const t = R[15]; R[15] = R[R_OSP]; R[R_OSP] = t; }
    R[R_SR] = (R[R_SR] | 0x2000) & ~0x8000;
    R[15] = (R[15] - 4) | 0; this.bus.wl(R[15] >>> 0, pc >>> 0); R[15] = (R[15] - 2) | 0; this.bus.ww(R[15] >>> 0, sr);
    R[R_PC] = this.bus.rl(vec * 4); R[R_ICNT] -= cyc;
  };
  CPU.prototype.reset = function () {
    const R = this.R; R.fill(0); R[R_SR] = 0x2700; R[15] = this.bus.rl(0); R[R_PC] = this.bus.rl(4);
  };
  CPU.prototype.interrupt = function (level) { // called at an instruction boundary when level > mask
    const R = this.R; R[R_STOP] = 0;
    const sr = this.X.getSR();
    if (!(R[R_SR] & 0x2000)) { const t = R[15]; R[15] = R[R_OSP]; R[R_OSP] = t; }
    R[R_SR] = (R[R_SR] & ~0x8700) | 0x2000 | (level << 8);
    R[15] = (R[15] - 4) | 0; this.bus.wl(R[15] >>> 0, R[R_PC] >>> 0); R[15] = (R[15] - 2) | 0; this.bus.ww(R[15] >>> 0, sr);
    R[R_PC] = this.bus.rl((24 + level) * 4);
    // autovector IACK waits for the E clock (MAME m68000 vpa_sync): the vector read starts 10 cycles in
    let w = 0; if (this.ephase) { const m = (this.ephase() + 10) % 10; w = (m < 7 ? 10 - m : 20 - m) + 1; }
    R[R_ICNT] -= 44 + w;
  };
  // Run until R_ICNT <= 0. this.blocks (from tools/translate68k) is used when present.
  CPU.prototype.run = function () {
    const R = this.R, ops = this.ops, rw = this.bus.rw, blocks = this.blocks;
    while (R[R_ICNT] > 0) {
      const ipl = R[R_IPL];
      if (ipl && (ipl > ((R[R_SR] >> 8) & 7) || ipl === 7)) { if (R[R_IDLY]) R[R_IDLY] = 0; else { this.interrupt(ipl); continue; } }
      if (R[R_STOP]) { R[R_ICNT] = 0; break; }
      const pc = R[R_PC];
      if (blocks) { const b = blocks[pc >>> 1]; if (b) { b(); continue; } }
      if (this.pre) this.pre(pc);
      R[R_PPC] = pc; const op = rw(pc >>> 0); R[R_PC] = pc + 2;
      (ops[op] || this.compileOp(op))();
      if (this.trace) this.trace(pc);
    }
  };
  function this_cpu_illegal(op) { throw new Error('68000: illegal/unimplemented opcode ' + op.toString(16)); }
  const api = { genOp, CPU, R_PC, R_SR, R_X, R_N, R_Z, R_V, R_C, R_OSP, R_ICNT, R_STOP, R_IPL, R_PPC, R_N_REGS };
  if (typeof module !== 'undefined') module.exports = api; else G.M68K = api;
})(typeof window !== 'undefined' ? window : globalThis);
