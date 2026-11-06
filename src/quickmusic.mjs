// The music driven by the studio, not a session (owner, 2026-10-19: a music session reached 755k tokens in 12 steps
// before composing a note, reading the theory and the engine's source and searching tempos by hand; the owner approved
// "the AI makes the musical decisions, code writes the notes"). One small AI call:
//   1. the studio maps the tempo onto the picture (the board's cuts as hits, bar 1 at offset_sec) and makes one
//      section per scene (src/music/compose.mjs, no AI);
//   2. plan: a fresh call reads the scenes, the words, the hits and the owner's recent pieces and answers with a cue
//      plan: key, chords per section, a motif, each section's name, function, intensity and parts, how each hit plays;
//   3. code writes the notes from it (every note a chord tone of its moment), the engine checks them as it checks a
//      session's (strudel.mjs plan, check: the MIDI is captured, instruments, audition), the render goes through the
//      render queue, the studio mixes it under the voice (sidechain, two-pass loudnorm) onto the animatic and submits.
// A plan the engine refuses goes back to a fresh call with only the errors. The owner's notes on a version, a reference
// track, or anything the studio can't finish goes to a session.
import { runAs } from './models.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, REPO } from './studio.mjs';
import { loadProject, projectPaths, projectPipeline } from './projects.mjs';
import { stepView, stepChecks, submit } from './gates.mjs';
import { scriptView } from './svc/script.mjs';
import { loadTheme } from './svc/theme.mjs';
import { heardLine } from './svc/assets.mjs';
import { listAllPacks } from './svc/packs.mjs';
import { makeSoundtrack } from './soundtrack/index.mjs';
import { bpbOf, tempoMap, placeOf, sectionsFromScenes, planProblems, tensionProblems, blueprintFrom, composeChecked, scoreText, usedParts, ROLES, PARTS, VARIATIONS, PALETTES, HIT_KINDS } from './music/compose.mjs';
import { parseChord } from '../pipelines/_shared/skills/music/lib/harmony.mjs';
import { SONG_SCHEMA, songProblems, songBlueprint, songChecked, songPrompt } from './music/song.mjs';
import { profileMarkdown } from './music/genre.mjs';

const CHECKS = ['loudness', 'sync', 'music-check', 'music-instruments', 'music-source', 'music-under-voice'];
const M = join(REPO, 'pipelines', '_shared', 'skills', 'music', 'strudel.mjs');
const QC = join(REPO, 'pipelines', '_shared', 'skills', 'final-pass', 'qc.mjs');
const FPS = 30;
const MAX_FIXES = 2;

const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const r3 = (x) => Math.round(x * 1000) / 1000;
const readJsonOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function quickMusicStep(root, id, config) {
  if (config.quickMusic === false || config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'music');
  if (!step) return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'music' || runnable[0].state === 'changes') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  const work = projectPaths(root, id).work;
  // a reference track to match takes listening: a session
  if (loadTheme(root, id)?.reference) return null;
  for (const f of ['out/animatic.mp4', 'out/scenes.json', 'voice/timing.json', 'out/voice/narration.wav', 'transitions/board.json']) if (!existsSync(join(work, f))) return null;
  if (stepChecks(root, id, 'music').some((c) => !CHECKS.includes(c.id))) return null;
  return runnable[0];
}

// Run a command without blocking the service (the engine starts a headless Chrome; a check takes a while).
export function exec(cmd, args, { cwd, env, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill('SIGTERM'), timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: `${out}${e.message}` }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
  });
}
export const engine = (c, env, ...args) => exec(process.execPath, [M, ...args], { cwd: c.work, env });
const tail = (s, n = 3000) => String(s || '').slice(-n);

export function context(root, id) {
  const work = projectPaths(root, id).work;
  const project = loadProject(root, id);
  const script = scriptView(root, id);
  const timing = readJsonOr(join(work, 'voice', 'timing.json'), { seconds: 0, lines: [] });
  const board = readJsonOr(join(work, 'transitions', 'board.json'), { cuts: [] });
  const scenesJson = readJsonOr(join(work, 'out', 'scenes.json'), { fps: FPS, scenes: [] });
  const fps = scenesJson.fps || FPS;
  const scenes = scenesJson.scenes.map((s) => ({ key: s.key, beat: s.beat, name: s.name, start_sec: s.from_frame / fps, end_sec: (s.from_frame + s.frames) / fps }));
  const theme = loadTheme(root, id);
  // the songs handed over "for reference" (Like this song), as heard from their audio (src/music/listen.mjs)
  const liked = (project.assets || []).filter((a) => !a.removed && a.use === 'reference' && a.heard?.bpm).map((a) => ({ name: a.name, note: a.note, heard: heardLine(a.heard) }));
  // the harmonic tension the owner set per scene (the theme's cues, 0 smooth … 1 rough); the rest is the AI's
  const tensions = Object.fromEntries((theme?.cues || []).filter((x) => x.beat && typeof x.tension === 'number').map((x) => [x.beat, x.tension]));
  return { work, project, script, timing, board, scenes, theme, liked, tensions, scoring: scoringPack(root, theme), recent: readJsonOr(join(work, 'music', 'recent.json'), { pieces: [] }).pieces || [] };
}

// The scoring pack the music theme names (packs/scoring/<id>/), or null: no pack, the AI decides as before. A pack
// that's named but missing stops the music: scoring without it would quietly ignore the owner's pick.
export function scoringPack(root, theme) {
  if (!theme?.scoring_pack) return null;
  const p = listAllPacks(root, 'scoring').find((x) => x.id === theme.scoring_pack);
  if (!p) throw new Error(`no scoring pack "${theme.scoring_pack}" in ${join(root, 'packs', 'scoring')}`);
  if (typeof p.instruments !== 'string') return p;
  const ip = listAllPacks(root, 'instrument').find((x) => x.id === p.instruments);
  if (!ip) throw new Error(`the scoring pack "${p.name}" plays the instrument pack "${p.instruments}", which isn't in ${join(root, 'packs', 'instrument')}`);
  return { ...p, ...fromInstrumentPack(ip) };
}

