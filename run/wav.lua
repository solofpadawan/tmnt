local n = 0
emu.register_frame_done(function() n = n + 1; if n >= tonumber(os.getenv("TMNT_N") or 1800) then manager.machine:exit() end end)
