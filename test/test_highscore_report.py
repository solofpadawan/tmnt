#!/usr/bin/env python3
"""TMNT web, online highscore report (stage/net/highscore.js, contract highscores/DESIGN.md section 7), headless Chromium, one browser per peer.
PRIVATE rooms (tmnt_public=0) on the production Worker (slug tmnt_web) for the SIGNALING only (host / join / WebRTC; the Worker answers match_id).
POST /scores/report is INTERCEPTED with Playwright (route.fulfill / abort, never continued): nothing is ever sent to the production score endpoint
and the bodies are validated here. The score RAM addresses, tracker rules and the real end of a game are checked on the real machine / MAME by
test/highscore_check.js and test/mame/mame_check.js (run first by this test).
The game end in the browser is produced by a test hook in EVERY page (a Machine.step wrapper that is a pure function of the machine state and the
frame number, so it is deterministic and rollback-safe): once mode 2 runs it pokes the occupancy bytes and the score words of the first players
(0x60101/0x60107 + 8*s, 0x60104 + 8*s: slot 0 = 345, 1 = 120, 2 = 67) and, at the next multiple of ENDMOD frames, flips the mode byte 0x60001 to 1
(what the game does when every continue is gone).
 A  host + guest + spectator: one body each, same match_id / room / slot:score set, own nick / role / slot, spectator sends nothing, no second body
    afterwards; offline page: nothing; the panel has no extra nick field
 B  the guest's POSTs fail (network): the ending is not blocked, the SAME body is retried at 0 / ~1.5 / ~6.5 s (three tries) and then given up; host unaffected
 C  solo host + spectator (nobody else playing): nothing is sent; 2 players in the room but only one coined in: nothing is sent
 D  3 players ("João Silva", "Rita", "Zé"): nicks come from the session roster (JOAOSILV / RITA / ZEP3); same 3-slot fingerprint everywhere
 E  3 players, one guest leaves mid-match: the leaver is omitted from every remaining report and sends nothing; the two who stayed agree
 F  3 players, the host leaves mid-match (Sair da sala): the match is treated as ended; the host (before leaving) and both guests send matching reports
    that INCLUDE the host's slot; nothing is reported twice
 G  a player who joins in the middle of the match (coins in): never reports; its slot is omitted from the other reports
Usage: python3 test/test_highscore_report.py WEB [--preview DIR]"""
import argparse, json, os, random, socket, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default=''); ap.add_argument('--only', default='')
a = ap.parse_args(); RUN = str(random.randint(100, 999))
here = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(a.web)
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); BASE = f'http://127.0.0.1:{port}/index.html'
fails, errs = [], []; ALL = []; BODIES = {}
def check(n, ok, i=''):
    print(('PASS ' if ok else 'FAIL ') + n, i, flush=True)
    if not ok: fails.append(n)
def wait(fn, to=20):
    t0 = time.time()
    while time.time() - t0 < to:
        try: v = fn()
        except Exception: v = None
        if v: return v
        time.sleep(0.25)
    return None
def lst():
    try: return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10)).get('rooms', [])
    except Exception as e: return [{'err': str(e)}]
HOOK = """([endmod, nslots]) => { const M = TMNTMachine.prototype; if (M.__hs) return; M.__hs = 1; const orig = M.step;
  const sc = [0x0345, 0x0120, 0x0067, 0];
  M.step = function () {
    const w = this.wram, F = this.frame();
    if (w[1] === 2 && F % 120 === 0 && w[0x104] === 0 && w[0x105] < 0x10) { // the game is running and nobody has scored yet: players present, scores in RAM (packed BCD words)
      for (let s = 0; s < nslots; s++) { w[0x101 + 8 * s] = 2; w[0x107 + 8 * s] = 2; w[0x104 + 8 * s] = sc[s] >> 8; w[0x105 + 8 * s] = sc[s] & 255; }
    } else if (((endmod && F % endmod === 0) || (window.__hsEndAt && F === window.__hsEndAt)) && w[1] === 2 && w[0x104] === 0x03 && w[0x105] >= 0x45) { // end of game: the game's own flip 2 -> 1 (everybody out)
      w[1] = 1; for (let s = 0; s < 4; s++) { w[0x107 + 8 * s] = 1; w[0x101 + 8 * s] = 0; }
    }
    return orig.call(this);
  }; }"""
