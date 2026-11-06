// Pipelines: the harness. A pipeline is a folder:
//
//   pipeline.json   name, intake questions, the steps and how each is reviewed, status lines, the error checks
//   PIPELINE.md     how the work is made (read by every session)
//   checklist.md    (optional) the production checklist a session copies and ticks off
//   skills/<name>/SKILL.md   (optional) skills; they're installed into the project's .claude/skills
//
// See docs/PIPELINES.md for the full format. A project pins a snapshot of its pipeline when it's created, so editing
// a pipeline never changes a video that's already in production.
import { existsSync, readdirSync, readFileSync, statSync, cpSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO, paths, readJson, UserError } from './studio.mjs';
import { zip, unzip, dirEntries } from './zip.mjs';

export const REVIEW_MODES = ['questions', 'document', 'frames', 'video', 'audio', 'internal'];
export const WORK_KINDS = ['script', 'stills', 'motion', 'audio', 'music', 'research', 'plan', 'instruments'];
// A step with "when" runs only if the studio and the brief want it (otherwise it's skipped when the project starts).
export const STEP_CONDITIONS = ['music', 'voice'];
export const CANVAS_KINDS = ['beat', 'line', 'frame', 'transition', 'shot'];
// The Mortiflix Studio stages a step can be shown under (`stage` on a step; otherwise worked out from its key).
export const V3_STAGE_KEYS = ['script', 'voiceMusic', 'look', 'stills', 'motion', 'sound', 'artcraft'];
export const STAGE_KEYS = ['script', 'voice', 'styleFrames', 'transitions', 'animatic', 'music', 'edit', 'render'];
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
  // code: the app tells this refusal apart by its code, not by the words (the message stays as it was)
  if (!p) throw Object.assign(new UserError(`no pipeline "${slug}" (see: mortiflix pipelines)`), { code: 'no_pipeline' });
  if (p.error) throw new UserError(`pipeline "${slug}" is invalid: ${p.error}`);
  return p;
}

export function loadPipeline(dir, { lenient = false } = {}) {
  const def = readJson(join(dir, 'pipeline.json'));
  if (lenient) dropBadSteps(def, dir);
  const errors = validatePipeline(def, dir);
  if (errors.length) throw new Error(errors.join('; '));
  return normalize(def, dir);
}

// One step's own checks (no other step involved).
function stepErrors(s, def) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(KEY.test(s.key || ''), `step key "${s.key}": lowercase letters, digits, - or _`);
  need(REVIEW_MODES.includes(s.review), `step "${s.key}": review must be one of ${REVIEW_MODES.join(', ')}`);
  for (const w of s.work || []) need(WORK_KINDS.includes(w), `step "${s.key}": work "${w}" must be one of ${WORK_KINDS.join(', ')}`);
  if (s.when !== undefined) need(STEP_CONDITIONS.includes(s.when), `step "${s.key}": "when" must be one of ${STEP_CONDITIONS.join(', ')}`);
  if (s.canvas !== undefined) need(CANVAS_KINDS.includes(s.canvas), `step "${s.key}": "canvas" must be one of ${CANVAS_KINDS.join(', ')}`);
  if (s.off !== undefined) need(typeof s.off === 'boolean', `step "${s.key}": "off" must be true or false`);
  if (s.off === true) need(!s.delivers, `step "${s.key}": the delivering step always runs`);
  if (s.stage !== undefined) { const ok = def.stage_set === 'v3' ? V3_STAGE_KEYS : STAGE_KEYS; need(ok.includes(s.stage), `step "${s.key}": "stage" must be one of ${ok.join(', ')}`); }
  return errors;
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
    for (const e of stepErrors(s, def)) errors.push(e);
    need(!keys.has(s.key), `step "${s.key}" appears twice`);
    keys.add(s.key);
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
    // A canvas step: once sent, the steps after it go ahead while the owner reviews its pieces on the canvas.
    ...(s.canvas ? { canvas: s.canvas } : {}),
    // This step waits until every step before it is approved (the final render waits for the owner's OK).
    ...(s.waits_for_approval ? { waits_for_approval: true } : {}),
    // A preset can turn a step off: it is skipped when the project starts (the AI still decides that part).
    ...(s.off ? { off: true } : {}),
    ...(s.stage ? { stage: s.stage } : {}),
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
    stage_set: def.stage_set === 'v3' ? 'v3' : null,
    checks: def.checks || [],
    shared_skills: def.shared_skills || [],
    // What a preset carries beyond its intake defaults (the preset creator, doc 31): the look, the voice and the
    // music theme, and the preset it was copied from.
    ...(def.look ? { look: def.look } : {}),
    ...(def.voice ? { voice: def.voice } : {}),
    ...(def.music_theme ? { music_theme: def.music_theme } : {}),
    ...(def.based_on ? { based_on: def.based_on } : {}),
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

