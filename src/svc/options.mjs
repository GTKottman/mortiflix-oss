// Smart options instead of chat (Redesign parts/95-smart-options.md, owner 2026-11-01: "an intelligent UI over the chat,
// where we give options and stuff, and the back end is Claude, but there's no back and forth chat").
// Each screen shows up to 4 option buttons for what makes sense there. options.get answers at once: the cached options
// when the state token is unchanged, else the stage's defaults while one cheap call (role `options` = Haiku) makes fresh
// ones in the background (event `options.ready`). options.run turns one option into one action: a Fix on each piece it
// names (an OK'd piece asks first), or, with no piece to point at, an instruction the AI reads before its next work.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectPaths, loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { stageSet, stageOf } from './stages.mjs';
import { canvasView, nodeAction } from '../canvas.mjs';
import { askAI } from './chat.mjs';

export const STAGES = ['script', 'voice', 'look', 'stills', 'motion', 'sound', 'finish'];
export const MAX = 4; // the default count; the owner's setting options.count (1-8) replaces it (svc/reviewsize.mjs)
const VERSION = 3; // bump when the prompt changes: old cached options are made again (2: options fit their stage; 3: no dated moves on Motion)
// Which canvas pieces belong to a stage (canvasView kinds).
const KINDS = { script: ['beat'], voice: ['line', 'cue'], look: ['frame'], stills: ['frame'], motion: ['shot'], sound: [], finish: [] };
// Shown at once, with no AI call (and for the demo backend, or when the call fails). [label, text of the Fix]
const DEFAULTS = {
  script: { stage: [['Shorter', 'Make the script shorter: cut what repeats, keep every point.'], ['Stronger hook', 'Make the opening line a stronger hook.'], ['Plainer words', 'Use plainer, everyday words.']],
    piece: [['Shorter', 'Make this scene shorter.'], ['Plainer words', 'Say this scene in plainer words.'], ['Split in two', 'Split this scene into two scenes.']] },
  voice: { stage: [['Calmer read', 'Read the whole voice calmer.'], ['More energy', 'Read the whole voice with more energy.']],
    piece: [['Slower', 'Read this line slower.'], ['Say it plainer', 'Say this line in plainer words.'], ['Remake this line', 'Remake this line.']] },
  look: { stage: [['Bolder colour', 'Use bolder colour across the look.'], ['More contrast', 'Give the look more contrast.'], ['Different type', 'Try a different typeface for the look.'], ['Closer to the brief', 'Make the look match the brief more closely.'], ['Less busy', 'Make the look less busy.']],
    piece: [['Less busy', 'Make this frame less busy.'], ['Bolder colour', 'Use bolder colour in this frame.'], ['More contrast', 'Give this frame more contrast.'], ['Different type', 'Use a different typeface in this frame.'], ['Closer to the brief', 'Make this frame match the brief more closely.']] },
  stills: { stage: [['Bigger text', 'Make the text bigger on every still.'], ['Less busy', 'Make the stills less busy.']],
    piece: [['Closer to the look', 'Make this still closer to the picked look.'], ['Bigger text', 'Make the text on this still bigger.'], ['Simpler', 'Make this still simpler.']] },
  motion: { stage: [['Slower', 'Make the motion slower overall.'], ['Calmer', 'Make the motion calmer overall.']],
    piece: [['Slower', 'Make the motion in this scene slower.'], ['Less busy', 'Make this scene less busy: fewer things moving at once.'], ['Match cut', 'Carry the cut out of this scene with an element on screen that morphs into its match on the next screen.'], ['Stronger finish', 'Give this scene a stronger finish.']] },
  sound: { stage: [['Quieter sounds', 'Make the sound effects quieter under the voice.'], ['Fewer sounds', 'Use fewer sound effects.']],
    piece: [['Softer', 'Make this sound softer.'], ['Shorter', 'Make this sound shorter.'], ['Remove this sound', 'Remove this sound.']] },
  finish: { stage: [], piece: [] },
  // A music cue on the Voice & music screen (target mc01..): music notes, never a voice read. {cue} = "Music 2".
  music: { stage: [], piece: [['Less busy', 'Make {cue} less busy: fewer instruments, more room for the voice.'], ['Darker', 'Make {cue} darker in mood and colour.'], ['More pulse', 'Give {cue} more pulse: a clearer, steadier beat.'], ['Quieter under the voice', 'Keep {cue} quieter under the voice.'], ['Different instrument', 'Make {cue} with a different lead instrument.']] },
};

