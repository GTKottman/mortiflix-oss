// Media over HTTP for the bridge: caching (ETag, Last-Modified, 304, Range kept) and small cached thumbnails.
// Kept apart from bridge.mjs so tests can call the handlers with fake req/res, without listening on a port.
import { pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.mkv']);
// Host header names this machine (loopback), or with home-network access on a home-network IP. One copy: bridge.mjs uses these too.
// A page reached by DNS rebinding carries its own host name here and is refused (vite.dev server.allowedHosts: explicit list).
export const LOOP_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
export const LAN_HOST = /^(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;
const hostOk = (h, lan) => LOOP_HOST.test(h) || (lan() && LAN_HOST.test(h));
const lanEnv = () => process.env.MFX_BRIDGE_LAN === '1';
// Frames and takes get a new file name every time (lf03-v3.png, lf03-t2.png): they never change under that name.
const VERSIONED = /-(?:v|t)\d+\.[A-Za-z0-9]+$/;
const MAX_JOBS = 3;

export const etagOf = (st) => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

/** Send a file with cache validators, 304s and byte ranges. */
export function sendFile(req, res, file, type, { st = statSync(file), immutable = VERSIONED.test(file), headers = {} } = {}) {
  const etag = etagOf(st);
  const last = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  const h = {
    'content-type': type, 'accept-ranges': 'bytes', etag, 'last-modified': last,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...headers,
  };
  const inm = req.headers['if-none-match'];
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  const fresh = inm ? inm.split(',').some((t) => { const x = t.trim(); return x === '*' || x === etag || x.replace(/^W\//, '') === etag.replace(/^W\//, ''); })
    : Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims;
  if (fresh && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(304, h); return res.end(); }
  // If-Range: a stale validator means the whole file, not a piece of a different one
  const ir = req.headers['if-range'];
  const rangeOk = !ir || ir === etag || ir === last;
  const r = rangeOk ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '') : null;
  if (r && st.size && (r[1] !== '' || r[2] !== '')) {
    const a = r[1] === '' ? Math.max(0, st.size - Number(r[2])) : Number(r[1]);
    const b = r[1] === '' || r[2] === '' ? st.size - 1 : Math.min(Number(r[2]), st.size - 1);
    if (a > b || a >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(file, { start: a, end: b }), res, () => {});
  }
  res.writeHead(200, { ...h, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  pipeline(createReadStream(file), res, () => {}); // a file that vanishes or a closed client ends the response; it must not crash the bridge
}

/** Thumbnails: `thumb(req, res, u)` serves /thumb?path=&w=. Cache: <cacheDir>/<sha1(path+mtime+w)>.webp.
 *  `lan`: () => whether home-network access is on now (the bridge's Settings switch); default MFX_BRIDGE_LAN=1. */
// `trusted`: the caller already checked who is asking (the bridge on a socket file, behind Morti Drive).
export function createThumbs({ inStudio, cacheDir: cacheDirOf, ffmpeg = 'ffmpeg', run = runFfmpeg, lan = lanEnv, trusted = false }) {
  const cacheDir = typeof cacheDirOf === 'function' ? cacheDirOf : () => cacheDirOf;
  const inflight = new Map(); // cache file -> promise
  let active = 0;
  const waiting = [];
  const slot = () => (active < MAX_JOBS ? (active++, Promise.resolve()) : new Promise((ok) => waiting.push(ok)));
  const free = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function make(src, out, w, video) {
    await slot();
    try {
      mkdirSync(dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.${Date.now()}.tmp.webp`;
      const vf = `scale='min(${w},iw)':-2`; // never enlarge
      const a = ['-v', 'error', '-y', ...(video ? ['-ss', '0.5'] : []), '-i', src, '-frames:v', '1', '-vf', vf, '-c:v', 'libwebp', '-quality', '72', tmp];
      try { await run(ffmpeg, a); renameSync(tmp, out); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    } finally { free(); }
  }

  return async function thumb(req, res, u) {
    const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };
    if (!trusted && !hostOk(req.headers.host || '', lan)) return fail(403, 'loopback only');
    const real = inStudio(u.searchParams.get('path') || '');
    const ext = real ? extname(real).toLowerCase() : '';
    let st; try { st = real && statSync(real); } catch { st = null; }
    if (!real || !st?.isFile() || !(IMAGE.has(ext) || VIDEO.has(ext))) return fail(404, 'not found');
    const w = Math.min(1280, Math.max(32, Math.round(Number(u.searchParams.get('w')) || 480)));
    const key = createHash('sha1').update(`${real}\0${Math.floor(st.mtimeMs)}\0${w}`).digest('hex');
    const out = join(cacheDir(), `${key}.webp`);
    let ost = null; try { ost = statSync(out); } catch {}
    if (!ost) {
      let job = inflight.get(out);
      if (!job) { job = make(real, out, w, VIDEO.has(ext)).finally(() => inflight.delete(out)); inflight.set(out, job); }
      try { await job; ost = statSync(out); } catch { return fail(502, 'thumbnail failed'); }
    }
    // keyed by path+mtime+w in the cache, but the URL is not: revalidate (a 304 is a stat), never `immutable`
    return sendFile(req, res, out, 'image/webp', { st: ost, immutable: false });
  };
}

function runFfmpeg(bin, args) {
  return new Promise((ok, no) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('error', (e) => { clearTimeout(t); no(e); });
    p.on('close', (c) => { clearTimeout(t); c === 0 ? ok() : no(new Error(err || `ffmpeg ${c}`)); });
  });
}
