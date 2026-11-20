#!/usr/bin/env python3
"""Audio unlock hint: shown ONLY while the AudioContext is suspended/blocked; first click or key resumes audio and hides it.
Never shown when audio is already running, nor with ?sound=0. Covers the Assistir/spectator case (context created at ready, no prior click).
Usage: python3 test/test_sound_unlock.py web [--preview DIR]
"""
import argparse, os, sys, time, socket, subprocess
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser(); ap.add_argument('web'); ap.add_argument('--preview', default='')
a = ap.parse_args()
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', a.web],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BASE = f'http://127.0.0.1:{port}/index.html'
fails = []
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
    if not ok: fails.append(name)

def hint(pg):
    return pg.evaluate("""() => {
      const e = document.getElementById('sndhint');
      const ac = TMNTG.audio && TMNTG.audio.ac;
      const cs = e ? getComputedStyle(e) : null;
      return {
        exists: !!e,
        display: cs ? cs.display : 'none',
        text: e ? (e.textContent || '') : '',
        ac: ac ? ac.state : null,
        ready: !!(TMNTG.audio && TMNTG.audio.ready)
      };
    }""")

def hide_chrome(pg):
    pg.evaluate("""() => {
      const h = document.getElementById('hint');
      if (h) { h.style.transition = 'none'; h.style.opacity = '0'; h.classList.add('off'); }
      if (window.TMNTHINT) TMNTHINT.off = true;
    }""")

def wait_ready(pg):
    pg.evaluate('TMNTG.whenReady')
    pg.wait_for_function('window.TMNTG && TMNTG.ready', timeout=60000)

