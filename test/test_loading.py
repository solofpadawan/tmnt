#!/usr/bin/env python3
"""Loading overlay (loading.js) in headless Chromium against a local server with per-file HOLDs (a held file never answers until the test
releases it, so every load stage can be observed and measured). No netplay, no rooms.
Usage: python3 test/test_loading.py web [--preview DIR]
Checks: style (#fff, 15px/600, rgba(0,0,0,.6), padding 8px 16px, radius 8px, no border), exact centre on the game canvas (#screen) and on
TMNTGFX.rects().g in the 1920x1080 bezel, the real stage sequence (local ROM / IndexedDB cache path), pt/en/es texts, one message at a time,
hidden while the "pick your zip" dialog is open, removed on the FIRST drawn frame (not on audio), load errors in the same box and they stay,
stays centred after resizes, other window shapes, ?gfx=crt|orig and (when the browser allows it) real fullscreen."""
import argparse, os, sys, json, time, threading, http.server, socketserver, functools, mimetypes, re
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default='')
a = ap.parse_args(); WEB = os.path.abspath(a.web)
HOLD = {}      # path substring -> threading.Event (set = released)
BAD = set()    # path substrings answered with 404
PATCH = {}     # path substring -> (old, new) text replacement
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def do_GET(self):
        path = self.path.split('?')[0]; root = ''
        for pre in ('/norom/', '/bad/'):
            if path.startswith(pre): root = pre; path = path[len(pre) - 1:]
        if path.endswith('/'): path += 'index.html'
        full = os.path.normpath(WEB + path)
        for k, ev in list(HOLD.items()):
            if k in path: ev.wait(60)
        if not full.startswith(WEB) or not os.path.isfile(full) or any(k in path for k in BAD) or (root == '/norom/' and path.endswith('roms/tmnt.zip')):
            self.send_response(404); self.end_headers(); return
        data = open(full, 'rb').read()
        if root == '/bad/' and path.endswith('romset.js'): data += b"\n;window.TMNTROM.build = () => { throw new Error('ROM boom test'); };\n"
        self.send_response(200); self.send_header('Content-Type', mimetypes.guess_type(full)[0] or 'application/octet-stream'); self.send_header('Content-Length', str(len(data))); self.send_header('Cache-Control', 'no-store'); self.end_headers()
        try: self.wfile.write(data)
        except Exception: pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
srv = S(('127.0.0.1', 0), H); port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://127.0.0.1:{port}'
fails = []
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
    if not ok: fails.append(name)
DOTS = "#tmntload .e i{animation:none!important;opacity:1!important}"
def shot(pg, path, **kw):  # previews: freeze the ellipsis on three dots so every preview reads the same
    pg.add_style_tag(content=DOTS); time.sleep(0.15); pg.screenshot(path=path, **kw)
def hold(*ks):
    for k in ks: HOLD[k] = threading.Event()
def release(*ks):
    for k in ks:
        if k in HOLD: HOLD.pop(k).set()
OV = """(() => { const e = document.getElementById('tmntload'); if (!e || getComputedStyle(e).display === 'none') return null;
  const r = e.getBoundingClientRect(), s = document.getElementById('screen').getBoundingClientRect(), c = getComputedStyle(e), g = window.TMNTGFX ? TMNTGFX.rects().g : null;
  return { text: e.textContent, n: document.querySelectorAll('#tmntload').length, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height,
    sx: s.left + s.width / 2, sy: s.top + s.height / 2, sw: s.width, sh: s.height, gx: g ? g.x + g.w / 2 : null, gy: g ? g.y + g.h / 2 : null,
    color: c.color, font: c.fontSize + '/' + c.fontWeight, ff: c.fontFamily, bg: c.backgroundColor, pad: c.paddingTop + ' ' + c.paddingRight + ' ' + c.paddingBottom + ' ' + c.paddingLeft, rad: c.borderTopLeftRadius, bw: c.borderTopWidth, bs: c.borderTopStyle, z: c.zIndex, pe: c.pointerEvents,
    cls: e.className, st: window.TMNTLOADING.current, dots: Array.from(e.querySelectorAll('.e i')).map(i => getComputedStyle(i).opacity) }; })()"""
def wait_ov(pg, pred, to=30):
    t0 = time.time(); o = None
    while time.time() - t0 < to:
        o = pg.evaluate(OV)
        if o and pred(o): return o
        time.sleep(0.05)
    return o
