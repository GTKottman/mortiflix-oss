// What the AI is working on right now, in plain words (owner's first run: "It should be obvious what's being worked on",
// "That wasn't clear in the application at all"). The service sends it as the `work.active` event whenever it changes;
// the app animates exactly these pieces (node area, the preview's shot bar, the chat's "talking about" item, the stage
// bar step) and shows `doing` in the stage bar hint and the chat's Now line.
//
// Only real state: a session is running for the project (the runner), the owner's open edit requests (the runner does
// those first), else the step the runner works on (the first ready / working / changes step, as the runner and the demo
// pick it) and its canvas pieces not made yet; the newest activity line that names one of them is `current`; a running
// render of the project adds its percent.
import { loadProject, projectPipeline, readEvents } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { stageOf } from './stages.mjs';

const NAME = { shot: (n) => `shot ${Number(n.id.slice(1)) || n.label}`, transition: (n) => `the cut ${n.label}`, frame: (n) => `look ${n.label}`, layout: (n) => `layout frame ${n.label}`, line: (n) => `line ${n.id}`, cue: (n) => `music cue ${n.label}`, beat: (n) => `beat ${Number(n.id.slice(1)) || n.label}` };
const nameOf = (n) => (NAME[n.kind] ? NAME[n.kind](n) : n.label || n.id);
const refsIn = (text) => [...new Set([...String(text).matchAll(/\b([bsmt]\d{2,3}(?:-\d+)?|sf\d{2,3})\b/gi)].map((m) => m[1].toLowerCase()))];
const versionsOf = (n) => (n.versions || []).filter((v) => v.file || v.path).length;
const made = (n) => Boolean(n.versions?.length) && !n.planned;

