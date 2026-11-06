import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import * as craft from '../src/craft.mjs';
import { withCraft, sandboxArgs, describeTool } from '../src/backends/claude-code.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { prepareWorkdir, writeTorch } from '../src/torch.mjs';
import { sessionToolsEnv } from '../src/setup.mjs';

// The asset names of a real release (storytold/gridcraft v0.3.0).
const NAMES = ['gridcraft-0.3.0-freebsd-x86_64.tar.gz', 'gridcraft-0.3.0-linux-aarch64.AppImage', 'gridcraft-0.3.0-linux-aarch64.deb',
  'gridcraft-0.3.0-linux-aarch64.tar.gz', 'gridcraft-0.3.0-linux-x86_64.AppImage', 'gridcraft-0.3.0-linux-x86_64.tar.gz',
  'gridcraft-0.3.0-macos-universal.dmg', 'gridcraft-0.3.0-windows-arm64-portable.zip', 'gridcraft-0.3.0-windows-arm64.msi',
  'gridcraft-0.3.0-windows-x64-portable.zip', 'gridcraft-0.3.0-windows-x86-portable.zip', 'gridcraft-cli-0.3.0-macos-universal.zip',
  'gridcraft-web-0.3.0.zip', 'SHA256SUMS.txt'];

test('craft: picks the right build for each system', () => {
  const pick = (platform, arch) => craft.pickAssets('gridcraft', NAMES, { platform, arch });
  assert.deepEqual(pick('linux', 'x64'), { archive: 'gridcraft-0.3.0-linux-x86_64.tar.gz' });
  assert.deepEqual(pick('linux', 'arm64'), { archive: 'gridcraft-0.3.0-linux-aarch64.tar.gz' });
  assert.deepEqual(pick('freebsd', 'x64'), { archive: 'gridcraft-0.3.0-freebsd-x86_64.tar.gz' });
  assert.deepEqual(pick('win32', 'x64'), { archive: 'gridcraft-0.3.0-windows-x64-portable.zip' });
  assert.deepEqual(pick('win32', 'arm64'), { archive: 'gridcraft-0.3.0-windows-arm64-portable.zip' });
  assert.deepEqual(pick('win32', 'ia32'), { archive: 'gridcraft-0.3.0-windows-x86-portable.zip' });
  assert.deepEqual(pick('darwin', 'arm64'), { archive: 'gridcraft-cli-0.3.0-macos-universal.zip', app: 'gridcraft-0.3.0-macos-universal.dmg' });
  assert.equal(pick('linux', 'ppc64'), null);
  assert.equal(pick('aix', 'x64'), null);
  // Another app's files never match.
  assert.equal(craft.pickAssets('cadcraft', NAMES, { platform: 'linux', arch: 'x64' }), null);
});

test('craft: SHA256SUMS.txt parses in both sha256sum styles', () => {
  const a = 'a'.repeat(64); const b = 'B'.repeat(64);
  assert.deepEqual(craft.parseSums(`${a}  one.tar.gz\n${b} *two.zip\nnot a line\n`), { 'one.tar.gz': a, 'two.zip': b.toLowerCase() });
});

test('craft: MCP arguments per app (VectorCraft headless, PhotoCraft confined to the folder)', () => {
  assert.deepEqual(craft.mcpArgs('effectcraft'), ['mcp']);
  assert.deepEqual(craft.mcpArgs('vectorcraft'), ['mcp', '--headless']);
  assert.deepEqual(craft.mcpArgs('photocraft', '/w'), ['mcp', '--automation-read-root', '/w', '--automation-write-root', '/w']);
});

test('craft: the session gets the servers and their tools allowed', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'mfx-craft-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const base = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Read'];
  assert.deepEqual(withCraft(base, work), base, 'no file: unchanged');
  mkdirSync(join(work, '.mortiflix'));
  writeFileSync(craft.craftMcpFile(work), JSON.stringify({ mcpServers: { photocraft: {}, effectcraft: {} } }));
  assert.deepEqual(withCraft(base, work), ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Read mcp__photocraft mcp__effectcraft', '--mcp-config', craft.craftMcpFile(work)]);
  assert.deepEqual(withCraft(['--dangerously-skip-permissions'], work), ['--dangerously-skip-permissions', '--allowedTools', 'mcp__photocraft mcp__effectcraft', '--mcp-config', craft.craftMcpFile(work)]);
  assert.equal(describeTool('mcp__photocraft__doc_save', { path: 'out/a.psd' }), 'photocraft: doc_save out/a.psd');
});

