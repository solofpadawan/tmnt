#!/bin/bash
ROOT=/workspace/tmnt-highscore-20261120-0053; WEB=$ROOT/stage; LOG=$ROOT/test/logs; cd $ROOT; export PYTHONUNBUFFERED=1
run() { n=$1; shift; echo "== $n $(date +%H:%M:%S)"; if "$@" > $LOG/$n.log 2>&1; then echo "PASS $n"; else echo "FAIL $n"; tail -20 $LOG/$n.log; fi
  python3 -c "
import json, urllib.request
d=json.load(urllib.request.urlopen(urllib.request.Request('https://games4me-netplay.games4me.workers.dev/tmnt_web/signal.php?a=list', headers={'User-Agent':'Mozilla/5.0'}), timeout=10)); print('public rooms after $n:', d.get('rooms'))"; }
run highscore_check node test/highscore_check.js
run mame_ram_check bash -c "bash test/mame/run_mame.sh && node test/mame/mame_check.js"
run highscore_report python3 test/test_highscore_report.py $WEB --preview previews/highscore
run runtime_stage python3 test/test_web_runtime_stage.py $WEB previews/mame 100 1500
run web_audio python3 test/test_web_audio.py $WEB 1500
run spec_audio python3 test/test_spec_audio.py $WEB --preview previews --hold 25 --out $LOG/spec_audio.json
run desync_2p1s python3 test/test_desync_spec.py $WEB --players 2 --spectators 1 --secs 20 --taps 4 --sound --preview previews/d21
run desync_4p1s python3 test/test_desync_spec.py $WEB --players 4 --spectators 1 --secs 20 --taps 4 --preview previews/d41
run sound_unlock python3 test/test_sound_unlock.py $WEB
echo ALLDONE
