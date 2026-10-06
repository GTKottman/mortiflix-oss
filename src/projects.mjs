// Projects on disk. Two folders per project:
//   projects/<id>/  the working folder: the session runs here and writes whatever it makes
//   state/<id>/     the record: project.json, events.jsonl, the pinned pipeline, every submitted version and your
//                   feedback. Only Mortiflix writes here (the session talks to it through `mfx`), so what you
//                   reviewed and approved can't be changed after the fact.
import { existsSync, mkdirSync, readdirSync, appendFileSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { paths, readJson, writeJson, withLock, UserError, loadConfig } from './studio.mjs';
import { musicConfig } from './setup.mjs';
import { findPipeline, loadPipeline, snapshotPipeline } from './pipelines.mjs';

export const STATES = ['draft', 'queued', 'waiting', 'paused', 'delivered', 'cancelled'];

export function projectPaths(root, id) {
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new UserError(`bad project id "${id}"`);
  const p = paths(root);
  const state = join(p.state, id);
  return {
    work: join(p.projects, id),
    state,
    file: join(state, 'project.json'),
    events: join(state, 'events.jsonl'),
    pipeline: join(state, 'pipeline'),
    reviews: join(state, 'reviews'),
    sessions: join(state, 'sessions'),
    lock: join(state, '.lock'),
  };
}

export function newId(title) {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const slug = String(title || 'video').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'video';
  return `${ymd}-${slug}-${randomBytes(2).toString('hex')}`;
}

export function createProject(root, { pipeline: slug, title, answers = {}, backend = null }) {
  const pipeline = findPipeline(root, slug);
  title = String(title || '').trim() || pipeline.name;
  const id = newId(title);
  const pp = projectPaths(root, id);
  mkdirSync(pp.work, { recursive: true });
  mkdirSync(pp.reviews, { recursive: true });
  mkdirSync(pp.sessions, { recursive: true });
  snapshotPipeline(pipeline, pp.pipeline);
  const clean = {};
  for (const q of pipeline.intake) {
    if (q.type === 'files') continue;
    const v = answers[q.id];
    if (v === undefined || v === null || v === '') continue;
    if (q.type === 'choice' && !q.choices.includes(v)) throw new UserError(`"${q.label || q.id}" must be one of: ${q.choices.join(', ')}`);
    clean[q.id] = String(v).slice(0, 20_000);
  }
  const project = {
    id,
    title,
    pipeline: { slug: pipeline.slug, name: pipeline.name, hash: pipeline.hash, makes: pipeline.makes },
    state: 'draft',
    backend,
    created_at: now(),
    queued_at: null,
    intake: { answers: clean, files: [] },
    steps: {},
    questions: [],
    status: null,
    needs_you: null,
    session: null,
    deliverables: [],
    no_progress: 0,
    usage: { sessions: 0, input_tokens: 0, output_tokens: 0 },
  };
  writeJson(pp.file, project);
  event(root, id, { event: 'CREATED', actor: 'you', details: `${pipeline.name}: ${title}` });
  return project;
}

// A file you hand over with the brief. It lands in the working folder's input/<field>/.
export async function addIntakeFile(root, id, { field, name, stream, buffer }) {
  const pp = projectPaths(root, id);
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const q = pipeline.intake.find((x) => x.id === field && x.type === 'files');
  if (!q) throw new UserError(`"${field}" isn't a file question in this pipeline`);
  if (project.state !== 'draft') throw new UserError('files can only be added before the project starts');
  const safe = safeName(name);
  const dir = join(pp.work, 'input', field);
  mkdirSync(dir, { recursive: true });
  let file = join(dir, safe);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${basename(safe, extname(safe))}-${i}${extname(safe)}`);
  if (buffer) writeFileSync(file, buffer);
  else await streamPipeline(stream, createWriteStream(file));
  const rel = `input/${field}/${basename(file)}`;
  update(root, id, (p) => { p.intake.files.push({ field, name: basename(file), path: rel }); });
  return rel;
}

export function startProject(root, id) {
  const pipeline = projectPipeline(root, id);
  const p = update(root, id, (p) => {
    if (p.state !== 'draft') throw new UserError(`already started (${p.state})`);
    for (const q of pipeline.intake) {
      if (!q.required) continue;
      const ok = q.type === 'files' ? p.intake.files.some((f) => f.field === q.id) : Boolean(p.intake.answers[q.id]);
      if (!ok) throw new UserError(`"${q.label || q.id}" is required`);
    }
    // Steps that only run when wanted: music needs the studio's music on and a brief that doesn't say "no music".
    const noMusic = musicConfig(loadConfig(root)).engine === 'none' || /^\s*(no|none|off)\b/i.test(String(p.intake.answers.music ?? ''));
    for (const s of pipeline.steps) {
      if (s.when === 'music' && noMusic) { p.steps ||= {}; p.steps[s.key] = { state: 'skipped' }; }
    }
    p.state = 'queued';
    p.queued_at = now();
  });
  event(root, id, { event: 'STARTED', actor: 'you' });
  return p;
}

export function loadProject(root, id) {
  const pp = projectPaths(root, id);
  if (!existsSync(pp.file)) throw new UserError(`no project "${id}"`);
  return readJson(pp.file);
}

export function listProjects(root) {
  const dir = paths(root).state;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, 'project.json')))
    .map((id) => { try { return readJson(join(dir, id, 'project.json')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// Every change to a project goes through here: locked, so the web UI, the CLI and the runner never clobber each other.
export function update(root, id, fn) {
  const pp = projectPaths(root, id);
  return withLock(pp.lock, () => {
    const p = readJson(pp.file);
    const out = fn(p);
    p.updated_at = now();
    writeJson(pp.file, p);
    return out === undefined ? p : out;
  });
}

export function projectPipeline(root, id) {
  return loadPipeline(projectPaths(root, id).pipeline);
}

// The project log: append-only, one JSON object per line.
export function event(root, id, { event: name, actor = 'studio', step = null, version = null, details = '' }) {
  const pp = projectPaths(root, id);
  const row = { t: now(), event: name, actor, step, version, details: String(details ?? '').slice(0, 4000) };
  appendFileSync(pp.events, JSON.stringify(row) + '\n');
  return row;
}

export function readEvents(root, id, { limit = 500 } = {}) {
  const pp = projectPaths(root, id);
  if (!existsSync(pp.events)) return [];
  const lines = readFileSync(pp.events, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function readJournal(root, id, { tailChars = 6000 } = {}) {
  const f = join(projectPaths(root, id).work, 'JOURNAL.md');
  if (!existsSync(f)) return '';
  const t = readFileSync(f, 'utf8');
  return t.length > tailChars ? `…\n${t.slice(-tailChars)}` : t;
}

export function safeName(name) {
  const base = basename(String(name || 'file')).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return base || 'file';
}

export function now() {
  return new Date().toISOString();
}
