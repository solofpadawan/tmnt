#!/usr/bin/env python3
"""Blinking speaking-mic icon (net/chat.js, ported from Moo Mesa) on the overlay canvas, against the production Worker with a PRIVATE room
(tmnt_public=0, spectator joins via ?sala=&assistir=1), headless Chromium, fake microphones.
Usage: python3 test/test_mic_icon.py web [--mode test|preview] [--preview DIR] [--lang pt|en]
mode test    : host + guest + spectator at 1280x720. A per-frame sampler reads the overlay canvas (#chatov) and voice.speaking on every page.
               Checks: icon pixels (pure white) appear on the host (local speaker), the guest (remote speaker) and the spectator (remote
               speaker, own mic never on) while someone speaks and ONLY then; both blink phases are seen, each ~120 ms; the icon sits just right
               of the speaker's nick; the drawing code is textually identical to Moo Mesa's; 0 desyncs; the test room is gone at the end.
mode preview : same room at 1920x1080, host speaks for ~10 s; on every page the blink clock (TMNTCHAT.now) is frozen at an ON phase and
               an OFF phase and a screenshot is taken of each (previews/mic_icon_{host,guest,spectator}_{on,off}_<lang>_1920x1080.png)."""
import argparse, os, sys, json, time, socket, subprocess, wave, urllib.request, re
import numpy as np
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--mode', default='test'); ap.add_argument('--preview', default=''); ap.add_argument('--lang', default='pt'); ap.add_argument('--room', default='MIC ICONE')
ap.add_argument('--moo', default='/workspace/moomesa/web/net/chat.js')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
UA = {'User-Agent': 'Mozilla/5.0'}
def lst(): return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers=UA), timeout=10))
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', a.web], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); BASE = f'http://127.0.0.1:{port}/index.html'
TMP = f'/tmp/tmnt_micicon_test_{os.getpid()}'; os.makedirs(TMP, exist_ok=True)
PREV = a.mode == 'preview'
SEGS = {0: [(2, 14)], 1: [(18, 21)]} if PREV else {0: [(2, 8), (26, 28)], 1: [(14, 20)]}
def wav(slot):
    sr = 48000; n = sr * 48; t = np.arange(n) / sr; x = np.zeros(n)
    for (b, e) in SEGS.get(slot, []):
        i0, i1 = int(b * sr), int(e * sr); tt = t[i0:i1] - b
        f0 = (110 + 25 * slot) * (1 + 0.15 * np.sin(2 * np.pi * 0.7 * tt)); ph = 2 * np.pi * np.cumsum(f0) / sr
        y = np.zeros_like(tt)
        for k in range(1, 30):
            fk = k * f0; g = np.exp(-((fk - 700) / 350) ** 2) + 0.6 * np.exp(-((fk - 1700) / 500) ** 2) + 0.2 * np.exp(-((fk - 3000) / 800) ** 2)
            y += g * np.sin(k * ph) / k ** 0.3
        env = (0.7 + 0.3 * np.sin(2 * np.pi * 4 * tt)) ** 0.6; y *= env; y *= 0.5 / np.max(np.abs(y)); x[i0:i1] = y
    x += np.random.default_rng(slot).normal(0, 0.0003, n)
    p = f'{TMP}/mic{slot}.wav'; w = wave.open(p, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()); w.close(); return p
BOT = """seed => { let x = seed * 2654435761 >>> 0, cur = 0, hold = 0, n = 0; const I = TMNTIN;
  I.sample = () => { n++; const o = new Uint8Array(4); const k = n % 900;
    if (k === 60) o[0] = I.COIN; else if (k === 120 || k === 130) o[0] = I.ATTACK;
    else { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    return o; }; }"""
