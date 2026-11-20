#!/usr/bin/env python3
"""TMNT web: the HOST's online room closes by itself when idle (net/ui.js idle monitor). Production Worker (slug tmnt_web), headless Chromium, ?idletest=1
(20 s idle / 20 s hidden / 5 s warning), PRIVATE rooms only (every page: tmnt_public=0, so the public list must stay empty). A private room is not in ?a=list at all,
so "room gone" is probed with the Worker's join action ('no such room' once the host left); ?a=list is checked empty at the end.
Scenarios: A) idle host closes (warning ~15 s, closed ~20 s), PT + EN previews at 1920x1080; B) a key during the warning cancels it; C) a player's input keeps the room
alive (and idle players / spectators never trigger anything, 0 desyncs), then it closes ~20 s after the player stops; D) hidden tab closes it even with players active.
Usage: python3 test/test_idle_close.py WEB [--preview DIR]"""
import argparse, urllib.error, json, os, random, socket, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default='')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
ROOT = os.path.abspath(a.web); PREV = a.preview or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'previews'); os.makedirs(PREV, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'; TAG = random.randint(10000, 99999)
fails, errs = [], []
def check(n, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + n, info, flush=True)
    if not ok: fails.append(n if not info else f'{n}: {info}')
def lst():
    try: return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10)).get('rooms', [])
    except Exception as e: return [{'err': str(e)}]
