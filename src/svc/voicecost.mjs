// Cost first for the voice (opt C2): ElevenLabs bills narration by character, so every paid voice action shows
// {needs_confirm, characters, credits_estimate, lines} first and records nothing until the call carries confirm: true.
// Only lines whose take key changed count (soundtrack/voice.mjs planLines); the scribe check is priced by audio seconds.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, listProjects } from '../projects.mjs';
import { ttsCredits } from './ledger.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { planLines } from '../soundtrack/voice.mjs';
import { scriptView } from './script.mjs';
import { linesFromScript } from '../quickvoice.mjs';
import { narratorVoice } from './voicecast.mjs';

const CHARS_PER_SECOND = 15; // speech rate, to turn characters into the audio seconds the scribe check reads
const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// Credits per character, as ElevenLabs bills them: measured from the `character-cost` the recordings reported
// (sound/voice/usage.jsonl `credits`, every project, this model), else the list price (ledger ttsCredits). eleven_v4
// bills about 0.44 a character: 1 a character priced Dir3's re-read at 433 for 236 billed (2026-11-02).
let rates = { at: 0, root: null, by: new Map() };
export function creditRate(root, model) {
  if (rates.root !== root || Date.now() - rates.at > 60_000) {
    const by = new Map();
    let ids = [];
    try { ids = listProjects(root).map((p) => p.id); } catch { /* no projects */ }
    for (const id of ids) {
      let text = '';
      try { text = readFileSync(join(projectPaths(root, id).work, 'sound', 'voice', 'usage.jsonl'), 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) {
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (r.engine !== 'elevenlabs' || !(Number(r.credits) > 0) || !(Number(r.characters) > 0)) continue;
        const m = by.get(r.model) || { credits: 0, characters: 0 };
        m.credits += Number(r.credits); m.characters += Number(r.characters);
        by.set(r.model, m);
      }
    }
    rates = { at: Date.now(), root, by };
  }
  const m = rates.by.get(model);
  return m && m.characters >= 200 ? m.credits / m.characters : ttsCredits(model, 1);
}
export const resetCreditRates = () => { rates = { at: 0, root: null, by: new Map() }; };

// `rate`: credits per character (creditRate); 1 when not given.
export const estimateOf = (characters, lines, extra = {}, rate = 1) => {
  const credits = Math.ceil(characters * rate);
  return {
    needs_confirm: true, lines, characters, credits_estimate: credits, credits_per_character: rate, check_seconds: Math.round(characters / CHARS_PER_SECOND),
    message: `${lines.length} line${lines.length === 1 ? '' : 's'}, ${characters} characters: about ${credits} ElevenLabs credits.`, ...extra,
  };
};

// The whole voice: only the lines whose take key changed (free when none).
export function voiceMakeEstimate(root, id) {
  const work = projectPaths(root, id).work;
  const lines = readOr(join(work, 'voice', 'lines.json'), []);
  const v = voiceConfig(root);
  if (v.engine !== 'elevenlabs') return { needs_confirm: false, lines: [], characters: 0, credits_estimate: 0, check_seconds: 0, message: 'This voice runs on this machine: no credits.' };
  const e = v.elevenlabs;
  const p = planLines({ work, lines, voiceId: e.voice_id, model: e.model_id, stability: e.stability, similarity: e.similarity_boost, style: e.style ?? null, speed: e.speed ?? null, speakerBoost: e.use_speaker_boost !== false });
  if (!p.need.length) return { needs_confirm: false, lines: [], characters: 0, credits_estimate: 0, check_seconds: 0, restored: p.restore.map((r) => r.line.id), message: 'Every line already has its take: nothing to pay.' };
  return estimateOf(p.characters, p.need.map((x) => x.line.id), {}, creditRate(root, e.model_id));
}

// One line again (New take / Remake line / a changed tag): its characters, whatever the cache says (a new take is asked for).
export function lineTakeEstimate(root, id, lineId, text = null) {
  const work = projectPaths(root, id).work;
  const l = readOr(join(work, 'voice', 'lines.json'), []).find((x) => x.id === lineId);
  const chars = String(text ?? l?.text ?? '').length;
  if (voiceConfig(root).engine !== 'elevenlabs') return { needs_confirm: false, lines: [lineId], characters: 0, credits_estimate: 0, check_seconds: 0, message: 'This voice runs on this machine: no credits.' };
  return estimateOf(chars, [lineId], {}, creditRate(root, voiceConfig(root).elevenlabs?.model_id));
}

// The voice step before it starts (the runner's cost OK, src/svc/paidgate.mjs): the lines the approved script gives,
// read by this project's narrator; lines whose take is already recorded (or archived) are free. `voice` says who reads.
export function voiceStepEstimate(root, id) {
  const work = projectPaths(root, id).work;
  const n = narratorVoice(root, id);
  const voice = { id: n.voice_id, name: n.name, model: n.model, from: n.from };
  if (voiceConfig(root).engine !== 'elevenlabs') return { needs_confirm: false, lines: [], characters: 0, credits_estimate: 0, voice, message: 'This voice runs on this machine: no credits.' };
  let lines = [];
  try { lines = linesFromScript(scriptView(root, id)); } catch { lines = readOr(join(work, 'voice', 'lines.json'), []); }
  // the voice step records only lines with no take yet (soundtrack/voice.mjs makeVoice): the same lines count here
  const has = (l) => existsSync(join(work, 'sound', 'voice', 'lines', `${l.id}.pcm`)) && existsSync(join(work, 'sound', 'voice', 'lines', `${l.id}.json`));
  const p = planLines({ work, lines: lines.filter((l) => !has(l)), ...narratorTake(root, n) });
  if (!p.need.length) return { needs_confirm: false, lines: [], characters: 0, credits_estimate: 0, voice, message: 'Every line already has its take: nothing to pay.' };
  return estimateOf(p.characters, p.need.map((x) => x.line.id), { voice }, creditRate(root, narratorTake(root, n).model));
}

// The take settings the voice step records with (quickvoice.mjs), so the estimate prices the same takes.
export function narratorTake(root, n) {
  const e = voiceConfig(root).elevenlabs; const s = n.settings || {};
  return { voiceId: n.voice_id || e.voice_id || null, model: n.model || e.model_id, stability: s.stability ?? e.stability, similarity: s.similarity_boost ?? e.similarity_boost, speakerBoost: (s.use_speaker_boost ?? e.use_speaker_boost) !== false };
}