// What each stage's options may change, for the prompt; and labels that belong to another stage (a script note like
// "Stronger hook" on Look), dropped from the AI's answer.
const SCOPE = {
  script: 'the words: length, the opening hook, plain wording, how the scenes are split',
  voice: 'how the narrator reads: speed, energy, plainer wording of a line, remaking a line; the music under it',
  look: 'the look of the frames: colour, contrast, type, layout, how busy a frame is, how close it is to the brief',
  stills: 'the stills: text size, how busy a still is, how close it is to the picked look',
  motion: 'how the scenes move: speed, how many things move at once, how a scene starts and ends. Never offer a fade, dissolve, wipe, iris or push (the owner\'s TASTE: everything fading in is the generic move they reject, and those cuts read as dated); a cut is carried by an element on screen that morphs into its match on the next screen, and moves vary from cut to cut',
  sound: 'the sound effects: how loud, how many, how long, removing one',
  finish: 'nothing',
  music: 'this music cue: mood, how busy it is, its pulse, its instruments, how loud it sits under the voice (never how the voice reads)',
};
const OFF_STAGE = {
  look: /hook|pacing|shorter|longer|script|plainer|read|voice|split|slower|faster/i,
  stills: /hook|pacing|shorter|longer|script|plainer|read|voice|split|slower|faster/i,
  motion: /hook|script|plainer words|read|voice/i,
  sound: /hook|script|plainer|pacing/i,
  music: /\bread\b|\bline\b|plainer|wording|split|hook|script|narrat/i,
};
// Moves the owner's TASTE rejects, dropped from Motion's options by their label or their words (2026-11-02, d4fd: "Soft fade")
const DATED = { motion: /\b(fade[sd]?|fading|dissolves?|wipes?|iris|push(es)?|cross-?fades?)\b/i };
/** True when an option fits the stage it is shown on (its label, and on Motion its words too). */
export const fitsStage = (stage, label, text = '') => !OFF_STAGE[stage]?.test(String(label || '')) && !DATED[stage]?.test(`${label || ''} ${text || ''}`);

const bad = (m) => { const e = new Error(m); e.code = 'bad_request'; throw e; };
const file = (root, id) => join(projectPaths(root, id).state, 'options.json');
function load(root, id) { try { return JSON.parse(readFileSync(file(root, id), 'utf8')); } catch { return { entries: {}, run: {} }; } }
function save(root, id, db) { const f = file(root, id); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, JSON.stringify(db, null, 1)); }
const key = (stage, target) => `${stage}|${target || ''}`;
const hash = (x) => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// A music cue the owner is looking at on the Voice & music screen (music/cues.json), or null. Cues are not board pieces.
function musicCue(root, id, stage, target) {
  if (stage !== 'voice' || !target) return null;
  try {
    const j = JSON.parse(readFileSync(join(projectPaths(root, id).work, 'music', 'cues.json'), 'utf8'));
    return (j.cues || []).find((c) => c.id === target) || null;
  } catch { return null; }
}
const cueWords = (id) => `Music ${Number(String(id).replace(/\D/g, '')) || id}`;

function view(root, id) { try { return canvasView(root, id); } catch { return { order: {}, nodes: {} }; } }

// The stage's steps and their versions ({key: version}), and the stage's ledger key (v3: script, voiceMusic, ... artcraft).
export function stageSteps(root, id, stage) {
  try {
    const pipeline = projectPipeline(root, id);
    const set = stageSet(pipeline);
    const idx = STAGES.indexOf(stage);
    const steps = stepView(loadProject(root, id), pipeline).filter((s) => stageOf(s, set) === idx);
    return { versions: Object.fromEntries(steps.map((s) => [s.key, s.version || 0])), key: set.id === 'v3' ? set.keys[idx] ?? null : null };
  } catch { return { versions: {}, key: null }; }
}

// What the options depend on: project + stage (+ piece) + the stage's step version. Same token = same options = no call:
// a reload, a piece being drawn or a question asked makes no new call; only a new version of the stage's step does.
export function stateOf(root, id, stage, target, count = MAX) {
  const g = view(root, id);
  const kinds = KINDS[stage] || [];
  const pieces = Object.values(g.nodes).filter((n) => kinds.includes(n.kind) && !n.missing).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const t = target ? g.nodes[target] || null : null;
  const questions = openQuestions(root, id);
  const steps = stageSteps(root, id, stage);
  const cue = musicCue(root, id, stage, target);
  const kind = cue ? 'music' : stage; // which defaults, scope and off-stage words apply
  const token = hash({ v: VERSION, count, stage, target: target || null, steps: steps.versions, ...(cue ? { kind } : {}) });
  return { g, pieces, t, questions, token, stageKey: steps.key, kind, cue };
}

