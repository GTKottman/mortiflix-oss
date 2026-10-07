// The gates: the rules every project follows, enforced here (not by asking the model nicely).
//
//   - Only you cross a gate. A session can submit a reviewed step; only your Approve finishes it.
//   - Internal steps finish with `mfx step done`, and only with their error checks reported.
//   - Every submission reports every error check its step runs, on exactly what it's sending.
//   - Every note you pinned on a version is answered, one by one, in the next version.
//   - Submitted files are copied out of the working folder: what you reviewed can't change afterwards.
import { existsSync, mkdirSync, copyFileSync, realpathSync, statSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { paths, readJson, writeJson, withLock, isInside, UserError } from './studio.mjs';
import { checksForStep, WORK_KINDS } from './pipelines.mjs';
import { projectPaths, projectPipeline, loadProject, update, event, safeName, now } from './projects.mjs';

const DONE = ['approved', 'done', 'skipped'];
const KINDS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'],
  video: ['.mp4', '.webm', '.mov', '.m4v'],
  audio: ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac'],
  pdf: ['.pdf'],
  text: ['.md', '.txt'],
};

export function kindOf(file) {
  const ext = extname(file).toLowerCase();
  for (const [k, list] of Object.entries(KINDS)) if (list.includes(ext)) return k;
  return 'file';
}

export class GateError extends UserError {}
const refuse = (msg) => { throw new GateError(msg); };

// Each step's state. Stored: working, in_review, changes, approved, done. Otherwise derived: ready or blocked.
export function stepView(project, pipeline) {
  const stored = project.steps || {};
  const byKey = Object.fromEntries(pipeline.steps.map((s) => [s.key, s]));
  // A skipped step counts as finished only once the steps it follows are: skipping never lets later work jump ahead.
  const finished = (k) => DONE.includes(stored[k]?.state) && (stored[k].state !== 'skipped' || (byKey[k]?.after || []).every(finished));
  return pipeline.steps.map((s) => {
    const rec = stored[s.key] || {};
    const state = rec.state || (s.after.every(finished) ? 'ready' : 'blocked');
    return { ...s, state, version: rec.version || 0, last_feedback: rec.last_feedback || null };
  });
}

// Recompute the project's state from its steps. Paused, cancelled and draft projects stay as they are.
export function settle(project, pipeline) {
  if (!['queued', 'waiting', 'delivered'].includes(project.state)) return project.state;
  const steps = stepView(project, pipeline);
  const before = project.state;
  if (steps.every((s) => DONE.includes(s.state))) project.state = 'delivered';
  else if (project.questions.some((q) => !q.answered_at)) project.state = 'waiting';
  else if (steps.some((s) => ['ready', 'working', 'changes'].includes(s.state))) project.state = 'queued';
  else project.state = 'waiting';
  if (project.state === 'queued' && before !== 'queued') project.queued_at = now();
  if (project.state === 'delivered' && before !== 'delivered') project.delivered_at = now();
  if (project.state !== 'queued') project.status = null;
  return project.state;
}

function studioChecks(root) {
  const f = paths(root).checks;
  return existsSync(f) ? readJson(f).active || [] : [];
}

export function stepChecks(root, id, stepKey) {
  return checksForStep(projectPipeline(root, id), stepKey, studioChecks(root));
}

function findStep(pipeline, key) {
  return pipeline.steps.find((s) => s.key === key) || refuse(`no step "${key}" in this pipeline (steps: ${pipeline.steps.map((s) => s.key).join(', ')})`);
}

function validateChecks(root, id, stepKey, reported) {
  const need = stepChecks(root, id, stepKey);
  const list = Array.isArray(reported) ? reported : [];
  const byId = new Map(list.map((c) => [c?.id, c]));
  for (const c of list) {
    if (!need.some((n) => n.id === c?.id)) refuse(`error_checks: "${c?.id}" isn't a check for ${stepKey} (run: mfx checks ${stepKey})`);
    if (!['pass', 'fixed', 'n/a'].includes(c.result)) refuse(`error_checks: "${c.id}" result must be pass, fixed or n/a`);
    if (c.result !== 'pass' && !String(c.note || '').trim()) refuse(`error_checks: "${c.id}" is ${c.result}, so it needs a note`);
  }
  const missing = need.filter((n) => !byId.has(n.id));
  if (missing.length) refuse(`error_checks: missing ${missing.map((m) => m.id).join(', ')} (every check for ${stepKey} must be reported: mfx checks ${stepKey})`);
  return list.map((c) => ({ id: c.id, result: c.result, note: String(c.note || '').slice(0, 1000) }));
}

