#!/usr/bin/env python3
"""Browser audio vs Node, sample-for-sample, against this voice build's stage (master GainNode at unity).
Worklet dump is taken BEFORE the duck GainNode, so unity gain is a no-op and samples must still match
tools/render_pcm.js + render_wav.js. Also asserts TMNTG.audio.duck.gain.value === 1 when not ducked.
usage: test_web_audio.py [WEB] [FRAMES=1500]
"""
import os, sys, subprocess, time, base64, functools, http.server, threading
import numpy as np
from playwright.sync_api import sync_playwright

WEB = sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(os.path.join(os.path.dirname(__file__), '../stage'))
N = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
TMNT = '/workspace/tmnt'
out = os.path.join(os.path.dirname(__file__), '../previews/audio')
os.makedirs(out, exist_ok=True)

subprocess.run(['node', 'tools/render_pcm.js', str(N), out + '/node.f32'], cwd=TMNT, check=True)
subprocess.run(['node', 'tools/render_wav.js', str(N), out + '/node.wav'], cwd=TMNT, check=True, capture_output=True)
node = np.fromfile(out + '/node.f32', dtype='<f4')
wav = np.frombuffer(open(out + '/node.wav', 'rb').read()[44:], dtype='<i2')

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_address[1]}/index.html'

ok = True
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.goto(BASE + '?pause=1&audiotest=1')
    pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000)
    st = pg.evaluate('TMNTG.actx && TMNTG.actx.state')
    duck = pg.evaluate('TMNTG.audio && TMNTG.audio.duck && TMNTG.audio.duck.gain.value')
    graph = pg.evaluate('!!(TMNTG.audio && TMNTG.audio.ac && TMNTG.audio.duck && TMNTG.actx === TMNTG.audio.ac)')
    print('AudioContext', st, 'duck', duck, 'shared graph', graph)
    if duck != 1 or not graph:
        print('FAIL duck/graph', duck, graph); ok = False
    pg.evaluate('n => TMNTG.runTo(n)', N)
    t0 = time.time()
    while True:
        d = pg.evaluate("TMNTG.audioCmd('dump').then(d => d ? ({q: d.queued, rx: d.rx.length, tx: d.tx.length}) : null)")
        if d is None:
            print('FAIL no worklet dump'); ok = False; break
        if d['q'] == 0 or time.time() - t0 > N / 59.0 + 30: break
        time.sleep(1)
    blob = pg.evaluate("""TMNTG.audioCmd('dump').then(d => { const f = a => { let s = ''; const u = new Uint8Array(a.buffer);
        for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
        return {rx: f(d.rx), tx: f(d.tx), sr: TMNTG.actx.sampleRate}; })""")
    duck2 = pg.evaluate('TMNTG.audio.duck.gain.value')
    if duck2 != 1:
        print('FAIL duck after run', duck2); ok = False
    pg.reload(); pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=30000)
    cached = not pg.evaluate("!!document.getElementById('zip')")
    b.close()
srv.shutdown()

rx = np.frombuffer(base64.b64decode(blob['rx']), dtype='<f4'); tx = np.frombuffer(base64.b64decode(blob['tx']), dtype='<f4')
q16 = lambda a: np.clip(np.floor(a.astype(np.float64) * 32768 + 0.5), -32768, 32767).astype(np.int16)

def chk(name, a, b, exact=True):
    global ok
    n = min(len(a), len(b)); same = len(a) == len(b) and (np.array_equal(a, b) if exact else True)
    diff = int(np.count_nonzero(a[:n] != b[:n]))
    print(f'{name}: {len(a)} vs {len(b)} samples, {diff} differ' + ('' if same and not diff else '  <-- FAIL')); ok &= same and diff == 0

print(f'AudioContext {st} @ {blob["sr"]} Hz, {N} frames')
chk('worklet received  vs node per-frame (float32)', rx, node)
chk('worklet output    vs worklet received (float32)', tx, rx)
chk('worklet output    vs node one-shot WAV (int16)', q16(tx), wav[:len(tx)])
print(f'non-silent samples: {int(np.count_nonzero(tx))}; IndexedDB cache on reload: {cached}'); ok &= cached
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