def alive(room):  # private rooms are not listed: ask the Worker to join; a gone room answers 'no such room'
    try:
        j = json.load(urllib.request.urlopen(urllib.request.Request(f'{SIG}?a=join&room={room}&id=probe{TAG}x', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10))
        return bool(j.get('ok'))
    except urllib.error.HTTPError as e:
        try: return False if 'no such room' in e.read().decode() else None
        except Exception: return None
    except Exception: return None
def wait(fn, to=20, step=0.25):
    t0 = time.time()
    while time.time() - t0 < to:
        try: v = fn()
        except Exception: v = None
        if v: return v
        time.sleep(step)
    return None
INSTR = """() => { const I = TMNTIN; window.__bs = { play: false }; let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0;
  I.sample = () => { const o = new Uint8Array(4); if (__bs.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.JUMP][(x >>> 16) % 7]; hold = 20 + ((x >>> 8) % 30); } o[0] = cur; } return o; }; }"""
IDLE = "() => TMNTNETPLAY.idle"
STATS = "() => { const N = TMNTNETPLAY.session; return N && N.rb ? { spec: !!N.spec, slot: N.slot, frame: N.rb.frame, d: N.stats.desyncs, sd: N.stats.specDesyncs, hc: N.stats.hashChecks, shc: N.stats.specHashChecks } : null; }"
try:
  with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader'])
    def page(nick, q='', lang='pt'):
        ctx = br.new_context(locale='pt-BR' if lang == 'pt' else 'en-US', viewport={'width': 800, 'height': 450}); pg = ctx.new_page(); pg.set_default_timeout(90000)
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(nick)}); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')  # PRIVATE
        pg.on('pageerror', lambda e, n=nick: errs.append(f'{n}: {e}'))
        pg.goto(f'{BASE}?lang={lang}&noturn=1&sound=0&idletest=1{q}'); pg.evaluate('TMNTG.whenReady'); pg.evaluate(INSTR); return pg
    def mk(room, lang='pt', player=True, spec=True):
        H = page('Saulo', '', lang); H.evaluate(f'TMNTNETPLAY.host(false, "{room}")'); H.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=30000)
        P = S = None
        if player:
            P = page('Jogador2', f'&sala={room}', lang); P.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot > 0 && !TMNTNETPLAY.state.wait', timeout=60000)
        if spec:
            S = page('Ouvinte', f'&sala={room}&assistir=1', lang); S.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec === true && TMNTNETPLAY.session.rb && TMNTNETPLAY.state.wait === null', timeout=60000)
        for pg in (H, P, S):
            if pg and pg.evaluate("getComputedStyle(document.getElementById('np')).display") == 'block': pg.keyboard.press('F7')
        time.sleep(1.5); return H, P, S
    def idle_wait(H, room, lang, shots):
        """host untouched: the warning must show before the close; returns (t_warn, t_closed)"""
        t0 = time.time(); tw = tc = None; iw = None
        while time.time() - t0 < 60:
            st = H.evaluate(IDLE)
            if st['warn'] and tw is None:
                tw = time.time() - t0; iw = st['idleMs']
                if shots:
                    time.sleep(0.3)
                    if H.evaluate("(() => { const e = document.getElementById('idlewarn'); return !!e && getComputedStyle(e).display !== 'none'; })()"): H.screenshot(path=os.path.join(PREV, f'idle_warning_{lang}_1920x1080.png'))
            if st['closed']: tc = time.time() - t0; break
            time.sleep(0.25)
        return tw, tc, iw
    # ---------- A) idle host closes (PT), then EN ----------
    for lang in ('pt', 'en'):
        R = f'IDL-A{lang[0].upper()}-{TAG}'; H, P, S = mk(R, lang); H.set_viewport_size({'width': 1920, 'height': 1080})
        check(f'[{lang}] room alive before idling', alive(R) is True)
        check(f'[{lang}] idle monitor is on for the host only', H.evaluate(IDLE)['on'] and not P.evaluate(IDLE)['on'] and not S.evaluate(IDLE)['on'], [x.evaluate(IDLE) for x in (H, P, S)])
        tw, tc, iw = idle_wait(H, R, lang, True)
        print(f'[{lang}] warning at {tw}s (host idle {iw} ms), closed at {tc}s', flush=True)
        check(f'[{lang}] warning shown before the close (~15 s idle)', iw is not None and 14800 <= iw <= 17500, iw)
        check(f'[{lang}] room closed ~5 s after the warning (20 s idle)', tc is not None and tw is not None and 4 <= tc - tw <= 8, (tw, tc))
        txw = H.evaluate("(document.getElementById('idlewarn') || {}).textContent || ''")
        check(f'[{lang}] warning text', ('Sala será fechada por inatividade em' in txw and 'aperte qualquer tecla' in txw) if lang == 'pt' else ('Room will close for inactivity in' in txw and 'press any key' in txw), txw)
        time.sleep(0.5)
        txc = H.evaluate("(document.getElementById('idleclosed') || {}).textContent || ''")
        check(f'[{lang}] closed message', txc == ('Sala fechada por inatividade' if lang == 'pt' else 'Room closed due to inactivity'), txc)
        H.screenshot(path=os.path.join(PREV, f'idle_closed_{lang}_1920x1080.png'))
        check(f'[{lang}] room gone from the Worker', wait(lambda: alive(R) is False, 12, 1.0) is not None)
        check(f'[{lang}] host session ended (same path as Sair da sala)', H.evaluate('!TMNTNETPLAY.session'))
        check(f'[{lang}] players / spectators never closed anything themselves', not P.evaluate(IDLE)['closed'] and not S.evaluate(IDLE)['closed'] and not P.evaluate(IDLE)['on'] and not S.evaluate(IDLE)['on'])
        for pg in (H, P, S): pg.context.close()
    # ---------- B) a key during the warning cancels the close ----------
    R = f'IDL-B-{TAG}'; H, P, S = mk(R, 'pt', True, False)
    wait(lambda: H.evaluate(IDLE)['warn'], 30, 0.2); check('[B] warning shown', H.evaluate(IDLE)['warn'])
    H.keyboard.press('Shift'); time.sleep(1.6)
    st = H.evaluate(IDLE); check('[B] a key cancels the warning', not st['warn'] and not st['closed'] and st['idleMs'] < 4000, st)
    time.sleep(8)  # past the time the room would have closed
    check('[B] room still alive after the original close time', alive(R) is True and H.evaluate('!!TMNTNETPLAY.session'))
    wait(lambda: H.evaluate(IDLE)['warn'], 30, 0.2); H.mouse.click(300, 200); time.sleep(1.6)   # a click cancels as well
    check('[B] a click cancels a second warning', not H.evaluate(IDLE)['warn'] and not H.evaluate(IDLE)['closed'])
    for pg in (H, P): pg.context.close()
    print('[B] cleanup: room alive after the host page was killed (expected, expires on its own):', alive(R))
    # ---------- C) a player's input keeps the room alive; idle players / spectators never trigger a close; 0 desyncs ----------
    R = f'IDL-C-{TAG}'; H, P, S = mk(R, 'pt'); P.evaluate('__bs.play = true')
    t0 = time.time(); warned = False
    while time.time() - t0 < 36:
        st = H.evaluate(IDLE); warned |= st['warn']
        if st['closed']: break
        time.sleep(0.5)
    check('[C] room alive after 36 s (> 20 s idle) thanks to the player\'s input, no warning ever', alive(R) is True and not warned and not H.evaluate(IDLE)['closed'], (warned, H.evaluate(IDLE)))
    check('[C] idle spectator never triggered anything', not S.evaluate(IDLE)['on'] and not S.evaluate(IDLE)['closed'])
    stt = [pg.evaluate(STATS) for pg in (H, P, S)]
    check('[C] 0 desyncs (host, player, spectator) and frames advance', all(x and x['d'] == 0 and x['sd'] == 0 for x in stt) and all(x['frame'] > 400 for x in stt), stt)
    P.evaluate('__bs.play = false'); t1 = time.time()
    wait(lambda: H.evaluate(IDLE)['closed'], 60, 0.5); dt = time.time() - t1
    check('[C] once the player stops, the room closes (~20 s)', H.evaluate(IDLE)['closed'] and 14 <= dt <= 40, '%.1fs' % dt)
    check('[C] room gone from the Worker', wait(lambda: alive(R) is False, 12, 1.0) is not None)
    for pg in (H, P, S): pg.context.close()
    # ---------- D) hidden tab closes it even though a player is active ----------
    R = f'IDL-D-{TAG}'; H, P, S = mk(R, 'pt', True, False); P.evaluate('__bs.play = true')
    H.evaluate("() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }"); t1 = time.time()
    wait(lambda: H.evaluate(IDLE)['closed'], 60, 0.5); dt = time.time() - t1; st = H.evaluate(IDLE)
    check('[D] hidden host tab closes the room after ~20 s (reason hidden)', st['closed'] and st['reason'] == 'hidden' and 14 <= dt <= 40, (st, '%.1fs' % dt))
    check('[D] room gone from the Worker', wait(lambda: alive(R) is False, 12, 1.0) is not None)
    check('[D] player page did not close anything', not P.evaluate(IDLE)['closed'] and not P.evaluate(IDLE)['on'])
    for pg in (H, P): pg.context.close()
    check('no page errors', not errs, errs[:6])
    br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
time.sleep(3); pub = lst(); check('public tmnt_web list is empty at the end', pub == [], pub)
print('ALL PASS' if not fails else 'FAILURES: ' + '; '.join(fails)); sys.exit(1 if fails else 0)