// An instrument pack in the form the music code reads: each part [sound, set, gain, character, why, source, extra],
// the drum kit, and the samples to fetch from each library.
export function fromInstrumentPack(ip) {
  const instruments = {}; const kit = {}; const fetch = { vcsl: new Set(), vsco2: new Set() };
  const need = (from, sound) => { if (fetch[from || 'vcsl'] && !['synth', 'surge'].includes(from)) fetch[from || 'vcsl'].add(sound); };
  for (const [k, v] of Object.entries(ip.parts || {})) {
    if (!v || typeof v !== 'object') continue;
    if (k === 'drums') {
      instruments.drums_why = v.why;
      for (const [gm, d] of Object.entries(v.kit || {})) { kit[gm] = { sound: d.sound, set: d.set || '', gain: d.gain ?? 1, from: d.source || 'vcsl' }; if (d.source !== 'synth') need(d.source, d.sound); }
      continue;
    }
    if (!PARTS.includes(k)) continue;
    const from = v.source || 'vcsl';
    instruments[k] = [v.sound, v.set || '', v.gain ?? 0.8, v.character || 'neutral', v.why || '', from, from === 'surge' ? { surge: { patch: v.patch } } : undefined];
    if (from !== 'surge') need(from, v.sound);
  }
  return { instrument_pack: ip.id, concept: ip.concept, instruments, kit: Object.keys(kit).length ? kit : null, samples: [...fetch.vcsl], vsco2: [...fetch.vsco2] };
}

// The board's cuts as hits: the moment each one lands (the word it lands on), else the scene it opens.
export function cutHits(c) {
  return c.board.cuts.map((x, i) => {
    const t = Number(String(x.lands_on || '').match(/\((\d+(?:\.\d+)?)\s*s\)/)?.[1]) || c.scenes[i + 1]?.start_sec;
    const name = typeof x.transition === 'string' ? x.transition : x.transition?.new || 'cut';
    return t ? { cut: i + 1, t_sec: +Number(t).toFixed(3), what: `${name} into ${x.to}` } : null;
  }).filter(Boolean);
}

const ACCENTS = ['bell', 'bass', 'theme', 'drop'];
const MODE_NAMES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonic minor', 'melodic minor'];
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['title', 'dramatic_reading', 'must_not', 'concept', 'scale', 'tempo', 'palette', 'palette_why', 'motif', 'sections', 'key_words', 'hits', 'ending', 'note'],
  properties: {
    title: { type: 'string', description: 'a real title for the cue' },
    dramatic_reading: { type: 'string', description: 'the transformation in one line: "confusion -> recognition -> confidence"' },
    must_not: { type: 'string', description: 'what the music must not do here, and why' },
    concept: { type: 'string', description: 'the small vocabulary and why it fits this story: tonal centre, harmonic character, the motif\'s characteristic interval and rhythm, register, texture' },
    scale: { type: 'string', description: 'tonic:mode, e.g. "E:dorian" (modes: major minor dorian phrygian lydian mixolydian harmonic minor melodic minor)' },
    tempo: { type: 'object', required: ['bpm_min', 'bpm_max', 'why'], properties: { bpm_min: { type: 'number' }, bpm_max: { type: 'number' }, why: { type: 'string' } }, description: 'a range at least 16 BPM wide: the studio picks the tempo inside it that lands the cuts and your key words on the grid' },
    palette: { type: 'string', enum: PALETTES },
    palette_why: { type: 'string' },
    motif: {
      type: 'object', required: ['degrees', 'beats', 'contour', 'why'],
      properties: {
        degrees: { type: 'array', items: { type: 'integer' }, description: 'scale degrees from the tonic (0 = tonic, 7 = an octave up in a 7-note mode, negatives below)' },
        beats: { type: 'array', items: { type: 'number' }, description: 'each note\'s length in beats (quarter notes), multiples of 0.25' },
        contour: { type: 'string', description: 'the shape in words: a question that rises, an answer that falls…' },
        why: { type: 'string', description: 'what in the story the motif stands for' },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object', required: ['name', 'function', 'why', 'intensity', 'chords', 'melody', 'parts'],
        properties: {
          name: { type: 'string', description: 'story-bearing, never Intro/Verse/A/B' },
          function: { type: 'string', description: 'establish, develop, destabilise, withhold, release, reinterpret, resolve: what happens, what rises or is held back' },
          why: { type: 'string', description: 'the words or picture that make this section sound this way: chords, intensity, parts, variation' },
          intensity: { type: 'integer', minimum: 0, maximum: 10 },
          chords: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, description: 'one chord per bar, cycling through the section; ["Am7", "G"] splits a bar in halves' },
          melody: { type: 'string', enum: VARIATIONS },
          parts: { type: 'array', items: { type: 'string', enum: PARTS } },
        },
      },
    },
    key_words: {
      type: 'array', description: '3-8 spoken words the music answers exactly where they are said',
      items: { type: 'object', required: ['t', 'word', 'response', 'why'], properties: { t: { type: 'number', description: 'the word\'s start, copied from the word list' }, word: { type: 'string' }, response: { type: 'string', enum: ACCENTS }, why: { type: 'string' } } },
    },
    hits: { type: 'array', items: { type: 'object', required: ['cut', 'kind', 'why'], properties: { cut: { type: 'integer' }, kind: { type: 'string', enum: HIT_KINDS }, why: { type: 'string' } } } },
    ending: { type: 'string', description: 'how it ends and why (resolved, or left open on purpose)' },
    note: { type: 'string', description: 'for the owner, short: the idea, how the hits and key words are played, what to listen for' },
  },
};

// The plan's schema with a scoring pack's limits in it: the plan call can only answer inside them. A pack with its own
// instruments has no palette to choose.
export function planSchema(pack) {
  if (!pack) return PLAN_SCHEMA;
  const s = JSON.parse(JSON.stringify(PLAN_SCHEMA));
  const P = s.properties;
  const keep = (list, all) => { const l = (list || []).filter((x) => all.includes(x)); return l.length ? l : null; };
  if (pack.instruments) { delete P.palette; delete P.palette_why; s.required = s.required.filter((k) => k !== 'palette' && k !== 'palette_why'); }
  const modes = keep(pack.modes, MODE_NAMES);
  if (modes) P.scale.description = `tonic:mode, e.g. "E:${modes[0]}". Modes allowed by the scoring pack: ${modes.join(', ')}`;
  const parts = keep(pack.parts, PARTS);
  if (parts) P.sections.items.properties.parts.items.enum = parts;
  const hits = keep(pack.hits, HIT_KINDS);
  if (hits) P.hits.items.properties.kind.enum = hits;
  const keys = keep(pack.key_words, ACCENTS);
  if (keys) P.key_words.items.properties.response.enum = keys;
  if (pack.tempo?.bpm_min && pack.tempo?.bpm_max) P.tempo.description = `${P.tempo.description}. The scoring pack allows ${pack.tempo.bpm_min}-${pack.tempo.bpm_max} BPM`;
  if (pack.sevenths) P.sections.items.properties.chords.description += '. The scoring pack asks for sevenths or richer on every chord (maj7, m7, 7, m9, 6, add9…)';
  return s;
}

