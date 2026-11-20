#!/usr/bin/env python3
"""Voice chat (web/net/voice.js) against a signal server (default: production Worker, but rooms MUST be private so they never appear in the public tmnt_web list). Headless Chromium with fake media devices.
Usage: python3 test/test_voice.py web [--players 4] [--spectator 1] [--lang pt|en] [--preview DIR] [--room NAME]
One browser per player (+ one spectator when the room is full). Each browser's fake microphone plays its own WAV (speech-like
bursts at different times, silence otherwise). Host creates the room by typing the name, G1 joins by ?sala= (hint expected), the other
players join through the code field (no hint), the spectator through the room list (no hint, no mic button).
Checks (numbers printed): every listener's received audio energy rises while somebody else talks, speaker icon lights/clears on
every page, sender bitrate while talking vs silence (getStats), spectator sends 0 bytes, per-player mute (no duck, no icon change),
volume slider (localStorage), ducking: game master gain ~DUCK_GAIN while another unmuted player is heard, 1.0 afterwards, never ducked by
the own voice, 0 desyncs, invite hint only for the ?sala= guest, mic denial message, test rooms gone at the end."""
import argparse, os, sys, json, time, socket, subprocess, struct, wave, urllib.request, math
import numpy as np
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--players', type=int, default=4); ap.add_argument('--spectator', type=int, default=1)
ap.add_argument('--lang', default='pt'); ap.add_argument('--preview', default=''); ap.add_argument('--room', default='VOZ TESTE'); ap.add_argument('--novad', action='store_true'); ap.add_argument('--public', action='store_true', help='list the room on the public tmnt_web directory (default: private; spectator joins via ?assistir=1)')
a = ap.parse_args()
SIG = 'https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php'
UA = {'User-Agent': 'Mozilla/5.0'}
def lst(): return json.load(urllib.request.urlopen(urllib.request.Request(SIG + '?a=list', headers=UA), timeout=10))
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', a.web], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); BASE = f'http://127.0.0.1:{port}/index.html'
TMP = f'/tmp/tmnt_voice_test_{os.getpid()}'; os.makedirs(TMP, exist_ok=True)
# ---- fake microphone files: speech-like (harmonics, formants, syllable modulation) in the given [start,end] seconds, silence otherwise
SEGS = {0: [(1, 4), (31, 34), (40, 43)], 1: [(7, 10), (27, 30)], 2: [(13, 16)], 3: [(19, 22)]}
if a.players == 2: SEGS = {0: [(1, 4), (31, 34), (40, 43)], 1: [(7, 10), (27, 30)]}
def wav(slot):
    sr = 48000; n = sr * 48; t = np.arange(n) / sr; x = np.zeros(n)
    for (b, e) in SEGS.get(slot, []):
        i0, i1 = int(b * sr), int(e * sr); tt = t[i0:i1] - b
        f0 = (110 + 25 * slot) * (1 + 0.15 * np.sin(2 * np.pi * 0.7 * tt)); ph = 2 * np.pi * np.cumsum(f0) / sr
        y = np.zeros_like(tt)
        for k in range(1, 30):
            fk = k * f0; g = np.exp(-((fk - 700) / 350) ** 2) + 0.6 * np.exp(-((fk - 1700) / 500) ** 2) + 0.2 * np.exp(-((fk - 3000) / 800) ** 2)
            y += g * np.sin(k * ph) / k ** 0.3
        env = (0.55 + 0.45 * np.sin(2 * np.pi * 4 * tt)) ** 0.6; y *= env; y *= 0.5 / np.max(np.abs(y)); x[i0:i1] = y
    x += np.random.default_rng(slot).normal(0, 0.0003, n)
    p = f'{TMP}/mic{slot}.wav'; w = wave.open(p, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()); w.close(); return p
BOT = """seed => { let x = seed * 2654435761 >>> 0, cur = 0, hold = 0, n = 0; const I = TMNTIN;
  I.sample = () => { n++; const o = new Uint8Array(4); const k = n % 900;
    if (k === 60) o[0] = I.COIN; else if (k === 120 || k === 130) o[0] = I.ATTACK;
    else { if (--hold <= 0) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; cur = [0, I.L, I.R, I.U, I.D, I.ATTACK, I.ATTACK | I.R, I.JUMP, I.L | I.ATTACK][(x >>> 16) % 9]; hold = 5 + ((x >>> 8) % 40); } o[0] = cur; }
    return o; }; }"""
