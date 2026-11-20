#!/usr/bin/env python3
"""Pixel-compare our renders (run/out/ours/<f>.png) with MAME snapshots taken by run/shots.lua at the same frames.
usage: test/compare.py F1 F2 ...   (MAME snaps run/out/snap/tmnt/NNNN.png are in ascending frame order)"""
import sys
from PIL import Image, ImageChops
fr = sorted(int(a) for a in sys.argv[1:])
tot = 0
for i, f in enumerate(fr):
    a = Image.open(f'run/out/ours/{f}.png').convert('RGB'); b = Image.open(f'run/out/snap/tmnt/{i:04d}.png').convert('RGB')
    d = ImageChops.difference(a, b).convert('L').point(lambda v: 255 if v else 0)
    n = sum(1 for v in d.getdata() if v); bb = d.getbbox()
    print(f'frame {f}: {100*(1-n/(320*224)):.3f}% match, {n} px differ, bbox {bb}'); tot += n
print('total differing px', tot)
