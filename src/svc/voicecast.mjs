// The Voice stage as an ElevenLabs cast (v3): a narrator and a voice per character, each with its own settings and clip
// gain (voice/cast.json), audio tags and a pause per line (voice/lines.json), and a verbatim check of what was heard
// against the script (voice/timing.json). vo.mjs reads cast.json and lines.json; this file edits them.
//
//   cast.get  {project?}                      -> { cast, set, fallback }  (fallback: the studio's one voice, shown until a cast is saved)
//   cast.set  {cast:[{role,voice_id,name,model,settings,gain_db}]}
//   voice.line.set {line, tags?, role?, gap_after?, stability?, dry?}  -> { line, changed, retake, credits, edit }
//   voice.check {}                            -> { lines:[{id, role, text, tags, gap_after, stability, checked, ok, missing, extra, word_count, words:[{text,start,end,extra}]}], bad, checked }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths } from '../projects.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { isV4 } from '../voice/elevenlabs.mjs';
import { creditRate } from './voicecost.mjs';
import { rememberQuote, takeQuote } from './paidgate.mjs';
import { writeJson } from '../studio.mjs';

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const voiceDir = (root, id) => join(projectPaths(root, id).work, 'voice');
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export const ROLE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

export function cleanCast(list) {
  if (!Array.isArray(list)) throw new Error('cast must be a list');
  const seen = new Set();
  const out = list.slice(0, 24).map((c) => {
    const role = slug(c?.role || c?.name);
    if (!ROLE.test(role)) throw new Error(`bad role "${c?.role}"`);
    if (seen.has(role)) throw new Error(`role ${role} appears twice`);
    seen.add(role);
    const s = c.settings || {};
    return {
      role,
      voice_id: c.voice_id ? String(c.voice_id).slice(0, 60) : null,
      name: String(c.name || role).slice(0, 60),
      model: String(c.model || 'eleven_v4').slice(0, 40),
      settings: {
        stability: num(s.stability, 0.5, 0, 1),
        similarity_boost: num(s.similarity_boost, 0.75, 0, 1),
        style: num(s.style, 0, 0, 1),
        speed: num(s.speed, 1, 0.7, 1.2),
        use_speaker_boost: s.use_speaker_boost !== false,
      },
      gain_db: num(c.gain_db, 0, -24, 12),
    };
  });
  return out;
}

export function castGet(root, id) {
  const f = join(voiceDir(root, id), 'cast.json');
  const saved = existsSync(f) ? readOr(f, null) : null;
  const v = (() => { try { return voiceConfig(root); } catch { return {}; } })();
  const e = v.elevenlabs || {};
  const fallback = { role: 'narrator', voice_id: e.voice_id || null, name: e.voice_name || e.voice_id || null, model: e.model_id || 'eleven_v4', settings: { stability: e.stability ?? 0.5, similarity_boost: e.similarity_boost ?? 0.75, style: e.style ?? 0, speed: e.speed ?? 1, use_speaker_boost: e.use_speaker_boost !== false }, gain_db: 0, engine: v.engine || 'none' };
  const cast = saved?.cast || [];
  return { cast: cast.map((c) => ({ ...c, v4: isV4(c.model) })), set: Boolean(saved), fallback };
}

// The voice that narrates this project: the cast's narrator once one is saved, else the studio's voice (owner,
// 2026-11-02: a project made with "Pick in the script step" was read by the studio voice with no pick shown).
export function narratorVoice(root, id) {
  const { cast, fallback } = castGet(root, id);
  const c = cast.find((x) => x.role === 'narrator') || null;
  const n = c && c.voice_id ? c : fallback;
  return { voice_id: n.voice_id || null, name: n.name || null, model: n.model || 'eleven_v4', settings: n.settings || {}, from: c && c.voice_id ? 'cast' : 'studio' };
}

export function castSet(root, id, list) {
  const cast = cleanCast(list);
  const dir = voiceDir(root, id);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'cast.json'), { cast });
  return { cast: cast.map((c) => ({ ...c, v4: isV4(c.model) })), set: true };
}

// "[tired, wry] The words." -> { tags: ['tired','wry'], words: 'The words.' }
export function splitTags(text) {
  const tags = [];
  let rest = String(text || '');
  for (;;) {
    const m = rest.match(/^\s*\[([^\]]*)\]\s*/);
    if (!m) break;
    for (const t of m[1].split(',')) if (t.trim()) tags.push(t.trim());
    rest = rest.slice(m[0].length);
  }
  return { tags, words: rest };
}
const withTags = (tags, words) => (tags.length ? `[${tags.join(', ')}] ${words}` : words);
const parseTags = (t) => (Array.isArray(t) ? t : String(t || '').split(/[\],\[]/)).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 8);

// ElevenLabs bills v4 text by character: the tags count too.
export const creditsFor = (text) => String(text || '').length;

