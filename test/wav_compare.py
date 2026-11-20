# python3 test/wav_compare.py ours.wav mame.wav: best lag, max/mean abs diff (int16 LSB), and per-second breakdown
import sys, wave, numpy as np
def rd(f):
    w = wave.open(f); a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.int64)
    return a.reshape(-1, w.getnchannels()).mean(1), w.getframerate()
a, ra = rd(sys.argv[1]); b, rb = rd(sys.argv[2]); assert ra == rb
n = min(len(a), len(b)); best = None
for lag in range(-50, 51):
    x = a[max(0, lag):n + min(0, lag)]; y = b[max(0, -lag):n - max(0, lag)]; m = min(len(x), len(y))
    d = np.abs(x[:m] - y[:m]).mean()
    if best is None or d < best[1]: best = (lag, d)
lag = best[0]; x = a[max(0, lag):]; y = b[max(0, -lag):]; m = min(len(x), len(y)); d = np.abs(x[:m] - y[:m])
print('lag', lag, 'samples', m, 'max', int(d.max()), 'mean %.3f' % d.mean(), 'exact %.2f%%' % (100 * (d == 0).mean()),
      'within1 %.2f%%' % (100 * (d <= 1).mean()), 'rms ours %.0f mame %.0f' % (np.sqrt((x[:m]**2).mean()), np.sqrt((y[:m]**2).mean())))
for s in range(0, m // ra):
    seg = d[s * ra:(s + 1) * ra]; print(' sec %2d max %6d mean %8.3f  rms mame %6.0f' % (s, seg.max(), seg.mean(), np.sqrt((y[s*ra:(s+1)*ra]**2).mean())))
