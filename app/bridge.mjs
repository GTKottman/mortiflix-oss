#!/usr/bin/env node
// Mortiflix app bridge: runs the Mortiflix service (JSON lines over stdio) and gives the screens
// http://127.0.0.1:<port>/ (web/ static files) + a WebSocket at /ws + GET /file?path= (studio media only, cached: ETag/304/Range) + GET /thumb?path=&w= (small cached WebP).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, readFileSync, realpathSync, rmSync, statSync, readdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { sendFile, createThumbs, LOOP_HOST, LAN_HOST } from './tools/media-http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(flag('port', 4646));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { console.error(`bridge: --port must be a whole number from 1 to 65535 (got ${flag('port', '')})`); process.exit(2); }
// --socket <file>: listen on a Unix socket file instead of a port, for a host that serves the app (Morti Drive at
// /studio/, owner 2026-11-03: "stop hosting that on a port"). Only this user's programs can open the file (mode 600);
// the host says in X-Morti-Client whether the person is on this machine ('local') or another device ('remote').
const SOCKET = flag('socket', '');
const SERVICE = flag('service', join(here, '..', 'bin', 'mortiflix-service.mjs'));
const WEB = join(here, 'web');
const ASSETS = join(WEB, 'app', 'assets') + sep; // Vite's content-hashed build files: a new build = new names
const STUDIO = process.env.MORTIFLIX_STUDIO || join(homedir(), 'Mortiflix');
let VERSION = '0.0.0';
try { VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version || VERSION; } catch {}
let studioReal = STUDIO;
try { studioReal = realpathSync(STUDIO); } catch {}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/plain; charset=utf-8' };
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
// Studio media opened directly as a page (e.g. an .svg) runs no script and gets no origin (MDN CSP sandbox);
// <img>/<video>/<audio> ignore these headers, so the screens show the files as before.
const FILE_HEADERS = { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' };

// ---- service child ----
const sockets = new Set();
const pending = new Map(); // service id -> { ws, id }
let child = null, nextId = 1, backoff = 500, hello = null, up = false, stopping = false;

const broadcast = (obj) => { const s = JSON.stringify(obj); for (const w of sockets) if (w.readyState === 1) w.send(s); };

function startService() {
  // MFX_BRIDGE_PORT: the service names the home-network addresses with this bridge's port (svc/lanaccess.mjs)
  const env = { ...process.env, MORTIFLIX_STUDIO: STUDIO, MFX_BRIDGE_PORT: String(PORT) };
  const c = spawn(process.execPath, [SERVICE], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  child = c;
  console.error(`bridge: service pid ${c.pid} studio ${STUDIO}`);
  let buf = '';
  // a write to a service that just died must not take the bridge down (EPIPE): the exit handler restarts it
  c.stdin.on('error', (e) => console.error(`bridge: service input closed (${e.code || e.message})`));
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) onServiceLine(line);
    }
  });
  // Node docs (child_process 'error'): emitted when the process could not be spawned; 'exit' may or may not follow,
  // so both paths go through ended() once.
  let done = false;
  const ended = (how) => {
    if (done) return; done = true;
    if (child === c) child = null;
    up = false; hello = null;
    for (const [, p] of pending) {
      if (p.internal === 'restart') json(p.res, 200, { restarting: !stopping, reason: 'The service stopped before it answered.' });
      else reply(p, { ok: false, error: { code: 'service_stopped', message: 'The service stopped while this was running. Check the result before trying again.' } });
    }
    pending.clear();
    broadcast({ event: 'bridge.state', data: { up: false } });
    if (stopping) return;
    console.error(`bridge: service exited (${how}), restarting in ${backoff} ms`);
    setTimeout(startService, backoff); backoff = Math.min(backoff * 2, 15000);
  };
  c.on('error', (e) => { console.error(`bridge: service process error (${e.code || e.message})`); if (c.pid === undefined) ended(`not started: ${e.code || e.message}`); });
  c.on('exit', (code, sig) => ended(code ?? sig));
  // hello first
  const id = nextId++;
  pending.set(id, { internal: true });
  write({ id, type: 'hello', params: { client: 'mortiflix-app', version: VERSION, protocol: 1 } });
}
// false = nothing to write to (service down or its input closed): the message was NOT delivered.
// stdin.write() returning false only means "buffer full, wait for drain"; the line is still queued and will be
// delivered (Node stream docs, writable.write), so that counts as sent.
const write = (o) => {
  const c = child;
  if (!c || c.exitCode !== null || !c.stdin.writable || c.stdin.destroyed) return false;
  c.stdin.write(JSON.stringify(o) + '\n');
  return true;
};