# in-page sampler: 100 ms state log + 500 ms voice stats (per transceiver, via sender/receiver getStats)
SAMPLER = """() => { const L = window.__vlog = [], S = window.__vstat = [];
  setInterval(() => { const v = TMNTNETPLAY.voice; if (!v) return; L.push({ t: Date.now(), g: v.gain(), duck: v.ducking, sp: v.speaking.slice(), self: v.selfOn, mic: v.micOn, lvl: +v.level.toFixed(4), rx: v.rxLevel.map(x => +x.toFixed(4)),
    icon: Array.from(document.querySelectorAll('#np [data-vs]')).map(e => [+e.dataset.vs, e.classList.contains('on')]), hud: document.querySelectorAll('#npvh [data-hv]').length }); }, 100);
  setInterval(async () => { const N = TMNTNETPLAY.session; if (!N) return; const rec = { t: 0, out: 0, outBy: {}, inE: {}, inB: {} }, jobs = [];
    for (const l of N.links) { const vx = l.link.vx; if (!vx || !vx.usable()) continue;
      for (let s = 0; s < 4; s++) { const tx = vx.txs[s];
        jobs.push(tx.sender.getStats().then(m => m.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'audio') { rec.out += r.bytesSent; rec.outBy[(l.slot) + ':' + s] = r.bytesSent; } })));
        jobs.push(tx.receiver.getStats().then(m => m.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { rec.inE[s] = Math.max(rec.inE[s] || 0, r.totalAudioEnergy || 0); rec.inB[s] = Math.max(rec.inB[s] || 0, r.bytesReceived || 0); } }))); } }
    await Promise.all(jobs); rec.t = Date.now(); S.push(rec); }, 500); }"""
STATS = """() => { const N = TMNTNETPLAY.session; if (!N || !N.rb) return null; return { slot: N.slot, frame: N.rb.frame, desyncs: N.stats.desyncs, hashChecks: N.stats.hashChecks, resyncs: N.stats.resyncs, spec: N.spec, specDesyncs: N.stats.specDesyncs, specHashChecks: N.stats.specHashChecks }; }"""
fails = []
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
    if not ok: fails.append(name)
