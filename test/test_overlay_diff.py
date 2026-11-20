#!/usr/bin/env python3
"""Pixel-identical overlay/panel vs the live 20261109-roomname-1239 build, plus F7 patchPanel==render and a cheap
per-frame cost sample (idle skip vs always-clear). Headless Chromium, deviceScaleFactor=1."""
import argparse, os, sys, time, socket, subprocess, json, struct, zlib
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('after')
ap.add_argument('--before', default='/workspace/tmnt-roomname-20261109-roomname-1239/stage')
ap.add_argument('--preview', default='')
a = ap.parse_args()
PREV = a.preview
if PREV:
    os.makedirs(PREV, exist_ok=True)

def png_bytes(b64):
    import base64
    return base64.b64decode(b64.split(',', 1)[1] if ',' in b64 else b64)

def png_diff(a, b):
    """Return (equal, extra) comparing raw PNG bytes first, then pixels if needed."""
    if a == b:
        return True, 'identical bytes'
    if len(a) == len(b):
        # still report pixel mismatch if encodings differ
        pass
    def decode(png):
        # use PIL if present, else a tiny parser for RGBA IHDR+IDAT
        try:
            from PIL import Image
            import io
            im = Image.open(io.BytesIO(png)).convert('RGBA')
            return im.size, im.tobytes()
        except Exception:
            return None, None
    sa, pa = decode(a); sb, pb = decode(b)
    if pa is not None and pa == pb and sa == sb:
        return True, 'identical pixels (compressed PNG differed)'
    if pa is None:
        return False, f'different bytes ({len(a)} vs {len(b)}), no PIL to compare pixels'
    if sa != sb:
        return False, f'size {sa} vs {sb}'
    n = sum(1 for i in range(0, len(pa), 4) if pa[i:i+4] != pb[i:i+4])
    return False, f'{n} pixels differ of {len(pa)//4}'

SETUP = r"""() => {
  TMNTG.pause(true);
  if (window.TMNTHINT) TMNTHINT.off = true;
  const w = TMNTG.machine.wram;
  w[1] = 2; // playing
  const pos = [[120, 160], [180, 150], [80, 190], [240, 170]];
  for (let p = 0; p < 4; p++) {
    const o = 0x2000 + 0x50 * p;
    const set = (off, v) => { w[off] = (v >> 8) & 0xff; w[off + 1] = v & 0xff; };
    set(o, 0x8001);
    set(o + 12, pos[p][0] + 96);
    set(o + 14, 240 - pos[p][1]);
  }
  const names = ['Leo', 'Mike', 'Don', 'Raph'];
  const fake = { rb: {}, names: () => names, namesGen: 7, slot: 0, spec: false,
    spectators: () => [], peers: () => [] };
  const P = window.TMNTNETPLAY || (window.TMNTNETPLAY = {});
  window.__ovSessDesc = Object.getOwnPropertyDescriptor(P, 'session');
  Object.defineProperty(P, 'session', { configurable: true, enumerable: true, get: () => window.__ovUseFake !== false ? fake : (window.__ovSessDesc && window.__ovSessDesc.get ? window.__ovSessDesc.get.call(P) : window.__ovSessDesc && window.__ovSessDesc.value) });
  window.__ovFake = fake; window.__ovUseFake = true;
  const now = performance.now();
  TMNTCHAT.bubbles[0] = { text: 'Cowabunga!', t0: now - 1000, dur: 8000 };
  TMNTCHAT.bubbles[1] = { text: 'Bora, parceiro! Vamos nessa', t0: now - 1000, dur: 8000 };
  TMNTCHAT.bubbles[2] = null; TMNTCHAT.bubbles[3] = null;
  TMNTCHAT.specLines.length = 0;
  TMNTCHAT.draw(TMNTG.machine);
  return true;
}"""

SHOTS = r"""kind => {
  const fake = window.__ovFake;
  const now = performance.now();
  if (kind === 'balloon') {
    fake.spec = false;
    TMNTCHAT.bubbles[0] = { text: 'Cowabunga!', t0: now - 1000, dur: 8000 };
    TMNTCHAT.bubbles[1] = { text: 'Bora, parceiro! Vamos nessa', t0: now - 1000, dur: 8000 };
    TMNTCHAT.specLines.length = 0;
  } else if (kind === 'nicks') {
    fake.spec = false;
    TMNTCHAT.bubbles[0] = TMNTCHAT.bubbles[1] = TMNTCHAT.bubbles[2] = TMNTCHAT.bubbles[3] = null;
    TMNTCHAT.specLines.length = 0;
  } else if (kind === 'spec') {
    fake.spec = true;
    TMNTCHAT.bubbles[0] = TMNTCHAT.bubbles[1] = TMNTCHAT.bubbles[2] = TMNTCHAT.bubbles[3] = null;
    TMNTCHAT.specLines.length = 0;
    TMNTCHAT.specLines.push({ name: 'Fan 1', text: 'Vamos tartarugas!', t0: now - 1000, dur: 8000 });
  }
  TMNTCHAT.draw(TMNTG.machine);
  return document.getElementById('chatov').toDataURL('image/png');
}"""