// ---------------------------------------------------------------------------------------------------------------
// What the session does (through mfx)

export function submit(root, id, stepKey, sub) {
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  const step = findStep(pipeline, stepKey);
  if (step.review === 'internal') refuse(`${stepKey} is internal: finish it with mfx step done ${stepKey} --checks <file>`);
  if (!sub || typeof sub !== 'object') refuse('submission must be a JSON object');
  // The step's state first (checked again under the lock below): the most useful refusal comes first.
  const early = stepView(loadProject(root, id), pipeline).find((s) => s.key === stepKey);
  if (early.state === 'blocked') refuse(`${stepKey} can't start yet: it runs after ${step.after.join(', ')}`);
  const note = String(sub.note || '').trim();
  if (!note) refuse('submission needs a "note": what this is and what to look at');

  const questions = (sub.questions || []).map((q, i) => {
    if (!q?.text) refuse(`questions[${i}] needs text`);
    const qid = String(q.id || `q${i + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `q${i + 1}`;
    const choices = Array.isArray(q.choices) ? q.choices.map(String).slice(0, 12) : null;
    const def = q.default === undefined || q.default === null ? null : String(q.default);
    if (choices && def !== null && !choices.includes(def)) refuse(`questions[${i}]: the default must be one of its choices`);
    return { id: qid, text: String(q.text).slice(0, 2000), choices, default: def };
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length) refuse('question ids must be unique');

  const work = realpathSync(pp.work);
  const items = (sub.items || []).map((it, i) => {
    const label = String(it?.label || `Item ${i + 1}`).slice(0, 200);
    const section = it?.section ? String(it.section).slice(0, 200) : null;
    if (typeof it?.text === 'string') return { label, section, kind: 'text', text: it.text.slice(0, 200_000) };
    if (typeof it?.path !== 'string') refuse(`items[${i}] needs a "path" (a file in this project folder) or "text"`);
    const abs = join(work, it.path);
    if (!existsSync(abs)) refuse(`items[${i}]: ${it.path} doesn't exist`);
    const real = realpathSync(abs);
    if (!isInside(work, real)) refuse(`items[${i}]: ${it.path} is outside the project folder`);
    const st = statSync(real);
    if (!st.isFile()) refuse(`items[${i}]: ${it.path} isn't a file`);
    const kind = kindOf(real);
    if (kind === 'text' && st.size <= 200_000) return { label, section, kind: 'text', text: readFileSync(real, 'utf8'), source: it.path };
    return { label, section, kind, real, size: st.size, source: it.path };
  });

  const has = (k) => items.some((x) => x.kind === k);
  const need = {
    questions: () => questions.length || refuse('a questions step needs at least one question'),
    document: () => has('text') || has('pdf') || refuse('a document step needs the document in items (text, .md, .txt or .pdf)'),
    frames: () => has('image') || has('video') || refuse('a frames step needs the frames (images) in items'),
    video: () => has('video') || refuse('a video step needs the video in items'),
    audio: () => has('audio') || refuse('an audio step needs the audio in items'),
  };
  need[step.review]();

  const error_checks = validateChecks(root, id, stepKey, sub.error_checks);

  return update(root, id, (p) => {
    const view = stepView(p, pipeline).find((s) => s.key === stepKey);
    if (view.state === 'blocked') refuse(`${stepKey} can't start yet: it runs after ${step.after.join(', ')}`);
    if (view.state === 'in_review') refuse(`${stepKey} v${view.version} is already waiting for review`);
    if (DONE.includes(view.state)) refuse(`${stepKey} is already approved`);

    // Every note from the last round gets an answer in this version.
    const fb = view.last_feedback;
    let pin_changes = [];
    if (fb && fb.verdict === 'changes' && fb.notes > 0) {
      const given = Array.isArray(sub.pin_changes) ? sub.pin_changes : [];
      for (let n = 1; n <= fb.notes; n++) {
        const c = given.find((x) => Number(x?.note) === n);
        if (!c) refuse(`pin_changes: note ${n} from ${stepKey} v${fb.version} has no answer (one entry per note: {"note": ${n}, "change": "...", "status": "done|partly|not_done"})`);
        if (!String(c.change || '').trim()) refuse(`pin_changes: note ${n} needs "change": what you changed, in plain words`);
        if (!['done', 'partly', 'not_done'].includes(c.status)) refuse(`pin_changes: note ${n} status must be done, partly or not_done`);
        pin_changes.push({ note: n, change: String(c.change).slice(0, 1000), status: c.status });
      }
    }

    const version = view.version + 1;
    const dir = join(pp.reviews, stepKey, `v${version}`);
    mkdirSync(join(dir, 'files'), { recursive: true });
    const stored = items.map((it, i) => {
      if (!it.real) return { label: it.label, section: it.section, kind: it.kind, text: it.text, source: it.source || null };
      const name = `${String(i + 1).padStart(2, '0')}-${safeName(it.source)}`;
      copyFileSync(it.real, join(dir, 'files', name));
      return { label: it.label, section: it.section, kind: it.kind, file: `reviews/${stepKey}/v${version}/files/${name}`, size: it.size, source: it.source };
    });
    const record = { step: stepKey, version, note: note.slice(0, 5000), questions, items: stored, error_checks, pin_changes, submitted_at: now() };
    writeJson(join(dir, 'submission.json'), record);
    p.steps[stepKey] = { ...(p.steps[stepKey] || {}), state: 'in_review', version, submitted_at: record.submitted_at };
    p.status = null;
    settle(p, pipeline);
    event(root, id, { event: 'SUBMITTED', step: stepKey, version, details: note.slice(0, 300) });
    return { step: stepKey, version, items: stored.length, project_state: p.state };
  });
}

export function stepStart(root, id, stepKey) {
  const pipeline = projectPipeline(root, id);
  findStep(pipeline, stepKey);
  return update(root, id, (p) => {
    const view = stepView(p, pipeline).find((s) => s.key === stepKey);
    if (view.state === 'blocked') refuse(`${stepKey} can't start yet: it runs after ${view.after.join(', ')}`);
    if (!['ready', 'changes', 'working'].includes(view.state)) refuse(`${stepKey} is ${view.state}`);
    p.steps[stepKey] = { ...(p.steps[stepKey] || {}), state: 'working', version: view.version };
    event(root, id, { event: 'STEP_STARTED', step: stepKey });
    return { step: stepKey, state: 'working' };
  });
}

export function stepDone(root, id, stepKey, reportedChecks) {
  const pipeline = projectPipeline(root, id);
  const step = findStep(pipeline, stepKey);
  if (step.review !== 'internal') refuse(`${stepKey} is reviewed by you: only your approval finishes it (mfx submit ${stepKey} <file>)`);
  const error_checks = validateChecks(root, id, stepKey, reportedChecks);
  return update(root, id, (p) => {
    const view = stepView(p, pipeline).find((s) => s.key === stepKey);
    if (view.state === 'blocked') refuse(`${stepKey} can't finish yet: it runs after ${step.after.join(', ')}`);
    if (view.state === 'done') refuse(`${stepKey} is already done`);
    p.steps[stepKey] = { ...(p.steps[stepKey] || {}), state: 'done', version: view.version, done_at: now(), error_checks };
    settle(p, pipeline);
    event(root, id, { event: 'STEP_DONE', step: stepKey, details: error_checks.map((c) => `${c.id}:${c.result}`).join(' ') });
    return { step: stepKey, state: 'done', project_state: p.state };
  });
}

export function ask(root, id, stepKey, text, { default: def = null, choices = null } = {}) {
  const pipeline = projectPipeline(root, id);
  findStep(pipeline, stepKey);
  if (!String(text || '').trim()) refuse('the question is empty');
  if (choices && def !== null && !choices.includes(def)) refuse('the default must be one of the choices');
  return update(root, id, (p) => {
    const q = { id: `q${p.questions.length + 1}`, step: stepKey, text: String(text).slice(0, 2000), default: def, choices, asked_at: now(), answer: null, answered_at: null };
    p.questions.push(q);
    settle(p, pipeline);
    event(root, id, { event: 'ASKED', step: stepKey, details: q.text.slice(0, 300) });
    return { question: q.id, project_state: p.state };
  });
}

export function status(root, id, key, mode = 'working') {
  const pipeline = projectPipeline(root, id);
  const text = pipeline.status_lines[key];
  if (!text) refuse(`no status line "${key}" (this pipeline's: ${Object.keys(pipeline.status_lines).join(', ') || 'none'})`);
  if (!['working', 'rendering'].includes(mode)) refuse('mode must be working or rendering');
  return update(root, id, (p) => { p.status = { key, text, mode, at: now() }; return p.status; });
}

export function handoff(root, id, text) {
  if (!String(text || '').trim()) refuse('the handoff is empty');
  const pp = projectPaths(root, id);
  appendFileSync(join(pp.work, 'JOURNAL.md'), `\n## ${now().slice(0, 16).replace('T', ' ')}\n\n${String(text).trim()}\n`);
  event(root, id, { event: 'HANDOFF', details: String(text).slice(0, 600) });
  return { ok: true };
}

export function log(root, id, name, details) {
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(name || '')) refuse('event names are UPPER_CASE, e.g. RESEARCH_DONE');
  event(root, id, { event: name, details });
  return { ok: true };
}

