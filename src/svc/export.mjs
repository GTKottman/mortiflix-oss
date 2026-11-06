// Render and export (doc 39): where the video goes on each OS, the finished file kept in the project's record, and
// posting through publish.mjs (always after the owner confirms; the AI never posts).
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join, extname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { projectPaths, projectPipeline, loadProject, update, event, now } from '../projects.mjs';
import { settle } from '../gates.mjs';
import { UserError } from '../studio.mjs';
import { publishPlan, publish } from '../publish.mjs';

const unsafe = /[<>:"/\\|?*\x00-\x1f]+/g;
export const fileTitle = (t) => String(t || 'Video').replace(unsafe, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Video';

// The person's Videos folder (Windows: %USERPROFILE%\Videos; Mac: ~/Movies; Linux: XDG_VIDEOS_DIR, else ~/Videos).
export function videosDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return join(env.USERPROFILE || home, 'Videos');
  if (platform === 'darwin') return join(home, 'Movies');
  if (env.XDG_VIDEOS_DIR) return env.XDG_VIDEOS_DIR;
  try {
    const m = readFileSync(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8').match(/^XDG_VIDEOS_DIR="?([^"\n]+)"?/m);
    if (m) { const d = m[1].replace(/^\$HOME/, home); if (d !== home && d !== `${home}/`) return d; }
  } catch { /* no user-dirs */ }
  return join(home, 'Videos');
}

// Where a render goes: <Videos>/Mortiflix/<Project>/<Project>.<ext>, never over an existing file (" (2)").
export function exportTarget(root, id, { ext = 'mp4', name = null, stems = false, create = false, platform } = {}) {
  const project = loadProject(root, id);
  const title = fileTitle(project.title);
  const dir = join(videosDir({ platform }), 'Mortiflix', title);
  const e = String(ext || 'mp4').replace(/^\./, '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'mp4';
  const base = fileTitle(name || title);
  const pick = (n) => (stems ? join(dir, `${n} – Stems`) : join(dir, `${n}.${e}`));
  let file = pick(base);
  for (let i = 2; existsSync(file); i++) file = pick(`${base} (${i})`);
  if (create) mkdirSync(stems ? file : dir, { recursive: true });
  const plat = platform || process.platform;
  return { dir, file, name: basename(file), reveal: plat === 'win32' ? 'Show in Explorer' : plat === 'darwin' ? 'Show in Finder' : 'Show in Files' };
}

// A finished render from the app: copied into the project's record (reviews/<final>/rendered-N.<ext>) so the project
// keeps it even if the person moves the file, and the project is delivered.
export function deliverFromApp(root, id, { file, preset = null, timeline_rev = null }) {
  if (typeof file !== 'string' || !isAbsolute(file) || !existsSync(file)) throw new UserError('export.done needs the rendered file (an absolute path)');
  const real = realpathSync(file);
  if (!statSync(real).isFile()) throw new UserError('that render is not a file');
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.delivers) || pipeline.steps.at(-1);
  const dir = join(pp.reviews, step.key);
  mkdirSync(dir, { recursive: true });
  const ext = extname(real).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  let n = 1;
  while (existsSync(join(dir, `rendered-${n}${ext}`))) n++;
  copyFileSync(real, join(dir, `rendered-${n}${ext}`));
  const rel = `reviews/${step.key}/rendered-${n}${ext}`;
  const size = statSync(real).size;
  const r = update(root, id, (p) => {
    p.steps[step.key] = { ...(p.steps[step.key] || {}), state: 'approved', delivered_from: 'app', decided_at: now() };
    for (const s of pipeline.steps) if (!['approved', 'done', 'skipped'].includes(p.steps[s.key]?.state)) p.steps[s.key] = { ...(p.steps[s.key] || {}), state: 'skipped', by: 'app' };
    p.deliverables = [{ label: `${step.name} (rendered in the app${preset ? `, ${String(preset).slice(0, 80)}` : ''})`, kind: /\.(wav|mp3|flac|aiff?)$/.test(ext) ? 'audio' : 'video', file: rel, size, copy: real, timeline_rev }];
    if (['paused', 'draft'].includes(p.state)) p.state = 'queued';
    settle(p, pipeline);
    return { delivered: rel, copy: real, project_state: p.state };
  });
  event(root, id, { event: 'DELIVERED_FROM_APP', actor: 'you', step: step.key, details: `${basename(real)}${preset ? ` (${preset})` : ''}` });
  return r;
}

// Post… (doc 39): the plan first (what, where, when), then the send, only with confirm: true from the owner's click.
export function postPlan(root, id, opts = {}) {
  return publishPlan(root, id, { to: opts.to, profile: opts.profile, title: opts.title, description: opts.description, at: opts.at, timezone: opts.timezone, again: Boolean(opts.again) });
}

export async function postSend(root, id, { confirm, by, ...opts } = {}) {
  if (confirm !== true) throw new UserError('posting needs the owner\'s confirm: true');
  if (by === 'ai') throw new UserError('the AI never posts: the owner presses Post');
  const plan = postPlan(root, id, opts);
  const r = await publish(root, plan);
  event(root, id, { event: 'POSTED', actor: 'you', details: `${plan.platforms.join(', ')} via ${plan.service}` });
  return r;
}
