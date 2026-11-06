// Lessons (v3): what the owner's notes taught the studio, kept per project and across projects, shown on the Lessons
// page, and put in every motion / stills / session prompt while approved and on. Owner: "TONS of the stuff we
// learned while being extremely picky were applicable to the future scenes."
//   studio-wide  <root>/lessons.json            project  <root>/state/<id>/lessons.json
//   [{id, name, text, section, scope:"project"|"all", on, source:{project,node,note,frame,at}, approved, used}]
// Also here: Video Notes saved from the app (notes.save / notes.send / notes.delete) and the scene-by-scene loop of the
// animatic (motion.scene.*; motion.first.* are aliases).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths, writeJson, UserError, isInside, readJsonList } from '../studio.mjs';
import { loadProject, projectPaths, update } from '../projects.mjs';

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const readList = readJsonList; // studio.mjs: [] only when missing; a damaged file is an error, never wiped
// The count of lessons waiting for an OK, for a screen's badge: a damaged lessons file shows 0 instead of stopping the
// screen from loading (writes still refuse it, readJsonList).
export function waitingLessons(root, id) {
  try { return listLessons(root, id, 'project').lessons.filter((l) => !l.approved).length; } catch { return 0; }
}
const fileFor = (root, scope, id) => (scope === 'all' ? join(root, 'lessons.json') : join(projectPaths(root, id).state, 'lessons.json'));
export const SECTIONS = ['Process', 'Design', 'Motion', 'Picture and words', 'Sound', 'Characters'];
const section = (v) => SECTIONS.find((s) => s.toLowerCase() === String(v || '').toLowerCase()) || null;

const load = (root, scope, id) => readList(fileFor(root, scope, id)).map((l) => ({ ...l, scope }));
const save = (root, scope, id, list) => writeJson(fileFor(root, scope, id), list.map(({ scope: _s, ...l }) => l));

// read side only: source.image = the marked frame of the note that made the lesson (state/<project>/notes/notes.json),
// source.project_title = the name of the project the note came from
function withImages(root, list) {
  const notes = new Map();
  const titles = new Map();
  return list.map((l) => {
    const pid = l.source?.project;
    if (!pid || l.source.imported) return l;
    if (!titles.has(pid)) { try { titles.set(pid, loadProject(root, pid).title || null); } catch { titles.set(pid, null); } }
    if (titles.get(pid)) l = { ...l, source: { ...l.source, project_title: titles.get(pid) } };
    if (l.source.image !== undefined) return l;
    if (!notes.has(pid)) { try { notes.set(pid, readList(join(projectPaths(root, pid).state, 'notes', 'notes.json'))); } catch { notes.set(pid, []); } }
    const n = notes.get(pid).find((x) => x.lesson === l.id);
    return n?.image ? { ...l, source: { ...l.source, image: n.image } } : l;
  });
}

// lessons.list {scope?: "all"|"project"|"both" (default), project?}
export function listLessons(root, id, scope = 'both') {
  const all = scope === 'project' ? [] : load(root, 'all');
  const mine = scope === 'all' || !id ? [] : load(root, 'project', id);
  const lessons = withImages(root, [...mine.filter((l) => !l.approved), ...all, ...mine.filter((l) => l.approved)]);
  const counts = { total: lessons.length, on: lessons.filter((l) => l.approved && l.on).length, off: lessons.filter((l) => l.approved && !l.on).length, waiting: lessons.filter((l) => !l.approved).length, sections: {} };
  for (const l of lessons) if (l.section) counts.sections[l.section] = (counts.sections[l.section] || 0) + 1;
  return { lessons, counts };
}

// Finds a lesson wherever it is: {scope, list, i}.
function find(root, id, lid) {
  for (const scope of ['project', 'all']) {
    if (scope === 'project' && !id) continue;
    const list = load(root, scope, id);
    const i = list.findIndex((l) => l.id === lid);
    if (i >= 0) return { scope, list, i, home: scope === 'project' ? id : null };
  }
  throw new UserError(`no lesson ${lid}`);
}

const newId = () => `l-${randomBytes(4).toString('hex')}`;
// A lesson's own name, shown above its words. Without one from Claude: the first words of the rule.
const NAME_MAX = 60;
const shortName = (text) => str(String(text).split(/[.:;!?](?:\s|$)/)[0].split(/\s+/).slice(0, 6).join(' '), NAME_MAX);
const mk = (o) => ({ id: newId(), name: str(o.name, NAME_MAX) || shortName(o.text), text: str(o.text, 600), section: section(o.section), on: o.on !== false, source: o.source || {}, approved: Boolean(o.approved), used: 0 });

