#!/usr/bin/env python3
"""TMNT web, spectator-only features, PRIVATE room on the production Worker (slug tmnt_web), headless Chromium:
 (1) "Aguardando o host..." / "Waiting for the host..." overlay: never while the host runs (incl. a jitter netsim), shown ~3 s after the host's rAF stops, hidden as soon
     as frames resume, never on the host / a player; PT + EN previews at 1920x1080.
 (2) "Sair da sala": a SPECTATOR and (playerleave build) a PLAYER reload to the same URL without sala/room/assistir/watch (other params kept).
Exit 0 only if everything passes, 0 desyncs, and the public tmnt_web list is empty at the end.
Usage: python3 test/test_spec_leave_wait.py WEB [--preview DIR] [--sim 60,30,2]"""
import argparse, json, os, random, socket, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default=''); ap.add_argument('--sim', default='60,30,2')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
ROOT = os.path.abspath(a.web); PREV = a.preview or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'previews')
os.makedirs(PREV, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'
R = f'SLW-{random.randint(10000, 99999)}'
fails, errs, pages = [], [], []
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
# in-page recorder (test instrumentation only): was the overlay ever visible, and the first time it appeared
REC = """() => { window.__w = { ever: false, t0: 0 }; setInterval(() => { const e = document.getElementById('spwait'); const on = !!(e && getComputedStyle(e).display !== 'none');
  if (on && !window.__w.ever) { window.__w.ever = true; window.__w.t0 = performance.now(); } }, 40); }"""
FREEZE = "() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = f => { window.__lastLoop = f; return 0; }; }"
THAW = "() => { window.requestAnimationFrame = window.__raf; window.requestAnimationFrame(window.__lastLoop); }"
SHOWN = "() => { const e = document.getElementById('spwait'); return !!(e && getComputedStyle(e).display !== 'none'); }"
STATS = "() => { const N = TMNTNETPLAY.session; return N && N.rb ? { spec: !!N.spec, slot: N.slot, frame: N.rb.frame, d: N.stats.desyncs, sd: N.stats.specDesyncs, hc: N.stats.hashChecks, shc: N.stats.specHashChecks } : null; }"
try:
  with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader'])
    def page(nick, q='', lang='pt', vp=(800, 450)):
        ctx = br.new_context(locale='pt-BR' if lang == 'pt' else 'en-US', viewport={'width': vp[0], 'height': vp[1]})
        pg = ctx.new_page(); pg.set_default_timeout(90000)
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(nick)}); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, n=nick: errs.append(f'{n}: {e}'))
        pg.goto(f'{BASE}?lang={lang}&noturn=1&netsim={a.sim}&sound=0{q}'); pg.evaluate('TMNTG.whenReady'); pages.append(pg); return pg
    H = page('Saulo', vp=(800, 450)); H.evaluate(f'TMNTNETPLAY.host(false, "{R}")'); H.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=30000)
    print('room', R, '(private)', flush=True)
    P = page('Jogador2', f'&sala={R}'); P.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot > 0 && !TMNTNETPLAY.session.spec && !TMNTNETPLAY.state.wait', timeout=60000)
    SP = page('OuvintePT', f'&sala={R}&assistir=1&watch=1', 'pt', (800, 450))
    SE = page('OuvinteEN', f'&sala={R}&assistir=1', 'en', (800, 450))
    for sp in (SP, SE): sp.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec === true && TMNTNETPLAY.session.rb && TMNTNETPLAY.state.wait === null', timeout=60000)
    for pg in (H, P, SP, SE): pg.evaluate(REC)
    for sp in (SP, SE):
        if sp.evaluate("getComputedStyle(document.getElementById('np')).display") == 'block': sp.keyboard.press('F7')  # panel closed during the overlay test
    check('host sees both spectators', wait(lambda: H.evaluate('TMNTNETPLAY.session.spectators().length') >= 2) is not None, H.evaluate('TMNTNETPLAY.session.spectators()'))
    # ---- (1) overlay: host running + jitter netsim for 14 s -> never shown; spectators' playout is playing ----
    t0 = time.time(); f0 = SP.evaluate('TMNTG.frameNo'); shown_run = False
    while time.time() - t0 < 14:
        if SP.evaluate(SHOWN) or SE.evaluate(SHOWN): shown_run = True
        time.sleep(0.25)
    check('overlay never shown while the host runs (jitter netsim %s, 14 s, incl. join prebuffer)' % a.sim, not shown_run and not SP.evaluate('__w.ever') and not SE.evaluate('__w.ever'))
    f1 = SP.evaluate('TMNTG.frameNo'); check('spectator frames advance while the host runs (>= 150 frames in 14 s)', f1 > f0 + 150, (f0, f1))
    check('spectators run the playout buffer', bool(SP.evaluate('TMNTNETPLAY.session.specBuf()')) and bool(SE.evaluate('TMNTNETPLAY.session.specBuf()')))
    # ---- host rAF stops (background tab) ----
    hf = H.evaluate('TMNTG.frameNo'); H.evaluate(FREEZE); tf = time.time()
    time.sleep(2.0)
    check('overlay NOT shown 2 s after the host stopped (below the ~3 s threshold)', not SP.evaluate(SHOWN) and not SE.evaluate(SHOWN))
    ok = wait(lambda: SP.evaluate(SHOWN) and SE.evaluate(SHOWN), 6); tshow = time.time() - tf
    check('overlay shown on both spectators after the host stopped', bool(ok), 'after %.1fs' % tshow)
    check('overlay appeared at ~3-5 s', 2.9 <= tshow <= 5.5, '%.1fs' % tshow)
    txp, txe = SP.evaluate("document.getElementById('spwait').textContent"), SE.evaluate("document.getElementById('spwait').textContent")
    check('PT text', txp == 'Aguardando o host\u2026', txp); check('EN text', txe == 'Waiting for the host\u2026', txe)
    check('host and player never show it', not H.evaluate(SHOWN) and not P.evaluate(SHOWN) and not H.evaluate('__w.ever') and not P.evaluate('__w.ever') and P.evaluate('!TMNTG.waitHostShown'))
    time.sleep(0.5)
    for sp, nm in ((SP, 'pt'), (SE, 'en')):  # the run uses small viewports (4 browsers on a shared box); the previews are taken at 1920x1080
        sp.set_viewport_size({'width': 1920, 'height': 1080}); time.sleep(1.0)
        check('overlay still shown at 1920x1080 (%s)' % nm, sp.evaluate(SHOWN)); sp.screenshot(path=os.path.join(PREV, 'spec_wait_host_%s_1920x1080.png' % nm)); sp.set_viewport_size({'width': 800, 'height': 450})
    # ---- host resumes: overlay hides as soon as frames resume ----
    H.evaluate(THAW); tr = time.time()
    gone = wait(lambda: not SP.evaluate(SHOWN) and not SE.evaluate(SHOWN), 8)
    check('overlay hidden again after the host resumed', bool(gone), 'after %.1fs' % (time.time() - tr))
    sf = SP.evaluate('TMNTG.frameNo')
    check('spectator frames advance again (>= 60 frames within 12 s of the resume; the box is shared and loaded)', wait(lambda: SP.evaluate('TMNTG.frameNo') > sf + 60, 12) is not None, (sf, SP.evaluate('TMNTG.frameNo')))
    st = [pg.evaluate(STATS) for pg in (H, P, SP, SE)]
    check('0 desyncs (host, player, spectators)', all(x and x['d'] == 0 and x['sd'] == 0 for x in st), st)
    # ---- (2) spectator "Sair da sala" reloads; player leave does not ----
    openp(SP)
    SP.evaluate('window.__marker = 123'); check('spectator panel has the Sair da sala button', SP.evaluate("!!document.getElementById('np-leave')"))
    SP.click('#np-leave'); wait(lambda: (not SP.is_closed()) and SP.evaluate('typeof window.__marker') == 'undefined', 15)
    for _ in range(40):
        try: SP.wait_for_load_state('load'); SP.evaluate('TMNTG.whenReady'); break
        except Exception: time.sleep(0.25)
    time.sleep(2); url = SP.url; print('spectator URL after leaving:', url, flush=True)
    check('spectator page reloaded (JS marker gone)', SP.evaluate('typeof window.__marker') == 'undefined')
    check('URL without sala / room / assistir / watch', not any(k + '=' in url for k in ('sala', 'room', 'assistir', 'watch')), url)
    check('other params kept (lang, noturn, netsim, sound)', 'lang=pt' in url and 'noturn=1' in url and 'netsim=' in url and 'sound=0' in url, url)
    check('fresh game: no session', SP.evaluate('!TMNTNETPLAY.session'))
    fa = SP.evaluate('TMNTG.frameNo'); time.sleep(1.5); check('fresh game runs', SP.evaluate('TMNTG.frameNo') > fa + 10, fa)
    check('F7 panel closed after reload', SP.evaluate("getComputedStyle(document.getElementById('np')).display") == 'none')
    check('host roster: that spectator gone', wait(lambda: H.evaluate('TMNTNETPLAY.session.spectators().length') == 1, 15) is not None, H.evaluate('TMNTNETPLAY.session.spectators()'))
    SP.set_viewport_size({'width': 1920, 'height': 1080}); time.sleep(1.0); SP.screenshot(path=os.path.join(PREV, 'specleave_after_pt_1920x1080.png'))
    # the other spectator (EN) is not affected and keeps running
    e1 = SE.evaluate('TMNTG.frameNo'); check('other spectator unaffected (still spectating, frames advance)', wait(lambda: SE.evaluate('TMNTG.frameNo') > e1 + 20, 8) is not None and SE.evaluate('TMNTNETPLAY.session.spec') is True)
    # player leave (NEW in playerleave): the player's page reloads too, URL clean (details in test_player_leave.py)
    openp(P)
    P.evaluate('window.__marker = 456'); P.click('#np-leave'); wait(lambda: (not P.is_closed()) and P.evaluate('typeof window.__marker') == 'undefined', 15)
    for _ in range(40):
        try: P.wait_for_load_state('load'); P.evaluate('TMNTG.whenReady'); break
        except Exception: time.sleep(0.25)
    time.sleep(1); purl = P.url
    check('player: page reloaded (JS marker gone)', P.evaluate('typeof window.__marker') == 'undefined')
    check('player: URL without sala / room / assistir / watch', not any(k + '=' in purl for k in ('sala', 'room', 'assistir', 'watch')) and 'lang=pt' in purl, purl)
    check('player: fresh game, no session', P.evaluate('!TMNTNETPLAY.session'))
    check('host still hosting after the player left', H.evaluate('!!TMNTNETPLAY.session && !!TMNTNETPLAY.session.rb'))
    st = [pg.evaluate(STATS) for pg in (H, SE)]
    check('0 desyncs at the end (host, remaining spectator)', all(x and x['d'] == 0 and x['sd'] == 0 for x in st), st)
    check('no page errors', not errs, errs[:6])
    for pg in (SE, H):
        try: pg.evaluate('TMNTNETPLAY.session ? TMNTNETPLAY.leave() : null')
        except Exception as e: print('  leave warn', e)
    time.sleep(8)
    left = [r for r in lst() if r.get('room') == R]; check('test room removed from the Worker list', not left, left)
    br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
pub = lst(); check('public tmnt_web list is empty', pub == [], pub)
print('ALL PASS' if not fails else 'FAILURES: ' + '; '.join(fails)); sys.exit(1 if fails else 0)
