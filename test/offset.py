import sys
from PIL import Image, ImageChops
# MAME snaps run/out/snap/tmnt/(f-1).png for frames 1..N; ours run/out/ours/f.png
def diff(a,b):
    return sum(1 for v in ImageChops.difference(a,b).convert('L').get_flattened_data() if v)
N=int(sys.argv[1]); fr=[int(x) for x in sys.argv[2:]]
for f in fr:
    m=Image.open(f'run/out/snap/tmnt/{f-1:04d}.png').convert('RGB')
    r=[]
    for o in (-2,-1,0,1,2):
        if 1<=f+o<=N: r.append((o,diff(Image.open(f'run/out/ours/{f+o}.png').convert('RGB'),m)))
    print(f,r)