// Every lesson has its own name: one already taken gets a number.
function ownName(name, lessons) {
  const taken = new Set(lessons.map((l) => String(l.name || '').toLowerCase()));
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} ${n}`;
  return out;
}

// One quick Claude call: a specific note -> a general lesson with its own name. `ask(prompt)` returns text; without one (or when it fails)
// the owner's own words are kept as the proposal, which they can edit before approving.
export async function proposeLesson(root, id, { note, node = null, frame = null, ask = null }) {
  const said = str(note, 1000);
  if (!said) throw new UserError('lessons.propose needs the note');
  let text = said, sec = null, how = 'words', name = '';
  if (ask) {
    try {
      const prompt = `The owner of a motion-design studio gave this note on one frame of a video${node ? ` (piece ${node})` : ''}: "${said}"\n\nWrite ONE general lesson that would help every future scene and project avoid the same problem or repeat what they liked. Plain words, one or two sentences, imperative, no mention of this scene's names or numbers. Also give the lesson its own name: 2 to 5 plain words that say what this rule is about, specific enough that no other lesson would share it, Title Case, no full stop. Answer with JSON only: {"name": "...", "lesson": "...", "section": one of ${JSON.stringify(SECTIONS)}}`;
      const a = String(await ask(prompt));
      const j = JSON.parse(a.match(/\{[\s\S]*\}/)?.[0] || 'null');
      if (j?.lesson) { text = str(j.lesson, 400); name = str(j.name, NAME_MAX); sec = section(j.section); how = 'ai'; }
    } catch { /* the owner's words stand */ }
  }
  const list = load(root, 'project', id);
  const l = mk({ name: ownName(name || shortName(text), [...list, ...load(root, 'all')]), text, section: sec, on: true, approved: false, source: { project: id, node, note: said, frame, at: new Date().toISOString() } });
  save(root, 'project', id, [...list, l]);
  return { lesson: { ...l, scope: 'project' }, how };
}

// The project a project-scoped lesson belongs to: the project its note came from (when it still exists), else `pid`.
function homeOf(root, l, pid) {
  const src = l.source?.project;
  if (src && !l.source?.imported) { try { if (existsSync(projectPaths(root, src).file)) return src; } catch { /* not a project id */ } }
  if (!pid) throw new UserError('open a project first: a lesson for only one project needs that project');
  return pid;
}

// Moves the lesson at f into `to` ("all" | "project"), changed by `change`. A project lesson goes to its home project.
function put(root, pid, f, to, change) {
  const l = change({ ...f.list[f.i] });
  const home = to === 'project' ? homeOf(root, l, pid) : null;
  const same = to === f.scope && (to === 'all' || home === f.home);
  if (same) { f.list[f.i] = l; save(root, f.scope, f.home, f.list); return { ...l, scope: to, ...(home ? { project: home } : {}) }; }
  f.list.splice(f.i, 1);
  save(root, f.scope, f.home, f.list);
  save(root, to, home, [...load(root, to, home), l]);
  return { ...l, scope: to, ...(home ? { project: home } : {}) };
}

// lessons.approve {id, scope?: "all"|"project"}: "Approve" = every project, "Only in <project>" keeps it in the project
// its note came from.
export function approveLesson(root, pid, lid, scope = 'all') {
  const f = find(root, pid, lid);
  return { lesson: put(root, pid, f, scope === 'project' ? 'project' : 'all', (l) => ({ ...l, approved: true, on: true })) };
}

// lessons.edit {id, name?, text?, section?, scope?: "all"|"project"}: scope moves it between every project and only its project.
export function editLesson(root, pid, lid, patch = {}) {
  const f = find(root, pid, lid);
  if (patch.scope !== undefined && !['all', 'project'].includes(patch.scope)) throw new UserError('scope is "all" or "project"');
  const to = patch.scope ?? f.scope;
  return {
    lesson: put(root, pid, f, to, (l) => {
      if (patch.text !== undefined) { l.text = str(patch.text, 600); if (!l.text) throw new UserError('a lesson needs words'); }
      if (patch.name !== undefined) l.name = str(patch.name, NAME_MAX) || shortName(l.text);
      if (patch.section !== undefined) l.section = section(patch.section);
      return l;
    }),
  };
}

export function toggleLesson(root, pid, lid, on) {
  const f = find(root, pid, lid);
  const l = { ...f.list[f.i], on: on === undefined ? !f.list[f.i].on : Boolean(on) };
  if (!l.on) l.off_at = new Date().toISOString();
  f.list[f.i] = l;
  save(root, f.scope, f.home, f.list);
  return { lesson: { ...l, scope: f.scope } };
}

// lessons.delete keeps the lesson in <studio>/lessons-trash.json so lessons.restore {id} can put it back (Undo).
const trashFile = (root) => join(root, 'lessons-trash.json');
const TRASH_MAX = 200;

