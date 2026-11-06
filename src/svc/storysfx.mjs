// Sound on the story's actions, not on every moving element (2026-11-02, d4fd Sound v4: 36 moments, all whoosh or pop,
// placed on element counts; nothing marked the FILED stamp, the ticks, the chats dropping into the folder). The story
// actions come from the Motion session's own marks (video/src/sfx/<beats>.json, written with each scene) or, for scenes
// without them, from one Claude call that reads the approved motion code and the script. The motion data's probes only
// time them: each action snaps to the nearest probed move within SNAP frames.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SNAP = 6;
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const read = (f, n = 80_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');

export const STORY_SCHEMA = {
  type: 'object', required: ['actions'],
  properties: { actions: { type: 'array', items: { type: 'object', required: ['shot', 'frame', 'what', 'sound', 'importance'], properties: {
    shot: { type: 'string', description: 'the scene key, s01…' },
    frame: { type: 'integer', description: 'absolute frame on the whole video (30 fps) where the action lands (the impact, not the start of the move)' },
    what: { type: 'string', description: 'the story action in plain words: "FILED stamp slams onto the page"' },
    sound: { type: 'string', description: 'a short sound description: "heavy rubber-stamp thud". The SAME words for the same kind of action everywhere, so one sound is made and reused' },
    dur_sec: { type: 'number', description: 'the sound\'s length, 0.3 to 2 s' },
    importance: { type: 'integer', minimum: 1, maximum: 3, description: '3 = the scene\'s key story action, 1 = a small detail' },
  } } } },
};

// The marks the Motion session left with each scene (video/src/sfx/*.json: [{frame, what, sound, dur_sec?, importance?}]).
export function markedActions(work, scenes) {
  const dir = join(work, 'video', 'src', 'sfx');
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { actions: [], beats: [] }; }
  const actions = [], beats = new Set();
  for (const f of files) {
    const list = readJson(join(dir, f), []);
    if (!Array.isArray(list)) continue;
    f.replace(/\.json$/, '').split('+').forEach((b) => beats.add(b));
    for (const a of list) {
      const fr = Number(a.frame);
      const sc = scenes.find((x) => fr >= x.from_frame && fr < x.from_frame + x.frames);
      if (!sc || !a.sound) continue;
      actions.push({ shot: sc.key, frame: fr, what: String(a.what || a.sound), sound: String(a.sound), dur_sec: a.dur_sec, importance: a.importance || 2 });
    }
  }
  return { actions, beats: [...beats] };
}

// The approved motion's code, for every layout v3 makes (2026-11-02, bdb9: scenes/anim_b02.tsx… beside animatic.tsx,
// not one scenes/animatic.tsx, so the story call saw none of it): src/timing.ts, src/Main.tsx, scenes/animatic.tsx and
// each approved scene's own file (scenes/anim_<beat>.tsx, <beat>.tsx, <key>.tsx, anim_<key>.tsx). Stills (sf*, st_*),
// frames and backups are not motion.
export function motionCodeFiles(work, scenes = readJson(join(work, 'out', 'scenes.json'), {})?.scenes || []) {
  const src = join(work, 'video', 'src');
  const out = ['timing.ts', 'Main.tsx', 'scenes/animatic.tsx'];
  for (const sc of scenes) {
    for (const n of [sc.beat && `anim_${sc.beat}`, sc.beat, sc.key, sc.key && `anim_${sc.key}`].filter(Boolean)) {
      const f = `scenes/${n}.tsx`;
      if (existsSync(join(src, f)) && !out.includes(f)) out.push(f);
    }
  }
  return out.filter((f) => existsSync(join(src, f)));
}

export function storyPrompt(work, scenes, { fps = 30, cap, note = '' } = {}) {
  const timing = readJson(join(work, 'voice', 'timing.json'), { lines: [] });
  const src = join(work, 'video', 'src');
  const files = motionCodeFiles(work, scenes);
  const each = Math.max(12_000, Math.floor(300_000 / Math.max(1, files.length)));
  const code = files.map((f) => `### ${join(src, f)}\n${read(join(src, f), each)}`).join('\n');
  const rows = scenes.map((s) => ({ shot: s.key, beat: s.beat, name: s.name, frames: [s.from_frame, s.from_frame + s.frames - 1], words: (timing.lines || []).filter((l) => s.beat && l.id.startsWith(`${s.beat}-`)).map((l) => l.text).join(' ') }));
  return [
    'You are the sound designer of a short explainer video. From the approved motion code and the script, name the STORY ACTIONS a sound should mark: a stamp slams, a tag snaps on, a checkbox is ticked, a chat bubble flips into a price tag, a folder swallows papers. Not every element that moves: text fading in, layout settling, small drifts and exits get no sound.',
    `## The scenes (absolute frames at ${fps} fps) and their spoken words\n${JSON.stringify(rows)}`,
    `## The approved motion code\n${code}`,
    note ? `## The owner's note on the last sound plan (follow it)\n${note}` : '',
    `## Rules\n- Read where each action lands from the code (its interpolate/spring frames, Sequence offsets, the timing.ts word starts) and give the absolute frame of the impact.\n- At most ${cap} actions in all, at least about 0.5 s apart, every scene at least one; importance 3 for each scene's key action.\n- sound: a short concrete description a library or a sound generator understands ("heavy rubber-stamp thud", "pen tick on paper", "paper drop into a folder", "price tag flip"). Use the SAME words for the same kind of action, so one sound is reused.\n- Only actions that are in the code: never invent one.`,
    'Answer with the JSON asked for, nothing else.',
  ].filter(Boolean).join('\n\n');
}

