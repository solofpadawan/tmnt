"""Shared Playwright helpers: serve web/, open index.html in headless Chromium, load roms/tmnt.zip via the ROM picker
(first visit) or the IndexedDB cache. ROMs stay local."""
import os, threading, functools, http.server, contextlib
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(ROOT, 'roms/tmnt.zip')

@contextlib.contextmanager
def page(query='', viewport=(1920, 1080), args=()):
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    h = functools.partial(Q, directory=os.path.join(ROOT, 'web'))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', *args])
            ctx = b.new_context(viewport={'width': viewport[0], 'height': viewport[1]})
            pg = ctx.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.base = 'http://127.0.0.1:%d/index.html' % srv.server_port
            pg.goto(pg.base + query)
            yield pg
            if pg.errs: raise SystemExit('page errors: %s' % pg.errs)
            b.close()
    finally:
        srv.shutdown()

def load(pg, timeout=60000):
    """first visit: pick the zip in the overlay; returns once TMNTG.ready"""
    pg.wait_for_function("document.getElementById('zip') || (window.TMNTG && TMNTG.ready)", timeout=timeout)
    if not pg.evaluate('TMNTG.ready'): pg.set_input_files('#zip', ZIP)
    pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=timeout)