// Minutes a step takes in this project so far (the gaps between its steps' hand-ins), for "about N min".
function minutesPerStep(root, id) {
  let events = [];
  try { events = readEvents(root, id, { limit: 5000 }); } catch { return null; }
  const marks = events.filter((e) => ['STARTED', 'SUBMITTED', 'STEP_DONE'].includes(e.event)).map((e) => Date.parse(e.t)).filter(Number.isFinite);
  const gaps = marks.slice(1).map((t, i) => (t - marks[i]) / 60_000).filter((m) => m > 0.05 && m < 120);
  if (!gaps.length) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

// The plain-words line for a step: what it makes and how far it is ("Animating shot 4 of 8").
function stepWords(step, g, project) {
  const nodes = Object.values(g.nodes).filter((n) => !n.missing && n.state !== 'cut');
  const of = (kind) => nodes.filter((n) => n.kind === kind);
  const shots = of('shot');
  const status = String(project.status?.text || '');
  if (/voice|narrat/i.test(status) || (step.work || []).includes('voice')) {
    const lines = of('line');
    const done = lines.filter((n) => versionsOf(n) > 0).length;
    return lines.length ? { text: `Recording the voice: line ${Math.min(done + 1, lines.length)} of ${lines.length}`, done, total: lines.length, noun: 'lines' } : { text: 'Recording the voice' };
  }
  switch (step.canvas) {
    case 'beat': {
      const n = of('beat').length;
      return { text: n ? `Writing the script: ${n} scene${n === 1 ? '' : 's'} so far` : 'Writing the script', done: n, total: null, noun: 'scenes' };
    }
    case 'frame': {
      const n = of('frame').filter(made).length;
      return { text: `Making the looks (style samples, not the shots)${n ? `: ${n} so far` : ''}`, done: n, total: null, noun: 'looks' };
    }
    case 'transition': {
      const total = Math.max(0, shots.length - 1);
      const done = of('transition').filter((n) => n.from && n.to).length;
      return total ? { text: `Making the transitions between shots: cut ${Math.min(done + 1, total)} of ${total}`, done, total, noun: 'transitions' } : { text: 'Making the transitions between shots' };
    }
    case 'shot': {
      const done = shots.filter(made).length;
      return shots.length ? { text: `Animating shot ${Math.min(done + 1, shots.length)} of ${shots.length}`, done, total: shots.length, noun: 'shots' } : { text: 'Animating the shots' };
    }
    default: break;
  }
  const w = step.work || [];
  if (w.includes('music') || step.key === 'music' || step.key === 'score') return { text: 'Writing the music' };
  if (step.review === 'questions') return { text: 'Reading your idea and planning the video' };
  if (step.key === 'build' || step.key === 'final' || step.delivers) return { text: 'Putting the video together' };
  return { text: `Working on ${String(step.name || step.key).toLowerCase()}` };
}

// `running`: a session works on this project now. `g`: canvasView(). `activity`: the session's recent activity rows.
// `render`: the project's running render job, if any (render queue view).
export function activeWork(root, id, { running, g, activity = [], render = null }) {
  const out = { project: id, running: Boolean(running), step: null, nodes: [], current: null, doing: '', progress: null, shots_eta_min: null, before_shots: [] };
  let project;
  let view = [];
  let pipeline;
  try {
    project = loadProject(root, id);
    pipeline = projectPipeline(root, id);
    view = stepView(project, pipeline);
  } catch { return out; }
  // Before any shot exists: which steps come first, and about how long (stage 3's empty node area says so).
  const shotStep = view.find((s) => s.canvas === 'shot');
  const anyShotMade = Object.values(g.nodes).some((n) => n.kind === 'shot' && made(n));
  if (shotStep && !anyShotMade && !['approved', 'done', 'skipped', 'in_review'].includes(shotStep.state)) {
    const i = view.indexOf(shotStep);
    const left = view.slice(0, i + 1).filter((s) => !['approved', 'done', 'skipped', 'in_review'].includes(s.state));
    out.before_shots = left.filter((s) => s !== shotStep).map((s) => String(s.name || s.key));
    const per = minutesPerStep(root, id);
    if (per) out.shots_eta_min = Math.max(1, Math.round(per * left.length));
  }
  if (!out.running) return out;

  const live = Object.values(g.nodes).filter((n) => !n.missing && n.state !== 'cut');
  // The owner's Fixes come first (the runner does edit requests before anything else).
  const open = live.filter((n) => n.pending);
  if (open.length) {
    for (const n of open) out.nodes.push({ id: n.id, kind: n.kind, what: made(n) ? 'remaking' : 'making', v: (n.versions?.length || 0) + 1, edit: n.pending.id });
    const names = open.slice(0, 3).map(nameOf);
    out.doing = open.length === 1 ? `${made(open[0]) ? 'Remaking' : 'Making'} ${names[0]} (your Fix)` : `Remaking ${open.length} pieces you asked for: ${names.join(', ')}${open.length > 3 ? '…' : ''}`;
  } else {
    const step = view.find((s) => ['working', 'changes', 'ready'].includes(s.state));
    if (step) {
      out.step = { key: step.key, name: step.name || step.key, stage: stageOf(step), kind: step.canvas || null, state: step.state, version: (step.version || 0) + 1 };
      const words = stepWords(step, g, project);
      out.doing = words.text;
      if (words.total) out.progress = { done: words.done, total: words.total, noun: words.noun };
      if (step.canvas) {
        for (const n of live.filter((x) => x.kind === step.canvas)) {
          if (!made(n)) out.nodes.push({ id: n.id, kind: n.kind, what: 'making', v: 1 });
          else if (step.state === 'changes' && n.owner !== 'ok') out.nodes.push({ id: n.id, kind: n.kind, what: 'remaking', v: (n.versions?.length || 0) + 1 });
        }
      }
    }
  }
  // The piece the session is on: the newest activity line naming one of them, else the first (film order).
  const ids = new Set(out.nodes.map((n) => n.id));
  for (const a of [...activity].reverse()) {
    if (!['text', 'tool'].includes(a.kind)) continue;
    const hit = refsIn(a.text).find((r) => ids.has(r));
    if (hit) { out.current = hit; break; }
  }
  if (!out.current && out.nodes.length) {
    const order = [...(g.order?.shots || []), ...(g.order?.layouts || []), ...(g.order?.frames || []), ...(g.order?.lines || []), ...(g.order?.transitions || [])];
    out.current = [...out.nodes].sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9))[0].id;
  }
  if (render?.progress?.percent !== undefined) out.doing = `${out.doing || 'Rendering'} · rendering ${render.progress.percent}%`;
  if (!out.doing) out.doing = 'Working';
  return out;
}
