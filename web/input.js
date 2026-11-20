// TMNT local input: 4 players (keyboard + gamepads), configurable, saved in localStorage ('tmnt_input').
// One FrameInput per emulated frame = 4 player bytes, active HIGH: bit 0 left, 1 right, 2 up, 3 down, 4 attack,
// 5 jump, 6 coin, 7 start (netcode-ready: the game only ever sees FrameInputs). applyFrame() maps them onto the
// cabinet ports as MAME 'tmnt' does: P1..P4 (KONAMI16_LSB: bit 4 button 1 attack, 5 button 2 jump; active low) and
// COINS (bits 0-3 coin 1-4, bits 4-7 service 1-4). The 4-player cabinet has NO start buttons (bit 7 is unused):
// a player joins by inserting a coin in their own slot and pressing attack, so 'start' is a convenience alias for
// attack (keys 1-4 / pad Start). F2 = service coin for P1. F1 opens the controls menu.
(function (G) {
  'use strict';
  const ACT = ['left', 'right', 'up', 'down', 'attack', 'jump', 'coin', 'start'];
  const DEF_KEYS = [
    { left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], attack: ['KeyZ'], jump: ['KeyX'], coin: ['Digit5'], start: ['Digit1', 'Enter'] },
    { left: ['KeyD'], right: ['KeyG'], up: ['KeyR'], down: ['KeyF'], attack: ['KeyA'], jump: ['KeyS'], coin: ['Digit6'], start: ['Digit2'] },
    { left: ['KeyJ'], right: ['KeyL'], up: ['KeyI'], down: ['KeyK'], attack: ['KeyN'], jump: ['KeyM'], coin: ['Digit7'], start: ['Digit3'] },
    { left: ['Numpad4'], right: ['Numpad6'], up: ['Numpad8'], down: ['Numpad5'], attack: ['Numpad0'], jump: ['NumpadDecimal'], coin: ['Digit8'], start: ['Digit4'] },
  ];
  // gamepad (standard mapping) button per action; d-pad 12-15 and the left stick always move
  const DEF_PAD = { attack: 0, jump: 1, coin: 8, start: 9 };
  const clone = o => JSON.parse(JSON.stringify(o));
  let cfg = { keys: clone(DEF_KEYS), pad: clone(DEF_PAD), padOrder: [0, 1, 2, 3] };
  try { const s = JSON.parse(localStorage.getItem('tmnt_input')); if (s && s.keys && s.keys.length === 4) cfg = Object.assign(cfg, s); } catch (e) {}
  const save = () => { try { localStorage.setItem('tmnt_input', JSON.stringify(cfg)); } catch (e) {} };
  const held = {}, virt = new Uint8Array(4); // virt: test/automation presses (TMNTIN.press)
  let menu = null, block = false;
  // Editable fields swallow gameplay keys. A readonly or disabled INPUT (the invite link) does not.
  function typingTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !(t.readOnly || t.disabled);
    return false;
  }
  const typing = e => typingTarget(e.target);
  function focusScreen() {
    const c = document.getElementById('screen');
    if (!c || !c.focus) return;
    try { c.focus({ preventScroll: true }); } catch (e) { try { c.focus(); } catch (e2) {} }
  }
  function attach(target) {
    target.addEventListener('keydown', e => {
      if (menu && menu.onKey(e)) { e.preventDefault(); return; }
      if (e.code === 'F1') { e.preventDefault(); toggleMenu(); return; }
      if (typing(e)) return; held[e.code] = 1;
      if (/^(Arrow|Space|Numpad|F2)/.test(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', e => { held[e.code] = 0; });
    target.addEventListener('blur', () => { for (const k in held) held[k] = 0; });
  }
  function padBits(p) {
    if (!p || !p.connected) return 0;
    const b = i => p.buttons[i] && p.buttons[i].pressed, ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    let v = 0;
    if (b(14) || ax < -0.5) v |= 1; if (b(15) || ax > 0.5) v |= 2; if (b(12) || ay < -0.5) v |= 4; if (b(13) || ay > 0.5) v |= 8;
    for (let i = 4; i < 8; i++) if (b(cfg.pad[ACT[i]])) v |= 1 << i;
    return v;
  }
  const clean = b => { if ((b & 3) === 3) b &= ~3; if ((b & 12) === 12) b &= ~12; return b; };
  function sample() {
    const out = new Uint8Array(4);
    if (block || menu) return out;
    for (let p = 0; p < 4; p++) { const km = cfg.keys[p]; for (let i = 0; i < 8; i++) for (const k of km[ACT[i]] || []) if (held[k]) out[p] |= 1 << i; }
    const pads = (G.navigator && navigator.getGamepads) ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) { const p = cfg.padOrder.indexOf(i); if (p >= 0) out[p] |= padBits(pads[i]); }
    for (let p = 0; p < 4; p++) out[p] = clean(out[p] | virt[p]);
    return out;
  }
  function applyFrame(m, fi, net) { // net: online, the service key (F2, local only) would desync the peers
    let coins = 0xff;
    for (let p = 0; p < 4; p++) { const b = fi[p] | 0; m.inputs[p] = 0xff & ~((b & 0x3f) | ((b >> 3) & 0x10)); if (b & 0x40) coins &= ~(1 << p); }
    if (held.F2 && !net) coins &= ~0x10;
    m.inputs[4] = coins;
  }
  // ---------- controls menu (F1): click an entry, then press a key or gamepad button ----------
  const NAME = c => c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^Arrow/, '');
  function toggleMenu() {
    if (menu) { clearInterval(menu.poll); menu.el.remove(); menu = null; return; }
    const el = document.createElement('div'); el.id = 'tmntin';
    el.style.cssText = 'position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.78);color:#e8f5d0;font:clamp(11px,1.7vmin,16px) system-ui,sans-serif';
    menu = { el, wait: null, onKey: null };
    const render = () => {
      let h = '<div style="background:#0d1a10;border:3px solid #4caf50;border-radius:12px;padding:2vmin 3vmin;max-height:92vh;overflow:auto"><h2 style="margin:0 0 .6em;color:#8bd94a">Controls (F1 / Esc to close)</h2><table style="border-collapse:collapse">';
      h += '<tr><th></th>' + [1, 2, 3, 4].map(p => `<th style="padding:.2em 1em">P${p}</th>`).join('') + '<th style="padding:.2em 1em">Pad button</th></tr>';
      for (const a of ACT) {
        h += `<tr><td style="padding:.2em .6em;text-transform:capitalize">${a}</td>`;
        for (let p = 0; p < 4; p++) { const w = menu.wait && menu.wait.p === p && menu.wait.a === a; h += `<td><button data-p="${p}" data-a="${a}" style="min-width:7em;font:inherit;background:${w ? '#8bd94a' : '#1f3a22'};color:#fff;border:1px solid #4caf50;border-radius:5px">${w ? 'press…' : (cfg.keys[p][a] || []).map(NAME).join(' / ') || '-'}</button></td>`; }
        h += `<td style="text-align:center">${a in cfg.pad ? '#' + cfg.pad[a] : 'd-pad / stick'}</td></tr>`;
      }
      h += '</table><p style="opacity:.8">Gamepad n drives player n. Click a key to rebind (Backspace clears). <button id="tmntin-def">Defaults</button></p></div>';
      el.innerHTML = h;
      el.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => { menu.wait = { p: +b.dataset.p, a: b.dataset.a }; render(); });
      el.querySelector('#tmntin-def').onclick = () => { cfg = { keys: clone(DEF_KEYS), pad: clone(DEF_PAD), padOrder: [0, 1, 2, 3] }; save(); render(); };
    };
    menu.onKey = e => {
      if (!menu.wait) { if (e.code === 'Escape' || e.code === 'F1') { toggleMenu(); return true; } return false; }
      const { p, a } = menu.wait;
      if (e.code === 'Backspace') cfg.keys[p][a] = [];
      else if (e.code !== 'Escape') { for (const q of cfg.keys) for (const k in q) q[k] = q[k].filter(c => c !== e.code); cfg.keys[p][a] = [e.code]; }
      menu.wait = null; save(); render(); return true;
    };
    // a gamepad button pressed while an entry waits rebinds that action's pad button (attack / jump / coin / start)
    menu.poll = setInterval(() => {
      if (!menu || !menu.wait || !(menu.wait.a in cfg.pad)) return;
      for (const pd of (navigator.getGamepads ? navigator.getGamepads() : [])) if (pd) pd.buttons.forEach((b, i) => {
        if (b.pressed && (i < 12 || i > 15) && menu.wait) { cfg.pad[menu.wait.a] = i; menu.wait = null; save(); render(); }
      });
    }, 50);
    document.body.appendChild(el); render();
  }
  const api = { ACT, attach, sample, applyFrame, held, virt, typingTarget, focusScreen, get cfg() { return cfg; }, get block() { return block; }, set block(v) { block = v; }, L: 1, R: 2, U: 4, D: 8, ATTACK: 16, JUMP: 32, COIN: 64, toggleMenu,
    press(p, act, on) { const b = 1 << ACT.indexOf(act); if (on) virt[p] |= b; else virt[p] &= ~b; } };
  if (typeof module !== 'undefined') module.exports = api; else G.TMNTIN = api;
})(typeof window !== 'undefined' ? window : globalThis);
