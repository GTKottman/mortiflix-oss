#!/usr/bin/env node
// setup.mjs: start this project's video from the template, without a fresh install every time.
//
//   node .claude/skills/remotion-motion/setup.mjs [folder]      (default: video)
//
// The studio renders with Kinetograph (a GPU engine that runs Remotion's API itself, no Chrome). Kinetograph's bundler
// maps `remotion`, `@remotion/*` and `react` onto its own copies, so a project needs no packages to render. What the
// template installs is for the type check only (`tsc --noEmit`, which the animatic step runs): Remotion's type
// packages, React's types and TypeScript, no @remotion/cli and no Chrome. The studio installs them once (in
// $MFX_SHARED, keyed by the template's package.json) and each project links to it, so a new project costs kilobytes
// and no download. Outside a Mortiflix session (no $MFX_SHARED) it installs locally.
//
// It also copies Kinetograph's own agent skill (its authoring reference) into .claude/skills/kinetograph when the
// studio's Kinetograph install is found.
import { existsSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync, rmSync, lstatSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, 'template');
const target = resolve(process.argv[2] || 'video');
const npm = process.env.MFX_NPM || 'npm';
// Packages older templates had and this one dropped on purpose: not a project's own extras.
const DROPPED = new Set(['@remotion/cli']);

if (!existsSync(join(target, 'src'))) {
  mkdirSync(target, { recursive: true });
  for (const f of ['src', 'package.json', 'tsconfig.json', 'remotion.config.ts']) cpSync(join(template, f), join(target, f), { recursive: true });
  console.log(`${target}: started from the template`);
} else {
  // src/ can exist before this runs (the studio's asset pool writes src/pool.ts): add the template files it lacks
  // (src/index.ts above all), never overwriting one
  const add = (from, to) => { for (const name of readdirSync(from)) { const a = join(from, name); const b = join(to, name); if (statSync(a).isDirectory()) { mkdirSync(b, { recursive: true }); add(a, b); } else if (!existsSync(b)) { cpSync(a, b); console.log(`${target}: added ${b.slice(target.length + 1)} from the template`); } } };
  add(template, target);
  console.log(`${target}: already set up (src/ kept)`);
}

copyKinetographSkill();

const modules = join(target, 'node_modules');
const shared = process.env.MFX_SHARED || null;
const pkg = readFileSync(join(template, 'package.json'));
const dir = shared ? join(shared, `remotion-${createHash('sha256').update(pkg).digest('hex').slice(0, 12)}`) : null;

if (existsSync(modules) || isLink(modules)) {
  // Linked to an older shared install while the template has since changed (e.g. gained @remotion/transitions, or
  // dropped @remotion/cli for Kinetograph): move to the current one, unless this project added packages of its own.
  if (dir && isLink(modules) && realpathOr(modules) !== realpathOr(join(dir, 'node_modules'))) {
    const mine = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    const tpl = JSON.parse(pkg);
    const ownExtras = Object.entries(mine.dependencies || {}).filter(([k, v]) => tpl.dependencies?.[k] !== v && !DROPPED.has(k));
    if (!ownExtras.length) {
      ensureShared();
      rmSync(modules);
      link(join(dir, 'node_modules'), modules);
      writeFileSync(join(target, 'package.json'), JSON.stringify({ ...mine, scripts: tpl.scripts, dependencies: tpl.dependencies, devDependencies: tpl.devDependencies }, null, 2) + '\n');
      console.log(`node_modules: moved to the studio's current shared install (the template's packages changed): ${dir}`);
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
link(join(dir, 'node_modules'), modules);
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  try {
    if (!existsSync(done)) {
      writeFileSync(join(dir, 'package.json'), pkg);
      console.log(`installing the shared Remotion types (once per studio) in ${dir} …`);
      run(npm, ['install', '--no-audit', '--no-fund'], dir);
      writeFileSync(done, new Date().toISOString());
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Kinetograph's agent skill (SKILL.md + references/) from the studio's install, with a note on top that the studio's
// rules win: its CLI is `kinetograph` on the PATH (never npx, which would fetch another version), and stills, strips
// and renders go through `mfx render`, never its MCP server. Refreshed on every run, so it follows the installed version.
function copyKinetographSkill() {
  if (basename(dirname(dirname(here))) !== '.claude') return; // run from the studio's own repo, not a project's copy
  const shared = process.env.MFX_SHARED || '';
  // MFX_KINETOGRAPH as the studio reads it (src/kinetograph.mjs): a cli.js, a package folder or the fork's folder; else
  // the studio's install (MFX_SHARED is <studio>/run/shared).
  const asCli = (p) => {
    try { if (!statSync(p).isDirectory()) return p; } catch { return null; }
    return [join(p, 'dist', 'cli.js'), join(p, 'packages', 'cli', 'dist', 'cli.js')].find((f) => existsSync(f)) || null;
  };
  const cli = [process.env.MFX_KINETOGRAPH, shared && join(resolve(shared, '..', '..'), 'tools', 'kinetograph', 'node_modules', 'kinetograph', 'dist', 'cli.js')]
    .filter(Boolean).map(asCli).find((p) => p && existsSync(p));
  const from = cli ? join(dirname(cli), '..', 'skills', 'kinetograph') : null;
  if (!from || !existsSync(join(from, 'SKILL.md'))) { console.log('kinetograph skill: the studio\'s Kinetograph install not found (skipped)'); return; }
  const to = join(dirname(here), 'kinetograph');
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const md = readFileSync(join(to, 'SKILL.md'), 'utf8');
  const end = md.startsWith('---') ? md.indexOf('\n---', 3) + 4 : 0;
  const note = '\n> **In the Mortiflix studio** the remotion-motion skill\'s rules win. Run the CLI as `kinetograph` (it is on the\n' +
    '> PATH; never `npx kinetograph`). `still`, `strip`, `onion` and `render` go through `mfx render --label ... -- kinetograph ...`;\n' +
    '> `lint`, `check`, `inspect`, `doctor` and `compositions` run directly. Don\'t start `kinetograph mcp` or `studio`. Write the\n' +
    '> Remotion API with DOM/CSS/SVG (the animatic\'s `tsc --noEmit` checks against Remotion\'s types, so Kinetograph-only\n' +
    '> elements such as `<Layer>`, `<Text>` and effects fail it).\n';
  writeFileSync(join(to, 'SKILL.md'), md.slice(0, end) + note + md.slice(end));
  console.log(`kinetograph skill: copied to ${to}`);
}


// A directory link. On Windows a junction: a symlink there needs Developer Mode or an administrator, a junction doesn't.
function link(to, at) { symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir'); }
function realpathOr(p) { try { return realpathSync(p); } catch { return p; } }
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function run(cmd, args, cwd) {
  // npm is npm.cmd on Windows, which only runs through a shell (these arguments are fixed flags, nothing to quote).
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`); process.exit(1); }
}