def centred(o, tol=1.0): return o and abs(o['cx'] - o['sx']) <= tol and abs(o['cy'] - o['sy']) <= tol and (o['gx'] is None or (abs(o['cx'] - o['gx']) <= tol and abs(o['cy'] - o['gy']) <= tol))
TXT = {'pt': {'engine': 'Iniciando o motor...', 'rom': 'Carregando a ROM...'}, 'en': {'engine': 'Starting the engine...', 'rom': 'Loading the ROM...'}, 'es': {'engine': 'Iniciando el motor...', 'rom': 'Cargando la ROM...'}}
errors = []
with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'])
    def newpage(w=1920, h=1080, lang='pt-BR'):
        ctx = br.new_context(viewport={'width': w, 'height': h}, locale=lang); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e))); return pg
    # ---------- 1) engine stage (sim core held), texts in pt / en / es, style, centre ----------
    for lg in ('pt', 'en', 'es'):
        pg = newpage(); hold('sim/tmnt.js')
        pg.goto(f'{B}/index.html?lang={lg}&sound=0', wait_until='commit')
        o = wait_ov(pg, lambda o: o['st'] == 'engine')
        check(f'[{lg}] engine stage text', o and o['text'] == TXT[lg]['engine'], o and o['text'])
        if lg == 'pt':
            check('style: #fff, 15px/600, system sans-serif', o['color'] == 'rgb(255, 255, 255)' and o['font'] == '15px/600' and 'system-ui' in o['ff'], (o['color'], o['font'], o['ff']))
            check('style: rgba(0,0,0,.6), padding 8px 16px, radius 8px, no border', o['bg'] == 'rgba(0, 0, 0, 0.6)' and o['pad'] == '8px 16px 8px 16px' and o['rad'] == '8px' and (o['bw'] == '0px' or o['bs'] == 'none'), (o['bg'], o['pad'], o['rad'], o['bw'], o['bs']))
            check('one message at a time (one #tmntload element, pointer-events none)', o['n'] == 1 and o['pe'] == 'none')
            check('centred on the game canvas (#screen) AND on the bezel game rect (<= 1 px), not on the page', centred(o) and abs(o['sx'] - 960) < 1 and o['sw'] < 1400, {k: round(o[k], 1) for k in ('cx', 'cy', 'sx', 'sy', 'gx', 'gy', 'sw', 'sh')})
            ds = []
            for _ in range(12): ds.append(tuple(pg.evaluate(OV)['dots'])); time.sleep(0.15)
            check('only animation = ellipsis (dots step through 0..3 visible)', len({sum(1 for x in d if float(x) > .5) for d in ds}) >= 3, sorted({sum(1 for x in d if float(x) > .5) for d in ds}))
            if a.preview: shot(pg,f'{a.preview}/loading_engine_pt_1920x1080.png')
        if lg == 'es' and a.preview: shot(pg,f'{a.preview}/loading_engine_es_1920x1080.png')
        release('sim/tmnt.js'); pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000); pg.context.close()
    # ---------- 2) ROM stage (local roms/tmnt.zip held), first drawn frame removes the overlay, audio does not block the first frame ----------
    for lg in ('pt', 'en'):
        pg = newpage(); hold('roms/tmnt.zip')
        pg.goto(f'{B}/index.html?lang={lg}', wait_until='commit')
        o = wait_ov(pg, lambda o: o['st'] == 'rom')
        check(f'[{lg}] ROM stage text', o and o['text'] == TXT[lg]['rom'], o and o['text'])
        check(f'[{lg}] ROM stage centred on the canvas / bezel game rect', centred(o), o and {k: round(o[k], 1) for k in ('cx', 'cy', 'sx', 'sy', 'gx', 'gy')})
        if a.preview:
            shot(pg,f'{a.preview}/loading_rom_{lg}_1920x1080.png')
            if lg == 'pt':
                shot(pg,f'{a.preview}/loading_rom_zoom_pt_1920x1080.png', clip={'x': o['cx'] - 220, 'y': o['cy'] - 60, 'width': 440, 'height': 120})
        frames_before = pg.evaluate('TMNTGFX.frames')
        check(f'[{lg}] no game frame drawn yet while loading', frames_before == 0, frames_before)
        if lg == 'pt': hold('audio_worklet.js')
        release('roms/tmnt.zip')
        pg.wait_for_function('TMNTG.ready', timeout=60000)
        t0 = time.time()
        while time.time() - t0 < 20 and pg.evaluate('TMNTG.frame()') < 2: time.sleep(0.05)
        gone = pg.evaluate("!document.getElementById('tmntload') && TMNTLOADING.finished")
        st = pg.evaluate('({frames: TMNTGFX.frames, ready: TMNTG.ready, log: TMNTLOADING.log, audio: !!(TMNTG.audio && TMNTG.audio.ready)})')
        check(f'[{lg}] overlay gone after the first drawn frame' + (' even though the audio worklet is still held' if lg == 'pt' else ''), gone and st['frames'] >= 1 and (lg != 'pt' or not st['audio']), st)
        check(f'[{lg}] stage sequence (local ROM)', st['log'] == ['video', 'engine', 'rom', 'romcheck', 'machine', 'sound'], st['log'])
        if lg == 'pt':
            # the 'sound' stage is real: the worklet module is requested while the overlay was still allowed to show; release and see audio come up
            release('audio_worklet.js'); pg.wait_for_function('TMNTG.audio && TMNTG.audio.ready', timeout=20000)
            check('audio worklet still comes up after the overlay is gone', True)
        pg.context.close()
    # ---------- 3) IndexedDB cache path (no local roms/tmnt.zip) ----------
    pg = newpage(); pg.goto(f'{B}/index.html?sound=0'); pg.wait_for_function('TMNTG.ready', timeout=60000)
    pg.evaluate("""async () => { const raw = await TMNTLOAD.extractRaw(await (await fetch('roms/tmnt.zip')).arrayBuffer());
      await new Promise((ok, ko) => { const r = indexedDB.open('tmnt', 1); r.onupgradeneeded = () => r.result.createObjectStore('roms'); r.onerror = () => ko(r.error);
        r.onsuccess = () => { const tx = r.result.transaction('roms', 'readwrite'); tx.objectStore('roms').put(raw, 'raw'); tx.oncomplete = () => { r.result.close(); ok(); }; tx.onerror = () => ko(tx.error); }; }); }""")
    pg.goto(f'{B}/norom/index.html?lang=en&sound=0'); pg.wait_for_function('TMNTG.ready', timeout=60000)
    time.sleep(1)
    st = pg.evaluate("({log: TMNTLOADING.log, picker: !!document.getElementById('romload'), ov: !!document.getElementById('tmntload'), frame: TMNTG.frame()})")
    check('IndexedDB cache path: stages video, engine, rom, romcache, romcheck, machine (no picker, overlay removed)', st['log'] == ['video', 'engine', 'rom', 'romcache', 'romcheck', 'machine'] and not st['picker'] and not st['ov'] and st['frame'] > 0, st)
    # ---------- 4) no local zip, no cache: the picker is shown and the overlay hides itself ----------
    pg2 = newpage(); pg2.goto(f'{B}/norom/index.html?lang=pt&sound=0', wait_until='commit')
    pg2.wait_for_selector('#romload', timeout=30000); time.sleep(0.5)
    st = pg2.evaluate("({ov: (() => { const e = document.getElementById('tmntload'); return e ? getComputedStyle(e).display : 'gone'; })(), log: TMNTLOADING.log, frames: TMNTGFX.frames})")
    check('ROM picker open: loading overlay hidden (never on top of the dialog), no game frame yet', st['ov'] in ('none', 'gone') and st['log'][-1] == 'romcache' and st['frames'] == 0, st)
    if a.preview: shot(pg2,f'{a.preview}/loading_picker_hidden_pt_1920x1080.png')
    pg2.context.close()
    # ---------- 5) errors: same box, same place, they stay ----------
    pg = newpage(); BAD.add('sim/m68k.js'); pg.goto(f'{B}/index.html?lang=pt&sound=0', wait_until='commit')
    o = wait_ov(pg, lambda o: 'm68k' in o['text'], 30); time.sleep(3); o2 = pg.evaluate(OV)
    check('script load error: shown in the overlay box with the file name, white 15px/600 style, centred, still there 3 s later', o and o2 and 'sim/m68k.js' in o2['text'] and o2['text'].startswith('Falha ao carregar o arquivo') and centred(o2) and o2['color'] == 'rgb(255, 255, 255)' and o2['font'] == '15px/600' and o2['bg'] == 'rgba(0, 0, 0, 0.6)' and o2['dots'] == [], o2 and (o2['text'], o2['cls']))
    if a.preview: shot(pg,f'{a.preview}/loading_error_script_pt_1920x1080.png')
    BAD.discard('sim/m68k.js'); pg.context.close()
    pg = newpage(); pg.goto(f'{B}/bad/index.html?lang=en&sound=0', wait_until='commit')
    o = wait_ov(pg, lambda o: 'boom' in o['text'], 30); time.sleep(2); o2 = pg.evaluate(OV)
    check('boot() error: "Load error: ROM boom test" in the same box, centred, stays, no dots', o2 and o2['text'] == 'Load error: ROM boom test' and centred(o2) and o2['dots'] == [] and not pg.evaluate('TMNTLOADING.finished'), o2 and o2['text'])
    if a.preview: shot(pg,f'{a.preview}/loading_error_boot_en_1920x1080.png')
    pg.context.close()
    # ---------- 6) stays centred through resizes, other window shapes, gfx modes, fullscreen ----------
    pg = newpage(); hold('roms/tmnt.zip'); pg.goto(f'{B}/index.html?lang=pt&sound=0', wait_until='commit'); wait_ov(pg, lambda o: o['st'] == 'rom')
    res = []
    for (w, h) in ((1280, 720), (800, 900), (1100, 700), (2560, 1080), (640, 480), (1920, 1080)):
        pg.set_viewport_size({'width': w, 'height': h}); time.sleep(0.4); o = pg.evaluate(OV)
        res.append((w, h, centred(o), round(o['cx'] - o['sx'], 2), round(o['cy'] - o['sy'], 2), round(o['sw']))); 
        if a.preview and (w, h) == (2560, 1080): shot(pg,f'{a.preview}/loading_size_2560x1080_pt.png')
        if a.preview and (w, h) == (800, 900): shot(pg,f'{a.preview}/loading_size_800x900_pt.png')
    check('centred on the canvas after every resize (1280x720, 800x900, 1100x700, 2560x1080, 640x480, back to 1920x1080)', all(r[2] for r in res), res)
    # fullscreen (real, when the headless browser grants it from a key press)
    pg.evaluate("document.addEventListener('keydown', e => { if (e.key === 'f') document.documentElement.requestFullscreen().catch(x => window.__fserr = String(x)); }, true)")
    pg.keyboard.press('f'); time.sleep(1.0)
    fs = pg.evaluate('!!document.fullscreenElement'); o = pg.evaluate(OV)
    if fs:
        check('real fullscreen: overlay centred on the canvas', centred(o), {k: round(o[k], 1) for k in ('cx', 'cy', 'sx', 'sy', 'sw')})
        if a.preview: shot(pg,f'{a.preview}/loading_fullscreen_pt_1920x1080.png')
        pg.evaluate('document.exitFullscreen()'); time.sleep(0.6); o = pg.evaluate(OV)
        check('after leaving fullscreen: still centred', centred(o))
    else:
        print('NOTE: headless Chromium refused real fullscreen:', pg.evaluate('window.__fserr'))
    for mode in ('crt', 'orig'):
        pg.evaluate(f"TMNTGFX.set('{mode}')"); time.sleep(0.3); o = pg.evaluate(OV)
        check(f'?gfx={mode} layout: centred on the canvas', centred(o), o and {k: round(o[k], 1) for k in ('cx', 'cy', 'sx', 'sy', 'sw')})
        if a.preview and mode == 'crt': shot(pg,f'{a.preview}/loading_gfx_crt_pt_1920x1080.png')
    pg.evaluate("TMNTGFX.set('bezel')")
    release('roms/tmnt.zip'); pg.wait_for_function('TMNTG.ready', timeout=60000); time.sleep(0.5)
    check('after the first frame the overlay is gone also after layout changes', pg.evaluate("!document.getElementById('tmntload')"))
    pg.context.close()
    # ---------- 7) ?pause=1 (tests): nothing to wait for, overlay removed at ready ----------
    pg = newpage(); pg.goto(f'{B}/index.html?pause=1&sound=0'); pg.wait_for_function('TMNTG.ready', timeout=60000)
    check('?pause=1: overlay removed at ready (no frame is drawn until runTo)', pg.evaluate("!document.getElementById('tmntload')"))
    pg.context.close(); br.close()
print('page errors:', errors[:5])
check('no unexpected page errors', not [e for e in errors if 'boom' not in e])
print('FAIL: ' + ', '.join(fails) if fails else 'ALL PASS'); sys.exit(1 if fails else 0)
