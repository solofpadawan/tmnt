#!/bin/bash
# MAME reference run (MAME 0.276, tmnt, ROM from /workspace/tmnt/roms): logs mode byte / score words / lives / state byte every frame for 4 and 2 players.
export LD_LIBRARY_PATH=/workspace/mame-root/usr/lib:$LD_LIBRARY_PATH
cd "$(dirname "$0")"; mkdir -p ../logs /tmp/mnv /tmp/mcfg
for M in 15 3; do
  TMNT_MASK=$M TMNT_N=${TMNT_N:-9000} TMNT_OUT=../logs/mame_ramlog_mask$M.txt /workspace/mame-root/bin/mame tmnt -rompath /workspace/tmnt/roms -video none -sound none -nothrottle -skip_gameinfo \
    -nvram_directory /tmp/mnv -cfg_directory /tmp/mcfg -seconds_to_run 900 -autoboot_script ramlog.lua >/dev/null 2>&1
  wc -l ../logs/mame_ramlog_mask$M.txt
done