// What a plan breaks in its scoring pack (each goes back to a fresh fix call, like any other plan problem).
export function packProblems(plan, pack) {
  if (!pack) return [];
  const p = [];
  const mode = String(plan.scale || '').split(':')[1]?.trim().toLowerCase();
  if (pack.modes?.length && mode && !pack.modes.includes(mode)) p.push(`scale: the scoring pack allows only ${pack.modes.join(', ')}`);
  for (const [i, s] of (plan.sections || []).entries()) {
    const bad = (s.parts || []).filter((x) => pack.parts?.length && !pack.parts.includes(x));
    if (bad.length) p.push(`sections[${i}] "${s.name}": the scoring pack has no ${bad.join(', ')} (parts: ${pack.parts.join(', ')})`);
    if (pack.sevenths) {
      const plain = (s.chords || []).flat().filter((c) => { try { return parseChord(c).tones.size < 4; } catch { return false; } });
      if (plain.length) p.push(`sections[${i}] "${s.name}": the scoring pack wants a seventh or richer on every chord, not ${[...new Set(plain)].join(', ')}`);
    }
  }
  for (const [i, h] of (plan.hits || []).entries()) if (pack.hits?.length && !pack.hits.includes(h.kind)) p.push(`hits[${i}]: the scoring pack allows only ${pack.hits.join(', ')}`);
  for (const [i, k] of (plan.key_words || []).entries()) if (pack.key_words?.length && !pack.key_words.includes(k.response)) p.push(`key_words[${i}]: the scoring pack allows only ${pack.key_words.join(', ')}`);
  return p;
}

// The pack's part of the prompt: its sound, how its parts play and its rules, in its own words.
const packText = (pack) => [
  `## The scoring pack: "${pack.name}" (the owner picked it: score inside it)`,
  pack.description, pack.concept && `Sound: ${pack.concept}`,
  pack.how && `How the code plays this pack (this replaces the parts, palette and drums lines below where they differ):\n${pack.how}`,
  pack.words,
].filter(Boolean).join('\n\n');

// The craft the plan is made with (the music skill's own pages), so one call has what a session reads first.
const CRAFT = join(REPO, 'pipelines', '_shared', 'skills', 'music', 'craft');
const craftText = () => {
  const melody = read(join(CRAFT, 'melody-craft.md'));
  return `${read(join(CRAFT, 'picture-scoring.md')).replace(/\n## Output workflow[\s\S]*?(?=\n## Quality rules)/, '\n')}\n\n${melody.slice(0, melody.indexOf('## 5.') > 0 ? melody.indexOf('## 5.') : undefined)}`;
};
const HARMONY = `## Harmony: what makes it sound right (the code writes only chord tones, so the chart you write is the sound you get)
- Build the chart from the scale's own chords; a borrowed chord (iv in major, bVI, bVII) is a colour for one story moment, named in the section's why.
- Chords that share tones move smoothly under speech (Cmaj7 to Am7, Fmaj7 to Dm7: two or three common tones). Root motion by fifths drives forward; by thirds it changes colour without pushing; by step (IV to V, bVI to bVII) it lifts.
- Functional motion (ii-V-I, IV-V-I) creates expectation and arrival; modal motion (i-IV in dorian, I-II in lydian, I-bVII in mixolydian) floats and wonders; a chord held under changing words suspends time.
- Harmonic rhythm is a dial: one chord for two bars under dense narration, one per bar in the middle, two per bar only for a build or the last lift. Changing it is how a section feels faster without getting louder.
- Tension and release: sus4 or add9 open a question, maj7 is sweet and open, m7b5 or a borrowed iv shades; release lands on a stable chord on a downbeat, best where a key word lands.
- Avoid dim and aug chords except as a passing colour, and crowded chords (an 11th or 13th with every tone): where two chord tones sit a semitone apart the code drops one, so a crowded chord thins the texture.
- Cadence where the story answers its question (V-I or IV-I under the answer, the end card); leave it open (end on IV, or on I with its 9th) only when the story should end on a question.
- Do not equate major with happy or minor with sad: register, spacing, rhythm and the harmonic rhythm decide the feeling as much.`;

