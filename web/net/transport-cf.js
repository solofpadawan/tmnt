// Cloudflare netplay signaling client: drop-in replacement for PhpSignal in each game's web/net/transport.js.
// Same interface: new CfSignal(url, room, id); .req(a, extra, body) -> Promise<json>; .send(to, msg); .loop(); .close();
// .onmsg = (from, data) => ...; .meta = () => ({n, p, s, st, pv, pl, sp}) | null; .alive.
// url = the HTTP endpoint, e.g. https://games4me-netplay.<sub>.workers.dev/ssr/signal.php (old signal.php URLs also work:
// then it simply polls like PhpSignal). With the Worker it opens wss://.../ssr/ws?room=&id= after host/join and gets
// offers/answers/ICE pushed instantly; if the socket fails or drops it polls over HTTP (same as PhpSignal) and retries the
// socket with backoff. Load it before transport.js: <script src="net/transport-cf.js"></script>
(function (G) {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function wsUrlFor(url) { // https://host/<game>/signal.php -> wss://host/<game>/ws ; null for anything that is not our Worker
    try { const u = new URL(url, G.location && G.location.href);
      if (!/\/signal(\.php)?$/.test(u.pathname) || /alwaysdata/.test(u.host)) return null; // plain PHP host: polling only
      u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'; u.pathname = u.pathname.replace(/\/signal(\.php)?$/, '/ws'); u.search = ''; return u.href; } catch (e) { return null; }
  }
  function CfSignal(url, room, id, opts) {
    this.url = url; this.room = room; this.id = id; this.onmsg = null; this.alive = true; this.fast = 0;
    this.o = opts || {}; this.wsUrl = this.o.ws === false ? null : (this.o.wsUrl || wsUrlFor(url)); this.ws = null; this.wsOk = false; this.backoff = 1000;
  }
  CfSignal.prototype.req = async function (a, extra, body) {
    const u = `${this.url}?a=${a}&room=${this.room}&id=${this.id}${extra || ''}`;
    const r = await fetch(u, body === undefined ? { cache: 'no-store' } : { method: 'POST', body, cache: 'no-store', keepalive: a === 'leave' });
    const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
    if (!j.ok) throw new Error(j.error || 'signal error');
    if (typeof j.match_id === 'string' && !this.match_id) this.match_id = j.match_id; // Worker v19+: host / join / poll carry match_id (32 hex), used by the online highscore report (net/highscore.js)
    return j;
  };
  CfSignal.prototype.send = function (to, msg) {
    this.fast = 20;
    if (this.wsOk && this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'send', to, msg: JSON.stringify(msg) })); return Promise.resolve(); } catch (e) {} }
    return this.req('send', '&to=' + to, JSON.stringify(msg)).catch(e => console.warn('signal send', e.message));
  };
  CfSignal.prototype.deliver = function (from, raw) { let d; try { d = JSON.parse(raw); } catch (e) { return; } this.fast = 20; if (this.onmsg) this.onmsg(from, d); };
  CfSignal.prototype.openWs = function () {
    return new Promise(res => {
      let done = false; const fin = v => { if (!done) { done = true; res(v); } };
      let ws; try { ws = new WebSocket(`${this.wsUrl}?room=${encodeURIComponent(this.room)}&id=${encodeURIComponent(this.id)}`); } catch (e) { return fin(false); }
      this.ws = ws; const tm = setTimeout(() => { try { ws.close(); } catch (e) {} fin(false); }, 5000);
      ws.onmessage = ev => {
        if (ev.data === 'pong') return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hello') { clearTimeout(tm); this.wsOk = true; this.backoff = 1000; if (typeof m.match_id === 'string' && !this.match_id) this.match_id = m.match_id; fin(true); }
        else if (m.t === 'msg') this.deliver(m.from, m.msg);
        else if (m.t === 'err') console.warn('signal ws', m.error);
        else if (m.t === 'gone') { this.gone = true; this.closeCode = 4004; }
      };
      ws.onclose = ev => { clearTimeout(tm); this.wsOk = false; this.closeCode = this.gone ? 4004 : ev.code; fin(false); };
      ws.onerror = () => {};
    });
  };
  // push loop over the socket (ping 20 s, meta 5 s); falls back to HTTP polling while the socket is down
  CfSignal.prototype.loop = async function () {
    let lastPing = 0;
    while (this.alive) {
      if (this.wsUrl && !this.wsOk && (!this.retryAt || Date.now() >= this.retryAt)) {
        if (await this.openWs()) console.log('[netplay-cf] websocket push on');
        else { this.retryAt = Date.now() + this.backoff; this.backoff = Math.min(this.backoff * 2, 30000); }
      }
      let extra = '';
      const metaDue = this.meta && Date.now() - (this.metaT || 0) >= 5000;
      if (this.wsOk && this.ws.readyState === 1) {
        try {
          if (metaDue) { const m = this.meta(); if (m) this.ws.send(JSON.stringify({ t: 'meta', meta: JSON.stringify(m) })); this.metaT = Date.now(); }
          if (Date.now() - lastPing >= 20000) { this.ws.send('ping'); lastPing = Date.now(); }
        } catch (e) {}
        await sleep(250); continue;
      }
      if (metaDue) { const m = this.meta(); if (m) { extra = '&meta=' + encodeURIComponent(JSON.stringify(m)); this.metaT = Date.now(); } }
      try { const j = await this.req('poll', extra); for (const m of j.msgs) this.deliver(m.from, m.msg); }
      catch (e) { console.warn('signal poll', e.message); await sleep(2000); }
      await sleep(this.fast > 0 ? (this.fast--, 300) : 1500);
    }
  };
  CfSignal.prototype.close = function () { this.alive = false; try { this.ws && this.ws.close(1000, 'bye'); } catch (e) {} return this.req('leave', '', '').catch(() => {}); }; // returns the pending leave request (the spectator's "Sair da sala" waits for it before reloading)
  G.NETCF = { CfSignal, wsUrlFor };
})(typeof window !== 'undefined' ? window : globalThis);
