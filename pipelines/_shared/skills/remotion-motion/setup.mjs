#!/usr/bin/env node
// setup.mjs: start this project's Remotion video from the template, without a fresh install every time.
//
//   node .claude/skills/remotion-motion/setup.mjs [folder]      (default: video)
//
// Remotion with its own Chrome is ~750 MB and half a minute to install. The studio installs the template's exact
// dependencies once (in $MFX_SHARED, keyed by the template's package.json) and each project links to it, so a new
// project costs kilobytes and no download. Outside a Mortiflix session (no $MFX_SHARED) it installs locally.
import { existsSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync, rmSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, 'template');
const target = resolve(process.argv[2] || 'video');
const npm = process.env.MFX_NPM || 'npm';

if (!existsSync(join(target, 'src'))) {
  mkdirSync(target, { recursive: true });
  for (const f of ['src', 'package.json', 'tsconfig.json']) cpSync(join(template, f), join(target, f), { recursive: true });
  console.log(`${target}: started from the template`);
} else console.log(`${target}: already set up (src/ kept)`);

const modules = join(target, 'node_modules');
const shared = process.env.MFX_SHARED || null;
const pkg = readFileSync(join(template, 'package.json'));
const dir = shared ? join(shared, `remotion-${createHash('sha256').update(pkg).digest('hex').slice(0, 12)}`) : null;

if (existsSync(modules) || isLink(modules)) {
  // Linked to an older shared install while the template has since gained packages (e.g. @remotion/transitions):
  // move to the current one, unless this project added packages of its own.
  if (dir && isLink(modules) && realpathOr(modules) !== realpathOr(join(dir, 'node_modules'))) {
    const mine = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    const tpl = JSON.parse(pkg);
    const ownExtras = Object.entries(mine.dependencies || {}).filter(([k, v]) => tpl.dependencies?.[k] !== v);
    if (!ownExtras.length) {
      ensureShared();
      rmSync(modules);
      symlinkSync(join(dir, 'node_modules'), modules, 'dir');
      writeFileSync(join(target, 'package.json'), JSON.stringify({ ...mine, dependencies: tpl.dependencies, devDependencies: tpl.devDependencies }, null, 2) + '\n');
      console.log(`node_modules: moved to the studio's current shared install (the template gained packages): ${dir}`);
      process.exit(0);
    }
  }
  console.log(`node_modules: already there (${isLink(modules) ? 'linked to the studio\'s shared install' : 'a local install'})`);
  process.exit(0);
}

if (!shared) {
  run(npm, ['install', '--no-audit', '--no-fund'], target);
  console.log('node_modules: installed locally');
  process.exit(0);
}

ensureShared();
symlinkSync(join(dir, 'node_modules'), modules, 'dir');
console.log(`node_modules: linked to the studio's shared install (${dir})`);
console.log('Need another package? Replace the link with a local install first: rm node_modules && npm install && npm install <pkg>');

function ensureShared() {
  const done = join(dir, '.installed');
  if (existsSync(done)) return;
  mkdirSync(dir, { recursive: true });
  // One installer at a time (a lock directory; a stale one after 15 minutes is taken over).
  const lock = join(dir, '.installing');
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      if (existsSync(done)) break;
      if (Date.now() - statSync(lock).mtimeMs > 15 * 60_000) { rmSync(lock, { recursive: true, force: true }); continue; }
      spawnSync('sleep', ['2']);
    }
  }
  try {
    if (!existsSync(done)) {
      writeFileSync(join(dir, 'package.json'), pkg);
      console.log(`installing the shared Remotion (once per studio) in ${dir} …`);
      run(npm, ['install', '--no-audit', '--no-fund'], dir);
      writeFileSync(done, new Date().toISOString());
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function realpathOr(p) { try { return realpathSync(p); } catch { return p; } }
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`); process.exit(1); }
}