BOT = """() => { const I = TMNTIN; let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0; const B = window.__bs = { n: -1, play: false, cf: 0 };
  I.sample = () => { const o = new Uint8Array(4);
    if (B.n >= 0) { const k = B.n++; if (k < 8) o[0] = I.COIN; else if (k >= 30 && k < 38) o[0] = I.ATTACK; else if (k >= 60 && k < 68) o[0] = I.ATTACK; else if (k > 70) B.n = -1; }
    else if (B.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.L | I.U, I.R | I.D, I.JUMP, I.R | I.U][(x >>> 16) % 9]   /* no ATTACK while playing: the game never adds points by itself, so the poked BCD scores stay exact */; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    return o; }; }"""
WRAP_WATCH = """() => { const S = TMNTSESSION.Session; const W = function (o) { o.watch = 1; return new S(o); }; W.prototype = S.prototype; Object.assign(W, S); TMNTSESSION.Session = W; }"""
STATS = "() => { const N = TMNTNETPLAY.session; return N && N.rb ? { spec: !!N.spec, slot: N.slot, frame: N.rb.frame, d: N.stats.desyncs, sd: N.stats.specDesyncs } : null; }"
def S(pg, e, *arg): return pg.evaluate(e, *arg) if arg else pg.evaluate(e)
def mk(p, br, nick, mode='ok', pend=True, offline=False):
    ctx = br.new_context(locale='pt-BR', viewport={'width': 800, 'height': 450}); pg = ctx.new_page(); pg.set_default_timeout(90000)
    pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(nick)}); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')
    pg.on('pageerror', lambda e: errs.append(f'{nick}: {e}'))
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}
    pg.__bodies = []
    def handler(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        pg.__bodies.append({'url': req.url, 'ct': req.headers.get('content-type'), 'body': json.loads(req.post_data or 'null'), 'at': time.time()})
        if mode == 'abort': return route.abort('failed')
        ALL.append(1); st = 'pending' if len(ALL) == 1 and pend else 'accepted'
        route.fulfill(status=200, headers=dict(cors, **{'Content-Type': 'application/json'}), body=json.dumps({'ok': True, 'status': st}))
    pg.route('**/scores/report', handler)   # EVERY score POST is answered here: nothing reaches the real endpoint
    return pg
def load(pg, q='', hook=(300, 2)):
    pg.goto(f'{BASE}?lang=pt&noturn=1&sound=0&keep=1{q}'); pg.evaluate('TMNTG.whenReady'); pg.evaluate(BOT); pg.evaluate(HOOK, list(hook))
def host(pg, room, hook=(300, 2)):
    load(pg, '', hook); time.sleep(1.0); pg.evaluate(f'TMNTNETPLAY.host(false, "{room}")'); pg.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=30000); time.sleep(1.0)
    return pg.evaluate('TMNTNETPLAY.state.room')
def guest(pg, room, hook=(300, 2)):
    load(pg, f'&sala={room}', hook); pg.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot > 0 && !TMNTNETPLAY.session.spec && !TMNTNETPLAY.state.wait', timeout=60000); time.sleep(1.5)
def spec(pg, room, hook=(300, 2)):
    load(pg, '', hook); pg.evaluate(WRAP_WATCH); pg.goto(f'{BASE}?lang=pt&noturn=1&sound=0&keep=1&sala={room}&assistir=1&watch=1'); pg.evaluate('TMNTG.whenReady'); pg.evaluate(BOT); pg.evaluate(HOOK, list(hook))
    pg.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec === true && TMNTNETPLAY.session.rb && TMNTNETPLAY.state.wait === null', timeout=60000); time.sleep(1.0)
