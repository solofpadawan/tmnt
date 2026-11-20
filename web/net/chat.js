// In-game chat (pt34u). TAB opens a text field, Enter sends, TAB/Esc cancels. The line appears as a speech bubble above
// the sender's character on every screen. Online it travels over the reliable DataChannel (session.chat / 't:c'), never
// through the rollback inputs, so it cannot desync the game. Offline (no room) it shows over P1 (local only).
// Bubbles are drawn on an overlay canvas over #screen (not by render.js), anchored to the player object in 68000 work
// RAM: player p's object at 0x102000+0x50*p: word 0 = 0x8x01 while the turtle is
// in play (0xffff/0 before), word 6 (+0x0c) X (screen x = X-96), word 7 (+0x0e) depth (feet y ≈ 240-depth).
// Only while 0x104001 = 2 (a game is running, not the attract demo).
// Speaking (voice VAD, TMNTNETPLAY.voice.speaking[p]; ported from Moo Mesa): a small procedural white microphone is drawn
// just after that player's nick and blinks while the flag is on (local transmit or a remote speaker, also on a spectator's
// screen). The nick text itself is unchanged. A nick is only drawn while it is on screen, and that already repaints every frame,
// so the on/off phase needs no extra dirty tracking.
(function (G) {
  'use strict';
  const _t = (k, o) => (G.t || ((x) => x))(k, o);
  const W = 320, H = 224, MAXC = 60;
  const COL = ['#4a9cff', '#ff9a2e', '#c45cff', '#ff4848']; // Leonardo, Michelangelo, Donatello, Raphael
  const bubbles = [null, null, null, null], recent = [], specLines = []; // spectator lines: top of the screen, tagged with the name
  // ---- player positions (game pixels); null when not on screen ----
  function playerPos(m, p) {
    const w = m && m.wram; if (!w) return null;
    if (w[1] !== 2) return null; // 0x100001 game mode: 2 = playing
    const o = 0x2000 + 0x50 * p, r = a => (w[a] << 8) | w[a + 1], w0 = r(o);
    if (w0 === 0xffff || (w0 & 0x80ff) !== 0x8001) return null;
    const x = r(o + 12) - 96, feet = 240 - r(o + 14);
    if (x < -8 || x > W + 8 || feet < 24 || feet > H + 40) return null;
    return { x, feet, head: feet - 62 };
  }
  // ---- overlay ----
  let ov = null, oc = null, field = null, open = false, scrEl = null, idle = false;
  const wrapCache = new Map(), measCache = new Map(); // font+maxW+text / font+text, until the text changes
  let namesCached = null, namesSrc = null, namesGen = -1;
  const stats = { draws: 0, skips: 0, clears: 0 };
  let nowOverride = null; // tests / previews: freeze the clock that drives the mic blink
  function screen() { if (!scrEl || !scrEl.isConnected) scrEl = document.getElementById('screen'); return scrEl; }
  function cachedWrap(ctx, text, maxW) {
    const k = ctx.font + '\0' + maxW + '\0' + text; let h = wrapCache.get(k);
    if (h) return h;
    const lines = wrap(ctx, text, maxW), tw = Math.max(...lines.map(l => ctx.measureText(l).width));
    h = { lines, tw }; wrapCache.set(k, h); if (wrapCache.size > 80) wrapCache.delete(wrapCache.keys().next().value); return h;
  }
  function cachedWidth(ctx, text) {
    const k = ctx.font + '\0' + text; let w = measCache.get(k);
    if (w == null) { w = ctx.measureText(text).width; measCache.set(k, w); if (measCache.size > 80) measCache.delete(measCache.keys().next().value); }
    return w;
  }
  function namesOf() {
    const N = G.TMNTNETPLAY && G.TMNTNETPLAY.session; if (!N || !N.rb) { namesCached = null; namesSrc = null; namesGen = -1; return null; }
    const g = N.namesGen | 0;
    if (namesSrc === N && namesGen === g && namesCached) return namesCached;
    namesCached = N.names(); namesSrc = N; namesGen = g; return namesCached;
  }
  function setup() {
    const scr = screen();
    ov = Object.assign(document.createElement('canvas'), { id: 'chatov' });
    ov.style.cssText = 'position:absolute;pointer-events:none;z-index:5';
    scr.after(ov); oc = ov.getContext('2d');
    const css = `#chatin{position:fixed;left:50%;bottom:8%;transform:translateX(-50%);width:min(520px,80vw);z-index:11;display:none;
      font:600 18px system-ui,sans-serif;padding:8px 12px;border-radius:10px;border:3px solid #4a9cff;background:rgba(2,10,4,.92);color:#fff;outline:none}
      #chatin::placeholder{color:#a99}`;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
    field = Object.assign(document.createElement('input'), { id: 'chatin', maxLength: MAXC, autocomplete: 'off', spellcheck: false, placeholder: _t('chat.placeholder') });
    document.body.appendChild(field);
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const t = field.value; close(); send(t); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    field.addEventListener('blur', () => { if (open) close(); });
    addEventListener('keydown', e => {
      if (e.code !== 'Tab' || open) return;
      if (e.target && e.target.tagName === 'INPUT') return; // the F7 panel's fields keep normal TAB
      e.preventDefault(); openField();
    });
  }
  function mySlot() { const N = G.TMNTNETPLAY && G.TMNTNETPLAY.session; return N ? N.slot : 0; }
  function openField() {
    open = true; G.TMNTIN.block = true; for (const k in G.TMNTIN.held) G.TMNTIN.held[k] = 0;
    const s = Math.max(0, mySlot()); field.style.borderColor = COL[s]; field.value = '';
    field.style.display = 'block'; field.focus();
  }
  function close() { if (!open) return; open = false; G.TMNTIN.block = false; field.style.display = 'none'; field.blur(); try { if (G.TMNTIN && G.TMNTIN.focusScreen) G.TMNTIN.focusScreen(); else G.focus(); } catch (e) {} }
  const localRl = G.TMNTSESSION ? new G.TMNTSESSION.RateLimit() : null;
  // send a line: online through the session (it echoes a 'chat' event that calls show), offline as P1
  function send(text) {
    const N = G.TMNTNETPLAY && G.TMNTNETPLAY.session;
    if (N) return N.chat(text);
    const x = G.TMNTSESSION.sanitize(text); if (!x || !localRl.ok(performance.now())) return null;
    show(0, x); return x;
  }
  function show(slot, text, name) {
    const x = G.TMNTSESSION.sanitize(text); if (!x || slot < -1 || slot > 3) return;
    if (slot === -1) {
      const n = G.TMNTSESSION.sanitize(name || _t('chat.spectator')).slice(0, 20);
      specLines.push({ name: n, text: x, t0: performance.now(), dur: 5000 }); if (specLines.length > 3) specLines.shift();
      recent.push({ slot, name: n, text: x, t: Date.now() }); if (recent.length > 50) recent.shift(); return;
    }
    bubbles[slot] = { text: x, t0: performance.now(), dur: 4000 + Math.max(0, x.length - 20) * 60 };
    recent.push({ slot, text: x, t: Date.now() }); if (recent.length > 50) recent.shift();
  }
  function wrap(ctx, text, maxW) {
    const words = text.split(' '), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
      while (ctx.measureText(cur).width > maxW && cur.length > 1) { let k = cur.length - 1; while (k > 1 && ctx.measureText(cur.slice(0, k)).width > maxW) k--; lines.push(cur.slice(0, k)); cur = cur.slice(k); }
    }
    if (cur) lines.push(cur); return lines;
  }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function needsPaint(m, names, now) {
    const N = G.TMNTNETPLAY && G.TMNTNETPLAY.session;
    if (N && N.spec) return true;
    if (specLines.length) return true;
    if (bubbles.some(b => b)) return true;
    if (names) for (let p = 0; p < 4; p++) if (names[p] && !bubbles[p] && playerPos(m, p)) return true;
    if (G.TMNTHINT && G.TMNTHINT.willDraw && G.TMNTHINT.willDraw(m, now)) return true;
    return false;
  }
  function draw(m) {
    if (!ov) return;
    const scr = screen(); if (!scr) return;
    const cw = parseFloat(scr.style.width) || W, ch = parseFloat(scr.style.height) || H;
    const dpr = G.devicePixelRatio || 1, bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    const now = nowOverride != null ? nowOverride : performance.now();
    const names = namesOf(); // nicknames: online only
    const need = needsPaint(m, names, now);
    const layout = ov.width !== bw || ov.height !== bh || ov.style.left !== scr.style.left || ov.style.top !== scr.style.top || ov.style.width !== cw + 'px' || ov.style.height !== ch + 'px';
    if (ov.width !== bw || ov.height !== bh) { ov.width = bw; ov.height = bh; idle = false; }
    ov.style.left = scr.style.left; ov.style.top = scr.style.top; ov.style.width = cw + 'px'; ov.style.height = ch + 'px';
    if (!need) {
      if (!idle || layout) { oc.setTransform(1, 0, 0, 1, 0, 0); oc.clearRect(0, 0, bw, bh); stats.clears++; idle = true; }
      else stats.skips++;
      return;
    }
    idle = false; stats.draws++;
    const c = oc, k = bw / W, ky = bh / H; // 4:3 modes (gfx.js): non-square game pixels
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, bw, bh); stats.clears++;
    c.setTransform(k, 0, 0, ky, 0, 0);
    drawSpec(c, now);
    if (G.TMNTHINT) G.TMNTHINT.draw(c, m, now); // coin hint (net/hint.js), also the spectator's free-slot notice
    const nk = []; if (names) for (let p = 0; p < 4; p++) if (names[p] && !bubbles[p]) drawNick(c, m, p, names[p], nk, now);
    if (!bubbles.some(b => b)) return;
    const placed = [];
    for (let p = 0; p < 4; p++) {
      const b = bubbles[p]; if (!b) continue;
      const age = now - b.t0; if (age > b.dur) { bubbles[p] = null; continue; }
      const alpha = Math.min(1, age / 120, (b.dur - age) / 600);
      c.globalAlpha = alpha;
      c.font = '600 8px system-ui, sans-serif';
      const pos = playerPos(m, p), tail = 6;
      const wr = cachedWrap(c, b.text, pos ? 118 : 60), lines = wr.lines, lh = 9.5; // off screen: the bubble hangs under that player's HUD panel (80 px)
      const w = Math.ceil(wr.tw) + 10, h = lines.length * lh + 7;
      let ax, ay, up; // anchor (tail tip), bubble above (up=false) or below the HUD (up=true)
      if (pos) { ax = pos.x; ay = pos.head; up = false; if (ay - tail - h < 18) { ay = 18 + tail + h; } }
      else { ax = 80 * p + 40; ay = 30; up = true; }
      let bx = Math.round(Math.min(W - w - 2, Math.max(2, ax - w / 2))), by = Math.round(up ? ay + tail : ay - tail - h);
      // two players close together: push this bubble past the ones already drawn (the tail stretches)
      for (let tries = 0; tries < 4; tries++) {
        const hit = placed.find(r => bx < r.x + r.w + 1 && bx + w + 1 > r.x && by < r.y + r.h + 6 && by + h + 6 > r.y);
        if (!hit) break;
        by = up ? hit.y + hit.h + 8 : hit.y - h - 8;
        if (!up && by < 2) { by = hit.y + hit.h + 8; up = true; }
      }
      placed.push({ x: bx, y: by, w, h, p, ax, ay, up, lines, lh, alpha });
    }
    // tails first, then the bodies, so a stretched tail never crosses another bubble's text
    for (const r of placed) {
      c.globalAlpha = r.alpha; c.lineWidth = 1.5; c.strokeStyle = COL[r.p]; c.fillStyle = 'rgba(255,255,255,0.96)';
      const tx = Math.min(r.x + r.w - 6, Math.max(r.x + 6, r.ax));
      c.beginPath();
      if (r.up && r.ay <= r.y) { c.moveTo(tx - 3.5, r.y + 2); c.lineTo(tx, r.ay); c.lineTo(tx + 3.5, r.y + 2); }
      else if (r.up) { c.moveTo(tx - 3.5, r.y + 2); c.lineTo(tx, r.y - 5); c.lineTo(tx + 3.5, r.y + 2); }
      else { c.moveTo(tx - 3.5, r.y + r.h - 2); c.lineTo(tx, r.ay); c.lineTo(tx + 3.5, r.y + r.h - 2); }
      c.fill(); c.stroke();
    }
    for (const r of placed) {
      const { x: bx, y: by, w, h, p, lines, lh } = r;
      c.globalAlpha = r.alpha; c.lineWidth = 1.5; c.strokeStyle = COL[p]; c.fillStyle = 'rgba(255,255,255,0.96)';
      rr(c, bx, by, w, h, 4); c.fill(); c.stroke();
      // open the tail into the body: cover the border stroke across the tail base (white, no stroke)
      const tx = Math.min(bx + w - 6, Math.max(bx + 6, r.ax)); c.beginPath();
      if (r.up) { c.moveTo(tx - 2.6, by + 1.6); c.lineTo(tx, by - 2.2); c.lineTo(tx + 2.6, by + 1.6); }
      else { c.moveTo(tx - 2.6, by + h - 1.6); c.lineTo(tx, by + h + 2.2); c.lineTo(tx + 2.6, by + h - 1.6); }
      c.closePath(); c.fill();
      c.font = '600 8px system-ui, sans-serif';
      c.fillStyle = '#1a1208'; c.textBaseline = 'top';
      lines.forEach((l, i) => c.fillText(l, bx + 5, by + 4 + i * lh));
      c.font = '800 6px system-ui, sans-serif'; const tag = 'P' + (p + 1) + (names && names[p] ? ' ' + names[p] : ''), tgw = cachedWidth(c, tag) + 5;
      c.fillStyle = COL[p]; rr(c, bx - 1, by - 5, tgw, 7, 2); c.fill();
      c.fillStyle = '#000'; c.fillText(tag, bx + 1.5, by - 4.2);
    }
    c.globalAlpha = 1;
  }
  // nickname over the head (player colour, dark outline); hidden while the player object is not active/on screen
  // White mic icon (procedural, no bitmap; identical to Moo Mesa's) just after the nick, vertically centred on the 6 px text
  // (baseline y, centre = y-3). Dark outline like the nick so it stays readable on any background.
  const MIC_BLINK_MS = 120, MIC_GAP = 2, MIC_W = 5;
  function micBlinkOn(t) { return ((t / MIC_BLINK_MS) | 0) % 2 === 0; }
  function drawMicIcon(c, left, y) {
    const cx = left + 2.3, cy = y - 3, hw = 1.15;
    const y0 = cy - 2.1, y1 = cy - 0.35;
    c.save();
    c.globalAlpha = 0.95;
    c.lineJoin = 'round'; c.lineCap = 'round';
    const head = () => { c.beginPath(); c.arc(cx, y0, hw, Math.PI, 0, false); c.arc(cx, y1, hw, 0, Math.PI, false); c.closePath(); };
    head(); c.lineWidth = 2.35; c.strokeStyle = 'rgba(0,0,0,.85)'; c.stroke();
    head(); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 0.35; c.strokeStyle = '#fff'; c.stroke();
    const stand = (w, col) => {
      c.lineWidth = w; c.strokeStyle = col;
      c.beginPath(); c.arc(cx, y1, 1.85, 0.12 * Math.PI, 0.88 * Math.PI, false); c.stroke();
      c.beginPath(); c.moveTo(cx, cy + 1.55); c.lineTo(cx, cy + 2.5);
      c.moveTo(cx - 1.25, cy + 2.5); c.lineTo(cx + 1.25, cy + 2.5); c.stroke();
    };
    stand(2.55, 'rgba(0,0,0,.85)'); stand(0.7, '#fff');
    c.restore();
  }
  // The name string, font, colour and position never change when a mic is shown: the icon is drawn to the right of the
  // already-placed text (the overlap push-up still uses the nick width alone).
  function drawNick(c, m, p, name, nk, now) {
    const pos = playerPos(m, p); if (!pos) return;
    c.font = '700 6px system-ui, sans-serif'; c.textBaseline = 'bottom'; c.textAlign = 'center'; c.globalAlpha = 0.9;
    const w = cachedWidth(c, name), x = Math.min(W - w / 2 - 2, Math.max(w / 2 + 2, pos.x)); let y = Math.max(26, pos.head - 2);
    for (let i = 0; i < 4; i++) { const hit = nk.find(r => Math.abs(r.x - x) < (r.w + w) / 2 + 2 && Math.abs(r.y - y) < 7); if (!hit) break; y = hit.y - 7; }
    nk.push({ x, y, w });
    c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,.85)'; c.lineJoin = 'round'; c.strokeText(name, x, y);
    c.fillStyle = COL[p]; c.fillText(name, x, y); c.textAlign = 'left'; c.globalAlpha = 1;
    const vv = G.TMNTNETPLAY && G.TMNTNETPLAY.voice;
    if (vv && vv.speaking && vv.speaking[p] && micBlinkOn(now)) drawMicIcon(c, x + w / 2 + MIC_GAP, y);
  }
  // spectator overlay: a SPECTATING/ASSISTINDO tag (+ free slot notice) for the spectator itself, and the spectators' chat lines
  function drawSpec(c, now) {
    const N = G.TMNTNETPLAY && G.TMNTNETPLAY.session;
    c.textBaseline = 'top';
    if (N && N.spec) {
      c.globalAlpha = 0.85; c.font = '800 7px system-ui, sans-serif';
      const tag = _t('chat.watching'), w = cachedWidth(c, tag) + 8; c.fillStyle = 'rgba(0,0,0,.6)'; rr(c, W - w - 3, H - 13, w, 10, 3); c.fill();
      c.fillStyle = '#9fe0ff'; c.fillText(tag, W - w + 1, H - 11.5);
    }
    let y = 30;
    for (let i = 0; i < specLines.length; i++) {
      const l = specLines[i], age = now - l.t0; if (age > l.dur) { specLines.splice(i--, 1); continue; }
      c.globalAlpha = Math.min(1, age / 120, (l.dur - age) / 600);
      c.font = '700 6px system-ui, sans-serif'; const tag = l.name, tw = cachedWidth(c, tag);
      c.font = '600 7px system-ui, sans-serif'; const wr = cachedWrap(c, l.text, 200), lines = wr.lines, mw = wr.tw;
      const w = Math.ceil(Math.max(mw, tw)) + 10, h = lines.length * 8.5 + 11, x = Math.round((W - w) / 2);
      c.fillStyle = 'rgba(15,25,40,.85)'; c.strokeStyle = '#9fe0ff'; c.lineWidth = 1; rr(c, x, y, w, h, 3); c.fill(); c.stroke();
      c.fillStyle = '#9fe0ff'; c.font = '700 6px system-ui, sans-serif'; c.fillText(tag, x + 5, y + 2);
      c.fillStyle = '#fff'; c.font = '600 7px system-ui, sans-serif'; lines.forEach((t, j) => c.fillText(t, x + 5, y + 10 + j * 8.5));
      y += h + 3;
    }
    c.globalAlpha = 1;
  }
  G.TMNTCHAT = { specLines, show, send, draw, playerPos, recent, bubbles, get open() { return open; }, openField, close, COL, stats, MIC_BLINK_MS, MIC_GAP, MIC_W, micBlinkOn, get now() { return nowOverride; }, set now(v) { nowOverride = v; } };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', setup); else setup();
})(window);
