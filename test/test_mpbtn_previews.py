#!/usr/bin/env python3
"""Headless Chromium: place the Multijogador button, assert geometry, take previews.
usage: python3 test_mpbtn_previews.py [WEB] [PREV]
Private: no netplay rooms are created.
"""
import os, sys, json, functools, http.server, threading, time
from playwright.sync_api import sync_playwright
from PIL import Image

WEB = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../stage'))
PREV = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../previews'))
os.makedirs(PREV, exist_ok=True)

VIEWPORTS = [
    ('1920x1080', 1920, 1080),
    ('1280x720', 1280, 720),
    ('1366x768', 1366, 768),
    ('900x1200', 900, 1200),  # narrow/tall
    ('1600x900', 1600, 900),
]

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_address[1]}/index.html'
fails = []
report = {'base': BASE, 'web': WEB, 'shots': [], 'geo': []}


def measure(pg):
    return pg.evaluate("""() => {
      const btn = document.getElementById('npb');
      const bar = document.getElementById('bar');
      const scr = document.getElementById('screen');
      const bz = document.getElementById('bezel');
      const np = document.getElementById('np');
      const keys = document.getElementById('btn-keys');
      const r = TMNTGFX.rects();
      const br = btn.getBoundingClientRect();
      const sr = scr.getBoundingClientRect();
      const ar = bz ? bz.getBoundingClientRect() : null;
      const cs = getComputedStyle(btn);
      const og = {
        canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
        url: (document.querySelector('meta[property="og:url"]') || {}).content || null,
        image: (document.querySelector('meta[property="og:image"]') || {}).content || null,
      };
      return {
        text: btn.textContent, bar: !!bar, keys: !!keys, teclas: !!document.body.innerText.match(/\\\\bTeclas\\\\b/),
        npDisplay: np ? np.style.display : null,
        btn: {x: br.x, y: br.y, w: br.width, h: br.height, right: br.right, bottom: br.bottom},
        game: r.g, art: r.a || null, screen: {x: sr.x, y: sr.y, w: sr.width, h: sr.height, bottom: sr.bottom},
        bezel: ar ? {x: ar.x, y: ar.y, w: ar.width, h: ar.height, bottom: ar.bottom} : null,
        style: {bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity, font: cs.font, radius: cs.borderRadius, pos: cs.position, shadow: cs.textShadow},
        og, iw: innerWidth, ih: innerHeight, stamp: window.TMNTV_STAMP || null,
        parent: btn.parentElement && btn.parentElement.id,
        corner: btn.classList.contains('corner')
      };
    }""")


