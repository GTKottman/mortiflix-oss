// Setup: the applications a studio can use, why each one is needed, whether it's here, and how to install it.
// Everything installs into the studio folder (<studio>/tools/) or as the user's own tool (uv), never system-wide,
// and nothing installs without being asked. The choices (music, asset sites) live in config.json.
//
//   strudel         Strudel (AGPL, npm) for the music step: it writes and renders the score
//   chrome          a headless Chrome that Strudel renders in (an existing Chrome/Chromium is reused)
//   browser-harness browser-use's browser-harness: sessions use your own Chrome to get assets from sites you name
//   comfyui         ComfyUI + the TTS Audio Suite, for narration on your own graphics card (Qwen3-TTS)
//   blender         Blender, for 3D work
//   blender-addons  the 3D toolkits (MoBlend, Nova FX, Camera, Animate, Math, Circuits, Camera Flight), installed into
//                   the studio's own Blender profile (tools/blender-profile), never into your personal Blender setup
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { loadConfig, saveConfig, UserError } from './studio.mjs';
import { voiceConfig } from './voice/index.mjs';
import * as qwen from './voice/qwen.mjs';

export const STRUDEL_VERSION = '1.3.0';
const OS = platform();
export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
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
    id: 'narration',
    title: 'Narration',
    why: 'A voice reads the script, and the animation is timed to its words.',
    needs: 'Either an ElevenLabs API key (their voices, paid per character), or ComfyUI with Qwen3-TTS on your own NVIDIA graphics card (free and private, about 10 GB to install), or your own voice (you record the lines in the booth), or no narration.',
  },
  {
    id: 'music',
    title: 'Music',
    why: 'After you approve the animatic, the studio scores it: a blueprint, a story, builds and hits placed on the video\'s own timing, written in Strudel and rendered to audio.',
    needs: 'Strudel (about 20 MB) and a headless Chrome to render in (your Chrome is reused if you have one). Optional: a MIDI pack of every part, to remake the music in your own DAW.',
    tools: ['strudel', 'chrome'],
  },
  {
    id: 'assets',
    title: 'Assets',
    why: 'If you use a stock site (footage, images, 3D models, sound effects), sessions can search it and download what fits, with your own login, in your own Chrome.',
    needs: 'browser-harness (from browser-use on GitHub, installed with uv) and the addresses of the sites you use.',
    tools: ['browser-harness'],
  },
  {
    id: '3d',
    title: '3D',
    why: 'Pipelines that build 3D scenes (product shots, music videos, models) render them in Blender.',
    needs: 'Blender (about 350 MB, the official build for your system) and the 3D toolkits: MoBlend (MoGraph), Nova FX (particles, fire, fireworks), Camera, Animate, Math, Circuits, and Camera Flight for flying the camera yourself. Skip it if you only make 2D videos.',
    tools: ['blender', 'blender-addons'],
  },
];

// ---- running things ----

function which(bin) {
  const r = spawnSync(OS === 'win32' ? 'where' : 'sh', OS === 'win32' ? [bin] : ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

function version(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? (r.stdout || r.stderr).split('\n')[0].trim() : null;
}

// A command whose output streams to `log`, line by line. Rejects on a non-zero exit.
export function run(cmd, args, { cwd, env, log = () => {} } = {}) {
  return new Promise((ok, fail) => {
    log(`$ ${[cmd, ...args].join(' ')}`);
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: OS === 'win32' });
    let tail = '';
    const onData = (d) => {
      const s = String(d);
      tail = (tail + s).slice(-2000);
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) log(`  ${line.trimEnd().slice(0, 300)}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => fail(new Error(`${cmd}: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? ok(tail) : fail(new Error(`${cmd} exited with ${code}: ${tail.trim().split('\n').slice(-3).join(' / ')}`))));
  });
}

