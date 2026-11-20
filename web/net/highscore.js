// Online highscore report (bar board, Worker games4me-netplay /scores/report; contract: highscores/DESIGN.md section 7). WEB ONLY.
// What it does: while a netplay session runs it watches the CONFIRMED frames (Rollback.onConfirm, read-only: nothing here touches the
// machine, the inputs, the rollback, the audio or the hashes), reads each player's score from the emulated work RAM and, when the game ends,
// sends ONE report per match to the Worker. Offline play, PeerJS, plain signal.php, spectators and the desktop app (app:) never report.
// RAM (68000 address space; work RAM 0x60000..0x63fff, wram[a - 0x60000]); player slot s = 0..3 (P1..P4):
//   0x60001 byte game mode: 0 boot, 1 attract / title / hi-score screens, 2 game running (85 / 170 / 255 only during the boot RAM test).
//           The game only goes 2 -> 1 when everybody is out (all continues expired) or the game ends: that is the "game ended" event.
//   per-player record at 0x60100 + 8*s:  +0 word lives left (0 = out)   +1 word 3   +4 WORD SCORE, packed BCD (0x0123 = 123 points; added with ABCD
//           at 0x1fa0, max 9999; the game clears it when a new game starts and does NOT clear it at game over)
//           +6 byte energy   +7 byte 2 = player in the game, 1 = not playing / out for good (set by coin + attack, back to 1 at game over)
//   (the same score words are what the game copies into its own hi-score table at 0x63500 and the table is sorted at 0x7c16.)
// Per match the tracker keeps, for every slot, "was occupied" (record +7 == 2 or lives > 0 or score > 0 seen in game mode) and the highest score
// seen. The first GRACE frames of a game are ignored for scores (the previous game's scores are still in RAM until the game clears them a frame
// or two after the mode flips). It is armed only if it saw a non-game frame first (a guest that joins in the middle of a game never saw the
// beginning and does not report; the host and the early guests do). If the host leaves mid-match (before the 2 -> 1 flip), the remaining guests
// and the leaving host report right away from the last confirmed scores, including the host's slot; a guest that already left, and a slot that
// was (re)seated after the game started, are omitted from every report. See NOTES.md.
(function (G) {
  'use strict';
  const NODE = typeof module !== 'undefined' && module.exports;
  const GAME = 'tmnt_web', NS = 4, SCORE_MAX = 99999999, BASE = 0x100, STRIDE = 8, A_LIVES = 1, A_SCORE = 4, A_STATE = 7, A_MODE = 1, GRACE = 3;
  const MATCH_RE = /^[0-9a-f]{32}$/, SEAT_INF = 0x7fffffff; // SEAT_INF = Rollback.INF: still connected <=> join != INF and leave == INF
  // packed BCD word (big endian, 2 bytes) -> integer; -1 if any nibble is not a decimal digit
  function bcd16(w, a) { let v = 0; for (let i = 0; i < 2; i++) { const b = w[a + i], hi = b >> 4, lo = b & 15; if (hi > 9 || lo > 9) return -1; v = v * 100 + hi * 10 + lo; } return v; }
  // Board nick: always derived from the player's normal nick (tmnt_nick / Session.names()). No extra field and no player action.
  // Fold: NFD, strip accents, uppercase, drop anything outside A-Z0-9 (no spaces), cut to 8. If shorter than 3 characters, append
  // 'P' + the 1-based slot (P1..P4) and then 'X' until the result is 3 characters (empty nick in slot 0 -> P1X; "Zé" in
  // slot 1 -> ZEP2; "AB" in slot 0 -> ABP1). A report is never blocked for lack of a nick.
  const fold = x => String(x == null ? '' : x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const boardNickOf = (x, slot) => {
    let n = fold(x).slice(0, 8);
    if (n.length >= 3) return n;
    n = (n + 'P' + ((slot | 0) + 1)).slice(0, 8);
    while (n.length < 3) n += 'X';
    return n;
  };

  // ===== MID-MATCH JOINER POLICY (rule 4): the ONLY place that decides it =====
  // Current rule: a player who joins after the match began never reports and is in nobody's report. It is enforced by exactly these two
  // hooks; nothing else in this file knows about it. To change the policy later, change only this object (and, if a late joiner should
  // report the host's numbers, feed it the host's tracker + roster through Tracker.exportState()/importState() and rosterState() below,
  // e.g. inside the join snapshot).
  const POLICY = {
    // may a slot seated at rollback frame joinF be part of a match that started at frame startF? (startF == null: no game info, no filter)
    slotCountsInReport(joinF, startF) { return startF == null || joinF <= startF; },
    // may a tracker that did not see the start of the game (page opened / joined while a game was already running) start counting?
    trackerMayStartMidGame: false,
  };

  function Tracker() { this.reset(); }
  Tracker.prototype.reset = function () { this.armed = false; this.inGame = false; this.occ = [0, 0, 0, 0]; this.max = [0, 0, 0, 0]; this.ended = 0; this.startF = 0; this.gf = 0; };
  Tracker.prototype.scores = function () { const scores = []; for (let s = 0; s < NS; s++) if (this.occ[s]) scores.push({ slot: s, score: this.max[s] }); return scores; };
  // Plain-JSON copy of everything the tracker knows about the running match (for a future "host sends it in the join snapshot"; NOT used today).
  Tracker.prototype.exportState = function () { return { armed: this.armed, inGame: this.inGame, occ: this.occ.slice(), max: this.max.slice(), ended: this.ended, startF: this.startF, gf: this.gf }; };
  Tracker.prototype.importState = function (st) {
    if (!st || !Array.isArray(st.occ) || !Array.isArray(st.max) || st.occ.length !== NS || st.max.length !== NS) return false;
    this.armed = !!st.armed; this.inGame = !!st.inGame; this.occ = st.occ.map(x => x ? 1 : 0); this.max = st.max.map(x => Math.max(0, Math.min(SCORE_MAX, x | 0)));
    this.ended = st.ended | 0; this.startF = st.startF | 0; this.gf = st.gf | 0; return true;
  };
  // current max scores of occupied slots, without ending the game. null if this tracker is not in a running game (never started, or already ended).
  Tracker.prototype.current = function () { return this.inGame ? { scores: this.scores(), startF: this.startF } : null; };
  // one confirmed frame f (work RAM after it). Returns { scores: [{slot, score}], startF } once, on the frame that leaves game mode after a full game seen.
  Tracker.prototype.observe = function (w, f) {
    if (!w || w.length < 0x200) return null;
    if (w[A_MODE] !== 2) {
      const was = this.inGame; this.inGame = false;
      if (was && w[A_MODE] !== 1) { this.occ = [0, 0, 0, 0]; this.max = [0, 0, 0, 0]; this.armed = true; return null; } // left game mode for the service / test screen or a reset: not a game over
      if (was) { const res = { scores: this.scores(), startF: this.startF }; this.ended++; this.occ = [0, 0, 0, 0]; this.max = [0, 0, 0, 0]; this.armed = true; return res; }
      this.armed = true; return null;
    }
    if (!this.inGame) { if (!this.armed && !POLICY.trackerMayStartMidGame) return null; this.inGame = true; this.occ = [0, 0, 0, 0]; this.max = [0, 0, 0, 0]; this.startF = f | 0; this.gf = 0; }
    this.gf++;
    for (let s = 0; s < NS; s++) {
      const b = BASE + STRIDE * s;
      if (w[b + A_LIVES] || w[b + A_STATE] === 2) this.occ[s] = 1;
      if (this.gf <= GRACE) continue; // stale scores of the previous game
      const v = bcd16(w, b + A_SCORE);
      if (v > 0) this.occ[s] = 1;
      if (v > this.max[s] && v <= SCORE_MAX) this.max[s] = v;
    }
    return null;
  };

  const done = new Set();            // match ids already reported by this page: ONE report per match_id (a different body from the same peer would be 409)
  const ev = [];                     // test / debug log of what happened
  const note = (type, info) => { const e = Object.assign({ type, at: Date.now() }, info || {}); ev.push(e); if (ev.length > 50) ev.shift(); try { console.log('[tmnt-score]', type, info ? JSON.stringify(info) : ''); } catch (x) {} return e; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const enabled = () => typeof location !== 'undefined' && location.protocol !== 'app:';

  // POST once, retrying the IDENTICAL body (0 / 1.5 / 5 s) on network errors / 429 / 5xx (safe: the Worker is idempotent); 4xx is final. Never throws.
  async function post(url, body) {
    const text = JSON.stringify(body); let last = '';
    for (const wait of API.RETRY_MS) {
      if (wait) await sleep(wait);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, cache: 'no-store', keepalive: true });
        let j = null; try { j = await r.json(); } catch (e) {}
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) { const status = j && (j.status || j.error) || ('HTTP ' + r.status); return { ok: r.ok, http: r.status, status }; }
        last = 'HTTP ' + r.status;
      } catch (e) { last = (e && e.message) || 'network'; }
    }
    return { ok: false, http: 0, status: 'failed', error: last };
  }

  // slots still connected at this moment and seated before the game started (rollback roster). null = session has no roster (unit stubs): do not filter.
  // A guest that left is omitted (leave != INF); a slot (re)seated AFTER the game began (join frame > first game frame) is a mid-match joiner: omitted too.
  function seatedSlots(s, startF) {
    const rb = s && s.rb, j = rb && rb.join, lv = rb && rb.leave;
    if (!j || !lv) return null;
    const out = [];
    for (let sl = 0; sl < NS; sl++) if (j[sl] !== SEAT_INF && lv[sl] === SEAT_INF && POLICY.slotCountsInReport(j[sl], startF)) out.push(sl);
    return out;
  }

  // Roster as plain JSON (join / leave frame per slot) for the same future use as Tracker.exportState(); NOT used today.
  function rosterState(s) { const rb = s && s.rb; return rb && rb.join && rb.leave ? { join: Array.prototype.slice.call(rb.join, 0, NS), leave: Array.prototype.slice.call(rb.leave, 0, NS) } : null; }

  function finish(s, ctx, res) {
    const c = ctx() || {}, t = c.t, mid = t && t.match_id;
    if (!t || !MATCH_RE.test(mid || '')) return note('skip', { why: 'no match_id (not the Cloudflare Worker)' });
    if (s.spec || s.wasSpec || s.watch === true) return note('skip', { why: 'spectator' });
    const role = s.role === 'host' ? 'host' : 'guest', slot = role === 'host' ? 0 : s.slot;
    if (!(slot >= 0 && slot < NS)) return note('skip', { why: 'no player slot' });
    const seated = seatedSlots(s, res.startF);
    const alive = seated ? res.scores.filter(x => seated.indexOf(x.slot) >= 0) : res.scores;
    if (alive.length < 2) return note('skip', { why: 'fewer than 2 players still connected', n: alive.length });
    if (!alive.some(x => x.slot === slot)) return note('skip', { why: 'my slot did not play', slot });
    // nick always comes from the session roster (Session.names(), already exchanged in hello / {t:'nick'} / who.pl)
    const names = typeof s.names === 'function' ? s.names() : [];
    const nickAt = (sl, fallback) => {
      const raw = names[sl] != null && String(names[sl]) !== '' ? names[sl] : (fallback || '');
      return boardNickOf(raw, sl);
    };
    const nick = nickAt(slot, c.nick);
    if (done.has(mid)) return note('skip', { why: 'already reported', match_id: mid });
    done.add(mid);
    const scores = alive.map(x => ({ slot: x.slot, score: x.score, nick: nickAt(x.slot, x.slot === slot ? c.nick : '') }));
    const body = { game: GAME, match_id: mid, room: String(t.room || c.room || '').toUpperCase(), peer_id: t.id, role, nick, my_slot: slot, scores };
    const url = API.url(t, c);
    note('report', { body });
    post(url, body).then(r => note('result', r), e => note('result', { ok: false, status: 'error', error: String(e && e.message || e) }));
  }

  // If the host leaves mid-match, treat that as the end: report the last CONFIRMED max scores (the host's last confirmed
  // frame is what every guest has been observing, so their numbers agree). Include the host's slot (the host never gets a
  // leave frame on the roster: the session just ends). Do nothing if the match already ended normally (mode 2 -> 1 already
  // reported, or tracker not in a game). A guest clicking leave does not call this.
  function flushOnHostLeft(s, ctx, tr) {
    if (!s || !tr) return note('skip', { why: 'host left but no tracker' });
    if (s.spec || s.wasSpec || s.watch === true) return note('skip', { why: 'spectator' });
    if (!tr.inGame) return note('skip', { why: 'host left, no match in progress' });
    const res = tr.current();
    if (!res || !res.scores.length) return note('skip', { why: 'host left, no match in progress' });
    note('gameover', { frame: s.rb && s.rb.confirmed, scores: res.scores, why: 'host-left' });
    try { return finish(s, ctx, res); } catch (e) { return note('error', { error: String(e && e.message || e) }); }
  }

  // attach(session, ctx): ctx() -> { t: transport, room, signal: signaling URL in use, nick: the player's normal nick }. Players (host / guest) of a Worker match only.
  function attach(s, ctx) {
    if (!enabled() || !s) return null;
    const tr = new Tracker();
    s.onConfirmed = (f, snap) => { const res = tr.observe(snap && snap.wram, f); if (res) { note('gameover', { frame: f, scores: res.scores }); try { finish(s, ctx, res); } catch (e) { note('error', { error: String(e && e.message || e) }); } } };
    // guests: hostgone arrives while the session and ctx() transport are still intact (ui.js endSession runs after this)
    const prev = s.ev;
    s.ev = e => { if (e && e.t === 'hostgone') { try { flushOnHostLeft(s, ctx, tr); } catch (err) { note('error', { error: String(err && err.message || err) }); } } if (typeof prev === 'function') prev(e); };
    // host: 'Sair da sala' / TMNTNETPLAY.leave() calls this before endSession, inside the existing leave wait
    s.flushScore = () => flushOnHostLeft(s, ctx, tr);
    s.hsTracker = tr;
    return tr;
  }
  const API = {
    GAME, NS, SCORE_MAX, MATCH_RE, SEAT_INF, GRACE, POLICY, rosterState, bcd16, fold, boardNickOf, seatedSlots, Tracker, attach, post, finish, flushOnHostLeft, events: ev, done,
    RETRY_MS: [0, 1500, 5000],
    // same Worker that issued the match_id (the signaling URL actually in use; ?signal= overrides it), path /scores/report
    url: (t, c) => { try { return new URL((c && c.signal) || (G.TMNTNET && G.TMNTNET.DEFAULT_SIGNAL) || '').origin + '/scores/report'; } catch (e) { return 'https://games4me-netplay.games4me.workers.dev/scores/report'; } },
    ADDR: { mode: 0x60001, slot0: 0x60100, stride: STRIDE, lives: A_LIVES, score: A_SCORE, state: A_STATE },
  };
  if (NODE) module.exports = API; else G.TMNTHS = API;
})(typeof window !== 'undefined' ? window : globalThis);