def check_geo(tag, m, require_below=True):
    problems = []
    if m['keys'] or m['teclas']:
        problems.append('Teclas button present')
    if not m['bar'] or m['parent'] != 'bar' or m['corner']:
        problems.append('button is not in #bar (web path)')
    if m['text'] not in ('Multijogador (F7)', 'Multiplayer (F7)'):
        problems.append(f"unexpected label {m['text']!r}")
    # solid TMNT green #3fae3a = rgb(63, 174, 58), fully opaque, white text
    st = m['style']
    bg, col, op = st['bg'], st['color'], str(st['opacity'])
    if '63, 174, 58' not in bg and '63,174,58' not in bg:
        problems.append(f'button background is not TMNT green: {bg}')
    if '255, 200' in bg or 'ffc861' in bg.lower():
        problems.append(f'yellow Moo Mesa color leaked: {bg}')
    if bg.strip().startswith('rgba') and not (bg.endswith(', 1)') or bg.endswith(',1)')):
        problems.append(f'background has alpha: {bg}')
    if op not in ('1', '1.0'):
        problems.append(f'opacity is not 1: {op!r}')
    if '255, 255, 255' not in col and '255,255,255' not in col and col.lower() not in ('#fff', '#ffffff', 'white', 'rgb(255, 255, 255)'):
        problems.append(f'text color is not white: {col}')
    for k, v in m['og'].items():
        if not v or 'games4me.alwaysdata.net/tmnt_web' not in v:
            problems.append(f'og/{k} is not alwaysdata: {v}')
        if v and 'localhost' in v:
            problems.append(f'og/{k} has localhost: {v}')
    g, b, art = m['btn'], m['btn'], m['art']
    cx = m['btn']['x'] + m['btn']['w'] / 2
    mid = m['iw'] / 2
    if abs(cx - mid) > 2:
        problems.append(f'not horizontally centered: cx={cx:.1f} mid={mid:.1f}')
    game_bottom = m['game']['y'] + m['game']['h']
    floor = min((art['y'] + art['h']) if art else m['ih'], m['ih'])
    margin = floor - game_bottom
    # must not cover the game when there is room under the CRT
    overlap = max(0, game_bottom - m['btn']['y'])
    if margin >= m['btn']['h'] - 0.5:
        if overlap > 1:
            problems.append(f'covers game by {overlap:.1f}px though margin={margin:.1f}')
        if m['btn']['bottom'] > floor + 2:
            problems.append(f'button extends past bezel floor ({m["btn"]["bottom"]:.1f} > {floor:.1f})')
        if m['btn']['y'] + 1 < game_bottom:
            problems.append(f'button top {m["btn"]["y"]:.1f} is above game bottom {game_bottom:.1f}')
        # roughly vertically centered in the under-CRT strip
        expected = game_bottom + (margin - m['btn']['h']) / 2
        if abs(m['btn']['y'] - expected) > 2:
            problems.append(f'vertical center off: y={m["btn"]["y"]:.1f} expected={expected:.1f}')
    if require_below and margin >= 8 and overlap > 1:
        problems.append(f'covers game (overlap {overlap:.1f}) with margin {margin:.1f}')
    return problems, {
        'tag': tag, 'label': m['text'], 'btn': m['btn'], 'game_bottom': game_bottom,
        'floor': floor, 'margin': margin, 'overlap': overlap, 'cx': cx, 'bg': bg, 'color': m['style']['color'], 'opacity': m['style']['opacity'],
        'problems': problems
    }



def zoom_crop(src, btn, scale=4, pad=16):
    im = Image.open(src).convert('RGB')
    x, y, w, h = btn['x'], btn['y'], btn['w'], btn['h']
    l = max(0, int(x) - pad); t = max(0, int(y) - pad)
    r = min(im.width, int(x + w) + pad); b = min(im.height, int(y + h) + pad)
    crop = im.crop((l, t, r, b))
    crop = crop.resize((crop.width * scale, crop.height * scale), Image.Resampling.NEAREST)
    out = src.replace('.png', '_zoom.png') if src.endswith('.png') else src + '_zoom.png'
    # canonical name for the requested PT 1920 crop
    if src.endswith('btn_pt_1920x1080.png'):
        out = os.path.join(os.path.dirname(src), 'btn_pt_1920x1080_zoom.png')
    crop.save(out)
    print('zoom', out, crop.size)
    return out