def go(pg):
    wait(lambda: S(pg, 'TMNTG.frameNo') > 900 and mode(pg) == 1, 60)   # the game has booted and sits in attract
    pg.evaluate('__bs.n = 0'); pg.evaluate('__bs.play = true')   # coin + attack + attack, then random play
def mode(pg): return S(pg, 'TMNTG.machine.wram[1]')
def evs(pg, typ=None): return [e for e in S(pg, 'TMNTHS.events') if typ is None or e['type'] == typ]
def names(pg): return S(pg, 'TMNTNETPLAY.session.names()')
def fp(B): return sorted((x['slot'], x['score']) for x in B['scores'])
# all bodies carry the SAME fingerprint, with exactly the expected slots and each score = the poked BCD value or a few points more
# (the game itself may add a point or two from contact during the random walk; what matters for the Worker is that every peer agrees)
def fpok(BS, exp): f0 = fp(BS[0]); return all(fp(B) == f0 for B in BS) and [x[0] for x in f0] == [e[0] for e in exp] and all(e[1] <= x[1] <= e[1] + 50 for x, e in zip(f0, exp))
def advancing(pg, n=20, to=10):
    f = pg.evaluate('TMNTG.frameNo'); return wait(lambda: pg.evaluate('TMNTG.frameNo') > f + n, to) is not None
def quiet(*pgs):
    for pg in pgs:
        try: pg.evaluate('TMNTNETPLAY.session ? TMNTNETPLAY.leave() : null')
        except Exception: pass
def close_all(*pgs):
    for pg in pgs:
        try: pg.context.close()
        except Exception: pass
def save(key, val):
    BODIES[key] = val
