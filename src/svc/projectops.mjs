// Project housekeeping from Home's ⋯ menu: rename, duplicate, delete (a soft delete into the studio's trash) and restore.
//   project.rename    {project, title}         the title the app, the canvas and the session see
//   project.duplicate {project, upto?: step|all} a new project with the brief and script (and, with `upto`, the approved
//                                              steps up to that one); no session and no paid call: the copy starts paused
//   project.delete    {project}                moves state/<id> and projects/<id> to <studio>/trash/<stamp>-<id>/
//   project.restore   {project}                moves the newest trashed copy back (the Undo of a delete)
// Delete and restore refuse while a session is running on the project.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { paths, readJson, writeJson, UserError } from '../studio.mjs';
import { loadProject, projectPaths, projectPipeline, update, event, newId } from '../projects.mjs';

const TITLE_MAX = 120;
const KEPT_STATES = ['approved', 'done', 'skipped'];
const now = () => new Date().toISOString();
const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

export const trashDir = (root) => join(root, 'trash');

// project.rename: the title lives in project.json; every view reads it from there.
export function renameProject(root, id, title) {
  const t = cleanTitle(title);
  if (!t) throw new UserError('a project needs a name');
  const before = loadProject(root, id).title;
  if (t === before) return { project: id, title: t, before };
  update(root, id, (p) => { p.title = t; });
  event(root, id, { event: 'RENAMED', actor: 'you', details: `${before} → ${t}` });
  return { project: id, title: t, before };
}

// Work files each step writes (relative to projects/<id>/). A copy leaves out the ones of steps it does not keep.
const STEP_WORK = {
  script: ['script', 'script.md'],
  voice: ['voice', 'sound/voice', 'music', 'out/voice'],
  'style-frames': ['design/frames', 'design/frames.json'],
  stills: ['stills'],
  animatic: ['out', 'transitions'],
  sound: ['sound'],
  artcraft: ['artcraft', 'final'],
};
// Canvas node kinds each step makes. A shot is planned by the script; its versions (videos) come from the animatic.
const STEP_KINDS = { voice: ['line', 'cue'], 'style-frames': ['frame'], animatic: ['transition'] };
// Never copied: the copy has its own log, chat and sessions.
const STATE_SKIP = new Set(['sessions', 'chat.jsonl', 'chat.cursor', 'events.jsonl', '.lock', 'canvas', 'options.json']);
const WORK_SKIP = new Set(['JOURNAL.md', 'feedback']);

// The steps a copy keeps: brief and script always (in whatever state), then each later step up to `upto` while it is
// approved, done or skipped. `upto` is a step of the project's pipeline, or "all" (every step it has OK'd).
function keptSteps(project, pipeline, upto) {
  const keys = pipeline.steps.map((s) => s.key);
  const last = upto === 'all' ? keys.length - 1 : upto ? keys.indexOf(upto) : keys.indexOf('script');
  if (upto && last < 0) throw new UserError(`no step "${upto}" in this project (${keys.join(', ')})`);
  const kept = [];
  for (const [i, k] of keys.entries()) {
    if (i > Math.max(last, keys.indexOf('script'))) break;
    const rec = project.steps?.[k];
    if (k === 'brief' || k === 'script') { kept.push(k); continue; }
    if (!rec || !KEPT_STATES.includes(rec.state)) break;
    kept.push(k);
  }
  return kept;
}

// A path is left out when a dropped step owns it, unless a kept step owns a path inside it (out/voice inside out).
function dropWork(rel, kept, dropped) {
  const own = (list) => list.some((k) => (STEP_WORK[k] || []).some((w) => rel === w || rel.startsWith(`${w}/`) || w.startsWith(`${rel}/`)));
  const ownsExactly = (list) => list.some((k) => (STEP_WORK[k] || []).some((w) => rel === w || rel.startsWith(`${w}/`)));
  if (!ownsExactly(dropped)) return false;
  // a dropped step owns rel; keep it only when a kept step owns rel or something under it
  return !own(kept);
}

export function duplicateProject(root, id, { upto = null, title = null } = {}) {
  const src = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const kept = keptSteps(src, pipeline, upto ? String(upto) : null);
  const dropped = pipeline.steps.map((s) => s.key).filter((k) => !kept.includes(k));
  const name = cleanTitle(title) || cleanTitle(`${src.title} (copy)`);
  const nid = newId(name);
  const from = projectPaths(root, id);
  const to = projectPaths(root, nid);
  const at = now();

  // the record: brief, pinned pipeline, skills, the reviews of kept steps
  mkdirSync(to.state, { recursive: true });
  for (const f of readdirSync(from.state)) {
    if (STATE_SKIP.has(f) || f === 'project.json') continue;
    if (f === 'reviews') {
      for (const k of kept) if (existsSync(join(from.reviews, k))) cpSync(join(from.reviews, k), join(to.reviews, k), { recursive: true });
      continue;
    }
    cpSync(join(from.state, f), join(to.state, f), { recursive: true });
  }
  mkdirSync(to.reviews, { recursive: true });
  mkdirSync(to.sessions, { recursive: true });

  // the working folder, without the files of dropped steps
  if (existsSync(from.work)) {
    cpSync(from.work, to.work, {
      recursive: true,
      filter: (s) => {
        const rel = relative(from.work, s).split(sep).join('/');
        if (!rel) return true;
        if (WORK_SKIP.has(rel)) return false;
        return !dropWork(rel, kept, dropped);
      },
    });
    // feedback of kept steps only
    const fb = join(from.work, 'feedback');
    if (existsSync(fb)) {
      for (const f of readdirSync(fb)) {
        const step = f.replace(/-v\d+\.json$/, '');
        if (kept.includes(step)) { mkdirSync(join(to.work, 'feedback'), { recursive: true }); cpSync(join(fb, f), join(to.work, 'feedback', f)); }
      }
    }
  } else mkdirSync(to.work, { recursive: true });

  copyCanvas(root, id, nid, kept, dropped);
  copyOptions(from.state, to.state, pipeline, kept);

  const steps = {};
  for (const k of kept) if (src.steps?.[k]) steps[k] = src.steps[k];
  const all = dropped.length === 0;
  const p = {
    ...src,
    id: nid,
    title: name,
    created_at: at,
    queued_at: null,
    updated_at: at,
    steps,
    session: null,
    state: 'paused',
    needs_you: { text: `A copy of "${src.title}". Press Resume when Mortiflix should make the next step.`, at, by_you: true },
    deliverables: all ? src.deliverables || [] : [],
    no_progress: 0,
    last_failure: null,
    canvas_edits: 0,
    copied_from: { project: id, title: src.title, kept, at },
  };
  delete p.usage;
  if (p.mfx) delete p.mfx.samples_wanted;
  writeJson(to.file, p);
  event(root, nid, { event: 'DUPLICATED', actor: 'you', details: `from ${src.title} (${id}), kept ${kept.join(', ')}` });
  return { project: nid, title: name, from: id, kept };
}