export function deleteLesson(root, pid, lid) {
  const f = find(root, pid, lid);
  const [l] = f.list.splice(f.i, 1);
  save(root, f.scope, f.home, f.list);
  const trash = readList(trashFile(root)).filter((x) => x.lesson?.id !== lid);
  writeJson(trashFile(root), [...trash, { lesson: l, scope: f.scope, project: f.home, deleted_at: new Date().toISOString() }].slice(-TRASH_MAX));
  return { deleted: lid };
}

export function restoreLesson(root, lid) {
  const trash = readList(trashFile(root));
  const i = trash.findIndex((x) => x.lesson?.id === lid);
  if (i < 0) throw new UserError(`lesson ${lid} is not in the trash`);
  const { lesson, scope, project } = trash[i];
  if (scope === 'project' && !existsSync(projectPaths(root, project).file)) throw new UserError('the project of that lesson is gone');
  save(root, scope, project, [...load(root, scope, project), lesson]);
  trash.splice(i, 1);
  writeJson(trashFile(root), trash);
  return { lesson: { ...lesson, scope, ...(project ? { project } : {}) } };
}

// Which lesson sections each step's prompts carry (T6). A lesson with no section reaches every step. No step = every section.
export const STEP_SECTIONS = {
  brief: ['Process'],
  frames: ['Design', 'Picture and words', 'Characters'],
  animatic: ['Motion', 'Picture and words', 'Process'],
  sound: ['Sound'],
};
export const LESSON_BUDGET = 6000; // characters of lesson lines per prompt
const sameText = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The lessons a prompt gets, in order: project lessons first, then the studio's by use and newest. `more` = approved
// lessons of this step that did not fit the budget (never dropped without saying so).
export function pickLessons(root, id, { step = null, budget = LESSON_BUDGET } = {}) {
  let all = [], mine = [];
  try { all = load(root, 'all'); mine = id ? load(root, 'project', id) : []; } catch { return { chosen: [], more: 0, lists: { all, mine } }; }
  const live = (l) => l.approved && l.on && l.text;
  const secs = STEP_SECTIONS[step];
  const forStep = (l) => !secs || !l.section || secs.includes(l.section);
  const rank = all.map((l, i) => ({ l, i })).filter(({ l }) => live(l)).sort((x, y) => (y.l.used || 0) - (x.l.used || 0) || y.i - x.i).map(({ l }) => l);
  const seen = new Set();
  const cands = [...mine.filter(live), ...rank].filter(forStep).filter((l) => { const k = sameText(l.text); if (seen.has(k)) return false; seen.add(k); return true; });
  const chosen = [];
  let used = 0;
  for (const l of cands) {
    const n = l.text.length + 3;
    if (used + n > budget && chosen.length) break;
    chosen.push(l); used += n;
  }
  return { chosen, more: cands.length - chosen.length, lists: { all, mine } };
}

// The text every prompt gets: approved + on lessons of the studio and the project, for this step, capped. Each use counts
// once per call, for the lessons that were put in.
export function lessonsBlock(root, id, { mark = true, step = null, budget = LESSON_BUDGET } = {}) {
  const { chosen, more, lists } = pickLessons(root, id, { step, budget });
  if (!chosen.length) return '';
  if (mark) {
    const ids = new Set(chosen.map((l) => l.id));
    for (const [scope, list] of [['all', lists.all], ['project', lists.mine]]) {
      if (!list.some((l) => ids.has(l.id))) continue;
      for (const l of list) if (ids.has(l.id)) l.used = (l.used || 0) + 1;
      try { save(root, scope, id, list); } catch { /* counting is best effort */ }
    }
  }
  const tail = more > 0 ? `\n(${more} more lesson${more === 1 ? '' : 's'} for this step on the Lessons page)` : '';
  return `## Mistakes never to repeat, and rules learned from the owner's own notes on earlier work (every one is approved: do not make these mistakes again; they are rules about what the owner is picky about, not a process or a motion to copy)\n${chosen.map((l) => `- ${l.text}`).join('\n')}${tail}`;
}

