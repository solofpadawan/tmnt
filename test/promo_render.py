#!/usr/bin/env python3
"""Promo video, step 3: replay one peer's recorded session frame-exact in a paused page and screenshot every frame of
[A, B) through the real presentation path (render.js -> gfx.js WebGL CRT + bezel v4, chat.js nicknames + bubbles).
State = that peer's packed snapshot at F0, inputs = that peer's recorded confirmed inputs, bubbles at the frames that
peer showed them, on a virtual clock (performance.now = frame time) so bubble timing is frame-exact. UI overlays hidden
(#hint, F7 button, coin hint). usage: promo_render.py PEER A B TAG VW VH [JOBS=4] -> /tmp/tmnt_promo/frames_TAG/%05d.png"""
import os, subprocess, time, json, socket, sys
from multiprocessing import Process
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from webutil import load
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); OUT = '/tmp/tmnt_promo'
PEER, A, B, TAG, VW, VH = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
JOBS = int(sys.argv[7]) if len(sys.argv) > 7 else 4
FR = f'{OUT}/frames_{TAG}'; os.makedirs(FR, exist_ok=True)
SETUP = """d => { const m = TMNTG.machine, u = TMNTSNAP.unpack(new Uint8Array(d.snap)); m.load(u.m); TMNTG.frameNo = d.F0 - 1;
  for (const id of ['hint', 'npb']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
  TMNTHINT.off = true; window.__d = d; window.__ci = 0;
  TMNTNETPLAY.state.s = { rb: {}, names: () => d.names, slot: d.slot, spec: false, role: d.slot ? 'guest' : 'host', active: () => false };
  window.__stepTo = f1 => { const D = window.__d; for (let f = TMNTG.frameNo + 1; f <= f1; f++) {
      window.__vt = f * 1000 / (6000000 / (384 * 264));
      while (__ci < D.chat.length && D.chat[__ci][0] <= f) { const c = D.chat[__ci++]; TMNTCHAT.show(c[1], c[2]); }
      TMNTG.netStep(new Uint8Array(D.rec[f]), f); }
    TMNTG.draw(); }; }"""
def job(lo, hi, port, d):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader'])
        pg = b.new_page(viewport={'width': VW, 'height': VH}, device_scale_factor=1)
        pg.add_init_script("(() => { const real = performance.now.bind(performance); window.__vt = null; performance.now = () => window.__vt === null ? real() : window.__vt; })()")
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{port}/index.html?pause=1&sound=0'); load(pg)
        pg.evaluate(SETUP, d); pg.evaluate(f'__stepTo({lo - 1})'); t0 = time.time()
        for f in (range(lo, hi) if os.environ.get("ONLY") is None else [int(os.environ["ONLY"])]):
            pg.evaluate(f'__stepTo({f})'); pg.wait_for_timeout(5); pg.screenshot(path=f'{FR}/{f - A:05d}.png', timeout=180000)
            if f % 100 == 0: print(TAG, f, round(time.time() - t0, 1), flush=True)
        if errs: print('errors', errs[:5], flush=True)
        b.close()
if __name__ == '__main__':
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    php = subprocess.Popen(['php', '-S', f'127.0.0.1:{port}', '-t', os.path.join(ROOT, 'web')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    d = json.load(open(f'{OUT}/live_p{PEER}.json')); d['rec'] = {k: v for k, v in d['rec'].items() if d['F0'] <= int(k) < B}
    cuts = [A + (B - A) * k // JOBS for k in range(JOBS + 1)]
    ps = [Process(target=job, args=(cuts[k], cuts[k + 1], port, d)) for k in range(JOBS)]
    for x in ps: x.start()
    for x in ps: x.join()
    php.terminate(); print('done', TAG, len(os.listdir(FR)))
