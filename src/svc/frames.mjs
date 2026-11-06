// Style frames, v3 (plan 90 + the owner's answers, 2026-11-01): the Look is made in ROUNDS OF 3 frames, like renders. The owner
// checks off EACH frame (OK, or Fix with notes). What they said on the frames before goes into the frames after. How many frames
// depends on the video: one per part of the script (short parts share a frame), and a long part holds its frame longer: there is
// no set length per frame. State lives in design/frames-state.json (every frame); design/frames.json is what the canvas and the
// later steps read (only frames that have a picture, `file` = the current version).
//
//   frame state   todo → writing → review (made, passed the studio's checks and the AI inspection) → ok | fix (notes sent: remade as a new version)
//                 held (shown with what is not satisfied: a studio measured check still failing after 2 fixes, or the AI inspection
//                 after 3 rounds; the owner decides: OK anyway, or Fix with a note, which also carries the check's result)
//                 skipped (the owner said "enough"; never made)
//   round         floor(index / 3) + 1. A round is written together (one Claude call); the next round starts when every frame of
//                 the rounds before is OK.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { projectPaths, event, loadProject } from '../projects.mjs';
import { measureFrame } from './inspect.mjs';
import { readPool } from './pool.mjs';
import { restartStep } from './restart.mjs';
import { UserError } from '../studio.mjs';
import { listLessons, listNotes, sendNotes, saveNote, waitingLessons } from './lessons.mjs';
import { loadFrames, saveFrames, framesFile, framesHeld, hasFramesWork } from './framestate.mjs';
export { loadFrames, saveFrames, framesFile, framesHeld, hasFramesWork };

export const FRAMES_PER_ROUND = 3; // the default; the owner's setting review.framesPerRound (1-6) replaces it when the frames are planned
export const MIN_HOLD_S = 5;   // a frame covers at least this much of the video: shorter parts share one
export const MAX_FRAMES = 12;
const pad = (n) => String(n).padStart(2, '0');

// ---- the plan: which parts of the script each frame covers ----
// scenes: [{id, name, from_sec, to_sec}] in script order. One frame per part; consecutive parts shorter than MIN_HOLD_S share one
// frame; more than MAX_FRAMES merges the shortest neighbours. hold_s = how long that part of the video is (a long part holds longer).
export function planFrames(scenes, { minHold = MIN_HOLD_S, max = MAX_FRAMES, perRound = FRAMES_PER_ROUND } = {}) {
  const dur = (s) => (Number.isFinite(s.to_sec) && Number.isFinite(s.from_sec) ? Math.max(0.5, s.to_sec - s.from_sec) : 6);
  const groups = [];
  let cur = null;
  for (const s of scenes) {
    if (!cur) cur = { scenes: [s], hold_s: dur(s) }; else { cur.scenes.push(s); cur.hold_s += dur(s); }
    if (cur.hold_s >= minHold) { groups.push(cur); cur = null; }
  }
  if (cur) { if (groups.length && cur.hold_s < minHold) { const g = groups.at(-1); g.scenes.push(...cur.scenes); g.hold_s += cur.hold_s; } else groups.push(cur); }
  while (groups.length > max) {
    let best = 0;
    for (let i = 1; i + 1 < groups.length; i++) if (groups[i].hold_s + groups[i + 1].hold_s < groups[best].hold_s + groups[best + 1].hold_s) best = i;
    groups.splice(best, 2, { scenes: [...groups[best].scenes, ...groups[best + 1].scenes], hold_s: groups[best].hold_s + groups[best + 1].hold_s });
  }
  return groups.map((g, i) => ({ id: `sf${pad(i + 1)}`, composition: `SF${pad(i + 1)}`, beats: g.scenes.map((s) => s.id), label: `SF${pad(i + 1)} · ${g.scenes[0].name || g.scenes[0].id}${g.scenes.length > 1 ? ` + ${g.scenes.length - 1} more` : ''}`, hold_s: Math.round(g.hold_s * 10) / 10, round: Math.floor(i / perRound) + 1, state: 'todo', current: null, versions: [] }));
}

// ---- state: svc/framestate.mjs (fs only, so gates.mjs can ask whether frames are still open) ----
export const ensurePlan = (work, scenes, { perRound } = {}) => {
  const st = loadFrames(work);
  if (st.planned) return st;
  st.frames = planFrames(scenes, { perRound }); st.planned = true; st.planned_at = new Date().toISOString();
  saveFrames(work, st);
  return st;
};

