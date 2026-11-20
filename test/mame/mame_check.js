// Feeds the per-frame RAM log written by MAME (run_mame.sh / ramlog.lua) to the highscore Tracker and checks the addresses against the emulator:
// mode byte 0x60001 (1 -> 2 at game start, 2 -> 1 once at the end), score words 0x60104 + 8*s (valid BCD, never decrease inside a game, persist after the end),
// player state byte 0x60107 + 8*s (2 = in the game), lives byte 0x60101 + 8*s. Usage: node test/mame/mame_check.js
const fs = require('fs'), path = require('path'); const HS = require('../../stage/net/highscore.js');
let fails = 0; const ok = (n, c, i) => { console.log((c ? 'PASS ' : 'FAIL ') + n, i === undefined ? '' : i); if (!c) fails++; };
for (const [mask, slots] of [[15, '0,1,2,3'], [3, '0,1']]) {
  const file = path.join(__dirname, `../logs/mame_ramlog_mask${mask}.txt`); const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.split(' '));
  const tr = new HS.Tracker(), w = new Uint8Array(0x4000); const seen = [0, 0, 0, 0], res = []; let prev = -1, start = -1, flips = [], monotonic = true, lastSc = [0, 0, 0, 0], gf = 0, atFlip = null, stateSeen = [0, 0, 0, 0];
  for (const L of lines) {
    const f = +L[0], mode = +L[1]; w[1] = mode;
    for (let s = 0; s < 4; s++) { const sc = L[2 + 2 * s], st = L[3 + 2 * s].split('/'); w[0x104 + 8 * s] = parseInt(sc.slice(0, 2), 16); w[0x105 + 8 * s] = parseInt(sc.slice(2), 16); w[0x101 + 8 * s] = +st[0]; w[0x107 + 8 * s] = +st[1]; }
    if (prev !== 2 && mode === 2) { start = f; gf = 0; lastSc = [0, 0, 0, 0]; }
    if (mode === 2) { gf++; for (let s = 0; s < 4; s++) { const v = HS.bcd16(w, 0x104 + 8 * s); if (v < 0) ok('MAME: score word is valid BCD', false, L.join(' ')); if (gf > HS.GRACE) { if (v < lastSc[s]) monotonic = false; lastSc[s] = v; if (v > seen[s]) seen[s] = v; } if (w[0x107 + 8 * s] === 2) stateSeen[s] = 1; } }
    if (prev === 2 && mode === 1) { flips.push(f); atFlip = [0, 1, 2, 3].map(s => HS.bcd16(w, 0x104 + 8 * s)); }
    prev = mode; const r = tr.observe(w, f); if (r) res.push(r);
  }
  console.log(`MAME mask ${mask}: game start frame ${start}, mode 2 -> 1 at ${flips.join(',')}, max scores ${seen.join(',')}, scores at the flip ${atFlip && atFlip.join(',')}`);
  ok(`MAME ${mask}: mode byte goes 1 -> 2 at the game start and 2 -> 1 exactly once at the end`, start > 0 && flips.length === 1);
  ok(`MAME ${mask}: score words are BCD and never decrease during the game`, monotonic);
  ok(`MAME ${mask}: the game does not clear the scores at game over (flip-frame RAM = highest seen)`, atFlip && atFlip.join() === seen.join());
  ok(`MAME ${mask}: state byte +7 == 2 only for the players that coined in`, stateSeen.join() === [0, 1, 2, 3].map(s => (mask >> s) & 1).join(), stateSeen.join());
  ok(`MAME ${mask}: tracker reports one game with slots ${slots} and the highest scores`, res.length === 1 && res[0].scores.map(x => x.slot).join() === slots && res[0].scores.every(x => x.score === seen[x.slot]), JSON.stringify(res));
  ok(`MAME ${mask}: at least one player scored`, seen.some(v => v > 0));
}
process.exit(fails ? 1 : 0);