// End one service child: close its input (it finishes what it is doing, then exits), then its own pid after 3 s.
// (Never a pattern kill: any other mortiflix-service or node process is left alone.)
function endChild(c) {
  try { c.stdin.end(); } catch {}
  const t = setTimeout(() => { if (c.exitCode === null) { try { c.kill('SIGTERM'); } catch {} } }, 3000);
  c.once('exit', () => clearTimeout(t));
}
// Restart ONLY the child this bridge spawned. The exit handler starts the new one.
function restartService() {
  const c = child;
  if (!c || c.exitCode !== null) return { restarting: false, reason: 'The service is already down; the bridge is starting it again.' };
  backoff = 500; // an asked-for restart comes back at once
  console.error(`bridge: restart asked, ending service pid ${c.pid}`);
  endChild(c);
  return { restarting: true, pid: c.pid };
}
// Who may use the bridge, checked on EVERY http route and on the WebSocket upgrade:
// - the socket is local and the Host header names this machine, or (home-network access on) the socket comes from the
//   home network (192.168.x.x / 10.x.x.x) and the Host is a home-network IP. A page reached by DNS rebinding has its own
//   host name in Host and is refused; a public, VPN or tailnet address is refused in LAN mode too.
// - sameOrigin: a browser page's Origin is this server's own address (cross-site WebSocket / form posts refused).
// Home-network access: Settings' switch (config.json lan.enabled, off by default, svc/lanaccess.mjs in the service), read
// here at start and again on every settings.changed event; MFX_BRIDGE_LAN=1 (tools/serve-lan.sh) forces it on.
const LAN_ENV = process.env.MFX_BRIDGE_LAN === '1';
const savedLan = () => { try { return JSON.parse(readFileSync(join(STUDIO, 'config.json'), 'utf8'))?.lan?.enabled === true; } catch { return false; } };
let lanSaved = savedLan();
const lanOn = () => LAN_ENV || lanSaved;
const LOOP_ADDR = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const LAN_ADDR = /^(::ffff:)?(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/;
// Cross-site check (OWASP WebSocket Security Cheat Sheet: validate Origin against an allowlist on the handshake, in the
// 'upgrade' event). Browsers always send Origin on cross-site requests and a page cannot change it; the only origin
// allowed is this server's own address (the Host the request came to). No Origin header = not a browser page (curl, the
// shell, tests): allowed, the address/Host checks still apply.
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (o === undefined) return true;
  const host = req.headers.host || '';
  return o === `http://${host}` || o === `https://${host}`;
};
const allowed = (req) => {
  if (SOCKET) return sameOrigin(req); // reached only through the host, which checked the address and sign-in
  const a = req.socket?.remoteAddress || '', h = req.headers.host || '';
  const ok = (LOOP_ADDR.test(a) && LOOP_HOST.test(h)) || (lanOn() && LAN_ADDR.test(a) && LAN_HOST.test(h));
  return ok && sameOrigin(req);
};
const reply = (p, m) => { if (p.ws?.readyState === 1) p.ws.send(JSON.stringify({ ...m, id: p.id })); };

