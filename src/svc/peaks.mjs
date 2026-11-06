// audio.peaks {path, buckets?}: a waveform for the app's lanes. ffmpeg decodes the file to mono 8 kHz signed 16-bit PCM on
// stdout; each bucket keeps its largest absolute sample (0..1). The file must lie inside the studio folder (symlinks
// resolved). Results are cached as json in <studio>/state/cache/peaks, keyed by path + mtime + size + buckets.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isInside } from '../studio.mjs';

export const PEAK_RATE = 8000;
export const DEFAULT_BUCKETS = 400;
export const MAX_BUCKETS = 4000;

// The file as a real path inside the studio, or an Error with a plain message.
export function studioFile(root, p) {
  const raw = String(p ?? '').trim();
  if (!raw) throw new Error('audio.peaks needs a path');
  let real;
  try { real = realpathSync(isAbsolute(raw) ? raw : resolve(root, raw)); } catch { throw new Error('that file does not exist'); }
  let top;
  try { top = realpathSync(root); } catch { top = resolve(root); }
  if (!isInside(top, real)) throw new Error('audio must be a file inside the studio');
  if (!statSync(real).isFile()) throw new Error('that is not a file');
  return real;
}

// Max |sample| per bucket from s16le PCM; the buckets split the whole file evenly.
export function bucketPeaks(pcm, buckets) {
  const n = Math.floor(pcm.length / 2);
  const out = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    let m = 0;
    for (let i = from; i < to && i < n; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > m) m = v; }
    out[b] = Math.round((Math.min(m, 32767) / 32767) * 10000) / 10000;
  }
  return out;
}

function decode(file, { timeoutMs = 120_000 } = {}) {
  return new Promise((ok, fail) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', () => { clearTimeout(timer); fail(new Error('ffmpeg is not installed')); });
    c.on('close', (code) => { clearTimeout(timer); code === 0 ? ok(Buffer.concat(chunks)) : fail(new Error(`could not read that audio${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}`)); });
  });
}

export async function audioPeaks(root, p) {
  const file = studioFile(root, p?.path);
  const asked = p?.buckets === undefined || p?.buckets === null ? DEFAULT_BUCKETS : Number(p.buckets);
  if (!Number.isFinite(asked) || asked < 1) throw new Error('buckets must be a number from 1 to 4000');
  const buckets = Math.min(MAX_BUCKETS, Math.floor(asked));
  const st = statSync(file);
  const dir = join(root, 'state', 'cache', 'peaks');
  const key = createHash('sha1').update(`${file}\0${st.mtimeMs}\0${st.size}\0${buckets}`).digest('hex');
  const cache = join(dir, `${key}.json`);
  if (existsSync(cache)) { try { return { ...JSON.parse(readFileSync(cache, 'utf8')), cached: true }; } catch { /* rebuilt below */ } }
  const pcm = await decode(file);
  const result = { peaks: bucketPeaks(pcm, buckets), duration_s: Math.round((pcm.length / 2 / PEAK_RATE) * 1000) / 1000 };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${cache}.${process.pid}.tmp`, JSON.stringify(result));
  try { renameSync(`${cache}.${process.pid}.tmp`, cache); } catch { /* cache is optional */ }
  return { ...result, cached: false };
}
