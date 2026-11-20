#!/usr/bin/env python3
"""TMNT web, "Sair da sala" for PLAYERS and the HOST (playerleave build), PRIVATE rooms on the production Worker (slug tmnt_web), headless Chromium, multi-browser.
 A) 4-player-capable room: host + guest1 + guest2 + spectator. guest1 leaves mid-game -> guest1's page reloads with a clean URL (other params kept), fresh game, no
    session, F7 closed; host / guest2 / spectator never reload, keep running (frames advance), see slot 1 freed ('left' event, rb.leave[1]), 0 desyncs; the Worker
    room stays.
 B) host + guest + spectator. The HOST leaves -> host's page reloads (clean URL); the Worker room disappears; guest and spectator follow the EXISTING path
    (session ended in place with the 'host gone' message, no reload) and are exactly as they are in the previous build.
 C) idle-close path (host idle) is NOT a reload (covered by test_idle_close.py).
--before: run against the PREVIOUS build (expects the leaver NOT to reload) to show the others behave identically (before/after).
Exit 0 only if everything passes, 0 desyncs, and the public tmnt_web list is empty at the end.
Usage: python3 test/test_player_leave.py WEB [--preview DIR] [--before] [--out file.json]"""
import argparse, json, os, random, socket, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default=''); ap.add_argument('--before', action='store_true'); ap.add_argument('--out', default='')
a = ap.parse_args()
RELOAD = not a.before
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
ROOT = os.path.abspath(a.web); PREV = a.preview or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'previews')
os.makedirs(PREV, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'
TAG = 'before' if a.before else 'after'
RA, RB = f'PLA-{random.randint(10000, 99999)}', f'PLB-{random.randint(10000, 99999)}'
fails, errs, out = [], [], {}
def check(n, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + n, info, flush=True)
    if not ok: fails.append(n if not info else f'{n}: {info}')
def lst():
    try: return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10)).get('rooms', [])
    except Exception as e: return [{'err': str(e)}]
def wait(fn, to=20):
    t0 = time.time()
    while time.time() - t0 < to:
        try: v = fn()
        except Exception: v = None
        if v: return v
        time.sleep(0.2)
    return None
def openp(pg):
    if pg.evaluate("getComputedStyle(document.getElementById('np')).display") != 'block': pg.keyboard.press('F7'); time.sleep(0.5)
STATS = "() => { const N = TMNTNETPLAY.session; return N && N.rb ? { spec: !!N.spec, slot: N.slot, frame: N.rb.frame, d: N.stats.desyncs, sd: N.stats.specDesyncs, hc: N.stats.hashChecks, shc: N.stats.specHashChecks } : null; }"
LEFT = "() => TMNTNETPLAY.state.log.filter(e => e.t === 'left').length"
FREED = "(s) => { const N = TMNTNETPLAY.session; return !!(N && N.rb && N.rb.leave[s] !== 0x7fffffff && N.rb.leave[s] < 1e9); }"
def reloaded(pg, to=15):
    wait(lambda: (not pg.is_closed()) and pg.evaluate('typeof window.__marker') == 'undefined', to)
    for _ in range(40):
        try: pg.wait_for_load_state('load'); pg.evaluate('TMNTG.whenReady'); break
        except Exception: time.sleep(0.25)
    time.sleep(1.5)