function copyCanvas(root, id, nid, kept, dropped) {
  const fromDir = join(projectPaths(root, id).state, 'canvas');
  const toDir = join(projectPaths(root, nid).state, 'canvas');
  const graphFile = join(fromDir, 'graph.json');
  if (!existsSync(graphFile)) return;
  const g = readJson(graphFile);
  const dropKinds = new Set(dropped.flatMap((k) => STEP_KINDS[k] || []));
  const noShotVideos = dropped.includes('animatic');
  const nodes = {};
  const gone = new Set();
  for (const [nidKey, n] of Object.entries(g.nodes || {})) {
    if (dropKinds.has(n.kind)) { gone.add(nidKey); continue; }
    nodes[nidKey] = n.kind === 'shot' && noShotVideos ? { ...n, versions: [], current: null } : n;
    if (n.kind === 'shot' && noShotVideos) gone.add(nidKey); // its media are videos
  }
  const order = {};
  for (const [k, list] of Object.entries(g.order || {})) order[k] = Array.isArray(list) ? list.filter((x) => nodes[x]) : list;
  mkdirSync(join(toDir, 'media'), { recursive: true });
  writeJson(join(toDir, 'graph.json'), { ...g, project: nid, nodes, order, problems: [] });
  const ownerFile = join(fromDir, 'owner.json');
  if (existsSync(ownerFile)) {
    const o = readJson(ownerFile);
    const decisions = Object.fromEntries(Object.entries(o.decisions || {}).filter(([k]) => nodes[k] && !(gone.has(k) && nodes[k].kind !== 'shot')));
    writeJson(join(toDir, 'owner.json'), { ...o, decisions });
  }
  const media = join(fromDir, 'media');
  if (existsSync(media)) for (const m of readdirSync(media)) if (nodes[m] && !gone.has(m)) cpSync(join(media, m), join(toDir, 'media', m), { recursive: true });
}

// The AI's options rows of kept stages ("script|b01").
function copyOptions(fromState, toState, pipeline, kept) {
  const f = join(fromState, 'options.json');
  if (!existsSync(f)) return;
  let o;
  try { o = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
  const names = new Set(pipeline.steps.filter((s) => kept.includes(s.key)).flatMap((s) => [s.key, s.stage].filter(Boolean)));
  const entries = Object.fromEntries(Object.entries(o.entries || {}).filter(([k]) => names.has(k.split('|')[0])));
  writeJson(join(toState, 'options.json'), { ...o, entries });
}

const busy = (p) => p.session !== null && p.session !== undefined;

// project.delete: both folders go to trash/<stamp>-<id>/ (state, work) with a note of what it was.
export function trashProject(root, id) {
  const p = loadProject(root, id);
  if (busy(p)) throw new UserError(`"${p.title}" is being made right now: stop it before deleting`);
  const pp = projectPaths(root, id);
  const stamp = now().replace(/[:.]/g, '-');
  const dir = join(trashDir(root), `${stamp}-${id}`);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'trashed.json'), { project: id, title: p.title, deleted_at: now() });
  move(pp.state, join(dir, 'state'));
  if (existsSync(pp.work)) move(pp.work, join(dir, 'work'));
  return { deleted: id, title: p.title, trash: dir };
}

// project.restore: the newest trashed copy of the project comes back, unless a project with that id exists again.
export function restoreProject(root, id) {
  const pp = projectPaths(root, id);
  if (existsSync(pp.file)) throw new UserError(`"${id}" is not deleted`);
  const t = trashDir(root);
  const found = existsSync(t) ? readdirSync(t).filter((d) => d.endsWith(`-${id}`) && existsSync(join(t, d, 'state', 'project.json'))).sort() : [];
  if (!found.length) throw new UserError(`"${id}" is not in the trash`);
  const dir = join(t, found.at(-1));
  mkdirSync(paths(root).state, { recursive: true });
  mkdirSync(paths(root).projects, { recursive: true });
  move(join(dir, 'state'), pp.state);
  if (existsSync(join(dir, 'work'))) move(join(dir, 'work'), pp.work);
  rmSync(dir, { recursive: true, force: true });
  const p = loadProject(root, id);
  event(root, id, { event: 'RESTORED', actor: 'you' });
  return { restored: id, title: p.title };
}

// A rename, or a copy and remove when the trash is on another disk.
function move(a, b) {
  try { renameSync(a, b); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(a, b, { recursive: true, preserveTimestamps: true });
    rmSync(a, { recursive: true, force: true });
  }
}