export const codeHash = (work, note = '') => createHash('sha1').update([...motionCodeFiles(work).map((f) => read(join(work, 'video', 'src', f), 400_000)), note].join('\n')).digest('hex').slice(0, 12);

// [{shot, frame, …}] -> [{shot, at_sec, dur_sec, what, sound, importance, snapped}]: each frame moved to the nearest move
// the probes saw within SNAP frames (the code's frame is the plan; the probe is where the picture really moves).
export function timeActions(actions, rawActs, fps = 30) {
  const frames = rawActs.map((a) => Math.round(a.at_sec * fps));
  return actions.map((a) => {
    let best = null;
    for (const f of frames) { const d = Math.abs(f - a.frame); if (d <= SNAP && (best === null || d < Math.abs(best - a.frame))) best = f; }
    const fr = best ?? a.frame;
    return { shot: a.shot, at_sec: Math.round((fr / fps) * 1000) / 1000, dur_sec: Math.max(0.3, Math.min(2, Number(a.dur_sec) || 0.6)), what: String(a.what).slice(0, 120), sound: String(a.sound).slice(0, 200), importance: a.importance || 2, snapped: best !== null };
  });
}

// the cap and spacing (as a designer would: the key actions first, each scene's at least once)
export function capActions(acts, { seconds, per = 1.75, minSpace = 0.5 } = {}) {
  const cap = Math.max(1, Math.round((seconds || Math.max(0, ...acts.map((a) => a.at_sec))) / per));
  const firstOf = new Map();
  for (const a of [...acts].sort((p, q) => (q.importance - p.importance) || (p.at_sec - q.at_sec))) if (!firstOf.has(a.shot)) firstOf.set(a.shot, a);
  const order = [...acts].sort((p, q) => ((firstOf.get(q.shot) === q) - (firstOf.get(p.shot) === p)) || (q.importance - p.importance) || (p.at_sec - q.at_sec));
  const picked = [];
  for (const a of order) { if (picked.length >= cap) break; if (picked.some((x) => Math.abs(x.at_sec - a.at_sec) < minSpace)) continue; picked.push(a); }
  // one length per sound, so a repeated sound is one made sound
  const len = new Map();
  for (const a of picked.sort((p, q) => p.at_sec - q.at_sec)) { if (!len.has(a.sound)) len.set(a.sound, a.dur_sec); a.dur_sec = len.get(a.sound); }
  return picked;
}

// The story actions for the plan: the Motion's marks where every scene has them, else one call (cached by the code's
// hash in sound/story.json). `ask(prompt, schema)` -> {ok, structured}. Returns {actions, source} or {error}.
export async function storyActionsFor(work, { ask, rawActs = [], fps = 30, seconds, note = '' } = {}) {
  const sj = readJson(join(work, 'out', 'scenes.json'), {});
  const scenes = sj.scenes || [];
  if (!scenes.length) return { error: 'no approved scenes (out/scenes.json)' };
  const cap = Math.max(1, Math.round((seconds || scenes.reduce((m, s) => Math.max(m, (s.from_frame + s.frames) / fps), 0)) / 1.75));
  const marked = markedActions(work, scenes);
  if (!note && marked.actions.length && scenes.every((s) => marked.beats.includes(s.beat))) return { actions: capActions(timeActions(marked.actions, rawActs, fps), { seconds }), source: 'motion marks' };
  const cacheFile = join(work, 'sound', 'story.json');
  const h = codeHash(work, note);
  const cached = readJson(cacheFile, null);
  let list = cached?.hash === h ? cached.actions : null;
  if (!list) {
    if (!ask) return { error: 'no AI call available' };
    const r = await ask(storyPrompt(work, scenes, { fps, cap, note }), STORY_SCHEMA);
    if (!r?.ok || !Array.isArray(r.structured?.actions)) return { error: r?.error || 'the story call gave no actions' };
    list = r.structured.actions.filter((a) => scenes.some((s) => s.key === a.shot) && Number.isFinite(Number(a.frame)));
    mkdirSync(join(work, 'sound'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ hash: h, made: new Date().toISOString(), actions: list }, null, 2));
  }
  return { actions: capActions(timeActions(list, rawActs, fps), { seconds }), source: cached?.hash === h ? 'story call (cached)' : 'story call' };
}