export function openQuestions(root, id) {
  return (loadProject(root, id).questions || []).filter((q) => !q.answered_at).map((q) => ({
    id: q.id, text: short(q.text, 300), choices: Array.isArray(q.choices) ? q.choices.map((c) => short(c, 60)).slice(0, 6) : [], ...(q.default != null ? { default: String(q.default) } : {}) }));
}

// The money an option spends before it is run (ElevenLabs only; Claude runs are the owner's own subscription).
function costOf(stage, nodes) {
  if (!nodes.length) return stage === 'sound' ? { what: 'ElevenLabs sounds', amount: 'about 1 per sound remade' } : null;
  const lines = nodes.filter((n) => n.kind === 'line');
  if (lines.length) return { what: 'ElevenLabs characters', amount: String(lines.reduce((a, n) => a + String(n.title || '').length, 0)) };
  const cues = nodes.filter((n) => n.kind === 'cue');
  if (cues.length) return { what: 'ElevenLabs music cues', amount: String(cues.length) };
  return null;
}

function describe(o, g) {
  const names = o.nodes.map((n) => g.nodes[n]?.label || n);
  return o.nodes.length ? `Sends a Fix to ${names.join(', ')}: ${o.text}` : `Tells the AI before its next work: ${o.text}`;
}

// Raw options ({label, text, nodes}) -> what the app gets ({id, label, does, cost?}); the full option is kept server-side.
function finish(stage, target, raw, g, token, count = MAX, kind = stage) {
  const seen = new Set();
  return raw.filter((o) => o && o.label && o.text && fitsStage(kind, o.label, o.text) && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase())).slice(0, count).map((o, i) => {
    const nodes = (o.nodes || []).filter((n) => g.nodes[n]);
    const full = { label: short(o.label, 32), text: short(o.text, 600), nodes };
    const cost = costOf(stage, nodes.map((n) => g.nodes[n]));
    return { id: `${token}.${i}`, label: full.label, does: describe(full, g), ...(cost ? { cost } : {}), _: full };
  });
}

function defaults(stage, target, s) {
  const d = DEFAULTS[s.kind || stage] || { stage: [], piece: [] };
  const list = target ? d.piece : d.stage;
  return list.map(([label, text]) => ({ label, text: s.cue ? text.replace('{cue}', cueWords(s.cue.id)) : text, nodes: s.t ? [s.t.id] : [] }));
}

const PROMPT = (stage, target, s, project, count = MAX) => {
  const pieces = s.pieces.slice(0, 40).map((n) => `${n.id} ${n.label || ''} (${n.state}${n.owner ? ', ' + n.owner : ''}): ${short(n.title, 140)}`).join('\n');
  const kind = s.kind || stage;
  const about = s.cue ? `${cueWords(s.cue.id)}, a music cue under the voice (${s.cue.from_sec}-${s.cue.to_sec} s): ${short(s.cue.prompt || s.cue.mood, 400)}` : s.t ? `${s.t.id} ${s.t.label || ''} (${s.t.state}${s.t.owner ? ', ' + s.t.owner : ''}): ${short(s.t.title, 600)}` : target ? `${target} (not a piece on the board)` : 'the whole stage';
  return `You pick the option buttons a video app shows the owner. No chat: each button is one change the AI then makes.
Project "${short(project.title, 120)}". Stage: ${stage}${s.cue ? ' (the music)' : ''}. The owner is looking at: ${about}
Pieces in this stage:
${pieces || '(none yet)'}
Give up to ${count} option${count === 1 ? '' : 's'} that make sense for what the owner is looking at now, and only changes this stage makes: ${SCOPE[kind] || stage}. label = 1 to 3 plain words (e.g. ${(DEFAULTS[kind]?.stage?.length ? DEFAULTS[kind].stage : DEFAULTS[kind]?.piece || []).slice(0, 3).map(([l]) => `"${l}"`).join(', ') || '"Less busy"'}). text = the exact change to make, one short sentence. nodes = the piece ids it changes (the one being looked at, or [] for the whole stage). Never suggest publishing or posting.
Answer ONLY with JSON: {"options": [{"label": "...", "text": "...", "nodes": ["..."]}]}`;
};

