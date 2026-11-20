#!/usr/bin/env python3
"""2p/4p netplay desync + tap test with spectators. Production Cloudflare Worker, loopback WebRTC, ?netsim.
Usage: python3 test_desync_spec.py WEB --players 2 --spectators 2 --secs 20 --taps 4
Exit 0 only if 0 desyncs, 0 lost taps, spectators stay in spec mode and advance frames."""
import argparse, os, sys, json, time, functools, http.server, threading
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web')
ap.add_argument('--players', type=int, default=2); ap.add_argument('--spectators', type=int, default=2)
ap.add_argument('--rtt', type=float, default=50); ap.add_argument('--secs', type=float, default=20)
ap.add_argument('--taps', type=int, default=4); ap.add_argument('--warm', type=float, default=8)
ap.add_argument('--sound', action='store_true', help='keep the audio on (default: ?sound=0); spectators then must post the spectator FIFO config to the worklet (TMNTG.specAudio)')
ap.add_argument('--tag', default=''); ap.add_argument('--out', default=''); ap.add_argument('--preview', default='')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *x): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=a.web)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}/index.html'
ROOM = 'SPEC-%d-%d' % (os.getpid() % 10000, int(time.time()) % 1000)
lat = a.rtt / 2; SIM = f'{lat:g},{round(lat * 0.1, 1):g},0'
INSTR = """() => {
  const I = TMNTIN; const B = window.__bs = { coin: false, fire: false, play: false, tap: false };
  const M = window.__m = { fi: new Map(), logFi: false };
  let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0;
  I.sample = () => { const o = new Uint8Array(4);
    if (B.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    if (B.coin || B.tap) o[0] |= I.COIN; if (B.fire) o[0] |= I.ATTACK; return o; };
  const S = TMNTSESSION.Session.prototype, ot = S.tick;
  S.tick = function (local) {
    if (this.rb && M.logFi && !this.rb.__w) { this.rb.__w = 1; const os = this.rb.step; this.rb.step = (fi, f) => { M.fi.set(f, fi[0] + ',' + fi[1] + ',' + fi[2] + ',' + fi[3]); return os.call(this.rb, fi, f); }; }
    return ot.call(this, local);
  };
  M.start = () => { M.logFi = true; M.fi.clear(); };
}"""
WRAP_WATCH = """() => {
  const S = TMNTSESSION.Session;
  const W = function (o) { o.watch = 1; return new S(o); };
  W.prototype = S.prototype; Object.assign(W, S); TMNTSESSION.Session = W;
}"""
STATS = """() => { const N = TMNTNETPLAY.session; if (!N || !N.rb) return null;
  return { slot: N.slot, spec: !!N.spec, frame: N.rb.frame, confirmed: N.rb.confirmed,
    desyncs: N.stats.desyncs, specDesyncs: N.stats.specDesyncs, hashChecks: N.stats.hashChecks,
    specHashChecks: N.stats.specHashChecks, resyncs: N.stats.resyncs,
    playout: N.specBuf ? N.specBuf() : null, specAudio: !!TMNTG.specAudio, audioReady: !!(TMNTG.audio && TMNTG.audio.ready) }; }"""