export function planPrompt(c, sections, cuts, fix) {
  const busyWords = (a, b) => c.timing.lines.filter((l) => l.end > a && l.start < b).map((l) => l.text).join(' ');
  const t = c.theme;
  const using = t?.samples?.find((s) => s.id === t.using);
  const words = c.timing.lines.map((l) => `${l.id} (${l.start.toFixed(2)}-${l.end.toFixed(2)}): ${(l.words || []).map((w) => `${w.text}@${Number(w.start).toFixed(2)}`).join(' ')}`).join('\n');
  return [
    `You plan the original score for "${c.project.title}", an explainer video with narration. You make every musical decision and give the reason for it; the studio's code writes every note from your plan (each one a tone of the chord of its moment, checked by the harmony lock), fits the tempo, renders a stand-in and mixes it under the voice. This is your one chance to score it: use the craft below, plan the whole cue, answer with the JSON asked for and nothing else.`,
    `## The brief\n${JSON.stringify({ ...c.project.intake?.answers, ...Object.fromEntries(Object.entries(c.project.mfx?.answers || {}).map(([k, v]) => [k, v.answer])) })}`,
    c.scoring ? packText(c.scoring) : '',
    t ? `## The music theme ${t.picked_by === 'you' ? 'the owner chose' : 'set for this project'} (follow it${using ? '; the motif is its opening phrase, written as scale degrees' : ''})\n${JSON.stringify({ mood: t.mood, genre: t.genre, tempo: t.tempo, key: t.key, instruments: t.instruments, words: t.words, theme: using ? { name: using.name, desc: using.desc, key: using.key, strudel: using.strudel } : undefined })}` : '',
    c.liked?.length ? `## The song${c.liked.length > 1 ? 's' : ''} the owner likes for this video (heard from the audio; study the feel, tempo, key and chords, never copy them)\n${c.liked.map((l) => `- ${l.name}: ${l.heard}${l.note ? ` (the owner: "${l.note.slice(0, 200)}")` : ''}`).join('\n')}` : '',
    `## The sections (one per scene, fixed: plan exactly these, in order). The video is ${c.videoSec} s.\n${sections.map((s, i) => { const b = c.script.beats.find((x) => x.id === s.beat); const t = c.tensions?.[s.beat]; return `${i + 1}. ${s.start_sec.toFixed(2)}-${s.end_sec.toFixed(2)} s, scene ${s.key}${b ? ` "${b.name}", picture: ${b.visual}` : ''}.${typeof t === 'number' ? ` The owner set its harmonic tension to ${t} (0 smooth: plain triads … 1 rough: 9ths, 13ths, altered chords).` : ''} Spoken: "${busyWords(s.start_sec, s.end_sec)}"`; }).join('\n')}`,
    `## The cuts (picture hits; the studio fits the tempo so they land on the beat)\n${cuts.map((h) => `cut ${h.cut} at ${h.t_sec} s: ${h.what}`).join('\n')}`,
    `## Every spoken word with its start (seconds): pick your key words from here\n${words}`,
    `## The owner's recent pieces (vary key, opening chords and mood from them: the same key and opening progression as one is refused)\n${JSON.stringify(c.recent.map((r) => ({ title: r.title, scale: r.scale, bpm: r.bpm, opening: r.opening })))}`,
    `## How the code plays your plan
- parts: bass (the root on every chord change; long notes when quiet, root-fifth from intensity 4, octave eighths from 7), pad (the chords held, voice-led), melody (your motif, varied per section), arp (broken chords, eighths; sixteenths from 8), bells (on the hits, at a section that rises, on the last chord), drums (a soft kick from intensity 0, hats from 4, a second kick from 6, claps from 7, a tom fill into a section that rises, a crash on a direct hit). Parts enter and leave by section: list only what plays.
- melody variations: statement, fragment (its first half), inversion, augmentation (twice as slow), octave-up, sequence (repeated a step higher each time), rest. A phrase plays, then rests as long (call and answer); under the words it plays every other phrase, softer.
- intensity 0-10 is the energy curve and follows the picture: builds really build, the quiet really thins out; contrast makes it legible. The code measures it, so a section asked 2+ higher than another must have more going on.
- key words: the 3-8 words that carry the meaning (the answer, the turn, the name of the thing, the call to action), not every noun. The code answers each exactly where it is said: bell (a bell tone on the word), bass (the floor re-strikes its root on it), theme (a theme note lands on it), drop (the beat before empties, so the word lands in space). The tempo is fitted so as many as possible fall on the grid.
- the voice talks almost all the time: the music sits ~18 dB under it (ducked), so the busiest writing goes where the words are fewest; the end card can open up.
- palette: the stand-in sound. warm = piano floor, soft synth bed, harp theme, marimba pulse, glockenspiel bells; glass = piano floor, bowed vibraphone bed, vibraphone theme, kalimba pulse, handbells; dark = piano floor, low synth bed, alto recorder theme, marimba pulse, tubular bells. Real, soft percussion in all. The owner makes the final sound from the MIDI.
- hits: for each cut, direct (on it), anticipation (the change just before), aftermath (react a beat after) or none; hit the few that change meaning.`,
    HARMONY,
    `## The craft (the music skill: read it, then plan)\n${craftText()}`,
    fix ? `## Your last plan was refused: fix only these\n${fix.errors.join('\n')}\n\n## That plan\n${JSON.stringify(fix.plan)}` : '',
  ].filter(Boolean).join('\n\n');
}

