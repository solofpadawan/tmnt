#!/usr/bin/env python3
"""Promo video, step 1: a REAL 4-player online session. 4 headless Chromium, one per player, WebRTC over loopback, signaling
by web/net/signal.php on a LOCAL php -S (production signal.php / its log are never touched). Nicks Saulo, Ronaldo, Bia, Leo.
Every peer plays its own column of the offline plan (test/promo_plan.js, keyed by frame since power-on): the page's
TMNTIN.sample is replaced by the plan lookup for the frame its input is scheduled for (frame + delay), so inputs travel
through the normal rollback netcode. Each peer records the inputs actually used for every simulated frame (the final
value is the confirmed one), a packed machine snapshot at F0 (+ the sound board), and its state hash every 10 confirmed
frames. Chat lines are sent with TMNTCHAT.send by the player who 'types' them; the host logs when each bubble shows.
-> /tmp/tmnt_promo/live_p{0..3}.json   usage: python3 test/promo_live.py [plan.json] [F0] [END]"""
import os, subprocess, time, json, socket, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from webutil import load
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); OUT = '/tmp/tmnt_promo'; os.makedirs(OUT, exist_ok=True)
PLANF = sys.argv[1] if len(sys.argv) > 1 else f'{OUT}/plan.json'; F0 = int(sys.argv[2]) if len(sys.argv) > 2 else 2400
END = int(sys.argv[3]) if len(sys.argv) > 3 else 3360
PLAN = json.load(open(PLANF))['plan']
CHATS = [(2680, 1, 'bora, pessoal!'), (2840, 2, 'cobre minha retaguarda'), (2990, 0, 'Cowabunga!'), (3140, 3, 'pega o Shredder!')]
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
php = subprocess.Popen(['php', '-S', f'127.0.0.1:{port}', '-t', os.path.join(ROOT, 'web')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'; SIG = f'http://127.0.0.1:{port}/net/signal.php'
NICKS = ['Saulo', 'Ronaldo', 'Bia', 'Leo']
BOT = """plan => { window.__plan = plan; TMNTIN.sample = () => { const o = new Uint8Array(4), N = TMNTNETPLAY.session;
  if (!N || !N.rb || N.slot < 0) return o; const r = plan[N.rb.frame + N.rb.delay - 1]; o[0] = r ? r[N.slot] : 0; return o; }; }"""
HOOK = """F0 => { const N = TMNTNETPLAY.session, rb = N.rb; window.__rec = {}; window.__hash = {}; window.__chat = []; window.__F0 = F0;
  rb.addLocal = v => { const s = rb.slot, t = rb.frame + rb.delay; // exact plan value for every frame scheduled (also gaps after a stall)
    for (let f = Math.max(rb.known[s] + 1, rb.frame); f <= t; f++) { const r = __plan[f - 1]; rb.store(s, f, r ? r[s] : 0); } };
  const sim = rb.sim.bind(rb); rb.sim = f => { sim(f); window.__rec[f] = Array.from(rb.used.get(f)); };
  const oa = rb.onAudio; rb.onAudio = after => { if (oa) oa(after); const f = rb.confirmed;
    if (f % 10 === 0) window.__hash[f] = TMNTSNAP.hash(after);
    if (f === F0 - 1 && !window.__snap) window.__snap = Array.from(TMNTSNAP.pack({ m: after, ext: TMNTG.netExt() })); };
  const sh = TMNTCHAT.show; TMNTCHAT.show = (slot, text, name) => { window.__chat.push([rb.frame, slot, text]); return sh(slot, text, name); };
  return rb.frame; }"""
fails = []
with sync_playwright() as p:
    args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-gl=angle', '--use-angle=swiftshader']
    browsers = [p.chromium.launch(args=args) for _ in range(4)]; pages = []
    for i, b in enumerate(browsers):
        pg = b.new_page(viewport={'width': 960, 'height': 540}); pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(NICKS[i])}) }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: fails.append(f'page {i}: {e}')); pages.append(pg)
    h = pages[0]; h.goto(f'{BASE}?pause=1&signal={SIG}'); load(h); h.evaluate(BOT, PLAN)
    h.evaluate('(async () => { TMNTG.machine.powerOn(); TMNTG.frameNo = 0; await TMNTNETPLAY.host(false); })()')
    h.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=20000)
    print('host hook at frame', h.evaluate(HOOK, F0)); h.evaluate('TMNTG.pause(false)')
    room = h.evaluate('TMNTNETPLAY.state.room'); print('room', room, flush=True)
    for i in range(1, 4):
        g = pages[i]; g.goto(f'{BASE}?sala={room}&signal={SIG}'); load(g); g.evaluate(BOT, PLAN)
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=60000)
        print('guest', i, 'joined, slot', g.evaluate('TMNTNETPLAY.session.slot'), 'hook at', g.evaluate(HOOK, F0), flush=True)
    jf = h.evaluate('TMNTNETPLAY.session.rb.join'); print('join frames', jf, flush=True)
    if max(jf) >= 1700: print('WARNING: a guest joined after the coin frame', flush=True)
    chats = list(CHATS); t0 = time.time()
    while True:
        fr = h.evaluate('TMNTNETPLAY.session.rb.frame')
        if chats and fr >= chats[0][0]: _, k, t = chats.pop(0); pages[k].evaluate('t => TMNTCHAT.send(t)', t); print('chat', fr, k, t, flush=True)
        if int(time.time() - t0) % 10 == 0: pass
        if fr > END + 60: break
        time.sleep(0.03)
        if fr > len(PLAN) - 30: print('WARNING: plan too short'); break
    time.sleep(2)
    for i, pg in enumerate(pages): pg.screenshot(path=f'{OUT}/live_end_p{i+1}.png')
    for i, pg in enumerate(pages):
        d = pg.evaluate('''() => { const N = TMNTNETPLAY.session, r = N.rb.stats; return { slot: N.slot, names: N.names(), F0: __F0, snap: __snap || null, chat: __chat, hash: __hash,
          conf: N.rb.confirmed, desyncs: N.stats.desyncs, resyncs: N.stats.resyncs, hashChecks: N.stats.hashChecks, rollbacks: r.rollbacks, maxRollback: r.maxRollback, stalls: r.stalls,
          join: N.rb.join, rec: Object.fromEntries(Object.entries(__rec).filter(([f]) => +f <= N.rb.confirmed)) }; }''')
        json.dump(d, open(f'{OUT}/live_p{i}.json', 'w'))
        print(i, {k: d[k] for k in ('slot', 'names', 'conf', 'desyncs', 'resyncs', 'hashChecks', 'rollbacks', 'maxRollback', 'stalls')}, 'frames', len(d['rec']), 'snap', len(d['snap'] or []), 'chat', d['chat'], flush=True)
    for b in browsers: b.close()
php.terminate(); print('page errors', fails[:5])