// lessons.import {path}: the "What Have We Learned" markdown as approved, on, every-project lessons. One time.
export function parseLearned(md, title = 'Imported') {
  const out = [];
  let sec = null, cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const raw of String(md).split('\n')) {
    const h = raw.match(/^##\s+(.+)/);
    if (h) { flush(); const name = h[1].replace(/\(.*\)/, '').trim(); sec = section(name) || (/pictur|word/i.test(name) ? 'Picture and words' : /character/i.test(name) ? 'Characters' : /sound|music|audio/i.test(name) ? 'Sound' : /motion|animat/i.test(name) ? 'Motion' : /design|layout|colou?r/i.test(name) ? 'Design' : /process/i.test(name) ? 'Process' : null); continue; }
    const b = raw.match(/^(?:\d+\.|-)\s+(.*)/);
    if (b) { flush(); cur = { section: sec, text: b[1] }; continue; }
    if (cur && /^\s{2,}\S/.test(raw) && !/^\s*(-|\*|\d+\.)\s/.test(raw) && !/^\s*\*\*How to code it/i.test(raw)) cur.text += ` ${raw.trim()}`;
    else if (!raw.trim()) { /* blank line inside an item */ } else if (cur && !/^\s/.test(raw)) flush();
  }
  flush();
  return out.filter((x) => sec !== undefined && x.text.replace(/\*\*/g, '').trim().length > 12).map((x) => {
    let text = x.text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    let note = '';
    const p = text.match(/\s*\(([^()]{10,})\)\s*$/);
    if (p) { note = p[1]; text = text.slice(0, p.index).trim(); }
    return { section: x.section, text, note, title };
  });
}

