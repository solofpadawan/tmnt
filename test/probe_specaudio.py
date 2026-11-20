#!/usr/bin/env python3
"""Exploratory: spectator audio output in various autoplay / join modes. Private rooms only."""
import argparse, os, sys, json, time, functools, http.server, threading
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--mode', default='autoplay')
a = ap.parse_args()
HOLD = threading.Event(); HOLD.set()  # set = not holding
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *x): pass
    def do_GET(self):
        if self.path.startswith('/audio_worklet.js'): HOLD.wait(60)
        return super().do_GET()
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=a.web)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}/index.html'
HOOK = '''() => { const b = TMNTG.board; if (!b || window.__rec) return 'no'; const R = window.__rec = new Map(); const o = b.render.bind(b);
  b.render = (buf, len, z) => { const n = o(buf, len, z); let e = 0; for (let i = 0; i < n; i++) e += buf[i] * buf[i]; R.set(z, Math.round(e * 1e4)); return n; }; return 'ok'; }'''
INSTR = """() => { const I = TMNTIN; const B = window.__bs = { coin: false, fire: false, play: false };
  let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0;
  I.sample = () => { const o = new Uint8Array(4);
    if (B.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    if (B.coin) o[0] |= I.COIN; if (B.fire) o[0] |= I.ATTACK; return o; }; }"""
PROBE = """() => { const A = TMNTG.audio; if (!A || !A.ac) return 'noaudio'; const ac = A.ac;
  if (window.__pr) return 'already';
  const an = ac.createAnalyser(); an.fftSize = 2048; A.duck.connect(an);
  const buf = new Float32Array(2048); const P = window.__pr = { max: 0, win: 0, nz: 0, n: 0 };
  setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); P.n++; if (m > 1e-4) P.nz++; P.max = Math.max(P.max, m); P.win = m; }, 60);
  return 'ok'; }"""
SNAP = """() => { const A = TMNTG.audio, P = window.__pr || {}, N = TMNTNETPLAY.session, h = document.getElementById('sndhint');
  return { ac: A && A.ac ? A.ac.state : null, ready: !!(A && A.ready), duck: A && A.duck ? +A.duck.gain.value.toFixed(3) : null, specAudio: TMNTG.specAudio,
    hint: !!(h && getComputedStyle(h).display !== 'none'), max: +(P.max || 0).toFixed(4), nz: P.nz, n: P.n, win: +(P.win || 0).toFixed(4),
    spec: N ? !!N.spec : null, frame: N && N.rb ? N.rb.frame : null }; }"""
def reset(pg): pg.evaluate('() => { if (window.__pr) { __pr.max = 0; __pr.nz = 0; __pr.n = 0; } }')
with sync_playwright() as p:
    ok = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    blocked = [x for x in ok if 'autoplay' not in x] + ['--autoplay-policy=document-user-activation-required']
    hb = p.chromium.launch(args=ok); sb = p.chromium.launch(args=ok)
    h = hb.new_context(viewport={'width': 800, 'height': 600}).new_page()
    h.add_init_script('try { localStorage.setItem("tmnt_nick","host"); localStorage.setItem("tmnt_public","0") } catch (e) {}')
    sc = sb.new_context(viewport={'width': 1280, 'height': 720}); s = sc.new_page()
    s.add_init_script('try { localStorage.setItem("tmnt_nick","spec"); localStorage.setItem("tmnt_public","0") } catch (e) {}')
    s.on('console', lambda m: print('  [spec console]', m.text[:150]) if m.type in ('warning', 'error') else None)
    q = 'noturn=1&netsim=25,2.5,0'
    h.goto(f'{BASE}?{q}'); h.evaluate('TMNTG.whenReady'); h.evaluate(INSTR); time.sleep(1.5)
    ROOM = 'SA-%d-%d' % (os.getpid() % 10000, int(time.time()) % 1000)
    h.evaluate(HOOK)
    h.evaluate('([p, n]) => TMNTNETPLAY.host(p, n)', [False, ROOM]); h.wait_for_function('TMNTNETPLAY.session', timeout=30000)
    room = h.evaluate('TMNTNETPLAY.state.room')
    def pulse(k, ms): h.evaluate('([k, ms]) => { __bs[k] = true; setTimeout(() => __bs[k] = false, ms) }', [k, ms])
    pulse('coin', 100); time.sleep(0.8); pulse('fire', 100); time.sleep(0.5); pulse('fire', 100); time.sleep(0.4); h.evaluate('__bs.play = true'); time.sleep(3)
    print('host', h.evaluate(SNAP))
    if a.mode.startswith('url-hold'): HOLD.clear()
    if a.mode.startswith('url'):   # join via link, no gesture
        s.goto(f'{BASE}?{q}&sala={room.lower()}&assistir=1')
    elif a.mode == 'url-nowatch':
        s.goto(f'{BASE}?{q}&sala={room.lower()}')
    else:
        s.goto(f'{BASE}?{q}')
    s.evaluate('TMNTG.whenReady')
    if a.mode in ('autoplay', 'join-click', 'join-nogesture'):
        if a.mode == 'autoplay' or a.mode == 'join-nogesture':
            s.evaluate("""() => { const S = TMNTSESSION.Session, W = function (o) { o.watch = 1; return new S(o); }; W.prototype = S.prototype; Object.assign(W, S); TMNTSESSION.Session = W; }""")
            s.evaluate('r => TMNTNETPLAY.join(r, true)', room)
        else:
            s.keyboard.press('F7'); time.sleep(0.5)
    time.sleep(1)
    try:
        s.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=60000)
    except Exception as e:
        print('no session', e)
    if a.mode.startswith('url-hold'):
        time.sleep(float(os.environ.get("HOLDS","8"))); print("holding: worklet not loaded yet; state", s.evaluate(SNAP)); HOLD.set(); time.sleep(1.5)
    print('hook spec', s.evaluate(HOOK)); print('probe', s.evaluate(PROBE))
    for i in range(3):
        time.sleep(3); print(f't+{(i+1)*3}s', s.evaluate(SNAP)); 
    print('--- gesture (click on screen)')
    reset(s)
    s.mouse.click(400, 300)
    for i in range(3):
        time.sleep(2.5); print(f'after click t+{(i+1)*2.5}s', s.evaluate(SNAP)); 
    print('host', h.evaluate(SNAP))
    H = dict(h.evaluate('Array.from(__rec.entries())')); S = dict(s.evaluate('Array.from(__rec.entries())'))
    com = [k for k in S if k in H]; same = sum(1 for k in com if S[k] == H[k]); eS = sum(S[k] for k in com); eH = sum(H[k] for k in com)
    print('RENDER COMPARE: spec renders', len(S), 'host', len(H), 'common', len(com), 'identical', same, 'energy spec/host', eS, eH)
    s.screenshot(path=f'/tmp/probe_{a.mode}.png')
    for pg in (s, h):
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception: pass
    hb.close(); sb.close()
srv.shutdown()
