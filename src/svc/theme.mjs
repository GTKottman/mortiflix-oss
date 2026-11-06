// The music theme (doc 33): music/theme.json in the project's working folder, which the music skill reads before its
// blueprint. The owner picks it (New project › Music › Choose…, or a preset carries one) or leaves it to the AI, who
// shows three 15 s themes in the chat and uses the first. One cue per beat is planned before any notes exist.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { projectPaths, loadProject, event, update, projectPipeline } from '../projects.mjs';
import { settle } from '../gates.mjs';
import { paths, loadConfig, UserError } from '../studio.mjs';

const str = (v, n = 200) => (v === undefined || v === null ? null : String(v).slice(0, n));
const list = (v, n = 12) => (Array.isArray(v) ? v.slice(0, n).map((x) => String(x).slice(0, 80)).filter(Boolean) : []);
// A missing value stays missing: Number(null), Number('') and Number(false) are 0, which would clamp to `lo`.
const clampInt = (v, lo, hi) => (v === null || v === undefined || typeof v === 'boolean' || (typeof v === 'string' && !v.trim()) || !Number.isFinite(Number(v))
  ? null : Math.min(hi, Math.max(lo, Math.round(Number(v)))));

// Only the fields doc 33 names, each bounded: the theme is shown to sessions.
export function cleanTheme(t = {}, { forPreset = false } = {}) {
  if (!t || typeof t !== 'object') throw new UserError('a music theme is an object');
  const tempo = t.tempo && typeof t.tempo === 'object' ? t.tempo : {};
  const out = {
    picked_by: t.picked_by === 'you' ? 'you' : 'ai',
    mood: list(t.mood),
    genre: str(t.genre, 120),
    tempo: { feel: str(tempo.feel, 60), bpm_min: clampInt(tempo.bpm_min, 30, 300), bpm_max: clampInt(tempo.bpm_max, 30, 300), ...(tempo.bpm_fixed ? { bpm_fixed: clampInt(tempo.bpm_fixed, 30, 300) } : {}) },
    instruments: { use: list(t.instruments?.use), avoid: list(t.instruments?.avoid) },
    key: str(t.key, 40),
    finish: t.finish === 'own' ? 'own' : 'studio',
    words: str(t.words, 2000),
    // the scoring pack the music step follows (packs/scoring/<id>/), or none: the AI decides as before
    ...(t.scoring_pack ? { scoring_pack: str(t.scoring_pack, 120) } : {}),
  };
  if (t.reference && typeof t.reference === 'object') out.reference = { asset: str(t.reference.asset, 40), seconds: Number(t.reference.seconds) || null, bpm: Number(t.reference.bpm) || null, key: str(t.reference.key, 40), lufs: Number(t.reference.lufs) || null };
  if (forPreset) return out;
  out.samples = (Array.isArray(t.samples) ? t.samples.slice(0, 6) : []).map((s, i) => ({ id: str(s.id, 20) || `t${i + 1}`, name: str(s.name, 80), desc: str(s.desc, 300), strudel: str(s.strudel, 20_000), wav: str(s.wav, 300), bpm: Number(s.bpm) || null, key: str(s.key, 40) }));
  out.using = str(t.using, 20);
  out.cues = (Array.isArray(t.cues) ? t.cues.slice(0, 200) : []).map(cleanCue).filter(Boolean);
  return out;
}

// A cue's harmonic tension, 0 smooth … 1 rough, in tenths; missing = the AI decides.
const tensionOf = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Math.min(1, Math.max(0, Number(v))) * 10) / 10);

function cleanCue(c) {
  if (!c || !/^m\d{2,3}$/.test(String(c.id || ''))) return null;
  return { id: c.id, beat: /^b\d{2,3}$/.test(String(c.beat || '')) ? c.beat : null, feel: str(c.feel, 300) || '', energy: clampInt(c.energy, 1, 5) ?? 3, tension: tensionOf(c.tension),
    instruments: Array.isArray(c.instruments) ? list(c.instruments) : 'theme', ...(c.hit ? { hit: { kind: c.hit.kind === 'word' ? 'word' : 'cut', at_sec: Number(c.hit.at_sec) || 0 } } : {}), state: 'planned' };
}

export const themeFile = (root, id) => join(projectPaths(root, id).work, 'music', 'theme.json');

