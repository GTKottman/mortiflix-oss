// The DAW render and its cache (doc 24 §1, §2). A render's key is the sha256 of the song without its rev, the blobs and
// audio files it points to, render.json and the engine's --version: asking for the same render again returns
// out/music/renders/<key12>/ at once, without running the engine (the AI checks its own edits over and over, doc 26).
// The engine runs through the studio's render queue, one heavy render at a time, like `mfx render`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths } from './projects.mjs';
import { songPaths } from './song-store.mjs';
import { readSong, writeSong } from './song.mjs';
import { enginePaths } from './daw-engine.mjs';

// What every render uses unless asked otherwise (doc 24 §1: 48 kHz, 32-bit float; the engine's own defaults match).
export const RENDER_DEFAULTS = { rate: 48000, blockSize: 512, threads: 8 };

const sha = (data) => createHash('sha256').update(data).digest('hex');

// The engine's --version line, read once per binary (and again when the file changes).
const versions = new Map();
export function engineVersion(bin) {
  const m = statSync(bin).mtimeMs;
  const hit = versions.get(bin);
  if (hit?.m === m) return hit.v;
  const v = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop();
  versions.set(bin, { m, v });
  return v;
}

export function renderKey({ song, work, settings, engine }) {
  const music = join(work, 'music');
  const { rev, ...rest } = song;
  const h = createHash('sha256');
  h.update(writeSong({ ...rest, rev: 0 }));
  const blobs = new Set();
  JSON.stringify(song, (k, v) => { if (k === 'blob' && typeof v === 'string') blobs.add(v); return v; });
  for (const b of [...blobs].sort()) h.update(`\nblob ${b} ${sha(readFileSync(join(music, 'daw', 'blobs', `${b}.bin`)))}`);
  for (const a of [...(song.audio || [])].sort((x, y) => String(x.file).localeCompare(String(y.file)))) {
    const f = join(work, a.file);
    h.update(`\naudio ${a.file} ${existsSync(f) ? sha(readFileSync(f)) : 'missing'}`);
  }
  h.update(`\nrender ${JSON.stringify(Object.fromEntries(Object.entries({ ...RENDER_DEFAULTS, ...settings }).sort()))}`);
  h.update(`\nengine ${engine}`);
  return h.digest('hex');
}

export const rendersDir = (root, id) => join(projectPaths(root, id).work, 'out', 'music', 'renders');

const finished = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'render-report.json'), 'utf8')).ok === true && existsSync(join(dir, 'mix-f32.wav')); } catch { return false; }
};

// Renders the project's song (or returns the cached render). Resolves with { key, dir, cached, report } once the file
// is there; a failed render throws with the engine's last output. `queue` is the studio's RenderQueue.
export async function renderProjectSong(root, id, { queue, settings = {}, sessionId = null, bin = process.env.MFX_DAW_ENGINE || enginePaths(root).bin, waitSeconds = 590 } = {}) {
  if (!existsSync(bin)) throw new Error('the sound engine is not installed (mortiflix setup daw-engine)');
  const sp = songPaths(root, id);
  if (!existsSync(sp.song)) throw new Error('this project has no song yet');
  const song = readSong(readFileSync(sp.song, 'utf8'));
  const all = { ...RENDER_DEFAULTS, ...settings };
  const key = renderKey({ song, work: projectPaths(root, id).work, settings: all, engine: engineVersion(bin) });
  const dir = join(rendersDir(root, id), key.slice(0, 12));
  const report = () => JSON.parse(readFileSync(join(dir, 'render-report.json'), 'utf8'));
  if (finished(dir)) return { key, dir, cached: true, report: report() };

  // The engine renders a copy of the song into a work folder; only a finished render is moved to its key's folder, so
  // a half-written one is never served from the cache.
  const work = `${dir}.part-${process.pid}-${Date.now()}`;
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'song.json'), writeSong(song));
  writeFileSync(join(work, 'render.json'), JSON.stringify(all, null, 2) + '\n');
  const job = queue.add({ projectId: id, sessionId, label: `music render ${key.slice(0, 12)}`, cwd: work, env: process.env,
    argv: [bin, '--render', join(work, 'song.json'), '--settings', join(work, 'render.json'), '--out', work] });
  let v = await queue.wait(job.id, id, waitSeconds);
  while (!['done', 'failed'].includes(v.state)) v = await queue.wait(job.id, id, waitSeconds);
  if (v.state !== 'done' || !finished(work)) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`the render failed (exit ${v.exit_code}): ${String(v.output_tail || '').trim().split('\n').slice(-3).join(' / ')}`);
  }
  if (finished(dir)) rmSync(work, { recursive: true, force: true });   // another render of the same key got there first
  else { rmSync(dir, { recursive: true, force: true }); renameSync(work, dir); }
  return { key, dir, cached: false, report: report() };
}
