// Pipelines: the harness. A pipeline is a folder:
//
//   pipeline.json   name, intake questions, the steps and how each is reviewed, status lines, the error checks
//   PIPELINE.md     how the work is made (read by every session)
//   checklist.md    (optional) the production checklist a session copies and ticks off
//   skills/<name>/SKILL.md   (optional) skills; they're installed into the project's .claude/skills
//
// See docs/PIPELINES.md for the full format. A project pins a snapshot of its pipeline when it's created, so editing
// a pipeline never changes a video that's already in production.
import { existsSync, readdirSync, readFileSync, statSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO, paths, readJson, UserError } from './studio.mjs';

export const REVIEW_MODES = ['questions', 'document', 'frames', 'video', 'audio', 'internal'];
export const WORK_KINDS = ['script', 'stills', 'motion', 'audio', 'music'];
// A step with "when" runs only if the studio and the brief want it (otherwise it's skipped when the project starts).
export const STEP_CONDITIONS = ['music'];
const KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function builtInDir() {
  return join(REPO, 'pipelines');
}

// Every pipeline this studio can use: the built-in ones plus the studio's own (same slug = the studio's wins).
export function listPipelines(root) {
  const found = new Map();
  for (const base of [builtInDir(), root ? paths(root).pipelines : null]) {
    if (!base || !existsSync(base)) continue;
    for (const slug of readdirSync(base).sort()) {
      if (slug.startsWith('_')) continue;
      const dir = join(base, slug);
      if (!existsSync(join(dir, 'pipeline.json'))) continue;
      try {
        found.set(slug, { ...loadPipeline(dir), dir, source: base === builtInDir() ? 'built-in' : 'studio' });
      } catch (e) {
        found.set(slug, { slug, dir, error: e.message, source: base === builtInDir() ? 'built-in' : 'studio' });
      }
    }
  }
  return [...found.values()];
}

export function findPipeline(root, slug) {
  const p = listPipelines(root).find((x) => x.slug === slug);
  if (!p) throw new UserError(`no pipeline "${slug}" (see: mortiflix pipelines)`);
  if (p.error) throw new UserError(`pipeline "${slug}" is invalid: ${p.error}`);
  return p;
}

export function loadPipeline(dir) {
  const def = readJson(join(dir, 'pipeline.json'));
  const errors = validatePipeline(def, dir);
  if (errors.length) throw new Error(errors.join('; '));
  return normalize(def, dir);
}

export function validatePipeline(def, dir) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(typeof def.slug === 'string' && KEY.test(def.slug), 'slug: lowercase letters, digits, - or _');
  need(typeof def.name === 'string' && def.name.trim(), 'name is required');
  need(Array.isArray(def.steps) && def.steps.length > 0, 'steps: at least one');
  if (dir) need(existsSync(join(dir, 'PIPELINE.md')), 'PIPELINE.md is missing');
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const keys = new Set();
  for (const s of steps) {
    need(KEY.test(s.key || ''), `step key "${s.key}": lowercase letters, digits, - or _`);
    need(!keys.has(s.key), `step "${s.key}" appears twice`);
    keys.add(s.key);
    need(REVIEW_MODES.includes(s.review), `step "${s.key}": review must be one of ${REVIEW_MODES.join(', ')}`);
    for (const w of s.work || []) need(WORK_KINDS.includes(w), `step "${s.key}": work "${w}" must be one of ${WORK_KINDS.join(', ')}`);
    if (s.when !== undefined) need(STEP_CONDITIONS.includes(s.when), `step "${s.key}": "when" must be one of ${STEP_CONDITIONS.join(', ')}`);
  }
  for (const s of steps) for (const a of s.after || []) need(keys.has(a), `step "${s.key}" runs after unknown step "${a}"`);
  if (errors.length === 0 && hasCycle(steps)) errors.push('the steps wait on each other in a loop');
  need(steps.filter((s) => s.delivers).length <= 1, 'only one step can be the delivery');
  for (const name of def.shared_skills || []) {
    need(KEY.test(name), `shared skill "${name}": lowercase letters, digits, - or _`);
    if (dir && KEY.test(name)) need(sharedSkillDir(dir, name), `shared skill "${name}" not found in _shared/skills`);
  }
  const ids = new Set();
  for (const c of def.checks || []) {
    need(KEY.test(c.id || ''), `check id "${c.id}": lowercase letters, digits, - or _`);
    need(!ids.has(c.id), `check "${c.id}" appears twice`);
    ids.add(c.id);
    need(c.title && c.how, `check "${c.id}" needs a title and how`);
  }
  const fields = new Set();
  for (const q of def.intake || []) {
    need(KEY.test(q.id || ''), `intake id "${q.id}": lowercase letters, digits, - or _`);
    need(!fields.has(q.id), `intake "${q.id}" appears twice`);
    fields.add(q.id);
    need(['text', 'long', 'choice', 'files'].includes(q.type || 'text'), `intake "${q.id}": type must be text, long, choice or files`);
    if (q.type === 'choice') need(Array.isArray(q.choices) && q.choices.length > 1, `intake "${q.id}": choices needs two or more`);
  }
  return errors;
}

