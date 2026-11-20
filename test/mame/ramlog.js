// node sim twin of ramlog.lua (same inputs, same format). usage: node ramlog.js N > file
const path=process.env.TMNT_ROOT||'/workspace/tmnt/';
const { loadRomset } = require(path+'tools/romzip.js');
const Machine = require(path+'web/sim/tmnt.js'), IN = require(path+'web/input.js');
const rs = loadRomset(); const MASK=+(process.env.TMNT_MASK||15);
function script(f) { const o = new Uint8Array(4);
  for (let p = 0; p < 4; p++) { if(!((MASK>>p)&1)) continue;
    if (f >= 600 + 30 * p && f < 608 + 30 * p) o[p] |= 0x40;
    if (f >= 760 + 30 * p && f < 768 + 30 * p) o[p] |= 0x10;
    if (f > 1900) { const x = (Math.imul(Math.floor(f / 17) + 101 * p, 2654435761) >>> 0) >>> 11; o[p] |= [0, 1, 2, 4, 8, 16, 32, 17, 34][x % 9]; } }
  return o; }
const m = new Machine(rs); m.powerOn(); const N=+process.argv[2]||9000; const h2=v=>v.toString(16).padStart(2,'0'); const lines=[];
for (let f=1;f<=N;f++){ IN.applyFrame(m, script(f), true); m.step(); const w=m.wram, t=[f,w[1]];
  for(let s=0;s<4;s++){ t.push(h2(w[0x104+8*s])+h2(w[0x105+8*s])); t.push(w[0x101+8*s]+'/'+w[0x107+8*s]); } lines.push(t.join(' ')); }
console.log(lines.join('\n'));
