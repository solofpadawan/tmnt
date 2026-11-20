# summarize old/new JSON runs of test_spec_jitter.js (A/B table) + PCM identity on the common frame prefix + host/player path identity
import json,sys,os
L=sys.argv[1] if len(sys.argv)>1 else 'test/logs/specbuf'
def ld(n):
    p=f'{L}/{n}.json'; return json.load(open(p)) if os.path.exists(p) else None
rows=[]
for prof in ('jitter','spikes','default'):
    o,n=ld('old-'+prof),ld('new-'+prof)
    if not (o and n): continue
    print(f'== {prof} ==')
    for k,f in (('stalls (rb.stats.stalls)',lambda d:d['specStallsStat']),('stall ticks',lambda d:d['zeroTicks']),('stall ticks after 4 s',lambda d:d['zeroTicksAfter4s']),('freezes >50 ms',lambda d:d['freezes50ms']),('longest gap ms',lambda d:d['longestGapMs']),
        ('audio underruns',lambda d:d['audio']['underruns']),('audio overruns (drops)',lambda d:d['audio']['overruns']),('dropped samples',lambda d:d['audio']['droppedSamples']),('worklet fill min',lambda d:d['audio']['fillMinSamples']),('fps',lambda d:d['fps']),
        ('resyncs',lambda d:d['resyncs']),('spec desyncs',lambda d:d['specDesyncs']),('player desyncs',lambda d:d['hostDesyncs']),('spec hash checks',lambda d:d['specHashChecks']),('spec lag frames (end)',lambda d:d['specLagFrames'])):
        print(f'  {k:28s} old {f(o)!s:>8}  new {f(n)!s:>8}')
    po=dict(o['pcmDigest']); pn=dict(n['pcmDigest']); common=sorted(set(po)&set(pn)); bad=[x for x in common if po[x]!=pn[x]]
    print(f'  PCM: old {len(po)} frames, new {len(pn)} frames, common {len(common)}, differing {len(bad)}')
    # spectator delay: frames behind host over time not recorded per tick; report playout state
    print('  playout(new):',n['playout'])
    print('  spectator lag behind host (after 8 s): old', o['lag'], ' new', n['lag'])
    ho,hn=o['host'],n['host']
    print('  host/player path identical (frames, state hash, rollbacks, stalls, confirmed-state hash chain, player hashes)?', ho==hn or {k:(ho[k],hn[k]) for k in ho if ho[k]!=hn[k]})