// Sharing a pipeline: one self-contained zip (the folder plus the shared skills it uses, as its own skills/), the same
// shape a project pins. `mortiflix pipelines export <slug>` writes it; `mortiflix pipelines add <zip|https url>` puts
// one into the studio's pipelines/ folder after checking every path and validating it.
export function exportPipeline(root, slug) {
  const p = findPipeline(root, slug);
  const tmp = mkdtempSync(join(tmpdir(), 'mfx-export-'));
  try {
    snapshotPipeline(p, join(tmp, p.slug));
    return { slug: p.slug, name: p.name, hash: p.hash, zip: zip(dirEntries(join(tmp, p.slug), p.slug)) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function addPipeline(root, buf, { replace = false } = {}) {
  const entries = unzip(buf, { maxBytes: 100 * 1024 * 1024 });
  const top = entries.find((e) => /^([^/]+\/)?pipeline\.json$/.test(e.name));
  if (!top) throw new UserError('no pipeline.json in that zip (a shared pipeline is a folder with pipeline.json and PIPELINE.md)');
  const prefix = top.name.slice(0, -'pipeline.json'.length);
  const tmp = mkdtempSync(join(tmpdir(), 'mfx-add-'));
  try {
    const files = [];
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue;
      const rel = e.name.slice(prefix.length);
      if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((x) => x === '..' || x === '' || x === '.')) throw new UserError(`unsafe path in the zip: ${e.name}`);
      const dest = join(tmp, 'p', rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, e.data);
      files.push(rel);
    }
    const def = loadPipeline(join(tmp, 'p'));
    const dest = join(paths(root).pipelines, def.slug);
    const exists = existsSync(dest);
    if (exists && !replace) throw new UserError(`this studio already has a pipeline "${def.slug}" (add --replace to swap it)`);
    const builtIn = existsSync(join(builtInDir(), def.slug, 'pipeline.json'));
    mkdirSync(paths(root).pipelines, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(tmp, 'p'), dest, { recursive: true });
    return { slug: def.slug, name: def.name, files: files.sort(), replaced: exists, overrides_built_in: builtIn,
      scripts: files.filter((f) => /\.(mjs|js|cjs|py|sh)$/.test(f)) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// Your own preset (the pencil by Preset in New project): a copy of a pipeline in the studio's pipelines/ folder with
// your name, description and default answers (any value, your own words included). Shared skills stay shared. Saving
// again under the same name replaces your copy; a built-in pipeline is never changed.
export function savePreset(root, fromSlug, { name, description, defaults = {}, replace = false } = {}) {
  const src = findPipeline(root, fromSlug);
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new UserError('give the preset a name');
  const slug = clean.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset';
  const dest = join(paths(root).pipelines, slug);
  if (existsSync(join(builtInDir(), slug, 'pipeline.json'))) throw new UserError(`"${clean}" is the name of a built-in preset: pick another name`);
  if (existsSync(dest) && !replace && dest !== src.dir) throw new UserError(`you already have a preset called "${clean}"`);
  const tmp = mkdtempSync(join(tmpdir(), 'mfx-preset-'));
  try {
    cpSync(src.dir, join(tmp, 'p'), { recursive: true, dereference: true });
    const def = readJson(join(tmp, 'p', 'pipeline.json'));
    def.slug = slug;
    def.name = clean;
    if (description !== undefined) def.description = String(description).slice(0, 1000);
    for (const q of def.intake || []) {
      if (!(q.id in defaults) || q.type === 'files') continue;
      const v = defaults[q.id] === null || defaults[q.id] === undefined ? '' : String(defaults[q.id]).slice(0, q.type === 'long' ? 20_000 : 500);
      if (!v.trim()) { delete q.default; continue; }
      if (q.type === 'choice' && !q.choices.includes(v)) {
        if (q.custom === false) throw new UserError(`"${q.label || q.id}" must be one of: ${q.choices.join(', ')}`);
        q.choices = [...q.choices, v];
      }
      q.default = v;
    }
    def.based_on = src.based_on || src.slug;
    writeFileSync(join(tmp, 'p', 'pipeline.json'), JSON.stringify(def, null, 2) + '\n');
    loadPipeline(join(tmp, 'p'));
    mkdirSync(paths(root).pipelines, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(tmp, 'p'), dest, { recursive: true });
    return { slug, name: clean };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}


// ---- Migrating a project's pinned pipeline copy -------------------------------------------------------------------
// Steps that were removed from the built-in pipelines. A project made before the removal still pins a copy that has
// them, so loading that copy drops them (once, on disk) instead of failing the whole project.
// 'stills' (owner, 2026-11-04: "All of these looks ARE frames the step is reduntent"): the approved Look frames are
// what Motion builds from; projects already in Stills move on to Motion.
export const REMOVED_STEPS = ['layout-frames', 'stills'];
// Skill folders that only existed for a removed step (project copies; the project owns no other data in them).
export const REMOVED_SKILLS = ['moss-layout'];

const warned = new Set();
const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); console.warn(`[pipeline] ${msg}`); } };

// Take the steps whose keys are in `drop` out of def.steps, in place. Anything that waited on a dropped step waits on
// what the dropped step waited on; a step with no "after" waited on the step before it, which is made explicit first.
function removeSteps(def, drop) {
  const steps = def.steps;
  const resolved = new Map(steps.map((s, i) => [s.key, s.after ?? (i > 0 ? [steps[i - 1].key] : [])]));
  const through = (keys, seen = new Set()) => keys.flatMap((k) => {
    if (!drop.has(k)) return [k];
    if (seen.has(k)) return [];
    seen.add(k);
    return through(resolved.get(k) || [], seen);
  });
  def.steps = steps.filter((s) => !drop.has(s.key));
  for (const s of def.steps) {
    const before = resolved.get(s.key);
    if (s.after === undefined && !before.some((k) => drop.has(k))) continue;
    s.after = [...new Set(through(before))];
  }
  // Any other list of step keys (gates, stage maps) loses them too: string entries, and object keys named after them.
  const scrub = (v) => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) { if (typeof v[i] === 'string' && drop.has(v[i])) v.splice(i, 1); else scrub(v[i]); }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { if (drop.has(k)) delete v[k]; else scrub(v[k]); }
    }
  };
  for (const k of Object.keys(def)) if (k !== 'steps') scrub(def[k]);
  for (const s of def.steps) for (const k of Object.keys(s)) if (k !== 'after') scrub(s[k]);
}

