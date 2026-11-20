# TMNT (Konami 1989) HTML5 remake — notes

Target: MAME set `tmnt` (World 4 Players ver. X), 4 simultaneous players (Saulo's explicit choice).
Approach (same as Sunset Riders): the original 68000 program runs on an emulated board (web/sim/tmnt.js + reused
web/sim/m68k.js), checked frame-by-frame against MAME. ROM-free public build: the player selects their own zip
(web/romload.js, files matched by CRC). ROMs and anything derived (roms/, ref/, run/out/, web/assets/, dist/) are
gitignored and must never go in git or shareable zips.

## Hardware / memory map (main 68000 @ 8 MHz, from MAME tmnt.cpp)
- 000000-05ffff program ROM (LOAD16_BYTE), 060000-063fff work RAM, 080000-080fff palette (xBGR_555, big-endian pairs)
- 0a0000 r coins/service, 0a0002-0a0006 P1..P3, 0a0010 DSW1, 0a0012 DSW2, 0a0014 P4, 0a0018 DSW3
- 0a0000 w ctrl: coin counters, bit3 Z80 IRQ, bit5 IRQ5 enable, bit7 K052109 RMRD; 0a0008/9 soundlatch; 0a0010 watchdog
- 0c0000 priority (bit0: sprites over layer A), 100000-107fff K052109 (noA12: only upper byte of words), 106018 etc.
- 140000-140007 K051937, 140400-1407ff K051960 sprite RAM (DMA copied to buffer at vblank)
- 10e801 write: unmapped in MAME too (harmless)
- Frame: 384x264 @ 6 MHz pixel clock = 59.1856 Hz, 135168 CPU cycles; visible 320x224 (lines 16..239); IRQ5 at vblank.
- Draw order: layer B opaque, sprites(pri), layer A, sprites, fix layer. Shadow pen 15 -> darkened.

## ROM layout (web/romset.js)
Program 4 files 16-bit interleave; tiles 2x LOAD32_WORD + chunky_to_planar; sprites 4x LOAD32_WORD + c2p + address
unscramble from PROM 963a30; Z80 sound, K007232, uPD7759, title-music samples kept for later.

## Status
- Video + inputs + boot/self-test/attract/title: working. Sound: emulated (web/sim/tmntsound.js), see below.
- Verification: run/shots.lua with MAME master built SUBTARGET=tmnt at /opt/mame-master/src/tmnt
  (distro 0.276 reports 60 Hz — don't use it for references). test/compare.py (node render) and
  test/test_web_runtime.py (headless Chromium, real page + ROM picker) -> ref/preview/{web,mame,sbs}_f<N>.png.
- Pixel-exact at frames 100-700, 1200, 1400, 1500 (title), 1600, 3000.
- Fixed: the apparent 1-frame lag was frame numbering, not timing. "Frame N" was rendered after N-1 step() calls
  (run_frames started at f=1, game.js skipped step on frame 1); MAME snap N is after N frames. Now N steps = frame N.
  Node: every frame 1..3000 = 0 px diff; browser (test_web_runtime.py) frames 100..3000 step 100 = 0 px.

## Later milestones (from the Sunset Riders handoff — not done yet)
- Reuse sunsetriders ssr.js Konami glue as needed, WebGL CRT + original 16:9 themed bezel (gfx.js; never Konami cabinet art),
  web/net netcode, chat.js bubbles, room list + stats, dist/signal.php + turn_config.php (signal.php reads turn_config.php
  and rooms/ from __DIR__; Saulo uploads both by hand to a new alwaysdata folder like /www/tmnt/).
- IndexedDB ROM cache, 4-player input mapping, save states UI.


## Sound (web/sim/tmntsound.js)
- One-way board driven by m.soundLog [68000 cycle, latch | 0x100 = Z80 IRQ (0a0000 bit3 1->0, HOLD_LINE)].
  Z80 sees an event from the first instruction starting at/after its time (MAME synchronize). z80.js + ym2151.js from
  Sunset Riders; K007232 / uPD7759 / samples ported from MAME; MAME lofi resampler per route; mono gains YM .40x2,
  K007232 .15x2, uPD .30, title .25. Z80 trace = MAME exactly (30 frames, every instruction + cycle).
- MAME quirk reproduced: on the first title-sample start the samples stream switches 48000 -> 20000 Hz and
  output_buffer_flat::resample() leaves floor(now*20000) samples written, so playback starts one 20 kHz sample earlier.
- Verify: node tools/render_wav.js 6000 run/out/ours6k.wav; MAME -wavwrite with run/wav.lua (TMNT_N=6000);
  python3 test/wav_compare.py ours mame -> lag 0, max 16 LSB, mean 0.36, 98.9% within 1 LSB (title: max 9).
- Browser: rendered on the main thread after each frame, PCM to audio_worklet.js FIFO (~50 ms); ?sound=0 disables.
## Milestone: browser audio check, IndexedDB, 4-player input, CRT + bezel
- `test/test_web_audio.py [1500]`: headless Chromium, real AudioContext + worklet (`?audiotest=1`: no drops, records
  received and output samples). 1500 frames = 1,216,512 samples: worklet received == `tools/render_pcm.js` (float32,
  0 diff), worklet output == received (0 diff), output == `tools/render_wav.js` WAV (int16, 0 diff; quantise with
  Math.round semantics, floor(x+0.5)). Also checks a reload boots from the IndexedDB cache.
- `romload.js`: raw ROM files cached in IndexedDB db 'tmnt' / store 'roms' (CRC re-checked on load); otherwise a
  pick/drag-drop overlay. index.html opens straight into the game. `TMNTLOAD.cacheClear()` forgets the ROMs.
- `input.js` (TMNTIN): 4 players, keyboard + gamepads (pad n = player n), F1 remap menu saved in localStorage
  'tmnt_input'. The 4-player 'tmnt' cabinet has no start buttons (MAME: KONAMI16_LSB(n, UNKNOWN, UNKNOWN)): a player
  joins with coin in their own slot + attack. Defaults: P1 arrows Z/X coin 5; P2 RDFG A/S coin 6; P3 IJKL N/M coin 7;
  P4 Num8456 Num0/Num. coin 8; 1-4 and pad Start = attack alias; pad A attack, B jump, Select coin; F2 service.
- `test/test_web_4p.py [2400]`: real key events, coins 5-8, joins, all four walk + attack; gameplay with 4 turtles.
  Writes ref/preview/play4_bezel.png (full 16:9 page, WebGL CRT + bezel) and play4_raw.png.
- `gfx.js` (TMNTGFX): Sunset Riders' CRT shader (W=320) + an original procedural bezel with the same structure
  (background, vignette, outer frame, riveted band, glowing lip, recess, corner pieces, two side signs, title plate):
  night skyline over sewer bricks, steel pipes, manhole covers, neon signs. No image files, logos or characters.

## Online multiplayer (web/net, ported from Sunset Riders)
- WebRTC rollback (net/session.js, rollback.js) over PeerJS-style signaling `net/signal.php` (rooms/ + turn_config.php from `__DIR__`).
  Default signal URL: https://games4me.alwaysdata.net/tmnt/signal.php (alwaysdata folder /www/tmnt/). F7 = panel, TAB = chat.
- Machine.save/load covers 68000, Z80 is in the sound board: TMNTSound.save/load (Z80, RAM, YM2151, K007232, uPD7759,
  routes, pending events). Netplay audio comes from confirmed frames only (G.netAudio); a joining guest gets the host's
  board state inside the snapshot (`ext`). Sound log indices are absolute (Machine.sndBase, trimSound).
- Service key F2 is ignored online (local-only input would desync).
- Player objects (wram = addr-0x100000): 0x2000+0x50*p, word0 0x8x01 = active, +0x0c X (screen x = X-96),
  +0x0e depth (feet y = 240-depth, head = feet-62). wram[1]: 1 attract, 2 in game. Used by chat bubbles/hint.
- Tests: `node tools/state_check.js [N M]` (save/restore determinism: frames, state hashes, PCM);
  `python3 test/test_netplay.py --players 4 --seconds 120 --last-join 30 --preview ref/preview` (php -S, 4 Chromiums, ?netsim).
- Deploy by hand to /www/tmnt/: dist/signal.php, dist/turn_config.php (secrets, gitignored), dist/rooms/.htaccess + index.html.

## Desktop build (Electron 45, Windows x64)
- `desktop/main.js` serves the game via privileged `app://game/` (standard/secure/supportFetchAPI/corsEnabled), blocks net/rooms and *.php (403), 404 for missing files
  (romload: roms/tmnt.zip 404 -> prompt). No menu, fullscreen; F11 / Alt+Enter toggle, Esc only leaves fullscreen; autoplay + no background throttling; synthetic F24 after TMNTG.whenReady starts audio.
  Signal URL in transport.js is already absolute (games4me.alwaysdata.net/tmnt/signal.php). Icon = generated green hex shell (`icon.png/.ico`), not game art.
- `desktop/build.sh semrom` -> `dist/desktop/TMNT-win64-<stamp>.zip`: web = itch zip (make_itch.py, TMNT_PUBLIC, ROM-free check). ROM cached in IndexedDB (origin app://game). Shareable.
- `desktop/build.sh pessoal` -> `...-pessoal-<stamp>.zip`: web/ + roms/tmnt.zip. PERSONAL ONLY, never git/itch/share.
- Needs npm i + wine (rcedit). Test: fill desktop/web, `xvfb-run -a python3 test/test_desktop.py <userdata> <prompt 0|1>`. Invite links use location.href (app://) in desktop: share the room name.
