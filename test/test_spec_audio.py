#!/usr/bin/env python3
"""Spectator audio (late first gesture with a browser-blocked AudioContext must still play the SAME sound as the host) and the room-list 'Assistir' button (net/ui.js).
Production Cloudflare Worker, PRIVATE room (tmnt_public=0), host + 2 guests playing (3 players), then spectators:
  S1  joins by link (?sala=..&assistir=1) with the AudioContext BLOCKED like a browser autoplay policy (no gesture: resume() stays pending, context suspended),
      waits LONG before the first gesture (this is what a spectator who opens a link does), then CLICKS.
  S2  same, but resumes with a KEY (Enter).
  S3  joins through the room-list 'Assistir' button (list answered by a route stub that adds fake rows to check the buttons; the real Worker list is never touched
      and the real public list is checked empty at the end), autoplay allowed.
For every spectator: the hint ('Clique para ativar o som') shows while blocked and goes away on the first gesture/key, and the audio is REAL:
  - board-level: the sound board of the spectator renders the same PCM energy as the host's board for the same emulated time (z80 time key), >= 99% identical;
  - output-level: an AnalyserNode on the master gain (the node right before the speakers) sees non-zero samples (peak > 0.02) after the gesture.
--before DIR runs the same checks on an older stage (to show what the old build did).
Usage: python3 test/test_spec_audio.py WEB [--hold 25] [--preview DIR] [--before]"""
import argparse, os, sys, json, time, functools, http.server, threading, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--hold', type=float, default=25); ap.add_argument('--preview', default='')
ap.add_argument('--before', action='store_true', help='older stage: the room-list checks are skipped'); ap.add_argument('--out', default='')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *x): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=a.web)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}/index.html'
fails = []; res = {'errors': []}
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
    if not ok: fails.append(name)
INSTR = """() => { const I = TMNTIN; const B = window.__bs = { coin: false, fire: false, play: false };
  let x = (Math.random() * 1e9) >>> 0, cur = 0, hold = 0;
  I.sample = () => { const o = new Uint8Array(4);
    if (B.play) { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    if (B.coin) o[0] |= I.COIN; if (B.fire) o[0] |= I.ATTACK; return o; }; }"""
# per-render PCM energy of the sound board keyed by its z80 time (same emulated instant on every peer)
HOOK = """() => { const b = TMNTG.board; if (!b || window.__rec) return 'no'; const R = window.__rec = new Map(); const o = b.render.bind(b);
  b.render = (buf, len, z) => { const n = o(buf, len, z); let e = 0; for (let i = 0; i < n; i++) e += buf[i] * buf[i]; R.set(z, Math.round(e * 1e4)); return n; }; return 'ok'; }"""
# analyser right after the master gain = what reaches the speakers
PROBE = """() => { const A = TMNTG.audio; if (!A || !A.ac || window.__pr) return 'no'; const an = A.ac.createAnalyser(); an.fftSize = 2048; A.duck.connect(an);
  const buf = new Float32Array(2048); const P = window.__pr = { max: 0, nz: 0, n: 0 };
  setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); P.n++; if (m > 1e-4) P.nz++; P.max = Math.max(P.max, m); }, 60); return 'ok'; }"""
RESET = "() => { window.__pr.max = 0; window.__pr.nz = 0; window.__pr.n = 0; }"
# browser autoplay policy: context starts suspended, resume() waits for the first pointerdown / keydown (headless Chromium does not enforce it by itself)
GATE = """(() => { const AC = window.AudioContext; let g = false; const W = [];
  const open = () => { g = true; W.splice(0).forEach(f => f()); };
  addEventListener('pointerdown', open, true); addEventListener('keydown', open, true);
  window.AudioContext = class extends AC { constructor(o) { super(o); super.suspend(); } resume() { return g ? super.resume() : new Promise(r => W.push(() => r(super.resume()))); } };
  window.__gateOpen = () => g; })();"""
STATE = """() => { const A = TMNTG.audio, P = window.__pr || {}, N = TMNTNETPLAY.session, h = document.getElementById('sndhint');
  return { ac: A && A.ac ? A.ac.state : null, ready: !!(A && A.ready), hint: !!(h && getComputedStyle(h).display !== 'none'), hintText: h ? h.textContent : '',
    specAudio: TMNTG.specAudio, spec: N ? !!N.spec : null, frame: N && N.rb ? N.rb.frame : null, max: +(P.max || 0).toFixed(4), nz: P.nz || 0, n: P.n || 0, duck: A && A.duck ? +A.duck.gain.value.toFixed(3) : null }; }"""
def wait(pg, js, to=30, step=0.2):
    t0 = time.time()
    while time.time() - t0 < to:
        try:
            if pg.evaluate(js): return True
        except Exception: pass
        time.sleep(step)
    return False
def compare(spec, host):
    H = dict(host.evaluate('Array.from(__rec.entries())')); S = dict(spec.evaluate('Array.from(__rec.entries())'))
    com = [k for k in S if k in H]; same = sum(1 for k in com if S[k] == H[k])
    return {'spec': len(S), 'common': len(com), 'identical': same, 'eS': sum(S[k] for k in com), 'eH': sum(H[k] for k in com)}
