#!/bin/bash
set -o pipefail
ROOT=/workspace/tmnt-voice-20261110-voice-0946
WEB=/workspace/tmnt-voice-20261110-voice-0946/stage
PREV=/workspace/tmnt-voice-20261110-voice-0946/previews
LOG=/workspace/tmnt-voice-20261110-voice-0946/test/logs
REF=/workspace/tmnt-voice-20261110-voice-0946/ref-pt/old-pt-dump.txt
export PYTHONUNBUFFERED=1
ok=0
fail=0
run() {
  local name="$1"; shift
  echo "========== $name $(date +%H:%M:%S) =========="
  if "$@" > "$LOG/$name.log" 2>&1; then
    echo "PASS $name"
    ok=$((ok+1))
  else
    echo "FAIL $name exit $?"
    tail -40 "$LOG/$name.log"
    fail=$((fail+1))
  fi
}
cd "$ROOT"
run web_audio python3 test/test_web_audio.py "$WEB" 1500
run i18n python3 test/test_i18n_panel.py "$WEB" "$PREV/i18n" "$REF"
run room_name python3 test/test_room_name.py "$WEB" --preview "$PREV/room"
run cf_2peer python3 test/test_cf_2peer.py "$WEB" 40 "$PREV/cf"
run desync_2p2s python3 test/test_desync_spec.py "$WEB" --players 2 --spectators 2 --secs 20 --taps 4 --preview "$PREV/d22"
run desync_4p1s python3 test/test_desync_spec.py "$WEB" --players 4 --spectators 1 --secs 20 --taps 4 --preview "$PREV/d41"
run bench python3 test/run_bench_suite.py "$WEB" --tag voice-0946 --outdir "$ROOT/bench" --preview "$PREV/bench" --only 2p-50,4p-50 --secs 50 --warm 12
run voice python3 test/test_voice.py "$WEB" --players 4 --spectator 1 --lang pt --preview "$PREV/voice"
echo "========== SUMMARY $(date +%H:%M:%S) ok=$ok fail=$fail =========="
echo $fail > "$LOG/failcount"
exit $fail
