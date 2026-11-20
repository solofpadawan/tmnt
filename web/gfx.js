// Presentation (ported from the Sunset Riders remake): WebGL CRT shader + an ORIGINAL procedural 16:9 bezel
// (night city skyline over a sewer brick wall, steel pipe frame, toxic-green glow). Reads the finished 320x224 frame
// (game.js ImageData) and positions #screen; never touches the machine or inputs. #screen always sits exactly on
// the game picture (opacity 0 under WebGL). Default bezel; debug: ?gfx=crt|orig, ?webgl=0 (2D fallback).
// No image files, no Konami cabinet art, logos or characters: everything below is drawn from shapes and system fonts.
(function (G) {
  'use strict';
  const W = 320, H = 224, MODES = ['bezel', 'crt', 'orig'];
  const q = new URLSearchParams(location.search);
  let mode = q.get('gfx') || 'bezel';
  if (!MODES.includes(mode)) mode = 'bezel';
  let gl = null, prog = null, tex = null, crt = null, bz = null, bzKey = '', glFail = false, frames = 0;
  // ---------- layout ----------
  // bezel layout in 1920x1080 units: game picture 4:3, 974 high; slim steel band (16): the frame spans y 44..1050,
  // its top just under the top pipe (inner edge 42), its bottom on the bottom pipe (centre 1054) so the bottom corner
  // manholes sit on the pipe (pt10u); centred at x. All in bezel units, so it holds at any window shape (letterboxed).
  const BZ = { w: 1920, h: 1080, gh: 974, gy: 60, L: 16 }; BZ.gw = BZ.gh * 4 / 3; BZ.gx = (BZ.w - BZ.gw) / 2;
  function rects() {
    const iw = innerWidth, ih = innerHeight;
    if (mode === 'orig' || (glFail && mode !== 'bezel')) {
      const s = Math.max(1, Math.floor(Math.min(iw / W, ih / H)));
      return { g: { x: (iw - W * s) >> 1, y: (ih - H * s) >> 1, w: W * s, h: H * s } };
    }
    if (mode === 'crt') {
      let h = ih, w = h * 4 / 3; if (w > iw) { w = iw; h = w * 3 / 4; }
      return { g: { x: (iw - w) / 2, y: (ih - h) / 2, w, h } };
    }
    let aw = iw, ah = aw * 9 / 16; if (ah > ih) { ah = ih; aw = ah * 16 / 9; }
    const a = { x: (iw - aw) / 2, y: (ih - ah) / 2, w: aw, h: ah }, k = aw / BZ.w;
    return { a, g: { x: a.x + BZ.gx * k, y: a.y + BZ.gy * k, w: BZ.gw * k, h: BZ.gh * k } };
  }
  const px = (el, r) => { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; };
  function layout() {
    const scr = document.getElementById('screen'); if (!scr) return;
    const R = rects(), useGL = mode !== 'orig' && ensureGL();
    px(scr, R.g);
    // overlay UI: the F1 hint stays on the bricks beside the frame, above the bottom pipe;
    // the web multiplayer button is placed by placeChrome() on the bezel bar under the CRT.
    const A = R.a || { x: 0, y: 0, w: innerWidth, h: innerHeight }, kk = A.w / BZ.w, ds = document.documentElement.style;
    ds.setProperty('--uib', (innerHeight - A.y - A.h + (R.a ? 70 * kk : 6)) + 'px');
    ds.setProperty('--uil', (A.x + (R.a ? 56 * kk : 8)) + 'px'); ds.setProperty('--uir', (innerWidth - A.x - A.w + (R.a ? 56 * kk : 8)) + 'px');
    ds.setProperty('--uiw', (R.a ? Math.max(120, (BZ.gx - BZ.L - 70) * kk) : 2000) + 'px'); scr.style.opacity = useGL ? '0' : '1';
    scr.style.imageRendering = useGL || mode === 'orig' ? '' : 'auto';
    if (mode === 'orig') scr.style.imageRendering = 'pixelated';
    if (crt) {
      crt.style.display = useGL ? 'block' : 'none';
      if (useGL) { px(crt, R.g); const d = G.devicePixelRatio || 1; crt.width = Math.round(R.g.w * d); crt.height = Math.round(R.g.h * d); }
    }
    document.body.style.background = mode === 'bezel' ? 'radial-gradient(#06140a,#000 80%)' : '#000';
    if (mode === 'bezel') {
      if (!bz) { bz = document.createElement('canvas'); bz.id = 'bezel'; bz.style.cssText = 'position:absolute;z-index:0;pointer-events:none'; document.body.prepend(bz); }
      bz.style.display = 'block'; px(bz, R.a);
      const d = G.devicePixelRatio || 1, cw = Math.min(3840, Math.round(R.a.w * d)), key = cw + '';
      if (key !== bzKey) { bzKey = key; bz.width = cw; bz.height = Math.round(cw * 9 / 16); drawBezel(bz); }
    } else if (bz) bz.style.display = 'none';
    placeChrome(R);
    if (G.TMNTLOADING) G.TMNTLOADING.place(); // loading overlay follows the game canvas (resize / fullscreen)
  }
  // Multijogador (web): centered in the bezel/letterbox under the CRT when there is room;
  // otherwise at the bottom of the viewport, and the coin hint is lifted if they overlap the game.
  // Desktop (app:) keeps the old corner button and has no #bar.
  function placeChrome(R) {
    const bar = document.getElementById('bar');
    if (!bar) return;
    const bh = bar.offsetHeight || 32;
    const gameBottom = R.g.y + R.g.h;
    const floor = Math.min(R.a ? (R.a.y + R.a.h) : innerHeight, innerHeight);
    const margin = floor - gameBottom;
    let top;
    if (margin >= bh) top = gameBottom + (margin - bh) / 2;
    else {
      // Stay just below the CRT when any bezel/letterbox remains (a pixel may
      // clip at the viewport edge). If the CRT fills the height, sit at the bottom.
      top = gameBottom + Math.max(0, Math.min(2, margin));
      if (top + bh > innerHeight + 3 && margin < 8) top = innerHeight - bh - 4;
    }
    bar.style.top = Math.round(top) + 'px';
    bar.style.bottom = 'auto';
    bar.style.left = '50%';
    bar.style.transform = 'translateX(-50%)';
    if (window.TMNTHINT) {
      const overlap = Math.max(0, gameBottom - top);
      TMNTHINT.bottom = overlap > 0 && R.g.h > 0 ? Math.ceil(overlap * H / R.g.h) + 2 : 2;
    }
  }
  // ---------- WebGL CRT ----------
  const VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';
  const FS = `precision mediump float;
uniform sampler2D T;uniform vec2 SRC;uniform vec2 OUT;varying vec2 uv;
vec2 warp(vec2 p){p=p*2.-1.;p*=vec2(1.+p.y*p.y*.028,1.+p.x*p.x*.040);return p*.5+.5;}
vec3 tap(float x,float y){float i=floor(x-.5),f=fract(x-.5);f=clamp((f-.5)*2.5+.5,0.,1.);vec3 c=texture2D(T,vec2(i+.5+f,y)/SRC).rgb;return c*c;}
vec3 beam(float d,vec3 c){vec3 w=mix(vec3(.24),vec3(.46),sqrt(c));vec3 e=d/w;return exp(-.5*e*e);}
void main(){
 vec2 w=warp(uv);
 if(w.x<0.||w.x>1.||w.y<0.||w.y>1.){gl_FragColor=vec4(0.,0.,0.,1.);return;}
 float sc=OUT.y/SRC.y, s=clamp((sc-1.6)/2.2,0.,1.);
 float x=w.x*SRC.x, sy=w.y*SRC.y-.5, r0=floor(sy), f=sy-r0;
 vec3 c0=tap(x,r0+.5), c1=tap(x,r0+1.5);
 vec3 scan=c0*beam(f,c0)+c1*beam(1.-f,c1);
 vec3 fl=mix(c0,c1,smoothstep(.3,.7,f));
 vec3 col=mix(fl,scan*1.75,s);
 vec2 b=vec2(1.6)/SRC; vec3 g=vec3(0.);
 g+=texture2D(T,w+vec2(b.x,b.y)).rgb;g+=texture2D(T,w+vec2(-b.x,b.y)).rgb;g+=texture2D(T,w+vec2(b.x,-b.y)).rgb;g+=texture2D(T,w+vec2(-b.x,-b.y)).rgb;
 g*=.25; col+=g*g*.16;
 float m=mod(floor(gl_FragCoord.x),3.); vec3 mk=vec3(.86); if(m<.5)mk.r=1.12;else if(m<1.5)mk.g=1.12;else mk.b=1.12;
 col*=mix(vec3(1.),mk,s);
 vec2 v=w*(1.-w); col*=pow(clamp(v.x*v.y*16.,0.,1.),.10);
 vec2 e=min(w,1.-w)*vec2(SRC.x/SRC.y,1.); float cm=smoothstep(0.,.008,min(e.x,e.y)); 
 gl_FragColor=vec4(sqrt(col)*cm,1.);}`;
  function ensureGL() {
    if (gl) return true; if (glFail || q.get('webgl') === '0') { glFail = true; return false; }
    try {
      crt = document.createElement('canvas'); crt.id = 'crt'; crt.style.cssText = 'position:absolute;z-index:1;pointer-events:none';
      gl = crt.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
      if (!gl) throw new Error('no webgl');
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const bb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.uniform2f(gl.getUniformLocation(prog, 'SRC'), W, H); gl.uniform1i(gl.getUniformLocation(prog, 'T'), 0);
      crt.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; glFail = true; layout(); });
      document.getElementById('screen').after(crt);
      return true;
    } catch (e) { console.warn('gfx: WebGL unavailable, using the 2D canvas', e.message); gl = null; glFail = true; if (crt) crt.remove(); crt = null; return false; }
  }
  const tms = [];
  function present(img) {
    if (mode === 'orig' || !gl) return;
    const t0 = performance.now();
    gl.viewport(0, 0, crt.width, crt.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.uniform2f(gl.getUniformLocation(prog, 'OUT'), crt.width, crt.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); frames++;
    tms.push(performance.now() - t0); if (tms.length > 240) tms.shift();
  }
  // ---------- bezel (procedural, 1920x1080 design units) ----------
  const SANS = "Impact,'Arial Black','Helvetica Neue',Arial,sans-serif";
  function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function fitText(c, t, x, y, maxw) { const m = c.measureText(t).width; if (m > maxw) { c.save(); c.translate(x, y); c.scale(maxw / m, 1); c.fillText(t, 0, 0); c.restore(); } else c.fillText(t, x, y); }
  function city(c) { // night sky, moon, skyline with lit windows (top band)
    const sky = c.createLinearGradient(0, 0, 0, 430); sky.addColorStop(0, '#04060f'); sky.addColorStop(.7, '#121a3a'); sky.addColorStop(1, '#2a1f45');
    c.fillStyle = sky; c.fillRect(0, 0, BZ.w, 430);
    const r = rnd(7); for (let i = 0; i < 160; i++) { c.fillStyle = `rgba(255,255,255,${.2 + r() * .6})`; c.fillRect(r() * BZ.w, r() * 260, 2, 2); }
    const mg = c.createRadialGradient(1560, 120, 10, 1560, 120, 160); mg.addColorStop(0, 'rgba(255,250,220,.35)'); mg.addColorStop(1, 'rgba(255,250,220,0)');
    c.fillStyle = mg; c.fillRect(1380, 0, 360, 300); c.fillStyle = '#f4efd6'; c.beginPath(); c.arc(1560, 120, 54, 0, 7); c.fill();
    c.fillStyle = 'rgba(180,170,140,.35)'; for (const [x, y, s] of [[1545, 105, 10], [1578, 135, 7], [1550, 145, 5]]) { c.beginPath(); c.arc(x, y, s, 0, 7); c.fill(); }
    for (const [base, col, hmin, hmax, wl] of [[430, '#0c1024', 120, 300, .10], [430, '#070914', 60, 200, .22]]) {
      for (let x = -20; x < BZ.w;) {
        const w = 60 + r() * 110, h = hmin + r() * (hmax - hmin); c.fillStyle = col; c.fillRect(x, base - h, w, h);
        if (r() < .3) { c.fillRect(x + w / 2 - 3, base - h - 40, 6, 40); c.fillStyle = '#ff3030'; c.fillRect(x + w / 2 - 3, base - h - 44, 6, 6); }
        for (let yy = base - h + 14; yy < base - 10; yy += 22) for (let xx = x + 10; xx < x + w - 12; xx += 18)
          if (r() < wl) { c.fillStyle = r() < .8 ? 'rgba(255,214,120,.85)' : 'rgba(140,220,255,.8)'; c.fillRect(xx, yy, 8, 11); }
        x += w + 4 + r() * 10;
      }
    }
  }
  function bricks(c) { // sewer wall: wet bricks below the street line, with a slime gradient
    const y0 = 400, r = rnd(31), bh = 44, bw = 104;
    c.fillStyle = '#141814'; c.fillRect(0, y0, BZ.w, BZ.h - y0);
    for (let row = 0, y = y0; y < BZ.h; row++, y += bh) for (let x = (row % 2 ? -bw / 2 : 0); x < BZ.w; x += bw) {
      const t = 24 + r() * 22 | 0; c.fillStyle = `rgb(${t + 10},${t + 16},${t + 8})`; c.fillRect(x + 3, y + 3, bw - 6, bh - 6);
      c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(x + 3, y + 3, bw - 6, 3); c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(x + 3, y + bh - 7, bw - 6, 4);
      if (r() < .12) { c.fillStyle = 'rgba(80,160,40,.18)'; c.fillRect(x + 3, y + 3, bw - 6, bh - 6); }
    }
    c.fillStyle = '#1b1d22'; c.fillRect(0, y0 - 18, BZ.w, 24); c.fillStyle = '#3a3d44'; c.fillRect(0, y0 - 18, BZ.w, 4); // curb
    const sl = c.createLinearGradient(0, 880, 0, BZ.h); sl.addColorStop(0, 'rgba(60,170,30,0)'); sl.addColorStop(1, 'rgba(70,200,40,.45)'); c.fillStyle = sl; c.fillRect(0, 880, BZ.w, 200);
    for (let i = 0; i < 26; i++) { const x = r() * BZ.w, l = 30 + r() * 120, y = y0 + 6; c.fillStyle = 'rgba(110,210,50,.35)'; rr(c, x, y, 5, l, 2.5); c.fill(); c.beginPath(); c.arc(x + 2.5, y + l, 5, 0, 7); c.fill(); }
  }
  function pipe(c, x0, y0, x1, y1, r) { // round steel pipe with highlight and flanges
    const hz = y0 === y1, g = hz ? c.createLinearGradient(0, y0 - r, 0, y0 + r) : c.createLinearGradient(x0 - r, 0, x0 + r, 0);
    g.addColorStop(0, '#20262a'); g.addColorStop(.35, '#8a9aa0'); g.addColorStop(.5, '#c6d4d8'); g.addColorStop(.7, '#55626a'); g.addColorStop(1, '#14181b');
    c.fillStyle = 'rgba(0,0,0,.5)'; hz ? c.fillRect(x0, y0 - r + 8, x1 - x0, 2 * r) : c.fillRect(x0 - r + 8, y0, 2 * r, y1 - y0);
    c.fillStyle = g; hz ? c.fillRect(x0, y0 - r, x1 - x0, 2 * r) : c.fillRect(x0 - r, y0, 2 * r, y1 - y0);
    const len = hz ? x1 - x0 : y1 - y0;
    for (let d = 90; d < len - 40; d += 300) { c.fillStyle = g; hz ? c.fillRect(x0 + d, y0 - r - 6, 22, 2 * r + 12) : c.fillRect(x0 - r - 6, y0 + d, 2 * r + 12, 22);
      c.fillStyle = '#0e1113'; for (const o of [-r, r]) { c.beginPath(); hz ? c.arc(x0 + d + 11, y0 + o, 3, 0, 7) : c.arc(x0 + o, y0 + d + 11, 3, 0, 7); c.fill(); } }
  }
  function bolt(c, x, y, r) { const g = c.createRadialGradient(x - r / 3, y - r / 3, 1, x, y, r); g.addColorStop(0, '#e8f0f0'); g.addColorStop(.6, '#7a868a'); g.addColorStop(1, '#2a3033');
    c.fillStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(x + 2, y + 3, r, 0, 7); c.fill(); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
  function manhole(c, x, y, R) { // cast-iron cover: rim, grid pattern, two pick holes
    c.fillStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.arc(x + 4, y + 6, R + 4, 0, 7); c.fill();
    const g = c.createRadialGradient(x - R / 3, y - R / 3, 4, x, y, R); g.addColorStop(0, '#6a6f72'); g.addColorStop(1, '#25292b');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, 7); c.fill(); c.strokeStyle = '#111'; c.lineWidth = R * .08; c.beginPath(); c.arc(x, y, R * .86, 0, 7); c.stroke();
    c.save(); c.beginPath(); c.arc(x, y, R * .78, 0, 7); c.clip(); c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = R * .06;
    for (let d = -R; d <= R; d += R * .26) { c.beginPath(); c.moveTo(x + d, y - R); c.lineTo(x + d, y + R); c.stroke(); c.beginPath(); c.moveTo(x - R, y + d); c.lineTo(x + R, y + d); c.stroke(); }
    c.restore(); c.fillStyle = '#0a0a0a'; for (const o of [-.45, .45]) { c.beginPath(); c.ellipse(x + o * R, y, R * .09, R * .05, 0, 0, 7); c.fill(); }
  }
  function sign(c, x, y, w, h, lines, glow) { // neon sign box with tube lettering
    c.fillStyle = 'rgba(0,0,0,.6)'; rr(c, x + 8, y + 10, w, h, 16); c.fill();
    c.fillStyle = '#0b0f12'; rr(c, x, y, w, h, 16); c.fill(); c.strokeStyle = '#4a555c'; c.lineWidth = 6; rr(c, x, y, w, h, 16); c.stroke();
    c.save(); c.shadowColor = glow; c.shadowBlur = 24; c.strokeStyle = glow; c.lineWidth = 4; rr(c, x + 16, y + 16, w - 32, h - 32, 10); c.stroke(); c.restore();
    for (const L of lines) {
      if (L.manhole) { manhole(c, x + w / 2, y + L.y, L.manhole); continue; }
      c.save(); c.font = `${L.s}px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.shadowColor = L.c || glow; c.shadowBlur = 18;
      c.fillStyle = L.c || glow; fitText(c, L.t, x + w / 2, y + L.y, w - 50); c.shadowBlur = 0; c.fillStyle = 'rgba(255,255,255,.75)'; fitText(c, L.t, x + w / 2, y + L.y, w - 50); c.restore();
      c.save(); c.font = `${L.s}px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.globalAlpha = .55; c.fillStyle = L.c || glow; fitText(c, L.t, x + w / 2, y + L.y, w - 50); c.restore();
    }
    for (const [bx, by] of [[x + 14, y + 14], [x + w - 14, y + 14], [x + 14, y + h - 14], [x + w - 14, y + h - 14]]) bolt(c, bx, by, 5);
  }
  function drawBezel(cv) {
    const c = cv.getContext('2d'), k = cv.width / BZ.w; c.setTransform(k, 0, 0, k, 0, 0);
    city(c); bricks(c);
    const v = c.createRadialGradient(960, 540, 300, 960, 540, 1150); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.62)'); c.fillStyle = v; c.fillRect(0, 0, BZ.w, BZ.h);
    const gx = BZ.gx, gy = BZ.gy, gw = BZ.gw, gh = BZ.gh, L = BZ.L; // steel band width
    // pipes around the outer edge
    pipe(c, 0, 26, BZ.w, 26, 16); pipe(c, 0, BZ.h - 26, BZ.w, BZ.h - 26, 16); pipe(c, 26, 0, 26, BZ.h, 16); pipe(c, BZ.w - 26, 0, BZ.w - 26, BZ.h, 16);
    for (const [x, y] of [[26, 26], [BZ.w - 26, 26], [26, BZ.h - 26], [BZ.w - 26, BZ.h - 26]]) { c.fillStyle = '#3d474c'; rr(c, x - 26, y - 26, 52, 52, 8); c.fill(); bolt(c, x, y, 9); }
    // riveted steel frame (diamond plate)
    c.fillStyle = 'rgba(0,0,0,.55)'; rr(c, gx - L - 6, gy - L + 4, gw + 2 * L + 20, gh + 2 * L + 14, 26); c.fill();
    const lg = c.createLinearGradient(0, gy - L, 0, gy + gh + L); lg.addColorStop(0, '#5d6a70'); lg.addColorStop(.5, '#3a4448'); lg.addColorStop(1, '#262d30');
    c.fillStyle = lg; rr(c, gx - L, gy - L, gw + 2 * L, gh + 2 * L, 22); c.fill();
    c.save(); rr(c, gx - L, gy - L, gw + 2 * L, gh + 2 * L, 22); c.clip(); c.lineWidth = 3;
    for (let y = gy - L + 8, i = 0; y < gy + gh + L; y += 18, i++) for (let x = gx - L + (i % 2) * 18; x < gx + gw + L; x += 36) {
      c.strokeStyle = 'rgba(255,255,255,.13)'; c.beginPath(); c.moveTo(x, y + 4); c.lineTo(x + 12, y - 4); c.stroke(); }
    c.restore();
    c.strokeStyle = 'rgba(220,240,240,.25)'; c.lineWidth = 2; rr(c, gx - L + 1, gy - L + 1, gw + 2 * L - 2, gh + 2 * L - 2, 21); c.stroke();
    c.setLineDash([26, 14]); c.strokeStyle = 'rgba(240,200,40,.75)'; c.lineWidth = 3; rr(c, gx - L + 4, gy - L + 4, gw + 2 * L - 8, gh + 2 * L - 8, 14); c.lineWidth = 2; c.stroke(); c.setLineDash([]);
    // toxic-green glowing inner lip + black glass recess
    c.save(); c.shadowColor = '#6cff3a'; c.shadowBlur = 34;
    const bg = c.createLinearGradient(0, gy - 14, 0, gy + gh + 14); bg.addColorStop(0, '#b6ff6a'); bg.addColorStop(.5, '#2f8a16'); bg.addColorStop(1, '#8be04a');
    c.fillStyle = bg; rr(c, gx - 9, gy - 9, gw + 18, gh + 18, 10); c.fill(); c.restore();
    c.fillStyle = '#030503'; rr(c, gx - 3, gy - 3, gw + 6, gh + 6, 8); c.fill();
    // rivets on the steel
    for (let i = 1; i < 10; i++) { const x = gx - L / 2 + (gw + L) * i / 10; bolt(c, x, gy - L / 2 - 4, 4); bolt(c, x, gy + gh + L / 2 + 4, 4); }
    for (let i = 1; i < 8; i++) { const y = gy - L / 2 + (gh + L) * i / 8; bolt(c, gx - L / 2 - 4, y, 4); bolt(c, gx + gw + L / 2 + 4, y, 4); }
    // corner manhole covers on the frame
    for (const [x, y] of [[gx - L / 2, gy - L / 2], [gx + gw + L / 2, gy - L / 2], [gx - L / 2, gy + gh + L / 2], [gx + gw + L / 2, gy + gh + L / 2]]) manhole(c, x, y, 24);
    // side neon signs
    const pw = 214, ph = 400, py = 340; // fit between the side pipe (x 42) and the frame (x ~295)
    sign(c, 42 + (gx - L - 42 - pw) / 2 - 4, py, pw, ph, [{ t: 'SEWER', s: 60, y: 80 }, { t: 'ACCESS', s: 40, y: 130, c: '#ffd23a' }, { manhole: 62, y: 232 }, { t: 'KEEP OUT', s: 34, y: 338, c: '#ff5a3a' }], '#6cff3a');
    sign(c, gx + gw + L + (BZ.w - 42 - gx - gw - L - pw) / 2 + 4, py, pw, ph, [{ t: 'PIZZA', s: 62, y: 80, c: '#ff8a2a' }, { t: 'OPEN LATE', s: 30, y: 128, c: '#ffd23a' }, { t: '1 - 4', s: 74, y: 236 }, { t: 'PLAYERS', s: 32, y: 300 }, { t: 'INSERT COIN', s: 26, y: 352, c: '#3ad2ff' }], '#6cff3a');
    // title plate (stencil-sprayed steel plate, plain system font: no logo)
    const tw = 460, th = 54, tx = 960 - tw / 2, ty = gy - L - th / 2 - 2; // straddles the top pipe and the frame edge
    c.fillStyle = 'rgba(0,0,0,.55)'; rr(c, tx + 6, ty + 8, tw, th, 12); c.fill();
    const tg = c.createLinearGradient(0, ty, 0, ty + th); tg.addColorStop(0, '#9aa8ae'); tg.addColorStop(.45, '#5a666c'); tg.addColorStop(.55, '#4a555a'); tg.addColorStop(1, '#7d8a90');
    c.fillStyle = tg; rr(c, tx, ty, tw, th, 12); c.fill(); c.strokeStyle = '#1a2023'; c.lineWidth = 3; rr(c, tx + 6, ty + 6, tw - 12, th - 12, 8); c.stroke();
    for (const x of [tx + 22, tx + tw - 22]) bolt(c, x, ty + th / 2, 6);
    c.font = `36px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(0,0,0,.6)'; fitText(c, 'T  M  N  T', 963, ty + th / 2 + 5, tw - 90);
    c.save(); c.shadowColor = '#6cff3a'; c.shadowBlur = 16; c.fillStyle = '#7dff45'; fitText(c, 'T  M  N  T', 960, ty + th / 2 + 2, tw - 90); c.restore();
  }
  // ---------- debug mode switch (tests only; no key, not persisted) ----------
  function set(m) { if (!MODES.includes(m)) return; mode = m; layout(); }
  addEventListener('resize', layout);
  G.TMNTGFX = { layout, present, set, rects, BZ, get mode() { return mode; }, get webgl() { return !!gl; }, get frames() { return frames; }, modes: MODES };
})(window);