# per-frame sampler: voice.speaking + pure-white pixel count/bbox on the overlay canvas (game px) + both players' positions
SAMPLER = """() => { const L = window.__mlog = [], G_ = window.__mfull = [];
  const ov = () => document.getElementById('chatov');
  // fast (once per drawn frame): only a small window around each nick line, so the blink phases are timed finely
  const orig = TMNTCHAT.draw; window.__morig = orig;
  const fast = () => {
    const v = TMNTNETPLAY.voice, o = ov(); if (!v || !o || !o.width) return;
    const c = o.getContext('2d'), w = o.width, h = o.height, k = w / 320, ky = h / 224, m = TMNTG.machine, rec = { t: performance.now(), sp: v.speaking.slice(), self: v.selfOn, pos: [], n: [], bb: [] };
    for (let p = 0; p < 2; p++) {
      const q = TMNTCHAT.playerPos(m, p); rec.pos.push(q ? [+q.x.toFixed(1), +q.head.toFixed(1)] : null);
      if (!q) { rec.n.push(0); rec.bb.push(null); continue; }
      const gx0 = Math.max(0, q.x - 40), gx1 = Math.min(320, q.x + 70), gy0 = Math.max(0, Math.max(26, q.head - 2) - 18), gy1 = Math.min(224, Math.max(26, q.head - 2) + 3);
      const X0 = Math.floor(gx0 * k), Y0 = Math.floor(gy0 * ky), W_ = Math.max(1, Math.ceil((gx1 - gx0) * k)), H_ = Math.max(1, Math.ceil((gy1 - gy0) * ky));
      const d = c.getImageData(X0, Y0, W_, H_).data; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < H_; y++) for (let x = 0, i = y * W_ * 4; x < W_; x++, i += 4) if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235 && d[i + 3] >= 200) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      rec.n.push(n); rec.bb.push(n ? [(X0 + x0) / k, (Y0 + y0) / ky, (X0 + x1) / k, (Y0 + y1) / ky] : null);
    }
    L.push(rec); };
  TMNTCHAT.draw = function (m) { orig(m); fast(); }; // sampled right after every drawn frame (the blink phase is a function of the draw time)
  // slow (250 ms): the WHOLE overlay canvas, pure-white pixel count (the icon is the only white thing the overlay draws here)
  window.__mst2 = setInterval(() => {
    const v = TMNTNETPLAY.voice, o = ov(); if (!v || !o || !o.width) return;
    const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235 && d[i + 3] >= 200) n++;
    G_.push({ t: performance.now(), sp: v.speaking.slice(), n }); }, 250); }"""
STATS = """() => { const N = TMNTNETPLAY.session; if (!N || !N.rb) return null; return { slot: N.slot, frame: N.rb.frame, desyncs: N.stats.desyncs, hashChecks: N.stats.hashChecks, spec: N.spec, specDesyncs: N.stats.specDesyncs, specHashChecks: N.stats.specHashChecks }; }"""
fails = []
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
    if not ok: fails.append(name)