function onServiceLine(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  // the Settings switch changed: listen on the address it asks for (bind)
  if (m.event === 'settings.changed' && m.data?.lan) { lanSaved = m.data.lan.saved === true; failedHost = null; bind(); }
  if (m.event) { broadcast(m); return; }
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  if (p.internal === 'restart') { json(p.res, m.ok ? 200 : 500, m.ok ? m.result : { restarting: false, error: m.error }); return; }
  if (p.internal) {
    if (m.ok) { lanSaved = savedLan(); bind(); hello = m.result; up = true; backoff = 500; if (hello?.studio) try { studioReal = realpathSync(hello.studio); } catch {} broadcast({ event: 'bridge.state', data: { up: true, hello } }); }
    // refused hello (e.g. protocol mismatch): say why and start it again (with the growing backoff), instead of
    // keeping a child that answers nothing forever
    else { console.error(`bridge: service refused hello (${m.error?.code || ''} ${m.error?.message || ''}), restarting it`); if (child) endChild(child); }
    return;
  }
  reply(p, m);
}

// ---- http ----
function inStudio(p) {
  try {
    const real = realpathSync(resolve(p));
    return (real === studioReal || real.startsWith(studioReal + sep)) ? real : null;
  } catch { return null; }
}
const thumb = createThumbs({ inStudio, cacheDir: () => join(studioReal, 'cache', 'thumbs'), lan: lanOn, trusted: Boolean(SOCKET) });
const json = (res, code, o) => { if (res.headersSent) return; res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

// first picture of each project (Home cards): out/frames first, then design/layout
function stills() {
  const out = {}, dir = join(studioReal, 'projects');
  let ids = []; try { ids = readdirSync(dir); } catch {}
  for (const id of ids) {
    out[id] = null;
    for (const sub of ['out/frames', 'design/layout']) {
      try {
        const f = readdirSync(join(dir, id, sub)).filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && !/-t\d\./.test(n)).sort()[0];
        if (f) { out[id] = join(dir, id, sub, f); break; }
      } catch {}
    }
  }
  return out;
}

