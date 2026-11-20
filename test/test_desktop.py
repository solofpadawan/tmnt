"""Desktop (Electron) smoke test on Linux/xvfb: desktop/web must be filled by build.sh. Usage: test_desktop.py <userdata> <expect_prompt 0|1>"""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
UD, PROMPT = sys.argv[1], sys.argv[2] == '1'; D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'desktop')
p = subprocess.Popen(['npx', 'electron', '--no-sandbox', '--remote-debugging-port=9333', '--user-data-dir=' + UD, '.'], cwd=D, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    with sync_playwright() as pw:
        for _ in range(60):
            try: b = pw.chromium.connect_over_cdp('http://127.0.0.1:9333'); break
            except Exception: time.sleep(0.5)
        pg = None
        for _ in range(40):
            ps = [x for c in b.contexts for x in c.pages if x.url.startswith('app://')]
            if ps: pg = ps[0]; break
            time.sleep(0.25)
        pg.add_init_script("{const A=window.AudioContext;window.AudioContext=function(o){const c=new A(o);window.__actx=c;return c};}")
        pg.reload(); time.sleep(3)
        shown = pg.evaluate("!!document.getElementById('romload') && getComputedStyle(document.getElementById('romload')).display!=='none'")
        print('url', pg.url, 'romload prompt visible:', shown)
        assert shown == PROMPT, 'prompt state unexpected'
        if PROMPT: pg.set_input_files('#zip', os.path.join(D, '..', 'roms', 'tmnt.zip'))
        pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=30000)
        f0 = pg.evaluate('TMNTG.frame()'); time.sleep(3); f1 = pg.evaluate('TMNTG.frame()')
        st = pg.evaluate("[window.__actx && __actx.state, !!TMNTG.board, document.fullscreenElement!==undefined, typeof TMNTNET!=='undefined' && TMNTNET.DEFAULT_SIGNAL]")
        r = pg.evaluate("fetch('net/signal.php').then(r=>r.status)"); r2 = pg.evaluate("fetch('roms/none.zip').then(r=>r.status)")
        print(f'frames {f0}->{f1} ({(f1-f0)/3:.1f}/s) audio={st[0]} board={st[1]} signal={st[3]} php={r} missing={r2}')
        assert f1 - f0 > 120 and st[0] == 'running'
        print('OK')
finally:
    p.terminate(); time.sleep(1); p.kill()
