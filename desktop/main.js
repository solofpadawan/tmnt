// TMNT public desktop (app://game) — local only, no online multiplayer.
// Serves the game from resources/web (packaged) or ./web (dev).
// ROM is NOT bundled: the in-game loader asks for the user's own MAME tmnt.zip
// (or, optionally, a local roms/tmnt.zip that is never committed).
// Safety net: every http(s)/ws(s) request is cancelled and logged; mic/notifications denied;
// net/ and *.php are never served. Do not contact games4me-netplay, alwaysdata, TURN or PeerJS.
'use strict';
const { app, BrowserWindow, protocol, net, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WEB = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, 'web');
const NETLOG = process.env.TMNT_NETLOG || '';

function netLog(action, url) {
  const line = new Date().toISOString() + ' ' + action + ' ' + url + '\n';
  if (NETLOG) { try { fs.appendFileSync(NETLOG, line); } catch (e) {} }
  else console.log('[net]', action, url);
}

const LOCAL_OK = /^(app:|devtools:|chrome:|chrome-extension:|chrome-error:|data:|blob:|about:|file:)/i;
function isExternal(url) {
  return !LOCAL_OK.test(url);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('metrics-recording-only');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('no-pings');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
Menu.setApplicationMenu(null);

// 68000 JIT uses new Function, so script-src needs unsafe-eval. connect-src is local only.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const ALLOW_EXT = new Set(['.js', '.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.zip', '.bin', '.json', '.wasm', '.txt', '.map']);

function localFile(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return { err: 400 }; }
  if (u.protocol !== 'app:') return { err: 400 };
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p.includes('\\') || p.includes('\0')) return { err: 400 };
  const f = path.normalize(path.join(WEB, p));
  if (!f.startsWith(WEB + path.sep) && f !== WEB) return { err: 403 };
  if (/[\\/]net[\\/]|\.php$/i.test(f)) return { err: 403 };
  const ext = path.extname(f).toLowerCase();
  if (!ALLOW_EXT.has(ext)) return { err: 403 };
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return { err: 404 };
  return { file: f };
}

function installNetworkGuard(sess) {
  sess.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  sess.setPermissionCheckHandler(() => false);
  try { sess.setSpellCheckerEnabled(false); } catch (e) {}
  netLog('GUARD', 'session webRequest installed');
  try {
    sess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      if (isExternal(details.url)) {
        netLog('BLOCK', details.url);
        return callback({ cancel: true });
      }
      netLog('ALLOW', details.url);
      callback({ cancel: false });
    });
  } catch (e) {
    netLog('GUARD-ERR', String(e && e.message || e));
  }
  sess.webRequest.onBeforeRedirect({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    if (isExternal(details.redirectURL || '')) netLog('REDIRECT', details.redirectURL);
  });
}

app.whenReady().then(() => {
  installNetworkGuard(session.defaultSession);

  protocol.handle('app', async (req) => {
    const got = localFile(req.url);
    if (got.err) return new Response(got.err === 404 ? 'not found' : 'forbidden', { status: got.err });
    try {
      const r = await net.fetch(pathToFileURL(got.file).toString());
      const headers = new Headers(r.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(r.body, { status: r.status, headers });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  const w = new BrowserWindow({
    width: 1280, height: 960, fullscreen: true, autoHideMenuBar: true,
    title: 'TMNT', backgroundColor: '#000',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      backgroundThrottling: false, contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, devTools: true
    }
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    netLog('POPUP-DENY', url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { netLog('NAV-DENY', url); e.preventDefault(); }
  });
  w.webContents.on('will-redirect', (e, url) => {
    if (!url.startsWith('app://')) { netLog('NAV-REDIRECT-DENY', url); e.preventDefault(); }
  });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11' || (i.alt && i.key === 'Enter')) { w.setFullScreen(!w.isFullScreen()); e.preventDefault(); }
    else if (i.key === 'Escape' && w.isFullScreen()) { w.setFullScreen(false); e.preventDefault(); }
  });
  // autoplay already allowed: start audio without waiting for the first real key (startAudio listens for keydown)
  w.webContents.on('did-finish-load', () => w.webContents.executeJavaScript(
    "(window.TMNTG ? TMNTG.whenReady : Promise.resolve()).then(() => dispatchEvent(new KeyboardEvent('keydown', { code: 'F24', key: 'F24' })))"
  ).catch(() => {}));
  w.webContents.on('console-message', (_e, _level, message) => {
    if (/Refused to connect|CSP|Content Security Policy|Failed to load|net::/i.test(message)) netLog('CONSOLE', message);
  });
  w.loadURL('app://game/index.html');
});
app.on('window-all-closed', () => app.quit());
