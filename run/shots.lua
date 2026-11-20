-- snapshot at the frames in TMNT_FRAMES (default every 100 to 3000), then exit
local frames={} local s=os.getenv("TMNT_FRAMES") or ""
if s=="" then for f=100,3000,100 do frames[f]=1 end else for f in s:gmatch("%d+") do frames[tonumber(f)]=1 end end
local last=0 for f in pairs(frames) do if f>last then last=f end end
local n=0
emu.register_frame_done(function()
  n=n+1
  if frames[n] then manager.machine.video:snapshot() end
  if n>=last then manager.machine:exit() end
end)