// Edits one line in voice/lines.json. Words stay the script's: only the `[tags]` prefix of `text` changes. `retake` says
// whether the spoken result must be made again (tags, role or stability changed); the gap alone needs only a rebuild.
export function lineSet(root, id, p) {
  const f = join(voiceDir(root, id), 'lines.json');
  const list = readOr(f, null);
  if (!Array.isArray(list)) throw new Error('this project has no voice lines yet');
  const k = list.findIndex((l) => l.id === p.line);
  if (k < 0) throw new Error(`no line ${p.line}`);
  const l = { ...list[k] };
  const { tags: oldTags, words } = splitTags(l.text);
  const before = { tags: oldTags.join(','), role: l.role || 'narrator', stability: l.stability ?? null };
  const changed = { tags: false, role: false, gap: false, stability: false };
  if (p.tags !== undefined) {
    const t = parseTags(p.tags);
    changed.tags = t.join(',') !== before.tags;
    l.text = withTags(t, words.trim());
    if (!l.script) l.script = words.trim(); // the plain script stays plain for the check
  }
  if (p.role !== undefined) {
    const role = slug(p.role) || 'narrator';
    changed.role = role !== before.role;
    if (role === 'narrator') delete l.role; else l.role = role;
  }
  if (p.gap_after !== undefined) {
    const g = num(p.gap_after, null, 0, 5);
    if (g === null) throw new Error('gap_after must be seconds');
    changed.gap = g !== l.gap_after;
    l.gap_after = Math.round(g * 100) / 100;
  }
  if (p.stability !== undefined) {
    if (p.stability === null) { changed.stability = l.stability !== undefined; delete l.stability; } else { const s = num(p.stability, null, 0, 1); changed.stability = s !== l.stability; l.stability = s; }
  }
  const retake = changed.tags || changed.role || changed.stability;
  const credits = retake ? creditsFor(l.text) : 0;
  if (!p.dry) { list[k] = l; writeJson(f, list); }
  return { line: l, changed, retake, credits, dry: Boolean(p.dry) };
}

// ---- verbatim check -----------------------------------------------------------------------------------------------
const norm = (w) => String(w).toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}']+/gu, '');
const toks = (s) => String(s || '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).map(norm).filter(Boolean);

// Longest common subsequence; what the script has that was not heard (missing) and what was heard that is not in it (extra).
export function diffWords(want, got) {
  const n = want.length; const m = got.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = want[i] === got[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const missing = []; const extra = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (want[i] === got[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) missing.push(want[i++]); else extra.push(got[j++]);
  }
  while (i < n) missing.push(want[i++]);
  while (j < m) extra.push(got[j++]);
  return { missing, extra };
}

export function voiceCheck(root, id) {
  const dir = voiceDir(root, id);
  const lines = readOr(join(dir, 'lines.json'), []);
  const timing = readOr(join(dir, 'timing.json'), { lines: [] });
  const byId = new Map((timing.lines || []).map((t) => [t.id, t]));
  const out = lines.map((l) => {
    const script = String(l.script || splitTags(l.text).words);
    const t = byId.get(l.id);
    const base = { id: l.id, role: l.role || 'narrator', text: String(l.text || ''), tags: splitTags(l.text).tags, gap_after: l.gap_after ?? null, stability: l.stability ?? null };
    if (!t || !(t.words || []).length) return { ...base, checked: false, ok: null, timed: Boolean(t), missing: [], extra: [], word_count: toks(script).length, words: [] };
    const d = diffWords(toks(script), (t.words || []).map((w) => norm(w.text)).filter(Boolean));
    // words[]: what was heard, for the word chips; `extra` marks a heard word that is not in the script
    const extra = new Set(d.extra);
    const words = (t.words || []).filter((w) => norm(w.text)).map((w) => ({ text: String(w.text), start: Number(w.start) || 0, end: Number(w.end) || 0, extra: extra.has(norm(w.text)) }));
    return { ...base, checked: true, ok: !d.missing.length && !d.extra.length, timed: true, missing: d.missing, extra: d.extra, word_count: toks(script).length, words };
  });
  return { lines: out, checked: out.filter((x) => x.checked).length, bad: out.filter((x) => x.ok === false).map((x) => x.id), total: out.length };
}

// ---- service handlers (registered in service.mjs with one line) ---------------------------------------------------
export function voicecastHandlers({ needProject, root, retake }) {
  return {
    'cast.get': (p) => castGet(root, needProject(p)),
    'cast.set': (p) => castSet(root, needProject(p), p?.cast),
    'voice.check': (p) => voiceCheck(root, needProject(p)),
    'voice.line.set': (p) => {
      const id = needProject(p);
      const line = String(p?.line || '');
      // a retake is paid (C2): without confirm only the estimate comes back and nothing is changed. The estimate is a
      // one-time price (svc/paidgate.mjs quotes): a confirm pays only for the take it priced (same line, same tags, role
      // and stability, no more credits), so a re-sent or changed confirm records nothing.
      const probe = lineSet(root, id, { ...p, line, dry: true });
      const what = probe.retake ? { line: probe.line.id, text: probe.line.text, role: probe.line.role || 'narrator', stability: probe.line.stability ?? null } : null;
      const credits = probe.retake ? Math.ceil(probe.credits * creditRate(root, voiceConfig(root).elevenlabs?.model_id)) : 0;
      if (probe.retake && p?.confirm !== true) {
        rememberQuote(id, 'voice.line', what, credits);
        // `credits` is the price in credits (it was the character count, about 2.3 times too high at 0.44 a character)
        const est = { ...probe, characters: probe.credits, credits, credits_estimate: credits };
        return p?.dry ? est : { ...est, needs_confirm: true, lines: [probe.line.id], edit: null };
      }
      if (p?.dry) return probe;
      if (probe.retake) takeQuote(id, 'voice.line', what, credits);
      const r = lineSet(root, id, { ...p, line });
      let edit = null;
      if (r.retake && !r.dry) edit = retake(id, r.line, r);
      return { ...r, edit };
    },
  };
}