// A stand-in Craft app: a release tarball whose CLI answers MCP's hello and tools/list (no network, no real app).
const FAKE_CLI = `#!/usr/bin/env node
if (process.argv[2] !== 'mcp') process.exit(2);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gridcraft', version: '9.9.9' } });
    if (m.method === 'tools/list') reply({ tools: [{ name: 'new_workbook', inputSchema: { type: 'object' } }, { name: 'save_workbook', inputSchema: { type: 'object' } }] });
  }
});
`;

function fakeRelease(t, { tamper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-craft-rel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const top = join(dir, 'gridcraft-9.9.9-linux-x86_64');
  mkdirSync(join(top, 'bin'), { recursive: true });
  writeFileSync(join(top, 'bin', 'gridcraft-cli'), FAKE_CLI);
  writeFileSync(join(top, 'bin', 'gridcraft'), '#!/bin/sh\n');
  chmodSync(join(top, 'bin', 'gridcraft-cli'), 0o755);
  const name = 'gridcraft-9.9.9-linux-x86_64.tar.gz';
  assert.equal(spawnSync('tar', ['-czf', join(dir, name), '-C', dir, 'gridcraft-9.9.9-linux-x86_64']).status, 0);
  const bytes = readFileSync(join(dir, name));
  const sum = createHash('sha256').update(tamper ? Buffer.from('something else') : bytes).digest('hex');
  const files = { [name]: bytes, 'SHA256SUMS.txt': Buffer.from(`${sum}  ${name}\n`) };
  const fetchImpl = async (url) => {
    if (url.includes('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: 'v9.9.9', assets: Object.keys(files).map((n) => ({ name: n, browser_download_url: `https://dl.test/${n}` })) }), { status: 200 });
    }
    const f = files[url.split('/').pop()];
    return f ? new Response(f, { status: 200, headers: { 'content-length': String(f.length) } }) : new Response('', { status: 404 });
  };
  return fetchImpl;
}

const posix = process.platform === 'linux';

test('craft: installs a checked release, and refuses one that doesn\'t match its SHA256SUMS', { skip: !posix && 'the stand-in CLI is a Linux script' }, async (t) => {
  const root = tempStudio(t);
  const log = [];
  const got = await craft.installApp(root, 'gridcraft', { fetchImpl: fakeRelease(t), platform: 'linux', arch: 'x64', log: (l) => log.push(l) });
  assert.equal(got.version, '9.9.9');
  assert.ok(existsSync(got.cli));
  assert.ok(log.some((l) => /SHA-256 matches/.test(l)) && log.some((l) => /MCP server answers: 2 tools/.test(l)));
  assert.equal(readdirSync(join(craft.craftDir(root), 'downloads')).length, 0, 'downloads are cleaned up');
  const st = craft.craftStatus(root);
  assert.equal(st.apps.find((a) => a.id === 'gridcraft').installed, true);
  assert.deepEqual(craft.mcpServers(root, { dir: '/w' }).mcpServers, { gridcraft: { command: got.cli, args: ['mcp'] } });
  assert.deepEqual(JSON.parse(sessionToolsEnv(root).MFX_CRAFT), { gridcraft: got.cli });

  // A tampered download: refused, and the working install stays as it was.
  await assert.rejects(craft.installApp(root, 'gridcraft', { fetchImpl: fakeRelease(t, { tamper: true }), platform: 'linux', arch: 'x64' }), /doesn't match its SHA-256/);
  assert.equal(craft.installed(root, 'gridcraft')?.version, '9.9.9');
  assert.ok(!existsSync(join(craft.craftDir(root), 'gridcraft.new')));

  // installCraft keeps going past an app that fails (here: no release for it).
  const r = await craft.installCraft(root, { apps: ['cadcraft'], fetchImpl: async () => new Response('', { status: 404 }) });
  assert.match(r.problems, /cadcraft: GitHub 404/);

  craft.removeApp(root, 'gridcraft');
  assert.equal(craft.installed(root, 'gridcraft'), null);
  assert.ok(!craft.craftConfig(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).apps.includes('gridcraft'));
});

test('craft: sessions get the skill, the MCP config (files in their folder) and a line in CLAUDE.md', { skip: !posix && 'the stand-in CLI is a Linux script' }, async (t) => {
  const root = tempStudio(t);
  const none = createProject(root, { pipeline: 'explainer', title: 'Without', answers: { topic: 'bikes' } });
  startProject(root, none.id);
  prepareWorkdir(root, none.id);
  const w0 = projectPaths(root, none.id).work;
  assert.ok(!existsSync(craft.craftMcpFile(w0)) && !existsSync(join(w0, '.claude', 'skills', 'craft-apps')));

  await craft.installApp(root, 'gridcraft', { fetchImpl: fakeRelease(t), platform: 'linux', arch: 'x64' });
  const { id } = createProject(root, { pipeline: 'explainer', title: 'With', answers: { topic: 'bikes' } });
  startProject(root, id);
  prepareWorkdir(root, id);
  writeTorch(root, id, { backend: 'demo', reason: 'test' });
  const work = projectPaths(root, id).work;
  const mcp = JSON.parse(readFileSync(craft.craftMcpFile(work), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['gridcraft']);
  assert.ok(existsSync(join(work, '.claude', 'skills', 'craft-apps', 'SKILL.md')));
  assert.match(readFileSync(join(work, 'CLAUDE.md'), 'utf8'), /\*\*Craft apps\*\*.*GridCraft 9\.9\.9 \(Excel\)/);
  // Inside the sandbox the apps are there, read-only.
  const box = sandboxArgs({ root, workdir: work, socket: join(work, 's.sock'), claudeBin: process.execPath, env: { PATH: '/usr/bin' } });
  const i = box.indexOf(craft.craftDir(root));
  assert.ok(i > 0 && box[i - 1] === '--ro-bind');

  // Removed: the next session has neither.
  craft.removeApp(root, 'gridcraft');
  prepareWorkdir(root, id);
  assert.ok(!existsSync(craft.craftMcpFile(work)) && !existsSync(join(work, '.claude', 'skills', 'craft-apps')));
});

test('craft: the web studio\'s setup lists the apps and saves the choice', async (t) => {
  const { request } = await import('node:http');
  const { randomBytes } = await import('node:crypto');
  const { startServer } = await import('../src/web/server.mjs');
  const root = tempStudio(t);
  const socketPath = join(tmpdir(), `mfx-web-${randomBytes(4).toString('hex')}.sock`);
  const srv = await startServer(root, { socketPath, quiet: true, runner: false });
  t.after(() => srv.close());
  const call = (method, path, body) => new Promise((ok, fail) => {
    const req = request({ socketPath, method, path, headers: { host: 'localhost', ...(method !== 'GET' ? { 'x-mortiflix': '1' } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(b || 'null') }));
    });
    req.on('error', fail);
    req.end(body ? JSON.stringify(body) : null);
  });
  const info = (await call('GET', '/api/setup')).json;
  assert.ok(info.parts.some((p) => p.id === 'craft') && info.tools.craft);
  assert.equal(info.status.craft.apps.length, craft.APPS.length);
  assert.ok(info.status.craft.apps.every((a) => a.chosen && !a.installed), 'all chosen by default, none installed');
  const saved = (await call('PUT', '/api/setup/craft', { apps: ['effectcraft', 'photocraft'] })).json;
  assert.deepEqual(saved.status.craft.apps.filter((a) => a.chosen).map((a) => a.id), ['effectcraft', 'photocraft']);
  assert.equal((await call('PUT', '/api/setup/craft', { apps: ['artcraft'] })).status, 400);
  const removed = (await call('POST', '/api/setup/craft/photocraft/remove')).json;
  assert.deepEqual(removed.status.craft.apps.filter((a) => a.chosen).map((a) => a.id), ['effectcraft']);
});

test('craft: the owner pins an app (craftPins); the pinned tag is what gets fetched', async () => {
  const { pinFor, latestRelease } = await import('../src/craft.mjs');
  assert.equal(pinFor({}, 'photocraft'), null);
  assert.equal(pinFor({ craftPins: { photocraft: '0.9.1' } }, 'photocraft'), '0.9.1');
  assert.equal(pinFor({}, 'gridcraft'), null);
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response(JSON.stringify({ tag_name: 'v0.8.0', assets: [] }), { status: 200 }); };
  const r = await latestRelease('photocraft', { fetchImpl, version: '0.8.0' });
  assert.equal(r.version, '0.8.0');
  assert.match(seen[0], /\/repos\/storytold\/photocraft\/releases\/tags\/v0\.8\.0$/);
});