export function importLearned(root, file) {
  const f = String(file || '');
  if (!f || !existsSync(f)) throw new UserError(`no file at ${f}`);
  // only a Markdown file (a "What Have We Learned" page): never any other file the caller names
  if (extname(f).toLowerCase() !== '.md' || !statSync(f).isFile()) throw new UserError('lessons can only be imported from a Markdown (.md) file');
  const title = f.replace(/^.*\//, '').replace(/\.md$/i, '').replace(/^What Have We Learned - /i, '');
  const have = new Set(load(root, 'all').map((l) => l.text));
  const add = parseLearned(readFileSync(f, 'utf8'), title).filter((x) => !have.has(x.text)).map((x) => mk({ text: x.text, section: x.section, on: true, approved: true, source: { project: title, note: x.note || null, imported: true } }));
  save(root, 'all', null, [...load(root, 'all'), ...add]);
  return { imported: add.length };
}

// ---- Video Notes inside Mortiflix ----
// notes.save {node, time, text, image_png_base64, audio_base64?, audio_ext?}: the pen marks + words are kept under
// state/<id>/notes/, a Fix with the words and the picture goes to the piece, and the note becomes a lesson to approve.
export async function saveNote(root, id, p, { fix, ask = null } = {}) {
  // send: false keeps the note pending: nothing is fixed until notes.send gathers every pending note of the scene
  const send = p?.send !== false;
  const node = str(p?.node, 24);
  const text = str(p?.text, 4000);
  if (!node) throw new UserError('notes.save needs a node');
  if (!text && !p?.image_png_base64 && !p?.audio_base64) throw new UserError('a note needs words, marks or a recording');
  const dir = join(projectPaths(root, id).state, 'notes');
  mkdirSync(dir, { recursive: true });
  // the same words on the same piece, still waiting, are one note (2026-11-02 d4fd: Enter and Fix pressed together saved a
  // typed note twice and "2 notes" were sent)
  if (!send && text && !p?.image_png_base64 && !p?.audio_base64) {
    const twin = readList(join(dir, 'notes.json')).find((n) => n.pending && n.node === node && n.text === text && !n.image && !n.audio);
    if (twin) return { note: twin, lesson: null, edit: null, same: true };
  }
  const time = Number.isFinite(Number(p?.time)) ? Math.max(0, Number(p.time)) : 0;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const base = `${stamp}-${node}-${Math.round(time * 1000)}`;
  let image = null, audio = null;
  const png = String(p?.image_png_base64 || '').replace(/^data:image\/(png|jpeg);base64,/, '');
  const imgExt = p?.image_ext === 'jpg' ? 'jpg' : 'png'; // the tablet's marked frames are JPEGs
  if (png) { image = join(dir, `${base}.${imgExt}`); writeFileSync(image, Buffer.from(png, 'base64')); }
  if (p?.audio_base64) {
    const ext = /^[a-z0-9]{2,5}$/.test(String(p.audio_ext || '')) ? p.audio_ext : 'webm';
    audio = join(dir, `${base}.${ext}`);
    writeFileSync(audio, Buffer.from(String(p.audio_base64).replace(/^data:[^,]*,/, ''), 'base64'));
  }
  const frame = Number.isFinite(Number(p?.frame)) ? Number(p.frame) : Math.round(time * 30);
  const index = join(dir, 'notes.json');
  const note = { id: base, node, time, frame, text, image, audio, at: new Date().toISOString(), ...(send ? {} : { pending: true }), ...(p?.tablet ? { tablet: str(p.tablet, 120) } : {}) };
  const edit = send && fix ? fix(node, `${text || '(spoken note: see the recording)'}${image ? `\n\nThe owner's pen marks on the frame at ${time.toFixed(2)} s: ${image}` : ''}`) : null;
  if (edit?.edit) note.edit = edit.edit.id;
  const prop = text ? await proposeLesson(root, id, { note: text, node, frame, ask }) : null;
  if (prop) note.lesson = prop.lesson.id;
  writeJson(index, [...readList(index), note]);
  return { note, lesson: prop?.lesson || null, edit: edit?.edit || null };
}

export function listNotes(root, id, node = null) {
  const all = readList(join(projectPaths(root, id).state, 'notes', 'notes.json'));
  return { notes: node ? all.filter((n) => n.node === node) : all };
}

// notes.send {node}: every pending note of one scene goes as ONE fix ("Send my N notes"), in the order they were made.
export function sendNotes(root, id, node, { fix } = {}) {
  node = str(node, 24);
  if (!node) throw new UserError('notes.send needs a node');
  const index = join(projectPaths(root, id).state, 'notes', 'notes.json');
  const all = readList(index);
  const pend = all.filter((n) => n.node === node && n.pending);
  if (!pend.length) throw new UserError(`no pending notes on ${node}`);
  const text = pend.map((n, i) => `${i + 1}. At ${Number(n.time || 0).toFixed(2)} s: ${n.text || '(spoken note: see the recording)'}${n.image ? `\n   The owner's pen marks on the frame: ${n.image}` : ''}${n.audio ? `\n   Recording: ${n.audio}` : ''}`).join('\n');
  const edit = fix ? fix(node, `The owner's ${pend.length} note${pend.length === 1 ? '' : 's'} on this scene, all at once (fix every one in one pass):\n${text}`) : null;
  const ids = new Set(pend.map((n) => n.id));
  writeJson(index, all.map((n) => (ids.has(n.id) ? { ...n, pending: false, sent_at: new Date().toISOString(), ...(edit?.edit ? { edit: edit.edit.id } : {}) } : n)));
  return { sent: pend.length, notes: pend.map((n) => n.id), edit: edit?.edit || null };
}

// notes.delete {note}: drops a note (its files too) and its lesson while that is still waiting for approval.
export function deleteNote(root, id, noteId) {
  const index = join(projectPaths(root, id).state, 'notes', 'notes.json');
  const all = readList(index);
  const n = all.find((x) => x.id === noteId);
  if (!n) throw new UserError(`no note ${noteId}`);
  // only the note's own files, inside the project's notes folder (a path in notes.json is never trusted further)
  const notesDir = join(projectPaths(root, id).state, 'notes');
  for (const f of [n.image, n.audio]) if (f) { try { const real = realpathSync(String(f)); if (isInside(realpathSync(notesDir), real) && real !== realpathSync(notesDir)) rmSync(real, { force: true }); } catch { /* already gone */ } }
  writeJson(index, all.filter((x) => x.id !== noteId));
  if (n.lesson) { try { const l = load(root, 'project', id).find((x) => x.id === n.lesson); if (l && !l.approved) deleteLesson(root, id, n.lesson); } catch { /* none */ } }
  return { deleted: noteId };
}

// ---- the animatic, one scene at a time ----
// project.json mfx.motion_scenes = {current: <beat index>, done: [beat ids], built: [beat ids waiting for the owner's look],
// mode: "one" | "all"}. Scenes are made one by one: each is built alone, the owner's notes on it become lessons (mistakes
// never to repeat). One scene is made AHEAD while the owner checks the current one (owner, 2026-11-04: "when you're labeling
// one scene, the other scene's generating"), with the lessons so far: `ahead` is that beat, `ahead_at` when each was started.
// After many notes the OK asks whether to remake it with them (ASK_NOTES). Never more than one ahead, never in a batch
// unless the owner says so (motion.scene.all, which warns first). The old mfx.motion_first = {approved} migrates: approved
// meant every other scene was already built together, so it reads as mode "all" with scene 1 done.
export const sceneBeats = (root, id) => {
  try { return (JSON.parse(readFileSync(join(projectPaths(root, id).work, 'script', 'beats.json'), 'utf8')).beats || []).map((b) => ({ id: b.id, name: b.name || b.id })); } catch { return []; }
};
/** This many notes since the next scene was started: the OK asks whether to remake it with them. */
export const ASK_NOTES = 3;
const readScenes = (root, id) => {
  const m = loadProject(root, id).mfx || {};
  const beats = sceneBeats(root, id);
  let s = m.motion_scenes;
  if (!s) s = m.motion_first?.approved && beats.length ? { current: Math.min(1, beats.length - 1), done: [beats[0].id], built: [], mode: 'all' } : { current: 0, done: [], built: [], mode: 'one' };
  const done = (s.done || []).filter((b) => beats.some((x) => x.id === b));
  const next = beats.findIndex((b) => !done.includes(b.id));
  const built = (s.built || []).filter((b) => !done.includes(b));
  const ahead = s.ahead && beats.some((b) => b.id === s.ahead) && !done.includes(s.ahead) && !built.includes(s.ahead) ? s.ahead : null;
  return { ahead, ahead_at: { ...(s.ahead_at || {}) }, tablet: s.tablet && typeof s.tablet === 'object' ? s.tablet : {}, beats, mode: s.mode === 'all' ? 'all' : 'one', done, built: (s.built || []).filter((b) => !done.includes(b)), current: next < 0 ? Math.max(0, beats.length - 1) : (beats[s.current] && !done.includes(beats[s.current].id) ? s.current : next),
    make: { since: { ...(s.make?.since || {}) }, secs: [...(s.make?.secs || [])] } };
};
const writeScenes = (root, id, st) => update(root, id, (p) => { p.mfx ||= {}; p.mfx.motion_scenes = { current: st.current, done: st.done, built: st.built, mode: st.mode, ...(st.ahead ? { ahead: st.ahead } : {}), ...(Object.keys(st.ahead_at || {}).length ? { ahead_at: st.ahead_at } : {}), ...(st.tablet && Object.keys(st.tablet).length ? { tablet: st.tablet } : {}), ...(st.make && (st.make.secs.length || Object.keys(st.make.since).length) ? { make: st.make } : {}) }; });

// Video Notes (svc/videonotes.mjs): what the tablet is doing with each scene, kept on the scene state.
// The owner's OKs on the Motion scenes (motion.scene.approve): {ok, total, waiting}, or null with no scenes.
export const sceneOks = (root, id) => { try { const st = readScenes(root, id); return st.beats.length ? { ok: st.done.length, total: st.beats.length, waiting: st.built.length } : null; } catch { return null; } };
export const sceneTablet = (root, id) => readScenes(root, id).tablet;
export const setSceneTablet = (root, id, beat, patch) => { const st = readScenes(root, id); st.tablet = { ...st.tablet, [beat]: patch === null ? undefined : { ...(st.tablet[beat] || {}), ...patch } }; if (!st.tablet[beat]) delete st.tablet[beat]; writeScenes(root, id, st); return st.tablet[beat] || null; };
export const sceneState = (root, id) => { const st = readScenes(root, id); return { beats: st.beats, done: st.done, built: st.built }; };

// The scenes the animatic builds now: {mode, beats, current, done, only: <beat id>|null}. only = one scene, null = the whole video.
export function scenePlan(root, id) {
  const st = readScenes(root, id);
  const all = st.done.length >= st.beats.length;
  return { ...st, only: st.mode === 'one' && st.beats.length > 1 && !all ? st.ahead || st.beats[st.current].id : null };
}

// The scene after the current one, if it may be started ahead now: the current one is built (with the owner), nothing is
// ahead yet, and the next one is not built. It is never more than one scene ahead.
export function sceneAheadStart(root, id) {
  const st = readScenes(root, id);
  const now = st.beats[st.current];
  const next = st.beats[st.current + 1];
  if (st.mode !== 'one' || st.ahead || !now || !next || !st.built.includes(now.id) || st.built.includes(next.id) || st.done.includes(next.id)) return null;
  st.ahead = next.id;
  st.ahead_at[next.id] = Date.now();
  st.make.since[next.id] ||= Date.now();
  writeScenes(root, id, st);
  return next;
}

// Notes written since the next scene was started: it was made without them.
function notesSince(root, id, at) {
  if (!at) return 0;
  return readList(join(projectPaths(root, id).state, 'notes', 'notes.json')).filter((n) => Date.parse(n.at) >= at).length;
}

// motion.scene.get
export function sceneGet(root, id) {
  const st = readScenes(root, id);
  // Each scene's own clip (out/scenes/<file>, absolute path for the app's /file) and the joined animatic once it exists.
  const out = join(projectPaths(root, id).work, 'out');
  let clips = [];
  try { clips = JSON.parse(readFileSync(join(out, 'scenes', 'clips.json'), 'utf8')); } catch { /* none rendered yet */ }
  const clipOf = (beat) => { const c = clips.find((x) => (x.beats || []).includes(beat)); const f = c && join(out, 'scenes', c.file); return f && existsSync(f) ? { file: f, from: c.from, to: c.to } : null; };
  // Version 1, 2, …: every clip the scene has had (a Fix adds one), oldest first, absolute paths
  const versionsOf = (beat) => { const c = clips.find((x) => (x.beats || []).includes(beat)); return (c?.versions || []).map((v) => ({ n: v.n, file: join(out, 'scenes', v.file) })).filter((v) => existsSync(v.file)); };
  // a send that failed (tablet folder unwritable, no clip) carries its error and is 'not sent', never shown as queued
  const tabletOf = (b) => { const t = st.tablet[b]; return t ? { id: t.id ?? null, status: t.error && !t.id ? 'not sent' : t.status || 'to review', notes: t.notes || 0, handled: Boolean(t.handled), error: t.error || null } : null; };
  const animatic = join(out, 'animatic.mp4');
  const next = st.beats[st.current + 1];
  const nextStarted = next && (st.ahead === next.id || st.built.includes(next.id));
  const nextNotes = nextStarted ? notesSince(root, id, st.ahead_at[next.id]) : 0;
  // eta_s: median of this project's past make times, less the time already spent; null when no scene was timed yet
  const secs = [...st.make.secs].sort((a, b) => a - b);
  const med = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
  const etaOf = (b) => med === null ? null : Math.max(0, Math.round(med - (st.make.since[b] ? (Date.now() - st.make.since[b]) / 1000 : 0)));
  return {
    current: st.current, total: st.beats.length, mode: st.mode,
    // the scene after this one: already made or being made ahead, and how many notes came after it was started
    next: nextStarted ? { beat: next.id, made: st.built.includes(next.id), notes: nextNotes, ask: nextNotes >= ASK_NOTES } : null,
    // the median time one scene took to make in this project (the banner's "about N min" comes from it too); null = none timed
    make_s: med === null ? null : Math.round(med),
    animatic: existsSync(animatic) ? animatic : null,
    scenes: st.beats.map((b, i) => ({ beat: b.id, name: b.name, state: st.done.includes(b.id) ? 'ok' : st.built.includes(b.id) ? (st.mode === 'one' && i > st.current ? 'ready' : 'review') : (st.mode === 'all' || i === st.current || st.ahead === b.id) ? 'making' : 'waiting', clip: clipOf(b.id), versions: versionsOf(b.id), tablet: tabletOf(b.id), ...(st.done.includes(b.id) || st.built.includes(b.id) || !(st.mode === 'all' || i === st.current) ? {} : { eta_s: etaOf(b.id) }) })),
    lessons_waiting: waitingLessons(root, id),
  };
}

// Records that the studio built (and submitted) these scenes: they wait for the owner's OK.
export function sceneBuilt(root, id, beatIds) {
  const st = readScenes(root, id);
  const now = Date.now();
  if (beatIds.includes(st.ahead)) st.ahead = null;
  for (const b of beatIds) { const t0 = st.make.since[b]; if (t0 && now > t0) st.make.secs = [...st.make.secs, Math.round((now - t0) / 1000)].slice(-20); delete st.make.since[b]; }
  st.built = [...new Set([...st.built, ...beatIds])].filter((b) => !st.done.includes(b));
  writeScenes(root, id, st);
}

// The Motion step was submitted (by the studio's quick path or by a session): the scene(s) being made that have their
// clip are built and wait for the owner. 2026-11-02, d4fd b02: a session built and submitted scene 2, nothing called
// sceneBuilt, and the Motion screen stayed on "Regenerating" with no Approve.
// out/scenes.json (a session's list: {scenes:[{beat, file, from_frame, frames}]}) -> out/scenes/clips.json ([{beats, file,
// from, to, versions}]), only for clips that exist.
function adoptSessionScenes(out) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(out, 'scenes.json'), 'utf8')); } catch { return; }
  const idx = join(out, 'scenes', 'clips.json');
  let clips = [];
  try { clips = JSON.parse(readFileSync(idx, 'utf8')); } catch { /* the session's list starts it */ }
  let changed = false;
  for (const s of doc.scenes || []) {
    if (!s.beat || !s.file) continue;
    const file = String(s.file).replace(/^out\/scenes\//, '').replace(/^scenes\//, '');
    if (!existsSync(join(out, 'scenes', file))) continue;
    const from = Number(s.from_frame) || 0;
    const to = from + (Number(s.frames) || 0);
    const n = Number(/-v(\d+)\./.exec(file)?.[1]) || 1;
    const had = clips.find((c) => (c.beats || []).includes(s.beat));
    if (!had) { clips.push({ beats: [s.beat], file, from, to, versions: [{ n, file }] }); changed = true; }
    else if (had.file !== file && (had.beats || []).length === 1) {
      // the session remade the scene: its clip becomes the next version
      const versions = had.versions?.length ? had.versions : [{ n: 1, file: had.file }];
      Object.assign(had, { file, from, to, versions: versions.some((v) => v.file === file) ? versions : [...versions, { n: Math.max(n, ...versions.map((v) => v.n + 1)), file }] });
      changed = true;
    }
  }
  if (changed) writeFileSync(idx, JSON.stringify(clips.sort((x, y) => x.from - y.from), null, 1));
}