COST = r"""() => {
  const fake = window.__ovFake;
  fake.spec = false;
  TMNTCHAT.bubbles[0] = TMNTCHAT.bubbles[1] = TMNTCHAT.bubbles[2] = TMNTCHAT.bubbles[3] = null;
  TMNTCHAT.specLines.length = 0;
  const st = TMNTCHAT.stats || null;
  const base = st ? Object.assign({}, st) : null;
  TMNTCHAT.draw(TMNTG.machine); // first idle: should clear once on after
  const t0 = performance.now();
  const N = 180;
  for (let i = 0; i < N; i++) TMNTCHAT.draw(TMNTG.machine);
  const ms = performance.now() - t0;
  // nicks path
  const t1 = performance.now();
  for (let i = 0; i < N; i++) { /* names stay, positions fixed */ TMNTCHAT.draw(TMNTG.machine); }
  // that second loop is still idle (no nicks? wait, nicks are on if names exist)
  // actually after clearing bubbles, nicks SHOULD paint every frame. Reset by drawing nicks in a third loop.
  const tNick0 = performance.now();
  for (let i = 0; i < N; i++) TMNTCHAT.draw(TMNTG.machine);
  return { msIdleFirst: ms, n: N, stats: st ? Object.assign({}, st) : null, base, hasStats: !!st };
}"""

# The COST script as written is messy because after first idle clear, nicks still need paint
# (names + player pos). That's correct: idle-only is attract without names. Let's measure
# both "no session names" idle and "nicks on" in a cleaner evaluate later.

fails = []
ok = lambda c, m: (print(('PASS ' if c else 'FAIL ') + m, flush=True), c)[1] or fails.append(m) or c

def serve(root):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    proc = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', root],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.6)
    return proc, f'http://127.0.0.1:{port}/index.html'

def boot(p, url):
    args = ['--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1',
            '--disable-background-timer-throttling', '--use-gl=angle', '--use-angle=swiftshader']
    b = p.chromium.launch(args=args)
    ctx = b.new_context(viewport={'width': 1100, 'height': 700}, device_scale_factor=1, locale='pt-BR')
    pg = ctx.new_page()
    pg.add_init_script('try { localStorage.setItem("tmnt_nick","Leo"); localStorage.setItem("tmnt_public","1"); } catch(e) {}')
    pg.goto(url + '?sound=0&lang=pt')
    pg.evaluate('TMNTG.whenReady')
    pg.evaluate(SETUP)
    return b, pg