// The session can't go on without you (a decision only you can make, a broken tool, a missing key).
export function needsYou(root, id, text) {
  if (!String(text || '').trim()) refuse('say what you need');
  return update(root, id, (p) => {
    p.state = 'paused';
    p.needs_you = { text: String(text).slice(0, 2000), at: now() };
    event(root, id, { event: 'NEEDS_YOU', details: p.needs_you.text });
    return { project_state: p.state };
  });
}

export function proposeCheck(root, id, { title, how, example, work, same_as }) {
  const f = paths(root).checks;
  return withLock(`${f}.lock`, () => {
    const all = existsSync(f) ? readJson(f) : { active: [], proposed: [] };
    if (same_as) {
      const hit = [...all.active, ...all.proposed].find((c) => c.id === same_as) || refuse(`no check "${same_as}"`);
      hit.seen = (hit.seen || 1) + 1;
      writeJson(f, all);
      event(root, id, { event: 'CHECK_SEEN_AGAIN', details: same_as });
      return { id: same_as };
    }
    if (!title || !how) refuse('a check needs --title and --how');
    const applies_to = String(work || '').split(',').map((w) => w.trim()).filter(Boolean);
    for (const w of applies_to) if (!WORK_KINDS.includes(w)) refuse(`--work: ${w} isn't one of ${WORK_KINDS.join(', ')}`);
    const cid = `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36)}-${Date.now().toString(36).slice(-4)}`;
    all.proposed.push({ id: cid, title: String(title).slice(0, 200), how: String(how).slice(0, 2000), example: String(example || '').slice(0, 1000), applies_to, project: id, proposed_at: now() });
    writeJson(f, all);
    event(root, id, { event: 'CHECK_PROPOSED', details: title });
    return { id: cid };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// What you do (web UI or `mortiflix review`)

export function respond(root, id, stepKey, version, { verdict, overall = '', notes = [], answers = {} }) {
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  findStep(pipeline, stepKey);
  if (!['approve', 'changes'].includes(verdict)) refuse('verdict must be approve or changes');
  const dir = join(pp.reviews, stepKey, `v${version}`);
  if (!existsSync(join(dir, 'submission.json'))) refuse(`no ${stepKey} v${version}`);
  const sub = readJson(join(dir, 'submission.json'));

  const cleanNotes = (Array.isArray(notes) ? notes : []).map((n, i) => {
    const text = String(n?.text || '').trim();
    if (!text) refuse(`note ${i + 1} is empty`);
    const item = n.item === undefined || n.item === null ? null : Number(n.item);
    if (item !== null && !(Number.isInteger(item) && item >= 0 && item < sub.items.length)) refuse(`note ${i + 1} points at an item that doesn't exist`);
    const frac = (v) => (v === undefined || v === null || v === '' ? null : Math.min(1, Math.max(0, Number(v))));
    const out = { n: i + 1, item, item_label: item === null ? null : sub.items[item].label, text: text.slice(0, 2000) };
    const x = frac(n.x), y = frac(n.y);
    if (x !== null && y !== null && !Number.isNaN(x) && !Number.isNaN(y)) Object.assign(out, { x: round(x), y: round(y) });
    if (n.time_sec !== undefined && n.time_sec !== null && n.time_sec !== '' && Number(n.time_sec) >= 0) out.time_sec = round(Number(n.time_sec), 2);
    if (Number.isInteger(n.paragraph) && n.paragraph >= 0) out.paragraph = n.paragraph;
    return out;
  });
  if (verdict === 'changes' && !cleanNotes.length && !String(overall).trim()) refuse('say what to change (a note or an overall comment)');

  const resolved = sub.questions.map((q) => {
    const a = answers?.[q.id];
    const given = a === undefined || a === null || String(a).trim() === '' ? null : String(a).slice(0, 4000);
    if (given === null && q.default === null) refuse(`"${q.text}" needs an answer`);
    // A free answer beside the choices is allowed: people say "neither, make it teal".
    return { id: q.id, text: q.text, answer: given ?? q.default, used_default: given === null };
  });

  return update(root, id, (p) => {
    const view = stepView(p, pipeline).find((s) => s.key === stepKey);
    if (view.state !== 'in_review' || view.version !== version) refuse(`${stepKey} v${version} isn't waiting for review (it's ${view.state}, v${view.version})`);
    const feedback = {
      step: stepKey,
      version,
      verdict,
      overall: String(overall || '').slice(0, 4000),
      notes: cleanNotes,
      answers: resolved,
      decided_at: now(),
      how_to_read_annotations: 'Each note may point at an item (0-based index, item_label). x and y are fractions of the picture width and height from its top-left. time_sec is seconds into a video or audio item. paragraph is the 0-based paragraph of a text item. Answer every note in the next version\'s pin_changes.',
    };
    writeJson(join(dir, 'feedback.json'), feedback);
    mkdirSync(join(pp.work, 'feedback'), { recursive: true });
    writeJson(join(pp.work, 'feedback', `${stepKey}-v${version}.json`), feedback);
    p.steps[stepKey] = {
      ...(p.steps[stepKey] || {}),
      state: verdict === 'approve' ? 'approved' : 'changes',
      version,
      decided_at: feedback.decided_at,
      last_feedback: { version, verdict, notes: cleanNotes.length },
    };
    const step = pipeline.steps.find((s) => s.key === stepKey);
    if (verdict === 'approve' && step.delivers) {
      p.deliverables = sub.items.filter((it) => it.file).map((it) => ({ label: it.label, kind: it.kind, file: it.file, size: it.size }));
    }
    settle(p, pipeline);
    event(root, id, { event: verdict === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED', actor: 'you', step: stepKey, version, details: cleanNotes.length ? `${cleanNotes.length} note(s)` : feedback.overall.slice(0, 200) });
    return { step: stepKey, version, verdict, project_state: p.state };
  });
}

// The owner changes their mind after approving: the step goes back for changes, with their note, and steps after it
// that had started (but weren't approved) wait for the new version. The approval stays in the log.
export function reopen(root, id, stepKey, { overall = '', notes = [] } = {}) {
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  const step = findStep(pipeline, stepKey);
  if (step.review === 'internal') refuse(`${stepKey} isn't reviewed by you: reopen the reviewed step before it`);
  if (!String(overall).trim() && !notes.length) refuse('say what to change');
  return update(root, id, (p) => {
    const rec = p.steps?.[stepKey];
    if (!rec || !['approved', 'done'].includes(rec.state)) refuse(`${stepKey} isn't approved (it's ${rec?.state || 'not started'})`);
    const version = rec.version;
    const dir = join(pp.reviews, stepKey, `v${version}`);
    const before = existsSync(join(dir, 'feedback.json')) ? readJson(join(dir, 'feedback.json')) : null;
    const feedback = {
      step: stepKey, version, verdict: 'changes', reopened: true, approved_at: before?.decided_at || rec.decided_at || null,
      overall: String(overall).slice(0, 4000),
      notes: notes.map((n, i) => ({ n: i + 1, item: n.item ?? null, text: String(n.text || '').slice(0, 2000) })),
      answers: before?.answers || [],
      decided_at: now(),
      how_to_read_annotations: 'The owner approved this version, then asked for these changes. Answer every note in the next version\'s pin_changes.',
    };
    writeJson(join(dir, 'feedback.json'), feedback);
    mkdirSync(join(pp.work, 'feedback'), { recursive: true });
    writeJson(join(pp.work, 'feedback', `${stepKey}-v${version}.json`), feedback);
    p.steps[stepKey] = { ...rec, state: 'changes', decided_at: feedback.decided_at, last_feedback: { version, verdict: 'changes', notes: feedback.notes.length } };
    // Later steps that depend on it and had started without being approved go back to waiting.
    const after = new Set([stepKey]);
    let grew = true;
    while (grew) { grew = false; for (const s of pipeline.steps) if (!after.has(s.key) && s.after.some((a) => after.has(a))) { after.add(s.key); grew = true; } }
    for (const k of after) if (k !== stepKey && p.steps[k] && !['approved', 'done', 'skipped'].includes(p.steps[k].state)) delete p.steps[k];
    if (p.state === 'delivered') p.state = 'queued';
    settle(p, pipeline);
    event(root, id, { event: 'REOPENED', actor: 'you', step: stepKey, version, details: String(overall).slice(0, 200) });
    return { step: stepKey, version, project_state: p.state };
  });
}

export function answerQuestion(root, id, qid, value) {
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  return update(root, id, (p) => {
    const q = p.questions.find((x) => x.id === qid) || refuse(`no question ${qid}`);
    if (q.answered_at) refuse('already answered');
    const given = value === undefined || value === null || String(value).trim() === '' ? null : String(value).slice(0, 4000);
    if (given === null && q.default === null) refuse('this question needs an answer');
    q.answer = given ?? q.default;
    q.used_default = given === null;
    q.answered_at = now();
    mkdirSync(join(pp.work, 'feedback'), { recursive: true });
    writeJson(join(pp.work, 'feedback', 'questions.json'), p.questions);
    settle(p, pipeline);
    event(root, id, { event: 'ANSWERED', actor: 'you', step: q.step, details: `${q.text.slice(0, 120)} → ${q.answer}` });
    return { question: qid, project_state: p.state };
  });
}

export function resume(root, id) {
  const pipeline = projectPipeline(root, id);
  return update(root, id, (p) => {
    if (p.state !== 'paused') refuse(`not paused (${p.state})`);
    p.state = 'queued';
    p.needs_you = null;
    p.no_progress = 0;
    settle(p, pipeline);
    event(root, id, { event: 'RESUMED', actor: 'you' });
  });
}

export function pause(root, id, why = 'Paused by you') {
  return update(root, id, (p) => {
    if (['delivered', 'cancelled', 'draft'].includes(p.state)) refuse(`can't pause a ${p.state} project`);
    p.state = 'paused';
    p.needs_you = { text: why, at: now(), by_you: true };
    event(root, id, { event: 'PAUSED', actor: 'you' });
  });
}

export function cancel(root, id) {
  return update(root, id, (p) => {
    p.state = 'cancelled';
    event(root, id, { event: 'CANCELLED', actor: 'you' });
  });
}

export function decideCheck(root, checkId, approve) {
  const f = paths(root).checks;
  return withLock(`${f}.lock`, () => {
    const all = readJson(f);
    const i = all.proposed.findIndex((c) => c.id === checkId);
    if (i < 0) refuse(`no proposed check ${checkId}`);
    const [c] = all.proposed.splice(i, 1);
    if (approve) all.active.push({ ...c, approved_at: now() });
    writeJson(f, all);
    return c;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading back

export function submissions(root, id) {
  const pp = projectPaths(root, id);
  const out = [];
  if (!existsSync(pp.reviews)) return out;
  for (const step of readdirSync(pp.reviews)) {
    for (const v of readdirSync(join(pp.reviews, step))) {
      const f = join(pp.reviews, step, v, 'submission.json');
      if (!existsSync(f)) continue;
      const sub = readJson(f);
      const fb = join(pp.reviews, step, v, 'feedback.json');
      out.push({ ...sub, feedback: existsSync(fb) ? readJson(fb) : null });
    }
  }
  return out.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
}

export function feedbackFor(root, id, stepKey) {
  return submissions(root, id).filter((s) => s.feedback && (!stepKey || s.step === stepKey)).map((s) => s.feedback);
}

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