def audio_ok(name, spec, host):
    c = compare(spec, host); st = spec.evaluate(STATE)
    same = c['common'] >= 300 and c['identical'] >= 0.99 * c['common']
    check(f'{name}: spectator board PCM identical to the host board at the same emulated instants ({c["identical"]}/{c["common"]}, energy spec/host {c["eS"]}/{c["eH"]})', same and abs(c['eS'] - c['eH']) <= 0.01 * c['eH'], c)
    res.setdefault('diag', {})[name] = c
    check(f'{name}: the host board really made sound in that window', c['eH'] > 1000, c)
    check(f'{name}: speakers feed non-zero (peak > 0.02, {st["nz"]}/{st["n"]} windows non-zero)', st['max'] > 0.02 and st['nz'] >= 20, st)
    return c
ROOM = 'SAU-%d-%d' % (os.getpid() % 10000, int(time.time()) % 1000)
t00 = time.time()
with sync_playwright() as p:
    ok = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    nB = 6; bs = [p.chromium.launch(args=ok) for _ in range(nB)]; pages = []
    for i, b in enumerate(bs):
        ctx = b.new_context(viewport={'width': 1280, 'height': 720}, locale='pt-BR'); pg = ctx.new_page()
        pg.add_init_script('try { localStorage.setItem("tmnt_nick", "n%d"); localStorage.setItem("tmnt_public", "0") } catch (e) {}' % i)
        if i in (3, 4): pg.add_init_script(GATE)
        pg.on('pageerror', lambda e, i=i: res['errors'].append(f'page {i}: {e}')); pages.append(pg)
    q = 'noturn=1&netsim=25,5,0&lang=pt'
    h = pages[0]; h.goto(f'{BASE}?{q}'); h.evaluate('TMNTG.whenReady'); h.evaluate(INSTR); h.evaluate(HOOK); time.sleep(1.5)
    h.evaluate('([p, n]) => TMNTNETPLAY.host(p, n)', [False, ROOM]); h.wait_for_function('TMNTNETPLAY.session', timeout=30000)
    room = h.evaluate('TMNTNETPLAY.state.room')
    def pulse(pg, k, ms): pg.evaluate('([k, ms]) => { __bs[k] = true; setTimeout(() => __bs[k] = false, ms) }', [k, ms])
    def join_game(pg): pulse(pg, 'coin', 100); time.sleep(0.8); pulse(pg, 'fire', 100); time.sleep(0.5); pulse(pg, 'fire', 100); time.sleep(0.4); pg.evaluate('__bs.play = true')
    join_game(h); time.sleep(2)
    for i in (1, 2):
        g = pages[i]; g.goto(f'{BASE}?{q}&sala={room.lower()}'); g.evaluate('TMNTG.whenReady'); g.evaluate(INSTR); g.evaluate(HOOK)
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=60000); join_game(g); time.sleep(0.8)
    print(f'[{time.time()-t00:5.1f}s] 3 players in {room}; playing 12 s before the spectators join (mid-game join)', flush=True); time.sleep(12)
    # ---- S1 / S2: link + blocked audio ----
    S = {}
    for idx, name, how in ((3, 'S1 link+click', 'click'), (4, 'S2 link+key', 'key')):
        s = pages[idx]; S[name] = (s, how)
        s.goto(f'{BASE}?{q}&sala={room.lower()}&assistir=1'); s.evaluate('TMNTG.whenReady'); s.evaluate(HOOK)
        s.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.spec === true', timeout=60000)
        s.evaluate(PROBE)
    time.sleep(2)
    for name, (s, how) in S.items():
        st = s.evaluate(STATE)
        check(f'{name}: joined as spectator, context blocked (suspended, no worklet yet), hint "Clique para ativar o som" visible',
              st['spec'] and st['ac'] == 'suspended' and not st['ready'] and st['hint'] and st['hintText'] == 'Clique para ativar o som', st)
    print(f'waiting {a.hold:.0f} s without any gesture (the spectator reads the page / looks for the sound hint)...', flush=True); time.sleep(a.hold)
    for name, (s, how) in S.items():
        if a.preview and name.startswith('S1'):
            os.makedirs(a.preview, exist_ok=True); s.screenshot(path=os.path.join(a.preview, 'specaudio_hint_blocked_pt_1280x720.png'))
        s.evaluate(RESET)
        if how == 'click': s.mouse.click(640, 360)
        else: s.keyboard.press('Enter')
        ok_run = wait(s, "() => TMNTG.audio.ac.state === 'running' && TMNTG.audio.ready", 10)
        st = s.evaluate(STATE)
        check(f'{name}: first {how} resumes the context, worklet ready, spectator FIFO cfg, hint gone', ok_run and not st['hint'] and st['specAudio'], st)
    time.sleep(10)
    for name, (s, how) in S.items(): audio_ok(name, s, h)
    check('guest (player) board PCM identical to the host board (normal play unchanged)', (lambda c: c['common'] >= 300 and c['identical'] >= 0.99 * c['common'])(compare(pages[1], h)), compare(pages[1], h))
    # ---- S3: room-list 'Assistir' ----
    s3 = pages[5]; s3.goto(f'{BASE}?{q}'); s3.evaluate('TMNTG.whenReady'); s3.evaluate(HOOK)
    if not a.before:
        rows = [{'room': room, 'host': 'n0', 'p': 3, 's': 3, 'st': 'Fase 1'}, {'room': 'FULLP', 'host': 'x', 'p': 4, 's': 2, 'st': 'Fase 2'},
                {'room': 'FULLS', 'host': 'y', 'p': 4, 's': 4, 'st': 'Fase 3'}, {'room': 'OPENS4', 'host': 'z', 'p': 2, 's': 4, 'st': 'Fase 1'}]
        s3.route('**/signal.php?a=list*', lambda r: r.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'ok': True, 'rooms': rows})))
        s3.keyboard.press('F7')
        ok_l = wait(s3, "() => document.querySelectorAll('#np-list button').length >= 6", 20)
        info = s3.evaluate("""() => Array.from(document.querySelectorAll('#np-list tr')).slice(1).map(tr => ({ room: tr.querySelector('b').textContent,
          btns: Array.from(tr.querySelectorAll('button')).map(b => ({ t: b.textContent.trim(), d: b.disabled, title: b.title || '' })) }))""")
        print('list', json.dumps(info, ensure_ascii=False), flush=True)
        by = {r['room']: r['btns'] for r in info}
        check('room list: row with free player seats has Entrar + Assistir (enabled)', ok_l and [b['t'] for b in by.get(room.upper(), by.get(room, []))] == ['Entrar', 'Assistir'] and not any(b['d'] for b in by.get(room.upper(), by.get(room, []))), by)
        check('room list: full-players room (4/4, Esp. 2/4) offers only an enabled Assistir', [b['t'] for b in by.get('FULLP', [])] == ['Assistir'] and not by['FULLP'][0]['d'], by.get('FULLP'))
        check('room list: Esp. 4/4 -> Assistir disabled with the "Sem vagas para assistir" tooltip (full players too)',
              all(len(by.get(r, [])) and by[r][-1]['t'] == 'Assistir' and by[r][-1]['d'] and by[r][-1]['title'] == 'Sem vagas para assistir' for r in ('FULLS', 'OPENS4')) and [b['t'] for b in by['FULLS']] == ['Assistir'] and [b['t'] for b in by['OPENS4']] == ['Entrar', 'Assistir'] and not by['OPENS4'][0]['d'], {k: by.get(k) for k in ('FULLS', 'OPENS4')})
        # the row for the private room had s=3 only because it is a stub; click its Assistir
        if a.preview:
            os.makedirs(a.preview, exist_ok=True); s3.screenshot(path=os.path.join(a.preview, 'specaudio_room_list_assistir_pt_1280x720.png'))
            try: s3.locator('#np').screenshot(path=os.path.join(a.preview, 'specaudio_room_list_assistir_panel_pt.png'))
            except Exception as e: print('panel shot', e)
        s3.evaluate(PROBE)
        s3.evaluate(RESET)
        s3.locator('#np-list tr', has_text=room.upper()).locator('button', has_text='Assistir').click()
        s3.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.spec === true', timeout=60000)
        st = s3.evaluate(STATE); sess = s3.evaluate('({ spec: TMNTNETPLAY.session.spec, watchOnly: TMNTNETPLAY.state.watchOnly, slot: TMNTNETPLAY.session.slot })')
        check('S3 Assistir (list): joins straight as a spectator (slot -1, watch-only, no player seat taken)', sess['spec'] and sess['slot'] == -1 and sess['watchOnly'], sess)
        s3.evaluate(RESET); time.sleep(10)
        check('S3 Assistir (list): the click was a gesture -> context running, hint not shown', s3.evaluate(STATE)['ac'] == 'running' and not s3.evaluate(STATE)['hint'], s3.evaluate(STATE))
        audio_ok('S3 Assistir', s3, h)
    peers = h.evaluate('TMNTNETPLAY.session.spectators().length'); check('host sees the spectators', peers >= (2 if a.before else 3), peers)
    d = [pg.evaluate('(() => { const N = TMNTNETPLAY.session; return N ? { d: N.stats.desyncs, sd: N.stats.specDesyncs } : null })()') for pg in pages]
    check('0 desyncs (players + spectators)', all(x and x['d'] == 0 and x['sd'] == 0 for x in d if x), d)
    for pg in reversed(pages):
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception: pass
        time.sleep(0.3)
    time.sleep(1)
    for b in bs: b.close()
srv.shutdown()
try:
    d = json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers={'User-Agent': 'Mozilla/5.0'}), timeout=10)); rooms = d.get('rooms') or []
except Exception as e: rooms = ['err %s' % e]
check('public room list tmnt_web is empty at the end', rooms == [], rooms)
check('0 page errors', not res['errors'], res['errors'][:5])
print('wall %.0fs' % (time.time() - t00))
if a.out: json.dump({'fails': fails, 'diag': res.get('diag')}, open(a.out, 'w'))
if fails: print('FAILED', fails); sys.exit(1)
print('ALL PASS')
