// The studio's narration setup: which engine (ElevenLabs, local Qwen3-TTS, the owner's own voice, or none) and its settings. The settings
// live in config.json under `voice`; the ElevenLabs key lives in secrets.json and reaches only sessions that use it.
import { loadConfig, saveConfig, readSecret, writeSecret, readSessionEnv } from '../studio.mjs';
import * as eleven from './elevenlabs.mjs';
import * as qwen from './qwen.mjs';

// own: the owner narrates in their own voice, line by line, in the recording booth (src/booth.mjs).
export const ENGINES = ['none', 'elevenlabs', 'qwen', 'own'];

export function voiceConfig(root) {
  const v = loadConfig(root).voice || {};
  return {
    engine: ENGINES.includes(v.engine) ? v.engine : 'none',
    elevenlabs: { ...eleven.DEFAULTS, ...(v.elevenlabs || {}) },
    qwen: { ...qwen.DEFAULTS, ...(v.qwen || {}) },
  };
}

// Merge a change into the voice settings (only known fields, ranges enforced).
export function saveVoice(root, patch = {}) {
  const cur = voiceConfig(root);
  const next = { engine: cur.engine, elevenlabs: { ...cur.elevenlabs }, qwen: { ...cur.qwen } };
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
  for (const [k, v] of Object.entries(patch.qwen || {})) {
    if (!(k in qwen.DEFAULTS)) continue;
    if (k === 'check') next.qwen[k] = Boolean(v);
    else if (k === 'url') { if (/^https?:\/\/[^\s]+$/.test(String(v))) next.qwen[k] = String(v).replace(/\/+$/, ''); }
    else next.qwen[k] = String(v).slice(0, 1000);
  }
  saveConfig(root, { voice: next });
  return next;
}

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
  const gpus = qwen.detectGpus();
  return {
    ...v,
    elevenlabs_key: Boolean(readSecret(root, 'elevenlabs_api_key')) ? 'saved' : elevenKey(root) ? 'from the environment' : null,
    gpus,
    local: qwen.recommend(gpus),
    presets: qwen.PRESETS,
    output_formats: eleven.OUTPUT_FORMATS,
    servers: Object.keys(eleven.SERVERS),
  };
}

export { eleven, qwen };
