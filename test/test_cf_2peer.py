#!/usr/bin/env python3
"""2-peer TMNT netplay against the live Cloudflare Worker (DEFAULT_SIGNAL)."""
import os, sys, json, time, socket, subprocess, urllib.request
from playwright.sync_api import sync_playwright

WEB = sys.argv[1] if len(sys.argv) > 1 else '/workspace/tmnt-cf-20261109-cf-1103/assemble'
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 40
PREV = sys.argv[3] if len(sys.argv) > 3 else '/workspace/tmnt-cf-20261109-cf-1103/previews'
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
os.makedirs(PREV, exist_ok=True)

s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', WEB],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'

BOT = """seed => { let x = seed * 2654435761 >>> 0, cur = 0, hold = 0, n = 0; const I = TMNTIN, orig = I.sample;
  I.sample = () => { n++; const o = new Uint8Array(4); const k = n % 900;
    if (k === 60) o[0] = I.COIN; else if (k === 120 || k === 130) o[0] = I.ATTACK;
    else { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    return o; }; }"""
STATS = """() => { const N = TMNTNETPLAY.session; if (!N || !N.rb) return null; const r = N.rb.stats;
  return { slot: N.slot, frame: N.rb.frame, confirmed: N.rb.confirmed, rollbacks: r.rollbacks, stalls: r.stalls,
    resyncs: N.stats.resyncs, desyncs: N.stats.desyncs, hashChecks: N.stats.hashChecks, names: N.names(), peers: N.peers() }; }"""

def lst():
    return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10))

ice = json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=ice', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10))
ice_urls = [u for x in ice.get('ice', []) for u in ([x['urls']] if isinstance(x.get('urls'), str) else x.get('urls', []))]
print('ice ok', ice.get('ok'), 'servers', len(ice.get('ice', [])), 'turn urls', len([u for u in ice_urls if str(u).startswith('turn')]))

