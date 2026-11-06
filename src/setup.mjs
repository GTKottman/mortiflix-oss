// Setup: the applications a studio can use, why each one is needed, whether it's here, and how to install it.
// Everything installs into the studio folder (<studio>/tools/) or as the user's own tool (uv), never system-wide,
// and nothing installs without being asked. The choices (music, asset sites) live in config.json.
//
//   transitions     the remotion-transitions library (MIT): every cut in every video is chosen from it (or inspired by it)
//   strudel         Strudel (AGPL, npm) for the music step: it writes and renders the score
//   kinetograph     Kinetograph (the owner's fork build when its tarballs are here, else npm, pinned; src/kinetograph.mjs):
//                   renders every 2D shot, still and animatic from the
//                   Remotion-API projects sessions write, on the GPU, with no Chrome
//   chrome          a headless Chrome that Strudel renders in (an existing Chrome/Chromium is reused)
//   browser-harness browser-use's browser-harness: sessions use your own Chrome to get assets from sites you name
//   blender         Blender, for 3D work
//   blender-addons  the 3D toolkits (MoBlend, Nova FX, Camera, Animate, Math, Circuits, Camera Flight), installed into
//                   the studio's own Blender profile (tools/blender-profile), never into your personal Blender setup
//   daw-engine      the mini DAW's sound engine (mortiflix-engine: JUCE + Tracktion Engine), built from the pinned source
//                   commits with --build (release downloads come later)
//   craft           the Craft apps (EffectCraft, PhotoCraft, VectorCraft, …: open-source remakes of the Adobe apps), their
//                   official builds, checked against their SHA256SUMS, each with its own MCP server (src/craft.mjs)
// No local AI generation (owner, 2026-11-01: "local generation is considered bloat"): voice and music come from
// ElevenLabs; pictures are drawn in code (Kinetograph).
import { spawn, spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, createWriteStream, statSync, copyFileSync, chmodSync, statfsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch, tmpdir, availableParallelism, totalmem } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { loadConfig, saveConfig, UserError } from './studio.mjs';
import * as plat from './platform.mjs';
import { publishConfig } from './publish.mjs';
import { keySource } from './keys.mjs';
import * as craft from './craft.mjs';
import { kgStatus, kgDir, kgBinDir, kgPacks, kgSourceFile, nativePackage, KINETOGRAPH_VERSION, KINETOGRAPH_NODE } from './kinetograph.mjs';

export const STRUDEL_VERSION = '1.3.0';
const OS = platform();
export const REPO_ROOT = plat.REPO_ROOT;
const EXE = OS === 'win32' ? '.exe' : '';

export const toolsDir = (root) => join(root, 'tools');

// ---- the parts of setup, in the order the walkthrough takes them ----

export const PARTS = [
  {
    id: 'claude',
    title: 'Claude',
    why: 'Claude does the work: it writes, designs, animates and checks every step. Mortiflix is the studio around it.',
    needs: 'Your Claude Code login (your plan pays), or an Anthropic API key (you pay per token).',
  },
  {
    id: 'rendering',
    title: 'Rendering',
    why: 'Every 2D shot, style frame and animatic is rendered by the built-in renderer: a GPU video engine, no browser.',
    needs: `Built in (installed with the app). Linux x64, macOS on Apple silicon and Windows x64.`,
    tools: ['kinetograph'],
  },
  {
    id: 'transitions',
    title: 'Transitions',
    why: 'Every cut in every video is designed: before the animatic, a transition board shows how each style frame becomes the next, and why (the object or idea that carries the cut).',
    needs: 'The remotion-transitions library from GitHub (about 5 MB): 50 motion-design transitions in nine families, with a preview of each.',
    tools: ['transitions'],
  },
  {
    id: 'narration',
    title: 'Narration',
    why: 'A voice reads the script, and the animation is timed to its words.',
    needs: 'An ElevenLabs API key (their voices, paid per character): the default, and the only voice the studio generates. Or your own voice (you record the lines in the booth), or no narration.',
  },
  {
    id: 'music',
    title: 'Music',
    why: 'After you approve the animatic, the studio scores it: a blueprint, a story, builds and hits placed on the video\'s own timing, written in Strudel and rendered to audio.',
    needs: 'Strudel (about 20 MB) and a headless Chrome to render in (your Chrome is reused if you have one). Optional: a MIDI pack of every part, to remake the music in your own DAW.',
    tools: ['strudel', 'chrome'],
  },
  {
    id: 'daw',
    title: 'Your DAW',
    why: 'The MIDI pack is made to be finished in a DAW. Name yours and every MIDI pack comes with the steps to bring it in there: the tempo, bar 1, one track per channel, the markers.',
    needs: 'Nothing to install. Optional: without one, the steps are written for any DAW.',
  },
  {
    id: 'daw-engine',
    title: 'Sound engine (DAW mode)',
    why: 'Plays and mixes the music with your own VST3 plugins, right in the canvas.',
    needs: 'The Mortiflix sound engine (about 27 MB), built here from its pinned source (JUCE + Tracktion Engine, about 400 MB of source and build files, a few minutes). Linux: PipeWire with pipewire-jack, or JACK.',
    tools: ['daw-engine'],
  },
  {
    id: 'assets',
    title: 'Assets',
    why: 'If you use a stock site (footage, images, 3D models, sound effects), sessions can search it and download what fits, with your own login, in your own Chrome.',
    needs: 'browser-harness (from browser-use on GitHub, installed with uv) and the addresses of the sites you use.',
    tools: ['browser-harness'],
  },
  {
    id: 'publish',
    title: 'Publishing',
    why: 'Once you approve a final, `mortiflix publish` can post it to your social accounts: where the brief said, at a time you pick, after it shows you the plan and you say yes. Sessions can never post.',
    needs: 'Optional. Upload-Post (hosted, free plan with 10 uploads/mo or paid plans, your accounts connected on upload-post.com) and its API key. Without one, you download finals and post them yourself.',
  },
  {
    id: '3d',
    title: '3D',
    why: 'Pipelines that build 3D scenes (product shots, music videos, models) render them in Blender.',
    needs: 'Blender (about 350 MB, the official build for your system) and the 3D toolkits: MoBlend (MoGraph), Nova FX (particles, fire, fireworks), Camera, Animate, Math, Circuits, and Camera Flight for flying the camera yourself. Skip it if you only make 2D videos.',
    tools: ['blender', 'blender-addons'],
  },
  {
    id: 'craft',
    title: 'Craft apps',
    why: 'Sessions can work in real design apps the way a person does: compositions in EffectCraft, layered images in PhotoCraft, vectors in VectorCraft, and more. They are open-source remakes of the Adobe apps, and each comes with an MCP server, so Claude runs their menus and tools directly and hands you files you can open in them.',
    needs: `Optional. The official builds of the apps you pick, from github.com/${craft.OWNER} (MIT or Apache-2.0; 15 to 80 MB each, about 900 MB for all ${craft.APPS.length}), checked against each release's SHA256SUMS. They are young (most are weeks old), so expect gaps.`,
    tools: ['craft'],
  },
];