export function loadTheme(root, id) {
  const f = themeFile(root, id);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveTheme(root, id, theme, { by = 'you' } = {}) {
  const t = cleanTheme(theme);
  // three themes asked for and not made yet: the request stays (run 2: Done on the theme page right after
  // "Make 3 samples" dropped it, and they never came)
  const wanted = loadTheme(root, id)?.samples_wanted;
  if (wanted && !t.samples.length) t.samples_wanted = wanted;
  const f = themeFile(root, id);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(t, null, 2));
  event(root, id, { event: 'MUSIC_THEME', actor: by === 'ai' ? 'studio' : 'you', details: [t.genre, ...t.mood].filter(Boolean).join(', ').slice(0, 200) || 'theme set' });
  return t;
}

// The cue plan: one cue per beat (doc 33 §3), from the theme, else one planned cue per beat of the script.
export function cuePlan(root, id, graph) {
  const theme = loadTheme(root, id);
  const planned = new Map((theme?.cues || []).map((c) => [c.id, c]));
  const beats = graph?.order?.beats || [];
  const out = [];
  beats.forEach((b, i) => {
    const cid = `m${String(i + 1).padStart(2, '0')}`;
    out.push(planned.get(cid) || { id: cid, beat: b, feel: '', energy: 3, tension: null, instruments: 'theme', state: 'planned' });
    planned.delete(cid);
  });
  return [...out, ...planned.values()];
}

export function setCuePlan(root, id, cue, { feel, energy, tension } = {}) {
  const t = loadTheme(root, id) || cleanTheme({ picked_by: 'ai' });
  let c = t.cues.find((x) => x.id === cue);
  if (!c) {
    c = cleanCue({ id: cue, beat: `b${String(cue).slice(1)}` });
    if (!c) throw new UserError(`bad cue ${cue}`);
    t.cues.push(c);
  }
  if (feel !== undefined) c.feel = String(feel).slice(0, 300);
  if (energy !== undefined) c.energy = clampInt(energy, 1, 5) ?? c.energy;
  if (tension !== undefined) c.tension = tensionOf(tension);
  return saveTheme(root, id, t).cues.find((x) => x.id === cue);
}

// Three short themes to hear. The demo backend makes quiet placeholder tones at once (ffmpeg, no AI, no cost); with a
// real backend the request is written into the theme and the next session makes them (plain Strudel, doc 33), and
// they arrive as a "themes" card in the chat.
export async function themeSamples(root, id, theme = {}) {
  const config = loadConfig(root);
  const backend = id ? (loadProject(root, id).backend || config.backend) : config.backend;
  const base = cleanTheme(id ? { ...(loadTheme(root, id) || {}), ...theme } : theme);
  if (backend !== 'demo') {
    if (!id) return { samples: [], made: false, note: 'The three themes are made once the project exists.' };
    base.samples_wanted = new Date().toISOString();
    const f = themeFile(root, id);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, JSON.stringify(base, null, 2));
    event(root, id, { event: 'THEME_SAMPLES_WANTED', actor: 'you', details: 'three 15 s themes' });
    // a session makes them now, even while the project waits for the owner (gates.settle); the runner drops the flag
    // once that session ends
    update(root, id, (p) => { p.mfx = { ...(p.mfx || {}), samples_wanted: base.samples_wanted }; settle(p, projectPipeline(root, id)); return p; });
    return { samples: [], made: false, note: 'The AI makes three themes next; they arrive in the chat.' };
  }
  const dir = id ? join(projectPaths(root, id).work, 'music', 'theme-samples') : join(paths(root).run, 'theme-samples', randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  const names = [['Steady pulse', 220, 96], ['Bright lift', 330, 120], ['Slow air', 262, 72]];
  const samples = [];
  for (const [i, [name, hz, bpm]] of names.entries()) {
    const wav = join(dir, `t${i + 1}.wav`);
    // Quiet (-24 dBFS-ish) and short: a placeholder, never loud.
    await ffmpeg(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=15`, '-af', 'volume=0.06', '-ar', '48000', wav]);
    samples.push({ id: `t${i + 1}`, name, desc: `Demo theme ${i + 1}: a placeholder tone, not music.`, strudel: `note("c3 e3 g3 b3").s("sine").slow(${(120 / bpm).toFixed(2)})`, wav, bpm, key: 'C:major' });
  }
  if (id) { base.samples = samples; base.using ||= 't1'; saveTheme(root, id, base, { by: 'ai' }); }
  return { samples, made: true, using: base.using || 't1' };
}

function ffmpeg(args) {
  return new Promise((ok, fail) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fail(new UserError(`ffmpeg is needed for the demo themes: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? ok() : fail(new UserError(`ffmpeg failed: ${err.trim().slice(-300)}`))));
  });
}

export const hasTheme = (root, id) => existsSync(themeFile(root, id));
