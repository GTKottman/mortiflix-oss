// First-run setup, the part the app's Setup window adds to part 08's setup.* / keys.* (src/svc/setup.mjs): downloads
// and installs the user said yes to, with progress. `setup.download` fetches files the app lists
// (no local AI model catalogues since 2026-11-01) with their size and SHA-256 checked; `setup.install` installs one of
// setup.mjs's components (TOOLS: Chrome, Strudel, transitions, Blender + toolkits, uv tools, sound engine); `setup.cancel` stops either. Each runs as a job: the reply is {job}, then `setup.progress` events
// {job, kind, label, state: running|done|failed|cancelled, line, done?, total?}. Nothing downloads on its own.
//
// MFX_FAKE_DOWNLOADS=1 (tests): `fake:<bytes>` URLs make that many zero bytes, slowly, and the Chrome install only
// pretends. Without it a fake: URL is refused.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, saveConfig, isInside } from './studio.mjs';
import { installTool, toolsDir, TOOLS, TOOL_INFO } from './setup.mjs';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 8 * 1024 ** 3;
const fake = () => process.env.MFX_FAKE_DOWNLOADS === '1';

export function setupHandlers({ root, emit, ProtocolError }) {
  const bad = (m) => new ProtocolError('bad_request', m);
  const jobs = new Map(); // job id -> { cancel: AbortController }
  let nextJob = 1;
  // A background job: progress goes out as setup.progress events, the reply only says it started.
  const startJob = (kind, label, work) => {
    const job = nextJob++;
    const ctl = new AbortController();
    jobs.set(job, ctl);
    const progress = (data) => emit('setup.progress', { job, kind, label, ...data });
    progress({ state: 'running', line: `Starting: ${label}` });
    Promise.resolve()
      .then(() => work({ progress, signal: ctl.signal }))
      .then((r) => progress(r && typeof r === 'object' ? { line: 'Done', ...r, state: r.ok === false ? 'failed' : 'done' } : { state: 'done', line: r || 'Done' }))
      .catch((e) => progress({ state: ctl.signal.aborted ? 'cancelled' : 'failed', line: ctl.signal.aborted ? 'Cancelled' : String(e?.message || e).slice(0, 500) }))
      .finally(() => jobs.delete(job));
    return { job };
  };

  return {
    // Download files the user said yes to: each streams into <dest>.part, its size and SHA-256 are checked, then it is
    // renamed into place. Files already there with the right size are skipped.
    'setup.download': (p) => {
      const files = Array.isArray(p?.files) ? p.files : null;
      if (!files || !files.length || files.length > MAX_FILES) throw bad(`files: 1-${MAX_FILES} of {url, dest, size, sha256}`);
      const list = files.map((f) => checkFile(f, bad, root));
      const label = String(p?.label || 'Download').slice(0, 120);
      return startJob('download', label, ({ progress, signal }) => downloadFiles(list, { progress, signal }));
    },
    // Install a component the user said yes to (or skipped at install time), with setup.mjs's own installers: one
    // install logic for the installers, `mortiflix setup` and this window.
    'setup.install': (p) => {
      const tool = String(p?.tool || '');
      if (!TOOLS.includes(tool)) throw bad(`tool: ${TOOLS.join(', ')}`);
      const label = TOOL_INFO[tool]?.name || tool;
      return startJob('install', label, async ({ progress, signal }) => {
        if (fake()) return fakeInstall(root, tool, { progress, signal });
        // the sound engine has no release downloads yet: it builds from the pinned source (asked first, it says so)
        const st = await installTool(root, tool, { build: tool === 'daw-engine', signal, log: (line) => progress({ state: 'running', line: String(line).slice(0, 300) }) });
        return st?.detail ? `Installed: ${st.detail}` : 'Installed';
      });
    },
    'setup.cancel': (p) => {
      const ctl = jobs.get(Number(p?.job));
      if (ctl) ctl.abort();
      return { cancelled: Boolean(ctl) };
    },
  };
}

// ---- tools ----

