#!/usr/bin/env python3
"""Netplay smoothness benchmark (before/after), headless Chromium, one browser per player, real WebRTC over loopback,
signalling by the PRODUCTION Cloudflare Worker (private rooms named BENCH-*, removed at the end), latency simulated at
the transport (?netsim=lat,jit,0 on every page = the game's own link simulator, delays each send by lat +- jit ms; the
host's per-link sim is overridden for the slow player). RTT between two peers = 2 * lat (host <-> guest).
Usage: python3 test/test_netplay_bench.py WEB_DIR --players N --rtt MS [--slow MS] [--secs 45] [--taps 4] [--tag NAME] [--out FILE.json]
  --slow MS : the LAST guest has that RTT to the host, everybody else uses --rtt.
Metrics (measured only inside the window, after join + warm-up): stall episodes (consecutive Session.tick calls whose
rb.advance() was refused with no frame simulated; duration = first refused tick -> next tick that simulated), raw
rb.stats.stalls counter, effective FPS of the simulated frame counter (and of confirmed frames), worst 1 s FPS, input delay
in frames (rb.delay), rollbacks, state-hash desyncs (Session.stats.desyncs), committed-input mismatch between peers.
Tap test: after the window every player taps COIN for 50 ms, N times, 1.5 s apart; each peer counts COIN runs in the
committed inputs of every slot; a lost tap = fewer runs than sent."""
import argparse, os, sys, json, time, socket, subprocess, urllib.request, threading
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--players', type=int, default=2); ap.add_argument('--rtt', type=float, default=50)
ap.add_argument('--slow', type=float, default=0); ap.add_argument('--secs', type=float, default=45); ap.add_argument('--taps', type=int, default=4)
ap.add_argument('--tag', default=''); ap.add_argument('--out', default=''); ap.add_argument('--warm', type=float, default=12); ap.add_argument('--tapms', type=int, default=50); ap.add_argument('--preview', default='')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
UA = {'User-Agent': 'Mozilla/5.0'}
def lst():
    last = None
    for i in range(4):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers=UA), timeout=15))
        except Exception as e:
            last = e
            time.sleep(2)
    raise last