errors = []
VW, VH = (1920, 1080) if PREV else (1280, 720)
with sync_playwright() as p:
    base_args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    bs = []; pages = []; names = ['Saulo', 'Yoda', 'Ouvinte']
    for i in range(3):
        mic = wav(i if i < 2 else 9)
        bs.append(p.chromium.launch(args=base_args + ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={mic}']))
        ctx = bs[-1].new_context(viewport={'width': VW, 'height': VH}); pg = ctx.new_page()
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(names[i])}); localStorage.setItem("tmnt_public", "0"); localStorage.removeItem("tmnt_voice_vol") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: errors.append(f'{i}: {e}'))
        pg.on('console', lambda m, i=i: errors.append(f'{i} console: {m.text}') if m.type == 'error' and 'favicon' not in m.text and 'Failed to load resource' not in m.text else None)
        pages.append(pg)
    h, g, sp = pages
    lang = f'lang={a.lang}'
    h.goto(f'{BASE}?{lang}'); h.evaluate('TMNTG.whenReady'); h.evaluate(BOT, 1); h.evaluate('TMNTG.startAudio()'); time.sleep(2)
    h.keyboard.press('F7'); h.click('#np-room'); h.keyboard.type(a.room, delay=20); h.click('#np-create'); h.wait_for_function('TMNTNETPLAY.session', timeout=30000); time.sleep(1.5)
    room = h.evaluate('TMNTNETPLAY.state.room'); print('room', room, '(private)')
    g.goto(f'{BASE}?{lang}&sala={room.lower()}'); g.evaluate('TMNTG.whenReady'); g.evaluate(BOT, 2); g.evaluate('TMNTG.startAudio()')
    g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=40000)
    sp.goto(f'{BASE}?{lang}&sala={room.lower()}&assistir=1'); sp.evaluate('TMNTG.whenReady'); sp.evaluate('TMNTG.startAudio()')
    sp.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec', timeout=60000)
    check('spectator joined as spectator in a private room', bool(sp.evaluate('TMNTNETPLAY.session.spec')))
    for pg in pages:  # close the F7 panel so only the game is visible
        if pg.evaluate("document.getElementById('np').style.display") == 'block': pg.keyboard.press('F7')
    # wait until both turtles are in play on every page (nicks need the player objects active)
    t0 = time.time(); ok = False
    while time.time() - t0 < 60 and not ok:
        ok = all(pg.evaluate("(() => { const m = TMNTG.machine; return !!(TMNTCHAT.playerPos(m, 0) && TMNTCHAT.playerPos(m, 1)); })()") for pg in pages); time.sleep(0.5)
    check('both turtles on screen on host, guest and spectator', ok)
    # nothing is speaking and the mic starts off: no icon yet
    check('mic starts off on both players', not h.evaluate('TMNTNETPLAY.voice.micOn') and not g.evaluate('TMNTNETPLAY.voice.micOn'))
    if not PREV:
        for pg in pages: pg.evaluate(SAMPLER)
    T0 = time.time()
    h.evaluate('TMNTNETPLAY.voice.toggleMic()'); g.evaluate('TMNTNETPLAY.voice.toggleMic()')
    check('mic on (auto voice detection, no push-to-talk)', h.evaluate('TMNTNETPLAY.voice.micOn') and g.evaluate('TMNTNETPLAY.voice.micOn'))
    if PREV:
        # host speaks ~[2,14] s after the mic opened; freeze the blink clock on every page at an ON then an OFF phase
        t0 = time.time()
        while time.time() - t0 < 30 and not (h.evaluate('TMNTNETPLAY.voice.speaking[0]') and g.evaluate('TMNTNETPLAY.voice.speaking[0]') and sp.evaluate('TMNTNETPLAY.voice.speaking[0]')): time.sleep(0.05)
        time.sleep(1.0)
        for who, pg in (('host', h), ('guest', g), ('spectator', sp)):
            print(who, 'speaking flags', pg.evaluate('TMNTNETPLAY.voice.speaking'))
        # pin the scene (paused emulation keeps redrawing the overlay) so ON / OFF show the very same frame; blink clock frozen at an ON then an OFF phase
        for pg in pages: pg.evaluate('TMNTG.pause(true)')
        from PIL import Image
        ANCH = """(() => { const q = TMNTCHAT.playerPos(TMNTG.machine, 0), r = document.getElementById('chatov').getBoundingClientRect(); return q && { x: r.left + q.x * r.width / 320, y: r.top + (q.head - 2) * r.height / 224 }; })()"""
        for ph, nowv in (('on', 0), ('off', 120)):
            for pg in pages: pg.evaluate(f'TMNTCHAT.now = {nowv}')
            time.sleep(0.5)
            for who, pg in (('host', h), ('guest', g), ('spectator', sp)):
                fn = f'{a.preview}/mic_icon_{who}_{ph}_{a.lang}_1920x1080.png'; pg.screenshot(path=fn)
                an = pg.evaluate(ANCH)
                if who == 'host' and an:  # 4x zoom of the speaker's nick, cut from the very same screenshot
                    im = Image.open(fn); x0 = int(max(0, min(1920 - 240, an['x'] - 120))); y0 = int(max(0, min(1080 - 60, an['y'] - 40)))
                    im.crop((x0, y0, x0 + 240, y0 + 60)).resize((960, 240), Image.NEAREST).save(f'{a.preview}/mic_icon_zoom_{ph}_{a.lang}_1920x1080.png')
        for pg in pages: pg.evaluate('TMNTCHAT.now = null; TMNTG.pause(false)')
    else:
        time.sleep(32)
        for pg in pages: pg.evaluate('TMNTCHAT.draw = window.__morig; clearInterval(window.__mst2)')
        logs = [pg.evaluate('window.__mlog') for pg in pages]; fulls = [pg.evaluate('window.__mfull') for pg in pages]
        st = [h.evaluate(STATS), g.evaluate(STATS)]; stsp = sp.evaluate(STATS)
        names_pg = ['host', 'guest', 'spectator']
        PERIOD = 120
        # frozen blink clock on the spectator page with a forced speaking flag: icon ON at t = 0, 240, 480 ms ... and OFF at 120, 360, 600 ...
        sp.evaluate('TMNTNETPLAY.voice.speaking[0] = true; TMNTNETPLAY.voice.speaking[1] = true'); frozen = []
        PROBE = """(() => { const o = document.getElementById('chatov'), m = TMNTG.machine; const q = [0, 1].map(p => TMNTCHAT.playerPos(m, p)).find(x => x); if (!q) return -1;
            const k = o.width / 320, ky = o.height / 224, d = o.getContext('2d').getImageData(Math.floor(Math.max(0, q.x - 40) * k), Math.floor((Math.max(26, q.head - 2) - 18) * ky), Math.ceil(110 * k), Math.ceil(21 * ky)).data; let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235 && d[i + 3] >= 200) n++; return n; })()"""
        for t_ in (0, 119, 120, 239, 240, 359, 360, 479, 480, 1200, 1320):
            sp.evaluate(f'TMNTCHAT.now = {t_}'); n_ = -1
            for _ in range(15):
                time.sleep(0.3); n_ = sp.evaluate(PROBE)
                if n_ >= 0: break
            frozen.append((t_, n_ > 0, int(t_ / 120) % 2 == 0, n_))
        sp.evaluate('TMNTNETPLAY.voice.speaking[0] = false; TMNTNETPLAY.voice.speaking[1] = false; TMNTCHAT.now = null')
        check('frozen clock: icon ON in even 120 ms phases, OFF in odd ones (spectator page, forced flag)', all(x[1] == x[2] and x[3] >= 0 for x in frozen), frozen)
        for pi, lg in enumerate(logs):
            nm = names_pg[pi]
            print(f'--- {nm}: {len(lg)} samples')
            # 1) nobody speaking (and none for >= 600 ms): never any white pixel on the whole overlay canvas
            quiet_bad = 0; quiet_n = 0; last_sp = -1e9
            for r in fulls[pi]:
                if any(r['sp']): last_sp = r['t']
                elif r['t'] - last_sp > 600: quiet_n += 1; quiet_bad += 1 if r['n'] else 0
            check(f'{nm}: no icon pixels anywhere while nobody speaks', quiet_n > 40 and quiet_bad == 0, f'{quiet_n} quiet full-canvas samples, {quiet_bad} with white pixels')
            # white pixels while somebody speaks only come from the two icons: never when only a non-speaker... (full canvas, any phase)
            # 2..4) for each speaker slot alone: blink + position
            for s_ in (0, 1):
                rows = [r for r in lg if r['sp'][s_] and not any(r['sp'][k] for k in range(4) if k != s_) and r['pos'][s_]]
                for r in rows: r['nn'] = r['n'][s_]; r['bbs'] = r['bb'][s_]
                if s_ == 1 and pi == 1: pass
                on = [r for r in rows if r['nn']]; off = [r for r in rows if not r['nn']]
                check(f'{nm}: slot {s_} speaking -> icon seen in BOTH blink phases', len(on) >= 10 and len(off) >= 10, f'{len(rows)} samples, on {len(on)}, off {len(off)}')
                # blink law: icon present <=> micBlinkOn(draw time). Frames are ~100 ms apart in this loaded headless box, so
                # the 120 ms phases are checked sample by sample against the draw timestamp (the exact timing is checked frozen, below)
                agree = sum(1 for r in rows if bool(r['nn']) == (int(r['t'] / PERIOD) % 2 == 0)); dts = sorted(rows[k + 1]['t'] - rows[k]['t'] for k in range(len(rows) - 1) if rows[k + 1]['t'] - rows[k]['t'] < 400)
                check(f'{nm}: slot {s_} icon visible exactly in the ON phases of the 120 ms blink (draw-time check)', len(rows) >= 20 and agree >= 0.93 * len(rows), f'{agree}/{len(rows)} samples agree, frame dt median {dts[len(dts) // 2] if dts else None:.0f} ms')
                # position: icon just right of the speaker's nick (x between the nick centre and +45 px, y within the nick line)
                bad = []; chk = 0
                for r in on:
                    px, ph = r['pos'][s_]; o = r['pos'][1 - s_]
                    if o and abs(o[0] - px) < 70 and abs(o[1] - ph) < 20: continue  # two nicks close together are pushed up: skip
                    ymid = max(26, ph - 2) - 3; chk += 1; bb = r['bbs']
                    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
                    if not (px <= cx <= px + 45 and abs(cy - ymid) <= 3.5 and (bb[2] - bb[0]) <= 8): bad.append((round(cx, 1), round(cy, 1), px, ph))
                check(f'{nm}: slot {s_} icon right after the nick, centred on the nick line, <= 8 game px wide', chk >= 5 and len(bad) <= max(1, chk // 20), f'{chk} samples, {len(bad)} off, e.g. {bad[:3]}')
            # 5) the spectator never transmits
            if pi == 2: check('spectator: own mic never on, own slot never speaking', all(not r['self'] for r in lg))
        check('0 desyncs (host compared >= 5 hashes; guest 0 desyncs)', st[0]['desyncs'] == 0 and st[0]['hashChecks'] >= 5 and st[1]['desyncs'] == 0, st)
        check('spectator 0 desyncs', stsp and stsp['specDesyncs'] == 0, stsp)
        # 6) drawing code identical to Moo Mesa's
        def grab(path, name):
            src = open(path).read(); i = src.index(f'function {name}('); d = 0; j = src.index('{', i)
            k = j
            while True:
                if src[k] == '{': d += 1
                elif src[k] == '}':
                    d -= 1
                    if d == 0: break
                k += 1
            return re.sub(r'\s+', ' ', src[i:k + 1])
        mine = a.web + '/net/chat.js'
        same = all(grab(mine, f) == grab(a.moo, f) for f in ('drawMicIcon', 'micBlinkOn'))
        consts = re.search(r'const MIC_BLINK_MS = [^;]*;', open(mine).read()).group(0) == re.search(r'const MIC_BLINK_MS = [^;]*;', open(a.moo).read()).group(0)
        check('drawMicIcon / micBlinkOn / MIC_* constants identical to Moo Mesa chat.js', same and consts, a.moo)
    for pg in reversed(pages):
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception as e: print('leave', e)
        time.sleep(0.7)
    time.sleep(1)
    for b in bs: b.close()
srv.terminate(); time.sleep(1)
after = lst(); still = [r for r in after.get('rooms', []) if 'MIC' in json.dumps(r).upper()]
check('public tmnt_web list empty / test room not listed', not still, f"public rooms: {len(after.get('rooms', []))}")
print('page errors:', errors[:6]); check('no page errors', not [e for e in errors if 'console' not in e], errors[:3])
print('FAIL: ' + ', '.join(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
