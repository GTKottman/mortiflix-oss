// The video project's scaffold: every template file (video/src/index.ts, Root.tsx, Main.tsx, video.ts, package.json,
// tsconfig.json) that is missing is copied from the remotion-motion template; nothing that exists is overwritten.
// (2026-11-02, Director 2: style frames failed 4x with "no such file: src/index.ts". The asset pool writes video/src/pool.ts
// before the frames step, and setup.mjs started from the template only when video/src did not exist yet, so a v3 project
// never got its entry file.) Called before every render of frames, stills and the animatic.
import { existsSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runAsync } from './run.mjs';

export const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pipelines', '_shared', 'skills', 'remotion-motion', 'template');

// Only the entry and the package files: Root.tsx, format.ts and frames.tsx are the studio's (quickframes.mjs), Main.tsx
// the animatic's, video.ts the AI's look.
export const SCAFFOLD = ['src/index.ts', 'package.json', 'tsconfig.json'];
export function ensureVideoScaffold(work, { template = TEMPLATE } = {}) {
  if (!existsSync(template)) return [];
  const out = [];
  for (const f of SCAFFOLD) { const a = join(template, f); const b = join(work, 'video', f); if (existsSync(a) && !existsSync(b)) { mkdirSync(dirname(b), { recursive: true }); cpSync(a, b); out.push(f); } }
  return out;
}

// ---- the packages the type check needs (2026-11-02, Dir2 d4fd Motion: "src/pool.ts: cannot find module '@remotion/fonts'":
// the studio's pool.ts and the transitions library import it, the template did not list it). Kinetograph renders without
// any package; tsc needs each one's types. Every template dependency must resolve in video/node_modules; when one does
// not (a project linked to an older shared install), the studio's own setup.mjs (the current template) moves the project
// to the current shared install, installing it once per studio.
export function missingModules(work, { template = TEMPLATE } = {}) {
  let tpl;
  try { tpl = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')); } catch { return []; }
  const nm = join(work, 'video', 'node_modules');
  return Object.keys({ ...tpl.dependencies, ...tpl.devDependencies }).filter((dep) => !existsSync(join(nm, dep, 'package.json')));
}
export async function ensureVideoModules(work, { shared = null, env = {}, template = TEMPLATE, run = runAsync } = {}) {
  const miss = missingModules(work, { template });
  if (!miss.length) return { ok: true, added: [] };
  const r = await run(process.execPath, [join(dirname(template), 'setup.mjs')], { cwd: work, env: { ...process.env, ...env, ...(shared ? { MFX_SHARED: shared } : {}) }, encoding: 'utf8', timeout: 15 * 60_000 });
  const still = missingModules(work, { template });
  return { ok: !still.length, added: miss.filter((m) => !still.includes(m)), missing: still, log: `${r?.stdout || ''}${r?.stderr || ''}`.slice(-600) };
}
