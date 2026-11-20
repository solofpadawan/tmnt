#!/usr/bin/env python3
"""4-player local input check through the real keyboard path (input.js default keys -> FrameInput -> ports):
coins 5/6/7/8 and starts 1/2/3/4 (= attack: the 4-player cabinet joins with button 1), then all four walk right while attacking; screenshots of the full 16:9 page
(WebGL CRT + bezel) and of the raw 320x224 frame. Writes ref/preview/play4_bezel.png, play4_raw.png.
usage: test/test_web_4p.py [SHOT_FRAME=2400]"""
import os, sys, base64, io
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from webutil import page, load, ROOT
SHOT = int(sys.argv[1]) if len(sys.argv) > 1 else 2400
PREV = os.path.join(ROOT, 'ref/preview'); os.makedirs(PREV, exist_ok=True)
VP = tuple(int(v) for v in os.environ.get('VIEWPORT', '1920x1080').split('x'))
with page('?pause=1&sound=0', viewport=VP) as pg:
    load(pg)
    run = lambda n: pg.evaluate('n => TMNTG.runTo(n)', n)
    def tap(key, f, hold=8): pg.keyboard.down(key); run(f + hold); pg.keyboard.up(key)
    run(600)
    for i, k in enumerate(['Digit5', 'Digit6', 'Digit7', 'Digit8']): tap(k, 600 + 30 * i)
    for i, k in enumerate(['Digit1', 'Digit2', 'Digit3', 'Digit4']): run(760 + 30 * i); tap(k, 760 + 30 * i)
    p = lambda: pg.evaluate('Array.from(TMNTG.ports())')
    run(1900)
    for k in ['ArrowRight', 'KeyG', 'KeyL', 'Numpad6']: pg.keyboard.down(k)
    run(SHOT - 30); ports = p()
    for k in ['KeyZ', 'KeyA', 'KeyN', 'Numpad0']: pg.keyboard.down(k)
    run(SHOT)
    print('ports while held (P1..P4, COINS):', [hex(v) for v in ports])
    raw = pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    pg.wait_for_timeout(300); pg.screenshot(path=f'{PREV}/play4_bezel.png')
    print('webgl', pg.evaluate('TMNTGFX.webgl'), 'mode', pg.evaluate('TMNTGFX.mode'))
Image.open(io.BytesIO(base64.b64decode(raw.split(',')[1]))).save(f'{PREV}/play4_raw.png')
print('wrote', f'{PREV}/play4_bezel.png', f'{PREV}/play4_raw.png')
