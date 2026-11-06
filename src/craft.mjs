// The Craft apps: open-source, clean-room remakes of the Adobe apps (and a few more) in Rust, by the team behind
// ArtCraft (github.com/storytold). Each one is MIT OR Apache-2.0, ships official builds for Linux, macOS and Windows,
// and comes with a command line whose `mcp` subcommand is a Model Context Protocol server: every menu item is a
// command an agent can run, headless, the same way a person does in the app.
//
// Mortiflix doesn't copy their code. `mortiflix craft install` pulls each app's latest official release from GitHub,
// checks it against the release's own SHA256SUMS.txt, and unpacks it into <studio>/tools/craft/<app>/. Sessions
// (claude-code backend) then get the installed apps' MCP servers and the craft-apps skill; `mortiflix craft register`
// adds the same servers to your own Claude Code.
//
// The ArtCraft name and logo are the ArtCraft team's trademarks and aren't open source: nothing here uses them as a
// name or a mark. ArtCraft's own AI app (storytold/artcraft) is "fair source", not open source, and isn't offered.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform as hostPlatform, arch as hostArch, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { loadConfig, saveConfig, UserError } from './studio.mjs';
import * as plat from './platform.mjs';

export const OWNER = 'storytold';

// `use` is what a motion design studio reaches for it for (the craft-apps skill says the same, at more length).
// `mcp` is what its MCP server needs beyond `mcp` to run headless with files under `dir`: VectorCraft's connects to a
// running app unless told --headless; PhotoCraft's reads and writes nothing until it's given its roots.
export const APPS = [
  { id: 'effectcraft', name: 'EffectCraft', replaces: 'After Effects', use: 'compositions, keyframes, shape and text layers, puppet pins, 3D layers; renders MP4/WebM' },
  { id: 'photocraft', name: 'PhotoCraft', replaces: 'Photoshop', use: 'layered images and PSD files, adjustment layers, masks, brushes; the most mature of them', mcp: (dir) => ['--automation-read-root', dir, '--automation-write-root', dir] },
  { id: 'vectorcraft', name: 'VectorCraft', replaces: 'Illustrator', use: 'vector artwork, logos, paths, Pathfinder; exports SVG/PDF/PNG', mcp: () => ['--headless'] },
  { id: 'lightcraft', name: 'LightCraft', replaces: 'Lightroom', use: 'developing photos and raw files, masks, batch looks' },
  { id: 'designcraft', name: 'DesignCraft', replaces: 'InDesign', use: 'page layout and typography' },
  { id: 'soundcraft', name: 'SoundCraft', replaces: 'Audition', use: 'audio editing and cleanup' },
  { id: 'pdfcraft', name: 'PdfCraft', replaces: 'Acrobat', use: 'reading, rendering, editing and combining PDFs' },
  { id: 'deckcraft', name: 'DeckCraft', replaces: 'PowerPoint', use: 'slide decks' },
  { id: 'wordcraft', name: 'WordCraft', replaces: 'Word', use: 'documents' },
  { id: 'gridcraft', name: 'GridCraft', replaces: 'Excel', use: 'spreadsheets, formulas and charts' },
  { id: 'cadcraft', name: 'CadCraft', replaces: 'CAD', use: 'technical drawing and CAD' },
];
export const APP_IDS = APPS.map((a) => a.id);
const byId = (id) => APPS.find((a) => a.id === id);
export const mcpArgs = (id, dir = '.') => ['mcp', ...(byId(id)?.mcp?.(dir) || [])];

export const craftDir = (root) => join(root, 'tools', 'craft');
const appDir = (root, id) => join(craftDir(root), id);
const manifestFile = (root, id) => join(appDir(root, id), 'craft.json');

// ---- which release file fits this computer ----

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The files to download for `id` from a release's asset names: { archive, app? } (macOS: the CLI zip, plus the dmg
// with the app). null when the release has nothing for this system.
export function pickAssets(id, names, { platform = hostPlatform(), arch = hostArch() } = {}) {
  const find = (re) => names.find((n) => re.test(n)) || null;
  const v = '\\d+\\.\\d+\\.\\d+[^-]*';
  const i = esc(id);
  if (platform === 'linux' || platform === 'freebsd') {
    const cpu = platform === 'freebsd' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
    const archive = cpu && find(new RegExp(`^${i}-${v}-${platform}-${cpu}\\.tar\\.gz$`));
    return archive ? { archive } : null;
  }
  if (platform === 'win32') {
    const cpu = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[arch];
    const archive = cpu && find(new RegExp(`^${i}-${v}-windows-${cpu}-portable\\.zip$`));
    return archive ? { archive } : null;
  }
  if (platform === 'darwin') {
    const archive = find(new RegExp(`^${i}-cli-${v}-macos-universal\\.zip$`));
    return archive ? { archive, app: find(new RegExp(`^${i}-${v}-macos-universal\\.dmg$`)) } : null;
  }
  return null;
}

