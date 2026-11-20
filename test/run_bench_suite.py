#!/usr/bin/env python3
"""Run the TMNT netplay bench matrix and write per-scenario JSON + a summary table."""
import argparse, json, os, subprocess, sys, time
ap = argparse.ArgumentParser()
ap.add_argument('web')
ap.add_argument('--tag', required=True)
ap.add_argument('--outdir', required=True)
ap.add_argument('--secs', type=float, default=45)
ap.add_argument('--warm', type=float, default=12)
ap.add_argument('--preview', default='')
ap.add_argument('--only', default='')  # comma-separated tags to run a subset
a = ap.parse_args()
HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.join(HERE, 'test_netplay_bench.py')
os.makedirs(a.outdir, exist_ok=True)
SCENARIOS = [
    dict(key='2p-50', players=2, rtt=50, slow=0, taps=8),
    dict(key='2p-180', players=2, rtt=180, slow=0, taps=8),
    dict(key='2p-500', players=2, rtt=500, slow=0, taps=8),
    dict(key='4p-50', players=4, rtt=50, slow=0, taps=4),
    dict(key='4p-180', players=4, rtt=180, slow=0, taps=4),
    dict(key='4p-500', players=4, rtt=500, slow=0, taps=4),
    dict(key='4p-slow', players=4, rtt=50, slow=500, taps=4),
]
if a.only:
    want = set(a.only.split(','))
    SCENARIOS = [s for s in SCENARIOS if s['key'] in want]
rows = []
for s in SCENARIOS:
    out = os.path.join(a.outdir, f"{a.tag}_{s['key']}.json")
    log = os.path.join(a.outdir, f"{a.tag}_{s['key']}.log")
    cmd = [sys.executable, BENCH, a.web,
           '--players', str(s['players']), '--rtt', str(s['rtt']),
           '--taps', str(s['taps']), '--secs', str(a.secs), '--warm', str(a.warm),
           '--tag', f"{a.tag}_{s['key']}", '--out', out]
    if s['slow']:
        cmd += ['--slow', str(s['slow'])]
    if a.preview and s['key'] == '4p-50':
        cmd += ['--preview', a.preview]
    print('RUN', ' '.join(cmd), flush=True)
    t0 = time.time()
    with open(log, 'w') as lf:
        rc = subprocess.call(cmd, stdout=lf, stderr=subprocess.STDOUT)
    wall = time.time() - t0
    rec = dict(s, tag=a.tag, rc=rc, wall=round(wall, 1), out=out, log=log)
    if rc == 0 and os.path.isfile(out):
        data = json.load(open(out))
        peers = data.get('peers') or []
        fps = [p['fps'] for p in peers] if peers else []
        desyncs = sum(p.get('desyncs', 0) for p in peers)
        # also final desyncs
        fin = data.get('final') or []
        desyncs = max(desyncs, sum(x.get('d', 0) for x in fin))
        tap = data.get('tap') or {}
        lost = sum(tap.get('lost') or [0])
        sent = sum(tap.get('sent') or [0])
        rec.update(fps_avg=round(sum(fps)/len(fps), 1) if fps else None,
                   fps_min=round(min(fps), 1) if fps else None,
                   lost=lost, sent=sent, desyncs=desyncs, npeers=len(peers),
                   delay=[round(p.get('delayAvg', 0), 1) for p in peers],
                   errors=len(data.get('errors') or []))
        print(f"  {s['key']} fps={rec['fps_avg']} lost={lost}/{sent} desyncs={desyncs} wall={wall:.0f}s", flush=True)
    else:
        print(f"  {s['key']} FAILED rc={rc} wall={wall:.0f}s — see {log}", flush=True)
        # print tail
        try:
            print(''.join(open(log).readlines()[-30:]), flush=True)
        except Exception:
            pass
    rows.append(rec)
    json.dump(rows, open(os.path.join(a.outdir, f'{a.tag}_summary.json'), 'w'), indent=1)
print('SUITE_DONE', a.tag, 'failed', sum(1 for r in rows if r.get('rc') != 0))
sys.exit(1 if any(r.get('rc') != 0 for r in rows) else 0)