// The cue plan and the notes, shared by the music step and the soundtrack system (src/soundtrack): one plan call with the
// craft in it (a fix call with only the errors when the plan or the engine refuses it), the tempo fitted to the cuts
// and the plan's key words inside the plan's range, the notes by code, checked with the engine's own harmony lock and
// intensity curve. c: { work, project, script, timing, scenes, theme, recent, videoSec }; cuts: [{ cut, t_sec, what }].
export async function planAndCompose({ c, cuts, call, config = {}, env = {}, onActivity = () => {}, stopped = () => false }) {
  if (c.scoring?.profile) return songPlanAndCompose({ c, cuts, call, config, env, onActivity, stopped });
  // 2. the cue plan: one call with the craft in it; a fix call with only the errors when the plan or the engine
  // refuses it. 3. the tempo fitted to the cuts and the plan's key words, inside the plan's range; the notes by code,
  // checked with the engine's own harmony lock and intensity curve
  const mu = join(c.work, 'music');
  mkdirSync(mu, { recursive: true });
  const tt = c.theme?.tempo || {};
  const allWords = c.timing.lines.flatMap((l) => (l.words || []).map((w) => ({ text: w.text, t: Number(w.start) })));
  onActivity({ kind: 'info', text: `Planning the music: ${c.scenes.length} scenes, ${cuts.length} cuts, ${allWords.length} words.` });
  let plan = null; let fix = null; let bp = null; let composed = null; let map = null; let hits = null; let sections = null; let keys = null;
  for (let round = 0; ; round++) {
    if (round > MAX_FIXES) return { ok: false, error: `the plan still fails: ${fix.errors.join('; ').slice(0, 300)}` };
    // config._reusePlan (tests): the plan already written (music/plan.json) instead of a new call, first round only
    const saved = !round && config._reusePlan ? readJsonOr(join(mu, 'plan.json'), null) : null;
    const r = saved ? { ok: true, structured: saved } : await call(planPrompt(c, c.scenes, cuts, fix), planSchema(c.scoring), fix ? 'fix' : 'plan');
    if (stopped()) return { ok: false, stopped: true };
    plan = r.ok ? r.structured : null;
    if (!plan) return { ok: false, error: r.error || 'the plan call gave no answer' };
    const raw = plan;
    writeFileSync(join(mu, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const pp = [...planProblems(plan, c.scenes), ...packProblems(plan, c.scoring), ...tensionProblems(plan, c.scenes, c.tensions)];
    // every key word must be a spoken word, at its start
    keys = (plan.key_words || []).map((k) => { const w = allWords.reduce((x, y) => (Math.abs(y.t - k.t) < Math.abs(x.t - k.t) ? y : x), allWords[0]); return w && Math.abs(w.t - k.t) <= 0.15 ? { ...k, t: w.t, word: w.text } : null; });
    keys.forEach((k, i) => { if (!k) pp.push(`key_words[${i}] "${plan.key_words[i].word}" at ${plan.key_words[i].t} s isn't a word start in the list`); });
    if (pp.length) { fix = { plan: raw, errors: pp }; continue; }
    // the tempo inside the plan's range (and the theme's), landing the cuts (on an eighth) and the key words (a sixteenth)
    let lo = Math.max(48, Number(plan.tempo?.bpm_min) || 64); let hi = Math.min(180, Number(plan.tempo?.bpm_max) || 140);
    if (tt.bpm_fixed) { lo = tt.bpm_fixed; hi = tt.bpm_fixed; } else { if (tt.bpm_min) lo = Math.max(lo, tt.bpm_min); if (tt.bpm_max) hi = Math.min(hi, tt.bpm_max); }
    if (hi - lo < 16) { const m = (lo + hi) / 2; lo = Math.max(48, m - 8); hi = m + 8; }
    // a scoring pack's tempo limits win (its whole range when the plan asked outside it)
    const pt = c.scoring?.tempo || {};
    if (pt.bpm_min && pt.bpm_max) { const a = Math.max(lo, pt.bpm_min); const b = Math.min(hi, pt.bpm_max); [lo, hi] = a <= b ? [a, b] : [pt.bpm_min, pt.bpm_max]; }
    onActivity({ kind: 'info', text: `Fitting the tempo (${Math.round(lo)}-${Math.round(hi)} BPM) to ${cuts.length} cuts and ${keys.length} key words.` });
    map = tempoMap({ hits: [...cuts.map((h) => ({ t_sec: h.t_sec, weight: 3, div: 2 })), ...keys.map((k) => ({ t_sec: k.t, weight: 1, div: 4 }))], videoSec: c.videoSec, fps: FPS, bpmMin: lo, bpmMax: hi, prefer: (lo + hi) / 2, ...(c.scoring?.meters?.length ? { meters: c.scoring.meters } : {}) });
    hits = cuts.map((h) => { const p = placeOf(map, h.t_sec); return { ...h, bar: p.bar, beat: p.beat, fits: Math.abs(p.at - h.t_sec) <= 1 / FPS + 1e-6 && p.bar <= map.bars }; }).filter((h) => h.bar >= 1 && h.bar <= map.bars);
    keys = keys.map((k) => { const p = placeOf(map, k.t, 4); return { ...k, bar: p.bar, beat: p.beat, q: p.q, off: r3(p.at - k.t) }; }).filter((k) => k.bar >= 1 && k.bar <= map.bars);
    // one section per scene; scenes that land in the same bar at this tempo share a section (their plans merge)
    sections = sectionsFromScenes(map, c.scenes);
    const merged = { ...plan, sections: sections.map((s) => { const ps = s.scenes.map((k) => plan.sections[c.scenes.findIndex((x) => x.key === k)]); return ps.length === 1 ? ps[0] : { ...ps[0], intensity: Math.max(...ps.map((x) => x.intensity)), chords: ps.flatMap((x) => x.chords), why: ps.map((x) => x.why).join(' / '), parts: [...new Set(ps.flatMap((x) => x.parts))] }; }) };
    const used0 = new Set(merged.sections.flatMap((s) => s.parts || []).filter((p) => PARTS.includes(p)));
    bp = blueprintFrom({ plan: merged, map, sections, hits, used: used0 });
    bp.key_words = keys.map((k) => ({ t_sec: k.t, word: k.word, bar: k.bar, beat: k.beat, off_sec: k.off, response: k.response, why: k.why }));
    const busy = (t) => c.timing.lines.some((l) => t >= l.start && t < l.end);
    composed = composeChecked({ plan: merged, bp, voiceBusy: busy, accents: keys.map((k) => ({ beat: k.q, response: k.response })), pack: c.scoring });
    plan = merged;
    const used = usedParts(composed.notes);
    bp.roles = PARTS.filter((k) => used.has(k)).map((k) => ({ channel: ROLES[k].channel, harmony: ROLES[k].harmony, name: ROLES[k].name, job: ROLES[k].job }));
    writeFileSync(join(mu, 'blueprint.json'), `${JSON.stringify(bp, null, 2)}\n`);
    const pl = await engine(c, env, 'plan');
    if (pl.code !== 0) { fix = { plan: raw, errors: pl.out.split('\n').filter((l) => /blueprint\.json|✖/.test(l)) }; continue; }
    if (!composed.harmony.ok) return { ok: false, error: `the written notes break the harmony lock (a studio bug): ${composed.harmony.errors.slice(0, 3).join(' ')}`.slice(0, 400) };
    if (composed.curve.problems.length) { fix = { plan: raw, errors: composed.curve.problems.map((p) => `intensity: ${p} (change the asks or the parts that play)`) }; continue; }
    break;
  }
  // a pack with its own instruments: the sound is the pack's, named where the palette was
  if (c.scoring?.instruments) Object.assign(plan, { palette: c.scoring.id, palette_why: `the scoring pack "${c.scoring.name}"${c.scoring.concept ? `: ${c.scoring.concept}` : ''}` });
  writeFileSync(join(mu, 'score.strudel.js'), scoreText({ notes: composed.notes, bp, plan }));
  return { ok: true, plan, bp, composed, map, hits, sections, keys };
}

// A researched genre's song (src/music/song.mjs): the clock first (the genre's tempo range fitted to the cuts), then one
// plan call writes banks and scenes, code writes the notes; a refused plan goes back to a fresh call with only the errors.
async function songPlanAndCompose({ c, cuts, call, config = {}, env = {}, onActivity = () => {}, stopped = () => false }) {
  const mu = join(c.work, 'music');
  mkdirSync(mu, { recursive: true });
  const pack = c.scoring; const prof = pack.profile;
  const lo = Math.max(48, pack.tempo?.bpm_min || prof.tempo.min); const hi = Math.min(180, pack.tempo?.bpm_max || prof.tempo.max);
  const map = tempoMap({ hits: cuts.map((h) => ({ t_sec: h.t_sec, weight: 3, div: 2 })), videoSec: c.videoSec, fps: FPS, bpmMin: lo, bpmMax: Math.max(hi, lo + 4), prefer: prof.tempo.typical || (lo + hi) / 2, meters: pack.meters?.length ? pack.meters : ['4/4'] });
  const hits = cuts.map((h) => { const p = placeOf(map, h.t_sec); return { ...h, bar: p.bar, beat: p.beat, fits: Math.abs(p.at - h.t_sec) <= 1 / FPS + 1e-6 && p.bar <= map.bars }; }).filter((h) => h.bar >= 1 && h.bar <= map.bars);
  const spoken = []; for (let b = 1; b <= map.bars; b++) { const a = map.offset_sec + (b - 1) * map.sec_per_bar; if (c.timing.lines.some((l) => l.end > a && l.start < a + map.sec_per_bar)) spoken.push(b); }
  const words = spoken.reduce((out, b) => { const last = out.at(-1); if (last && last[1] === b - 1) last[1] = b; else out.push([b, b]); return out; }, []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') || 'none';
  onActivity({ kind: 'info', text: `Writing the ${prof.name} song: ${map.bpm} BPM, ${map.bars} bars, ${cuts.length} cuts.` });
  const busy = (t) => c.timing.lines.some((l) => t >= l.start && t < l.end);
  const melodyCraft = read(join(CRAFT, 'melody-craft.md'));
  const kit = pack.kit ? new Set(Object.keys(pack.kit).map(Number)) : null;
  let plan = null; let fix = null; let bp = null; let composed = null;
  for (let round = 0; ; round++) {
    if (round > MAX_FIXES) return { ok: false, error: `the song plan still fails: ${fix.errors.join('; ').slice(0, 300)}` };
    const saved = !round && config._reusePlan ? readJsonOr(join(mu, 'plan.json'), null) : null;
    const r = saved ? { ok: true, structured: saved } : await call(songPrompt({ c, pack, map, cuts: hits, scenes: c.scenes, words, harmony: HARMONY, melodyCraft, profileText: profileMarkdown(prof, { full: false }), fix, kit }), SONG_SCHEMA, fix ? 'fix' : 'plan');
    if (stopped()) return { ok: false, stopped: true };
    plan = r.ok ? r.structured : null;
    if (!plan) return { ok: false, error: r.error || 'the plan call gave no answer' };
    writeFileSync(join(mu, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const pp = songProblems(plan, { bars: map.bars, profile: prof, meter: map.meter });
    if (pp.length) { fix = { plan, errors: pp }; continue; }
    bp = songBlueprint({ plan, map, cuts: hits });
    composed = songChecked({ plan, bp, cuts: hits, voiceBusy: busy, kit });
    bp.key_words = [];
    writeFileSync(join(mu, 'blueprint.json'), `${JSON.stringify(bp, null, 2)}\n`);
    const pl = await engine(c, env, 'plan');
    if (pl.code !== 0) { fix = { plan, errors: pl.out.split('\n').filter((l) => /blueprint\.json|✖/.test(l)) }; continue; }
    if (!composed.harmony.ok) return { ok: false, error: `the written notes break the harmony lock (a studio bug): ${composed.harmony.errors.slice(0, 3).join(' ')}`.slice(0, 400) };
    break;
  }
  // what the rest of the music step reads from a plan (the spotting map, the note), filled in from the song
  Object.assign(plan, {
    tempo: { bpm_min: lo, bpm_max: hi, why: `the ${prof.name} profile` },
    palette: pack.instrument_pack || pack.id, palette_why: `the ${prof.name} scoring pack${pack.concept ? `: ${pack.concept}` : ''}`,
    key_words: [], hits: [],
    sections: bp.sections.map((s, i) => ({ ...plan.sections[i], intensity: s.intensity, melody: plan.sections[i].play?.melody || 'rest', parts: s.parts })),
  });
  writeFileSync(join(mu, 'song-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(mu, 'score.strudel.js'), scoreText({ notes: composed.notes, bp, plan }));
  const sections = bp.sections.map((s) => ({ scenes: [], start_bar: s.start_bar, end_bar: s.end_bar }));
  return { ok: true, plan, bp, composed, map, hits, sections, keys: [] };
}

export async function quickMusic({ root, id, view, run, runArgs, config, onActivity, fallback, renders, sessionId }) {
  let c;
  try { c = context(root, id); } catch (e) { return { ok: false, error: e.message, usage: { input_tokens: 0, output_tokens: 0 } }; }
  const env = runArgs.env || {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  const call = async (prompt, schema, role = 'plan') => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', '', '--json-schema', JSON.stringify(schema)] } });
    usage.input_tokens += r.usage?.input_tokens || 0;
    usage.output_tokens += r.usage?.output_tokens || 0;
    return r;
  };
  const give = async (why) => {
    onActivity({ kind: 'info', text: `The studio couldn't finish the music by itself (${why}): pausing for you.` });
    const f = await fallback(why);
    return { ...f, usage: { input_tokens: usage.input_tokens + (f.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (f.usage?.output_tokens || 0) } };
  };
  const stopped = () => runArgs.signal?.aborted;
  if (!renders) return give('no render queue');
  if (!env.MFX_STRUDEL || !env.MFX_CHROME) return give('Strudel or its Chrome isn\'t set up');
  // the real instruments (VCSL, CC0): fetched into the studio once, then served to the renderer from disk
  if (!env.MFX_SAMPLES) {
    const dirS = join(root, 'tools', 'samples');
    onActivity({ kind: 'info', text: 'Fetching the instrument samples (once, about 360 MB).' });
    const f = await exec(process.execPath, [join(REPO, 'pipelines', '_shared', 'skills', 'music', 'samples.mjs'), 'fetch', dirS], { timeout: 30 * 60_000 });
    if (!existsSync(join(dirS, 'vcsl.json'))) return give(`the instrument samples couldn't be fetched: ${tail(f.out, 200)}`);
    env.MFX_SAMPLES = dirS;
  }
  // the instruments a scoring pack plays that the studio's copy doesn't have yet (fetched once, added to the map)
  const have = (n) => Object.hasOwn(readJsonOr(join(env.MFX_SAMPLES, n.startsWith('vsco2_') ? 'vsco2.json' : 'vcsl.json'), {}), n);
  const need = [...(c.scoring?.samples || []), ...(c.scoring?.vsco2 || [])].filter((n) => !have(n));
  if (need.length) {
    onActivity({ kind: 'info', text: `Fetching the scoring pack's instruments (once): ${need.join(', ')}.` });
    await exec(process.execPath, [join(REPO, 'pipelines', '_shared', 'skills', 'music', 'samples.mjs'), 'fetch', env.MFX_SAMPLES, ...need], { timeout: 30 * 60_000 });
    const still = need.filter((n) => !have(n));
    if (still.length) return give(`the scoring pack's instruments couldn't be fetched: ${still.join(', ')}`);
  }
  if (/\bno music\b/i.test(String(c.project.intake?.answers?.music || ''))) return give('the brief asks for no music');
  const own = /MIDI/i.test(String(c.project.intake?.answers?.music || '')) || c.theme?.finish === 'own';

  // 1-6. Soundtrack v1 (owner approved 2026-10-19, src/soundtrack): the plan and the notes, real instruments (no sample
  // boosted past 12 dB, a synth where one still fails), the stems, the effects from the SFX pack, the Dubstage mix
  // (the voice untouched and proven so, the score held under it, one plain delivery gain), then onto the animatic
  const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'out/animatic.mp4'], { cwd: c.work });
  c.videoSec = +Number(probe.out).toFixed(3);
  if (!(c.videoSec > 5)) return give('the animatic\'s length couldn\'t be read');
  const mu = join(c.work, 'music');
  let st;
  try {
    st = await makeSoundtrack({ root, id, run, runArgs, config, stages: ['music', 'effects', 'mix'], videoSec: c.videoSec, log: (t) => onActivity({ kind: 'info', text: String(t).split('\n')[0].slice(0, 200) }) });
  } catch (e) {
    if (stopped()) return { ok: false, error: 'stopped', usage };
    return give(e.message);
  }
  usage.input_tokens += st.usage.input_tokens; usage.output_tokens += st.usage.output_tokens;
  const sr = st.report;
  // a genre song keeps its plan as written in plan.json and the plan the rest of the step reads in song-plan.json
  const plan = readJsonOr(join(mu, 'song-plan.json'), null) || readJsonOr(join(mu, 'plan.json'), {});
  const bp = readJsonOr(join(mu, 'blueprint.json'), {});
  const bpb = bpbOf(bp.meter);
  const map = { bpm: bp.bpm, meter: bp.meter, offset_sec: bp.offset_sec, bars: bp.bars, sec_per_bar: +(bpb * 60 / bp.bpm).toFixed(3) };
  const sections = bp.sections.map((x) => ({ start_sec: map.offset_sec + (x.start_bar - 1) * map.sec_per_bar }));
  const used = new Set(sr.music.parts.map((p) => p.channel));
  const mp3 = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'out/music/score.wav', '-c:a', 'libmp3lame', '-b:a', '320k', 'out/music/score.mp3'], { cwd: c.work });
  if (mp3.code !== 0) return give(`making out/music/score.mp3 (the music alone, sent for review): ${tail(mp3.out, 300)}`);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'out/music/score.wav', '-lavfi', 'showspectrumpic=s=1600x400', 'music/spectrum.png'], { cwd: c.work });
  const mux = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'out/animatic.mp4', '-i', 'sound/mix.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-t', String(c.videoSec), 'out/animatic-music.mp4'], { cwd: c.work });
  if (mux.code !== 0) return give(`putting the mix on the animatic: ${tail(mux.out, 300)}`);
  const vt = read(join(c.work, 'video', 'src', 'video.ts'));
  const size = `${vt.match(/width:\s*(\d+)/)?.[1] || 1920}x${vt.match(/height:\s*(\d+)/)?.[1] || 1080}`;
  const qcRun = await exec(process.execPath, [QC, 'out/animatic-music.mp4', '--size', size, '--fps', String(FPS), '--duration', String(+Number(c.videoSec).toFixed(3)), '--lufs', String(sr.mix.lufs), '--true-peak', '-1', '--end-hold', '--json', 'checks/qc-music.json'], { cwd: c.work });
  // qc.mjs exits 0 (all pass) or 1 (a check failed, its json written); anything else means it did not run, never a pass
  if (qcRun.code !== 0 && qcRun.code !== 1) return give(`qc.mjs on the mix did not run: ${tail(qcRun.out, 300)}`);
  const qc = readJsonOr(join(c.work, 'checks', 'qc-music.json'), { checks: [] });
  const q = (k) => (qc.checks || []).find((x) => x.id === k);
  const audioFails = (qc.checks || []).filter((x) => /^audio\./.test(x.id) && x.result === 'fail');
  if (audioFails.length) return give(`qc.mjs on the mix: ${audioFails.map((x) => `${x.id} ${x.detail || ''}`).join('; ').slice(0, 300)}`);

  // 7. the spotting map, written from the plan (no AI), and the submission
  const check = readJsonOr(join(mu, 'check.json'), { hits: [], intensity: [] });
  const cell = (x) => String(x ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const spot = [
    `# Spotting: ${c.project.title}`, '',
    `**Dramatic reading:** ${plan.dramatic_reading}.`, '',
    `**What the music must not do:** ${plan.must_not}`, '',
    `**Concept:** ${plan.concept}`, '',
    `**Motif:** scale degrees ${plan.motif.degrees.join(' ')}, beats ${plan.motif.beats.join(' ')}: ${plan.motif.contour}. Why: ${plan.motif.why}`, '',
    `**Tempo:** ${map.bpm} BPM, ${map.meter}, bar 1 at ${map.offset_sec} s (a bar is ${map.sec_per_bar} s), ${map.bars} bars. The plan asked ${plan.tempo.bpm_min}-${plan.tempo.bpm_max} BPM (${plan.tempo.why}); the studio chose the tempo inside it that lands the most cuts and key words on the grid.`, '',
    `**Sound (stand-in):** ${plan.palette}: ${plan.palette_why}`, '',
    '| bars | time (s) | section | intensity | chords | melody | parts | function | why |', '|---|---|---|---|---|---|---|---|---|',
    ...bp.sections.map((s, i) => `| ${s.start_bar}-${s.end_bar} | ${sections[i].start_sec.toFixed(2)} | ${cell(s.name)} | ${s.intensity} | ${cell((bp.chart[i]?.chords || []).map((x) => (Array.isArray(x) ? x.join(' ') : x)).join(' · '))} | ${s.variation} | ${(s.parts || []).join(', ')} | ${cell(s.function)} | ${cell(s.why)} |`), '',
    '## Key words (the music answers each where it is said)', '',
    '| time (s) | word | music | off by | response | why |', '|---|---|---|---|---|---|',
    ...(bp.key_words || []).map((k) => `| ${k.t_sec} | ${cell(k.word)} | bar ${k.bar} beat ${k.beat} | ${k.off_sec >= 0 ? '+' : ''}${k.off_sec} s | ${k.response} | ${cell(k.why)} |`), '',
    '## Cuts', '',
    '| time (s) | cut | music | kind | why |', '|---|---|---|---|---|',
    ...bp.hits.map((h) => `| ${h.t_sec} | ${cell(h.what.split(':')[0])} | bar ${h.bar} beat ${h.beat} | ${h.kind} | ${cell(h.what.split(':').slice(1).join(':').trim())} |`), '',
    `**Ending:** ${plan.ending}`, '',
  ].join('\n');
  writeFileSync(join(mu, 'SPOTTING.md'), spot);
  await engine(c, env, 'sheet');
  const lufs = q('audio.loudness')?.detail; const tp = q('audio.true-peak')?.detail;
  const hitRows = (check.hits || []).filter((h) => h.kind !== 'none');
  const error_checks = [
    { id: 'loudness', result: 'pass', note: `qc.mjs on out/animatic-music.mp4: ${lufs || `${sr.mix.lufs} LUFS`}, true peak ${tp || `${sr.mix.true_peak_dbtp} dBTP`}. Dubstage set one plain gain (${sr.mix.delivery_gain_db} dB) for the whole soundtrack, no limiter: the level is where the untouched voice's own peaks allow (owner's choice, 2026-10-19). The score alone peaks at ${sr.music.score_peak_db} dBFS. Measured only: nothing here is by ear.` },
    { id: 'sync', result: 'pass', note: `${hitRows.length ? `${hitRows.length} hit${hitRows.length === 1 ? '' : 's'} within a frame: ${hitRows.map((h) => `bar ${h.bar} beat ${h.beat ?? 1} (${h.off_sec >= 0 ? '+' : ''}${h.off_sec} s)`).join(', ')}.` : 'No hits at this tempo.'}${bp.hits.some((h) => h.kind === 'none') ? ` ${bp.hits.filter((h) => h.kind === 'none').length} cut(s) play as no hit.` : ''} ${bp.key_words?.length ? ` ${bp.key_words.length} key words answered where they are said: ${bp.key_words.filter((k) => Math.abs(k.off_sec) <= 1 / FPS).length} within a frame, the rest on the nearest sixteenth (largest ${Math.max(...bp.key_words.map((k) => Math.abs(k.off_sec))).toFixed(3)} s off).` : ''} The music starts at bar 1 = ${map.offset_sec} s (adelay ${Math.round(map.offset_sec * 1000)} ms). The picture is the approved animatic's (video copied); the voice is the approved narration, untouched.` },
    { id: 'music-check', result: 'pass', note: `strudel.mjs check --video-sec ${c.videoSec} --fps ${FPS}: 0 problems (harmony locked, the curve follows the sections, hits on the picture). MIDI captured: music/notes.json, out/music/midi/. The notes were written by code from the cue plan, every pitched note a chord tone.` },
    { id: 'music-instruments', result: 'pass', note: `strudel.mjs instruments and audition pass on ${sr.music.parts.length} channels: a ${sr.music.palette} palette of real instruments (VCSL, CC0), each levelled from its audition, none boosted past 12 dB (${sr.music.parts.map((p) => `${p.role} ${p.sound} ${p.boost_db >= 0 ? '+' : ''}${p.boost_db}`).join(', ')})${sr.music.synth_fallbacks.length ? `; a synth plays ${sr.music.synth_fallbacks.join(', ')} (its sample needed more)` : ''}.` },
    { id: 'music-source', result: 'n/a', note: own ? 'This is the music step itself: the Strudel stand-in for review. The owner\'s own master (strudel.mjs own-master) comes in at the build.' : 'This is the music step itself: the approved Strudel render is used from here on.' },
    { id: 'music-under-voice', result: 'pass', note: `Dubstage: the score sits ${sr.mix.music_under_voice_db} dB under the voice while it speaks (target 20; 10 in the gaps), dipping just before each word, with a gentle 2.5 kHz cut under speech. The voice itself is untouched: mix minus everything else = the voice x ${sr.mix.voice_gain_db} dB, leftover ${sr.mix.voice_residual_db} dB. ${(sr.effects || []).length} effects from the SFX pack (${(sr.effects || []).map((e) => `${e.sound} at ${e.moment} s`).join(', ')}). Measured, not listened to.` },
  ].filter((x) => stepChecks(root, id, 'music').some((k) => k.id === x.id));
  const curve = (check.intensity || []).map((s) => `${s.name} ${s.asked}→${s.measured}`).join(' · ');
  const note = `${plan.note}\n\n"${plan.title}": ${map.bpm} BPM, ${map.meter}, ${plan.scale}, ${map.bars} bars, ${used.size} parts, ${(sr.effects || []).length} effects. The story: ${plan.dramatic_reading}. Intensity asked → measured: ${curve}.\n\nThe studio wrote the notes from one AI cue plan and mixed everything with Dubstage (soundtrack v1, no session); the mix is also in sound/mix.wav (lossless) and sound/mix.mp3. These are measurements, not listening: judge it by ear.${own ? ' It\'s a stand-in: the MIDI pack is ready on the project page (Music › Download MIDI) for you to finish the sound in your DAW.' : ''}`;
  try {
    submit(root, id, 'music', {
      note, questions: [], error_checks,
      items: [
        { path: 'out/animatic-music.mp4', label: 'Animatic with the music' },
        { path: 'out/music/score.mp3', label: own ? 'The music alone (stand-in)' : 'The music alone' },
        { path: 'music/MUSIC-SHEET.md', label: 'Music sheet' },
        { path: 'music/SPOTTING.md', label: 'Spotting map' },
        { path: 'music/spectrum.png', label: 'Spectrum of the score' },
        { path: 'sound/REPORT.md', label: 'Soundtrack report (with the voice proof)' },
      ].filter((it) => existsSync(join(c.work, it.path))),
    });
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  const cl = join(c.work, 'checklist.md');
  if (existsSync(cl)) {
    const t = readFileSync(cl, 'utf8').split('\n');
    const at = t.findIndex((l) => /^##\s+Music\b/i.test(l));
    if (at >= 0) { for (let i = at + 1; i < t.length && !/^##\s/.test(t[i]); i++) t[i] = t[i].replace(/^- \[ \]/, '- [x]'); writeFileSync(cl, t.join('\n')); }
  }
  appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Music v${view.version + 1} planned by one AI call, written and mixed by the studio (no session): "${plan.title}", ${map.bpm} BPM, ${plan.scale}, ${map.bars} bars.\n`);
  onActivity({ kind: 'info', text: `Music ready for your check: "${plan.title}".` });
  return { ok: true, usage, summary: plan.note };
}