export function scenesSubmitted(root, id) {
  const st = readScenes(root, id);
  let clips = [];
  const idx = join(projectPaths(root, id).work, 'out', 'scenes', 'clips.json');
  // 2026-11-04 Texas b01, b02: the Motion session rendered out/scenes/<beat>-v1.mp4 and listed it in out/scenes.json only, so
  // the scene stayed "Generating" and had no OK. What its list adds goes into clips.json (every clips.json reader).
  adoptSessionScenes(join(projectPaths(root, id).work, 'out'));
  try { clips = JSON.parse(readFileSync(idx, 'utf8')); } catch { return []; }
  const has = (b) => clips.some((c) => (c.beats || []).includes(b) && existsSync(join(projectPaths(root, id).work, 'out', 'scenes', c.file)));
  // a scene made ahead: only it is new; the current one may be waiting for its Fix with its old clip still there
  const making = st.ahead ? [st.ahead] : st.beats.filter((b, i) => !st.done.includes(b.id) && !st.built.includes(b.id) && (st.mode === 'all' || i === st.current)).map((b) => b.id);
  const built = making.filter(has);
  if (built.length) sceneBuilt(root, id, built);
  return built;
}

// The scene is being made again from the owner's notes: it is no longer waiting for a look (it comes back through sceneBuilt).
export function sceneRemaking(root, id, beat) {
  const st = readScenes(root, id);
  st.built = st.built.filter((b) => b !== beat);
  st.make.since[beat] = Date.now();
  delete st.ahead_at[beat];
  writeScenes(root, id, st);
}