async function fakeInstall(root, tool, { progress, signal }) {
  for (let i = 1; i <= 5; i++) {
    if (signal.aborted) throw new Error('cancelled');
    await new Promise((r) => setTimeout(r, 150));
    progress({ state: 'running', line: `fake ${tool}: step ${i} of 5`, done: i, total: 5 });
  }
  if (tool !== 'chrome') return `Installed (fake): ${tool}`;
  const file = join(toolsDir(root), 'browsers', 'fake-chrome', process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  const tools = { ...(loadConfig(root).tools || {}), chrome: file };
  saveConfig(root, { tools });
  return `Installed (fake): ${file}`;
}

// ---- downloads ----

// dest must be inside the studio folder: a caller that names the URL, the hash and the place could otherwise overwrite
// any file this user can write.
function checkFile(f, bad, root) {
  if (!f || typeof f !== 'object') throw bad('each file is {url, dest, size, sha256}');
  const url = String(f.url || '');
  const dest = String(f.dest || '');
  const size = Number(f.size);
  const sha256 = String(f.sha256 || '').toLowerCase();
  if (url.startsWith('fake:')) {
    if (!fake()) throw bad('fake: downloads are for tests (MFX_FAKE_DOWNLOADS=1)');
  } else if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 2000) throw bad('downloads are https only');
  if (!isAbsolute(dest) || normalize(dest) !== dest || dest.split(/[\\/]/).includes('..') || dest.length > 4096) throw bad('dest is an absolute, normal path');
  // compared as the real paths (symlinks followed), so a link inside the studio can't point the file elsewhere
  const studio = realPath(resolve(root));
  const where = realPath(dest);
  if (where === studio || !isInside(studio, where)) throw bad('dest is inside the studio folder');
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw bad('size is the file\'s byte count');
  if (!url.startsWith('fake:') && !/^[0-9a-f]{64}$/.test(sha256)) throw bad('sha256 is 64 hex digits');
  return { url, dest, size, sha256 };
}

// The real path of p, also for a file that doesn't exist yet: its nearest existing folder's real path + the rest.
function realPath(p) {
  const rest = [];
  let q = p;
  while (!existsSync(q) && dirname(q) !== q) { rest.unshift(basename(q)); q = dirname(q); }
  try { return join(realpathSync(q), ...rest); } catch { return p; }
}

const present = (f) => { try { return statSync(f.dest).size === f.size; } catch { return false; } };

async function body(url, signal) {
  if (url.startsWith('fake:')) {
    const n = Number(url.slice(5)) || 0;
    // Zero bytes in 16 KB pieces, a little slowly, so the progress bar can be seen.
    return Readable.from((async function* gen() {
      for (let sent = 0; sent < n; sent += 16384) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 15));
        yield Buffer.alloc(Math.min(16384, n - sent));
      }
    })());
  }
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${new URL(url).host}`);
  return Readable.fromWeb(res.body);
}

export async function downloadFiles(files, { progress = () => {}, signal = new AbortController().signal } = {}) {
  const todo = files.filter((f) => !present(f));
  const total = todo.reduce((a, f) => a + f.size, 0);
  let done = 0;
  let last = 0;
  for (const f of todo) {
    if (signal.aborted) throw new Error('cancelled');
    mkdirSync(dirname(f.dest), { recursive: true });
    const part = `${f.dest}.part`;
    const hash = createHash('sha256');
    let got = 0;
    try {
      const src = await body(f.url, signal);
      await pipeline(src, async function* count(source) {
        for await (const chunk of source) {
          got += chunk.length;
          if (got > f.size) throw new Error(`${basename(f.dest)} is bigger than expected`);
          hash.update(chunk);
          done += chunk.length;
          if (Date.now() - last > 200) { last = Date.now(); progress({ state: 'running', line: `Downloading ${basename(f.dest)}`, done, total }); }
          yield chunk;
        }
      }, createWriteStream(part), { signal });
      if (got !== f.size) throw new Error(`${basename(f.dest)} came out ${got} bytes, expected ${f.size}`);
      if (f.sha256 && hash.digest('hex') !== f.sha256) throw new Error(`${basename(f.dest)} failed its SHA-256 check`);
      renameSync(part, f.dest);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
  }
  progress({ state: 'running', line: 'Checked', done: total, total });
  return todo.length ? `Downloaded ${todo.length} file${todo.length === 1 ? '' : 's'} (${(total / 1e6).toFixed(1)} MB)` : 'Already here';
}
