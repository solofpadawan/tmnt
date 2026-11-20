#!/usr/bin/env python3
"""Boot/frames vs existing MAME snapshots: serve this build's stage, run the machine, compare #screen.
usage: test_web_runtime_stage.py [WEB] [PREV] [frames...]
Default frames: 100 (boot/self-test-ish) and 1500 (title).
"""
import base64, io, os, sys, functools, http.server, threading
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

WEB = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../stage'))
PREV = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../previews/mame'))
frames = [int(x) for x in sys.argv[3:]] or [100, 1500]
REF = '/workspace/tmnt/ref/preview'
os.makedirs(PREV, exist_ok=True)

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_address[1]}/index.html'
ok = True
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.goto(BASE + '?pause=1&sound=0')
    pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000)
    print('boot ready stamp', pg.evaluate('window.TMNTV_STAMP'))
    for f in frames:
        refp = os.path.join(REF, f'mame_f{f}.png')
        if not os.path.isfile(refp):
            print('FAIL missing MAME ref', refp); ok = False; continue
        pg.evaluate('n => TMNTG.runTo(n)', f)
        url = pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
        ours = Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).convert('RGB')
        ref = Image.open(refp).convert('RGB')
        if ours.size != ref.size:
            print(f'FAIL frame {f}: size {ours.size} vs MAME {ref.size}'); ok = False
            continue
        d = ImageChops.difference(ours, ref).convert('L')
        n = sum(1 for v in d.getdata() if v)
        ours.save(os.path.join(PREV, f'web_f{f}.png'))
        sbs = Image.new('RGB', (ours.width * 2 + 8, ours.height))
        sbs.paste(ours, (0, 0)); sbs.paste(ref, (ours.width + 8, 0))
        sbs.save(os.path.join(PREV, f'sbs_f{f}.png'))
        print(f'frame {f}: {n} of {ours.width*ours.height} px differ ({100*(1-n/(ours.width*ours.height)):.3f}% match), bbox {d.getbbox()}')
        if n != 0:
            ok = False
    b.close()
srv.shutdown()
sys.exit(0 if ok else 1)
