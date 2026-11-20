#!/usr/bin/env python3
"""itch.io page images (local only, ref/ is gitignored). Five 1920x1080 page screenshots with the bezel, UI overlays hidden
(#hint, F7 button, coin hint), each a different scene:
 1 title screen (attract mode)          2 Scene 1 burning street, 4 players
 3 sewer, 4 players                     4 skateboard highway (Scene 3), 4 players
 5 Technodrome, staged online look: nicknames + chat bubbles drawn by the real chat overlay (net/chat.js)
Stages are reached with the arcade's own "finish this scene" RAM flag (0x600BD) and each scene start is kept as a
machine.save() state; during play every player is kept invincible with full energy and lives (capture only).
Then a 630x500 cover ref/preview/itch_cover.png from our own bezel side panels + text (no game graphics)."""
import os, sys, glob
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test'))
from webutil import page, load, ROOT
PREV = os.path.join(ROOT, 'ref/preview'); os.makedirs(PREV, exist_ok=True)
for f in glob.glob(f'{PREV}/itch_shot_*.png'): os.remove(f)
POKE = '''([n, fin]) => { const m = TMNTG.machine, w = m.wram;
  for (let i = 0; i < n; i++) { for (let p = 0; p < 4; p++) { w[0x202D + 0x50*p] = 2; w[0x2008 + 0x50*p] = 10; w[0x101 + 8*p] = 3; }
    if (fin) w[0xBD] = 0xFF; TMNTG.runTo(TMNTG.frameNo + 1);
    if (!window.ST) window.ST = {}; if (!(w[0x120] in ST)) ST[w[0x120]] = m.save(); }
  return w[0x120]; }'''
HIDE = '''() => { for (const id of ['hint', 'npb']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
  if (window.TMNTHINT) TMNTHINT.off = true; }'''
MV = ['ArrowRight', 'KeyG', 'KeyL', 'Numpad6']; AT = ['KeyZ', 'KeyA', 'KeyN', 'Numpad0']
UP = ['ArrowUp', 'KeyR']; DN = ['KeyK', 'Numpad5']
with page('?pause=1&sound=0', viewport=(1920, 1080)) as pg:
    load(pg); pg.evaluate(HIDE)
    run = lambda n: pg.evaluate('n => TMNTG.runTo(n)', n)
    def shot(n, what):
        pg.evaluate(HIDE); pg.evaluate('() => { TMNTG.draw(); if (window.TMNTCHAT) TMNTCHAT.draw(TMNTG.machine); }')
        pg.wait_for_timeout(400); pg.screenshot(path=f'{PREV}/itch_shot_{n}.png'); print('shot', n, what, flush=True)
    run(1600); shot(1, 'title screen')
    def tap(key, f, hold=8): pg.keyboard.down(key); run(f + hold); pg.keyboard.up(key)
    f = 1700
    for i, k in enumerate(['Digit5', 'Digit6', 'Digit7', 'Digit8']): tap(k, f + 30 * i)
    for i, k in enumerate(['Digit1', 'Digit2', 'Digit3', 'Digit4']): run(f + 160 + 30 * i); tap(k, f + 160 + 30 * i)
    pg.evaluate(POKE, [300, False])
    while pg.evaluate(POKE, [30, True]) < 9: pass
    def play(scene, rounds):
        pg.evaluate('s => TMNTG.machine.load(ST[s])', scene)
        for k in MV: pg.keyboard.down(k)
        for t in range(rounds):
            for k in AT: pg.keyboard.down(k)
            pg.evaluate(POKE, [4, False])
            for k in AT: pg.keyboard.up(k)
            pg.evaluate(POKE, [6, False])
            if t % 25 == 12: pg.keyboard.down('KeyX'); pg.evaluate(POKE, [3, False]); pg.keyboard.up('KeyX')
        for k in MV: pg.keyboard.up(k)
        # spread the four turtles over the floor: P1 back left + up, P2 up, P3 down, P4 right + down
        for k in ['ArrowLeft', 'ArrowUp', 'KeyR', 'KeyK', 'Numpad5', 'Numpad6']: pg.keyboard.down(k)
        pg.evaluate(POKE, [20, False]); pg.keyboard.up('KeyR'); pg.keyboard.up('KeyK')
        pg.evaluate(POKE, [25, False])
        for k in ['ArrowLeft', 'ArrowUp', 'Numpad5', 'Numpad6']: pg.keyboard.up(k)
        pg.keyboard.down('KeyZ'); pg.keyboard.down('Numpad0'); pg.evaluate(POKE, [5, False]); pg.keyboard.up('KeyZ'); pg.keyboard.up('Numpad0')
        pg.evaluate(POKE, [3, False])
    play(0, 75); shot(2, 'Scene 1 burning street, 4 players')
    play(3, 20); shot(3, 'sewer, 4 players')
    play(6, 110); shot(4, 'skateboard highway, 4 players')
    play(8, 85)
    pg.evaluate('''() => { const names = ['Saulo', 'Zé', 'Ana', 'Rafa'];
      TMNTNETPLAY.__proto__; window.__realSession = TMNTNETPLAY.session;
      Object.defineProperty(TMNTNETPLAY, 'session', { configurable: true, get: () => ({ rb: {}, slot: 0, names: () => names }) });
      TMNTCHAT.show(0, 'Bora, pessoal! Rumo ao Destruidor!'); TMNTCHAT.show(2, 'Cowabunga!!'); }''')
    shot(5, 'Technodrome, online look: nicknames + chat bubbles')

# 630x500 cover: our own bezel side panels (sign + bricks + pipes) cropped from shot 2, text in the middle. No game graphics.
src = Image.open(f'{PREV}/itch_shot_2.png').convert('RGB'); W, H = src.size
L = src.crop((0, 0, 300, H)).resize((int(300 * 500 / H), 500)); R = src.crop((W - 300, 0, W, H)).resize(L.size)
cv = Image.new('RGB', (630, 500), '#061208'); d = ImageDraw.Draw(cv)
for y in range(500): d.line([(0, y), (630, y)], fill=(6, 18 + y // 25, 8))
cv.paste(L, (0, 0)); cv.paste(R, (630 - R.width, 0))
def font(sz, bold=True):
    f = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    return ImageFont.truetype(f, sz) if os.path.exists(f) else ImageFont.load_default()
def ctext(y, s, sz, fill, bold=True, shadow=(18, 61, 12)):
    f = font(sz, bold); x = (630 - d.textlength(s, font=f)) / 2
    if shadow: d.text((x + 3, y + 3), s, font=f, fill=shadow)
    d.text((x, y), s, font=f, fill=fill)
d.rounded_rectangle((L.width + 6, 70, 630 - R.width - 6, 430), 14, outline=(95, 191, 58), width=3)
ctext(100, 'TMNT', 84, (139, 217, 74)); ctext(205, 'ARCADE 1989', 26, (223, 245, 208))
ctext(250, 'HTML5 REMAKE', 26, (223, 245, 208))
ctext(310, '1-4 PLAYERS', 30, (255, 176, 64)); ctext(350, 'LOCAL + ONLINE', 22, (120, 200, 255), shadow=None)
ctext(395, 'bring your own MAME ROM', 15, (180, 200, 170), bold=False, shadow=None)
cv.save(f'{PREV}/itch_cover.png'); print('cover', cv.size)
