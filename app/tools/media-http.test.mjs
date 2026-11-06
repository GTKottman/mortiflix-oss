// node tools/media-http.test.mjs : handler tests with fake req/res (no port is opened, nothing shared is touched).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sendFile, createThumbs } from './media-http.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mfx-media-')));
mkdirSync(join(root, 'f'));
const big = join(root, 'f', 'sf01-opening.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', big]);
const versioned = join(root, 'f', 'lf03-v3.png');
writeFileSync(versioned, readFileBytes(big));
function readFileBytes(f) { return execFileSync('cat', [f], { maxBuffer: 1 << 28 }); }
const wav = join(root, 'f', 'a.wav'); writeFileSync(wav, Buffer.alloc(1000, 7));

class Res extends Writable {
  constructor() { super(); this.code = 0; this.h = {}; this.chunks = []; this.finished = new Promise((ok) => this.once('finish', ok)); }
  writeHead(c, h = {}) { this.code = c; this.h = h; }
  _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb(); }
}
const fake = (headers = {}, method = 'GET') => ({ req: { headers: { host: '127.0.0.1:4646', ...headers }, method }, res: new Res() });
const get = async (file, type, headers, method) => { const { req, res } = fake(headers, method); sendFile(req, res, file, type); await res.finished; return res; };
const body = (res) => Buffer.concat(res.chunks);

// ---- /file caching
let r = await get(big, 'image/png', {});
assert.equal(r.code, 200); assert.ok(r.h.etag && r.h['last-modified']); assert.equal(r.h['cache-control'], 'no-cache');
const etag = r.h.etag, lm = r.h['last-modified'];
r = await get(big, 'image/png', { 'if-none-match': etag }); assert.equal(r.code, 304); assert.equal(body(r).length, 0);
r = await get(big, 'image/png', { 'if-none-match': 'W/"x"' }); assert.equal(r.code, 200);
r = await get(big, 'image/png', { 'if-modified-since': lm }); assert.equal(r.code, 304);
r = await get(versioned, 'image/png', {}); assert.match(r.h['cache-control'], /immutable/);
r = await get(wav, 'audio/wav', { range: 'bytes=10-19' }); assert.equal(r.code, 206); assert.equal(r.h['content-range'], 'bytes 10-19/1000'); assert.equal(body(r).length, 10);
r = await get(wav, 'audio/wav', { range: 'bytes=-5' }); assert.equal(r.code, 206); assert.equal(body(r).length, 5);
r = await get(wav, 'audio/wav', { range: 'bytes=2000-' }); assert.equal(r.code, 416);
r = await get(wav, 'audio/wav', { range: 'bytes=10-19', 'if-range': 'W/"stale"' }); assert.equal(r.code, 200); assert.equal(body(r).length, 1000);
console.log('file: ok');

// ---- /thumb
const inStudio = (p) => { try { const real = realpathSync(resolve(p)); return real === root || real.startsWith(root + sep) ? real : null; } catch { return null; } };
let calls = 0;
const cacheDir = join(root, 'cache', 'thumbs');
const run1 = (bin, args) => { calls++; execFileSync(bin, args); return Promise.resolve(); };
const thumb = createThumbs({ inStudio, cacheDir, run: run1 });
const call = async (q, headers = {}) => { const { req, res } = fake(headers); await thumb(req, res, new URL('http://x/thumb?' + q)); await res.finished; return res; };
r = await call(`path=${encodeURIComponent(big)}&w=480`);
assert.equal(r.code, 200); assert.equal(r.h['content-type'], 'image/webp');
const small = body(r).length, orig = statSync(big).size;
console.log(`orig ${orig} B -> thumb ${small} B`);
assert.ok(small < 60 * 1024 && small < orig / 5);
assert.equal(calls, 1);
// cached: no second ffmpeg; 304 on revalidate
const r2 = await call(`path=${encodeURIComponent(big)}&w=480`, { 'if-none-match': r.h.etag }); assert.equal(r2.code, 304); assert.equal(calls, 1);
// another width = another file; a new mtime = a new file
await call(`path=${encodeURIComponent(big)}&w=240`); assert.equal(calls, 2);
const t = new Date(Date.now() + 5000); utimesSync(big, t, t);
await call(`path=${encodeURIComponent(big)}&w=480`); assert.equal(calls, 3);
assert.equal(readdirSync(cacheDir).filter((n) => n.endsWith('.webp')).length, 3);
// concurrent identical requests share one job
const [a, b] = await Promise.all([call(`path=${encodeURIComponent(versioned)}&w=300`), call(`path=${encodeURIComponent(versioned)}&w=300`)]);
assert.equal(a.code, 200); assert.equal(b.code, 200); assert.equal(calls, 4);
// refused: outside the studio, not an image, bad host, missing
assert.equal((await call(`path=${encodeURIComponent('/etc/passwd')}`)).code, 404);
assert.equal((await call(`path=${encodeURIComponent(wav)}`)).code, 404);
assert.equal((await call(`path=${encodeURIComponent(join(root, '..', 'x.png'))}`)).code, 404);
assert.equal((await call(`path=${encodeURIComponent(big)}`, { host: 'evil.example' })).code, 403);
assert.equal(calls, 4);
console.log('thumb: ok');