import functools, http.server
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *x): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=a.web)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}/index.html'
ROOM = 'BENCH-%d-%d' % (os.getpid() % 10000, int(time.time()) % 1000)
def sim(rtt): lat = rtt / 2; return f'{lat:g},{round(lat * 0.1, 1):g},0'
INSTR = """() => {
  const S = TMNTSESSION.Session.prototype, I = TMNTIN;
  const M = window.__m = { eps: [], cur: null, samples: [], fi: new Map(), logFi: false, win: null, ticks: 0, tapCount: 0 };
  const B = window.__bs = { coin: false, fire: false, play: false, tap: false };
  let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0;
  I.sample = () => { const o = new Uint8Array(4);
    if (B.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    if (B.coin || B.tap) o[0] |= I.COIN; if (B.fire) o[0] |= I.ATTACK; return o; };
  const wrap = rb => { if (!rb || rb.__w) return; rb.__w = 1; const os = rb.step; rb.step = (fi, f) => { if (M.logFi) M.fi.set(f, fi[0] + ',' + fi[1] + ',' + fi[2] + ',' + fi[3]); return os.call(rb, fi, f); }; };
  const orig = S.tick;
  S.tick = function (local) {
    wrap(this.rb); const s0 = this.rb ? this.rb.stats.stalls : 0, t = performance.now();
    const done = orig.call(this, local); wrap(this.rb); M.ticks++;
    const s1 = this.rb ? this.rb.stats.stalls : 0, t1 = performance.now();
    if (this.rb && !this.spec) {
      if (done === 0 && s1 > s0) { if (!M.cur) M.cur = { t, n: 0 }; M.cur.n++; }
      else if (done > 0 && M.cur) { M.eps.push({ d: t1 - M.cur.t, n: M.cur.n, at: M.cur.t }); M.cur = null; }
    }
    return done;
  };
  setInterval(() => { const N = TMNTNETPLAY.session; if (!N || !N.rb) return; const r = N.rb.stats, p = N.peers(); let rt = 0; for (const q of p) if (q.rtt > rt) rt = q.rtt;
    M.samples.push({ t: performance.now(), f: N.rb.frame, c: N.rb.confirmed, d: N.rb.delay, st: r.stalls, rtt: rt }); }, 500);
  M.snap = () => { const N = TMNTNETPLAY.session, r = N.rb.stats; return { t: performance.now(), f: N.rb.frame, c: N.rb.confirmed, st: r.stalls, rb: r.rollbacks, rolled: r.rolledFrames,
    ne: M.eps.length, ds: N.stats.desyncs, hc: N.stats.hashChecks, rs: N.stats.resyncs, ticks: M.ticks, msSim: r.msSim, fr: r.frames }; };
  M.start = () => { M.win = M.snap(); M.logFi = true; M.fi.clear(); M.nEp0 = M.eps.length; M.nS0 = M.samples.length; };
  M.end = () => { const N = TMNTNETPLAY.session, a0 = M.win, a1 = M.snap(), dt = (a1.t - a0.t) / 1000, eps = M.eps.slice(M.nEp0).filter(e => e.at >= a0.t), sm = M.samples.slice(M.nS0);
    let worst = 1e9, worstS = 1e9; for (let i = 0; i + 2 < sm.length; i++) { const w = (sm[i + 2].c - sm[i].c) / ((sm[i + 2].t - sm[i].t) / 1000); if (w < worst) worst = w; const w2 = (sm[i + 2].f - sm[i].f) / ((sm[i + 2].t - sm[i].t) / 1000); if (w2 < worstS) worstS = w2; }
    const dl = sm.map(s => s.d), rt = sm.map(s => s.rtt).filter(v => v > 0);
    return { slot: N.slot, dt, frames: a1.f - a0.f, fps: (a1.f - a0.f) / dt, fpsConf: (a1.c - a0.c) / dt, worst1sFps: worstS, worst1sConf: worst,
      episodes: eps.length, stallMs: eps.reduce((s, e) => s + e.d, 0), maxStallMs: eps.reduce((s, e) => Math.max(s, e.d), 0), over100: eps.filter(e => e.d >= 100).length,
      rawStalls: a1.st - a0.st, delayAvg: dl.reduce((s, v) => s + v, 0) / (dl.length || 1), delayMax: Math.max(...dl), delayEnd: N.rb.delay, rttAvg: rt.reduce((s, v) => s + v, 0) / (rt.length || 1),
      rollbacks: a1.rb - a0.rb, rolledFrames: a1.rolled - a0.rolled, maxRollback: N.rb.stats.maxRollback, desyncs: a1.ds, hashChecks: a1.hc - a0.hc, resyncs: a1.rs,
      msSim: (a1.msSim - a0.msSim) / Math.max(1, a1.fr - a0.fr), msTick: TMNTG.msPerFrame(), confirmed: a1.c }; };
  M.tap = ms => { B.tap = true; setTimeout(() => { B.tap = false; }, ms); };
  M.pulse = (k, ms) => { B[k] = true; setTimeout(() => { B[k] = false; }, ms); };
}"""
res = {'args': vars(a), 'room': ROOM, 'errors': [], 'load0': open('/proc/loadavg').read().split()[:3]}
t00 = time.time()
with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounds-occluded-windows'.replace('backgrounds', 'backgrounding')]
    n = a.players; bs = [p.chromium.launch(args=args) for _ in range(n)]; pages = []
    rtts = [a.rtt] * n
    if a.slow: rtts[n - 1] = a.slow
    for i, b in enumerate(bs):
        ctx = b.new_context(viewport={'width': 800, 'height': 600}, locale='en-US'); pg = ctx.new_page()
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", "bench{i + 1}"); localStorage.setItem("tmnt_public", "0") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: res['errors'].append(f'page {i}: {e}')); pages.append(pg)
    q = lambda i: f'noturn=1&sound=0&netsim={sim(rtts[i])}'
    h = pages[0]; h.goto(f'{BASE}?{q(0)}'); h.evaluate('TMNTG.whenReady'); h.evaluate(INSTR); time.sleep(2)
    h.evaluate('([p, n]) => TMNTNETPLAY.host(p, n)', [False, ROOM]); h.wait_for_function('TMNTNETPLAY.session', timeout=30000); room = h.evaluate('TMNTNETPLAY.state.room'); res['room'] = room
    def pulse(pg, k, ms): pg.evaluate('([k, ms]) => __m.pulse(k, ms)', [k, ms])
    def join_game(pg):
        pulse(pg, 'coin', 100); time.sleep(0.8); pulse(pg, 'fire', 100); time.sleep(0.5); pulse(pg, 'fire', 100); time.sleep(0.5)
    # host starts the game alone, then each guest joins late
    join_game(h); h.evaluate('__bs.play = true'); time.sleep(3)
    for i in range(1, n):
        g = pages[i]; g.goto(f'{BASE}?{q(i)}&sala={room.lower()}'); g.evaluate('TMNTG.whenReady'); g.evaluate(INSTR)
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=60000)
        if a.slow and i == n - 1:  # host's own link to the slow guest: same simulated latency (symmetric RTT)
            h.evaluate('([slot, s]) => { for (const L of TMNTNETPLAY.session.links) if (L.slot === slot) L.link.sim = s; }', [i, {'lat': a.slow / 2, 'jit': round(a.slow / 20, 1), 'loss': 0}])
        join_game(g); g.evaluate('__bs.play = true'); time.sleep(1)
    print(f'[{time.time() - t00:5.1f}s] {n} players in room {room}, warm-up {a.warm}s', flush=True); time.sleep(a.warm)
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
        for pg in pages:
            try:
                pg.evaluate('document.getElementById("npb") && document.getElementById("npb").click()')
            except Exception:
                try: pg.keyboard.press('F7')
                except Exception: pass
        time.sleep(0.4)
        h.screenshot(path=os.path.join(a.preview, 'bench_%s_p%d_rtt%s.png' % (a.tag or 'run', n, int(a.rtt))))
        # also a slightly wider shot of the host after the window starts? keep this mid-warmup connected shot

    st0 = [pg.evaluate('({ slot: TMNTNETPLAY.session.slot, spec: TMNTNETPLAY.session.spec })') for pg in pages]; res['slots'] = st0
    for pg in pages: pg.evaluate('__m.start()')
    time.sleep(a.secs)
    res['peers'] = [pg.evaluate('__m.end()') for pg in pages]
    # ---- tap test (50 ms COIN taps, 1.5 s apart, round-robin over players)
    sent = [0] * n; k = 0; lastTapFrame = 0
    for r in range(a.taps):
        for i in range(n):
            pages[i].evaluate('ms => __m.tap(ms)', a.tapms); sent[i] += 1; lastTapFrame = max(lastTapFrame, pages[i].evaluate('TMNTNETPLAY.session.rb.frame')); time.sleep(1.5)
    # settle: every peer must have CONFIRMED (final inputs of all slots) past the last tap before counting
    t1 = time.time()
    while time.time() - t1 < 60 and min(pg.evaluate('TMNTNETPLAY.session.rb.confirmed') for pg in pages) < lastTapFrame + 60: time.sleep(0.5)
    res['tapSettleS'] = round(time.time() - t1, 1)
    COIN = int(pages[0].evaluate('TMNTIN.COIN'))
    got = [pg.evaluate('({ c: TMNTNETPLAY.session.rb.confirmed, fi: Array.from(__m.fi.entries()) })') for pg in pages]
    fis = [x['fi'] for x in got]; mins = min(x['c'] for x in got)
    maps = [dict((f, v) for f, v in x) for x in fis]
    mism = 0; common = 0
    for f in sorted(maps[0]):
        if f > mins: continue
        vs = [m.get(f) for m in maps]
        if any(v is None for v in vs): continue
        common += 1
        if len(set(vs)) > 1: mism += 1
    def runs(m, slot):
        c = 0; prev = False
        for f in sorted(m):
            if f > mins: break
            on = bool(int(m[f].split(',')[slot]) & COIN)
            if on and not prev: c += 1
            prev = on
        return c
    # slot of every page; count runs per slot on every peer. Only taps are inside the tap window: window frames start at __m.start (before the taps), so subtract the join-phase coin runs (none: playing starts before start())
    slots = [x['slot'] for x in st0]
    tap = {'sent': sent, 'seen': [[runs(m, s) for s in slots] for m in maps], 'common': common, 'inputMismatch': mism, 'tapMs': a.tapms}
    tap['lost'] = [max(0, sent[i] - min(tap['seen'][j][i] for j in range(n))) for i in range(n)]
    res['tap'] = tap
    fin = [pg.evaluate('({ d: TMNTNETPLAY.session.stats.desyncs, hc: TMNTNETPLAY.session.stats.hashChecks, rs: TMNTNETPLAY.session.stats.resyncs })') for pg in pages]
    res['final'] = fin
    for pg in reversed(pages):
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception as e: pass
        time.sleep(0.5)
    time.sleep(2)
    for b in bs: b.close()
srv.shutdown()
res['roomStillListed'] = ROOM in json.dumps(lst())
res['wall'] = time.time() - t00; res['load1'] = open('/proc/loadavg').read().split()[:3]
for i, x in enumerate(res['peers']):
    print(f"P{x['slot'] + 1} fps {x['fps']:.1f} worst1s {x['worst1sFps']:.1f} stall-eps {x['episodes']} ({x['stallMs']:.0f} ms, max {x['maxStallMs']:.0f}, >=100ms: {x['over100']}) raw {x['rawStalls']} delay avg {x['delayAvg']:.1f} max {x['delayMax']} rtt {x['rttAvg']:.0f} rb {x['rollbacks']} maxrb {x['maxRollback']} desync {x['desyncs']} hc {x['hashChecks']} msTick {x['msTick']:.1f}")
print('load', res['load0'], res['load1'], 'tapSettle', res.get('tapSettleS')); print('tap', json.dumps(res['tap'])); print('final', res['final'], 'errors', res['errors'][:3], 'roomStillListed', res['roomStillListed'])
if a.out:
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True); json.dump(res, open(a.out, 'w'), indent=1)