// A step that fails its own checks is logged and skipped, never fatal for the project. (In memory only.)
function dropBadSteps(def, dir) {
  if (!Array.isArray(def.steps)) return;
  def.steps = def.steps.filter((s) => s && typeof s === 'object');
  const bad = new Set();
  for (const s of def.steps) {
    const errs = stepErrors(s, def);
    if (errs.length) { bad.add(s.key); warnOnce(`${dir}: skipping step "${s.key}": ${errs.join('; ')}`); }
  }
  if (bad.size) removeSteps(def, bad);
}

// Bring a project's pinned pipeline up to date: drop REMOVED_STEPS (rewriting pipeline.json once, the old file kept as
// pipeline.json.bak-<date>) and remove the stale copied skill folders from the pipeline copy, the record and the working
// folder. Reviews and state for removed steps stay where they are. Returns true when it changed anything.
export function migrateProjectPipeline(pipelineDir, workDir = null, { log = warnOnce } = {}) {
  const file = join(pipelineDir, 'pipeline.json');
  if (!existsSync(file)) return false;
  let changed = false;
  let def;
  try { def = readJson(file); } catch (e) { log(`${file}: cannot read (${e.message})`); return false; }
  if (Array.isArray(def.steps) && def.steps.some((s) => REMOVED_STEPS.includes(s?.key))) {
    const gone = def.steps.filter((s) => REMOVED_STEPS.includes(s?.key)).map((s) => s.key);
    const bak = `${file}.bak-${new Date().toISOString().slice(0, 10)}`;
    try {
      if (!existsSync(bak)) cpSync(file, bak);
      removeSteps(def, new Set(REMOVED_STEPS));
      if (def.status_lines?.layout && !def.steps.some((x) => x.canvas === 'layout')) delete def.status_lines.layout;
      writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
      log(`${pipelineDir}: dropped removed step(s) ${gone.join(', ')} (old file: ${bak})`);
      changed = true;
    } catch (e) { log(`${file}: migration failed (${e.message})`); }
  }
  const stale = [];
  for (const name of REMOVED_SKILLS) {
    stale.push(join(pipelineDir, 'skills', name), join(pipelineDir, '..', 'skills', `${name}.md`));
    if (workDir) stale.push(join(workDir, '.claude', 'skills', name), join(workDir, 'pipeline', 'skills', name));
  }
  for (const f of stale) {
    if (!existsSync(f)) continue;
    try { rmSync(f, { recursive: true, force: true }); changed = true; log(`removed stale copy ${f}`); } catch (e) { log(`${f}: ${e.message}`); }
  }
  return changed;
}
