#!/usr/bin/env python3
"""Headless Chromium regression test: load web/ with the local roms/tmnt.zip through the ROM picker, run the machine to
FRAME (default 1500 = title screen), and pixel-compare the canvas with a MAME snapshot of the same frame
(run/shots.lua, MAME built from master with tmnt.cpp). Writes ref/preview/{web,mame,sbs}_f<FRAME>.png.
usage: test/test_web_runtime.py [FRAME]   (needs /opt/mame-master/src/tmnt; ROMs stay local)"""
import base64, io, os, subprocess, sys, shutil
from PIL import Image, ImageChops
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from webutil import page, load
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
MAME = os.environ.get('TMNT_MAME', '/opt/mame-master/src/tmnt')
PREV = os.path.join(ROOT, 'ref/preview'); os.makedirs(PREV, exist_ok=True)

def mame_frame(f):
    out = os.path.join(ROOT, 'run/out/ref%d' % f); shutil.rmtree(out, ignore_errors=True)
    subprocess.run([MAME, 'tmnt', '-rompath', os.path.join(ROOT, 'roms'), '-video', 'none', '-sound', 'none', '-nothrottle',
                    '-skip_gameinfo', '-nvram_directory', out + '/nv', '-cfg_directory', out + '/cfg', '-snapshot_directory', out,
                    '-snapname', '%g/%i', '-autoboot_script', os.path.join(ROOT, 'run/shots.lua')],
                   env=dict(os.environ, TMNT_FRAMES=str(f)), cwd=ROOT, check=True, capture_output=True)
    return Image.open(os.path.join(out, 'tmnt/0000.png')).convert('RGB')

def web_frame(f):
    with page('?pause=1&sound=0') as pg:
        load(pg)
        pg.evaluate('n => TMNTG.runTo(n)', f)
        url = pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).convert('RGB')

ours, ref = web_frame(FRAME), mame_frame(FRAME)
d = ImageChops.difference(ours, ref).convert('L')
n = sum(1 for v in d.get_flattened_data() if v) if hasattr(d, 'get_flattened_data') else sum(1 for v in d.getdata() if v)
ours.save(f'{PREV}/web_f{FRAME}.png'); ref.save(f'{PREV}/mame_f{FRAME}.png')
sbs = Image.new('RGB', (640 + 8, 224)); sbs.paste(ours, (0, 0)); sbs.paste(ref, (328, 0)); sbs.save(f'{PREV}/sbs_f{FRAME}.png')
print(f'frame {FRAME}: {n} of {320*224} px differ ({100*(1-n/(320*224)):.3f}% match), bbox {d.getbbox()}')
sys.exit(0 if n == 0 else 1)
