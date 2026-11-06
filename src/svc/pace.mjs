// How fast the studio's voice really speaks, from the takes it made (owner, 2026-11-02: a 146-word script written for
// 60 s at 150 words a minute ran 71 s with Tracy K). Every voiced project's voice/timing.json says how long the whole
// narration ran (pauses between lines included) and its words; the line takes say which voice read them. The pace is
// the median of the latest takes by the same voice, else by any voice, else 120 words a minute.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../studio.mjs';

export const DEFAULT_WPM = 120; // owner 2026-11-02: every real voice ran 118-128 a minute, never 150
const LATEST = 8;
const MIN_WORDS = 60; // a narration shorter than this says little about the pace
const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

let cache = null; // { at, root, takes }

// Every measured narration: {project, voice_id, words, seconds, at}.
export function measuredTakes(root) {
  if (cache && cache.root === root && Date.now() - cache.at < 60_000) return cache.takes;
  const dir = paths(root).projects;
  const takes = [];
  for (const id of existsSync(dir) ? readdirSync(dir) : []) {
    const f = join(dir, id, 'voice', 'timing.json');
    if (!existsSync(f)) continue;
    const t = readOr(f, null);
    if (!t?.seconds || !Array.isArray(t.lines) || !t.lines.length) continue;
    const words = t.lines.reduce((n, l) => n + (Array.isArray(l.words) && l.words.length ? l.words.length : String(l.text || '').split(/\s+/).filter(Boolean).length), 0);
    if (words < MIN_WORDS) continue;
    const meta = readOr(join(dir, id, 'sound', 'voice', 'lines', `${t.lines[0].id}.json`), {});
    takes.push({ project: id, voice_id: meta.voice_id || null, voice: meta.voice || null, words, seconds: t.seconds, at: statSync(f).mtimeMs });
  }
  takes.sort((a, b) => b.at - a.at);
  cache = { at: Date.now(), root, takes };
  return takes;
}

// {wpm, from: 'voice'|'studio'|'default', takes} for the voice (its ElevenLabs id) the project will be read by.
export function speechPace(root, { voiceId = null } = {}) {
  let takes = [];
  try { takes = measuredTakes(root); } catch { takes = []; }
  const same = voiceId ? takes.filter((t) => t.voice_id === voiceId).slice(0, LATEST) : [];
  const use = same.length ? same : takes.slice(0, LATEST);
  if (!use.length) return { wpm: DEFAULT_WPM, from: 'default', takes: 0 };
  return { wpm: Math.round(median(use.map((t) => (t.words / t.seconds) * 60))), from: same.length ? 'voice' : 'studio', takes: use.length };
}

export function _clearPaceCache() { cache = null; }
