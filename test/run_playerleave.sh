#!/bin/bash
ROOT=/workspace/tmnt-playerleave-20261112-2340; WEB=$ROOT/stage; OLD=/workspace/tmnt-loading-20261112-2015/stage; LOG=$ROOT/test/logs; cd $ROOT; export PYTHONUNBUFFERED=1
run() { n=$1; shift; echo "== $n $(date +%H:%M:%S)"; if "$@" > $LOG/$n.log 2>&1; then echo "PASS $n"; else echo "FAIL $n"; tail -20 $LOG/$n.log; fi; }
run player_leave_after python3 test/test_player_leave.py $WEB --out $LOG/pl_after.json
run player_leave_before python3 test/test_player_leave.py $OLD --before --preview previews --out $LOG/pl_before.json
run spec_leave_wait python3 test/test_spec_leave_wait.py $WEB
run idle_close python3 test/test_idle_close.py $WEB
run runtime_stage python3 test/test_web_runtime_stage.py $WEB previews/mame 100 1500
run web_audio python3 test/test_web_audio.py $WEB 1500
run desync_2p1s python3 test/test_desync_spec.py $WEB --players 2 --spectators 1 --secs 20 --taps 4 --sound --preview previews/d21
run desync_4p1s python3 test/test_desync_spec.py $WEB --players 4 --spectators 1 --secs 20 --taps 4 --preview previews/d41
run loading python3 test/test_loading.py $WEB
echo ALLDONE