// SHA256SUMS.txt → { file: hash }
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

// ---- GitHub ----

async function gh(path, fetchImpl) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mortiflix' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com${path}`, { headers });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub\'s rate limit for this address is used up (60 requests an hour without a token): try again later, or set GITHUB_TOKEN');
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

// Apps held at a version the studio was built and tested against; the owner moves a pin on (config craftPins).
// None is pinned now (the edit stage uses Mortiflix Studio, not a Craft app).
export const PINS = {};
export const pinFor = (config, id) => ({ ...PINS, ...(config.craftPins || {}) })[id] || null;

export async function latestRelease(id, { fetchImpl = fetch, version = null } = {}) {
  const r = await gh(version ? `/repos/${OWNER}/${id}/releases/tags/v${version}` : `/repos/${OWNER}/${id}/releases/latest`, fetchImpl);
  return { tag: r.tag_name, version: String(r.tag_name).replace(/^v/, ''), assets: Object.fromEntries(r.assets.map((a) => [a.name, a.browser_download_url])) };
}

// Downloads `url` to `file` and returns its SHA-256.
async function download(url, file, { fetchImpl, log }) {
  log(`Downloading ${url}`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let got = 0; let shown = 0;
  const body = Readable.fromWeb(res.body).on('data', (c) => {
    hash.update(c);
    got += c.length;
    if (total && got - shown > total / 4) { shown = got; log(`  ${Math.round((got / total) * 100)}% of ${(total / 1e6).toFixed(0)} MB`); }
  });
  mkdirSync(dirname(file), { recursive: true });
  await streamPipeline(body, createWriteStream(file));
  return hash.digest('hex');
}

function unpack(archive, dest, log) {
  log(`Unpacking ${archive.split(/[\\/]/).pop()}`);
  mkdirSync(dest, { recursive: true });
  // bsdtar (Windows' own tar.exe, macOS) reads .zip too; GNU tar on Linux only ever gets the .tar.gz.
  const r = spawnSync(plat.systemTar(), ['-xf', archive, '-C', dest, '--strip-components=1'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`unpacking failed: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
}

// macOS: the app itself comes in a disk image; copy its .app next to the CLI.
function copyAppFromDmg(dmg, dest, log) {
  const mnt = join(tmpdir(), `mfx-craft-${process.pid}-${Date.now()}`);
  const at = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmg], { encoding: 'utf8' });
  if (at.status !== 0) throw new Error(`hdiutil couldn't open the disk image: ${at.stderr.trim()}`);
  try {
    const app = readdirSync(mnt).find((n) => n.endsWith('.app'));
    if (!app) throw new Error('the disk image has no .app');
    log(`Copying ${app}`);
    cpSync(join(mnt, app), join(dest, app), { recursive: true, verbatimSymlinks: true });
    return app;
  } finally { spawnSync('hdiutil', ['detach', mnt]); }
}

// Where the CLI and the app are inside an unpacked release.
export function layout(dir, id, { platform = hostPlatform() } = {}) {
  if (platform === 'win32') return { cli: join(dir, `${id}-cli.exe`), app: join(dir, `${id}.exe`) };
  if (platform === 'darwin') {
    const app = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith('.app')) : null;
    return { cli: join(dir, `${id}-cli`), app: app ? join(dir, app) : null };
  }
  return { cli: join(dir, 'bin', `${id}-cli`), app: join(dir, 'bin', id) };
}

// ---- the owner's choice and what's installed ----

export function craftConfig(config) {
  const apps = Array.isArray(config.craft?.apps) ? config.craft.apps.filter((a) => APP_IDS.includes(a)) : APP_IDS;
  return { apps };
}

export function saveCraftApps(root, apps) {
  const list = apps === 'all' ? APP_IDS : [...new Set(apps)];
  for (const a of list) if (!APP_IDS.includes(a)) throw new UserError(`unknown app "${a}" (${APP_IDS.join(', ')})`);
  saveConfig(root, { craft: { apps: list } });
  return craftConfig(loadConfig(root));
}

export function installed(root, id) {
  try {
    const m = JSON.parse(readFileSync(manifestFile(root, id), 'utf8'));
    const where = layout(appDir(root, id), id);
    return existsSync(where.cli) ? { ...m, cli: where.cli, app: where.app && existsSync(where.app) ? where.app : null } : null;
  } catch { return null; }
}

export function craftStatus(root) {
  const chosen = craftConfig(loadConfig(root)).apps;
  const apps = APPS.map((a) => {
    const i = installed(root, a.id);
    return { ...a, chosen: chosen.includes(a.id), installed: Boolean(i), version: i?.version || null, cli: i?.cli || null, app: i?.app || null };
  });
  const have = apps.filter((a) => a.installed);
  return {
    ok: have.length > 0 && chosen.every((id) => have.some((a) => a.id === id)),
    apps,
    detail: have.length ? `${have.length} of ${APPS.length}: ${have.map((a) => `${a.name} ${a.version}`).join(', ')}` : 'not installed',
  };
}

// ---- installing ----

export async function installApp(root, id, { log = () => {}, fetchImpl = fetch, platform = hostPlatform(), arch = hostArch() } = {}) {
  const a = byId(id);
  if (!a) throw new UserError(`unknown app "${id}" (${APP_IDS.join(', ')})`);
  const rel = await latestRelease(id, { fetchImpl, version: pinFor(loadConfig(root), id) });
  const pick = pickAssets(id, Object.keys(rel.assets), { platform, arch });
  if (!pick) throw new Error(`${a.name} ${rel.version} has no build for ${platform} ${arch}`);
  const sumsUrl = rel.assets['SHA256SUMS.txt'];
  if (!sumsUrl) throw new Error(`${a.name} ${rel.version} publishes no SHA256SUMS.txt: not installing a file that can't be checked`);
  const sumsRes = await fetchImpl(sumsUrl);
  if (!sumsRes.ok) throw new Error(`couldn't fetch ${a.name}'s SHA256SUMS.txt (${sumsRes.status})`);
  const sums = parseSums(await sumsRes.text());

  const downloads = join(craftDir(root), 'downloads');
  const fresh = `${appDir(root, id)}.new`;
  rmSync(fresh, { recursive: true, force: true });
  const files = [pick.archive, pick.app].filter(Boolean);
  const got = {};
  try {
    for (const name of files) {
      const want = sums[name];
      if (!want) throw new Error(`${name} isn't listed in ${a.name}'s SHA256SUMS.txt: not installing it`);
      const file = join(downloads, name);
      const hash = await download(rel.assets[name], file, { fetchImpl, log });
      if (hash !== want) { rmSync(file, { force: true }); throw new Error(`${name} doesn't match its SHA-256 in SHA256SUMS.txt (got ${hash.slice(0, 12)}…, expected ${want.slice(0, 12)}…): not installed`); }
      log(`  ✔ SHA-256 matches SHA256SUMS.txt`);
      got[name] = { file, sha256: hash };
    }
    unpack(got[pick.archive].file, fresh, log);
    if (pick.app) copyAppFromDmg(got[pick.app].file, fresh, log);
    const where = layout(fresh, id, { platform });
    if (!existsSync(where.cli)) throw new Error(`the ${a.name} release has no ${where.cli.split(/[\\/]/).pop()} where it should be`);
    // It has to run here and answer as an MCP server (a build for another libc or CPU fails now, not mid-project).
    const probe = await mcpProbe(where.cli, mcpArgs(id));
    if (!probe.ok) throw new Error(`${a.name}'s MCP server doesn't start on this computer: ${probe.error}`);
    log(`  ✔ its MCP server answers: ${probe.tools.length} tools`);
    writeFileSync(join(fresh, 'craft.json'), `${JSON.stringify({ id, name: a.name, version: rel.version, tag: rel.tag, repo: `${OWNER}/${id}`, files: Object.fromEntries(Object.entries(got).map(([n, g]) => [n, g.sha256])), installed_at: new Date().toISOString() }, null, 2)}\n`);
    rmSync(appDir(root, id), { recursive: true, force: true });
    renameSync(fresh, appDir(root, id));
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    for (const g of Object.values(got)) rmSync(g.file, { force: true });
  }
  log(`  ✔ ${a.name} ${rel.version} (${a.replaces})`);
  return installed(root, id);
}

// The chosen apps (or `apps`), one after another. One failing never stops the others.
export async function installCraft(root, { apps, log = () => {}, fetchImpl = fetch } = {}) {
  const list = apps || craftConfig(loadConfig(root)).apps;
  const failed = [];
  for (const id of list) {
    log(`\n${byId(id)?.name || id}`);
    try { await installApp(root, id, { log, fetchImpl }); } catch (e) { failed.push(`${id}: ${e.message}`); log(`  ✖ ${e.message}`); }
  }
  return { ...craftStatus(root), problems: failed.length ? failed.join(' | ') : null };
}

export function removeApp(root, id) {
  if (!APP_IDS.includes(id)) throw new UserError(`unknown app "${id}" (${APP_IDS.join(', ')})`);
  rmSync(appDir(root, id), { recursive: true, force: true });
  saveConfig(root, { craft: { apps: craftConfig(loadConfig(root)).apps.filter((a) => a !== id) } });
  return craftStatus(root);
}

// ---- MCP ----

// Starts `<cli> mcp` headless, says hello and lists its tools: { ok, server, tools } or { ok: false, error }.
export function mcpProbe(cli, args = ['mcp'], { timeoutMs = 20_000 } = {}) {
  return new Promise((done) => {
    let p;
    try { p = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { done({ ok: false, error: e.message }); return; }
    let out = ''; let err = ''; let server = null; let finished = false;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); try { p.kill(); } catch { /* gone */ } done(r); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${timeoutMs / 1000} s${err ? `: ${err.trim().split('\n').pop()}` : ''}` }), timeoutMs);
    const send = (m) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    p.on('error', (e) => finish({ ok: false, error: e.message }));
    p.on('close', (code) => finish({ ok: false, error: `exited with ${code}${err ? `: ${err.trim().split('\n').pop()}` : ''}` }));
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish({ ok: false, error: m.error.message });
          server = m.result?.serverInfo || null;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list' });
        } else if (m.id === 2) {
          if (m.error) return finish({ ok: false, error: m.error.message });
          return finish({ ok: true, server, tools: (m.result?.tools || []).map((t) => t.name) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mortiflix', version: '1' } } });
  });
}

// Every installed app's MCP server, headless (stdio), with files under `dir` (a session: its project folder; your own
// Claude Code: "." = wherever you start it): { mcpServers: { photocraft: { command, args } } }.
export function mcpServers(root, { dir = '.' } = {}) {
  const out = {};
  for (const a of APPS) {
    const i = installed(root, a.id);
    if (i) out[a.id] = { command: i.cli, args: mcpArgs(a.id, dir) };
  }
  return { mcpServers: out };
}

// Adds the installed apps' MCP servers to your own Claude Code (user scope). A server of the same name that isn't
// one of these installs is yours: it's left alone.
export function registerWithClaude(root, { claudeBin = 'claude', apps, log = () => {} } = {}) {
  const servers = mcpServers(root).mcpServers;
  const ids = (apps || Object.keys(servers)).filter((id) => servers[id]);
  if (!ids.length) throw new UserError('no Craft app is installed yet: mortiflix craft install');
  const claude = (args) => { const c = plat.command(claudeBin, args); return spawnSync(c.file, c.args, { ...c.options, encoding: 'utf8', timeout: 30_000 }); };
  const done = { added: [], updated: [], kept: [] };
  for (const id of ids) {
    const s = servers[id];
    const have = claude(['mcp', 'get', id]);
    if (have.status === 0) {
      if (!String(have.stdout).includes(craftDir(root))) { done.kept.push(id); log(`  · ${id}: you already have an MCP server called "${id}"; left alone`); continue; }
      claude(['mcp', 'remove', '--scope', 'user', id]);
    }
    const r = claude(['mcp', 'add', '--scope', 'user', id, '--', s.command, ...s.args]);
    if (r.status !== 0) throw new Error(`claude mcp add ${id} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
    (have.status === 0 ? done.updated : done.added).push(id);
    log(`  ✔ ${id}: ${s.command} ${s.args.join(' ')}`);
  }
  return done;
}

// Opens an installed app for you (optionally with a file).
export function openApp(root, id, file) {
  const i = installed(root, id);
  if (!i) throw new UserError(`${byId(id)?.name || id} isn't installed: mortiflix craft install ${id}`);
  if (!i.app) throw new UserError(`${i.name} has no desktop app in this install`);
  const args = file ? [file] : [];
  const p = hostPlatform() === 'darwin' ? spawn('open', ['-a', i.app, ...args], { detached: true, stdio: 'ignore' }) : spawn(i.app, args, { detached: true, stdio: 'ignore', windowsHide: false });
  p.unref();
  return i.app;
}

// Where a session's working folder keeps its Craft MCP servers (read by the claude-code backend).
export const craftMcpFile = (workdir) => join(workdir, '.mortiflix', 'craft-mcp.json');

// For the session brief and the backend: the installed apps' CLIs ({ photocraft: "/…/photocraft-cli" }).
export function sessionCraft(root) {
  return Object.fromEntries(APPS.map((a) => [a.id, installed(root, a.id)?.cli]).filter(([, cli]) => cli));
}
