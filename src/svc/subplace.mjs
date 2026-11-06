// Where each subtitle goes so it never covers the picture's own words (run 3: "Picture two hands on a sheet of paper."
// was burned in right over the shot's credit "After Drawing Hands (M. C. Escher, 1948) / our own drawing of the idea").
//
// The shots' video is read once per media file (named by its content, so the result is cached for good): two frames a
// second, small and grey, and for each the bright "ink" (text, lines) in four bands where a subtitle can sit: the two
// bottom lines (the caption track's default place) and the two top lines. A subtitle whose bottom box meets ink during
// its time moves to the top when the top is clearer there (WebVTT `line:` cue setting, which the burn-in honours).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';

const W = 480; const H = 270; // the scan's frame (a quarter of 1080p)
const FPS = 2;
const CX = 10; const CY = 5; const NX = W / CX; const NY = Math.ceil(H / CY); // ink is counted in 10×5 cells
// The subtitles' style (SUB_STYLE) at 1080 lines: 38 px text, 1.25 line height, a 0.8 % bottom margin, a box per line.
const LINE = (38 * 1.25) / 4; const MARGIN = (0.008 * 1080) / 4;
const CHAR_PX = 19 / 4; const PAD_PX = 12 / 4; // Inter at 38 px: about 19 px a character
const INK = 50; // brighter than the frame's typical (median) grey by this much = ink
// Where a subtitle may sit, best first: the bottom edge, the top edge (both outside the picture's 5 % text-safe margin),
// then places inside the picture. `line` is the WebVTT cue setting (% from the top), null = the track's own place.
export const PLACES = [{ line: null }, { line: 1 }, { line: 11 }, { line: 70 }, { line: 56 }, { line: 24 }, { line: 40 }];

function scanFile(path, ffmpeg) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', path, '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const frames = [];
    let buf = Buffer.alloc(0);
    let err = '';
    const one = (f) => {
      const hist = new Uint32Array(256);
      for (let i = 0; i < f.length; i += 7) hist[f[i]]++;
      let n = 0; let med = 0; const half = Math.floor(f.length / 7 / 2);
      for (; med < 256; med++) { n += hist[med]; if (n >= half) break; }
      const limit = Math.min(250, med + INK);
      const cells = Buffer.alloc(NX * NY);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (f[y * W + x] > limit) { const c = Math.floor(y / CY) * NX + Math.floor(x / CX); if (cells[c] < 255) cells[c]++; }
      frames.push(cells.toString('base64'));
    };
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= W * H) { one(buf.subarray(0, W * H)); buf = buf.subarray(W * H); }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(frames) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`))));
  });
}

async function scanOf(dir, path, ffmpeg) {
  const f = join(dir, `${basename(path)}.cells.json`);
  let scan = null;
  if (existsSync(f)) { try { scan = JSON.parse(readFileSync(f, 'utf8')); } catch { /* scan again */ } }
  if (!scan) {
    scan = { fps: FPS, nx: NX, ny: NY, frames: await scanFile(path, ffmpeg) };
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${f}.tmp`, JSON.stringify(scan));
    renameSync(`${f}.tmp`, f);
  }
  return { fps: scan.fps, frames: scan.frames.map((b) => Buffer.from(b, 'base64')) };
}

// The box a subtitle's text takes at a place, in scan pixels: [x0, y0, x1, y1].
export function boxAt(text, place) {
  const lines = String(text).split('\n');
  const chars = Math.max(...lines.map((l) => l.length));
  const half = (chars * CHAR_PX) / 2 + PAD_PX;
  const h = LINE * lines.length;
  const top = place.line === null ? H - MARGIN - h : Math.min(H - h, (place.line / 100) * H);
  return [W / 2 - half, top, W / 2 + half, top + h];
}

// The most ink a subtitle box covers at a place while it shows (film time).
function inkUnder(scans, shots, cap, place) {
  const [bx0, by0, bx1, by1] = boxAt(cap.text, place);
  const [x0, x1] = [Math.max(0, Math.floor(bx0 / CX)), Math.min(NX - 1, Math.floor((bx1 - 0.01) / CX))];
  const [y0, y1] = [Math.max(0, Math.floor(by0 / CY)), Math.min(NY - 1, Math.floor((by1 - 0.01) / CY))];
  let worst = 0;
  for (let t = cap.start_sec; t < cap.end_sec; t += 1 / FPS) {
    const s = shots.find((x) => t >= x.start_sec && t < x.start_sec + x.dur_sec);
    const scan = s && s.media?.path && scans.get(s.media.path);
    if (!scan) continue;
    const i = Math.round(((s.media.from_sec ?? 0) + (t - s.start_sec)) * scan.fps);
    const f = scan.frames[Math.min(scan.frames.length - 1, Math.max(0, i))];
    if (!f) continue;
    let ink = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink += f[y * NX + x];
    worst = Math.max(worst, ink);
  }
  return worst;
}