def hide_chrome(pg):
    pg.evaluate("""() => {
      const h = document.getElementById('hint');
      if (h) { h.style.transition = 'none'; h.style.opacity = '0'; h.classList.add('off'); }
      if (window.TMNTHINT) TMNTHINT.off = true;
    }""")


ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'])
    # --- main required previews ---
    jobs = [
        ('btn_pt_1920x1080', 'pt', 1920, 1080, False),
        ('btn_en_1920x1080', 'en', 1920, 1080, False),
        ('btn_pt_1280x720', 'pt', 1280, 720, False),
        ('btn_en_1280x720', 'en', 1280, 720, False),
        ('btn_pt_panel_1920x1080', 'pt', 1920, 1080, True),
    ]
    # extra geometry sizes (PT only, no panel shot required except we still screenshot)
    for name, w, h in VIEWPORTS:
        if (w, h) not in ((1920, 1080), (1280, 720)):
            jobs.append((f'btn_pt_{name}', 'pt', w, h, False))

    for name, lang, w, h, open_panel in jobs:
        ctx = browser.new_context(viewport={'width': w, 'height': h}, locale='pt-BR' if lang == 'pt' else 'en-US')
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'{BASE}?lang={lang}&sound=0&pause=1')
        pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000)
        # paint a bit of attract + force layout after button metrics settle
        pg.evaluate('() => { TMNTG.runTo(1500); TMNTGFX.layout(); }')
        pg.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        hide_chrome(pg)
        time.sleep(0.15)
        if open_panel:
            pg.click('#npb')
            pg.wait_for_function("document.getElementById('np') && document.getElementById('np').style.display === 'block'", timeout=5000)
            # also confirm F7 would toggle, but leave panel open for the shot
        m = measure(pg)
        expected_label = 'Multijogador (F7)' if lang == 'pt' else 'Multiplayer (F7)'
        problems, geo = check_geo(name, m)
        if m['text'] != expected_label:
            problems.append(f'lang {lang}: got {m["text"]!r}')
        if open_panel and m['npDisplay'] != 'block':
            problems.append('panel not open after click')
        if errs:
            problems.append('page errors: ' + ' | '.join(errs))
        geo['problems'] = problems
        report['geo'].append(geo)
        path = os.path.join(PREV, name + '.png')
        pg.screenshot(path=path, full_page=False)
        report['shots'].append(path)
        if name in ('btn_pt_1920x1080', 'btn_en_1920x1080', 'btn_pt_1280x720'):
            crop = zoom_crop(path, m['btn'], scale=4, pad=16)
            report['shots'].append(crop)
        if name == 'btn_pt_1920x1080':
            pg.hover('#npb')
            ho = pg.evaluate("""() => {
              const cs = getComputedStyle(document.getElementById('npb'));
              return {opacity: cs.opacity, bg: cs.backgroundColor, color: cs.color};
            }""")
            print('hover', ho)
            if str(ho['opacity']) not in ('1', '1.0'):
                problems.append(f'hover opacity is not 1: {ho}')
            if ho['bg'].startswith('rgba') and not (ho['bg'].endswith(', 1)') or ho['bg'].endswith(',1)')):
                problems.append(f'hover background has alpha: {ho}')
            if '255, 255, 255' not in ho['color'] and '255,255,255' not in ho['color']:
                problems.append(f'hover text is not white: {ho}')
            pg.mouse.move(0, 0)
        status = 'FAIL' if problems else 'PASS'
        if problems:
            ok = False
        print(f'{status} {name}: label={m["text"]!r} y={m["btn"]["y"]:.1f} h={m["btn"]["h"]:.1f} margin={geo["margin"]:.1f} overlap={geo["overlap"]:.1f} bg={m["style"]["bg"]} color={m["style"]["color"]} opacity={m["style"]["opacity"]}')
        for pbm in problems:
            print('   -', pbm)
        if name == 'btn_pt_1920x1080':
            pg.keyboard.press('F7')
            pg.wait_for_function("document.getElementById('np').style.display === 'block'", timeout=3000)
            pg.keyboard.press('F7')
            pg.wait_for_function("document.getElementById('np').style.display !== 'block'", timeout=3000)
            print('PASS F7 toggle on 1920x1080 pt')
        ctx.close()

    # fullscreen-ish: same 16:9 after a resize from another size
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    pg = ctx.new_page()
    pg.goto(f'{BASE}?lang=pt&sound=0&pause=1')
    pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000)
    pg.evaluate('() => { TMNTG.runTo(1500); }')
    pg.set_viewport_size({'width': 1920, 'height': 1080})
    pg.evaluate('() => { TMNTGFX.layout(); }')
    pg.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    hide_chrome(pg)
    time.sleep(0.15)
    m = measure(pg)
    problems, geo = check_geo('resize_to_1920x1080', m)
    report['geo'].append(geo)
    path = os.path.join(PREV, 'btn_pt_resize_1920x1080.png')
    pg.screenshot(path=path, full_page=False)
    report['shots'].append(path)
    if problems:
        ok = False
        print('FAIL resize_to_1920x1080')
        for pbm in problems:
            print('   -', pbm)
    else:
        print('PASS resize_to_1920x1080')
    ctx.close()
    browser.close()

srv.shutdown()
outj = os.path.join(PREV, 'mpbtn_geo.json')
json.dump(report, open(outj, 'w'), indent=2)
print('wrote', outj, 'ok' if ok else 'FAILED')
sys.exit(0 if ok else 1)
