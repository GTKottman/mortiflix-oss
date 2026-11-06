// Short names for the beats ("Why is it blue?", "Sunlight is every colour"): shown on the nodes, the ribbon, the
// Script panel, the preview's beats lane and Mortiflix Studio's bins and chapter markers. Where a name comes from, first
// that has one:
//   1. the script itself: `name` (or `title`) on the beat in script/beats.json (sessions write it, harness/GATES.md),
//      or the owner's own rename (script.edit {beat_name});
//   2. the AI: one short call to the user's own AI for every beat without a name, kept in
//      state/<id>/canvas/beat-names.json with the words it named (a beat whose words change is named again);
//   3. a sensible title from the words themselves (shortTitle), never the first words cut off mid-sentence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canvasPaths, readBeats } from '../canvas.mjs';
import { projectPaths, loadProject } from '../projects.mjs';
import { loadConfig } from '../studio.mjs';

const MAX_NAME = 40;
const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const file = (root, id) => join(canvasPaths(root, id).dir, 'beat-names.json');
const sig = (words) => createHash('sha1').update(String(words || '')).digest('hex').slice(0, 12);

const LEAD = /^(?:but|so|and|now|then|well|okay|ok|remember|plus|also|yes|no|oh|look|here's|here is)\b[,:!]?\s+/i;
const SUBORDINATE = /^(?:when|if|as|once|after|before|while|because|since|until|whenever)\s+/i;
const PREPOSITION = /^(?:on|in|at|for|with|from|by|during|across|over|under|inside|outside)\s+/i;
const DANGLING = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'but', 'on', 'in', 'at', 'for', 'with', 'from', 'by', 'its', 'it', 'is', 'are', 'so', 'as', 'that', 'this', 'your', 'our', 'their', 'into', 'than', 'very']);

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// A title from the words alone: the first clause that says something, at most five words, never ending on "a" or
// "the". "Look up! On a sunny day, the sky is bright blue. But why?" → "The sky is bright blue".
export function shortTitle(words) {
  let text = clean(words).replace(/^[A-Z][a-z]+:\s+/, (m) => (/^(remember|note|recap|fact|tip|bonus):/i.test(m) ? '' : m));
  const sentences = text.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
  // A short call-out first ("Look up!", "Boing!") says little unless it is all there is.
  const meaty = sentences.find((x) => x.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(' ').length >= 3) || sentences[0] || '';
  let s = meaty.replace(/[.!?…]+$/, '');
  for (let i = 0; i < 3 && LEAD.test(s); i++) s = s.replace(LEAD, '');
  const comma = s.search(/[,;:—–]/);
  if (SUBORDINATE.test(s) && comma > 0) s = s.slice(0, comma).replace(SUBORDINATE, '');
  else if (PREPOSITION.test(s) && comma > 0 && s.slice(comma + 1).trim().split(' ').length >= 2) s = s.slice(comma + 1);
  else if (comma > 0 && s.slice(0, comma).trim().split(' ').length >= 2) s = s.slice(0, comma);
  let w = clean(s).replace(/["“”'‘’()]/g, '').split(' ').filter(Boolean).slice(0, 5);
  while (w.length > 1 && DANGLING.has(w.at(-1).toLowerCase().replace(/[^a-z']/g, ''))) w.pop();
  const out = capital(w.join(' ').replace(/[,;:.!?…—–-]+$/, ''));
  return out.length >= 2 ? out.slice(0, MAX_NAME) : capital(clean(words).split(' ').slice(0, 3).join(' ')).slice(0, MAX_NAME);
}

const fromScript = (b) => clean(b?.name || (typeof b?.title === 'string' ? b.title : '')).slice(0, 80);

// The names the AI gave, for the words they were given for.
export const loadAiNames = (root, id) => readOr(file(root, id), { names: {} });

// beat id → {name, from: script|ai|words}. `beats` = readBeats() rows (with `name` when the script has one).
export function beatNames(root, id, beats) {
  const ai = loadAiNames(root, id).names || {};
  const out = {};
  for (const b of beats) {
    const own = fromScript(b);
    const a = ai[b.id];
    out[b.id] = own ? { name: own, from: 'script' }
      : a?.name && a.sig === sig(b.words) ? { name: clean(a.name).slice(0, MAX_NAME), from: a.by === 'ai' ? 'ai' : 'words', asked: true }
        : { name: shortTitle(b.words), from: 'words' };
  }
  return out;
}

// The beats the AI has not been asked to name for their current words (and that have no name in the script).
export function unnamed(root, id) {
  let beats = [];
  try { beats = readBeats(projectPaths(root, id).work, []); } catch { return []; }
  const n = beatNames(root, id, beats);
  return beats.filter((b) => n[b.id].from === 'words' && !n[b.id].asked && clean(b.words));
}

const SYSTEM = 'You name the beats of a short video script. For each beat give a short title of 2 to 4 words that says what the beat is about (like a chapter title), in the script\'s language, without quotes or a full stop. Answer ONLY with JSON: {"names": {"<beat id>": "<title>", ...}}.';

function parseNames(text, ids) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return {};
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return {}; }
  const names = j?.names && typeof j.names === 'object' ? j.names : j;
  const out = {};
  for (const id of ids) {
    const v = clean(typeof names?.[id] === 'string' ? names[id] : '').replace(/^["“']|["”'.]$/g, '');
    if (v && v.length <= 60) out[id] = v.slice(0, MAX_NAME);
  }
  return out;
}

// Ask the user's own AI to name the beats that have no name (once per words; the demo backend uses shortTitle).
// `ask(prompt)` → the AI's text; the service passes its quick-reply path (claude -p, no tools / the API fallback).
export async function nameBeats(root, id, { ask } = {}) {
  const todo = unnamed(root, id);
  if (!todo.length) return { named: [] };
  const config = loadConfig(root);
  const backend = config.chatBackend || loadProject(root, id).backend || config.backend;
  let names = {};
  if (backend !== 'demo' && ask) {
    const prompt = `${SYSTEM}\n\n${todo.map((b) => `${b.id}: ${clean(b.words).slice(0, 600)}`).join('\n')}`;
    names = parseNames(await ask(prompt), todo.map((b) => b.id));
  }
  const store = loadAiNames(root, id);
  store.names = store.names || {};
  const named = [];
  for (const b of todo) {
    // The demo (and a reply that missed a beat) keeps the title from the words, so it is not asked again for them.
    store.names[b.id] = { name: names[b.id] || shortTitle(b.words), sig: sig(b.words), by: names[b.id] ? 'ai' : 'words', at: new Date().toISOString() };
    named.push(b.id);
  }
  mkdirSync(canvasPaths(root, id).dir, { recursive: true });
  writeFileSync(file(root, id), JSON.stringify(store, null, 2));
  return { named };
}