shots = {}
costs = {}
with sync_playwright() as p:
    pages = {}
    browsers = {}
    servers = []
    for label, root in [('before', a.before), ('after', a.after)]:
        srv, base = serve(root); servers.append(srv)
        b, pg = boot(p, base)
        browsers[label] = b; pages[label] = pg
        for kind in ('balloon', 'nicks', 'spec'):
            data = pg.evaluate(SHOTS, kind)
            shots[f'{label}_{kind}'] = data
            raw = png_bytes(data)
            if PREV:
                path = os.path.join(PREV, f'overlay_{label}_{kind}.png')
                open(path, 'wb').write(raw)
        # F7 empty / create panel (stub the live room list; opaque bg so the game does not composite through)
        pg.evaluate('''() => {
          TMNTNET.listRooms = async () => [];
          const box = document.getElementById("np");
          box.style.background = "#041208";
        }''')
        if pg.evaluate('document.getElementById("np").style.display === "block"'):
            pg.keyboard.press('F7'); time.sleep(0.1)
        pg.keyboard.press('F7')
        pg.wait_for_function('document.getElementById("np").style.display === "block"', timeout=5000)
        # refreshList is kicked by show(); wait until the stubbed empty list is painted
        pg.wait_for_function('!!document.querySelector("#np-list") && document.querySelector("#np-list").innerText.length > 0', timeout=5000)
        time.sleep(0.15)
        el = pg.locator('#np')
        png = el.screenshot(type='png')
        shots[f'{label}_f7empty'] = png
        if PREV:
            open(os.path.join(PREV, f'f7_{label}_empty.png'), 'wb').write(png)

    # pixel compare overlay + empty F7
    for kind, title in [('balloon', 'chat balloons'), ('nicks', 'nicknames'), ('spec', 'spectator tag + line'), ('f7empty', 'F7 empty panel')]:
        ba, bb = shots[f'before_{kind}'], shots[f'after_{kind}']
        if kind != 'f7empty':
            ba, bb = png_bytes(ba), png_bytes(bb)
        eq, why = png_diff(ba, bb)
        ok(eq, f'{title}: {why}')

    # after: patchPanel vs render (in-room host, no guest — structure is 4 free slots + you)
    pg = pages['after']
    # leave overlay fake session so host() can install a real one
    pg.evaluate("""() => {
      window.__ovUseFake = false;
      const P = TMNTNETPLAY, d = window.__ovSessDesc;
      if (d) Object.defineProperty(P, 'session', d);
      TMNTG.pause(false);
    }""")
    # Don't actually open a Worker room if we can render from a stub. Use exposed render after a real host
    # would need network. Instead, call patchPanel/render only if present and we host a PRIVATE unique room.
    has = pg.evaluate('typeof TMNTNETPLAY.patchPanel === "function" && typeof TMNTNETPLAY.render === "function"')
    ok(has, 'after exposes patchPanel and render')
    if has:
        import time as _t
        room = 'PERF-%d' % (int(_t.time()) % 100000)
        pg.evaluate('n => TMNTNETPLAY.host(false, n)', room)
        pg.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.state && TMNTNETPLAY.state.role === "host"', timeout=30000)
        time.sleep(0.4)
        if pg.evaluate('document.getElementById("np").style.display !== "block"'):
            pg.keyboard.press('F7'); time.sleep(0.2)
        pg.evaluate('document.getElementById("np").style.background = "#041208"')
        pg.evaluate('TMNTNETPLAY.render()')
        time.sleep(0.05)
        a1 = pg.locator('#np').screenshot(type='png')
        pg.evaluate('TMNTNETPLAY.patchPanel()')
        a2 = pg.locator('#np').screenshot(type='png')
        eq, why = png_diff(a1, a2)
        ok(eq, f'F7 patchPanel vs render: {why}')
        if PREV:
            open(os.path.join(PREV, 'f7_after_render.png'), 'wb').write(a1)
            open(os.path.join(PREV, 'f7_after_patch.png'), 'wb').write(a2)
        html1 = pg.evaluate('document.getElementById("np").innerHTML')
        pg.evaluate('TMNTNETPLAY.patchPanel()')
        html2 = pg.evaluate('document.getElementById("np").innerHTML')
        ok(html1 == html2, 'F7 patchPanel innerHTML equals previous render' if html1 == html2 else 'F7 innerHTML changed after patchPanel')
        try:
            pg.evaluate('TMNTNETPLAY.leave()')
        except Exception:
            pass

    # cost: idle without names (no session rb) on both
    COST2 = """() => {
      TMNTG.pause(true);
      if (window.TMNTHINT) TMNTHINT.off = true;
      const P = window.TMNTNETPLAY;
      const hold = P && P.session;
      try { Object.defineProperty(P, 'session', { configurable: true, get: () => null }); } catch (e) {}
      TMNTCHAT.bubbles[0] = TMNTCHAT.bubbles[1] = TMNTCHAT.bubbles[2] = TMNTCHAT.bubbles[3] = null;
      TMNTCHAT.specLines.length = 0;
      const st = TMNTCHAT.stats;
      if (st) { st.draws = 0; st.skips = 0; st.clears = 0; }
      TMNTCHAT.draw(TMNTG.machine);
      const N = 240, t0 = performance.now();
      for (let i = 0; i < N; i++) TMNTCHAT.draw(TMNTG.machine);
      const ms = performance.now() - t0;
      return { n: N, ms, per: ms / N, stats: st ? { draws: st.draws, skips: st.skips, clears: st.clears } : null };
    }"""
    for label in ('before', 'after'):
        costs[label] = pages[label].evaluate(COST2)
        print('COST', label, json.dumps(costs[label]), flush=True)
    if costs['after'].get('stats') and costs['after']['stats']['skips'] > 200:
        ok(True, 'after idle path skipped %s/%s frames' % (costs['after']['stats']['skips'], costs['after']['n']))
    else:
        # before has no stats; after must skip
        ok(bool(costs['after'].get('stats') and costs['after']['stats']['skips'] > 0),
           'after reports idle skips (stats=%s)' % costs['after'].get('stats'))

    for b in browsers.values():
        b.close()
    for srv in servers:
        srv.terminate()

open(os.path.join(PREV or '/tmp', 'overlay_cost.json'), 'w').write(json.dumps(costs, indent=2))
print('FAILS', fails)
print('PASS' if not fails else 'FAIL')
sys.exit(0 if not fails else 1)