export function parseOptions(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(j.options)) return null;
    return j.options.filter((o) => o && typeof o.label === 'string' && typeof o.text === 'string').map((o) => ({ label: o.label, text: o.text, nodes: Array.isArray(o.nodes) ? o.nodes.map(String) : [] }));
  } catch { return null; }
}

// One maker per project+stage+target at a time; `ask` is injectable for tests.
// `count()` = how many options the owner wants (settings options.count).
export function makeOptions({ root, emit = () => {}, ask = askAI, config = () => ({}), count: countOf = () => MAX }) {
  const running = new Map();

  function get({ project, stage, target }) {
    if (!STAGES.includes(stage)) bad(`options.get needs a stage (${STAGES.join(', ')})`);
    target = target ? short(target, 80) : null;
    if (target && !/^[\w:.-]+$/.test(target)) bad('bad target');
    const count = countOf(project);
    const s = stateOf(root, project, stage, target, count);
    const db = load(root, project);
    const k = key(stage, target);
    const hit = db.entries[k];
    const out = (raw, source, pending) => {
      const list = finish(stage, target, raw, s.g, s.token, count, s.kind);
      db.run = Object.fromEntries(Object.entries(db.run || {}).filter(([, r]) => key(r.stage, r.target) !== k)); // only this screen's latest buttons run
      for (const o of list) db.run[o.id] = { stage, target, ...o._, cost: o.cost || null };
      save(root, project, db);
      return { token: s.token, stage, target, source, pending, options: list.map(({ _, ...o }) => o), questions: s.questions };
    };
    if (hit && hit.token === s.token && Array.isArray(hit.options)) return out(hit.options, 'cache', false);
    const raw = defaults(stage, target, s);
    if (!raw.length && stage === 'finish') return out([], 'defaults', false);
    const backend = config(project)?.backend;
    if (backend === 'demo') return out(raw, 'defaults', false);
    if (!running.has(k + project)) {
      const job = (async () => {
        let made = null;
        try { made = parseOptions(await ask(root, project, PROMPT(stage, target, s, loadProject(root, project), count), { maxTokens: 500, role: 'options', stage: s.stageKey || stage })); } catch { made = null; }
        const now = stateOf(root, project, stage, target, count);
        if (now.token !== s.token) return; // the state moved on while Claude looked: the next get makes new ones
        const fresh = load(root, project);
        made = made ? made.filter((o) => fitsStage(s.kind, o.label, o.text)) : null; // another stage's notes are dropped; none left = the defaults
        fresh.entries[k] = { token: s.token, options: made && made.length ? made : raw, at: new Date().toISOString(), source: made && made.length ? 'ai' : 'defaults' };
        save(root, project, fresh);
        emit('options.ready', { project, stage, target, token: s.token });
      })().finally(() => running.delete(k + project));
      running.set(k + project, job);
    }
    return out(raw, 'defaults', true);
  }

  // `log(id, row)` writes the instruction into the project log the AI reads (chatRow); `wake()` starts the runner.
  function run({ project, id, confirm = false, confirm_cost = false }, { log, wake }) {
    const db = load(root, project);
    const o = db.run?.[String(id || '')];
    if (!o) bad('that option is gone: the screen changed, get the options again');
    if (o.cost && !confirm_cost) bad(`this uses ${o.cost.amount} ${o.cost.what}: confirm the cost first`);
    const g = view(root, project);
    const nodes = o.nodes.filter((n) => g.nodes[n] && g.nodes[n].state !== 'cut');
    const okd = nodes.filter((n) => g.nodes[n].owner === 'ok');
    if (okd.length && !confirm) return { asked: true, text: `${okd.map((n) => g.nodes[n].label).join(', ')} ${okd.length === 1 ? 'is' : 'are'} OK'd. Remake ${okd.length === 1 ? 'it' : 'them'} anyway?` };
    const does = describe({ ...o, nodes }, g);
    const edits = [];
    for (const n of nodes) edits.push(nodeAction(root, project, n, { action: 'fix', text: o.text }).edit.id);
    log({ role: 'action', text: nodes.length ? `${o.label}: ${o.text}` : `${o.label} (${o.stage}${o.target ? ' · ' + o.target : ''}): ${o.text}`, ...(nodes.length ? { refs: nodes } : {}) });
    delete db.run[id];
    save(root, project, db);
    wake();
    return { done: true, does, edits };
  }

  return { get, run, running };
}