async function download(url, file, log) {
  log(`Downloading ${url}`);
  const res = await fetch(url);
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

// ---- detecting each tool ----

function strudelStatus(root) {
  const dir = join(toolsDir(root), 'strudel');
  const pkg = join(dir, 'node_modules', '@strudel', 'web', 'package.json');
  if (!existsSync(pkg)) return { ok: false, detail: 'not installed' };
  return { ok: true, path: dir, version: JSON.parse(readFileSync(pkg, 'utf8')).version, detail: `Strudel ${JSON.parse(readFileSync(pkg, 'utf8')).version}` };
}

function chromeCandidates(root) {
  const out = [];
  const headless = join(toolsDir(root), 'browsers', 'chrome-headless-shell');
  if (existsSync(headless)) {
    for (const ver of readdirSync(headless)) {
      for (const d of readdirSync(join(headless, ver))) out.push(join(headless, ver, d, `chrome-headless-shell${EXE}`));
    }
  }
  if (OS === 'darwin') out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  else if (OS === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
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

async function comfyStatus(root) {
  const url = voiceConfig(root).qwen.url;
  const ws = join(toolsDir(root), 'ComfyUI');
  let live = null;
  try { live = await new qwen.ComfyUI({ url }).status(); } catch { /* not reachable */ }
  if (live?.ok) return { ok: true, detail: `ComfyUI at ${url} with the TTS Audio Suite`, url };
  if (live && !live.ok && live.comfyui) return { ok: false, detail: `ComfyUI is running at ${url} but the TTS Audio Suite isn't installed`, url, running: true };
  if (existsSync(join(ws, 'main.py'))) return { ok: false, installed: true, path: ws, detail: `installed in ${ws}, not running` };
  return { ok: false, detail: 'not installed' };
}

// Everything at once, for the walkthrough, doctor, the web page and the session brief.
export async function setupStatus(root) {
  const config = loadConfig(root);
  return {
    strudel: strudelStatus(root),
    chrome: chromeStatus(root),
    'browser-harness': browserHarnessStatus(),
    comfyui: await comfyStatus(root),
    blender: blenderStatus(root),
    'blender-addons': addonsStatus(root),
    music: musicConfig(config),
    assets: assetsConfig(config),
    gpu: qwen.recommend(qwen.detectGpus()),
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

async function installStrudel(root, log) {
  const dir = join(toolsDir(root), 'strudel');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mortiflix-strudel', private: true, license: 'AGPL-3.0-or-later', dependencies: { '@strudel/web': STRUDEL_VERSION } }, null, 2) + '\n');
  await run(OS === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, log });
  const s = strudelStatus(root);
  if (!s.ok) throw new Error('npm finished but @strudel/web is missing');
  return s;
}

async function installChrome(root, log) {
  const have = chromeStatus(root);
  if (have.ok) { log(`Using ${have.path}`); saveToolPath(root, 'chrome', have.path); return have; }
  const dir = join(toolsDir(root), 'browsers');
  await run(OS === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome-headless-shell@stable', '--path', dir], { log });
  const s = chromeStatus(root);
  if (!s.ok) throw new Error('the headless Chrome download finished but no executable was found');
  saveToolPath(root, 'chrome', s.path);
  return s;
}

async function ensureUv(log) {
  const have = findUv();
  if (have) return have;
  log('Installing uv (Astral\'s Python tool manager) for your user: https://docs.astral.sh/uv/');
  if (OS === 'win32') await run('powershell', ['-ExecutionPolicy', 'ByPass', '-c', 'irm https://astral.sh/uv/install.ps1 | iex'], { log });
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
    if (files.length) return { version: `${files[0][2]}.${files[0][3]}.${files[0][4]}`, url: dir + files[0][1], file: files[0][1] };
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
  mkdirSync(dest, { recursive: true });
  if (OS === 'darwin') {
    const mnt = join(tmpdir(), `mfx-blender-${process.pid}`);
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, file], { log });
    try { mkdirSync(join(dest, rel.version), { recursive: true }); await run('cp', ['-R', join(mnt, 'Blender.app'), join(dest, rel.version)], { log }); }
    finally { await run('hdiutil', ['detach', mnt], { log }).catch(() => {}); }
  } else {
    await run('tar', [OS === 'win32' ? '-xf' : '-xJf', file, '-C', dest], { log });
  }
  rmSync(file, { force: true });
  const s = blenderStatus(root);
  if (!s.ok) throw new Error('Blender unpacked but its executable wasn\'t found');
  saveToolPath(root, 'blender', s.path);
  return s;
}

// ComfyUI + the TTS Audio Suite, in its own Python environment inside the studio. NVIDIA only (that's what Qwen3-TTS
// needs here). Large: PyTorch with CUDA is several GB.
async function installComfy(root, log) {
  const gpu = qwen.recommend(qwen.detectGpus());
  if (!gpu.fits) throw new UserError(`Local narration needs an NVIDIA graphics card with 4 GB or more: ${gpu.reason} Use ElevenLabs instead.`);
  if (!which('git')) throw new UserError('ComfyUI is installed with git, which isn\'t on this machine: install git first.');
  const uv = await ensureUv(log);
  const ws = join(toolsDir(root), 'ComfyUI');
  if (!existsSync(join(ws, 'main.py'))) await run('git', ['clone', '--depth', '1', 'https://github.com/comfyanonymous/ComfyUI', ws], { log });
  const py = join(ws, '.venv', OS === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(py)) await run(uv, ['venv', '--python', '3.12', join(ws, '.venv')], { log });
  await run(uv, ['pip', 'install', '--python', py, 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128'], { log });
  await run(uv, ['pip', 'install', '--python', py, '-r', join(ws, 'requirements.txt')], { log });
  const suite = join(ws, 'custom_nodes', 'TTS-Audio-Suite');
  if (!existsSync(suite)) await run('git', ['clone', '--depth', '1', 'https://github.com/diodiogod/TTS-Audio-Suite', suite], { log });
  if (existsSync(join(suite, 'install.py'))) await run(py, [join(suite, 'install.py')], { cwd: suite, log });
  else await run(uv, ['pip', 'install', '--python', py, '-r', join(suite, 'requirements.txt')], { log });
  log('Installed. Starting it now (it listens on 127.0.0.1:8188).');
  startComfy(root);
  return { ok: true, path: ws, detail: `installed in ${ws}` };
}

// Starts the studio's own ComfyUI in the background (logs to tools/ComfyUI/comfyui.log).
export function startComfy(root) {
  const ws = join(toolsDir(root), 'ComfyUI');
  const py = join(ws, '.venv', OS === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(py)) throw new UserError('the studio\'s ComfyUI isn\'t installed (mortiflix setup narration)');
  const port = Number(new URL(voiceConfig(root).qwen.url).port || 8188);
  const out = createWriteStream(join(ws, 'comfyui.log'), { flags: 'a' });
  const p = spawn(py, [join(ws, 'main.py'), '--listen', '127.0.0.1', '--port', String(port)], { cwd: ws, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.pipe(out); p.stderr.pipe(out);
  p.unref();
  return { pid: p.pid, log: join(ws, 'comfyui.log') };
}

// ---- the 3D toolkits ----

// Each is a Blender extension, from its own repository (GPL-3.0) or vendored here (Nova FX). `kit` is how a session
// calls it inside Blender (see the blender-3d skill); `owner` ones are for you, in `mortiflix blender`.
export const ADDONS = [
  { id: 'moblend', name: 'MoBlend', about: 'MoGraph: cloners, effectors, fields, MoText, fracture', repo: 'GTKottman/moblend', dir: 'moblend', kit: 'mograph' },
  { id: 'nova_fx', name: 'Nova FX', about: 'Mortiflix\'s own particle engine: particles, fire, sparks and fireworks (Linux only for now)', vendored: 'vendor/nova-fx', dir: 'addon/nova_fx', kit: 'particles', stage: { from: 'core', to: 'lib', files: ['nova_core.c', 'gpu_vk.c', 'nova_params.h', 'shaders_spv.h'] } },
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

// A repository's default branch, unpacked under tools/blender-addons/src/<name> (replaced on every install).
async function fetchRepo(root, repo, log) {
  const name = repo.split('/')[1];
  const dest = join(toolsDir(root), 'blender-addons', 'src', name);
  const tgz = await download(`https://codeload.github.com/${repo}/tar.gz/HEAD`, join(toolsDir(root), 'downloads', `${name}.tar.gz`), log);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await run('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { log });
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
    if (a.vendored) {
      const stage = join(toolsDir(root), 'blender-addons', 'stage', a.id);
      rmSync(stage, { recursive: true, force: true });
      const src = join(REPO_ROOT, a.vendored);
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

const INSTALLERS = { strudel: installStrudel, chrome: installChrome, 'browser-harness': installBrowserHarness, blender: installBlender, 'blender-addons': installAddons, comfyui: installComfy };
export const TOOLS = Object.keys(INSTALLERS);

export const TOOL_INFO = {
  strudel: { name: 'Strudel', what: `@strudel/web ${STRUDEL_VERSION} from npm (AGPL-3.0)`, where: 'tools/strudel', size: '~20 MB' },
  chrome: { name: 'Headless Chrome', what: 'Chrome for Testing\'s headless shell, from Google (only if you have no Chrome or Chromium)', where: 'tools/browsers', size: '~100 MB' },
  'browser-harness': { name: 'browser-harness', what: 'browser-use/browser-harness, installed with uv (Python 3.12) as your own tool', where: '~/.local/bin', size: '~60 MB' },
  comfyui: { name: 'ComfyUI + TTS Audio Suite', what: 'ComfyUI and diodiogod/TTS-Audio-Suite from GitHub, PyTorch with CUDA, in their own Python environment; the Qwen3-TTS models download on first use', where: 'tools/ComfyUI', size: '~10 GB with the models' },
  blender: { name: 'Blender', what: 'the newest official build from download.blender.org (your own Blender is reused if you have one)', where: 'tools/blender', size: '~350 MB' },
  'blender-addons': { name: 'The 3D toolkits', what: 'MoBlend, Camera, Animate, Math, Circuits and Camera Flight from their GitHub repositories, and Nova FX from this repository, installed into the studio\'s own Blender profile', where: 'tools/blender-profile', size: '~15 MB' },
};

export async function installTool(root, id, { log = () => {} } = {}) {
  const fn = INSTALLERS[id];
  if (!fn) throw new UserError(`unknown tool "${id}" (${TOOLS.join(', ')})`);
  mkdirSync(toolsDir(root), { recursive: true });
  return fn(root, log);
}

// ---- what a session gets ----

export function sessionToolsEnv(root) {
  const config = loadConfig(root);
  const env = { MFX_MUSIC: JSON.stringify(musicConfig(config)), MFX_ASSETS: JSON.stringify(assetsConfig(config)) };
  const s = strudelStatus(root);
  if (s.ok) env.MFX_STRUDEL = s.path;
  const c = chromeStatus(root);
  if (c.ok) env.MFX_CHROME = c.path;
  const b = blenderStatus(root);
  if (b.ok) Object.assign(env, { MFX_BLENDER: b.path }, addonsStatus(root).installed?.length ? { ...blenderEnv(root), MFX3D: join(REPO_ROOT, 'harness', 'skills', 'blender-3d') } : {});
  return env;
}

export const blenderDocsDir = (root) => join(toolsDir(root), 'blender-addons', 'docs');

// What the session brief says about this studio's tools (no network calls: ComfyUI is the narration skill's business).
export function setupStatusSync(root) {
  const config = loadConfig(root);
  return { strudel: strudelStatus(root), chrome: chromeStatus(root), 'browser-harness': browserHarnessStatus(), blender: blenderStatus(root),
    'blender-addons': addonsStatus(root), music: musicConfig(config), assets: assetsConfig(config) };
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
  if (!assetsConfig(loadConfig(root)).sites.length || !bin) return null;
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