// Words in the picture under a box at film time t: the frame's crop read by tesseract (light words on the dark look,
// so the crop is inverted and doubled). null when it can't be read (no tesseract): then any ink counts as words.
function wordsAt(shots, box, t, { ffmpeg, tesseract, seen }) {
  const s = shots.find((x) => t >= x.start_sec && t < x.start_sec + x.dur_sec);
  if (!s?.media?.path) return Promise.resolve(false);
  const at = Math.max(0, (s.media.from_sec ?? 0) + (t - s.start_sec));
  const k = 1080 / H;
  const [x0, y0, x1, y1] = box.map((v) => Math.round(v * k));
  // the whole width of the band round the box, so a word the box only half covers is still read whole; then only
  // the words whose own boxes meet the subtitle's (a little larger) count
  const cy = Math.max(0, y0 - 40); const ch = Math.min(1080 - cy, y1 - y0 + 80);
  const crop = `crop=1920:${ch}:0:${cy}`;
  const hit = (l, t, w, h) => { const [a, b, c, d] = [l / 2, cy + t / 2, (l + w) / 2, cy + (t + h) / 2]; return c > x0 - 12 && a < x1 + 12 && d > y0 - 10 && b < y1 + 10; };
  // read once per file, moment and box (the media files are named by their content)
  const key = `${basename(s.media.path)}|${at.toFixed(3)}|${crop}`;
  if (seen && key in seen) return Promise.resolve(seen[key]);
  return new Promise((resolve0) => {
    const resolve = (v) => { if (seen && v !== null) seen[key] = v; resolve0(v); };
    const ff = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-ss', at.toFixed(3), '-i', s.media.path, '-frames:v', '1', '-vf', `${crop},format=gray,negate,scale=iw*2:ih*2`, '-f', 'image2pipe', '-vcodec', 'png', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ts = spawn(tesseract, ['stdin', 'stdout', '--psm', '6', 'tsv'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    ff.stdout.pipe(ts.stdin);
    ts.stdin.on('error', () => {});
    ts.stdout.on('data', (d) => { out += d; });
    ts.on('error', () => resolve(null));
    ff.on('error', () => resolve(null));
    ts.on('close', (code) => {
      if (code !== 0) return resolve(null);
      // a word, a number, an equation piece ("2", "--p--q", "=", "∀a:") read with some confidence
      const words = out.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c.length >= 12 && Number(c[10]) >= 50 && /[A-Za-z0-9=+→∀∃]/.test(c[11] || '') && hit(...c.slice(6, 10).map(Number)));
      resolve(words.length);
    });
  });
}

// How many words are under the box while the subtitle shows (the most at three moments)? null: can't tell.
async function wordsUnder(shots, cap, place, tools) {
  const box = boxAt(cap.text, place);
  const d = cap.end_sec - cap.start_sec;
  let most = 0;
  for (const t of [cap.start_sec + Math.min(0.3, d / 4), cap.start_sec + d / 2, cap.end_sec - Math.min(0.3, d / 4)]) {
    const r = await wordsAt(shots, box, t, tools);
    if (r === null) return null;
    most = Math.max(most, Number(r) || 0);
  }
  return most;
}

// Puts each subtitle where it covers none of the picture's own words: its usual place when nothing is under it (the
// ink scan) or what is under it isn't words (a drawing: tesseract finds none), else the first other place that is
// clear the same way, else where it covers least. A place other than the bottom goes in the caption's `settings`
// (WebVTT `line:N%`). Returns { moved, clashes, read } (clashes: words under every place; read: false without OCR).
export async function placeSubtitles({ captions, shots, cacheDir, ffmpeg = 'ffmpeg', tesseract = 'tesseract', min = 3, jobs = 4 }) {
  const scans = new Map();
  for (const path of new Set(shots.filter((s) => s.media?.kind === 'video' && s.media.path && existsSync(s.media.path)).map((s) => s.media.path))) {
    try { scans.set(path, await scanOf(cacheDir, path, ffmpeg)); } catch { /* not readable: left as it is */ }
  }
  const seenFile = join(cacheDir, 'words.json');
  let seen = {};
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')); } catch { /* none yet */ }
  const tools = { ffmpeg, tesseract, seen };
  let moved = 0; let clashes = 0; let read = true;
  const one = async (c) => {
    let best = null;
    for (const place of PLACES) {
      const ink = inkUnder(scans, shots, c, place);
      let clear = ink < min;
      let words = 0;
      if (!clear) {
        words = await wordsUnder(shots, c, place, tools);
        if (words === null) read = false;
        clear = words === 0;
      }
      // fewest words first, then least ink (without OCR, ink alone)
      const score = clear ? 0 : (words ?? 0) * 100000 + ink;
      if (!best || score < best.score) best = { place, score };
      if (clear) break;
    }
    if (best.score > 0) { clashes++; c.clash = true; }
    if (best.place.line !== null) { c.settings = `line:${best.place.line}%`; moved++; }
  };
  const queue = [...captions];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => { while (queue.length) await one(queue.shift()); }));
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(seenFile, JSON.stringify(seen)); } catch { /* read again next time */ }
  return { moved, clashes, read };
}
