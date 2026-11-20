-- MAME reference log: drives the SAME 4-player input script as ramlog.js (node sim) and logs, every frame, game mode (0x60001),
-- per-slot score words (0x60104+8s), lives (0x60101+8s) and the state byte (0x60107+8s).  usage: TMNT_N=9000 TMNT_OUT=file
local N=tonumber(os.getenv("TMNT_N") or "9000"); local out=io.open(os.getenv("TMNT_OUT") or "/tmp/mame_ramlog.txt","w")
local MASK=tonumber(os.getenv("TMNT_MASK") or "15")
local mach=manager.machine; local sp=mach.devices[":maincpu"].spaces["program"]
local ports=mach.ioport.ports
local function fld(tag,name) return ports[tag].fields[name] end
local F={}
for p=1,4 do F[p]={left=fld(":P"..p,"P"..p.." Left"),right=fld(":P"..p,"P"..p.." Right"),up=fld(":P"..p,"P"..p.." Up"),down=fld(":P"..p,"P"..p.." Down"),b1=fld(":P"..p,"P"..p.." Button 1"),b2=fld(":P"..p,"P"..p.." Button 2"),coin=fld(":COINS","Coin "..p)} end
local function script(f,p) -- p = 0..3 ; returns bitmask like the JS script
  local o=0
  if (MASK>>p)&1==0 then return 0 end
  if f>=600+30*p and f<608+30*p then o=o|0x40 end
  if f>=760+30*p and f<768+30*p then o=o|0x10 end
  if f>1900 then local x=((((f//17)+101*p)*2654435761)&0xffffffff)>>11; local t={0,1,2,4,8,16,32,17,34}; o=o|t[(x%9)+1] end
  return o
end
local function apply(f)
  for p=0,3 do local b=script(f,p); local k=F[p+1]
    k.left:set_value(b&1); k.right:set_value((b>>1)&1); k.up:set_value((b>>2)&1); k.down:set_value((b>>3)&1)
    k.b1:set_value((b>>4)&1); k.b2:set_value((b>>5)&1); k.coin:set_value((b>>6)&1) end
end
local n=0
apply(1)
emu.register_frame_done(function()
  n=n+1
  local t={n,sp:read_u8(0x60001)}
  for s=0,3 do t[#t+1]=string.format("%02x%02x",sp:read_u8(0x60104+8*s),sp:read_u8(0x60105+8*s)); t[#t+1]=sp:read_u8(0x60101+8*s)..'/'..sp:read_u8(0x60107+8*s) end
  out:write(table.concat(t," ").."\n")
  if n>=N then out:close(); mach:exit() else apply(n+1) end
end)