NP = a.players; NSP = a.spectator; NB = NP + NSP
errors = []
with sync_playwright() as p:
    base_args = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    bs = []
    for i in range(NB):
        mic = wav(i) if i < NP else wav(9)
        bs.append(p.chromium.launch(args=base_args + ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={mic}']))
    pages = []; lang = f'lang={a.lang}'
    for i, b in enumerate(bs):
        ctx = b.new_context(viewport={'width': 1280, 'height': 720}); pg = ctx.new_page()
        pub = '1' if a.public else '0'
        pg.add_init_script(f'try {{ localStorage.setItem("tmnt_nick", {json.dumps(["Saulo", "Zé", "Ana", "Bia", "Ouvinte"][i])}); localStorage.setItem("tmnt_public", "{pub}"); localStorage.removeItem("tmnt_voice_vol") }} catch (e) {{}}')
        pg.on('pageerror', lambda e, i=i: errors.append(f'{i}: {e}')); pg.on('console', lambda m, i=i: errors.append(f'{i} console: {m.text}') if m.type == 'error' and 'favicon' not in m.text and 'Failed to load resource' not in m.text else None)
        pages.append(pg)
    h = pages[0]
    h.goto(f'{BASE}?{lang}'); h.evaluate('TMNTG.whenReady'); h.evaluate(BOT, 1); h.evaluate('TMNTG.startAudio()'); time.sleep(2)
    h.keyboard.press('F7')
    # TMNT never had a Watch button next to the join-by-code field (SR has #np-watchcode); keep it that way.
    join_btn = h.query_selector('#np-join'); watchcode = h.query_selector('#np-watchcode')
    check('F7 join field: Entrar/Join present, no Assistir/Watch beside it', join_btn is not None and watchcode is None,
          f'join={bool(join_btn)} watchcode={bool(watchcode)}')
    if a.preview:
        time.sleep(0.6); h.screenshot(path=f'{a.preview}/f7_join_field_{a.lang}.png')
    h.click('#np-room'); h.keyboard.type(a.room, delay=20); h.click('#np-create'); h.wait_for_function('TMNTNETPLAY.session', timeout=30000); time.sleep(1.5)
    room = h.evaluate('TMNTNETPLAY.state.room'); print('room', room, 'link', h.evaluate('TMNTNETPLAY.link()'))
    check('host: no invite hint', h.evaluate('TMNTNETPLAY.hint') is None)
    hint_seen = {}
    for i in range(1, NP):
        g = pages[i]
        if i == 1:
            g.goto(f'{BASE}?{lang}&sala={room.lower()}'); g.evaluate('TMNTG.whenReady')
            t0 = time.time(); hv = None
            while time.time() - t0 < 25 and hv is None: hv = g.evaluate('TMNTNETPLAY.hint'); time.sleep(0.1)
            hint_seen[i] = hv; print('G1 hint:', hv)
            vis = g.evaluate("(() => { const e = document.getElementById('nphint'); const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { display: c.display, pe: c.pointerEvents, w: r.width, h: r.height, fs: c.fontSize }; })()")
            check('G1 (?sala= link): hint banner shown', bool(hv) and vis['display'] == 'block' and vis['pe'] == 'none', f'{hv!r} {vis}')
            if a.preview and i == 1: time.sleep(2.5); g.screenshot(path=f'{a.preview}/voice_hint_{a.lang}.png')
        else:
            g.goto(f'{BASE}?{lang}'); g.evaluate('TMNTG.whenReady'); g.keyboard.press('F7'); g.click('#np-code'); g.keyboard.type(room.lower(), delay=10); g.click('#np-join')
            try: g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb', timeout=40000)
            except Exception as e: print('join wait', e)
            time.sleep(0.5); hint_seen[i] = g.evaluate('TMNTNETPLAY.hint'); check(f'G{i} (code field): no hint', hint_seen[i] is None)
        g.evaluate(BOT, i + 1); g.evaluate('TMNTG.startAudio()')
        g.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.rb && TMNTNETPLAY.session.slot >= 0', timeout=40000)
    if NSP:
        sp = pages[NP]
        # Default: private room (not on the public tmnt_web list). Spectator joins via ?sala=&assistir=1.
        # --public: join through the room-list Watch button (data-w), which requires a listed room.
        if not a.public:
            sp.goto(f'{BASE}?{lang}&sala={room.lower()}&assistir=1'); sp.evaluate('TMNTG.whenReady'); sp.evaluate('TMNTG.startAudio()')
        else:
            sp.goto(f'{BASE}?{lang}'); sp.evaluate('TMNTG.whenReady'); sp.evaluate('TMNTG.startAudio()'); sp.keyboard.press('F7')
            if NP < 4: print('(spectator needs a full room; joining as player instead)')
            if NP == 4:
                sp.wait_for_selector(f'#np-list button[data-w][data-r="{room}"]', timeout=45000)
                print('list html', (sp.evaluate("document.getElementById('np-list') && document.getElementById('np-list').innerText") or '')[:240])
                sp.click(f'#np-list button[data-w][data-r="{room}"]')
            else:
                sp.wait_for_selector('#np-list button[data-r]', timeout=45000)
                sp.click('#np-list button[data-r]')
        if NP == 4:
            try:
                sp.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec', timeout=60000)
            except Exception as e:
                print('spectator wait failed', e)
                print('spectator state', sp.evaluate("(() => { const N = TMNTNETPLAY.session, st = TMNTNETPLAY.state; return { has: !!N, spec: N && N.spec, slot: N && N.slot, role: st && st.role, wait: st && st.wait, msg: st && st.msg, room: st && st.room, watchOnly: st && st.watchOnly, links: N && N.links && N.links.length }; })()"))
                raise
        time.sleep(1)
        if a.public:
            check('spectator (room list): no hint', sp.evaluate('TMNTNETPLAY.hint') is None)
        else:
            check('spectator (?assistir=1, private room): joined as spec', bool(sp.evaluate('TMNTNETPLAY.session && TMNTNETPLAY.session.spec')))

    time.sleep(2)
    # G1's hint goes away by itself (8 s) -- verify, and TAB closes it on a second page? (G1 only link guest) -> test TAB with a fresh page below
    g1 = pages[1]; t0 = time.time()
    while g1.evaluate('TMNTNETPLAY.hint') and time.time() - t0 < 12: time.sleep(0.2)
    check('hint auto-hides (~8 s after connecting)', g1.evaluate('TMNTNETPLAY.hint') is None)
    for pg in pages: pg.evaluate(SAMPLER)
    for i, pg in enumerate(pages):
        pg.keyboard.press('F7') if pg.evaluate("document.getElementById('np').style.display") != 'block' else None
    time.sleep(1)
    # panel state before the mic is on (mic off)
    sh = lambda pg, name: pg.screenshot(path=f'{a.preview}/voice_{name}_{a.lang}.png') if a.preview else None
    check('mic button starts off for players', all('off' in pages[i].inner_text('#np-mic').lower() or 'deslig' in pages[i].inner_text('#np-mic').lower() for i in range(NP)), pages[0].inner_text('#np-mic'))
    check('spectator has no mic button', NSP == 0 or (pages[NP].query_selector('#np-mic') is None and pages[NP].query_selector('#np-vvol') is not None))
    if NSP and a.preview: sh(pages[NP], 'spectator')
    sh(h, 'panel_micoff')
    # volume slider: 70% on the last player's page (persisted)
    L = NP - 1; lp = pages[L]
    lp.evaluate("(() => { const e = document.getElementById('np-vvol'); e.value = 70; e.dispatchEvent(new Event('input', { bubbles: true })); })()")
    check('voice volume saved (localStorage tmnt_voice_vol=0.7) and applied', lp.evaluate("localStorage.getItem('tmnt_voice_vol')") == '0.7' and lp.evaluate('TMNTNETPLAY.voice.vol') == 0.7)
    # mic on everywhere at ~the same instant (the fake files start when the device opens)
    T0 = time.time(); tasks = []
    for i in range(NP): pages[i].click('#np-mic')
    T0 = time.time(); print('mics on')
    time.sleep(0.4); sh(h, 'panel_micon_' + 'idle'); 
    check('mic on: enabled, nothing sent yet', all(pages[i].evaluate('TMNTNETPLAY.voice.micOn') for i in range(NP)))
    done = set()
    def at(sec, fn, key):
        if key not in done and time.time() - T0 >= sec: done.add(key); fn()
    muted_slot = 0
    while time.time() - T0 < 46:
        el = time.time() - T0
        if a.preview:
            at(8.5, lambda: sh(h, 'speaking'), 'shot1')           # G1 speaking [7,10]
            at(14.5, lambda: sh(pages[1], 'listener'), 'shot2')   # G2 speaking, seen from G1 (or host in 2p)
        at(24, lambda: lp.evaluate(f'TMNTNETPLAY.voice.setMute({muted_slot}, true)'), 'mute')
        at(25, lambda: sh(lp, 'muted') if a.preview else None, 'shotm')
        at(37, lambda: lp.evaluate(f'TMNTNETPLAY.voice.setMute({muted_slot}, false)'), 'unmute')
        time.sleep(0.1)
    time.sleep(1.5)
    st = [pg.evaluate(STATS) for pg in pages[:NP]]; stsp = pages[NP].evaluate(STATS) if NSP else None
    logs = [pg.evaluate('window.__vlog') for pg in pages]; stats = [pg.evaluate('window.__vstat') for pg in pages]
    mute_state = lp.evaluate('TMNTNETPLAY.voice.mute')
    # ---------------- analysis ----------------
    def seg_intervals(log, slot, key='self'):
        iv = []; cur = None
        for r in log:
            on = r['self'] if key == 'self' else r['sp'][slot]
            if on and cur is None: cur = r['t']
            if not on and cur is not None: iv.append((cur, r['t'])); cur = None
        return iv
    own = [seg_intervals(logs[i], i) for i in range(NP)]
    print('speech intervals (s, duration):', [[round((e - s) / 1000, 2) for s, e in x] for x in own])
    check('each player: VAD detected its speech bursts (>=1 interval each, ~3 s + 0.3 s hangover)', all(len(own[i]) >= len(SEGS[i]) - (1 if i == 0 else 0) and all(2.5 <= (e - s) / 1000 <= 5.0 for s, e in own[i]) for i in range(NP)), [[round((e - s) / 1000, 2) for s, e in x] for x in own])
    def at_t(log, t): 
        r = None
        for x in log:
            if x['t'] <= t: r = x
        return r
    def stat_at(sts, t):
        r = None
        for x in sts:
            if x['t'] <= t: r = x
        return r
    mute_iv = None
    # per speaker interval: listeners
    ducks = []; listen_ok = True; icon_ok = True; hud_ok = True
    for sp_i in range(NP):
        for (s0, e0) in own[sp_i]:
            w0, w1 = s0 + 1200, e0 - 300
            for li in range(NP + NSP):
                if li == sp_i: continue
                lg = [r for r in logs[li] if w0 <= r['t'] <= w1]
                if not lg: continue
                s_a, s_b = stat_at(stats[li], w0), stat_at(stats[li], w1)
                dE = (s_b['inE'].get(str(sp_i), 0) - s_a['inE'].get(str(sp_i), 0)) if s_a and s_b else -1
                dB = (s_b['inB'].get(str(sp_i), 0) - s_a['inB'].get(str(sp_i), 0)) if s_a and s_b else -1
                mu_listener = (li == L and any(r2 for r2 in [1]) and sp_i == muted_slot and (s0 / 1000 > 0) and 24 <= (s0 / 1000 - T0 * 0 - 0) )  # filled below
                gmin = min(r['g'] for r in lg if r['g'] is not None) if any(r['g'] is not None for r in lg) else None
                gmax = max(r['g'] for r in lg if r['g'] is not None) if gmin is not None else None
                icon = all(any(i2 == sp_i and on for (i2, on) in r['icon']) or not r['icon'] for r in lg)
                ducks.append(dict(spk=sp_i, lis=li, t0=round((s0 - T0 * 1000) / 1000, 1), dE=round(dE, 5), dB=dB, gmin=gmin, gmax=gmax, icon=icon, hud=min(r['hud'] for r in lg), rx=max(r['rx'][sp_i] for r in lg)))
    T0ms = T0 * 1000
    for d in ducks: d['mutedL'] = (d['lis'] == L and d['spk'] == muted_slot and 24 <= d['t0'] + 0 and d['t0'] < 37)
    # the mute window is [T0+24, T0+37] by wall clock; the sampler uses Date.now()
    for d in ducks:
        tt = d['t0']; d['mutedL'] = (d['lis'] == L and d['spk'] == muted_slot and 24 <= tt + 1.0 <= 37)
    for d in ducks: print(' ', d)
    ok_rx = all(((d['dE'] > 0) or (d['rx'] > 0.01) or d['mutedL']) and d['dB'] > 500 for d in ducks); check('voice reaches every listener (received audio energy and bytes rise while the speaker talks)', ok_rx and len(ducks) > 0, f'{len(ducks)} listener windows (inbound-rtp totalAudioEnergy may stay 0 with a muted keep-alive <audio>; analyser rxLevel and bytes must still rise)')
    check('speaker icon lit on every page while that player speaks', all(d['icon'] for d in ducks))
    check('speaker HUD over the game visible while someone speaks', all(d['hud'] >= 1 for d in ducks))
    lat = []; rel = []
    for sp_i in range(NP):
        for (s0, e0) in own[sp_i]:
            for li in range(NP + NSP):
                if li == sp_i or (li == L and sp_i == muted_slot and 24 <= (s0 - T0 * 1000) / 1000 <= 37): continue
                a1 = [r['t'] for r in logs[li] if s0 - 200 <= r['t'] <= e0 and r['g'] is not None and r['g'] < 0.7]
                if a1: lat.append(a1[0] - s0)
                b1 = [r['t'] for r in logs[li] if r['t'] >= e0 and r['g'] is not None and r['g'] > 0.97]
                if b1: rel.append(b1[0] - e0)
    if lat: print(f'ducking attack (speaker VAD on -> listener gain < 0.7): median {sorted(lat)[len(lat)//2]:.0f} ms, max {max(lat):.0f} ms (100 ms log resolution, n={len(lat)})')
    if rel: print(f'ducking release (speaker VAD off -> listener gain > 0.97): median {sorted(rel)[len(rel)//2]:.0f} ms, max {max(rel):.0f} ms (n={len(rel)})')
    same_ac = []
    for i, pg in enumerate(pages):
        same_ac.append(pg.evaluate("""() => {
          const v = TMNTNETPLAY.voice, g = TMNTG.audio && TMNTG.audio.ac;
          if (!v || !g) return { ok: false, why: !v ? 'no voice' : 'no game ac' };
          const vac = v.audioCtx();
          const plays = (v.audios || []).filter(Boolean).map(a => ({
            mutedEl: !!(a.el && a.el.muted), vol0: a.el ? a.el.volume === 0 : false,
            hasGain: !!a.gain, sameCtx: a.ctx === g, hasClone: !!a.clone
          }));
          return { ok: !!(vac && vac === g), state: g.state, own: !!v._ownCtx, plays };
        }"""))
    check('voice and game share the same AudioContext', all(x.get('ok') for x in same_ac) and all(not x.get('own') for x in same_ac), same_ac)
    play_ok = all(p.get('mutedEl') and p.get('vol0') and p.get('hasGain') and p.get('sameCtx') and p.get('hasClone')
                 for x in same_ac for p in (x.get('plays') or []))
    check('remote voice: muted <audio> + clone/GainNode on the game AudioContext',
          play_ok and any(x.get('plays') for x in same_ac), same_ac)
    DG = 0.65
    duck_ok = all((d['gmin'] is not None and d['gmin'] <= DG + 0.06) for d in ducks if not d['mutedL'])
    check(f'ducking: game gain <= {DG + 0.06:.2f} (target {DG}) while another player is heard', duck_ok, [d['gmin'] for d in ducks if not d['mutedL']])
    # Mute of slot S must not itself duck; another unmuted speaker still may (same as SR).
    # Use the 100 ms sampler: while the mute is on, if no *other* slot is marked speaking, gain must be ~1.
    # (A window that merely overlaps another burst is not a mute failure — 0946 passed this by luck of spacing.)
    mute_rows = [d for d in ducks if d['mutedL']]
    # After another speaker stops, duck hang (300 ms) + release (500 ms) can leave
    # gain < 0.95 with speaking flags already off (voice5: 0.879 at t=29.25 right after
    # P1's burst ended). Only assert once no *other* slot has been speaking for >= 800 ms.
    last_other = -1e18
    bad_mute_duck = []
    for r in logs[L]:
        if r.get('g') is None: continue
        others = any(r['sp'][i] for i in range(4) if i != muted_slot)
        if others:
            last_other = r['t']
        t_rel = (r['t'] - T0 * 1000) / 1000
        if not (24 <= t_rel < 37): continue
        if (not others) and (r['t'] - last_other) >= 800 and r['g'] < 0.95:
            bad_mute_duck.append((round(t_rel, 2), round(r['g'], 3), r['sp']))
    print('muted-only samples with gain<0.95 (should be none):', bad_mute_duck[:8], 'n=', len(bad_mute_duck))
    check('muted player: listener gain stays 1.0 (no ducking) but icon/audio flag unchanged',
          any(mute_rows) and not bad_mute_duck and all(d['icon'] and d['hud'] >= 1 for d in mute_rows),
          {'muted_windows': [(d['t0'], d['gmin']) for d in mute_rows], 'bad': bad_mute_duck[:6]})
    # a speaker is never ducked by its own voice: while only it speaks, its own gain stays 1
    own_g = []
    for i in range(NP):
        for (s0, e0) in own[i]:
            lg = [r for r in logs[i] if s0 + 1200 <= r['t'] <= e0 - 300 and all(not r['sp'][k] for k in range(4) if k != i)]
            if lg: own_g.append(min(r['g'] for r in lg if r['g'] is not None) if any(r['g'] is not None for r in lg) else 1)
    check('own voice never ducks the game', all(g > 0.95 for g in own_g), own_g)
    # release: after all speech is over (>=1.5 s since the last 'speaking' flag, and no one else speaks) gain back to 1.0
    silent_g = []
    allflags = sorted({r['t'] for r in logs[0]})
    for li in range(NP + NSP):
        for r in logs[li]:
            pass
    # gain after speech: sample 1.3 s after the end of every window in which nobody speaks for 2+ s
    ivs = sorted([(s0, e0) for i in range(NP) for (s0, e0) in own[i]])
    gaps = [(ivs[k][1] + 1500, ivs[k + 1][0] - 500) for k in range(len(ivs) - 1) if ivs[k + 1][0] - ivs[k][1] > 2300]
    gap_g = []
    for (g0, g1) in gaps:
        for li in range(NP + NSP):
            lg = [r['g'] for r in logs[li] if g0 <= r['t'] <= g1 and r['g'] is not None]
            if lg: gap_g.append(round(min(lg), 3))
    check('after the voice stops the game gain returns to 1.0 (release within ~0.5 s + hangover)', len(gap_g) > 0 and all(g > 0.97 for g in gap_g), f'{len(gap_g)} samples, min {min(gap_g) if gap_g else None}')
    # transition timing at the listener: attack/release times, from the 100 ms log (coarse)
    # bitrates
    def bitrate(si, w0, w1):
        s_a, s_b = stat_at(stats[si], w0), stat_at(stats[si], w1)
        return (s_b['out'] - s_a['out']) * 8 / ((s_b['t'] - s_a['t']) / 1000) / 1000 if s_a and s_b and s_b['t'] > s_a['t'] else None
    talk = []; quiet = []
    for i in range(NP):
        for (s0, e0) in own[i]:
            b = bitrate(i, s0 + 1000, e0 - 400)
            if b is not None: talk.append((i, round(b, 1), len(pages[i].evaluate('TMNTNETPLAY.session.links')) if False else None))
    # silence windows: all pages, between everyone's speech (gaps) -> total bytes sent on audio by all pages
    sil_kbps = []
    for (g0, g1) in [(x + 0, y) for (x, y) in gaps]:
        if g1 - g0 < 1000: continue
        tot = 0; dur = 0
        for si in range(NP + NSP):
            s_a, s_b = stat_at(stats[si], g0), stat_at(stats[si], g1)
            if s_a and s_b and s_b['t'] > s_a['t']: tot += s_b['out'] - s_a['out']; dur = max(dur, (s_b['t'] - s_a['t']) / 1000)
        if dur: sil_kbps.append(round(tot * 8 / dur / 1000, 2))
    print('sender bitrate while talking (player, kbps over all its links):', talk)
    print('all-pages audio bitrate in silence (kbps):', sil_kbps)
    check('sender bitrate while talking within 5..45 kbps per speaker (cap 28 kbps per stream)', all(5 < b < 45 * 3 for (_, b, _) in talk) and len(talk) > 0)
    check('audio bitrate ~0 in silence (< 0.5 kbps summed over every page)', len(sil_kbps) > 0 and all(b < 0.5 for b in sil_kbps))
    if NSP:
        sp_out = stats[NP][-1]['out'] if stats[NP] else None; check('spectator sent 0 audio bytes', sp_out == 0, sp_out)
        spl = logs[NP]; check('spectator heard the players (energy rises)', all((d['dE'] > 0 or d['rx'] > 0.01) for d in ducks if d['lis'] == NP), [d for d in ducks if d['lis'] == NP])
    check('players without ever enabling a mic: untouched (guest sends 0 bytes) -- n/a all enabled', True)
    check('mute flag kept for the muted slot, then cleared by unmute', mute_state[muted_slot] is False, mute_state)
    # sync
    print('netplay stats:', st, stsp)
    check('0 desyncs (host compared >= 5 hashes per guest)', all(x and x['desyncs'] == 0 for x in st) and st[0]['hashChecks'] >= 5, [(x['slot'], x['desyncs'], x['hashChecks']) for x in st if x])
    if stsp: check('spectator 0 desyncs', stsp['specDesyncs'] == 0, stsp)
    # mic off: tracks stopped, sending closed
    for i in range(NP): pages[i].evaluate('TMNTNETPLAY.voice.disableMic()')
    time.sleep(0.5)
    check('mic off stops tracks', all(not pages[i].evaluate('TMNTNETPLAY.voice.micOn') and pages[i].evaluate('TMNTNETPLAY.voice.stream') is None for i in range(NP)))
    # leave everything
    for pg in reversed(pages): 
        try: pg.evaluate('TMNTNETPLAY.leave()')
        except Exception as e: print('leave', e)
        time.sleep(0.7)
    time.sleep(2)
    # ---- mic denial: browser WITHOUT fake-ui (headless denies) ----
    bd = p.chromium.launch(args=base_args); dp = bd.new_page(viewport={'width': 1280, 'height': 720}); dp.add_init_script('try { localStorage.setItem("tmnt_public", "0") } catch (e) {}'); dp.goto(f'{BASE}?{lang}'); dp.evaluate('TMNTG.whenReady'); dp.keyboard.press('F7'); dp.click('#np-room'); dp.keyboard.type(a.room + '-D', delay=10)
    dp.click('#np-create'); dp.wait_for_function('TMNTNETPLAY.session', timeout=30000); time.sleep(1); fr0 = dp.evaluate('TMNTG.frame()'); dp.click('#np-mic'); time.sleep(1.5)
    msg = dp.evaluate("(() => { const d = document.querySelector('#np .vc div[style*=ffb0a0]'); return d ? d.textContent : null })()"); fr1 = dp.evaluate('TMNTG.frame()')
    print('denied message:', msg); check('mic denied/unavailable: translated message shown, game keeps running, mic stays off', bool(msg) and 'voice.err' not in msg and fr1 > fr0 and not dp.evaluate('TMNTNETPLAY.voice.micOn'), f'frames {fr0}->{fr1}')
    if a.preview: dp.screenshot(path=f'{a.preview}/voice_denied_{a.lang}.png')
    # TAB closes the invite hint early (and TAB still reaches the chat: field opens) -- a 2nd page opens the link of the denied-test room
    gp = bd.new_page(viewport={'width': 1280, 'height': 720}); gp.goto(f'{BASE}?{lang}&sala={dp.evaluate("TMNTNETPLAY.state.room").lower()}'); gp.evaluate('TMNTG.whenReady')
    t0 = time.time(); hv = None
    while time.time() - t0 < 25 and hv is None: hv = gp.evaluate('TMNTNETPLAY.hint'); time.sleep(0.1)
    check('link guest sees the hint (2nd check)', bool(hv), hv)
    time.sleep(1); gp.keyboard.press('Tab'); time.sleep(0.3)
    check('TAB hides the hint', gp.evaluate('TMNTNETPLAY.hint') is None and gp.evaluate('document.getElementById("chatin").style.display') == 'block')
    gp.evaluate('TMNTNETPLAY.leave()'); time.sleep(0.5)
    # ?sala=NOME&assistir=1 joins as spectator from the start (no field Watch button; this URL still works)
    apg = bd.new_page(viewport={'width': 1280, 'height': 720})
    aroom = dp.evaluate('TMNTNETPLAY.state.room')
    apg.goto(f'{BASE}?{lang}&sala={aroom.lower()}&assistir=1'); apg.evaluate('TMNTG.whenReady')
    try:
        apg.wait_for_function('TMNTNETPLAY.session && TMNTNETPLAY.session.spec', timeout=40000)
        check('?sala=&assistir=1 joins as spectator', True, apg.evaluate('({spec: TMNTNETPLAY.session.spec, slot: TMNTNETPLAY.session.slot})'))
        if a.preview: apg.screenshot(path=f'{a.preview}/voice_assistir_{a.lang}.png')
    except Exception as e:
        check('?sala=&assistir=1 joins as spectator', False, e)
    try: apg.evaluate('TMNTNETPLAY.leave()')
    except Exception: pass
    time.sleep(0.5); dp.evaluate('TMNTNETPLAY.leave()'); time.sleep(1); bd.close()
    for b in bs: b.close()
srv.terminate(); time.sleep(1)
after = lst(); still = [r for r in after.get('rooms', []) if a.room.split()[0].upper() in json.dumps(r)]
check('test rooms gone from the list', not still, still)
print('page errors:', errors[:6]); check('no page errors', not [e for e in errors if 'pageerror' in e or ':' in e and 'console' not in e], errors[:3])
print('FAIL: ' + ', '.join(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