// What the studio does next: {kind: 'fix' | 'write' | 'wait' | 'done', frames, round}.
export function nextAction(st) {
  const fix = st.frames.filter((f) => f.state === 'fix');
  if (fix.length) return { kind: 'fix', frames: fix, round: fix[0].round };
  if (st.frames.some((f) => ['review', 'held'].includes(f.state))) return { kind: 'wait', frames: st.frames.filter((f) => ['review', 'held'].includes(f.state)), round: null };
  const todo = st.frames.filter((f) => ['todo', 'writing'].includes(f.state));
  if (todo.length && !st.enough) { const round = todo[0].round; return { kind: 'write', frames: todo.filter((f) => f.round === round), round }; }
  return { kind: 'done', frames: [], round: null };
}

// ---- pictures with no version: a run that stopped after rendering (a takeover session, a restart, a give-up) ----
// A frame whose next picture (out/frames/<id>-v<n>.png) exists while no session runs on the project is recorded as that version,
// measured again from its saved inspect.json and the picture: review when the measured checks pass (no AI inspection ran: said in
// its note), held with the check result when they fail. It is never left as "Failed" over a picture that exists (2026-11-02, d4fd).
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
export function adoptRendered(root, id, st, work) {
  try { if (loadProject(root, id).session) return []; } catch { return []; }
  const adopted = [];
  for (const f of st.frames) {
    if (!['todo', 'writing', 'fix'].includes(f.state)) continue;
    const v = (f.versions.at(-1)?.v || 0) + 1;
    const rel = `out/frames/${f.id}-v${v}.png`;
    if (!existsSync(join(work, rel))) continue;
    let m = null;
    try {
      const inspect = JSON.parse(read(join(work, 'out', 'frames', `${f.id}-v${v}.inspect.json`)));
      const code = ['src/ui.tsx', `src/scenes/${f.id}.tsx`].map((x) => read(join(work, 'video', x))).join('\n');
      m = measureFrame({ inspect, png: readFileSync(join(work, rel)), pool: readPool(root, id), code, work });
    } catch (e) { m = { ok: false, checks: {}, problems: [`not measured: ${String(e.message).slice(0, 160)}`] }; }
    const held = m.ok ? null : m.problems.map((p) => `Studio check · ${p}`.slice(0, 500));
    f.versions.push({ v, file: rel, at: new Date().toISOString(), notes: 0, adopted: true, measured: { ok: m.ok, problems: m.problems, checks: Object.fromEntries(Object.entries(m.checks || {}).map(([k, x]) => [k, { pass: x.pass, note: x.note }])) }, inspection: held ? { rounds: 0, sections: {}, held: true, measured: true, unresolved: held } : null });
    Object.assign(f, { current: v, state: held ? 'held' : 'review', held, fix_notes: [], note: f.note || 'Drawn before the run stopped: the studio measured it again; the AI inspection did not run on it.' });
    adopted.push(f.id);
  }
  if (adopted.length) {
    saveFrames(work, st);
    try { event(root, id, { event: 'FRAMES_ADOPTED', actor: 'studio', details: `pictures drawn before the run stopped, now shown: ${adopted.join(', ')}` }); } catch { /* no log */ }
  }
  return adopted;
}

// ---- the owner's side: what the app shows, OK, Fix, enough ----
const abs = (work, f) => (f ? join(work, f) : null);
export function framesView(root, id) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  adoptRendered(root, id, st, work);
  const notes = listNotes(root, id).notes.filter((n) => /^sf\d+$/.test(n.node));
  const frames = st.frames.map((f) => {
    const cur = f.versions.find((v) => v.v === f.current) || null;
    const mine = notes.filter((n) => n.node === f.id);
    return { id: f.id, label: f.label, beats: f.beats, hold_s: f.hold_s, round: f.round, state: f.state, version: f.current, versions: f.versions.map((v) => ({ v: v.v, path: abs(work, v.file), notes: v.notes || 0, ok: v.measured?.ok ?? null, problems: v.measured?.problems || [], inspection: v.inspection || null })),
      fix_sent: f.state === 'fix' ? Boolean(f.fix_sent_at) : null, path: abs(work, cur?.file), held: f.held || null, inspection: cur?.inspection || null, why: f.why || '', note: f.note || '', pool_assets: f.pool_assets || [], pending_notes: mine.filter((n) => n.pending).length, notes_total: mine.length,
      notes: mine.map((n) => ({ id: n.id, text: n.text || '', time: n.time || 0, image: n.image || null, pending: Boolean(n.pending), lesson: n.lesson || null, version: n.version ?? null })) };
  });
  const act = nextAction(st);
  const ok = frames.filter((f) => f.state === 'ok').length;
  const round = act.round || (frames.filter((f) => f.state === 'review')[0]?.round ?? null);
  return { project: id, planned: st.planned, enough: st.enough === true, total: frames.length, ok, round, rounds: Math.max(0, ...frames.map((f) => f.round)), fixes_waiting: unsent(st).length,
    // Fixes kept and not sent yet are the owner's: the studio has nothing to do until they go
    waiting_for: !st.planned ? 'studio' : act.kind === 'wait' || (act.kind === 'fix' && act.frames.every((f) => !f.fix_sent_at)) ? 'you' : act.kind === 'done' ? 'done' : 'studio',
    ok_words: okSentence(st), frames, usage: st.rounds.slice(-6), lessons_waiting: waitingLessons(root, id) };
}
// The words the decision row shows: what OK does for the frame in review (matches the tablet's ok_words).
export function okSentence(st) {
  const left = st.frames.filter((f) => !['ok', 'skipped'].includes(f.state));
  const nextRound = st.frames.some((f) => f.state === 'todo');
  return { notes: 'OK · Remake this frame', none: left.length <= 1 && !nextRound ? 'OK · Look is done' : nextRound && left.filter((f) => f.state === 'review').length <= 1 ? `OK · Next round` : 'OK · Next frame' };
}

