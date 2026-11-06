// The studio's narration setup: which engine (ElevenLabs, the owner's own voice, or none) and its settings. The settings
// live in config.json under `voice`; the ElevenLabs key lives in secrets.json and reaches only sessions that use it.
// ElevenLabs is the default and the only generated voice (owner, 2026-11-01: "11 Labs should be the preferred, default
// and only way to generate audio until a good competitor comes along"; local generation is bloat). There is no local
// fallback: without a key the Voice stage and Settings say so in plain words. An old config's local engine ("qwen")
// reads as ElevenLabs.
import { loadConfig, saveConfig, readSecret, writeSecret, readSessionEnv } from '../studio.mjs';
import * as eleven from './elevenlabs.mjs';

// own: the owner narrates in their own voice, line by line, in the recording booth (src/booth.mjs).
export const ENGINES = ['none', 'elevenlabs', 'own'];
export const DEFAULT_ENGINE = 'elevenlabs';

export function voiceConfig(root) {
  const v = loadConfig(root).voice || {};
  return {
    engine: ENGINES.includes(v.engine) ? v.engine : DEFAULT_ENGINE,
    elevenlabs: { ...eleven.DEFAULTS, ...(v.elevenlabs || {}) },
  };
}

// Merge a change into the voice settings (only known fields, ranges enforced).
export function saveVoice(root, patch = {}) {
  const cur = voiceConfig(root);
  const next = { engine: cur.engine, elevenlabs: { ...cur.elevenlabs } };
  if (patch.engine !== undefined) {
    if (!ENGINES.includes(patch.engine)) throw new Error(`voice engine must be one of ${ENGINES.join(', ')}`);
    next.engine = patch.engine;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
  for (const [k, v] of Object.entries(patch.elevenlabs || {})) {
    if (!(k in eleven.DEFAULTS) && k !== 'tier') continue;
    if (['stability', 'similarity_boost', 'style'].includes(k)) next.elevenlabs[k] = clamp(v, 0, 1);
    else if (k === 'speed') next.elevenlabs[k] = clamp(v, 0.7, 1.2);
    else if (k === 'apply_text_normalization') { if (['auto', 'on', 'off'].includes(v)) next.elevenlabs[k] = v; }
    else if (k === 'output_format') { if (eleven.OUTPUT_FORMATS.some((f) => f.id === v)) next.elevenlabs[k] = v; }
    else if (k === 'server') { if (v in eleven.SERVERS) next.elevenlabs[k] = v; }
    else if (k === 'check_model') { if (['scribe_v2', 'off'].includes(v)) next.elevenlabs[k] = v; }
    else if (k === 'pronunciation_dictionaries') next.elevenlabs[k] = (Array.isArray(v) ? v : []).slice(0, 3).map((d) => ({ id: String(d.id), version_id: d.version_id ? String(d.version_id) : null, name: String(d.name || '') }));
    else if (['use_speaker_boost', 'sfx', 'music'].includes(k)) next.elevenlabs[k] = Boolean(v);
    else next.elevenlabs[k] = v === '' ? null : v === null ? null : String(v).slice(0, 200);
  }
  saveConfig(root, { voice: next });
  return next;
}

export const NO_KEY_MESSAGE = 'The voice and music come from ElevenLabs, and no ElevenLabs API key is saved. Add one in Settings › Keys (elevenlabs.io › Developers › API keys). Nothing is spoken until then.';

export function elevenKey(root) {
  return readSecret(root, 'elevenlabs_api_key') || readSessionEnv(root).ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY || null;
}

export function setElevenKey(root, key) {
  writeSecret(root, 'elevenlabs_api_key', key ? String(key).trim() : null);
}

// What a session gets: the settings (never a key) plus the key itself only when the studio narrates with ElevenLabs.
export function sessionVoiceEnv(root) {
  const v = voiceConfig(root);
  const env = { MFX_VOICE: JSON.stringify(v) };
  if (v.engine === 'elevenlabs') {
    const key = elevenKey(root);
    if (key) env.ELEVENLABS_API_KEY = key;
  }
  return env;
}

// Everything the setup screens show. Network calls are optional (`live`): the page asks for them separately.
export function voiceOverview(root) {
  const v = voiceConfig(root);
  const key = Boolean(readSecret(root, 'elevenlabs_api_key')) ? 'saved' : elevenKey(root) ? 'from the environment' : null;
  return {
    ...v,
    elevenlabs_key: key,
    // what Settings and the Voice stage show when ElevenLabs is the engine and there is no key (never a silent fallback)
    needs_key: v.engine === 'elevenlabs' && !key ? NO_KEY_MESSAGE : null,
    output_formats: eleven.OUTPUT_FORMATS,
    servers: Object.keys(eleven.SERVERS),
  };
}

export { eleven };
