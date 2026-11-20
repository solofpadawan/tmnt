// Loading overlay (common spec for the web remakes, Saulo 2026-11-12): one short message at a time, centred horizontally and
// vertically over the GAME CANVAS (#screen = the picture inside the bezel, as laid out by gfx.js), never over the page.
// White #fff system sans-serif 15px/600 on rgba(0,0,0,.6), padding 8px 16px, radius 8px, no border; the only animation is the
// trailing ellipsis (three dots stepping 0..3, pure CSS opacity, so it keeps moving while the main thread is busy).
// Self-contained (loaded first, before i18next): pt / en / es tables below, language like i18n/init.js (?lang=xx, else the browser
// languages; es is also recognised here). Stages, in order (TMNTLOADING.log records the ones a run went through):
//   video    gfx.js: WebGL CRT shader + procedural bezel (first TMNTGFX.layout())
//   engine   the emulation core scripts (sim/*.js), i18next and the rest of the page code are parsed / run
//   rom      TMNTLOAD.ensure(): fetch of the local roms/tmnt.zip (PC deploy)
//   romcache no local zip: the IndexedDB 'tmnt' ROM cache is read
//   romcheck CRC32 check of the ROM files (zip entries, or the cached ones)
//   machine  ROM regions are built and the 68000 / Z80 / YM2151 board is powered on
//   sound    AudioContext + AudioWorklet module (audio_worklet.js); runs in parallel with the first frames
// The overlay disappears on the FIRST DRAWN GAME FRAME (game.js draw() -> done()). While the "pick your tmnt.zip" dialog is
// open the overlay is hidden (hide()); the next stage() shows it again. Load errors (a script that fails to load, or an
// exception in boot()) replace the text with the error in the same box and the overlay then stays (it never auto-hides).
// Nothing here touches the machine, the inputs, the netcode or the render path; draw() only pays one boolean check once.
(function (G) {
  'use strict';
  const TXT = {
    video:    { pt: 'Preparando o vídeo (CRT)', en: 'Setting up the video (CRT)', es: 'Preparando el vídeo (CRT)' },
    engine:   { pt: 'Iniciando o motor', en: 'Starting the engine', es: 'Iniciando el motor' },
    rom:      { pt: 'Carregando a ROM', en: 'Loading the ROM', es: 'Cargando la ROM' },
    romcache: { pt: 'Lendo a ROM do cache', en: 'Reading the ROM from the cache', es: 'Leyendo la ROM de la caché' },
    romcheck: { pt: 'Verificando a ROM', en: 'Verifying the ROM', es: 'Verificando la ROM' },
    machine:  { pt: 'Ligando a placa arcade', en: 'Powering on the arcade board', es: 'Encendiendo la placa arcade' },
    sound:    { pt: 'Preparando o som', en: 'Preparing the sound', es: 'Preparando el sonido' }
  };
  const ERR = { pt: 'Erro ao carregar', en: 'Load error', es: 'Error al cargar' };
  const ERRF = { pt: 'Falha ao carregar o arquivo', en: 'Failed to load the file', es: 'Error al cargar el archivo' };
  const LANGS = ['pt', 'en', 'es'];
  function base(code) { const c = String(code || '').toLowerCase().replace('_', '-'); return c ? c.split('-')[0] : null; }
  function detect() {
    try {
      const forced = new URLSearchParams(location.search).get('lang');
      if (forced) { const b = base(forced); return LANGS.includes(b) ? b : 'en'; }
      const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || ['en'];
      for (const L of list) { const b = base(L); if (LANGS.includes(b)) return b; }
    } catch (e) {}
    return 'en';
  }
  const lang = detect();
  const log = [];
  let el = null, txt = null, cur = null, finished = false, errored = false, shown = false, ro = null, poll = 0;
  const css = '#tmntload{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:8;pointer-events:none;display:none;box-sizing:border-box;' +
    'color:#fff;font:600 15px system-ui,sans-serif;background:rgba(0,0,0,.6);padding:8px 16px;border-radius:8px;border:0;text-align:center;line-height:1.3;' +
    'max-width:90vw;white-space:nowrap}#tmntload.err{white-space:normal;word-break:break-word}' +
    '#tmntload .e{display:inline-block;width:.9em;text-align:left;white-space:nowrap}#tmntload .e i{font-style:normal;opacity:0;animation:1.2s step-end infinite}' +
    '#tmntload .e i:nth-child(1){animation-name:tmntld1}#tmntload .e i:nth-child(2){animation-name:tmntld2}#tmntload .e i:nth-child(3){animation-name:tmntld3}' +
    '@keyframes tmntld1{0%{opacity:0}25%,100%{opacity:1}}@keyframes tmntld2{0%,49.99%{opacity:0}50%,100%{opacity:1}}@keyframes tmntld3{0%,74.99%{opacity:0}75%,100%{opacity:1}}';
  function make() {
    if (el || !document.body) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'tmntload'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    txt = document.createElement('span'); el.appendChild(txt);
    document.body.appendChild(el);
    const rs = () => api.place(); // after the page's own resize / fullscreen handling (gfx.layout also calls place() itself)
    for (const ev of ['resize', 'orientationchange', 'fullscreenchange', 'webkitfullscreenchange']) addEventListener(ev, () => { rs(); requestAnimationFrame(rs); });
    document.addEventListener('fullscreenchange', () => { rs(); requestAnimationFrame(rs); });
    if (G.visualViewport) G.visualViewport.addEventListener('resize', rs);
    const sc = document.getElementById('screen');
    if (sc && G.ResizeObserver) { ro = new ResizeObserver(rs); ro.observe(sc); }
    poll = setInterval(rs, 500); // safety net while visible (cheap: one rect read)
  }
  function set(label, isErr) {
    make(); if (!el) return;
    el.className = isErr ? 'err' : '';
    txt.textContent = label;
    for (const n of Array.from(el.querySelectorAll('.e'))) n.remove();
    if (!isErr) { const e = document.createElement('span'); e.className = 'e'; e.innerHTML = '<i>.</i><i>.</i><i>.</i>'; el.appendChild(e); }
    el.style.display = 'block'; shown = true; api.place();
  }
  const api = {
    lang, log, TXT,
    text(key, l) { const o = TXT[key]; return o ? o[l || lang] : ''; },
    stage(key) {
      if (finished || errored || !TXT[key]) return;
      cur = key; log.push(key); set(TXT[key][lang], false);
    },
    // hide while another dialog owns the screen (the "pick your tmnt.zip" box); stage() / place() bring it back
    hide() { if (el && !errored) { el.style.display = 'none'; shown = false; } },
    error(msg, file) {
      if (finished || errored) return; // the first error is the cause (a missing script is followed by a boot() exception)
      errored = true;
      const m = String(msg == null ? '' : msg).replace(/\s+/g, ' ').slice(0, 300);
      set(file ? ERRF[lang] + ' ' + file + (m ? ': ' + m : '') : ERR[lang] + (m ? ': ' + m : ''), true);
      for (const n of Array.from(el.querySelectorAll('.e'))) n.remove();
      el.classList.add('err');
    },
    // first drawn game frame (or a paused test start): remove everything
    done() {
      if (finished || errored) return;
      finished = true; shown = false;
      if (poll) clearInterval(poll); if (ro) ro.disconnect();
      if (el) { el.remove(); el = null; }
    },
    // centre on the game canvas (#screen: its rect is the game picture inside the bezel / CRT / letterbox); viewport centre until it is laid out
    place() {
      if (!el || !shown) return;
      const sc = document.getElementById('screen'), r = sc ? sc.getBoundingClientRect() : null;
      if (r && r.width > 8 && r.height > 8 && (sc.style.width || sc.style.left)) {
        el.style.left = (r.left + r.width / 2) + 'px'; el.style.top = (r.top + r.height / 2) + 'px'; el.style.maxWidth = Math.max(120, r.width * 0.9) + 'px';
      } else { el.style.left = '50%'; el.style.top = '50%'; el.style.maxWidth = '90vw'; }
    },
    // let the browser paint the current stage before a long synchronous step (skipped in a hidden tab, where timers are throttled)
    paint() {
      if (finished || document.hidden) return Promise.resolve();
      return new Promise(res => { let d = false; const f = () => { if (!d) { d = true; res(); } }; requestAnimationFrame(() => setTimeout(f, 0)); setTimeout(f, 60); });
    },
    get current() { return cur; }, get visible() { return !!(el && shown && el.style.display !== 'none'); }, get errored() { return errored; }, get finished() { return finished; },
    get el() { return el; }
  };
  // a core script that fails to load: show it in the same box (resource errors do not bubble: capture phase)
  addEventListener('error', e => {
    const t = e && e.target;
    if (t && t.tagName === 'SCRIPT' && t.src) api.error('', String(t.getAttribute('src') || t.src).split('?')[0]);
  }, true);
  G.TMNTLOADING = api;
  make();
})(window);