function hasCycle(steps) {
  const after = new Map(steps.map((s) => [s.key, s.after || []]));
  const state = new Map();
  const visit = (k) => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const a of after.get(k) || []) if (visit(a)) return true;
    state.set(k, 2);
    return false;
  };
  return steps.some((s) => visit(s.key));
}

function normalize(def, dir) {
  // A step with no "after" waits on the step before it, so a plain list is a straight line.
  const steps = def.steps.map((s, i) => ({
    key: s.key,
    name: s.name || s.key,
    review: s.review,
    after: s.after ?? (i > 0 ? [def.steps[i - 1].key] : []),
    work: s.work || [],
    delivers: Boolean(s.delivers),
    describe: s.describe || '',
    ...(s.when ? { when: s.when } : {}),
  }));
  const last = steps[steps.length - 1];
  if (!steps.some((s) => s.delivers) && last.review !== 'internal') last.delivers = true;
  return {
    slug: def.slug,
    name: def.name,
    description: def.description || '',
    makes: def.makes || 'video',
    intake: (def.intake || []).map((q) => ({ type: 'text', ...q })),
    steps,
    status_lines: def.status_lines || {},
    checks: def.checks || [],
    shared_skills: def.shared_skills || [],
    hash: dir ? hashDir(dir, (def.shared_skills || []).map((n) => sharedSkillDir(dir, n)).filter(Boolean)) : null,
  };
}

// Skills several pipelines share live in <pipelines>/_shared/skills/<name> (the studio's own first, then built-in).
export function sharedSkillDir(pipelineDir, name) {
  for (const base of [join(pipelineDir, '..', '_shared', 'skills'), join(builtInDir(), '_shared', 'skills')]) {
    const d = join(base, name);
    if (existsSync(join(d, 'SKILL.md'))) return d;
  }
  return null;
}

// The checks a step runs: those that apply to the kinds of work it makes. Steps that make nothing run none.
export function checksForStep(pipeline, stepKey, studioChecks = []) {
  const step = pipeline.steps.find((s) => s.key === stepKey);
  if (!step || !step.work.length) return [];
  const all = [...pipeline.checks, ...studioChecks];
  return all.filter((c) => !c.applies_to?.length || c.applies_to.some((w) => step.work.includes(w)));
}

export function hashDir(dir, extra = []) {
  const h = createHash('sha256');
  const walk = (base, d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(base, full);
      else { h.update(relative(base, full)); h.update('\0'); h.update(readFileSync(full)); }
    }
  };
  walk(dir, dir);
  for (const d of extra) walk(join(d, '..'), d);
  return h.digest('hex').slice(0, 12);
}

// The pinned copy a project keeps: the pipeline folder plus its shared skills, under skills/.
export function snapshotPipeline(pipeline, dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(pipeline.dir, dest, { recursive: true, dereference: true });
  const def = readJson(join(dest, 'pipeline.json'));
  for (const name of pipeline.shared_skills || []) {
    cpSync(sharedSkillDir(pipeline.dir, name), join(dest, 'skills', name), { recursive: true, dereference: true });
  }
  // The snapshot is self-contained: its skills are now local.
  delete def.shared_skills;
  writeFileSync(join(dest, 'pipeline.json'), JSON.stringify(def, null, 2) + '\n');
}