try:
    with sync_playwright() as p:
        blocked = ['--autoplay-policy=document-user-activation-required',
                   '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
        # --- no autoplay: context starts suspended, hint must appear, then vanish on click / key ---
        for lang, expect in (('pt', 'Clique para ativar o som'), ('en', 'Click to enable sound')):
            b = p.chromium.launch(args=blocked)
            pg = b.new_page(viewport={'width': 1920, 'height': 1080})
            pg.goto(f'{BASE}?lang={lang}&pause=1')
            wait_ready(pg)
            hide_chrome(pg)
            # context must exist at ready even without a gesture (Assistir / spectator case)
            t0 = time.time(); st = hint(pg)
            while time.time() - t0 < 5 and st['ac'] is None:
                time.sleep(0.1); st = hint(pg)
            check(f'{lang}: AudioContext exists at ready before a click', st['ac'] is not None, st)
            while time.time() - t0 < 6 and not (st['display'] == 'block' and st['ac'] in ('suspended', 'interrupted')):
                time.sleep(0.1); st = hint(pg)
            if st['ac'] == 'running':
                pg.evaluate("TMNTG.audio && TMNTG.audio.ac && TMNTG.audio.ac.suspend()")
                t1 = time.time(); st = hint(pg)
                while time.time() - t1 < 3 and st['display'] != 'block':
                    time.sleep(0.1); st = hint(pg)
            check(f'{lang}: hint visible while AudioContext is suspended',
                  st['display'] == 'block' and st['ac'] in ('suspended', 'interrupted') and st['text'] == expect,
                  st)
            if a.preview and st['display'] == 'block':
                try: pg.evaluate('n => TMNTG.runTo(n)', 1500)
                except Exception: pass
                hide_chrome(pg)
                time.sleep(0.15)
                pg.screenshot(path=f'{a.preview}/sound_unlock_{lang}_1920x1080.png')
            # click the game (pointerdown) unlocks
            pg.click('#screen', position={'x': 160, 'y': 112}, force=True)
            t0 = time.time(); st = hint(pg)
            while time.time() - t0 < 5 and not (st['ac'] == 'running' and st['display'] in ('none', '') and st['ready']):
                time.sleep(0.1); st = hint(pg)
            check(f'{lang}: click resumes audio and hides the hint',
                  st['ac'] == 'running' and st['display'] in ('none', '') and st['ready'], st)
            b.close()

        # key path (fresh page, pt)
        b = p.chromium.launch(args=blocked)
        pg = b.new_page(viewport={'width': 1920, 'height': 1080})
        pg.goto(f'{BASE}?lang=pt&pause=1')
        wait_ready(pg)
        t0 = time.time(); st = hint(pg)
        while time.time() - t0 < 5 and st['display'] != 'block':
            time.sleep(0.1); st = hint(pg)
        if st['ac'] == 'running':
            pg.evaluate("TMNTG.audio && TMNTG.audio.ac && TMNTG.audio.ac.suspend()")
            t0 = time.time(); st = hint(pg)
            while time.time() - t0 < 3 and st['display'] != 'block':
                time.sleep(0.1); st = hint(pg)
        check('keydown path: hint shown before a key', st['display'] == 'block' and st['ac'] in ('suspended', 'interrupted'), st)
        pg.keyboard.press('Enter')
        t0 = time.time(); st = hint(pg)
        while time.time() - t0 < 5 and not (st['ac'] == 'running' and st['display'] in ('none', '')):
            time.sleep(0.1); st = hint(pg)
        check('keydown path: key resumes audio and hides the hint', st['ac'] == 'running' and st['display'] in ('none', '') and st['ready'], st)
        b.close()

        # spectator-like: ?assistir=1 (no prior click), then click enables sound
        b = p.chromium.launch(args=blocked)
        pg = b.new_page(viewport={'width': 1920, 'height': 1080})
        pg.goto(f'{BASE}?lang=pt&pause=1&assistir=1')
        wait_ready(pg)
        t0 = time.time(); st = hint(pg)
        while time.time() - t0 < 5 and not (st['ac'] in ('suspended', 'interrupted') and st['display'] == 'block'):
            if st['ac'] == 'running':
                pg.evaluate("TMNTG.audio && TMNTG.audio.ac && TMNTG.audio.ac.suspend()")
            time.sleep(0.1); st = hint(pg)
        check('spectator-like: hint while blocked before a click', st['display'] == 'block' and st['ac'] in ('suspended', 'interrupted'), st)
        pg.click('#screen', position={'x': 160, 'y': 112}, force=True)
        t0 = time.time(); st = hint(pg)
        while time.time() - t0 < 5 and not (st['ac'] == 'running' and st['display'] in ('none', '') and st['ready']):
            time.sleep(0.1); st = hint(pg)
        check('spectator-like: click enables sound and hides the hint',
              st['ac'] == 'running' and st['display'] in ('none', '') and st['ready'], st)
        b.close()

        # ?sound=0: never show, no context
        b = p.chromium.launch(args=blocked)
        pg = b.new_page()
        pg.goto(f'{BASE}?lang=pt&sound=0')
        wait_ready(pg)
        time.sleep(0.8)
        st = hint(pg)
        check('?sound=0: no unlock hint and no AudioContext', st['display'] in ('none', '') and st['ac'] is None, st)
        pg.keyboard.press('Enter'); time.sleep(0.3); st = hint(pg)
        check('?sound=0: still no hint after a key', st['display'] in ('none', '') and st['ac'] is None, st)
        b.close()

        # autoplay allowed: context runs without a click, hint must never appear
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 1920, 'height': 1080})
        pg.goto(f'{BASE}?lang=pt&pause=1')
        wait_ready(pg)
        t0 = time.time(); st = hint(pg)
        while time.time() - t0 < 8 and not (st['ac'] == 'running' and st['ready']):
            time.sleep(0.1); st = hint(pg)
        check('autoplay: AudioContext is running and the hint stays hidden',
              st['ac'] == 'running' and st['display'] in ('none', '') and st['ready'], st)
        if a.preview:
            try: pg.evaluate('n => TMNTG.runTo(n)', 1500)
            except Exception: pass
            hide_chrome(pg)
            time.sleep(0.2)
            st = hint(pg)
            check('autoplay preview: hint still hidden on the running game', st['display'] in ('none', ''), st)
            pg.screenshot(path=f'{a.preview}/sound_running_nohint_pt_1920x1080.png')
        b.close()
finally:
    srv.terminate()

if fails:
    print('FAILED', fails); sys.exit(1)
print('OK')