const restartFrames = (root, id, text) => restartStep(root, id, 'style-frames', text);

// ---- Fix notes are collected, then sent together (2026-11-02, Dir1 bdb9: a Fix on SF01 restarted the step at once with
// "1 note on frame sf01" and no words; the Fixes on SF02/SF03 seconds later reached nobody) ----
// A Fix keeps the frame's notes on it (state fix, not sent). They go when no frame waits for the owner's decision any more
// (every made frame is OK or Fix), or when the owner presses "Send N fixes" (frames.send_fixes): ONE restart whose words carry
// every frame's notes, and the remake prompt carries each frame's own (fix_notes).
const unsent = (st) => st.frames.filter((f) => f.state === 'fix' && !f.fix_sent_at);
// still to be decided: a frame in review or held, and a frame being remade now (its new version comes back for a decision)
const undecided = (st) => st.frames.filter((f) => ['review', 'held'].includes(f.state) || (f.state === 'fix' && f.fix_sent_at));
export function fixesWords(fixes) {
  return `The owner's notes on ${fixes.length} frame${fixes.length === 1 ? '' : 's'}: remake ${fixes.length === 1 ? 'that frame' : 'those frames'}, each with its own notes.\n${fixes.map((f) => `- ${f.id}: ${(f.fix_notes || []).map((n) => n.text || (n.image ? '(pen marks only)' : '')).filter(Boolean).join(' | ') || '(no words)'}`).join('\n')}`;
}
function sendFixes(root, id, work, st) {
  const fixes = unsent(st);
  if (!fixes.length) return null;
  // sent only when the step really goes back to the studio; a step that is working keeps them for its next decision
  let gone = null;
  try { gone = restartFrames(root, id, fixesWords(fixes)); } catch { gone = null; }
  if (!gone) return null;
  const at = new Date().toISOString();
  for (const f of fixes) f.fix_sent_at = at;
  saveFrames(work, st);
  try { event(root, id, { event: 'FRAME_FIXES_SENT', actor: 'you', details: fixes.map((f) => f.id).join(', ') }); } catch { /* no log */ }
  return fixes.map((f) => f.id);
}
// The fixes go by themselves once nothing is left to decide.
const sendIfDecided = (root, id, work, st) => (!undecided(st).length ? sendFixes(root, id, work, st) : null);

// frames.send_fixes: the owner sends the Fixes kept so far now, without deciding the other frames first.
export function sendFixesNow(root, id) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  if (!unsent(st).length) throw new UserError('No fix is waiting to be sent: press Fix on a frame first');
  const sent = sendFixes(root, id, work, st);
  if (!sent) throw new UserError('The studio is working on the Look now: your fixes are kept and go with your next decision');
  return { ...framesView(root, id), sent };
}

const need = (st, fid) => st.frames.find((f) => f.id === fid) || (() => { throw new UserError(`no frame ${fid || '(none)'}`); })();

