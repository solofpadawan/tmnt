// Online highscore (stage/net/highscore.js): the score RAM addresses and the game-ended event, checked
//  (1) on synthetic work-RAM frames (Tracker rules: armed only after a non-game frame, occupancy, max score, BCD word, stale scores, one event),
//  (2) finish() / flushOnHostLeft() / attach() / post() with a stubbed session and fetch (nothing leaves this process), and
//  (3) on a REAL power-on run of the machine (stage/sim/tmnt.js with the user's ROM): 4 players coin in and play until every continue expires,
//      then a second game with 2 players (the first game's scores are still in RAM when it starts): the BCD score word at 0x60104 + 8*slot is what the
//      game holds, mode byte 0x60001 goes 2 -> 1 once per game, and the Tracker reports the occupied slots with the highest scores and no stale ones.
// MAME cross-check of the same addresses: test/mame/ramlog.lua (+ ramlog.js, same input script on the sim).
// Usage: node test/highscore_check.js [--no-rom]
const fs = require('fs'), path = require('path'), R = p => path.join(__dirname, '..', p);
const HS = require(R('stage/net/highscore.js'));
let fails = 0; const ok = (n, c, i) => { console.log((c ? 'PASS ' : 'FAIL ') + n, i === undefined ? '' : i); if (!c) fails++; };
const mk = () => new Uint8Array(0x4000);
const setBcd = (w, s, v) => { const b = 0x104 + 8 * s, d = String(v).padStart(4, '0'); for (let i = 0; i < 2; i++) w[b + i] = (d.charCodeAt(2 * i) - 48) << 4 | (d.charCodeAt(2 * i + 1) - 48); };
const occ = (w, s) => { w[0x101 + 8 * s] = 2; w[0x107 + 8 * s] = 2; };
const run = (t, w, n, f0 = 100) => { let r = null; for (let i = 0; i < n; i++) { const x = t.observe(w, f0 + i); if (x) r = x; } return r; };
// ---- (1) tracker rules
ok('bcd16 reads 0x0312 as 312', HS.bcd16(Uint8Array.of(0x03, 0x12), 0) === 312 && HS.bcd16(Uint8Array.of(0x99, 0x99), 0) === 9999);
ok('bcd16 rejects a non-decimal nibble', HS.bcd16(Uint8Array.of(0x0a, 0x12), 0) === -1);
ok('RAM addresses: mode 0x60001, slot s score word 0x60104 + 8*s', HS.ADDR.mode === 0x60001 && HS.ADDR.slot0 + HS.ADDR.score === 0x60104 && HS.ADDR.stride === 8);
ok('board nick folds accents / case / symbols / spaces, cuts to 8, pads short ones with P{slot+1} and X',
  HS.boardNickOf('Chicão!') === 'CHICAO' && HS.boardNickOf('ab', 0) === 'ABP1' && HS.boardNickOf('Anfitriao') === 'ANFITRIA'
  && HS.boardNickOf('João da Silva') === 'JOAODASI' && HS.boardNickOf('João Silva') === 'JOAOSILV' && HS.boardNickOf('R2-D2') === 'R2D2'
  && HS.boardNickOf('12345678') === '12345678' && HS.boardNickOf('Zé', 1) === 'ZEP2' && HS.boardNickOf('', 0) === 'P1X'
  && HS.boardNickOf('A', 2) === 'AP3' && HS.boardNickOf('AB', 2) === 'ABP3' && !/\s/.test(HS.boardNickOf('a b c d')));