try:
  with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader'])
    def page(nick, q='', lang='pt', vp=(800, 450)):
        ctx = br.new_context(locale='pt-BR', viewport={'width': vp[0], 'height': vp[1]})
        pg = ctx.new_page(); pg.set_default_timeout(90000)
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(nick)}); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, n=nick: errs.append(f'{n}: {e}'))
        pg.goto(f'{BASE}?lang={lang}&noturn=1&sound=0&keep=1{q}'); pg.evaluate('TMNTG.whenReady'); return pg
    def guest(nick, room): 
        g = page(nick, f'&sala={room}'); g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot > 0 && !TMNTNETPLAY.session.spec && !TMNTNETPLAY.state.wait', timeout=60000); return g
    def spec(nick, room):
        sp = page(nick, f'&sala={room}&assistir=1&watch=1'); sp.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec === true && TMNTNETPLAY.session.rb && TMNTNETPLAY.state.wait === null', timeout=60000); return sp
    def host(nick, room):
        h = page(nick); h.evaluate(f'TMNTNETPLAY.host(false, "{room}")'); h.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=30000); return h
    def advancing(pg, n=20, to=10):
        f = pg.evaluate('TMNTG.frameNo'); return wait(lambda: pg.evaluate('TMNTG.frameNo') > f + n, to) is not None
    def mark(*pgs):
        for i, pg in enumerate(pgs): pg.evaluate(f'window.__marker = {100 + i}')
    # ================= A) a GUEST leaves mid-game =================
    print('--- A) guest leaves (%s build) room %s (private)' % (TAG, RA), flush=True)
    H = host('Saulo', RA); G1 = guest('Jogador2', RA); G2 = guest('Jogador3', RA); S = spec('Ouvinte', RA)
    check('A: host has 2 guests + 1 spectator', wait(lambda: H.evaluate('TMNTNETPLAY.session.spectators().length') == 1 and H.evaluate('TMNTNETPLAY.session.links.filter(l => l.slot > 0 && !l.spec).length') == 2) is not None)
    time.sleep(6)  # mid-game
    check('A: everybody advancing before the leave', all(advancing(x) for x in (H, G1, G2, S)))
    st0 = [x.evaluate(STATS) for x in (H, G1, G2, S)]; check('A: 0 desyncs before', all(x and x['d'] == 0 and x['sd'] == 0 for x in st0), st0)
    mark(H, G1, G2, S); lh = H.evaluate(LEFT); g1slot = G1.evaluate('TMNTNETPLAY.session.slot')
    openp(G1); check('A: guest panel has the Sair da sala button', G1.evaluate("!!document.getElementById('np-leave')"))
    tl = time.time(); G1.click('#np-leave')
    if RELOAD:
        reloaded(G1); url = G1.url; print('guest URL after leaving:', url, flush=True); out['A_guest_url'] = url
        check('A: guest page reloaded (JS marker gone)', G1.evaluate('typeof window.__marker') == 'undefined')
        check('A: guest URL clean (no sala / room / assistir / watch)', not any(k + '=' in url for k in ('sala', 'room', 'assistir', 'watch')), url)
        check('A: other params kept (lang, noturn, sound, keep)', all(x in url for x in ('lang=pt', 'noturn=1', 'sound=0', 'keep=1')), url)
        check('A: guest fresh game, no session, F7 closed', G1.evaluate('!TMNTNETPLAY.session') and G1.evaluate("getComputedStyle(document.getElementById('np')).display") == 'none')
        check('A: guest fresh game runs', advancing(G1, 10, 8))
        G1.set_viewport_size({'width': 1280, 'height': 720}); time.sleep(0.8); G1.screenshot(path=os.path.join(PREV, f'playerleave_{TAG}_guest_after_1280x720.png'))
    else:
        time.sleep(4); check('A(before): guest page NOT reloaded', G1.evaluate('window.__marker') == 101)
    check('A: host saw the guest leave (left event) and slot %s freed' % g1slot, wait(lambda: H.evaluate(LEFT) > lh and H.evaluate(FREED, g1slot), 15) is not None, H.evaluate(LEFT))
    check('A: host links: only guest2 + spectator left', H.evaluate('TMNTNETPLAY.session.links.filter(l => l.slot > 0 && !l.spec).length') == 1 and H.evaluate('TMNTNETPLAY.session.spectators().length') == 1)
    check('A: guest2 and spectator see slot freed', wait(lambda: G2.evaluate(FREED, g1slot) and S.evaluate(FREED, g1slot), 15) is not None)
    time.sleep(3)
    check('A: host, guest2, spectator never reloaded', all(x.evaluate('typeof window.__marker') == 'number' for x in (H, G2, S)))
    check('A: host, guest2, spectator still in session and advancing', all(x.evaluate('!!TMNTNETPLAY.session && !!TMNTNETPLAY.session.rb') and advancing(x) for x in (H, G2, S)))
    st1 = [x.evaluate(STATS) for x in (H, G2, S)]; check('A: 0 desyncs after the leave (host, guest2, spectator)', all(x and x['d'] == 0 and x['sd'] == 0 for x in st1), st1)
    out['A_others_after'] = {'host_leftEvents': H.evaluate(LEFT) - lh, 'g2_slot': G2.evaluate('TMNTNETPLAY.session.slot'), 'spec_list': H.evaluate('TMNTNETPLAY.session.spectators().length')}
    # tear down room A (the host leaves too; with the new build it reloads, which is fine)
    for x in (G2, S, H):
        try: x.evaluate('TMNTNETPLAY.session ? TMNTNETPLAY.leave() : null')
        except Exception: pass
    time.sleep(3)
    # ================= B) the HOST leaves =================
    print('--- B) host leaves (%s build) room %s (private)' % (TAG, RB), flush=True)
    H = host('Saulo', RB); G = guest('Jogador2', RB); S = spec('Ouvinte', RB)
    check('B: host sees guest + spectator', wait(lambda: H.evaluate('TMNTNETPLAY.session.spectators().length') == 1 and H.evaluate('TMNTNETPLAY.session.links.filter(l => l.slot > 0 && !l.spec).length') == 1) is not None)
    time.sleep(6); check('B: everybody advancing before', all(advancing(x) for x in (H, G, S)))
    st0 = [x.evaluate(STATS) for x in (H, G, S)]; check('B: 0 desyncs before', all(x and x['d'] == 0 and x['sd'] == 0 for x in st0), st0)
    mark(H, G, S); openp(H); H.click('#np-leave')
    if RELOAD:
        reloaded(H); url = H.url; print('host URL after leaving:', url, flush=True); out['B_host_url'] = url
        check('B: host page reloaded (JS marker gone)', H.evaluate('typeof window.__marker') == 'undefined')
        check('B: host URL clean', not any(k + '=' in url for k in ('sala', 'room', 'assistir', 'watch')) and all(x in url for x in ('lang=pt', 'noturn=1')), url)
        check('B: host fresh game, no session, F7 closed', H.evaluate('!TMNTNETPLAY.session') and H.evaluate("getComputedStyle(document.getElementById('np')).display") == 'none')
        check('B: host fresh game runs', advancing(H, 10, 8))
        H.set_viewport_size({'width': 1280, 'height': 720}); time.sleep(0.8); H.screenshot(path=os.path.join(PREV, f'playerleave_{TAG}_host_after_1280x720.png'))
    else:
        time.sleep(4); check('B(before): host page NOT reloaded', H.evaluate('window.__marker') == 100)
    check('B: guest and spectator ended their session (existing hostgone path)', wait(lambda: G.evaluate('!TMNTNETPLAY.session') and S.evaluate('!TMNTNETPLAY.session'), 20) is not None)
    time.sleep(1)
    gm, sm = G.evaluate("document.getElementById('np').innerText"), S.evaluate("document.getElementById('np').innerText")
    out['B_guest_panel_text'] = gm; out['B_spec_panel_text'] = sm
    check('B: guest and spectator get the "host gone" message', 'anfitri' in gm.lower() and 'anfitri' in sm.lower(), (gm[:80], sm[:80]))
    check('B: guest and spectator pages NOT reloaded (as today)', G.evaluate('window.__marker') == 101 and S.evaluate('window.__marker') == 102)
    G.screenshot(path=os.path.join(PREV, f'playerleave_{TAG}_guest_after_host_left_800x450.png'))
    check('B: Worker room removed', wait(lambda: not [r for r in lst() if r.get('room') == RB], 15) is not None)
    check('B: no page errors', not errs, errs[:6])
    br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
if a.out: json.dump(out, open(a.out, 'w'), indent=1, ensure_ascii=False)
pub = lst(); check('public tmnt_web list is empty', pub == [], pub)
print('ALL PASS' if not fails else 'FAILURES: ' + '; '.join(fails)); sys.exit(1 if fails else 0)
