// Netplay overlay (text via i18next, web/i18n/). F7 (or the multiplayer button) opens it. "Create room" makes this browser the host
// (player 1) with the room name the player typed and shows the invite link (?sala=NAME) with copy and WhatsApp buttons;
// opening the link joins as P2/P3/P4. Room names: 3-16 chars A-Z 0-9 '-' (ROOM_RE, same rule as the Worker); the fields
// normalize while typing (normRoom). Empty/short name = "Create room" disabled (no random name from the UI);
// TMNTNETPLAY.host() called without a name (tests/console only) still picks a random 4-char code. In the game every player inserts a coin (5) and presses fire, like the arcade.
// Query: ?sala=NAME join, ?net=peerjs use the PeerJS cloud instead of signal.php, ?signal=URL other signal.php,
// ?turn=turn:host:port,user,pass add a TURN server, ?delay=N pin input delay (otherwise the room follows RTT), ?netsim=lat,jit,loss (tests),
// ?lang=xx force UI language (see web/i18n/).
(function () {
  'use strict';
  const q = new URLSearchParams(location.search), G = window.TMNTG;
  const t = (k, o) => (G.t || window.t || ((x) => x))(k, o);
  const KIND = q.get('net') === 'peerjs' ? 'peerjs' : 'php', SIGNAL = q.get('signal') || TMNTNET.DEFAULT_SIGNAL;
  const ICE = TMNTNET.ICE.slice(), EXTRA = [];
  if (q.get('turn')) { const [urls, username, credential] = q.get('turn').split(','); EXTRA.push({ urls, username, credential }); }
  // ?noturn=1: only ?turn= servers (tests); ?direct=N: seconds before the relay-only retry (default 15)
  const iceAll = async () => ICE.concat(EXTRA, q.get('noturn') ? [] : await TMNTNET.getTurn(SIGNAL));
  const DIRECT_S = +(q.get('direct') || 15), RELAY_S = +(q.get('relayt') || 20);
  const SIM = TMNTLINK.parseSim(q.get('netsim'));
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ALPHA[b % ALPHA.length]).join('');
  // room names: uppercase, accents removed, whitespace runs -> '-', anything else dropped, max 16 (Worker: /^[A-Z0-9-]{3,16}$/)
  const ROOM_RE = /^[A-Z0-9-]{3,16}$/, ROOM_MAX = 16;
  const normRoom = x => String(x == null ? '' : x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').slice(0, ROOM_MAX);
  // normalize an <input> in place keeping the caret where the user is typing
  function normField(el) { const v = el.value, c = el.selectionStart == null ? v.length : el.selectionStart, nv = normRoom(v);
    if (nv !== v) { const nc = Math.min(normRoom(v.slice(0, c)).length, nv.length); el.value = nv; try { el.setSelectionRange(nc, nc); } catch (e) {} } return nv; }
  // create-room field state: '' (empty) | 'short' | 'ok'
  const nameState = n => !n ? 'empty' : ROOM_RE.test(n) ? 'ok' : 'short';
  function nameMsg(n) { const k = nameState(n); return k === 'short' ? `<span style="color:#ffb0a0">${t('net.room.short')}</span>` : k === 'empty' ? t('net.room.empty') : t('net.room.hint'); }
  const css = `#np{position:fixed;right:12px;top:12px;width:min(320px,92vw);box-sizing:border-box;background:rgba(4,18,8,.93);color:#d8f3d0;font:14px system-ui,sans-serif;
    border:2px solid #3fae3a;border-radius:10px;padding:12px;z-index:10;display:none;max-height:calc(100vh - 48px);overflow:auto}#np h3{margin:0 0 8px;font-size:16px;color:#9cff6a}
    #np button{background:#3fae3a;color:#021a04;border:0;border-radius:6px;padding:6px 10px;margin:3px 3px 3px 0;font-weight:600;cursor:pointer}
    #np input{width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:1px solid #3fae3a;background:#000;color:#fff;margin:4px 0}
    #np .slot{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #164a10}#np small{color:#8fb98a}
    #np table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}#np td,#np th{padding:2px 3px;text-align:left;border-bottom:1px solid #164a10}
    #np th{color:#9cff6a;font-weight:600}#np td button{padding:3px 6px;margin:0;font-size:12px;line-height:14px;display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;white-space:nowrap}#np td button:disabled,#np button:disabled{background:#40604a;cursor:default}
    #np button svg{flex:none}#np td .bstack{display:flex;flex-direction:column;align-items:stretch;gap:3px;width:max-content;margin:0 auto}#np td:first-child b{overflow-wrap:anywhere}
    #np label{display:block;margin:2px 0}#np label input{width:auto;margin:0 4px 0 0}
    #np .spk{display:inline-block;width:16px;height:16px;vertical-align:-3px;margin-right:4px;opacity:.22;color:#8fb98a}#np .spk.on,#npvh .spk.on{opacity:1;color:#7dff7d}
    #np .vmute{padding:1px 4px;margin:0 0 0 4px;background:transparent;color:#9cff6a;border:1px solid #164a10;line-height:0}#np .vmute.m{color:#ff8a7a;border-color:#ff8a7a}#np .vmute svg{width:14px;height:14px}
    #np .vc{margin-top:8px;padding-top:6px;border-top:1px solid #164a10}#np .vc h4{margin:0 0 4px;font-size:13px;color:#9cff6a}
    #np .mic{display:inline-flex;align-items:center;gap:6px}#np .mic svg{width:16px;height:16px}#np .mic.on{background:#4fb35a;color:#06210a}#np .mic.tx{background:#7dff7d}
    #np .vc input[type=range]{width:100%;padding:0;margin:2px 0}
    #nphint{position:fixed;z-index:12;display:none;pointer-events:none;text-align:center;white-space:nowrap;font-family:Georgia,'Times New Roman',serif;font-weight:700}
    #nphint.bz{transform:translate(-50%,-50%);color:#ffe9a8;letter-spacing:.04em;
      text-shadow:2px 0 #000,-2px 0 #000,0 2px #000,0 -2px #000,2px 2px #000,-2px 2px #000,2px -2px #000,-2px -2px #000,0 0 5px #000}
    #nphint.fb{left:50%;top:10px;transform:translateX(-50%);max-width:90vw;white-space:normal;background:rgba(4,18,8,.88);color:#ffe9a8;border:2px solid #3fae3a;border-radius:10px;padding:7px 14px;font:700 16px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5)}
    #npvh{position:fixed;left:12px;top:12px;z-index:8;display:none;flex-direction:column;gap:4px;pointer-events:none;font:600 14px system-ui,sans-serif}
    #npvh div{background:rgba(4,18,8,.78);color:#d8f3d0;border-radius:14px;padding:3px 10px 3px 6px;border:1px solid #7dff7d}#npvh .spk{display:inline-block;width:16px;height:16px;vertical-align:-3px;margin-right:4px}
    #npb{background:#3fae3a;color:#fff;border:0;border-radius:6px;padding:5px 9px;font:600 12px system-ui,sans-serif;cursor:pointer;opacity:1;text-shadow:0 1px 2px rgba(0,0,0,.55)}
    #npb:hover,#npb:active,#npb:focus{opacity:1;background:#3fae3a;color:#fff}
    #bar{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:9;display:flex;gap:6px;align-items:center;pointer-events:none}#bar button{pointer-events:auto}
    #npb.corner{position:fixed;right:var(--uir,12px);bottom:var(--uib,12px);z-index:9;background:rgba(63,174,58,.85);color:#021a04;opacity:.6;text-shadow:none}`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
  const box = Object.assign(document.createElement('div'), { id: 'np' }); document.body.appendChild(box);
  const desktop = location.protocol === 'app:';
  const btn = Object.assign(document.createElement('button'), { id: 'npb', type: 'button', textContent: t('net.btn') });
  if (desktop) {
    btn.className = 'corner';
    document.body.appendChild(btn);
  } else {
    const bar = Object.assign(document.createElement('div'), { id: 'bar' });
    bar.appendChild(btn);
    document.body.appendChild(bar);
    const lay = () => { if (window.TMNTGFX && TMNTGFX.layout) TMNTGFX.layout(); };
    lay();
    requestAnimationFrame(lay);
  }
  const vh = Object.assign(document.createElement('div'), { id: 'npvh' }); document.body.appendChild(vh);
  const SPK = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const SPKX = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const MIC = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const show = v => { box.style.display = v ? 'block' : 'none'; if (v) refreshList(); };
  btn.onclick = () => show(box.style.display !== 'block');
  addEventListener('keydown', e => { if (e.code === 'F7') { e.preventDefault(); show(box.style.display !== 'block'); } });
  const nickKey = 'tmnt_nick', getNick = () => { try { return localStorage.getItem(nickKey) || ''; } catch (e) { return ''; } };
  const st = { s: null, t: null, room: null, role: null, msg: '', wait: null, log: [], rooms: null, pub: true, autoWatch: false, name: '', code: '', busy: false };
  const pubKey = 'tmnt_public', getPub = () => { try { return localStorage.getItem(pubKey) !== '0'; } catch (e) { return true; } };
  const escH = x => String(x).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  // what the game is showing, from work RAM: 0x100001 = 1 attract / 2 game.
  function stageName(m) { const w = m && m.wram; if (!w) return ''; return w[1] === 2 ? t('net.stage.playing') : t('net.stage.title'); }
  // meta for signal.php: public rooms are listed; private ones send pv:1 (never listed, only counted in the owner's usage stats)
  function meta() { const s = st.s; if (!s || st.role !== 'host') return null;
    return { n: getNick() || t('net.meta.player1'), p: 1 + s.links.filter(l => l.slot > 0).length, s: s.spectators().length, st: stageName(G.machine),
      pv: st.pub ? 0 : 1, pl: s.names().filter(x => x), sp: s.spectators() }; }
  // public room list (only while the panel is open and we are not in a room)
  function listHtml() {
    if (st.rooms === null) return '<small>' + t('net.rooms.loading') + '</small>';
    const rows = st.rooms.filter(r => r.room !== st.room);
    if (!rows.length) return '<small>' + t('net.rooms.empty') + '</small>';
    let h = '<table><tr><th>' + t('net.th.room') + '</th><th>' + t('net.th.host') + '</th><th>' + t('net.th.players') + '</th><th>' + t('net.th.spec') + '</th><th>' + t('net.th.stage') + '</th><th></th></tr>';
    const EYE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';
    const wn = escH((() => { const v = t('net.watchNone'); return v && v !== 'net.watchNone' ? v : (/^pt/i.test((window.i18next && i18next.language) || 'pt') ? 'Sem vagas para assistir' : 'No spectator spots left'); })()); // text kept in ui.js (no i18n file change)
    for (const r of rows) {
      const full = r.p >= 4, specFull = r.s >= TMNTSESSION.MAXSPEC, rr = escH(r.room);
      // [Join] + [eye Watch] stacked (same as the other remakes); a full room only offers Watch; spectator cap (Esp. 4/4) = disabled Watch
      const bj = full ? '' : `<button data-r="${rr}">${t('net.join')}</button>`;
      const bw = specFull ? `<button disabled class="eye" title="${wn}" aria-label="${wn}">${EYE}${t('net.watch')}</button>` : `<button data-r="${rr}" data-d="1" class="eye">${EYE}${t('net.watch')}</button>`;
      h += `<tr><td><b>${escH(r.room)}</b></td><td>${escH(r.host || '?')}</td><td>${r.p | 0}/4</td><td>${r.s | 0}/${TMNTSESSION.MAXSPEC}</td><td>${escH(r.st || '')}</td><td><div class="bstack">${bj}${bw}</div></td></tr>`;
    }
    return h + '</table>';
  }
  function bindList(el) { for (const b of el.querySelectorAll('button[data-r]')) b.onclick = () => join(b.dataset.r, false, false, !!b.dataset.d).catch(err); }
  async function refreshList() {
    if (KIND !== 'php' || st.s || box.style.display !== 'block') return;
    const r = await TMNTNET.listRooms(SIGNAL); if (r) st.rooms = r; else if (st.rooms === null) st.rooms = [];
    const el = box.querySelector('#np-list'); if (el && !st.s) { el.innerHTML = listHtml(); bindList(el); }
  }
  setInterval(refreshList, 5000);
  const ctl = { active: () => !!(st.s && (st.s.rb || st.role === 'guest')), tick: fi => { const s = st.s; if (s.spec && s.vaga && !st.watchOnly && (fi & TMNTIN.COIN)) s.promote(); return s.tick(s.spec ? 0 : fi); }, get session() { return st.s; }, get state() { return st; }, get voice() { return st.s && st.s.voice; } };
  const voice = () => st.s && st.s.voice;
  const hb = Object.assign(document.createElement('div'), { id: 'nphint' }); document.body.appendChild(hb);
  let hintTimer = 0, hintShown = false;
  function placeHint() {
    const GF = window.TMNTGFX, R = GF && GF.mode === 'bezel' && GF.rects ? GF.rects() : null;
    if (R && R.a && R.g) { const k = R.a.w / GF.BZ.w, fs = Math.round(21 * k * 10) / 10;
      if (fs >= 11) { hb.className = 'bz'; hb.style.left = (R.g.x + R.g.w / 2) + 'px'; hb.style.top = (R.a.y + 1049 * k) + 'px'; hb.style.fontSize = fs + 'px'; hb.style.maxWidth = (R.g.w * 0.92) + 'px'; return; } }
    hb.className = 'fb'; hb.style.left = hb.style.top = hb.style.fontSize = hb.style.maxWidth = '';
  }
  addEventListener('resize', () => { if (hb.style.display === 'block') placeHint(); });
  function hideHint() { clearTimeout(hintTimer); hintTimer = 0; hb.style.display = 'none'; }
  function showHint(watching) { if (hintShown) return; hintShown = true; hb.textContent = t(watching ? 'voice.hintBarWatch' : 'voice.hintBar'); hb.style.display = 'block'; placeHint(); hintTimer = setTimeout(hideHint, 8000); }
  addEventListener('keydown', e => { if (e.code === 'Tab' && hb.style.display === 'block') hideHint(); }, true);
  function link() {
    const u = new URL(location.href); u.search = ''; u.searchParams.set('sala', st.room);
    if (KIND === 'peerjs') u.searchParams.set('net', 'peerjs');
    if (q.get('signal')) u.searchParams.set('signal', SIGNAL);
    return u.toString();
  }
  // HTML of the right-hand cell of a player slot (shared by full render and the 1 s in-place refresh)
  function slotWhoHtml(s, p) {
    let who = '<small>' + t('net.slot.free') + '</small>';
    const nm = s.names()[p], esc1 = x => String(x).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
    const peers = s.peers(), me = s.slot;
    if (p === me) who = t('net.slot.you') + (nm ? ` <small>(${esc1(nm)})</small>` : '');
    else if (st.role === 'host') { const L = peers.find(x => x.slot === p); if (L) who = `${esc1(nm || t('net.slot.connected'))} <small data-rtt="${p}">${L.rtt} ms</small>`; }
    else if (s.rb && s.rb.join[p] !== TMNTROLL.INF && s.rb.leave[p] === TMNTROLL.INF) who = p === 0 ? `${esc1(nm || t('net.slot.host'))} <small data-rtt="0">${peers[0] ? peers[0].rtt : '?'} ms</small>` : esc1(nm || t('net.slot.connected'));
    let vm = '';
    const vv = voice(), occupied = p === me || who.indexOf('<small>' + t('net.slot.free')) !== 0;
    if (vv && occupied && p !== me) { const mu = vv.mute[p], nn = esc1(nm || t('net.playerN', { n: p + 1 })); vm = `<button class="vmute${mu ? ' m' : ''}" data-vm="${p}" title="${mu ? t('voice.unmute', { name: nn }) : t('voice.mute', { name: nn })}" aria-label="${mu ? t('voice.unmute', { name: nn }) : t('voice.mute', { name: nn })}" aria-pressed="${mu}">${mu ? SPKX : SPK}</button>`; }
    return who + vm;
  }
  function slotIconHtml(s, p) {
    const vv = voice(); if (!vv) return '';
    const whoFree = '<small>' + t('net.slot.free') + '</small>';
    const occupied = p === s.slot || slotWhoTextOccupied(s, p);
    if (!occupied) return '';
    return `<span class="spk${vv.speaking[p] ? ' on' : ''}" data-vs="${p}">${SPK}</span>`;
  }
  function slotWhoTextOccupied(s, p) {
    if (p === s.slot) return true;
    const peers = s.peers();
    if (st.role === 'host') return !!peers.find(x => x.slot === p);
    return !!(s.rb && s.rb.join[p] !== TMNTROLL.INF && s.rb.leave[p] === TMNTROLL.INF);
  }
  function voiceHtml() {
    const s = st.s, v = voice(); if (!v) return '';
    let h = `<div class="vc"><h4>${t('voice.title')}</h4>`;
    if (s.spec) h += `<small>${t('voice.specOnly')}</small>`;
    else if (s.slot >= 0) {
      h += `<button id="np-mic" class="mic${v.micOn ? ' on' : ''}${v.selfOn ? ' tx' : ''}">${MIC}<span>${v.micOn ? (v.selfOn ? t('voice.micSending') : t('voice.micOn')) : t('voice.micOff')}</span></button>`;
      h += `<br><small>${v.micOn ? t('voice.hintOn') : t('voice.hintOff')}</small>`;
    }
    h += `<label for="np-vvol"><small>${t('voice.volume')}: <span id="np-vvol-n">${Math.round(v.vol * 100)}%</span></small></label><input type="range" id="np-vvol" min="0" max="100" step="5" value="${Math.round(v.vol * 100)}">`;
    if (v.err) h += `<div style="color:#ffb0a0">${t('voice.err.' + v.err)}</div>`;
    return h + '</div>';
  }
  function patchMuteButtons(v) {
    if (!v) return;
    const nm = st.s ? st.s.names() : [];
    for (const b of box.querySelectorAll('button[data-vm]')) {
      const sl = +b.dataset.vm, mu = !!v.mute[sl], nn = escH(nm[sl] || t('net.playerN', { n: sl + 1 }));
      b.classList.toggle('m', mu);
      b.setAttribute('aria-pressed', mu);
      b.title = b.getAttribute('aria-label') + ''; // keep
      const label = mu ? t('voice.unmute', { name: nn }) : t('voice.mute', { name: nn });
      b.title = label; b.setAttribute('aria-label', label);
      if ((b.classList.contains('m') === mu) && b.querySelector('svg')) {
        const want = mu ? SPKX : SPK;
        if (b.innerHTML !== want) b.innerHTML = want;
      } else b.innerHTML = mu ? SPKX : SPK;
    }
  }
  function voiceChanged(kind) {
    const v = voice(); if (!v) return;
    if (kind === 'speak' || kind === 'mute') {
      for (const el of box.querySelectorAll('[data-vs]')) el.classList.toggle('on', !!v.speaking[+el.dataset.vs]);
      const nm = st.s.names(), items = [];
      for (let p = 0; p < 4; p++) if (v.speaking[p]) { const n = p === st.s.slot ? t('net.slot.you') : (nm[p] || t('net.playerN', { n: p + 1 })); items.push(`<div data-hv="${p}"><span class="spk on">${SPK}</span>${escH(n)}</div>`); }
      const mb = box.querySelector('#np-mic'); if (mb && v.micOn) { mb.classList.toggle('tx', v.selfOn); const sp = mb.querySelector('span'); if (sp) sp.textContent = v.selfOn ? t('voice.micSending') : t('voice.micOn'); }
      vh.innerHTML = items.join(''); vh.style.display = items.length ? 'flex' : 'none';
      if (kind === 'mute') patchMuteButtons(v);
    }
    // Full render only when the mic turns on/off or an error appears (structure change). Mute just patches buttons.
    if (kind === 'mic') { if (box.style.display === 'block') { const a = document.activeElement; if (!(a && a.id === 'np-vvol')) render(); } }
  }
  function specsHtml(s) {
    const sp = s.spectators(), esc = x => String(x).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
    return { left: t('net.specs', { n: sp.length, max: TMNTSESSION.MAXSPEC }), right: `<small>${sp.length ? sp.map(esc).join(', ') : t('net.specs.none')}</small>` };
  }
  // Structure of the in-room panel (not live RTT). When this changes the 1 s timer does a full rebuild.
  function panelSig(s) {
    if (!s) return '';
    const peers = s.peers(), seats = [];
    for (let p = 0; p < 4; p++) {
      const occ = (p === s.slot) || (st.role === 'host' ? peers.some(x => x.slot === p) : !!(s.rb && s.rb.join[p] !== TMNTROLL.INF && s.rb.leave[p] === TMNTROLL.INF));
      seats.push(occ ? 1 : 0);
    }
    const pend = st.t && st.t.pending ? st.t.pending() : 0;
    return [st.role, st.full || '', st.pub ? 1 : 0, s.spec ? 1 : 0, s.vaga ? 1 : 0, s.spectators().join('\0'), seats.join(''), pend ? 1 : 0, st.msg || '', st.room || '', st.wait || ''].join('|');
  }
  function patchPanel() {
    const s = st.s;
    if (!s || st.full || box.style.display !== 'block') return render();
    const sig = panelSig(s);
    const slots = box.querySelectorAll('.slot');
    if (sig !== st.panelSig || slots.length !== 5 || !slots[0].children[1]) { st.panelSig = sig; return render(); }
    // In-place only: never rewrite slot innerHTML (that detaches mute buttons mid-click).
    for (const el of box.querySelectorAll('[data-rtt]')) {
      const p = +el.dataset.rtt; let ms = '?';
      const peers = s.peers();
      if (st.role === 'host') { const L = peers.find(x => x.slot === p); if (L) ms = L.rtt; }
      else if (p === 0) ms = peers[0] ? peers[0].rtt : '?';
      el.textContent = ms + ' ms';
    }
    const sp = specsHtml(s);
    slots[4].children[0].innerHTML = sp.left;
    slots[4].children[1].innerHTML = sp.right;
    const v = voice();
    if (v) {
      for (const el of box.querySelectorAll('[data-vs]')) el.classList.toggle('on', !!v.speaking[+el.dataset.vs]);
      const mb = box.querySelector('#np-mic');
      if (mb && v.micOn) { mb.classList.toggle('tx', v.selfOn); const spn = mb.querySelector('span'); if (spn) spn.textContent = v.selfOn ? t('voice.micSending') : t('voice.micOn'); }
      patchMuteButtons(v);
    }
  }
  function render() {
    const s = st.s, nk = getNick().replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); let h = '<h3>' + t('net.title') + '</h3>';
    h += `<small>${t('net.nick.label')}</small><input id="np-nick" maxlength="${TMNTSESSION.NICK_MAX}" placeholder="${t('net.nick.placeholder')}" value="${nk}">`;
    if (!s) {
      const can = nameState(st.name) === 'ok' && !st.busy;
      h += `<small>${t('net.room.label')}</small><input id="np-room" maxlength="${ROOM_MAX}" autocomplete="off" spellcheck="false" placeholder="${t('net.room.placeholder')}" value="${escH(st.name)}">
        <small id="np-room-msg">${nameMsg(st.name)}</small><br>
        <button id="np-create"${can ? '' : ' disabled'}>${t('net.create')}</button><label><input type="checkbox" id="np-pub"${getPub() ? ' checked' : ''}>${t('net.publicLabel')}</label><small>${t('net.code.or')}</small><input id="np-code" maxlength="${ROOM_MAX}" autocomplete="off" spellcheck="false" placeholder="${t('net.code.placeholder')}" value="${escH(st.code)}">
        <button id="np-join">${t('net.join')}</button>`;
      if (KIND === 'php') h += `<div style="margin-top:8px"><small>${t('net.rooms.open')}</small><div id="np-list">${listHtml()}</div></div>`;
    } else if (st.full) {
      h += `<div>${t('net.roomFull', { room: st.room })}</div>`;
      h += st.full === 'watch' ? `<small>${t('net.roomFullWatch')}</small><br>
        <button id="np-watch">${t('net.watch')}</button><button id="np-leave">${t('net.leave')}</button>` : `<small>${t('net.roomFullNoWatch', { max: TMNTSESSION.MAXSPEC })}</small><br><button id="np-leave">${t('net.leave')}</button>`;
    } else {
      if (st.role === 'host') {
        const L = link();
        h += `<div><small>${st.pub ? t('net.pubStatus') : t('net.privStatus')}</small></div>`;
        h += `<div>${t('net.invite', { room: st.room })}</div><input id="np-link" readonly value="${L}">
          <button id="np-copy">${t('net.copy')}</button><a href="https://wa.me/?text=${encodeURIComponent(t('net.waText', { link: L }))}" target="_blank" rel="noopener"><button>${t('net.whatsapp')}</button></a>`;
        const pend = st.t && st.t.pending ? st.t.pending() : 0;
        if (pend) h += `<div style="color:#9fe0ff">${t('net.pendingJoin')}</div>`;
      } else h += `<div>${t('net.roomOnly', { room: st.room })}</div>`;
      h += '<div style="margin-top:8px">';
      for (let p = 0; p < 4; p++) {
        h += `<div class="slot"><span>${slotIconHtml(s, p)}${t('net.playerN', { n: p + 1 })}</span><span>${slotWhoHtml(s, p)}</span></div>`;
      }
      const sp = specsHtml(s);
      h += `<div class="slot"><span>${sp.left}</span><span>${sp.right}</span></div>`;
      if (s.spec) h += `<div style="margin-top:6px;color:#9fe0ff">${t('net.watching')}</div>` + (s.vaga ? `<div style="color:#8f8">${t(st.watchOnly ? 'net.slotFreeWatch' : 'net.slotFree')}</div><button id="np-promote">${t('net.promote')}</button>` : '');
      h += `</div>${voiceHtml()}<small>${t('net.help')}</small><br><button id="np-leave">${t('net.leaveRoom')}</button>`;
    }
    if (st.msg) h += `<div style="margin-top:6px;color:#ffb0a0">${st.msg}</div>`;
    box.innerHTML = h;
    st.panelSig = s && !st.full ? panelSig(s) : '';
    const $ = id => box.querySelector('#' + id);
    const doCreate = () => { if (nameState(st.name) !== 'ok' || st.busy) { if ($('np-room')) $('np-room').focus(); return; }
      host($('np-pub') ? $('np-pub').checked : undefined, st.name).catch(err); };
    const doJoin = () => join(normRoom($('np-code').value)).catch(err);
    if ($('np-room')) { const el = $('np-room');
      el.oninput = () => { st.name = normField(el); const c = $('np-create'); if (c) c.disabled = !(nameState(st.name) === 'ok' && !st.busy); const m = $('np-room-msg'); if (m) m.innerHTML = nameMsg(st.name); };
      el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } }; }
    if ($('np-code')) { const el = $('np-code'); el.oninput = () => { st.code = normField(el); }; el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } }; }
    if ($('np-create')) $('np-create').onclick = doCreate;
    if ($('np-join')) $('np-join').onclick = doJoin;
    if ($('np-copy')) $('np-copy').onclick = () => { navigator.clipboard.writeText(link()).then(() => { st.msg = t('net.copied'); render(); }, () => { $('np-link').select(); }); };
    if ($('np-leave')) $('np-leave').onclick = leave;
    if ($('np-pub')) $('np-pub').onchange = e => { try { localStorage.setItem(pubKey, e.target.checked ? '1' : '0'); } catch (x) {} };
    if ($('np-list')) bindList($('np-list'));
    if ($('np-nick')) {
      const nick = $('np-nick');
      nick.onchange = e => { const n = TMNTSESSION.cleanNick(e.target.value); try { localStorage.setItem(nickKey, n); } catch (x) {} e.target.value = n; if (st.s) st.s.setName(n); };
      nick.addEventListener('blur', () => setTimeout(() => { if (!window.TMNTIN || TMNTIN.typingTarget(document.activeElement)) return; TMNTIN.focusScreen(); }, 0));
    }
    if ($('np-watch')) $('np-watch').onclick = () => { st.full = null; st.msg = t('net.watchingRecv'); st.wait = 'receiving'; st.s.watch(); render(); };
    if ($('np-retry')) $('np-retry').onclick = () => { const r = st.retry; const w = st.retryWatch; endSession(); join(r, false, false, w).catch(err); };
    if ($('np-promote')) $('np-promote').onclick = () => { st.s.promote(); render(); };
    if ($('np-mic')) $('np-mic').onclick = () => { const v = voice(); if (v) v.toggleMic().catch(e => console.warn(e)); };
    if ($('np-vvol')) $('np-vvol').oninput = e => { const v = voice(); if (v) { v.setVolume(e.target.value / 100); $('np-vvol-n').textContent = e.target.value + '%'; } };
    for (const b of box.querySelectorAll('button[data-vm]')) b.onclick = () => { const v = voice(), sl = +b.dataset.vm; if (v) v.setMute(sl, !v.mute[sl]); };
  }
  function err(e) { st.msg = t('net.err.prefix') + (e && e.message || e); console.warn(e); render(); }
  // signal server errors that the player can act on (Worker / signal.php error strings)
  function roomErr(e, room) { const m = e && e.message;
    if (m === 'room taken') return t('net.err.roomTaken', { room: escH(room) });
    if (m === 'bad room') return t('net.err.serverName', { room: escH(room) });
    if (m === 'no such room') return t('net.err.noRoom', { room: escH(room) });
    return null; }
  function focusGame() { if (window.TMNTIN && TMNTIN.focusScreen) TMNTIN.focusScreen(); }
  function makeSession(role, extra) {
    const m = G.machine;
    const delayOpt = TMNTSESSION.delayOption(q.get('delay'));
    const s = new TMNTSESSION.Session(Object.assign({ m, step: G.netStep, role, name: getNick(), delay: delayOpt.delay, explicitDelay: delayOpt.explicitDelay, onAudio: G.netAudio, ext: G.netExt,
      onEvent: e => { if (e.t === 'chat') { if (window.TMNTCHAT) TMNTCHAT.show(e.slot, e.text, e.name); return; }
        if (e.t === 'vaga' && e.v) show(true); st.log.push(e); if (e.t === 'state') { G.netAudioResync(e.snap); st.msg = ''; st.wait = null; } if (e.t === 'hostgone') { st.msg = t('net.hostGone'); st.wait = null; endSession(); }
        if (e.t === 'full' && st.autoWatch && e.watch) { st.autoWatch = false; st.msg = t('net.watchingRecv'); st.wait = 'receiving'; st.s.watch(); render(); return; }
        if (e.t === 'full') { st.msg = ''; st.wait = null; st.full = e.watch ? 'watch' : 'nowatch'; show(true); } render(); } }, extra));
    if (window.TMNTVOICE && TMNTVOICE.supported && q.get('net') !== 'peerjs') new TMNTVOICE.Voice(s, { onchange: voiceChanged });
    // online highscore (web only; players of a Cloudflare Worker match, never spectators / PeerJS / app:): net/highscore.js
    if (window.TMNTHS && location.protocol !== 'app:' && KIND === 'php' && !(extra && extra.watch)) TMNTHS.attach(s, () => ({ t: st.t, room: st.room, signal: SIGNAL, nick: getNick() }));
    return s;
  }
  // host(pub, name): name = the typed room name (normalized + validated); omitted only by tests/console -> random code
  async function host(pub, name) {
    const room = name === undefined ? code() : normRoom(name);
    if (!ROOM_RE.test(room)) throw new Error(t('net.err.badName'));
    if (st.busy || st.s) return;
    st.pub = pub === undefined ? getPub() : !!pub;
    st.busy = true;
    try {
      await G.whenReady; st.room = room; st.role = 'host'; st.msg = t('net.opening'); st.wait = null; render();
      st.t = await TMNTNET.open(KIND, { room: st.room, role: 'host', signal: SIGNAL, ice: await iceAll(), sim: SIM, meta, simnat: +(q.get('simnat') || 0) });
    } catch (e) {
      // e.g. 409 'room taken': back to the create form with the name kept, so the player can pick another one
      st.room = null; st.role = null; st.t = null; st.busy = false;
      const m = roomErr(e, room); if (!m) throw e;
      console.warn('[tmnt-net] host', room, e.message); st.msg = m; render();
      const f = box.querySelector('#np-room'); if (f) { f.focus(); f.select(); }
      return;
    }
    st.busy = false;
    st.s = makeSession('host', { frame: G.frameNo + 1 }); G.net = ctl;
    st.t.onlink = l => { st.s.addLink(l); render(); };
    st.msg = ''; render(); focusGame();
  }
  async function join(room, watch, viaLink, direct) {
    room = normRoom(room);
    if (!ROOM_RE.test(room)) throw new Error(t('net.err.badName'));
    st.autoWatch = !!watch && !direct; st.watchOnly = !!direct; st.viaLink = !!viaLink;
    await G.whenReady; st.room = room; st.role = 'guest'; st.msg = t('net.connecting'); st.wait = 'connecting'; render(); show(true);
    st.s = makeSession('guest', direct ? { watch: true } : undefined); G.net = ctl;
    const ice = await iceAll(), gen = st.gen = (st.gen || 0) + 1, hasTurn = ice.some(x => /^turns?:/.test([].concat(x.urls)[0]));
    // attempt 1: direct + STUN + TURN (policy all); attempt 2 (if no link after DIRECT_S): fresh connection, relay only
    for (const [policy, secs] of KIND === 'php' ? [['all', DIRECT_S]].concat(hasTurn ? [['relay', RELAY_S]] : []) : [['all', 0]]) {
      if (policy === 'relay') { try { fetch(SIGNAL + '?a=ice&relay=1&room=' + room, { cache: 'no-store' }).catch(() => {}); } catch (e) {} st.msg = t('net.relay'); st.wait = 'relay'; render(); }
      console.log('[tmnt-net] guest attempt', policy, 'room', room);
      const ok = await new Promise(async res => {
        let tport; try { tport = await TMNTNET.open(KIND, { room, role: 'guest', signal: SIGNAL, ice, sim: SIM, policy, simnat: +(q.get('simnat') || 0) }); } catch (e) { const m = roomErr(e, room); res(m ? Object.assign(new Error(m), { friendly: true }) : e); return; }
        if (st.gen !== gen || !st.s) { tport.close(); res(false); return; }
        st.t = tport; let done = false;
        tport.onlink = l => { done = true; st.s.addLink(l); if (viaLink) showHint(!!direct); st.msg = t('net.receiving'); st.wait = 'receiving'; render(); res(true); };
        if (secs) setTimeout(() => { if (!done) { console.log('[tmnt-net] guest: no connection after', secs, 's (' + policy + ')'); tport.onlink = null; tport.close(); if (st.t === tport) st.t = null; res(false); } }, secs * 1000);
      });
      if (ok === true) { focusGame(); return; }
      if (ok instanceof Error) { endSession(); if (ok.friendly) { st.msg = ok.message; render(); return; } throw ok; }
      if (st.gen !== gen || !st.s) return; // left meanwhile
    }
    st.wait = 'fail';
    st.msg = t('net.fail') + `<br><button id="np-retry">${t('net.retry')}</button>`;
    st.retry = room; st.retryWatch = !!direct; render();
  }
  function endSession() { st.watchOnly = false; hideHint(); if (st.s && st.s.voice) st.s.voice.stop(); vh.style.display = 'none'; vh.innerHTML = ''; st.gen = (st.gen || 0) + 1; st.full = null; st.wait = null; const lv = st.t ? st.t.close() : null; st.t = null; st.s = null; G.net = null; st.role = null; return lv; }
  // "Sair da sala" (web only, never the desktop build app:): whoever is in a session (host, player or spectator) leaves properly (Worker 'leave' with
  // keepalive + every link closed, so the host / the other players / the spectators see the exit exactly as before: the host's 'left' + freed slot, a
  // spectator's 'specleft', and when the HOST leaves each guest gets 'hostgone' and ends its session as it always did) and then ONLY the leaver's page
  // reloads, without ?sala= / ?room= / ?assistir= / ?watch= (they would rejoin) and keeping every other parameter (lang, voice, mute...). The reload
  // does not open F7 (nothing joins). Everything the leave path sends (Worker leave, peer-connection closes) goes out before the reload: endSession()
  // returns the pending leave request, awaited for at most 1500 ms, plus 200 ms for the closed peer connections to reach the other side.
  // The idle auto-close of the host's room (below) does NOT share this path: it calls endSession() itself and the game goes on locally, no reload.
  function reloadUrl() { const u = new URL(location.href); for (const k of ['sala', 'room', 'assistir', 'watch']) u.searchParams.delete(k); return u.toString(); }
  // host leaving mid-match: send the score report first (same last-confirmed numbers the guests will send on hostgone), while session / transport /
  // match_id are still available. Guests who click leave must not report (they are omitted from the others' bodies).
  function flushHostScore() { if (st.s && st.s.role === 'host' && typeof st.s.flushScore === 'function') { try { st.s.flushScore(); } catch (e) { console.warn('tmnt-score', e); } } }
  async function leaveAndReload() {
    if (st.leaving) return; st.leaving = true;
    flushHostScore();
    const url = reloadUrl(), lv = endSession(); st.msg = ''; render();
    try { await Promise.race([Promise.resolve(lv), new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
    await new Promise(r => setTimeout(r, 200)); // let the closed peer connections reach the other side
    location.replace(url);
  }
  function leave() {
    if (st.s && location.protocol !== 'app:') return leaveAndReload();
    flushHostScore();
    endSession(); st.msg = ''; st.rooms = null; render(); refreshList();
  }
  // ---- idle auto-close of the HOST's online room (web only; never the desktop build, spectators, players or local play) ----
  // Closes the room (same path as "Sair da sala": Worker 'leave' with keepalive + transport closed) after IDLE_MS with no local input AND no input change from
  // the other players, or after HIDDEN_MS with the tab hidden in a row. ~WARN_MS before, a warning ("press any key") is shown; any input cancels it.
  // Only wall-clock timestamps + a setInterval + visibilitychange (rAF stops in a hidden tab): nothing here touches the simulation, inputs, rollback, delay or hashes.
  // Hidden tabs may have their timers throttled (up to ~1 tick/min after 5 min hidden), so a hidden-tab close can be up to ~1 min late: that is fine.
  // ?idletest=1 (debug): 20 s idle / 20 s hidden / 5 s warning.
  const IDLE = Object.assign({ IDLE_MS: 10 * 60000, HIDDEN_MS: 10 * 60000, WARN_MS: 60000, TICK_MS: 1000 }, /^(1|true|yes)$/i.test(q.get('idletest') || '') ? { IDLE_MS: 20000, HIDDEN_MS: 20000, WARN_MS: 5000 } : {});
  const idle = { on: false, last: 0, hiddenSince: 0, warn: false, closed: false, reason: '', slots: [null, null, null, null], lastTick: 0 };
  let idleWarnEl = null, idleClosedEl = null;
  const idleNow = () => Date.now();
  function idleEnabled() { return location.protocol !== 'app:' && st.role === 'host' && !!st.s && !!st.s.rb && !st.s.spec; }
  function idleBump() { idle.last = idleNow(); if (idle.warn) idleHideWarn(); if (idle.hiddenSince && !document.hidden) idle.hiddenSince = 0; }
  function idleBox(id, top) {
    const e = document.createElement('div'); e.id = id; e.setAttribute('role', 'status');
    e.style.cssText = `position:fixed;left:50%;top:${top};transform:translate(-50%,-50%);z-index:14;pointer-events:none;text-align:center;background:rgba(4,18,8,.9);color:#ffe9a8;border:2px solid #3fae3a;border-radius:10px;padding:8px 16px;font:700 clamp(16px,1.7vw,32px) system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:90vw;letter-spacing:.02em;display:none`;
    document.body.appendChild(e); return e;
  }
  function idleHideWarn() { idle.warn = false; if (idleWarnEl) idleWarnEl.style.display = 'none'; }
  function idleShowWarn(sec) { if (!idleWarnEl) idleWarnEl = idleBox('idlewarn', '38%'); idle.warn = true; const tx = t('net.idleWarn', { s: sec }); if (idleWarnEl.textContent !== tx) idleWarnEl.textContent = tx; idleWarnEl.style.display = 'block'; }
  function idleShowClosed() { if (!idleClosedEl) idleClosedEl = idleBox('idleclosed', '38%'); idleClosedEl.textContent = t('net.idleClosed'); idleClosedEl.style.display = 'block'; }
  // the other players' input: a seated remote slot appearing / leaving, or its (real, received) input value changing
  function idleRemote() {
    const s = st.s, rb = s && s.rb; let act = false; if (!rb) return false;
    for (let sl = 1; sl < 4; sl++) {
      const on = rb.join[sl] !== TMNTROLL.INF && rb.leave[sl] === TMNTROLL.INF, sd = idle.slots[sl];
      if (!sd) { idle.slots[sl] = { on, val: 0, scan: rb.known[sl] }; continue; }
      if (on !== sd.on) { sd.on = on; sd.val = 0; sd.scan = rb.known[sl]; act = true; continue; }
      if (!on) continue;
      const k = rb.known[sl];
      for (let f = Math.max(sd.scan + 1, k - 150); f <= k; f++) { const v = rb.inp[sl].get(f); if (v !== undefined && v !== sd.val) { sd.val = v; act = true; } }
      if (k > sd.scan) sd.scan = k;
    }
    return act;
  }
  let idlePad = '';
  function idlePads() { // gamepad activity (no event for it): any button pressed / stick moved since the last look
    const pads = navigator.getGamepads ? navigator.getGamepads() : []; let sig = '';
    for (const p of pads || []) if (p && p.connected) sig += p.buttons.map(b => b && b.pressed ? 1 : 0).join('') + p.axes.map(a => Math.abs(a) > 0.5 ? 1 : 0).join('') + '|';
    const act = sig !== idlePad && /1/.test(sig); idlePad = sig; return act;
  }
  function idleClose(reason) {
    idle.closed = true; idle.reason = reason; idleHideWarn();
    flushHostScore(); // the room closes = the host leaves mid-match: same report as "Sair da sala"
    endSession(); st.msg = t('net.idleClosed'); st.rooms = null; render(); refreshList(); idleShowClosed();
  }
  function idleTick() {
    const t0 = idleNow(), gap = idle.lastTick ? t0 - idle.lastTick : 0; idle.lastTick = t0;
    if (!idleEnabled()) { idle.on = false; idle.slots = [null, null, null, null]; if (idle.warn) idleHideWarn(); return; }
    if (!idle.on) { idle.on = true; idle.last = t0; idle.hiddenSince = document.hidden ? t0 : 0; idle.closed = false; idle.slots = [null, null, null, null]; if (idleClosedEl) idleClosedEl.style.display = 'none'; idleRemote(); return; }
    if (!document.hidden && gap > 30000) { idle.last = t0; if (idle.warn) idleHideWarn(); } // the machine slept / the timer was frozen while visible: do not count that as idle
    if (idlePads()) idleBump();
    if (idleRemote()) idleBump();
    let left = IDLE.IDLE_MS - (t0 - idle.last), why = 'idle';
    if (document.hidden && idle.hiddenSince) { const lh = IDLE.HIDDEN_MS - (t0 - idle.hiddenSince); if (lh < left) { left = lh; why = 'hidden'; } }
    if (left <= 0) return idleClose(why);
    if (left <= IDLE.WARN_MS) idleShowWarn(Math.ceil(left / 1000)); else if (idle.warn) idleHideWarn();
  }
  for (const ev of ['keydown', 'pointerdown', 'touchstart', 'wheel']) addEventListener(ev, () => { if (idleClosedEl && idleClosedEl.style.display === 'block' && ev !== 'wheel') idleClosedEl.style.display = 'none'; if (idle.on) idleBump(); }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (idle.on) idle.hiddenSince = idleNow(); } else { idle.hiddenSince = 0; if (idle.on) idleBump(); } });
  setInterval(idleTick, IDLE.TICK_MS);
  addEventListener('beforeunload', () => { if (st.t) st.t.close(); });
  setInterval(() => { if (st.s && box.style.display === 'block' && !box.contains(document.activeElement)) patchPanel(); }, 1000);
  render();
  window.TMNTNETPLAY = Object.assign(ctl, { host, join, leave, link, refreshList, stageName, normRoom, ROOM_RE, roomList: () => st.rooms, signal: SIGNAL, kind: KIND, patchPanel, render, idleCfg: IDLE });
  Object.defineProperty(window.TMNTNETPLAY, 'idle', { get: () => ({ on: idle.on, warn: idle.warn, closed: idle.closed, reason: idle.reason, idleMs: idle.on ? idleNow() - idle.last : 0, hiddenMs: idle.hiddenSince ? idleNow() - idle.hiddenSince : 0 }) });
  Object.defineProperty(window.TMNTNETPLAY, 'hint', { get: () => (hb.style.display === 'block' ? hb.textContent : null) });
  if (q.get('sala')) join(normRoom(q.get('sala')), false, true, /^(1|true|sim|yes)$/i.test(q.get('assistir') || '')).catch(err);
})();