res = {'args': vars(a), 'room': ROOM, 'errors': []}
fails = []
t00 = time.time()
nP, nS = a.players, a.spectators; n = nP + nS
with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    bs = [p.chromium.launch(args=args) for _ in range(n)]; pages = []
    for i, b in enumerate(bs):
        ctx = b.new_context(viewport={'width': 800, 'height': 600}, locale='en-US'); pg = ctx.new_page()
        nick = ('spec%d' % (i - nP + 1)) if i >= nP else ('play%d' % (i + 1))
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", "{nick}"); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: res['errors'].append(f'page {i}: {e}'))
        pages.append(pg)
    q = f'noturn=1&netsim={SIM}' + ('' if a.sound else '&sound=0')
    h = pages[0]; h.goto(f'{BASE}?{q}'); h.evaluate('TMNTG.whenReady'); h.evaluate(INSTR)
    time.sleep(1.5)
    h.evaluate('([p, n]) => TMNTNETPLAY.host(p, n)', [False, ROOM])
    h.wait_for_function('TMNTNETPLAY.session', timeout=30000)
    room = h.evaluate('TMNTNETPLAY.state.room'); res['room'] = room
    def pulse(pg, k, ms): pg.evaluate('([k, ms]) => __bs.pulse ? __bs.pulse(k, ms) : ((__bs[k]=true), setTimeout(()=>__bs[k]=false, ms))', [k, ms])
    def join_game(pg):
        pulse(pg, 'coin', 100); time.sleep(0.8); pulse(pg, 'fire', 100); time.sleep(0.5); pulse(pg, 'fire', 100); time.sleep(0.4)
    join_game(h); h.evaluate('__bs.play = true'); time.sleep(2)
    for i in range(1, nP):
        g = pages[i]; g.goto(f'{BASE}?{q}&sala={room.lower()}'); g.evaluate('TMNTG.whenReady'); g.evaluate(INSTR)
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=60000)
        join_game(g); g.evaluate('__bs.play = true'); time.sleep(0.8)
    for i in range(nP, n):
        g = pages[i]; g.goto(f'{BASE}?{q}'); g.evaluate('TMNTG.whenReady'); g.evaluate(WRAP_WATCH); g.evaluate(INSTR)
        g.evaluate('r => TMNTNETPLAY.join(r, true)', room)
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.spec === true', timeout=60000)
        time.sleep(0.3)
    print(f'[{time.time()-t00:5.1f}s] {nP}p+{nS}spec in {room}, warm {a.warm}s', flush=True)
    time.sleep(a.warm)
    st0 = [pg.evaluate(STATS) for pg in pages]
    res['slots0'] = st0
    print('slots', st0, flush=True)
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
        try:
            pages[0].keyboard.press('F7'); time.sleep(0.3)
            pages[0].screenshot(path=os.path.join(a.preview, 'desync_%s_host.png' % (a.tag or f'{nP}p{nS}s')))
        except Exception:
            pass
    for i in range(nP):
        pages[i].evaluate('__m.start()')
    time.sleep(a.secs)
    # taps on seated players only
    sent = [0] * nP
    lastTapFrame = 0
    for r in range(a.taps):
        for i in range(nP):
            pages[i].evaluate('ms => { __bs.tap = true; setTimeout(() => { __bs.tap = false; }, ms); }', 50)
            sent[i] += 1
            lastTapFrame = max(lastTapFrame, pages[i].evaluate('TMNTNETPLAY.session.rb.frame'))
            time.sleep(1.2)
    t1 = time.time()
    while time.time() - t1 < 45:
        conf = [pg.evaluate('TMNTNETPLAY.session.rb.confirmed') for pg in pages]
        if min(conf) >= lastTapFrame + 60:
            break
        time.sleep(0.4)
    res['tapSettleS'] = round(time.time() - t1, 1)
    COIN = int(pages[0].evaluate('TMNTIN.COIN'))
    fin = [pg.evaluate(STATS) for pg in pages]
    res['final'] = fin
    # count coin runs on player pages from logged frames
    got = [pages[i].evaluate('({ c: TMNTNETPLAY.session.rb.confirmed, fi: Array.from(__m.fi.entries()) })') for i in range(nP)]
    maps = [dict((f, v) for f, v in x['fi']) for x in got]
    mins = min(x['c'] for x in got)
    def runs(m, slot):
        c = 0; prev = False
        for f in sorted(m):
            if f > mins: break
            on = bool(int(m[f].split(',')[slot]) & COIN)
            if on and not prev: c += 1
            prev = on
        return c
    slots = [st0[i]['slot'] for i in range(nP)]
    seen = [[runs(m, s) for s in slots] for m in maps]
    lost = [max(0, sent[i] - min(seen[j][i] for j in range(nP))) for i in range(nP)]
    res['tap'] = {'sent': sent, 'seen': seen, 'lost': lost, 'common': sum(1 for f in maps[0] if f <= mins)}
    for pg in reversed(pages):
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception: pass
        time.sleep(0.3)
    time.sleep(1)
    for b in bs: b.close()
srv.shutdown()
res['wall'] = time.time() - t00
print('final', json.dumps(fin, default=str), flush=True)
print('tap', json.dumps(res['tap']), flush=True)
print('errors', res['errors'][:5], flush=True)

def fail(m):
    fails.append(m); print('FAIL', m, flush=True)

if res['errors']:
    fail('page errors: %s' % res['errors'][:3])
if not all(fin):
    fail('missing stats')
else:
    players, specs = fin[:nP], fin[nP:]
    if any(x['spec'] for x in players):
        fail('a player is in spectator mode: %s' % players)
    if any(not x['spec'] or x['slot'] != -1 for x in specs):
        fail('a spectator is not in spec mode: %s' % specs)
    des = sum(x['desyncs'] for x in fin) + sum(x.get('specDesyncs') or 0 for x in fin)
    if des:
        fail('desyncs=%s (players %s spec %s)' % (des, [x['desyncs'] for x in players], [x.get('specDesyncs') for x in fin]))
    if any(x['frame'] < 80 for x in fin):
        fail('frames did not advance: %s' % [x['frame'] for x in fin])
    # spectator playout buffer (net/session.js): spectators run it, players / host never have one; with sound on, only spectators got the spectator FIFO config
    if any(not x.get('playout') for x in specs):
        fail('a spectator has no playout buffer: %s' % [x.get('playout') for x in specs])
    if any(x.get('playout') for x in players):
        fail('a player/host has a playout buffer: %s' % [x.get('playout') for x in players])
    if a.sound:
        if any(not x['audioReady'] for x in fin): fail('audio worklet not ready: %s' % [x['audioReady'] for x in fin])
        if any(not x['specAudio'] for x in specs): fail('spectator worklet not switched to the spectator FIFO: %s' % [x['specAudio'] for x in specs])
        if any(x['specAudio'] for x in players): fail('a player worklet got the spectator FIFO: %s' % [x['specAudio'] for x in players])
    print('playout', json.dumps([x.get('playout') for x in specs]), flush=True)
    # guests send hashes; the host is the one that records hashChecks
    if players[0]['hashChecks'] < 1:
        fail('host had no hash checks: %s' % players[0])
    if sum(lost):
        fail('lost taps %s sent %s seen %s' % (lost, sent, seen))
if a.out:
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    json.dump(res, open(a.out, 'w'), indent=1)
print('PASS' if not fails else 'FAIL', a.tag or f'{nP}p+{nS}spec', 'wall=%.1fs' % res['wall'])
sys.exit(0 if not fails else 1)
