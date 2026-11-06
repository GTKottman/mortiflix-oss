// "Improve my brief" (plan 52): one cheap Claude call (role `options` = Haiku) that suggests missing details and flags
// ambiguity. It never rewrites the idea and never changes the brief: each suggestion is accepted or dismissed by the owner.
import { createHash } from 'node:crypto';
import { askAnon } from './chat.mjs';
import { loadConfig } from '../studio.mjs';
import { FIELD, FIELDS, normalizeBrief, valueOf } from './briefschema.mjs';
import { STUDIO_MODELS } from '../models.mjs';

const fieldLine = (f) => `${f.id} (${f.type}${f.choices?.length ? `: ${f.choices.map((c) => c.value).join('|')}` : ''}${f.type === 'object' ? `: {${f.parts.map((p) => `${p.key}${p.choices?.length ? `=${p.choices.map((c) => c.value).join('|')}` : ''}`).join(', ')}}` : ''})`;

function prompt(brief, sources) {
  return `You help a video maker complete a production brief. Suggest improvements; the maker accepts or dismisses each one. Answer with JSON only: {"suggestions":[{"kind":"set"|"clarify","path":"section.setting","value":<valid value>,"label":"short button text","why":"one plain sentence"}]}.
Rules: at most 6 suggestions. NEVER suggest changing or rewriting the idea. "set" suggestions only for settings the maker has not set, using a value allowed below and fitting the idea. "clarify" suggestions (no path or value) are questions about missing or ambiguous details or contradictions. Visuals are always drawn in code; never suggest AI image generation. Nothing here starts research or paid work.

## Settings (path, type, allowed values)
${FIELDS.filter((f) => !f.decide_later).map(fieldLine).join('\n')}

## The brief so far
${JSON.stringify({ ...brief, sources: undefined })}

## Sources in the tray
${sources.map((s) => `${s.id} ${s.kind} ${s.status}: ${s.label}`).join('\n') || '(none)'}`;
}

function parse(text) {
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) return [];
  try { const j = JSON.parse(m[0]); return Array.isArray(j.suggestions) ? j.suggestions : []; } catch { return []; }
}

export async function improveBrief(root, input, sources = [], { ask = askAnon } = {}) {
  const { brief } = normalizeBrief(input);
  const config = loadConfig(root);
  const model = config.chatModel || config.model || (config.models ?? STUDIO_MODELS).options || 'default';
  const base = { ai: true, model, cost: 'One short Claude call, included in your Claude Code plan. No credits, no ElevenLabs.' };
  if (!String(brief.idea || '').trim()) return { ...base, suggestions: [], source: 'none', note: 'Write your idea first; there is nothing to improve yet.' };
  let raw;
  try { raw = await ask(root, prompt(brief, sources), { role: 'options' }); } catch (e) { return { ...base, suggestions: [], source: 'error', note: `The AI call did not work: ${String(e.message).slice(0, 200)}` }; }
  if (!String(raw).trim()) return { ...base, suggestions: [], source: 'demo', note: 'The demo backend makes no suggestions.' };
  const out = []; const seen = new Set();
  for (const s of parse(raw)) {
    if (out.length >= 6) break;
    const label = String(s?.label || '').trim().slice(0, 80); const why = String(s?.why || '').trim().slice(0, 300);
    if (!label) continue;
    if (s.kind === 'clarify') { out.push({ id: `i${out.length + 1}`, kind: 'clarify', label, why }); continue; }
    const f = FIELD[s?.path];
    if (!f || f.decide_later || valueOf(brief, f.id).origin !== 'default' || seen.has(f.id)) continue; // never over a setting the maker made
    const [sec, key] = f.id.split('.');
    const { brief: ok, errors } = normalizeBrief({ [sec]: { [key]: s.value } });
    if (errors.length) continue;
    seen.add(f.id);
    out.push({ id: `i${out.length + 1}`, kind: 'set', path: f.id, value: ok[sec][key], label, why });
  }
  return { ...base, suggestions: out, source: 'ai', token: createHash('sha1').update(JSON.stringify(brief)).digest('hex').slice(0, 12) };
}
