#!/bin/bash
ROOT=/workspace/tmnt-playerleave-20261112-2340; WEB=$ROOT/stage; LOG=$ROOT/test/logs; cd $ROOT; export PYTHONUNBUFFERED=1
run() { n=$1; shift; echo "== $n $(date +%H:%M:%S)"; if "$@" > $LOG/$n.log 2>&1; then echo "PASS $n"; else echo "FAIL $n"; tail -20 $LOG/$n.log; fi; }
run runtime_stage python3 test/test_web_runtime_stage.py $WEB previews/mame 100 1500
run web_audio python3 test/test_web_audio.py $WEB 1500
run desync_2p1s python3 test/test_desync_spec.py $WEB --players 2 --spectators 1 --secs 20 --taps 4 --sound --preview previews/d21
run desync_4p1s python3 test/test_desync_spec.py $WEB --players 4 --spectators 1 --secs 20 --taps 4 --preview previews/d41
run mic_icon python3 test/test_mic_icon.py $WEB --mode test
run sound_unlock python3 test/test_sound_unlock.py $WEB
echo ALLDONE