// Uploads (raw body), 4 GB cap:
//   POST /api/upload?name=<file name> -> {path, size} inside <studio>/uploads/ (New project: then assets.add)
//   POST /api/draft-upload?draft=<d-xxxxxx>&name=<file name> -> {path, size, draft} inside <studio>/drafts/<draft>/sources/
//     (New project source tray: then sources.add {draft, path, name})
const UPLOAD_MAX = 4 * 1024 ** 3;
const uploadName = (u) => (u.searchParams.get('name') || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
// RFC 9110 15.5.14: 413 Content Too Large, and the server may close the connection (the rest of the body is not read).
const tooBig = (req, res) => {
  if (res.headersSent) return req.destroy();
  res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: 'file too big' }));
  res.once('finish', () => req.destroy());
};
function receive(req, res, dir, name, extra = {}) {
  if (Number(req.headers['content-length']) > UPLOAD_MAX) return tooBig(req, res); // refused before any byte is written
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${Date.now()}-${name}`);
  const out = createWriteStream(dest);
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    req.unpipe(out); out.destroy(); out.once('close', () => rmSync(dest, { force: true })); // no partial file left
    if (code === 413) return tooBig(req, res);
    json(res, code, { error: msg });
  };
  req.on('data', (c) => { size += c.length; if (size > UPLOAD_MAX) fail(413); });
  req.on('error', () => fail(400, 'upload broke off'));
  // Node http docs: 'aborted' is deprecated, listen for 'close' and check message.complete
  req.on('close', () => { if (!req.complete) fail(400, 'upload broke off'); });
  out.on('error', (e) => fail(500, e.message));
  out.on('finish', () => { if (!failed) json(res, 200, { path: dest, size, ...extra }); });
  req.pipe(out);
}

const server = createServer((req, res) => {
  try {
    res.setHeader('x-mortiflix-bridge', '1'); // the window (main.rs bridge_up) adopts only a server that says this
    if (!allowed(req)) return json(res, 403, { error: 'not allowed from this address' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/file') {
      const real = inStudio(u.searchParams.get('path') || '');
      const type = real && MEDIA[extname(real).toLowerCase()];
      if (!real || !type || !statSync(real).isFile()) { res.writeHead(404); return res.end('not found'); }
      return sendFile(req, res, real, type, { headers: FILE_HEADERS });
    }
    if (u.pathname === '/thumb') return thumb(req, res, u);
    if (u.pathname === '/api/upload' && req.method === 'POST') return receive(req, res, join(STUDIO, 'uploads'), uploadName(u));
    if (u.pathname === '/api/draft-upload' && req.method === 'POST') {
      const draft = u.searchParams.get('draft') || '';
      if (!/^d-[a-z0-9]{6,12}$/.test(draft)) return json(res, 400, { error: 'bad draft id' });
      return receive(req, res, join(STUDIO, 'drafts', draft, 'sources'), uploadName(u), { draft });
    }
    if (u.pathname === '/api/stills') return json(res, 200, stills());
    if (u.pathname === '/api/service/restart') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end('POST only'); }
      // ?drain=1[&wait_min=N]: the service starts no new session, waits (up to N min, default 10) for the running ones,
      // then closes and this bridge starts it again; sessions still running then are picked up by the new service
      if (u.searchParams.get('drain') === '1' && up && child) {
        const id = nextId++;
        pending.set(id, { internal: 'restart', res });
        backoff = 500;
        const w = Number(u.searchParams.get('wait_min') ?? 10);
        if (!write({ id, type: 'service.restart', params: { drain: true, wait_min: Number.isFinite(w) && w >= 0 ? w : 10 } })) { pending.delete(id); return json(res, 200, restartService()); }
        return;
      }
      return json(res, 200, restartService());
    }
    if (u.pathname === '/api/status') return json(res, 200, { up, hello });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end('GET only'); }
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end('bad address'); }
    if (p === '/') { res.writeHead(302, { location: '/app/' }); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';   // /app/ = the Svelte app (ui/, built into web/app/)
    const file = normalize(join(WEB, p));
    if (!file.startsWith(WEB + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    // MDN Cache-Control: hashed build files never change under their name -> max-age=31536000, immutable
    sendFile(req, res, file, MIME[extname(file).toLowerCase()] || MEDIA[extname(file).toLowerCase()] || 'application/octet-stream', file.startsWith(ASSETS) ? { immutable: true } : undefined);
  } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(String(e.message)); }
});

const wss = new WebSocketServer({ noServer: true });
const onUpgradeError = (e) => console.error(`bridge: socket error before the live connection opened (${e.code || e.message})`);
server.on('upgrade', (req, sock, head) => {
  sock.on('error', onUpgradeError);
  if (!allowed(req) || new URL(req.url, 'http://x').pathname !== '/ws') { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => { sock.removeListener('error', onUpgradeError); wss.emit('connection', ws, req); });
});
wss.on('connection', (ws, req) => {
  ws.local = SOCKET ? req?.headers['x-morti-client'] === 'local' : LOOP_ADDR.test(req?.socket?.remoteAddress || ''); // this machine, not another device
  sockets.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => console.error(`bridge: live connection error (${e.code || e.message})`)); // ws README: every socket gets an 'error' listener
  ws.send(JSON.stringify({ event: 'bridge.state', data: { up, hello } }));
  ws.on('close', () => { sockets.delete(ws); for (const [k, p] of pending) if (p.ws === ws) pending.delete(k); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const down = () => ws.send(JSON.stringify({ id: m.id, ok: false, error: { code: 'service_down', message: 'The service is not running.' } }));
    // home-network access and the daily credit cap can only be changed on this machine: a home-network device can
    // neither open the door further nor raise what it may spend
    if (m.type === 'settings.set' && m.params && typeof m.params === 'object' && ('lan' in m.params || 'paid' in m.params) && !ws.local) {
      return ws.send(JSON.stringify({ id: m.id, ok: false, error: { code: 'local_only', message: 'Home-network access and the daily credit cap can only be changed on the computer Mortiflix Studio runs on.' } }));
    }
    // which program runs Claude (setup.backend claudeBin, any path on this machine): set only here, so a home-network
    // device cannot make the studio start a program of its choosing
    if (m.type === 'setup.backend' && !ws.local) {
      return ws.send(JSON.stringify({ id: m.id, ok: false, error: { code: 'local_only', message: 'How Claude runs can only be changed on the computer Mortiflix Studio runs on.' } }));
    }
    if (!up) return down();
    const id = nextId++;
    pending.set(id, { ws, id: m.id });
    // not delivered (the service just died): nothing ran, so this is the safe-to-retry service_down
    if (!write({ id, type: m.type, params: m.params || {} })) { pending.delete(id); down(); }
  });
});
// ws README "How to detect and close broken connections": ping every 30 s, drop a socket that did not answer the last one
// (a phone that went to sleep), so it leaves `sockets` and its pending entries.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// Listening: 127.0.0.1 only, or 0.0.0.0 when home-network access is on. A change re-listens at once (Node net docs:
// "The server.listen() method can be called again if and only if there was an error during the first server.listen()
// call or server.close() has been called"; server.close() "Stops the server from accepting new connections and keeps
// existing connections"), so connections already open are closed here by hand when access is turned off.
const conns = new Set(); // every TCP connection (upgraded live connections included)
server.on('connection', (s) => { conns.add(s); s.once('close', () => conns.delete(s)); });
let boundHost = null, binding = null, started = false, retry = 1000, failedHost = null;
// access turned off: every home-network connection ends now (the address checks refuse its next request anyway)
function dropLan() {
  for (const ws of wss.clients) if (!ws.local) ws.terminate();
  for (const s of conns) if (!LOOP_ADDR.test(s.remoteAddress || '')) s.destroy();
}
function bind() {
  if (SOCKET) {
    if (started || binding !== null) return; // one socket file; the home-network switch does not apply
    binding = SOCKET;
    try { unlinkSync(SOCKET); } catch {} // a file left by a bridge that did not exit cleanly
    server.listen(SOCKET, () => { try { chmodSync(SOCKET, 0o600); } catch {} });
    return;
  }
  const host = lanOn() ? '0.0.0.0' : '127.0.0.1';
  if (binding !== null || (server.listening && boundHost === host)) return; // one listen at a time; 'listening' looks again
  if (host === failedHost && server.listening) return; // that address failed: stay on the working one until the setting changes
  binding = host;
  if (host === '127.0.0.1') dropLan();
  if (server.listening) server.close();
  server.listen(PORT, host);
}
server.on('listening', () => {
  boundHost = binding; binding = null; retry = 1000;
  console.error(SOCKET ? `bridge: socket ${SOCKET}` : `bridge: http://${boundHost}:${PORT}/`);
  // the service starts once the port is ours, so a failed first listen leaves no service behind
  if (!started) { started = true; startService(); }
  bind(); // the setting changed again while this listen was on its way
});
// Node net docs: EADDRINUSE is the common listen error. The window only starts a bridge when nothing answers on the
// port, so another program holds it: say so plainly (the window shows the last log line) and exit. A re-listen after a
// Settings change that fails tries again (Node net docs' EADDRINUSE example: retry after a while), never exits.
server.on('error', (e) => {
  if (binding === null) { console.error(`bridge: server error (${e.code || e.message})`); return; }
  const host = binding; binding = null;
  if (started) {
    // back on the address that worked, so this machine's window keeps the studio; the switch is tried again when it changes
    if (boundHost && boundHost !== host && !server.listening) {
      failedHost = host;
      console.error(`bridge: cannot listen on ${host}:${PORT} (${e.code || e.message}): staying on ${boundHost}`);
      binding = boundHost; server.listen(PORT, boundHost);
      return;
    }
    console.error(`bridge: cannot listen on ${host}:${PORT} (${e.code || e.message}), trying again in ${retry / 1000} s`);
    setTimeout(bind, retry); retry = Math.min(retry * 2, 15000);
    return;
  }
  console.error(e.code === 'EADDRINUSE' ? `bridge: port ${PORT} is already in use (another program, or a Mortiflix Studio bridge from an older version: quit it, then start again)` : `bridge: cannot listen on port ${PORT} (${e.code || e.message})`);
  process.exit(1);
});
bind();
// Stop: close the service's input (it finishes the request it is on, then exits by itself), then exit.
// SIGHUP too (Node docs: its default action terminates without this handler, e.g. a closed terminal).
const stop = () => { if (stopping) return; stopping = true; clearInterval(heartbeat); try { child?.stdin.end(); } catch {} setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