// frames.ok {frame}: this frame is the owner's. The rest of its round is still theirs to check; when the last frame of the rounds so
// far is OK, the next round is written (the step is restarted). Returns the new view plus `next`: 'round' | 'wait' | 'done'.
export function okFrame(root, id, fid) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  const f = need(st, fid);
  if (f.state === 'ok') return { ...framesView(root, id), approved: fid, next: nextOf(st) };
  if (!['review', 'held'].includes(f.state)) throw new UserError(`${fid} is ${f.state}: only a made frame can be OK'd`);
  // OK on a held frame is the owner's "OK anyway": the unresolved check stays on the version, marked as their call
  if (f.state === 'held') { const v = f.versions.find((x) => x.v === f.current); if (v) v.ok_anyway = f.held || []; f.held = null; }
  f.state = 'ok'; f.ok_at = new Date().toISOString();
  saveFrames(work, st);
  try { event(root, id, { event: 'FRAME_OK', actor: 'you', details: `${f.id} v${f.current}` }); } catch { /* no log */ }
  const next = nextOf(st);
  if (next === 'round') { try { restartFrames(root, id, `Frame ${fid} is approved and the round is done: write the next round of frames, with the owner's notes on the frames so far.`); } catch { /* not in review: the runner continues by itself */ } }
  const sent = sendIfDecided(root, id, work, st);
  return { ...framesView(root, id), approved: fid, next: sent ? 'fixes' : next, ...(sent ? { sent } : {}) };
}
const nextOf = (st) => { const a = nextAction(st); return a.kind === 'write' ? 'round' : a.kind === 'done' ? 'done' : 'wait'; };

// frames.fix {frame, text?}: the notes on this frame go as ONE fix; the frame is remade as a new version (the old ones are kept).
export async function fixFrame(root, id, fid, { text = '', ask = null } = {}) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  const f = need(st, fid);
  if (!['review', 'ok', 'held'].includes(f.state)) throw new UserError(`${fid} is ${f.state}: only a made frame can be fixed`);
  if (String(text).trim()) await saveNote(root, id, { node: fid, text, send: false }, { ask });
  const checks0 = f.state === 'held' ? (f.held || []) : [];
  if (!listNotes(root, id, fid).notes.some((n) => n.pending) && !checks0.length) throw new UserError(`Fix needs a note on ${fid}: type what to change (Enter keeps it) or mark the frame`);
  const sent = listNotes(root, id, fid).notes.some((n) => n.pending) ? sendNotes(root, id, fid, { fix: null }) : { notes: [] };
  const all = listNotes(root, id, fid).notes.filter((n) => sent.notes.includes(n.id));
  // a held frame's Fix also carries what was not satisfied (the measured check's boxes and px), so a note is optional
  const checks = checks0.map((t) => ({ text: t, image: null, time: 0 }));
  f.fix_notes = [...all.map((n) => ({ text: n.text || '', image: n.image || null, time: n.time || 0 })), ...checks];
  f.held = null;
  f.state = 'fix'; f.fix_at = new Date().toISOString(); f.fix_sent_at = null;
  const v = f.versions.find((x) => x.v === f.current); if (v) v.notes = all.length;
  saveFrames(work, st);
  try { event(root, id, { event: 'FRAME_FIX', actor: 'you', details: `${f.id}: ${all.length} note${all.length === 1 ? '' : 's'}` }); } catch { /* no log */ }
  // kept until every frame has a decision (or the owner presses Send fixes), then sent together
  const gone = sendIfDecided(root, id, work, st);
  return { ...framesView(root, id), fixing: fid, notes: all.length, ...(gone ? { sent: gone } : {}) };
}

// frames.enough: stop making frames; every frame not made yet is skipped. The Look can be approved once the made ones are OK.
export function enoughFrames(root, id) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  st.enough = true;
  for (const f of st.frames) if (['todo', 'writing'].includes(f.state)) f.state = 'skipped';
  saveFrames(work, st);
  return framesView(root, id);
}

// frames.send_anyway {frame}: a held frame goes to review as it is (frames.ok on a held frame does the same and OKs it at once).
export function sendAnyway(root, id, fid) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  const f = need(st, fid);
  if (f.state !== 'held') throw new UserError(`${fid} is ${f.state}: only a held frame can be sent anyway`);
  f.state = 'review';
  const v = f.versions.find((x) => x.v === f.current); if (v?.inspection) v.inspection.sent_anyway = true;
  saveFrames(work, st);
  try { event(root, id, { event: 'FRAME_SENT_ANYWAY', actor: 'you', details: `${f.id}: ${(f.held || []).join(' | ').slice(0, 200)}` }); } catch { /* no log */ }
  return { ...framesView(root, id), sent: fid };
}

// frames.retry {frame}: try again: the unresolved inspection items go back to the writer as the corrections to make (3 more rounds).
export function retryFrame(root, id, fid) {
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  const f = need(st, fid);
  if (f.state !== 'held') throw new UserError(`${fid} is ${f.state}: only a held frame can be tried again`);
  f.fix_notes = (f.held || []).map((t) => ({ text: `Inspection: ${t}`, image: null, time: 0 }));
  f.state = 'fix'; f.held = null; f.fix_sent_at = null;
  saveFrames(work, st);
  sendIfDecided(root, id, work, st);
  return { ...framesView(root, id), retrying: fid };
}