// ---- (1b) mid-match joiner policy is isolated in HS.POLICY (rule 4 unchanged) + state is exportable for a future join snapshot
{
  ok('POLICY (rule 4): a slot seated AFTER the start is out, one seated at/before is in, no game info = no filter',
    HS.POLICY.slotCountsInReport(500, 400) === false && HS.POLICY.slotCountsInReport(400, 400) === true && HS.POLICY.slotCountsInReport(0, 400) === true && HS.POLICY.slotCountsInReport(5, null) === true);
  ok('POLICY (rule 4): a tracker that did not see the start of the game does not count', HS.POLICY.trackerMayStartMidGame === false);
  const rb = { join: [0, 0, 500, 0x7fffffff], leave: [0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff] };
  ok('seatedSlots goes through the policy: joiner at 500 excluded for a game that started at 400, included for one that started at 600',
    HS.seatedSlots({ rb }, 400).join() === '0,1' && HS.seatedSlots({ rb }, 600).join() === '0,1,2');
  ok('rosterState is plain JSON of join / leave', JSON.stringify(HS.rosterState({ rb })) === JSON.stringify({ join: rb.join, leave: rb.leave }) && HS.rosterState({}) === null);
  const t = new HS.Tracker(), w = mk(); w[1] = 1; t.observe(w, 1); w[1] = 2; occ(w, 0); occ(w, 1); for (let i = 0; i < 6; i++) { setBcd(w, 0, 100 + i); setBcd(w, 1, 50); t.observe(w, 10 + i); }
  const st = JSON.parse(JSON.stringify(t.exportState())), t2 = new HS.Tracker();
  ok('Tracker.exportState -> importState round trip (plain JSON) gives the same scores and the same end result',
    t2.importState(st) && JSON.stringify(t2.current()) === JSON.stringify(t.current()) && (w[1] = 1, JSON.stringify(t2.observe(w, 30)) === JSON.stringify(t.observe(w, 30))));
  ok('Tracker.importState rejects junk', new HS.Tracker().importState(null) === false && new HS.Tracker().importState({ occ: [1], max: [1] }) === false);
}
{
  const t = new HS.Tracker(), w = mk(); let r;
  w[1] = 2; occ(w, 0); setBcd(w, 0, 100); ok('mid-game start (never saw the beginning): not armed, no event', t.observe(w, 1) === null && t.armed === false);
  for (let i = 0; i < 3; i++) t.observe(w, 2 + i); w[1] = 1; ok('mid-game start: the later end is NOT reported', t.observe(w, 9) === null);
  w[1] = 2; occ(w, 0); occ(w, 1); setBcd(w, 0, 400); setBcd(w, 1, 90); r = t.observe(w, 10);
  ok('after a non-game frame the next game is tracked', r === null && t.inGame && t.startF === 10);
  run(t, w, 4, 11); ok('stale scores of the previous game (first GRACE frames) are ignored', JSON.stringify(t.current().scores) === JSON.stringify([{ slot: 0, score: 400 }, { slot: 1, score: 90 }]) && t.gf === 5);
  const t2 = new HS.Tracker(); w[1] = 1; t2.observe(w, 1); w[1] = 2; run(t2, w, 3, 2); ok('...while the first 3 frames do not take scores (occupancy only)', JSON.stringify(t2.current().scores) === JSON.stringify([{ slot: 0, score: 0 }, { slot: 1, score: 0 }]));
  setBcd(w, 0, 1230); setBcd(w, 1, 70); t.observe(w, 20); setBcd(w, 0, 0); setBcd(w, 1, 0); t.observe(w, 21); // scores dropping again (new game started in RAM): max is kept
  w[1] = 1; r = t.observe(w, 22);
  ok('end event: highest scores of every occupied slot, empty slots omitted, startF given', r && JSON.stringify(r.scores) === JSON.stringify([{ slot: 0, score: 1230 }, { slot: 1, score: 90 }]) && r.startF === 10, JSON.stringify(r));
  ok('one event only', t.observe(w, 23) === null && t.ended === 1);
  w.fill(0); w[1] = 2; occ(w, 1); occ(w, 0); setBcd(w, 0, 90); run(t, w, 5, 30); w[1] = 3; ok('game mode -> 3 (service / test screen) is not a game over', t.observe(w, 40) === null);
  w.fill(0); w[1] = 2; occ(w, 2); setBcd(w, 2, 9999); run(t, w, 5, 50); w[1] = 1; r = t.observe(w, 60);
  ok('next game (same tracker): slot 2 alone, 9999 accepted', r && r.scores.length === 1 && r.scores[0].slot === 2 && r.scores[0].score === 9999);
  w.fill(0); w[1] = 2; occ(w, 3); w[0x104 + 24 + 1] = 0x1f; run(t, w, 5, 70); w[1] = 1; r = t.observe(w, 80);
  ok('invalid BCD sample is ignored (score stays 0), slot still occupied', r && r.scores[0].slot === 3 && r.scores[0].score === 0);
  w.fill(0); w[1] = 2; w[0x107] = 1; w[0x10f] = 1; run(t, w, 5, 90); w[1] = 1; r = t.observe(w, 100);
  ok('slots that never joined (state byte 1, no lives, no score) are not occupied', r && r.scores.length === 0);
}
// ---- (2) finish() / attach() / post() with a stubbed session and fetch (nothing leaves this process)
globalThis.location = { protocol: 'https:' };
const sess = (o) => Object.assign({ role: 'host', slot: 0, spec: false, wasSpec: false, watch: false }, o);
const MID = '0123456789abcdef0123456789abcdef', TR = { match_id: MID, id: 'peer123abc', room: 'SALA-1' };
const two = { scores: [{ slot: 0, score: 120 }, { slot: 1, score: 34 }], startF: 100 };
let calls = []; globalThis.fetch = async (url, o) => { calls.push({ url, o, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, status: 'pending' }) }; };
const last = () => HS.events[HS.events.length - 1], tick = () => new Promise(r => setTimeout(r, 20));
const SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php', URLR = 'https://games4me-netplay.games4me.workers.dev/scores/report';
async function stubs() {
  ok('retry schedule of the real file is 0 / 1.5 s / 5 s', JSON.stringify(HS.RETRY_MS) === '[0,1500,5000]', JSON.stringify(HS.RETRY_MS));
  HS.RETRY_MS.splice(0, 3, 0, 5, 5); // fast retries for the stubbed tests below
  const fin = async (s, t, nick, res) => { calls = []; HS.finish(s, () => ({ t, room: 'SALA-1', signal: SIG, nick }), res || two); await tick(); await tick(); return calls.slice(); };
  let c = await fin(sess(), TR, 'Chico');
  ok('finish: host posts one body to the Worker /scores/report', c.length === 1 && c[0].url === URLR && c[0].o.method === 'POST' && /json/.test(c[0].o.headers['Content-Type']));
  const b = c[0] && c[0].body;
  ok('finish: body fields (game tmnt_web, match_id, room, peer_id, role, nick, my_slot, scores)', b && b.game === 'tmnt_web' && b.match_id === MID && b.room === 'SALA-1' && b.peer_id === 'peer123abc' && b.role === 'host' && b.nick === 'CHICO' && b.my_slot === 0 && JSON.stringify(b.scores) === JSON.stringify([{ slot: 0, score: 120, nick: 'CHICO' }, { slot: 1, score: 34, nick: 'P2X' }]), JSON.stringify(b));
  c = await fin(sess(), TR, 'Chico'); ok('finish: a second game of the same match_id does not post again', c.length === 0 && last().why === 'already reported');
  const T2 = Object.assign({}, TR, { match_id: 'fedcba9876543210fedcba9876543210' });
  c = await fin(sess({ role: 'guest', slot: 1 }), T2, 'Rita9'); ok('finish: guest = role guest, my_slot = session.slot', c.length === 1 && c[0].body.role === 'guest' && c[0].body.my_slot === 1 && c[0].body.nick === 'RITA9' && c[0].body.scores[1].nick === 'RITA9' && c[0].body.scores[0].nick === 'P1X');
  const T3 = n => Object.assign({}, TR, { match_id: n.padStart(32, 'a') });
  const three = { scores: [{ slot: 0, score: 900 }, { slot: 1, score: 500 }, { slot: 2, score: 100 }], startF: 100 };
  { const sg = Object.assign(sess({ role: 'guest', slot: 2 }), { names: () => ['Chico', 'Rita9', 'Zeca'] });
    c = await fin(sg, T3('c1'), 'Zeca', three);
    ok('finish: nicks of all slots derived from the session names (own slot uses its own)', c.length === 1 && JSON.stringify(c[0].body.scores) === JSON.stringify([{ slot: 0, score: 900, nick: 'CHICO' }, { slot: 1, score: 500, nick: 'RITA9' }, { slot: 2, score: 100, nick: 'ZECA' }]) && c[0].body.nick === 'ZECA' && c[0].body.my_slot === 2, JSON.stringify(c[0] && c[0].body));
    const sh = Object.assign(sess(), { names: () => ['Chico', 'ab', 'João Silva!'] });
    c = await fin(sh, T3('c2'), 'Chico', three);
    ok('finish: accented / short peer nicks are folded or padded, never left out', c.length === 1 && JSON.stringify(c[0].body.scores) === JSON.stringify([{ slot: 0, score: 900, nick: 'CHICO' }, { slot: 1, score: 500, nick: 'ABP2' }, { slot: 2, score: 100, nick: 'JOAOSILV' }]), JSON.stringify(c[0] && c[0].body)); }
  { // a player who already left is omitted from every remaining report (rollback roster), so fingerprints still agree
    const INF = HS.SEAT_INF, rbLeft = { join: [0, 0, 0, INF], leave: [INF, INF, 80, INF] }, names3 = () => ['Chico', 'Rita', 'Zé', ''];
    const sh = Object.assign(sess(), { names: names3, rb: rbLeft }), sg = Object.assign(sess({ role: 'guest', slot: 1 }), { names: names3, rb: rbLeft });
    c = await fin(sh, T3('e1'), 'Chico', three);
    const want = [{ slot: 0, score: 900, nick: 'CHICO' }, { slot: 1, score: 500, nick: 'RITA' }];
    ok('finish: leaver (slot 2) omitted from the host report', c.length === 1 && JSON.stringify(c[0].body.scores) === JSON.stringify(want) && c[0].body.nick === 'CHICO', JSON.stringify(c[0] && c[0].body));
    const c2 = await fin(sg, T3('e11'), 'Rita', three);
    ok('finish: the other remaining player sends the same slot:score set (no leaver)', c2.length === 1 && JSON.stringify(c2[0].body.scores) === JSON.stringify(want) && c2[0].body.nick === 'RITA' && c2[0].body.my_slot === 1);
    c = await fin(Object.assign(sess({ role: 'guest', slot: 2 }), { names: names3, rb: rbLeft }), T3('e13'), 'Zé', three);
    ok('finish: the player who already left does not report', c.length === 0 && /my slot/.test(last().why), last());
    c = await fin(Object.assign(sess(), { rb: { join: [0, 0, INF, INF], leave: [INF, 50, INF, INF] } }), T3('e2'), 'Chico');
    ok('finish: after the only guest leaves, fewer than 2 connected -> no report', c.length === 0 && /fewer/.test(last().why), last());
    // a slot seated AFTER the game began (mid-match joiner / re-seated freed slot) is omitted from every report
    const rbLate = { join: [0, 0, 150, INF], leave: [INF, INF, INF, INF] };
    c = await fin(Object.assign(sess(), { names: names3, rb: rbLate }), T3('e3'), 'Chico', three);
    ok('finish: slot seated after the game started (join frame 150 > start 100) is omitted', c.length === 1 && JSON.stringify(c[0].body.scores.map(x => x.slot)) === '[0,1]', JSON.stringify(c[0] && c[0].body));
    c = await fin(Object.assign(sess({ role: 'guest', slot: 2 }), { names: names3, rb: rbLate }), T3('e4'), 'Zé', three);
    ok('finish: the mid-match joiner does not report', c.length === 0 && /my slot/.test(last().why), last()); }
  { // host leaves mid-match: remaining guests AND the host report the last confirmed scores, INCLUDING the host's slot
    const INF = HS.SEAT_INF, names3 = () => ['Chico', 'Rita', 'Zé', ''], rbAll = { join: [0, 0, 0, INF], leave: [INF, INF, INF, INF] };
    const mkTr = () => { const tr = new HS.Tracker(), w = mk(); w[1] = 1; tr.observe(w, 1); w[1] = 2; occ(w, 0); occ(w, 1); occ(w, 2); setBcd(w, 0, 900); setBcd(w, 1, 500); setBcd(w, 2, 100); run(tr, w, 6, 2); return tr; };
    const flush = async (s, mid, tr, nick, rb) => { calls = []; HS.flushOnHostLeft(Object.assign(s, { names: names3, rb: rb || rbAll }), () => ({ t: T3(mid), room: 'SALA-1', signal: SIG, nick }), tr); await tick(); await tick(); return calls.slice(); };
    let tr = mkTr();
    ok('tracker.current: in-game max scores of occupied slots, does not end the game', tr.inGame && JSON.stringify(tr.current().scores) === JSON.stringify([{ slot: 0, score: 900 }, { slot: 1, score: 500 }, { slot: 2, score: 100 }]));
    c = await flush(sess(), 'f1', tr, 'Chico');
    const wantAll = [{ slot: 0, score: 900, nick: 'CHICO' }, { slot: 1, score: 500, nick: 'RITA' }, { slot: 2, score: 100, nick: 'ZEP3' }];
    ok('flushOnHostLeft: host includes its own slot and both guests', c.length === 1 && JSON.stringify(c[0].body.scores) === JSON.stringify(wantAll) && c[0].body.role === 'host' && c[0].body.nick === 'CHICO', JSON.stringify(c[0] && c[0].body));
    const cG = await flush(sess({ role: 'guest', slot: 1 }), 'f11', mkTr(), 'Rita');
    ok('flushOnHostLeft: a guest sends the same slot:score set including the host', cG.length === 1 && JSON.stringify(cG[0].body.scores) === JSON.stringify(wantAll) && cG[0].body.nick === 'RITA' && cG[0].body.my_slot === 1);
    const trE = mkTr(), wE = mk(); wE[1] = 1; trE.observe(wE, 50);
    calls = []; HS.flushOnHostLeft(Object.assign(sess(), { names: names3, rb: rbAll }), () => ({ t: T3('f12'), room: 'SALA-1', signal: SIG, nick: 'Chico' }), trE); await tick();
    ok('flushOnHostLeft: after a normal end (mode 2->1) does nothing extra', calls.length === 0 && /no match in progress/.test(last().why), last());
    const trD = mkTr(); await fin(Object.assign(sess(), { names: names3, rb: rbAll }), T3('f2'), 'Chico', trD.current());
    c = await flush(sess(), 'f2', trD, 'Chico'); ok('flushOnHostLeft: after this match was already reported, skip (already reported)', c.length === 0 && last().why === 'already reported', last());
    c = await flush(sess(), 'f3', mkTr(), 'Chico', { join: [0, 0, 0, INF], leave: [INF, INF, 80, INF] });
    ok('flushOnHostLeft: a guest who already left is still omitted, the host is kept', c.length === 1 && JSON.stringify(c[0].body.scores) === JSON.stringify([{ slot: 0, score: 900, nick: 'CHICO' }, { slot: 1, score: 500, nick: 'RITA' }]));
    const trI = new HS.Tracker(); calls = []; HS.flushOnHostLeft(sess({ names: names3, rb: rbAll }), () => ({ t: T3('f4'), room: 'S', signal: SIG, nick: 'C' }), trI); await tick();
    ok('flushOnHostLeft: host in the lobby / attract (no game running) sends nothing', calls.length === 0); }
  c = await fin(sess({ role: 'guest', slot: 1 }), T3('1'), 'Rita', { scores: [{ slot: 0, score: 5 }], startF: 1 }); ok('finish: fewer than 2 players -> no report', c.length === 0 && /fewer/.test(last().why));
  c = await fin(sess({ role: 'guest', slot: 2 }), T3('2'), 'Rita'); ok('finish: my slot did not play -> no report', c.length === 0 && /my slot/.test(last().why));
  c = await fin(sess({ role: 'guest', slot: 1, spec: true }), T3('3'), 'Rita'); ok('finish: spectator -> no report', c.length === 0 && last().why === 'spectator');
  c = await fin(sess({ role: 'guest', slot: 1, wasSpec: true }), T3('4'), 'Rita'); ok('finish: promoted spectator (was one) -> no report', c.length === 0 && last().why === 'spectator');
  c = await fin(sess({ watch: true }), T3('5'), 'Rita'); ok('finish: watch-only -> no report', c.length === 0);
  c = await fin(sess(), { id: 'x', room: 'R' }, 'Chico'); ok('finish: transport without match_id (PeerJS / signal.php) -> no report', c.length === 0 && /match_id/.test(last().why));
  c = await fin(sess(), Object.assign({}, TR, { match_id: 'XYZ' }), 'Chico'); ok('finish: malformed match_id -> no report', c.length === 0);
  c = await fin(sess(), T3('6'), 'Anfitriao'); ok('finish: 9-char nick is cut to 8 (ANFITRIA), report is still sent', c.length === 1 && c[0].body.nick === 'ANFITRIA');
  c = await fin(sess(), T3('7'), 'ab'); ok('finish: short nick is padded (ABP1 for slot 0), report is still sent', c.length === 1 && c[0].body.nick === 'ABP1' && c[0].body.scores[1].nick === 'P2X');
  let n = 0; globalThis.fetch = async (url, o) => { calls.push({ url, o, body: JSON.parse(o.body) }); n++; if (n === 1) throw new Error('offline'); if (n === 2) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ ok: true, status: 'accepted' }) }; };
  c = await fin(sess(), T3('8'), 'Chico'); await new Promise(r => setTimeout(r, 120));
  ok('post: network error then 503 then ok -> 3 attempts, identical body, result accepted', calls.length === 3 && calls[0].o.body === calls[1].o.body && calls[1].o.body === calls[2].o.body && last().type === 'result' && last().status === 'accepted', calls.length + ' ' + JSON.stringify(last()));
  calls = []; globalThis.fetch = async (url, o) => { calls.push(o); return { ok: false, status: 400, json: async () => ({ ok: false, error: 'bad nick' }) }; };
  await fin(sess(), T3('9'), 'Chico'); await new Promise(r => setTimeout(r, 60)); ok('post: a 4xx answer (bad nick) is final, not retried', calls.length === 1 && last().status === 'bad nick');
  calls = []; globalThis.fetch = async (url, o) => { calls.push(o); throw new Error('down'); };
  await fin(sess(), T3('a'), 'Chico'); await new Promise(r => setTimeout(r, 120)); ok('post: network down -> 3 tries then gives up quietly (never throws)', calls.length === 3 && last().status === 'failed');
  globalThis.location = { protocol: 'app:' }; const s1 = sess(); ok('attach: app: (Electron / desktop) attaches nothing', HS.attach(s1, () => ({})) === null && !s1.onConfirmed);
  globalThis.location = { protocol: 'https:' }; const s2 = sess(); ok('attach: web attaches an observer on the session', !!HS.attach(s2, () => ({})) && typeof s2.onConfirmed === 'function');
  const s3 = sess(); calls = []; globalThis.fetch = async (url, o) => { calls.push(o); return { ok: true, status: 200, json: async () => ({ ok: true, status: 'accepted' }) }; };
  HS.attach(s3, () => ({ t: Object.assign({}, TR, { match_id: 'b'.repeat(32) }), room: 'SALA-1', signal: SIG, nick: 'Chico' }));
  const w = mk(); w[1] = 1; s3.onConfirmed(1, { wram: w }); w[1] = 2; occ(w, 0); occ(w, 1); setBcd(w, 0, 100); for (let f = 2; f < 8; f++) s3.onConfirmed(f, { wram: w }); w[1] = 1; s3.onConfirmed(8, { wram: w }); await tick(); await tick();
  ok('attach: observer reports once at the game end (confirmed frames 1..8)', calls.length === 1 && JSON.parse(calls[0].body).scores.length === 2 && JSON.parse(calls[0].body).scores[0].score === 100);
  s3.onConfirmed(9, {}); s3.onConfirmed(10, null); ok('attach: a confirmed frame without a snapshot is ignored', true);
}
(async () => { await stubs(); realMachine(); })();
// ---- (3) real machine
function realMachine() {
  if (process.argv.includes('--no-rom') || !fs.existsSync(R('stage/roms/tmnt.zip'))) { console.log('SKIP real machine run (no ROM)'); process.exit(fails ? 1 : 0); }
  const { loadRomset } = require('./romzip.js'), Machine = require(R('stage/sim/tmnt.js')), IN = require(R('stage/input.js'));
  const rs = loadRomset(), m = new Machine(rs); m.powerOn(); const w = m.wram, tr = new HS.Tracker();
  const seen = { g1: [0, 0, 0, 0], g2: [0, 0, 0, 0] }; const flips = [], atFlip = []; const results = []; let G = 'g1', prev = 0, T2 = 0, entryRam = null, startF = -1, gf = 0;
  const score = s => HS.bcd16(w, 0x104 + 8 * s);
  const script = f => { const o = new Uint8Array(4); const mask = f < 7000 && !T2 ? 15 : 3;
    for (let p = 0; p < 4; p++) { if (!((mask >> p) & 1)) continue;
      const b0 = T2 ? T2 : 0;
      if (!T2) { if (f >= 600 + 30 * p && f < 608 + 30 * p) o[p] |= 0x40; if (f >= 760 + 30 * p && f < 768 + 30 * p) o[p] |= 0x10; }
      else { if (f >= b0 + 30 * p && f < b0 + 8 + 30 * p) o[p] |= 0x40; if (f >= b0 + 70 + 30 * p && f < b0 + 78 + 30 * p) o[p] |= 0x10; }
      if (f > 1900 && !(T2 && f < T2 + 150)) { const x = (Math.imul(Math.floor(f / 17) + 101 * p, 2654435761) >>> 0) >>> 11; o[p] |= [0, 1, 2, 4, 8, 16, 32, 17, 34][x % 9]; } }
    return o; };
  for (let f = 1; f < 40000 && results.length < 2; f++) {
    if (!T2 && flips.length === 1 && w[1] === 1 && f > flips[0] + 30) T2 = f + 10;  // second game: only P1 and P2 coin in again
    IN.applyFrame(m, script(f), true); m.step();
    if (prev !== 2 && w[1] === 2) { G = flips.length ? 'g2' : 'g1'; gf = 0; if (G === 'g2') entryRam = [0, 1, 2, 3].map(score); }
    if (w[1] === 2) { gf++; if (gf > HS.GRACE) for (let s = 0; s < 4; s++) { const v = score(s); if (v > seen[G][s]) seen[G][s] = v; } }
    if (prev === 2 && w[1] === 1) { flips.push(f); atFlip.push([0, 1, 2, 3].map(score)); } prev = w[1];
    const r = tr.observe(w, f); if (r) results.push(r);
  }
  console.log('real run: game 1 scores (RAM, BCD, max seen)', seen.g1.join(','), '| game 2', seen.g2.join(','), '| mode 2 -> 1 at frames', flips.join(','), '| stale scores in RAM at game 2 start', entryRam && entryRam.join(','));
  ok('real run: two games, each ended once (mode 2 -> 1) and the tracker saw both', flips.length === 2 && results.length === 2);
  ok('real run: game 1 = four players (0,1,2,3) coined in', results[0] && results[0].scores.map(x => x.slot).join() === '0,1,2,3', JSON.stringify(results[0]));
  ok('real run: game 1 reported scores = highest RAM scores seen, at least one scored', results[0] && results[0].scores.every((x, i) => x.score === seen.g1[i]) && seen.g1.some(v => v > 0));
  ok('real run: game 2 = only the two players who coined in again (0,1), slots 2/3 absent', results[1] && results[1].scores.map(x => x.slot).join() === '0,1', JSON.stringify(results[1]));
  ok('real run: game 2 starts with the previous game\'s scores still in RAM, and they are NOT reported', entryRam && entryRam.some(v => v > 0) && results[1] && results[1].scores.every((x, i) => x.score === seen.g2[i]), JSON.stringify([entryRam, seen.g2, results[1]]));
  ok('real run: the game does not clear the scores at game over (RAM at the flip frame = highest seen)', atFlip.length === 2 && atFlip[0].join() === seen.g1.join() && atFlip[1].join() === seen.g2.join(), JSON.stringify(atFlip));
  process.exit(fails ? 1 : 0);
}