// ---- running things ----

const which = (bin) => plat.which(bin);

function version(bin, args = ['--version']) {
  const c = plat.command(bin, args);
  const r = spawnSync(c.file, c.args, { ...c.options, encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? (r.stdout || r.stderr).split(/\r?\n/)[0].trim() : null;
}

// The install job a command runs for ({signal}: setup.cancel), seen by run() and download() through every await of the
// installer without passing it through each one (Node's AsyncLocalStorage).
const installJob = new AsyncLocalStorage();
const RUN_LIMIT_MS = 60 * 60_000; // one installer command: an hour at most (a hung one used to hang the install forever)

// A command whose output streams to `log`, line by line. Rejects on a non-zero exit, when the install is cancelled,
// and after `timeoutMs`; a stop is SIGTERM, then SIGKILL 5 s later.
export function run(cmd, args, { cwd, env, log = () => {}, timeoutMs = RUN_LIMIT_MS } = {}) {
  const signal = installJob.getStore()?.signal;
  return new Promise((ok, fail) => {
    if (signal?.aborted) { fail(new Error('cancelled')); return; }
    log(`$ ${[cmd, ...args].join(' ')}`);
    const c = plat.command(cmd, args);
    const p = spawn(c.file, c.args, { ...c.options, cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => {
      const s = String(d);
      tail = (tail + s).slice(-2000);
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) log(`  ${line.trimEnd().slice(0, 300)}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    let stopped = null;
    const stop = (why) => {
      if (stopped) return;
      stopped = why;
      try { p.kill('SIGTERM'); } catch { /* gone */ }
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
      t.unref?.();
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const limit = setTimeout(() => stop(`${cmd} took over ${Math.round(timeoutMs / 60_000)} min and was stopped`), timeoutMs);
    limit.unref?.();
    const end = () => { clearTimeout(limit); signal?.removeEventListener('abort', onAbort); };
    p.on('error', (e) => { end(); fail(new Error(`${cmd}: ${e.message}`)); });
    p.on('close', (code) => {
      end();
      if (stopped) fail(new Error(stopped));
      else if (code === 0) ok(tail);
      else fail(new Error(`${cmd} exited with ${code}: ${tail.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });
}

async function download(url, file, log) {
  log(`Downloading ${url}`);
  const res = await fetch(url, { signal: installJob.getStore()?.signal });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0; let shown = 0;
  const counted = Readable.fromWeb(res.body).on('data', (c) => {
    got += c.length;
    if (total && got - shown > total / 10) { shown = got; log(`  ${Math.round((got / total) * 100)}% of ${(total / 1e6).toFixed(0)} MB`); }
  });
  mkdirSync(dirname(file), { recursive: true });
  await streamPipeline(counted, createWriteStream(file));
  return file;
}

// Checks `file` against a known sha256 (deleted when it doesn't match).
export async function checkFileSha256(file, want, what = file, log = () => {}) {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  const got = h.digest('hex');
  if (got !== String(want).toLowerCase()) { rmSync(file, { force: true }); throw new Error(`${what}: checksum ${got} doesn't match ${want}; the download was deleted`); }
  log(`Checksum OK (sha256 ${got.slice(0, 16)}…)`);
}

// Checks `file` against the line for `name` in a SHA256SUMS-style list at `sumsUrl` (deleted when it doesn't match).
export async function checkSha256(file, sumsUrl, name, log = () => {}, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sumsUrl);
  if (!res.ok) throw new Error(`no checksums at ${sumsUrl} (${res.status})`);
  const want = (await res.text()).split('\n').map((l) => l.trim().split(/\s+\*?/)).find((f) => f[1] === name)?.[0]?.toLowerCase();
  if (!want) throw new Error(`${name} isn't in ${sumsUrl}`);
  return checkFileSha256(file, want, name, log);
}

// ---- detecting each tool ----

export const TRANSITIONS_REPO = 'GTKottman/remotion-transitions';

export function transitionsStatus(root) {
  const dir = join(toolsDir(root), 'remotion-transitions');
  const cat = join(dir, 'catalog.json');
  if (!existsSync(cat)) return { ok: false, detail: 'not installed' };
  try {
    const c = JSON.parse(readFileSync(cat, 'utf8'));
    return { ok: true, path: dir, count: c.transitions.length, detail: `${c.transitions.length} transitions` };
  } catch { return { ok: false, detail: 'catalog.json unreadable: reinstall' }; }
}

function strudelStatus(root) {
  const dir = join(toolsDir(root), 'strudel');
  const pkg = join(dir, 'node_modules', '@strudel', 'web', 'package.json');
  if (!existsSync(pkg)) return { ok: false, detail: 'not installed' };
  return { ok: true, path: dir, version: JSON.parse(readFileSync(pkg, 'utf8')).version, detail: `Strudel ${JSON.parse(readFileSync(pkg, 'utf8')).version}` };
}

function chromeCandidates(root) {
  const out = [];
  const headless = join(toolsDir(root), 'browsers', 'chrome-headless-shell');
  // Folders only: @puppeteer/browsers also keeps a `.metadata` file here.
  const dirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  for (const ver of dirs(headless)) {
    for (const d of dirs(join(headless, ver))) out.push(join(headless, ver, d, `chrome-headless-shell${EXE}`));
  }
  if (OS === 'darwin') out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  else if (OS === 'win32') {
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of bases) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    // Edge is Chromium and comes with Windows 10 and 11: it renders Strudel the same way, with nothing to download.
    for (const base of bases) out.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else for (const b of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) { const p = which(b); if (p) out.push(p); }
  return out;
}

function chromeStatus(root) {
  const saved = loadConfig(root).tools?.chrome;
  const found = [saved, ...chromeCandidates(root)].filter(Boolean).find((p) => existsSync(p));
  return found ? { ok: true, path: found, detail: found } : { ok: false, detail: 'no Chrome or Chromium found' };
}

const UV_PLACES = () => [which('uv'), join(homedir(), '.local', 'bin', `uv${EXE}`), join(homedir(), '.cargo', 'bin', `uv${EXE}`)];
const findUv = () => UV_PLACES().filter(Boolean).find((p) => existsSync(p)) || null;
const BH_PLACES = () => [which('browser-harness'), join(homedir(), '.local', 'bin', `browser-harness${EXE}`)];
export const findBrowserHarness = () => BH_PLACES().filter(Boolean).find((p) => existsSync(p)) || null;

function uvStatus() {
  const bin = findUv();
  return bin ? { ok: true, path: bin, detail: version(bin) || bin } : { ok: false, detail: 'not installed' };
}

function browserHarnessStatus() {
  const bin = findBrowserHarness();
  if (!bin) return { ok: false, detail: 'not installed' };
  return { ok: true, path: bin, detail: version(bin) || 'installed' };
}

function blenderCandidates(root) {
  const out = [loadConfig(root).tools?.blender];
  const mine = join(toolsDir(root), 'blender');
  if (existsSync(mine)) for (const d of readdirSync(mine)) out.push(join(mine, d, OS === 'darwin' ? 'Blender.app/Contents/MacOS/Blender' : `blender${EXE}`));
  out.push(which('blender'));
  if (OS === 'darwin') out.push('/Applications/Blender.app/Contents/MacOS/Blender');
  if (OS === 'win32' && process.env.PROGRAMFILES) {
    const base = join(process.env.PROGRAMFILES, 'Blender Foundation');
    if (existsSync(base)) for (const d of readdirSync(base)) out.push(join(base, d, 'blender.exe'));
  }
  return out.filter(Boolean);
}

function blenderStatus(root) {
  const bin = blenderCandidates(root).find((p) => existsSync(p));
  if (!bin) return { ok: false, detail: 'not installed' };
  return { ok: true, path: bin, detail: version(bin, ['--version'])?.replace(/\s+/g, ' ') || bin };
}

// The sound engine: installed, its --version, and its self-test (1 s of a tone rendered into memory, no sound device).
// Read again only when the file changes.
export const dawEngineBin = (root) => join(toolsDir(root), 'daw-engine', `mortiflix-engine${EXE}`);
const engineChecks = new Map();
export function dawEngineStatus(root) {
  const bin = dawEngineBin(root);
  if (!existsSync(bin)) return { ok: false, detail: 'not installed', path: null };
  const m = statSync(bin).mtimeMs;
  const hit = engineChecks.get(bin);
  if (hit?.m === m) return hit.st;
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  let ver = null;
  try { ver = JSON.parse(v.stdout.trim().split('\n').pop()); } catch { ver = null; }
  const t = spawnSync(bin, ['--selftest'], { encoding: 'utf8', timeout: 60_000 });
  const st = !ver ? { ok: false, detail: 'installed but it doesn\'t start', path: bin }
    : t.status !== 0 ? { ok: false, detail: `${ver.version}: its self-test failed`, path: bin, version: ver }
      : { ok: true, detail: `${ver.version} (Tracktion ${ver.tracktion_engine.slice(0, 7)}, ${ver.juce_version}), self-test passed`, path: bin, version: ver };
  engineChecks.set(bin, { m, st });
  return st;
}

// Everything at once, for the walkthrough, doctor, the web page and the session brief.
export async function setupStatus(root) {
  const config = loadConfig(root);
  return {
    transitions: transitionsStatus(root),
    strudel: strudelStatus(root),
    kinetograph: kgStatus(root),
    chrome: chromeStatus(root),
    'browser-harness': browserHarnessStatus(),
    uv: uvStatus(),
    blender: blenderStatus(root),
    'blender-addons': addonsStatus(root),
    craft: craft.craftStatus(root),
    'daw-engine': dawEngineStatus(root),
    music: musicConfig(config),
    daw: dawConfig(config),
    assets: assetsConfig(config),
    publish: (({ service, ...rest }) => ({ service, ...rest, key: service === 'none' ? null : keySource(root, service) }))(publishConfig(config)),
  };
}

// ---- the choices ----

export function musicConfig(config) {
  const m = config.music || {};
  return { engine: m.engine === 'none' ? 'none' : 'strudel', midi: Boolean(m.midi) };
}

export function saveMusic(root, { engine, midi } = {}) {
  const cur = musicConfig(loadConfig(root));
  if (engine !== undefined && !['strudel', 'none'].includes(engine)) throw new UserError('music engine: strudel or none');
  saveConfig(root, { music: { engine: engine ?? cur.engine, midi: midi === undefined ? cur.midi : Boolean(midi) } });
  return musicConfig(loadConfig(root));
}

// The DAWs a MIDI pack writes import steps for (anything else gets the general steps).
export const DAWS = {
  ableton: 'Ableton Live', fl: 'FL Studio', logic: 'Logic Pro', reaper: 'REAPER', bitwig: 'Bitwig Studio',
  cubase: 'Cubase', studioone: 'Studio One', garageband: 'GarageBand', protools: 'Pro Tools', other: 'Another DAW',
};

export function dawConfig(config) {
  const id = DAWS[config.daw] ? config.daw : null;
  return { id, name: id ? DAWS[id] : null };
}

export function saveDaw(root, id) {
  const v = id === 'none' || id === '' ? null : id;
  if (v !== null && v !== undefined && !DAWS[v]) throw new UserError(`which DAW? One of: ${Object.keys(DAWS).join(', ')} (or none)`);
  saveConfig(root, { daw: v ?? undefined });
  return dawConfig(loadConfig(root));
}

// The studio's browser: sessions drive it with browser-harness over its DevTools address (loopback only), never the
// owner's own Chrome and never Claude in Chrome. `start` (set from the terminal only: it is a command the studio runs)
// starts it when it isn't running.
export function browserConfig(config) {
  const b = config.browser || {};
  return { cdpUrl: b.cdpUrl || null, start: b.start || null };
}

export function saveBrowser(root, { cdpUrl, start } = {}) {
  const cur = browserConfig(loadConfig(root));
  let url = cdpUrl === undefined ? cur.cdpUrl : cdpUrl || null;
  if (url) {
    let u; try { u = new URL(url); } catch { throw new UserError('the browser address looks like http://127.0.0.1:9333'); }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new UserError('the studio browser must be on this computer: http://127.0.0.1:<port>');
    url = `http://${u.hostname}:${u.port || 80}`;
  }
  saveConfig(root, { browser: { cdpUrl: url, start: start === undefined ? cur.start : start || null } });
  return browserConfig(loadConfig(root));
}

export async function browserCheck(root, { timeoutMs = 1500 } = {}) {
  const b = browserConfig(loadConfig(root));
  if (!b.cdpUrl) return { ok: false, configured: false, detail: 'no studio browser named: sessions use browser-harness\'s default' };
  try {
    const r = await fetch(`${b.cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return { ok: true, configured: true, detail: `${j.Browser || 'a browser'} on ${b.cdpUrl}`, cdpUrl: b.cdpUrl };
  } catch { return { ok: false, configured: true, detail: `nothing answers on ${b.cdpUrl}`, cdpUrl: b.cdpUrl, canStart: Boolean(b.start) }; }
}

// Before a session: the studio browser up, started with its start command if it isn't (once, up to 15 s).
export async function ensureBrowser(root) {
  let st = await browserCheck(root);
  if (st.ok || !st.configured) return st;
  const b = browserConfig(loadConfig(root));
  if (!b.start) return st;
  spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', b.start] : ['-c', b.start], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30 && !st.ok; i++) { await new Promise((ok) => setTimeout(ok, 500)); st = await browserCheck(root); }
  return { ...st, started: st.ok };
}

export function assetsConfig(config) {
  return { sites: (config.assets?.sites || []).filter((s) => s && s.url) };
}

// Sites are addresses the owner uses for assets. Only http(s), no credentials in the address.
export function saveAssetSites(root, sites) {
  const clean = [];
  for (const s of Array.isArray(sites) ? sites : []) {
    const raw = String(typeof s === 'string' ? s : s?.url || '').trim();
    if (!raw) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new UserError(`"${raw}": only http and https addresses`);
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new UserError(`"${raw}" isn't a web address`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new UserError(`"${raw}": only http and https addresses`);
    if (u.username || u.password) throw new UserError('leave logins out of the address: sessions use your own browser, where you\'re already signed in');
    const notes = String(typeof s === 'object' ? s.notes || '' : '').slice(0, 300);
    if (!clean.some((c) => c.url === u.origin + u.pathname.replace(/\/$/, ''))) clean.push({ url: u.origin + u.pathname.replace(/\/$/, ''), notes });
  }
  saveConfig(root, { assets: { sites: clean.slice(0, 20) } });
  return assetsConfig(loadConfig(root));
}

function saveToolPath(root, key, path) {
  const tools = { ...(loadConfig(root).tools || {}) };
  if (path) tools[key] = path; else delete tools[key];
  saveConfig(root, { tools });
}

// ---- installing ----

async function installTransitions(root, log) {
  const dir = join(toolsDir(root), 'remotion-transitions');
  const tgz = await download(`https://codeload.github.com/${TRANSITIONS_REPO}/tar.gz/HEAD`, join(toolsDir(root), 'downloads', 'remotion-transitions.tar.gz'), log);
  const fresh = `${dir}.new`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  await run(plat.systemTar(), ['-xzf', tgz, '-C', fresh, '--strip-components=1'], { log });
  rmSync(tgz, { force: true });
  if (!existsSync(join(fresh, 'catalog.json'))) throw new Error('the download has no catalog.json');
  rmSync(dir, { recursive: true, force: true });
  const { renameSync } = await import('node:fs');
  renameSync(fresh, dir);
  return transitionsStatus(root);
}

async function installStrudel(root, log) {
  const dir = join(toolsDir(root), 'strudel');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mortiflix-strudel', private: true, license: 'AGPL-3.0-or-later', dependencies: { '@strudel/web': STRUDEL_VERSION } }, null, 2) + '\n');
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, log });
  const s = strudelStatus(root);
  if (!s.ok) throw new Error('npm finished but @strudel/web is missing');
  return s;
}

// Into tools/kinetograph: the owner's fork build when its tarballs are here (kgPacks: the CLI, its @kinetographdev
// packages and this computer's addon, all from the tarballs, nested ones too), else the pinned npm release and this
// computer's prebuilt addon (which brings its own ffmpeg). Never compiled here.
async function installKinetograph(root, log) {
  const native = nativePackage();
  if (!native) throw new Error(`The renderer has no build for ${OS}-${arch()} (Linux x64, macOS arm64 and Windows x64 only)`);
  if (Number(process.versions.node.split('.')[0]) < KINETOGRAPH_NODE) throw new Error(`The renderer needs Node ${KINETOGRAPH_NODE} or newer (this is ${process.version})`);
  const dir = kgDir(root);
  mkdirSync(dir, { recursive: true });
  const packs = kgPacks(root);
  let dependencies = { kinetograph: KINETOGRAPH_VERSION, [native]: KINETOGRAPH_VERSION };
  let overrides;
  // A fresh resolve either way: the lock and the old packages may name the other source (the tarballs all say 0.2.0).
  rmSync(join(dir, 'package-lock.json'), { force: true });
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  rmSync(kgSourceFile(root), { force: true });
  if (packs) {
    log(`Installing the fork build ${packs.build.branch || ''} ${String(packs.build.commit || '').slice(0, 8)} from ${packs.dir}`);
    dependencies = Object.fromEntries(Object.entries(packs.files).map(([name, file]) => [name, `file:${file}`]));
    // every @kinetographdev package a tarball asks for (core asks for native, compat, react, scene) is the tarball too
    overrides = Object.fromEntries(Object.keys(packs.files).map((name) => [name, `$${name}`]));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mortiflix-kinetograph', private: true, type: 'module', dependencies, ...(overrides ? { overrides } : {}) }, null, 2) + '\n');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, log });
  if (packs) writeFileSync(kgSourceFile(root), JSON.stringify({ source: 'fork', commit: packs.build.commit || null, branch: packs.build.branch || null, packs: packs.dir }, null, 2) + '\n');
  const s = kgStatus(root);
  if (!s.ok) throw new Error(`npm finished but ${s.detail}`);
  return s;
}

async function installChrome(root, log) {
  const have = chromeStatus(root);
  if (have.ok) { log(`Using ${have.path}`); saveToolPath(root, 'chrome', have.path); return have; }
  const dir = join(toolsDir(root), 'browsers');
  await run('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome-headless-shell@stable', '--path', dir], { log });
  const s = chromeStatus(root);
  if (!s.ok) throw new Error('the headless Chrome download finished but no executable was found');
  saveToolPath(root, 'chrome', s.path);
  return s;
}

async function ensureUv(log) {
  const have = findUv();
  if (have) return have;
  log('Installing uv (Astral\'s Python tool manager) for your user: https://docs.astral.sh/uv/');
  if (OS === 'win32') await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex'], { log });
  else await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { log });
  const uv = findUv();
  if (!uv) throw new Error('uv installed but wasn\'t found in ~/.local/bin: open a new terminal and run setup again');
  return uv;
}

async function installBrowserHarness(root, log) {
  const uv = await ensureUv(log);
  await run(uv, ['tool', 'install', '--python', '3.12', '--upgrade', '--force', 'browser-harness'], { log });
  const bin = findBrowserHarness();
  if (!bin) throw new Error('browser-harness installed but wasn\'t found (is ~/.local/bin on your PATH?)');
  // Its own skill text, so sessions learn it from the source (refreshed on every install).
  const r = spawnSync(bin, ['skill'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status === 0 && r.stdout.trim()) {
    mkdirSync(join(toolsDir(root), 'browser-harness'), { recursive: true });
    writeFileSync(join(toolsDir(root), 'browser-harness', 'SKILL.md'), r.stdout);
  }
  return browserHarnessStatus();
}

export function browserHarnessRecordings(choice) {
  const bin = findBrowserHarness();
  if (!bin) return null;
  if (choice === undefined) return (spawnSync(bin, ['recordings'], { encoding: 'utf8' }).stdout || '').trim();
  return spawnSync(bin, ['recordings', choice ? 'enable' : 'disable'], { encoding: 'utf8' }).status === 0;
}

// The newest Blender release for this system, from download.blender.org.
export async function latestBlender({ fetchImpl = fetch } = {}) {
  const base = 'https://download.blender.org/release/';
  const index = await (await fetchImpl(base)).text();
  const series = [...index.matchAll(/href="Blender(\d+)\.(\d+)\/"/g)].map((m) => [Number(m[1]), Number(m[2])]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const want = OS === 'darwin' ? `macos-${arch() === 'arm64' ? 'arm64' : 'x64'}\\.dmg` : OS === 'win32' ? `windows-${arch() === 'arm64' ? 'arm64' : 'x64'}\\.zip` : `linux-${arch() === 'arm64' ? 'arm64' : 'x64'}\\.tar\\.xz`;
  for (const [maj, min] of series.slice(0, 4)) {
    const dir = `${base}Blender${maj}.${min}/`;
    const list = await (await fetchImpl(dir)).text();
    const files = [...list.matchAll(new RegExp(`href="(blender-(\\d+)\\.(\\d+)\\.(\\d+)-${want})"`, 'g'))].sort((a, b) => Number(b[4]) - Number(a[4]));
    if (files.length) {
      const version = `${files[0][2]}.${files[0][3]}.${files[0][4]}`;
      return { version, url: dir + files[0][1], file: files[0][1], sums: `${dir}blender-${version}.sha256` };
    }
  }
  throw new Error(`no Blender build found for ${OS} ${arch()} at ${base}`);
}

async function installBlender(root, log) {
  const have = blenderStatus(root);
  if (have.ok) { log(`Using ${have.path} (${have.detail})`); saveToolPath(root, 'blender', have.path); return have; }
  const rel = await latestBlender();
  log(`Blender ${rel.version} for ${OS} ${arch()}`);
  const dest = join(toolsDir(root), 'blender');
  const file = await download(rel.url, join(toolsDir(root), 'downloads', rel.file), log);
  await checkSha256(file, rel.sums, rel.file, log);
  mkdirSync(dest, { recursive: true });
  if (OS === 'darwin') {
    const mnt = join(tmpdir(), `mfx-blender-${process.pid}`);
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, file], { log });
    try { mkdirSync(join(dest, rel.version), { recursive: true }); await run('cp', ['-R', join(mnt, 'Blender.app'), join(dest, rel.version)], { log }); }
    finally { await run('hdiutil', ['detach', mnt], { log }).catch(() => {}); }
  } else {
    await run(plat.systemTar(), [OS === 'win32' ? '-xf' : '-xJf', file, '-C', dest], { log });
  }
  rmSync(file, { force: true });
  const s = blenderStatus(root);
  if (!s.ok) throw new Error('Blender unpacked but its executable wasn\'t found');
  saveToolPath(root, 'blender', s.path);
  return s;
}

// ---- the 3D toolkits ----

// Each is a Blender extension, from its own repository (GPL-3.0) or vendored here (Nova FX). `kit` is how a session
// calls it inside Blender (see the blender-3d skill); `owner` ones are for you, in `mortiflix blender`.
export const ADDONS = [
  { id: 'moblend', name: 'MoBlend', about: 'MoGraph: cloners, effectors, fields, MoText, fracture', repo: 'GTKottman/moblend', dir: 'moblend', kit: 'mograph' },
  // Pinned: this commit's GitHub archive, checked against its sha256 (tested 2026-10-16).
  { id: 'nova_fx', name: 'Nova FX', about: 'Mortiflix\'s own particle engine: particles, fire, sparks and fireworks (Linux only for now)', repo: 'GTKottman/nova-fx', commit: '01facc9ad601e0d2e661e9bb2082a32f80808150', sha256: '8a863290c84d69d31467beba0823c1534711dfe9bb71c6fb8c01ab574829b303', dir: 'addon/nova_fx', kit: 'particles', stage: { from: 'core', to: 'lib', files: ['nova_core.c', 'gpu_vk.c', 'nova_params.h', 'shaders_spv.h'] } },
  { id: 'blender_cam_mcp', name: 'Camera', about: 'framing, shot presets, camera moves, shake, cuts, contact sheets', repo: 'GTKottman/Blender-Cam', build: 'scripts/build_addon.py', zip: 'dist/blender_cam_mcp.zip', kit: 'camera', skills: ['skills/blender-camera-director'] },
  { id: 'blender_animate', name: 'Animate', about: 'easing, springs, paths and motion analysis', repo: 'GTKottman/Blender-Animate', build: 'scripts/build_addon.py', zip: 'dist/blender_animate.zip', kit: 'animate', skills: ['skills/blender-animate'] },
  { id: 'blender_math_bridge', name: 'Math', about: 'LaTeX and exact math, drawn in 3D', repo: 'GTKottman/Blender-Math', build: 'scripts/build_addon.py', zip: 'dist/blender_math_bridge.zip', kit: 'math', skills: ['.claude/skills/blender-math'] },
  { id: 'circuit_lab', name: 'Circuits', about: 'circuit design, simulation and electron-flow animation', repo: 'GTKottman/Blender-Circuits', build: 'build_addon.py', zip: 'dist/blender_circuits.zip', kit: 'circuits', skills: ['.claude/skills/circuit-explainer-video'] },
  { id: 'camera_flight', name: 'Camera Flight', about: 'fly the camera like a game and record takes (for you, in `mortiflix blender`)', repo: 'GTKottman/boender-camera-flight', build: 'build.py', zipGlob: /^camera_flight-.*\.zip$/, owner: true },
];

export const blenderProfile = (root) => join(toolsDir(root), 'blender-profile');
export const blenderEnv = (root) => ({ BLENDER_USER_RESOURCES: blenderProfile(root) });

function addonsStatus(root) {
  const dir = join(blenderProfile(root), 'extensions', 'user_default');
  const have = existsSync(dir) ? readdirSync(dir) : [];
  const missing = ADDONS.filter((a) => !have.includes(a.id));
  if (!have.length) return { ok: false, detail: 'not installed', installed: [] };
  return { ok: !missing.length, installed: ADDONS.filter((a) => have.includes(a.id)).map((a) => a.id), detail: missing.length ? `missing ${missing.map((a) => a.name).join(', ')}` : `${ADDONS.length} toolkits in the studio's Blender` };
}

async function blenderPython(bin) {
  const r = spawnSync(bin, ['-b', '--factory-startup', '--python-expr', 'import sys; print("MFXPY=" + sys.executable)'], { encoding: 'utf8', timeout: 120_000 });
  const py = /MFXPY=(.+)/.exec(r.stdout || '')?.[1]?.trim();
  if (!py || !existsSync(py)) throw new Error('couldn\'t find the Python inside Blender');
  return py;
}

// A repository's default branch (or a pinned `commit`, checked against `sha256`), unpacked under
// tools/blender-addons/src/<name> (replaced on every install).
async function fetchRepo(root, repo, log, { commit = null, sha256 = null } = {}) {
  const name = repo.split('/')[1];
  const dest = join(toolsDir(root), 'blender-addons', 'src', name);
  const tgz = await download(`https://codeload.github.com/${repo}/tar.gz/${commit || 'HEAD'}`, join(toolsDir(root), 'downloads', `${name}.tar.gz`), log);
  if (sha256) await checkFileSha256(tgz, sha256, `${repo}@${commit.slice(0, 7)}`, log);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await run(plat.systemTar(), ['-xzf', tgz, '-C', dest, '--strip-components=1'], { log });
  rmSync(tgz, { force: true });
  return dest;
}

// zip `dir` as <out>, with the folder itself at the top (what Blender's install-file expects).
async function zipDir(py, dir, out, log) {
  const code = `import shutil,os; shutil.make_archive(${JSON.stringify(out.replace(/\.zip$/, ''))},'zip',${JSON.stringify(dirname(dir))},${JSON.stringify(dir.split(/[\\/]/).pop())})`;
  await run(py, ['-c', code], { log });
  return out;
}

async function installAddons(root, log) {
  const b = blenderStatus(root);
  if (!b.ok) throw new UserError('Blender comes first: install it in this step (mortiflix setup 3d).');
  const py = await blenderPython(b.path);
  // A clean profile: factory preferences, so nothing from your own Blender setup comes along.
  if (!existsSync(join(blenderProfile(root), 'config', 'userpref.blend'))) {
    await run(b.path, ['-b', '--factory-startup', '--python-expr', 'import bpy; bpy.ops.wm.save_userpref()'], { env: blenderEnv(root), log });
  }
  const built = join(toolsDir(root), 'blender-addons', 'zips');
  mkdirSync(built, { recursive: true });
  const skillsDir = join(toolsDir(root), 'blender-addons', 'skills');
  const docsDir = join(toolsDir(root), 'blender-addons', 'docs');
  mkdirSync(docsDir, { recursive: true });
  const keepDoc = (from, kit) => { if (kit && existsSync(from)) writeFileSync(join(docsDir, `${kit}.md`), readFileSync(from, 'utf8')); };
  const done = [];
  for (const a of ADDONS) {
    log(`\n${a.name}: ${a.about}`);
    let zip;
    if (a.vendored || a.stage) {
      const stage = join(toolsDir(root), 'blender-addons', 'stage', a.id);
      rmSync(stage, { recursive: true, force: true });
      const src = a.vendored ? join(REPO_ROOT, a.vendored) : await fetchRepo(root, a.repo, log, { commit: a.commit, sha256: a.sha256 });
      const { cpSync, copyFileSync } = await import('node:fs');
      cpSync(join(src, a.dir), join(stage, a.id), { recursive: true });
      if (a.stage) {
        mkdirSync(join(stage, a.id, a.stage.to), { recursive: true });
        for (const f of a.stage.files) copyFileSync(join(src, a.stage.from, f), join(stage, a.id, a.stage.to, f));
      }
      zip = await zipDir(py, join(stage, a.id), join(built, `${a.id}.zip`), log);
      keepDoc(join(src, 'README.md'), a.kit);
    } else {
      const repo = await fetchRepo(root, a.repo, log);
      keepDoc(join(repo, 'README.md'), a.kit);
      if (a.build) {
        await run(py, [join(repo, a.build)], { cwd: repo, log });
        const found = a.zip ? join(repo, a.zip) : (() => { const d = join(repo, 'dist'); const f = existsSync(d) ? readdirSync(d).filter((x) => a.zipGlob.test(x)).sort().pop() : null; return f ? join(d, f) : null; })();
        if (!found || !existsSync(found)) throw new Error(`${a.name}: its build script didn't produce ${a.zip || 'a zip in dist/'}`);
        zip = found;
      } else {
        zip = await zipDir(py, join(repo, a.dir), join(built, `${a.id}.zip`), log);
      }
      for (const s of a.skills || []) {
        if (!existsSync(join(repo, s))) continue;
        const { cpSync } = await import('node:fs');
        const dest = join(skillsDir, s.split('/').pop());
        rmSync(dest, { recursive: true, force: true });
        cpSync(join(repo, s), dest, { recursive: true });
      }
    }
    await run(b.path, ['--command', 'extension', 'install-file', '-r', 'user_default', '-e', zip], { env: blenderEnv(root), log });
    done.push(a.id);
  }
  // Load each one once, headless: it must register cleanly (and Nova compiles its core now, not mid-project).
  const checkPy = join(toolsDir(root), 'blender-addons', 'check.py');
  writeFileSync(checkPy, `import bpy, addon_utils, importlib
bad = []
for mod in ${JSON.stringify(ADDONS.map((a) => `bl_ext.user_default.${a.id}`))}:
    if mod not in bpy.context.preferences.addons:
        try:
            addon_utils.enable(mod, default_set=True, persistent=True)
        except Exception as e:
            bad.append(mod + ": " + str(e))
    if mod not in bpy.context.preferences.addons:
        bad.append(mod + ": not enabled")
try:
    importlib.import_module("bl_ext.user_default.nova_fx.core").lib()
except Exception as e:
    bad.append("Nova FX core: " + str(e).splitlines()[0])
print("MFXBAD=" + " | ".join(bad))
`);
  log('\nLoading every toolkit once (Nova FX compiles its core for this CPU)…');
  const r = spawnSync(b.path, ['-b', '--python', checkPy], { encoding: 'utf8', env: { ...process.env, ...blenderEnv(root) }, timeout: 600_000 });
  const m = /MFXBAD=(.*)/.exec(r.stdout || '');
  const bad = m ? m[1].trim() : `the check didn't finish: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' / ')}`;
  log(bad ? `! ${bad}` : '✔ all of them load');
  return { ...addonsStatus(root), problems: bad || null };
}

// Opens the studio's Blender (its own profile, with the toolkits) for you: Camera Flight lives here.
export function openBlender(root, args = []) {
  const b = blenderStatus(root);
  if (!b.ok) throw new UserError('Blender isn\'t set up: mortiflix setup 3d');
  const p = spawn(b.path, args, { env: { ...process.env, ...blenderEnv(root) }, detached: true, stdio: 'ignore' });
  p.unref();
  return b.path;
}

// The sound engine from source (doc 16 §9): the pinned tracktion_engine commit and its JUCE submodule (engine/deps.json)
// into a machine-wide cache, CMake + Ninja, then the binary is copied into the studio. It never installs system
// packages: missing ones are named with the pacman line. Our patches (engine/patches) are applied by the CMake step.
export const ENGINE_DEPS_DIR = () => process.env.MFX_ENGINE_DEPS || join(homedir(), '.cache', 'mortiflix', 'engine-deps');
export const ENGINE_BUILD_DIR = () => process.env.MFX_ENGINE_BUILD || join(homedir(), '.cache', 'mortiflix', 'engine-build');
const ENGINE_TOOLS = { cmake: 'cmake', ninja: 'ninja', git: 'git', 'c++': 'gcc', 'pkg-config': 'pkgconf' };
const ENGINE_LIBS = { alsa: 'alsa-lib', jack: 'pipewire-jack', freetype2: 'freetype2', fontconfig: 'fontconfig', x11: 'libx11', xcomposite: 'libxcomposite',
  xext: 'libxext', xcursor: 'libxcursor', xinerama: 'libxinerama', xrandr: 'libxrandr', xrender: 'libxrender', xi: 'libxi' };

export function engineBuildMissing() {
  const missing = Object.entries(ENGINE_TOOLS).filter(([bin]) => !which(bin)).map(([, pkg]) => pkg);
  if (which('pkg-config')) missing.push(...Object.entries(ENGINE_LIBS).filter(([lib]) => spawnSync('pkg-config', ['--exists', lib]).status !== 0).map(([, pkg]) => pkg));
  return missing;
}

const gitHead = (dir) => { const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

async function installDawEngine(root, log, { build = false } = {}) {
  if (!build) throw new UserError('there is no release build of the sound engine yet: build it here with mortiflix setup daw-engine --build');
  if (OS !== 'linux') throw new UserError('building the sound engine works on Linux for now (Windows and macOS come later)');
  const missing = engineBuildMissing();
  if (missing.length) throw new UserError(`building the sound engine needs: ${missing.join(', ')}. On Arch: sudo pacman -S --needed ${missing.join(' ')}`);
  const deps = JSON.parse(readFileSync(join(REPO_ROOT, 'engine', 'deps.json'), 'utf8'));
  const te = join(ENGINE_DEPS_DIR(), 'tracktion_engine');
  if (!existsSync(join(te, '.git'))) {
    mkdirSync(dirname(te), { recursive: true });
    await run('git', ['clone', '--filter=blob:none', '--no-checkout', deps.tracktion_engine.url, te], { log });
  }
  if (gitHead(te) !== deps.tracktion_engine.commit || !existsSync(join(te, 'modules'))) {   // a fresh clone has no files yet
    await run('git', ['-C', te, 'fetch', '--filter=blob:none', 'origin', deps.tracktion_engine.commit], { log });
    await run('git', ['-C', te, '-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', deps.tracktion_engine.commit], { log });
  }
  const juce = join(te, 'modules', 'juce');
  if (gitHead(juce) !== deps.juce.commit) {
    // tracktion_engine names JUCE by an SSH address (git@github.com:…), which needs a GitHub key: the https one instead
    await run('git', ['-C', te, 'submodule', 'init', 'modules/juce'], { log });
    await run('git', ['-C', te, 'config', 'submodule.modules/juce.url', deps.juce.url], { log });
    await run('git', ['-C', te, 'submodule', 'update', '--init', '--filter=blob:none', 'modules/juce'], { log });
  }
  if (gitHead(juce) !== deps.juce.commit) throw new Error(`JUCE in ${juce} is at ${gitHead(juce)}, not the pinned ${deps.juce.commit}`);
  const out = ENGINE_BUILD_DIR();
  await run('cmake', ['-S', join(REPO_ROOT, 'engine'), '-B', out, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DTE_DIR=${te}`], { log });
  // Each JUCE / Tracktion file takes 1-2 GB to compile: 4 at a time at most.
  await run('ninja', ['-C', out, `-j${Math.max(1, Math.min(4, availableParallelism()))}`, 'mortiflix-engine'], { log });
  const built = join(out, 'mortiflix-engine_artefacts', 'Release', `mortiflix-engine${EXE}`);
  if (!existsSync(built)) throw new Error(`the build finished but ${built} isn't there`);
  const bin = dawEngineBin(root);
  mkdirSync(dirname(bin), { recursive: true });
  rmSync(bin, { force: true });   // never copy through a link someone left here
  copyFileSync(built, bin);
  chmodSync(bin, 0o755);
  log(`Copied to ${bin}`);
  const st = dawEngineStatus(root);
  if (!st.ok) throw new Error(`the engine was built but ${st.detail}`);
  return st;
}

const INSTALLERS = { uv: async (_root, log) => { await ensureUv(log); return uvStatus(); }, transitions: installTransitions, strudel: installStrudel, kinetograph: installKinetograph, chrome: installChrome, 'browser-harness': installBrowserHarness, blender: installBlender, 'blender-addons': installAddons,
  'daw-engine': installDawEngine, craft: (root, log) => craft.installCraft(root, { log }) };
export const TOOLS = Object.keys(INSTALLERS);

export const TOOL_INFO = {
  transitions: { name: 'Transitions library', what: 'github.com/GTKottman/remotion-transitions (MIT): 50 transitions for Remotion, a catalog and a preview of each', where: 'tools/remotion-transitions', size: '~5 MB' },
  strudel: { name: 'Strudel', what: `@strudel/web ${STRUDEL_VERSION} from npm (AGPL-3.0)`, where: 'tools/strudel', size: '~20 MB' },
  kinetograph: { name: 'Motion renderer', what: `the built-in GPU renderer: draws every 2D shot, style frame and animatic`, where: 'tools/kinetograph', size: '~130 MB download, ~240 MB installed' },
  chrome: { name: 'Headless Chrome', what: 'Chrome for Testing\'s headless shell, from Google (only if you have no Chrome or Chromium)', where: 'tools/browsers', size: '~100 MB' },
  uv: { name: 'uv (Python)', what: 'Astral\'s uv, which installs and runs the Python tools (browser-harness) with its own Python, from astral.sh', where: '~/.local/bin', size: '~40 MB' },
  'browser-harness': { name: 'browser-harness', what: 'browser-use/browser-harness, installed with uv (Python 3.12) as your own tool', where: '~/.local/bin', size: '~60 MB' },
  blender: { name: 'Blender', what: 'the newest official build from download.blender.org (your own Blender is reused if you have one)', where: 'tools/blender', size: '~350 MB' },
  craft: { name: 'The Craft apps', what: `the official builds of the apps you picked, from github.com/${craft.OWNER}, each checked against its release's SHA256SUMS and started once as an MCP server`, where: 'tools/craft', size: '15-80 MB each' },
  'daw-engine': { name: 'Sound engine', what: 'mortiflix-engine (this repository\'s engine/, AGPL-3.0) built from the pinned Tracktion Engine (GPL-3.0) and JUCE (AGPL-3.0) commits with CMake and Ninja', where: 'tools/daw-engine (source and build files in ~/.cache/mortiflix)', size: '~27 MB (+ ~400 MB cache)' },
  'blender-addons': { name: 'The 3D toolkits', what: 'MoBlend, Nova FX, Camera, Animate, Math, Circuits and Camera Flight from their GitHub repositories (Nova FX pinned to a checked commit), installed into the studio\'s own Blender profile', where: 'tools/blender-profile', size: '~15 MB' },
};

// `signal` (setup.cancel): stops the installer's running command or download, and every one after it.
export async function installTool(root, id, { log = () => {}, build = false, signal } = {}) {
  const fn = INSTALLERS[id];
  if (!fn) throw new UserError(`unknown tool "${id}" (${TOOLS.join(', ')})`);
  mkdirSync(toolsDir(root), { recursive: true });
  return installJob.run({ signal }, () => fn(root, log, { build }));
}

// ---- what a session gets ----

export function sessionToolsEnv(root) {
  const config = loadConfig(root);
  const env = { MFX_MUSIC: JSON.stringify(musicConfig(config)), MFX_ASSETS: JSON.stringify(assetsConfig(config)) };
  const tr = transitionsStatus(root);
  if (tr.ok) env.MFX_TRANSITIONS = tr.path;
  const s = strudelStatus(root);
  if (s.ok) env.MFX_STRUDEL = s.path;
  // the renderer: sessions run plain `kinetograph render|still …` (the studio's install on the PATH); the owner's
  // MFX_KINETOGRAPH (a local build of the fork) is passed on as it is
  if (existsSync(kgBinDir(root))) env.PATH = `${kgBinDir(root)}${plat.pathDelimiter()}${process.env.PATH || ''}`;
  if (process.env.MFX_KINETOGRAPH) env.MFX_KINETOGRAPH = process.env.MFX_KINETOGRAPH;
  const c = chromeStatus(root);
  if (c.ok) env.MFX_CHROME = c.path;
  // the real instruments the music engine plays (VCSL, CC0), a local copy it serves to its renderer
  if (existsSync(join(root, 'tools', 'samples', 'vcsl.json'))) env.MFX_SAMPLES = join(root, 'tools', 'samples');
  // the film mix (Dubstage): the studio's own build, or one set by the owner
  const dub = process.env.MFX_DUBSTAGE || [join(root, 'tools', 'dubstage', 'dubstage')].find((f) => existsSync(f));
  if (dub) env.MFX_DUBSTAGE = dub;
  const daw = dawConfig(config);
  if (daw.id) env.MFX_DAW = daw.id;
  const browser = browserConfig(config);
  if (browser.cdpUrl) env.BU_CDP_URL = browser.cdpUrl;
  const b = blenderStatus(root);
  if (b.ok) Object.assign(env, { MFX_BLENDER: b.path }, addonsStatus(root).installed?.length ? { ...blenderEnv(root), MFX3D: join(REPO_ROOT, 'harness', 'skills', 'blender-3d') } : {});
  const crafts = craft.sessionCraft(root);
  if (Object.keys(crafts).length) env.MFX_CRAFT = JSON.stringify(crafts);
  return env;
}

export const blenderDocsDir = (root) => join(toolsDir(root), 'blender-addons', 'docs');

// What the session brief says about this studio's tools (no network calls).
export function setupStatusSync(root) {
  const config = loadConfig(root);
  return { transitions: transitionsStatus(root), strudel: strudelStatus(root), kinetograph: kgStatus(root), chrome: chromeStatus(root), 'browser-harness': browserHarnessStatus(), uv: uvStatus(), blender: blenderStatus(root),
    'blender-addons': addonsStatus(root), craft: craft.craftStatus(root), music: musicConfig(config), daw: dawConfig(config), assets: assetsConfig(config) };
}

// The 3D toolkits' own skills (from their repositories), when they're installed.
export function blenderSkillDirs(root) {
  const dir = join(toolsDir(root), 'blender-addons', 'skills');
  if (!addonsStatus(root).installed?.length || !existsSync(dir)) return [];
  return readdirSync(dir).map((n) => join(dir, n)).filter((p) => existsSync(join(p, 'SKILL.md')));
}

// The browser-harness skill text, when the owner uses asset sites and the tool is installed.
export function browserHarnessSkill(root) {
  const bin = findBrowserHarness();
  // Sessions get the browser when the owner listed asset sites or named a studio browser.
  const config = loadConfig(root);
  if ((!assetsConfig(config).sites.length && !browserConfig(config).cdpUrl) || !bin) return null;
  const f = join(toolsDir(root), 'browser-harness', 'SKILL.md');
  if (!existsSync(f) || !statSync(f).size) {
    // Installed before this studio knew about it: ask the tool for its own skill once, and keep it.
    const r = spawnSync(bin, ['skill'], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, r.stdout);
  }
  return readFileSync(f, 'utf8');
}
