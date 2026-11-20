#!/usr/bin/env python3
"""Typed room names for TMNT vs live Cloudflare Worker (tmnt_web)."""
import argparse, os, re, sys, json, time, socket, subprocess, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web')
ap.add_argument('--signal', default='https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php')
ap.add_argument('--name', default='Tmnt Cowabunga'); ap.add_argument('--preview', default=''); a = ap.parse_args()
SIG = a.signal
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', a.web], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); BASE = f'http://127.0.0.1:{port}/index.html'
PTRE = re.compile(r'[ãõçáéíóúâêôà]|\b(sala|salas|entrar|criar|nome|digite|curto|caracteres|letras|n[uú]meros|em uso|escolha|outro|servidor|existe|anfitri\w*|j[aá])\b', re.I)
fails = []; ok = lambda c, m: print(('PASS ' if c else 'FAIL ') + m, flush=True) or (c or fails.append(m))
def lst():
    try: return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10)).get('rooms', [])
    except Exception as e: return [{'err': str(e)}]
pv = lambda pg, n: a.preview and (os.makedirs(a.preview, exist_ok=True) or pg.screenshot(path=os.path.join(a.preview, n)))
sigq = '' if 'workers.dev' in SIG else f'&signal={SIG}'
pages = []; want = None
try:
  with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    br = p.chromium.launch(args=args)
    def page(nick, lang, extra=''):
        ctx = br.new_context(locale='pt-BR' if lang == 'pt' else 'en-US', viewport={'width': 1100, 'height': 760}); pg = ctx.new_page(); pg.set_default_timeout(60000)
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(nick)}); localStorage.setItem("tmnt_public", "1") }} catch (e) {{}}')
        pg.on('pageerror', lambda e: fails.append(f'{nick}: {e}')); pg.goto(f'{BASE}?lang={lang}&sound=0{sigq}{extra}'); pg.evaluate('TMNTG.whenReady'); pages.append(pg); return pg
    # --- host A (pt): empty / short / typed
    A = page('teste-bot', 'pt'); A.keyboard.press('F7'); time.sleep(0.5)
    ok(A.is_disabled('#np-create') and 'Digite um nome' in A.inner_text('#np-room-msg'), 'empty name: create disabled + hint "' + A.inner_text('#np-room-msg') + '"')
    pv(A, 'room_empty_pt.png')
    A.click('#np-room'); A.keyboard.type('ab'); ok(A.is_disabled('#np-create') and 'curto' in A.inner_text('#np-room-msg'), 'short name: "' + A.inner_text('#np-room-msg') + '"')
    pv(A, 'room_short_pt.png')
    A.fill('#np-room', ''); A.keyboard.type('Ação já 123456789xyz!@#', delay=10); v = A.input_value('#np-room')
    ok(v == 'ACAO-JA-12345678', f'normalized while typing (accents, spaces, symbols, max 16): {v}')
    A.fill('#np-room', ''); A.keyboard.type(a.name, delay=20); want = A.input_value('#np-room'); ok(re.fullmatch(r'[A-Z0-9-]{3,16}', want) is not None and not A.is_disabled('#np-create'), f'typed "{a.name}" -> {want}, create enabled')
    pv(A, 'room_name_create_pt.png')
    A.keyboard.press('Enter'); A.wait_for_function('TMNTNETPLAY.session', timeout=30000); time.sleep(1)
    ok(A.evaluate('TMNTNETPLAY.state.room') == want and want in A.inner_text('#np'), f'host room = typed name {want} (Enter in the field)')
    # --- host B (pt): same name -> 409
    B = page('teste-bot2', 'pt'); B.keyboard.press('F7'); B.click('#np-room'); B.keyboard.type(a.name.lower(), delay=10); B.click('#np-create')
    B.wait_for_function('document.querySelector("#np").innerText.includes("já está em uso")', timeout=30000); time.sleep(0.3)
    bt = B.inner_text('#np'); ok('em uso' in bt and B.evaluate('!TMNTNETPLAY.session && !TMNTNETPLAY.state.room') and B.input_value('#np-room') == want and not B.is_disabled('#np-create'),
        'second host same name: "name in use" shown, no session, name kept, button usable')
    pv(B, 'room_name_taken_pt.png')
    # alternate must stay ≤16 after norm (avoid collision with truncated '… 2')
    alt = (want[:14].rstrip('-') + '-2')[:16]
    B.fill('#np-room', ''); B.keyboard.type(alt); want2 = B.input_value('#np-room'); B.click('#np-create'); B.wait_for_function('TMNTNETPLAY.session', timeout=30000)
    ok(B.evaluate('TMNTNETPLAY.state.room') == want2, f'after choosing another name ({want2}) the room opens')
    B.evaluate('TMNTNETPLAY.leave()'); time.sleep(0.5)
    # --- C (en): create screen + 409 in English, then join by typed name
    C = page('teste-bot3', 'en'); C.keyboard.press('F7'); time.sleep(0.5)
    ok(C.is_disabled('#np-create') and C.inner_text('#np-room-msg') == 'Type a name to create the room.', 'EN empty hint')
    pv(C, 'room_empty_en.png')
    C.click('#np-room'); C.keyboard.type('ab'); ok(C.is_disabled('#np-create') and 'too short' in C.inner_text('#np-room-msg').lower(), 'EN short hint')
    pv(C, 'room_short_en.png')
    C.fill('#np-room', ''); C.keyboard.type('wild bunch'); pv(C, 'room_name_create_en.png')
    # EN chrome only (hints / buttons / placeholders / taken msg) — ignore room-list stage names (often PT)
    chrome = [
      C.inner_text('#np-room-msg'),
      C.inner_text('#np-create'),
      C.inner_text('#np-join'),
      C.eval_on_selector('#np-room', 'e => e.placeholder'),
      C.eval_on_selector('#np-code', 'e => e.placeholder'),
      C.evaluate("([...document.querySelectorAll('#np > small')].map(e => e.innerText).join(' | '))"),
    ]
    C.fill('#np-room', ''); C.keyboard.type(a.name); C.click('#np-create'); C.wait_for_function('document.querySelector("#np").innerText.includes("already in use")', timeout=30000); time.sleep(0.3)
    taken_line = C.evaluate("([...document.querySelectorAll('#np *')].map(e => e.innerText).find(t => /already in use/i.test(t||'')) || '')")
    pv(C, 'room_name_taken_en.png')
    C.click('#np-room'); C.fill('#np-room', 'ab'); C.dispatch_event('#np-room', 'input'); short = C.inner_text('#np-room-msg')
    etxt = chrome + [taken_line, short]
    lo = [m.group(0) for x in etxt for m in PTRE.finditer(re.sub(r'\b[A-Z0-9-]{3,16}\b', '', x or ''))]
    ok(not lo, 'EN panel (create / taken / short / placeholders) has no Portuguese: ' + (json.dumps(lo[:6], ensure_ascii=False) if lo else 'ok'))
    C.fill('#np-room', ''); C.fill('#np-code', a.name.lower()); cv = C.input_value('#np-code'); C.dispatch_event('#np-code', 'input'); cv = C.input_value('#np-code'); C.click('#np-join')
    C.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot === 1', timeout=60000)
    ok(cv == want, f'join field normalized ({a.name.lower()!r} -> {cv}) and joined as P2')
    # --- D: ?sala=<lowercase> as P3
    D = page('teste-bot4', 'pt', f'&sala={want.lower()}'); D.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot === 2', timeout=60000)
    ok(D.evaluate('TMNTNETPLAY.state.room') == want, f'?sala={want.lower()} joined as P3')
    time.sleep(2)
    A.evaluate('document.getElementById("npb").click()'); C.evaluate('document.getElementById("npb").click()'); D.evaluate('document.getElementById("npb").click()'); time.sleep(0.3)
    pv(A, 'room_connected_pt.png'); pv(C, 'room_connected_en.png')
    ds = [pg.evaluate('TMNTNETPLAY.session && TMNTNETPLAY.session.stats.desyncs') for pg in (A, C, D)]
    print('  desyncs', ds); ok(all(x == 0 for x in ds), '3 players, 0 desyncs')
    # room list join would be P4 - TMNT allows 4; do a quick list check then skip 4th to keep 3-peer focus, but still verify list
    E = page('teste-bot5', 'pt'); E.keyboard.press('F7')
    E.wait_for_function(f'(TMNTNETPLAY.roomList() || []).some(r => r.room === "{want}")', timeout=60000); time.sleep(0.5)
    row = [r for r in E.evaluate('TMNTNETPLAY.roomList()') if r['room'] == want]; print('  list row', row)
    ok(bool(row), f'room {want} listed')
    E.click(f'#np-list button[data-r="{want}"]'); E.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot === 3', timeout=60000)
    ok(True, f'room {want} joined from the list as P4')
    time.sleep(2); ds2 = [pg.evaluate('TMNTNETPLAY.session && TMNTNETPLAY.session.stats.desyncs') for pg in (A, C, D, E)]
    ok(all(x == 0 for x in ds2), '4 players after list join, 0 desyncs: ' + str(ds2))
    # --- F: unknown room + bad ?sala=
    F = page('teste-bot6', 'pt'); F.keyboard.press('F7'); F.fill('#np-code', 'nao existe xyz'); F.dispatch_event('#np-code', 'input'); F.click('#np-join')
    F.wait_for_function('document.querySelector("#np").innerText.includes("não existe")', timeout=60000); ft = F.inner_text('#np')
    ok(F.evaluate('!TMNTNETPLAY.session') and F.query_selector('#np-room') is not None, 'unknown room: friendly message, back to the form: ' + ft.split('\n')[-1])
    pv(F, 'room_nonexistent_pt.png')
    G2 = page('teste-bot7', 'en'); G2.keyboard.press('F7'); G2.fill('#np-code', 'does-not-exist-xx'); G2.dispatch_event('#np-code', 'input'); G2.click('#np-join')
    G2.wait_for_function('document.querySelector("#np").innerText.toLowerCase().includes("does not exist")', timeout=60000)
    pv(G2, 'room_nonexistent_en.png')
    ok(G2.evaluate('!TMNTNETPLAY.session'), 'EN nonexistent room message')
    G3 = page('teste-bot8', 'en', '&sala=ab'); time.sleep(1.5); gt = G3.inner_text('#np') if G3.is_visible('#np') else G3.evaluate('document.querySelector("#np").innerText')
    ok('invalid room name' in gt and G3.evaluate('!TMNTNETPLAY.session'), '?sala=ab -> invalid name message')
    for pg in (E, D, C):
      try: pg.evaluate('TMNTNETPLAY.leave()')
      except Exception: pass
      time.sleep(0.3)
    A.evaluate('TMNTNETPLAY.leave()'); time.sleep(3)
    br.close()
finally:
    srv.terminate()
time.sleep(2)
prefix = re.sub(r'[^A-Z0-9-]', '', (want or 'NONE'))[:8]
left = [r for r in lst() if str(r.get('room', '')).startswith(prefix) or 'err' in r]
ok(not left, 'no test rooms left in ?a=list: ' + json.dumps(left))
print('ALL PASS' if not fails else 'FAILED: ' + '; '.join(fails)); raise SystemExit(1 if fails else 0)