// motion.scene.approve {beat}: this scene is the owner's; the next one becomes the current. Returns the new state plus
// `next` (the beat to build now, or null when every scene is OK).
export function sceneApprove(root, id, beat) {
  const st = readScenes(root, id);
  const b = String(beat || '');
  if (!st.beats.some((x) => x.id === b)) throw new UserError(`no scene ${b || '(none)'}`);
  if (st.mode === 'one' && b !== st.beats[st.current]?.id && !st.done.includes(b)) throw new UserError(`scene ${st.beats[st.current].id} is the one being checked now: approve it first`);
  if (!st.done.includes(b)) st.done.push(b);
  st.built = st.built.filter((x) => x !== b);
  const nx = st.beats.findIndex((x) => !st.done.includes(x.id));
  const nextReady = nx >= 0 && st.built.includes(st.beats[nx].id);
  const nextMaking = nx >= 0 && st.ahead === st.beats[nx].id;
  st.current = nx < 0 ? st.beats.length - 1 : nx;
  const now = Date.now();
  for (const x of (st.mode === 'all' ? st.beats.filter((y) => !st.done.includes(y.id)) : nx < 0 ? [] : [st.beats[nx]])) if (!st.built.includes(x.id)) st.make.since[x.id] ||= now;
  writeScenes(root, id, st);
  return { ...sceneGet(root, id), approved: b, next: nx < 0 ? null : st.beats[nx].id, next_ready: nextReady, next_making: nextMaking, rest: st.mode === 'all' ? st.beats.filter((x) => !st.done.includes(x.id)).length : (nx < 0 ? 0 : 1) };
}