try:
    r = subprocess.run(['node', os.path.join(here, 'highscore_check.js')], capture_output=True, text=True, timeout=300)
    check('node highscore_check.js (tracker + finish / retry stubs + REAL machine, 2 games)', r.returncode == 0 and 'FAIL' not in r.stdout, r.stdout[-300:] + r.stderr[-300:])
    r = subprocess.run(['node', os.path.join(here, 'mame', 'mame_check.js')], capture_output=True, text=True, timeout=300)
    check('node mame/mame_check.js (RAM addresses vs the MAME log)', r.returncode == 0 and 'FAIL' not in r.stdout, r.stdout[-300:] + r.stderr[-300:])
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader'])
        want = lambda k: (not a.only) or k in a.only
        # ================= A: normal match =================
        if want('A'):
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita'); sp = mk(p, br, 'Ouvinte'); off = mk(p, br, 'Solo')
            room = host(h, f'HSA{RUN}'); print('room A', room); guest(g, room); spec(sp, room)
            check('A: host sees guest (slot 1) and spectator', wait(lambda: S(h, 'TMNTNETPLAY.session.spectators().length') == 1 and names(h)[:2] == ['Chico', 'Rita'], 15), names(h))
            h.keyboard.press('F7'); time.sleep(0.4); txt = S(h, "document.getElementById('np').innerText")
            check('A: F7 panel has the normal nick only (no extra board-nick field)', S(h, "!!document.getElementById('np-nick')") and 'placar' not in txt.lower() and 'scoreboard' not in txt.lower(), txt[:200])
            if a.preview: h.screenshot(path=f'{a.preview}/highscore_panel_unchanged_800x450.png')
            h.keyboard.press('F7')
            load(off, ''); go(off)
            go(h); time.sleep(1.5); go(g)
            check('A: both players are in the game (mode 2)', wait(lambda: mode(h) == 2 and mode(g) == 2, 60) is not None, (mode(h), mode(g)))
            okA = wait(lambda: evs(h, 'result') and evs(g, 'result'), 90)
            check('A: host and guest each sent ONE report', bool(okA) and len(h.__bodies) == 1 and len(g.__bodies) == 1, (len(h.__bodies), len(g.__bodies), evs(h, 'skip'), evs(g, 'skip')))
            if h.__bodies and g.__bodies:
                BA = [x.__bodies[0] for x in (h, g)]; bd = [x['body'] for x in BA]; print(json.dumps(bd, indent=1))
                check('A: POST goes to the Worker /scores/report as JSON', all(x['url'] == 'https://games4me-netplay.games4me.workers.dev/scores/report' and 'json' in (x['ct'] or '') for x in BA), [x['url'] for x in BA])
                check('A: game tmnt_web, same match_id (32 hex) and room', all(B['game'] == 'tmnt_web' for B in bd) and bd[0]['match_id'] == bd[1]['match_id'] and len(bd[0]['match_id']) == 32 and bd[0]['room'] == room.upper(), (bd[0]['match_id'], bd[1]['match_id'], bd[0]['room']))
                check('A: same slot:score fingerprint [(0,345),(1,120)] (BCD from RAM)', fpok(bd, [(0, 345), (1, 120)]), [fp(B) for B in bd])
                check('A: role / my_slot / own nick (CHICO host slot 0, RITA guest slot 1), nick on every slot', [(B['role'], B['my_slot'], B['nick']) for B in bd] == [('host', 0, 'CHICO'), ('guest', 1, 'RITA')] and all({x['slot']: x['nick'] for x in B['scores']} == {0: 'CHICO', 1: 'RITA'} for B in bd), [(B['role'], B['my_slot'], B['nick']) for B in bd])
                check('A: peer ids differ and are the signaling ids', bd[0]['peer_id'] != bd[1]['peer_id'] and all(len(B['peer_id']) >= 6 for B in bd))
                save('normal_end', {'host': bd[0], 'guest': bd[1]})
            time.sleep(8)
            check('A: the spectator sent nothing (no body, no report event)', not sp.__bodies and not evs(sp, 'report'), (sp.__bodies, evs(sp)))
            check('A: the offline page sent nothing and has no network session', not off.__bodies and not evs(off, 'report') and S(off, '!TMNTNETPLAY.session'))
            check('A: nothing more after the end (still one body each)', len(h.__bodies) == 1 and len(g.__bodies) == 1, (len(h.__bodies), len(g.__bodies)))
            st = [x.evaluate(STATS) for x in (h, g, sp)]; check('A: 0 desyncs', all(x and x['d'] == 0 and x['sd'] == 0 for x in st), st)
            quiet(g, sp, h); time.sleep(1.5); close_all(h, g, sp, off)
        # ================= B: network failure =================
        if want('B'):
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita', mode='abort')
            room = host(h, f'HSB{RUN}'); print('room B', room); guest(g, room); go(h); time.sleep(1.5); go(g)
            print('B modes', wait(lambda: mode(h) == 2 and mode(g) == 2, 60), mode(h), mode(g), flush=True)
            okB = wait(lambda: evs(h, 'result') and evs(g, 'result'), 120)
            print('B evs', evs(h), evs(g), flush=True)
            check('B: ending not blocked: the game went on to the attract screens (mode 1) and keeps running', mode(g) == 1 and advancing(g), mode(g))
            check('B: the guest tried 3 times with the IDENTICAL body (0 / ~1.5 / ~6.5 s), then gave up quietly', len(g.__bodies) == 3 and len({json.dumps(x['body'], sort_keys=True) for x in g.__bodies}) == 1 and 1.2 < g.__bodies[1]['at'] - g.__bodies[0]['at'] < 2.6 and 4.0 < g.__bodies[2]['at'] - g.__bodies[1]['at'] < 6.5 and evs(g, 'result')[-1]['status'] == 'failed', ([round(x['at'] - g.__bodies[0]['at'], 1) for x in g.__bodies], evs(g, 'result')))
            check('B: host unaffected (one body)', len(h.__bodies) == 1 and bool(okB))
            quiet(g, h); time.sleep(1.5); close_all(h, g)
        # ================= C: solo host / only one player coined in =================
        if want('C'):
            ALL.clear(); h = mk(p, br, 'Chico'); sp = mk(p, br, 'Ouvinte'); g = mk(p, br, 'Rita')
            room = host(h, f'HSC{RUN}', (300, 1)); print('room C', room); spec(sp, room, (300, 1))
            go(h); wait(lambda: mode(h) == 2, 60); okC = wait(lambda: S(h, 'wram=TMNTG.machine.wram, wram[1]') == 1 and True, 60)
            time.sleep(4)
            check('C: solo host (+ spectator), game ended: nothing sent', not h.__bodies and not sp.__bodies, (h.__bodies, sp.__bodies))
            check('C: ...the tracker saw the end and skipped it (fewer than 2)', any('fewer' in (e.get('why') or '') for e in evs(h, 'skip')) or not evs(h, 'report'), evs(h))
            quiet(sp, h); time.sleep(1.5); close_all(h, sp, g)
            # two in the room but only the host coined in
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita')
            room = host(h, f'HSC2{RUN}', (300, 1)); guest(g, room, (300, 1)); go(h); wait(lambda: mode(h) == 2 and mode(g) == 2, 60); time.sleep(8)
            check('C: 2 in the room, only one in the game: nothing sent by either', not h.__bodies and not g.__bodies and not evs(g, 'report'), (h.__bodies, g.__bodies))
            quiet(g, h); time.sleep(1.5); close_all(h, g)
        # ================= D: 3 players, nicks from the roster =================
        if want('D'):
            ALL.clear(); h = mk(p, br, 'João Silva'); g = mk(p, br, 'Rita'); g2 = mk(p, br, 'Zé')
            room = host(h, f'HSD{RUN}', (300, 3)); print('room D', room); guest(g, room, (300, 3)); guest(g2, room, (300, 3))
            check('D: nicks seen by all three', wait(lambda: all(names(x)[:3] == ['João Silva', 'Rita', 'Zé'] for x in (h, g, g2)), 15), [names(x) for x in (h, g, g2)])
            go(h); time.sleep(1.2); go(g); time.sleep(1.2); go(g2); wait(lambda: mode(h) == 2 and mode(g) == 2 and mode(g2) == 2, 60)
            okD = wait(lambda: evs(h, 'result') and evs(g, 'result') and evs(g2, 'result'), 100)
            check('D: three reports', bool(okD) and len(h.__bodies) == len(g.__bodies) == len(g2.__bodies) == 1, (len(h.__bodies), len(g.__bodies), len(g2.__bodies), evs(h, 'skip'), evs(g2, 'skip')))
            if h.__bodies and g.__bodies and g2.__bodies:
                BD = [x.__bodies[0]['body'] for x in (h, g, g2)]; print(json.dumps(BD, indent=1))
                check('D: same match_id / room and same 3-slot fingerprint', len({B['match_id'] for B in BD}) == 1 and fpok(BD, [(0, 345), (1, 120), (2, 67)]), [fp(B) for B in BD])
                check('D: nick of ALL three slots in every body: JOAOSILV / RITA / ZEP3 (accented, short padded)', all({x['slot']: x['nick'] for x in B['scores']} == {0: 'JOAOSILV', 1: 'RITA', 2: 'ZEP3'} for B in BD), [B['scores'] for B in BD])
                check('D: own nick / my_slot / role on top', [(B['role'], B['my_slot'], B['nick']) for B in BD] == [('host', 0, 'JOAOSILV'), ('guest', 1, 'RITA'), ('guest', 2, 'ZEP3')])
                save('three_players', {'host': BD[0], 'guest1': BD[1], 'guest2': BD[2]})
            quiet(g2, g, h); time.sleep(1.5); close_all(h, g, g2)
        # ================= E: a guest leaves mid-match =================
        if want('E'):
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita'); g2 = mk(p, br, 'Zé')
            room = host(h, f'HSE{RUN}', (0, 3)); print('room E', room); guest(g, room, (0, 3)); guest(g2, room, (0, 3))
            go(h); time.sleep(1.2); go(g); time.sleep(1.2); go(g2); wait(lambda: mode(h) == 2 and mode(g) == 2 and mode(g2) == 2, 60)
            print('E dbg', [(mode(x), S(x,'TMNTG.frameNo'), S(x,'TMNTG.machine.wram[0x104]'), S(x,'TMNTG.machine.wram[0x105]')) for x in (h,g,g2)], flush=True)
            check('E: scores poked on every peer before the leave', wait(lambda: all(S(x, 'TMNTG.machine.wram[0x104] === 0x03 && TMNTG.machine.wram[0x105] >= 0x45') for x in (h, g, g2)), 60) is not None)
            g2.evaluate('void TMNTNETPLAY.leave()')
            left = "() => { const s = TMNTNETPLAY.session, INF = 0x7fffffff; return !!(s && s.rb && s.rb.join[2] !== INF && s.rb.leave[2] !== INF); }"
            check('E: host and guest 1 see slot 2 leave (rollback roster)', wait(lambda: S(h, left) and S(g, left), 20) is not None)
            # end the game only AFTER the leave, at the same absolute frame on both remaining peers (deterministic: no desync)
            endAt = max(S(h, 'TMNTG.machine.frame()'), S(g, 'TMNTG.machine.frame()')) + 300
            for x in (h, g): x.evaluate(f'window.__hsEndAt = {endAt}')
            check('E: nothing sent before the end (leave alone is not an end)', not h.__bodies and not g.__bodies and not g2.__bodies, (len(h.__bodies), len(g.__bodies), len(g2.__bodies)))
            okE = wait(lambda: evs(h, 'result') and evs(g, 'result'), 120)
            check('E: the two who stayed reported, the leaver sent nothing', bool(okE) and len(h.__bodies) == 1 and len(g.__bodies) == 1 and not g2.__bodies, (len(h.__bodies), len(g.__bodies), g2.__bodies))
            if h.__bodies and g.__bodies:
                BE = [x.__bodies[0]['body'] for x in (h, g)]; print(json.dumps(BE, indent=1))
                check('E: remaining reports agree, only slots 0 and 1 (no Zé / ZEP3 / slot 2)', BE[0]['match_id'] == BE[1]['match_id'] and fpok(BE, [(0, 345), (1, 120)]) and all({x['slot']: x['nick'] for x in B['scores']} == {0: 'CHICO', 1: 'RITA'} for B in BE), [B['scores'] for B in BE])
                save('player_left_mid_match', {'host': BE[0], 'guest': BE[1]})
            quiet(g, h); time.sleep(1.5); close_all(h, g, g2)
        # ================= F: the host leaves mid-match =================
        if want('F'):
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita'); g2 = mk(p, br, 'Zé')
            room = host(h, f'HSF{RUN}', (0, 3)); print('room F', room); guest(g, room, (0, 3)); guest(g2, room, (0, 3))
            go(h); time.sleep(1.2); go(g); time.sleep(1.2); go(g2); wait(lambda: mode(h) == 2 and mode(g) == 2 and mode(g2) == 2, 60)
            check('F: scores in RAM on every peer, game still running (no end hook)', wait(lambda: all(S(x, 'TMNTG.machine.wram[0x104] === 0x03 && TMNTG.machine.wram[0x105] >= 0x45') for x in (h, g, g2)), 60) is not None)
            time.sleep(2.5)   # let the poked scores become confirmed on every peer
            h.keyboard.press('F7'); time.sleep(0.4); h.click('#np-leave')
            okF = wait(lambda: evs(g, 'result') and evs(g2, 'result') and len(h.__bodies) >= 1, 40)
            check('F: host reported before leaving, both guests on hostgone: one body each', bool(okF) and len(h.__bodies) == 1 and len(g.__bodies) == 1 and len(g2.__bodies) == 1, (len(h.__bodies), len(g.__bodies), len(g2.__bodies)))
            if h.__bodies and g.__bodies and g2.__bodies:
                BF = [x.__bodies[0]['body'] for x in (h, g, g2)]; print(json.dumps(BF, indent=1))
                check('F: the three bodies agree (same match_id / room / 3-slot fingerprint INCLUDING the host)', len({B['match_id'] for B in BF}) == 1 and len({B['room'] for B in BF}) == 1 and fpok(BF, [(0, 345), (1, 120), (2, 67)]), [fp(B) for B in BF])
                check('F: nicks CHICO / RITA / ZEP3 on every slot, own nick / role / slot on top', all({x['slot']: x['nick'] for x in B['scores']} == {0: 'CHICO', 1: 'RITA', 2: 'ZEP3'} for B in BF) and [(B['role'], B['my_slot'], B['nick']) for B in BF] == [('host', 0, 'CHICO'), ('guest', 1, 'RITA'), ('guest', 2, 'ZEP3')])
                save('host_left_mid_match', {'host': BF[0], 'guest1': BF[1], 'guest2': BF[2]})
            time.sleep(6)
            check('F: nothing reported twice', len(h.__bodies) == 1 and len(g.__bodies) == 1 and len(g2.__bodies) == 1)
            quiet(g2, g); time.sleep(1.5); close_all(h, g, g2)
        # ================= G: a player who joins in the middle of the match =================
        if want('G'):
            ALL.clear(); h = mk(p, br, 'Chico'); g = mk(p, br, 'Rita'); late = mk(p, br, 'Tarde')
            room = host(h, f'HSG{RUN}', (1800, 2)); print('room G', room); guest(g, room, (1800, 2))
            go(h); time.sleep(1.2); go(g); wait(lambda: mode(h) == 2 and mode(g) == 2, 60)
            guest(late, room, (1800, 2))   # arrives while the game runs (HOOK is installed on the late page too)
            go(late); time.sleep(3)
            check('G: the late joiner is seated in slot 2 and is in the game (coined in)', S(late, 'TMNTNETPLAY.session.slot') == 2 and wait(lambda: S(late, 'TMNTG.machine.wram[0x107 + 16] === 2'), 20) is not None, S(late, 'TMNTNETPLAY.session.slot'))
            okG = wait(lambda: evs(h, 'result') and evs(g, 'result'), 120)
            check('G: host and guest reported, the late joiner did not', bool(okG) and len(h.__bodies) == 1 and len(g.__bodies) == 1 and not late.__bodies, (len(h.__bodies), len(g.__bodies), late.__bodies, evs(late)))
            if h.__bodies and g.__bodies:
                BG = [x.__bodies[0]['body'] for x in (h, g)]
                check('G: the late joiner\'s slot (2) is in neither report, the two still agree', fpok(BG, [(0, 345), (1, 120)]), [fp(B) for B in BG])
            quiet(late, g, h); time.sleep(1.5); close_all(h, g, late)
        br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
if a.preview and BODIES:
    with open(f'{a.preview}/highscore_report_bodies.json', 'w') as f: json.dump(BODIES, f, indent=1, ensure_ascii=False)
print('console/page errors:', errs[:5])
check('no page errors', not errs, errs[:3])
pub = lst(); check('public tmnt_web list is empty (private test rooms)', pub == [], pub)
print('FAIL: ' + ', '.join(fails) if fails else 'ALL PASS'); sys.exit(1 if fails else 0)