res = {'ws': [[], []], 'logs': [[], []], 'errors': [], 'reqs': [[], []], 'chat': None}
ok = True
with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows']
    bs = [p.chromium.launch(args=args) for _ in range(2)]; pages = []
    for i, b in enumerate(bs):
        pg = b.new_page(viewport={'width': 1100, 'height': 700})
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(["teste-bot","teste-bot2"][i])}); localStorage.setItem("tmnt_public","1"); }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: res['errors'].append(f'{i}: {e}'))
        pg.on('websocket', lambda ws, i=i: res['ws'][i].append(ws.url))
        pg.on('console', lambda m, i=i: res['logs'][i].append(m.text) if ('netplay-cf' in m.text or 'tmnt-net' in m.text or 'signal' in m.text) else None)
        pg.on('request', lambda r, i=i: res['reqs'][i].append(r.url.split('?')[0] + '?' + (r.url.split('?')[1].split('&')[0] if '?' in r.url else '')) if ('workers.dev' in r.url or 'alwaysdata' in r.url) else None)
        pages.append(pg)
    h, g = pages
    h.goto(BASE + '?sound=0'); h.evaluate('TMNTG.whenReady'); h.evaluate(BOT, 1); time.sleep(3)
    sig_used = h.evaluate('TMNTNETPLAY.signal'); print('signal', sig_used)
    tcf = h.evaluate('!!window.NETCF'); print('NETCF', tcf)
    h.evaluate('TMNTNETPLAY.host(true)')
    # wait until room is set
    h.wait_for_function('!!(TMNTNETPLAY.state && TMNTNETPLAY.state.room)', timeout=20000)
    time.sleep(2)
    room = h.evaluate('TMNTNETPLAY.state.room'); print('room', room, 'link', h.evaluate('TMNTNETPLAY.link()'))
    # wait for meta listing (~5s)
    listed_hit = None
    for _ in range(12):
        listed = lst()
        hit = [r for r in listed.get('rooms', []) if r.get('room') == room or r.get('r') == room]
        if hit:
            listed_hit = hit; break
        time.sleep(1)
    print('listed', listed_hit or listed)

    g.goto(f'{BASE}?sound=0&sala={room}'); g.evaluate('TMNTG.whenReady'); g.evaluate(BOT, 2)
    # wait for guest session with rb
    t0 = time.time()
    while time.time() - t0 < 30:
        st = [pg.evaluate(STATS) for pg in pages]
        if all(st) and st[1] and st[1]['frame'] > 0:
            break
        time.sleep(1)
    print('connected', [s and {'slot': s['slot'], 'frame': s['frame']} for s in st])

    # chat once both connected
    try:
        g.evaluate('TMNTCHAT.send("Cowabunga CF!")')
        h.evaluate('TMNTCHAT.send("bora, pessoal!")')
        time.sleep(1.5)
        res['chat'] = [pg.evaluate('TMNTCHAT.recent.map(r => [r.slot, r.text])') for pg in pages]
        print('chat', res['chat'])
    except Exception as e:
        print('chat err', e); ok = False

    t0 = time.time()
    while time.time() - t0 < SECS:
        time.sleep(5)
        st = [pg.evaluate(STATS) for pg in pages]
        print(f'{time.time()-t0:5.1f}s', ' | '.join(
            f"P{s['slot']+1} f{s['frame']} rb{s['rollbacks']} st{s['stalls']} rs{s['resyncs']} ds{s['desyncs']} hc{s['hashChecks']}" if s else '-'
            for s in st), flush=True)

    st = [pg.evaluate(STATS) for pg in pages]
    h.screenshot(path=os.path.join(PREV, 'host-connected.png'))
    g.screenshot(path=os.path.join(PREV, 'guest-connected.png'))
    # side-by-side via canvas if available; also save panel shots
    try:
        h.evaluate('document.getElementById("npb") && document.getElementById("npb").click()')
        g.evaluate('document.getElementById("npb") && document.getElementById("npb").click()')
        time.sleep(0.4)
        h.screenshot(path=os.path.join(PREV, 'host-panel.png'))
        g.screenshot(path=os.path.join(PREV, 'guest-panel.png'))
    except Exception as e:
        print('panel shot', e)

    try:
        g.evaluate('TMNTNETPLAY.leave()'); time.sleep(1); h.evaluate('TMNTNETPLAY.leave()'); time.sleep(3)
    except Exception:
        pass
    for b in bs: b.close()

srv.terminate(); time.sleep(1)
after = lst(); still = [r for r in after.get('rooms', []) if room in json.dumps(r)]
print(json.dumps(st, default=str)[:2500])
print('ws', res['ws'])
print('logs sample', [[x for x in L if 'websocket' in x or 'tmnt-net' in x][:8] for L in res['logs']])
print('errors', res['errors'][:5])
print('alwaysdata requests', [u for r in res['reqs'] for u in r if 'alwaysdata' in u])
from collections import Counter
print('worker http reqs', [dict(Counter(r)) for r in res['reqs']])
print('room after leave listed:', still)

ws_on = [any('websocket push on' in l for l in L) for L in res['logs']]
print('ws push logs', ws_on)
print('ws urls', res['ws'])

checks = {
  'NETCF': tcf,
  'signal': sig_used == SIG,
  'both_stats': all(st),
  'no_desync': all(st) and st[0]['desyncs'] == 0 and st[1]['desyncs'] == 0,
  'hash_checks': all(st) and st[0]['hashChecks'] >= 3,
  'frames_advance': all(st) and st[0]['frame'] > 100 and st[1]['frame'] > 50,
  'ws_opened': all(res['ws']) and all('workers.dev' in u and '/tmnt_web/ws' in u for arr in res['ws'] for u in arr),
  'ws_push_log': all(ws_on),
  'listed': bool(listed_hit),
  'left_unlist': not still,
  'no_errors': not res['errors'],
  'no_alwaysdata': not any('alwaysdata' in u for r in res['reqs'] for u in r),
  'chat': bool(res['chat']) and any(any(t == 'Cowabunga CF!' for _, t in rec) for rec in res['chat']),
}
for k, v in checks.items():
    print(('PASS' if v else 'FAIL'), k, v)
ok = ok and all(checks.values())
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