// motion.scene.all {confirm}: making every other scene together. Never without the owner saying so, and the warning first.
export function sceneAll(root, id, confirm = false) {
  const st = readScenes(root, id);
  const rest = st.beats.length - st.done.length;
  if (st.mode === 'all' || rest <= 1) return { ...sceneGet(root, id), needs_confirm: false, started: false };
  if (!confirm) {
    const k = st.current + 1;
    return { needs_confirm: true, warning: `Making the other ${rest - 1} scenes now means none of them learn from your notes on scene ${k}. On Notional that wasted scenes 2\u201310. Make them one at a time instead?`, rest: rest - 1, current: st.current };
  }
  st.mode = 'all';
  writeScenes(root, id, st);
  return { ...sceneGet(root, id), needs_confirm: false, started: true };
}

// Old names (motion.first.*).
export function firstGet(root, id) {
  const st = readScenes(root, id);
  return { beat: st.beats[0]?.id || null, approved: st.done.includes(st.beats[0]?.id), at: null, waiting: waitingLessons(root, id) };
}
export const firstPending = (root, id) => { try { return !readScenes(root, id).done.length; } catch { return false; } };

// The animatic is held while the owner has scenes left to approve one by one: it cannot be approved before every scene is OK.
export function firstWaits(root, id) {
  try { const st = readScenes(root, id); return st.mode === 'one' && st.beats.length > 1 && st.done.length < st.beats.length; } catch { return false; }
}
export const scenesHeld = firstWaits;

export function firstApprove(root, id, approved = true) {
  const st = readScenes(root, id);
  if (!approved) { writeScenes(root, id, { ...st, done: st.done.filter((b) => b !== st.beats[0]?.id), current: 0 }); return firstGet(root, id); }
  if (st.beats[0] && !st.done.includes(st.beats[0].id)) sceneApprove(root, id, st.beats[0].id);
  return firstGet(root, id);
}
