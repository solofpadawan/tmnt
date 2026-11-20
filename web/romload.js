// ROM loader for the ROM-free public build: the player picks their own MAME 'tmnt' zip (World 4 Players ver. X);
// files are found by CRC32 (any names), checked, and turned into the machine's ROM regions by romset.js.
// Nothing ROM-derived is ever served. The checked raw files are cached in IndexedDB ('tmnt'), so the zip is picked once.
(function (G) {
  'use strict';
  const t = (k, o) => {
    try {
      if (typeof G !== 'undefined' && G.t) return G.t(k, o);
      if (typeof globalThis !== 'undefined' && typeof globalThis.t === 'function') return globalThis.t(k, o);
    } catch (e) {}
    const fb = {
      'rom.err.notZip': 'não é um arquivo zip',
      'rom.err.corrupt': 'zip corrompido',
      'rom.err.method': 'método de compressão não suportado',
      'rom.err.crc': (o && o.name ? o.name : '{{name}}') + ': CRC não confere',
      'rom.err.missing': 'Arquivos faltando (precisa do set MAME tmnt, World 4 Players ver. X): ' + ((o && o.list) || ''),
      'rom.h': 'Selecione o seu <b>tmnt.zip</b> da MAME (World 4 Players ver. X)',
      'rom.d': 'ou arraste o arquivo para cá',
      'rom.b': 'Escolher arquivo',
      'rom.n': 'Esta página não tem nenhum dado do jogo: use a sua própria ROM. Ela é lida e guardada só no seu navegador; nada é enviado.',
      'rom.r': 'Lendo…',
      'rom.c': 'Verificando ' + ((o && o.name) || '')
    };
    const v = fb[k];
    if (typeof v === 'string') return v;
    return k;
  };
  const CRCT = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRCT[n] = c; }
  function crc32(u8) { let c = -1; for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  async function inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  // minimal zip reader (central directory; stored and deflate entries; zip64 not needed for these sizes)
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error(t('rom.err.notZip'));
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(t('rom.err.corrupt'));
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
      out.push({ name: name.split('/').pop(), crc, size, method, lo, csize });
    }
    const get = async f => {
      const s = f.lo + 30 + dv.getUint16(f.lo + 26, true) + dv.getUint16(f.lo + 28, true), raw = u8.subarray(s, s + f.csize);
      if (f.method === 0) return raw.slice(); if (f.method === 8) return inflateRaw(raw); throw new Error(t('rom.err.method'));
    };
    return { files: out, get };
  }
  async function extract(zipBuf, progress) {
    const z = await unzip(zipBuf), byCrc = new Map(z.files.map(f => [f.crc >>> 0, f])), raw = {}, missing = [];
    for (const [name, crc] of Object.entries(TMNTROM.NEED)) {
      const f = byCrc.get(crc); if (!f) { missing.push(name); continue; }
      raw[name] = await z.get(f); if (progress) progress(name);
      if (crc32(raw[name]) !== crc) throw new Error(t('rom.err.crc', { name }));
    }
    if (missing.length) throw new Error(t('rom.err.missing', { list: missing.join(', ') }));
    return TMNTROM.build(raw);
  }
  async function extractRaw(zipBuf, progress) {
    const z = await unzip(zipBuf), byCrc = new Map(z.files.map(f => [f.crc >>> 0, f])), raw = {}, missing = [];
    for (const [name, crc] of Object.entries(TMNTROM.NEED)) {
      const f = byCrc.get(crc); if (!f) { missing.push(name); continue; }
      raw[name] = await z.get(f); if (progress) progress(name);
      if (crc32(raw[name]) !== crc) throw new Error(t('rom.err.crc', { name }));
    }
    if (missing.length) throw new Error(t('rom.err.missing', { list: missing.join(', ') }));
    return raw;
  }
  // ---- IndexedDB cache (raw ROM files by name; re-checked by CRC on load) ----
  const idb = (mode, fn) => new Promise((ok, ko) => {
    const r = indexedDB.open('tmnt', 1); r.onupgradeneeded = () => r.result.createObjectStore('roms');
    r.onerror = () => ko(r.error);
    r.onsuccess = () => { const tx = r.result.transaction('roms', mode), st = tx.objectStore('roms'), q = fn(st); tx.oncomplete = () => { r.result.close(); ok(q && q.result); }; tx.onerror = () => ko(tx.error); };
  });
  const cacheGet = () => idb('readonly', st => st.get('raw')).catch(() => null);
  const cachePut = raw => idb('readwrite', st => st.put(raw, 'raw')).catch(e => console.warn('IndexedDB', e));
  const cacheClear = () => idb('readwrite', st => st.delete('raw'));
  const valid = raw => raw && Object.entries(TMNTROM.NEED).every(([n, c]) => raw[n] && crc32(raw[n]) === c);
  function ask() {
    return new Promise(resolve => {
      if (G.TMNTLOADING) G.TMNTLOADING.hide(); // the picker owns the screen; the next stage() shows the overlay again
      const d = document.createElement('div'); d.id = 'romload';
      const tt = { h: t('rom.h'), d: t('rom.d'), b: t('rom.b'), n: t('rom.n'), r: t('rom.r'), c: (name) => t('rom.c', { name }) };
      d.innerHTML = `<style>
#romload{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(#0f2a14,#000 75%);
 color:#dff5d0;font:clamp(12px,2.4vmin,18px) system-ui,sans-serif;z-index:20;box-sizing:border-box;padding:3vmin}
#romload .bx{width:min(560px,92vw);text-align:center;border:3px dashed #5fbf3a;border-radius:14px;padding:4vmin 5vmin;background:rgba(0,0,0,.6);box-sizing:border-box;cursor:pointer}
#romload .bx.over{background:rgba(95,191,58,.25)}
#romload h1{margin:0 0 .4em;font:900 clamp(22px,6vmin,46px) Impact,'Arial Black',sans-serif;letter-spacing:.06em;color:#8bd94a;text-shadow:3px 3px 0 #123d0c}
#romload button{font:inherit;font-weight:700;padding:.6em 1.4em;border:0;border-radius:8px;background:#8bd94a;color:#0b2208;cursor:pointer}
#romload small{display:block;margin-top:1.2em;opacity:.6;line-height:1.35}#romload .m{min-height:1.3em;margin-top:.8em;color:#ffb0a0}</style>
<div class="bx"><h1>TMNT</h1><div style="font-size:1.3em;margin:.5em 0 .2em">${tt.h}</div>
<div style="opacity:.75;margin-bottom:1em">${tt.d}</div><button type="button">${tt.b}</button>
<input type="file" accept=".zip,application/zip" id="zip" hidden><div class="m"></div>
<small>${tt.n}</small></div>`;
      document.body.appendChild(d);
      const bx = d.querySelector('.bx'), inp = d.querySelector('#zip'), msg = d.querySelector('.m');
      const take = async file => {
        try { msg.style.color = '#dff5d0'; msg.textContent = tt.r; const raw = await extractRaw(await file.arrayBuffer(), n => { msg.textContent = tt.c(n); });
          await cachePut(raw); d.remove(); resolve(raw); }
        catch (e) { msg.style.color = '#ffb0a0'; msg.textContent = e.message; inp.value = ''; }
      };
      bx.onclick = () => inp.click(); inp.onclick = e => e.stopPropagation();
      inp.onchange = () => inp.files[0] && take(inp.files[0]);
      d.ondragover = e => { e.preventDefault(); bx.classList.add('over'); }; d.ondragleave = () => bx.classList.remove('over');
      d.ondrop = e => { e.preventDefault(); bx.classList.remove('over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]); };
      d.querySelector('button').focus();
    });
  }
  // ROM regions for the machine: from the IndexedDB cache, else ask for the zip (once)
  // PC deploy: a local roms/tmnt.zip next to index.html (never in the public/itch build) is used first, CRC-checked
  async function local(st) {
    if (typeof window !== "undefined" && window.TMNT_PUBLIC) return null; // public (itch) build: never looks for a local ROM
    try { const r = await fetch('roms/tmnt.zip', { cache: 'no-cache' }); if (!r.ok) return null; const zb = await r.arrayBuffer(); if (st) st('romcheck'); return await extractRaw(zb); }
    catch (e) { console.warn('roms/tmnt.zip', e.message); return null; }
  }
  async function ensure() {
    const L = G.TMNTLOADING, st = k => { if (L) L.stage(k); };
    st('rom'); const l = await local(st);
    if (l) { st('machine'); if (L) await L.paint(); return TMNTROM.build(l); }
    st('romcache'); const c = await cacheGet();
    if (c) st('romcheck');
    const raw = valid(c) ? c : await ask();
    st('machine'); if (L) await L.paint();
    return TMNTROM.build(raw);
  }
  G.TMNTLOAD = { extract, extractRaw, ensure, cacheClear, crc32 };
})(window);
