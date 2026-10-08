// The studio's keys in one place: what each one is for, when a project needs it, where it's kept, and a free check
// that it works. Values live in secrets.json (mode 600, in the studio folder) and are never printed, served or logged.
// Extra keys for sessions (anything a pipeline's tools read from the environment) live in session.env, also mode 600.
import { readSecret, writeSecret, loadConfig, readSessionEnv, writeSessionEnv, UserError } from './studio.mjs';
import { loadProject, projectPipeline } from './projects.mjs';
import { stepView } from './gates.mjs';
import { credentials as anthropicCredentials } from './backends/anthropic-api.mjs';
import { voiceConfig } from './voice/index.mjs';
import { ElevenLabs } from './voice/elevenlabs.mjs';

export const KEYS = {
  anthropic: {
    name: 'Anthropic API key',
    secret: 'anthropic_api_key',
    env: 'ANTHROPIC_API_KEY',
    get: 'console.anthropic.com › Settings › API keys',
    for: 'the Claude API backend (you pay per token). Not needed with Claude Code, which uses your own login.',
  },
  elevenlabs: {
    name: 'ElevenLabs API key',
    secret: 'elevenlabs_api_key',
    env: 'ELEVENLABS_API_KEY',
    get: 'elevenlabs.io › Developers › API keys',
    for: 'narration, sound effects and music with ElevenLabs. Not needed for local narration (Qwen3-TTS) or none.',
  },
  uploadpost: {
    name: 'Upload-Post API key',
    secret: 'upload_post_api_key',
    env: 'UPLOAD_POST_API_KEY',
    get: 'app.upload-post.com › API Keys',
    for: 'publishing a delivered video to TikTok, Instagram, YouTube and others with `mortiflix publish`, when Upload-Post is your publishing service. Optional: nothing is ever posted on its own.',
  },
  postiz: {
    name: 'Postiz API key',
    secret: 'postiz_api_key',
    env: 'POSTIZ_API_KEY',
    get: 'your Postiz › Settings › Developers › Public API',
    for: 'publishing a delivered video with `mortiflix publish`, when your own Postiz is your publishing service. Optional: nothing is ever posted on its own.',
  },
};

// Where a key comes from: saved in this studio, session.env, the environment Mortiflix was started with, or nowhere.
export function keySource(root, id) {
  const k = KEYS[id];
  if (!k) throw new UserError(`unknown key "${id}" (${Object.keys(KEYS).join(', ')})`);
  if (readSecret(root, k.secret)) return 'saved';
  if (id === 'elevenlabs' && readSessionEnv(root)[k.env]) return 'session.env';
  if (process.env[k.env]) return 'environment';
  if (id === 'anthropic' && anthropicCredentials(root).other) return 'environment';
  return null;
}

// The key itself, for the studio's own calls (publishing). Sessions never get this one.
export function keyValue(root, id) {
  const k = KEYS[id];
  return readSecret(root, k.secret) || process.env[k.env] || null;
}

// Which keys a project uses, given how the studio is set up. `steps` narrows it to the work that's about to run.
//   anthropic:  the project runs on the Claude API backend
//   elevenlabs: the studio narrates with ElevenLabs and the work makes sound (voice, effects, music)
export function keysFor(root, { backend, pipeline, steps } = {}) {
  const using = backend || loadConfig(root).backend;
  if (using === 'demo') return [];
  const need = [];
  if (using === 'anthropic-api') need.push('anthropic');
  const work = (steps || pipeline?.steps || []).flatMap((s) => s.work || []);
  if (voiceConfig(root).engine === 'elevenlabs' && work.includes('audio')) need.push('elevenlabs');
  return need;
}

export function missingKeys(root, opts) {
  return keysFor(root, opts).filter((id) => !keySource(root, id));
}

// What a project still lacks: for the whole project before it starts, or (`upcoming`) for the steps that can run now.
export function projectMissingKeys(root, projectId, { upcoming = false } = {}) {
  const p = loadProject(root, projectId);
  const pipeline = projectPipeline(root, projectId);
  const steps = upcoming ? stepView(p, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state)) : pipeline.steps;
  return missingKeys(root, { backend: p.backend, steps });
}

export function missingKeysText(ids, then = 'resume') {
  const names = ids.map((id) => KEYS[id].name);
  const fix = ids.includes('elevenlabs') ? ' (or pick another narration engine in Settings › Narration)' : '';
  return `This project needs your ${names.join(' and ')}. Add ${ids.length > 1 ? 'them' : 'it'} with \`mortiflix keys\` or in Settings › Keys${fix}, then ${then}.`;
}

export function keyStatus(root) {
  const config = loadConfig(root);
  const inUse = keysFor(root, { backend: config.backend, steps: [{ work: ['audio'] }] });
  return Object.entries(KEYS).map(([id, k]) => ({ id, name: k.name, get: k.get, for: k.for, env: k.env, source: keySource(root, id), in_use: inUse.includes(id) }));
}

export function saveKey(root, id, value) {
  const k = KEYS[id];
  if (!k) throw new UserError(`unknown key "${id}" (${Object.keys(KEYS).join(', ')})`);
  const v = value ? String(value).trim() : '';
  if (/\s/.test(v)) throw new UserError(`that doesn't look like an ${k.name} (it has spaces in it)`);
  writeSecret(root, k.secret, v || null);
}

// A free, read-only call that proves the key works. ok: true (works), false (refused), null (couldn't reach the API).
export async function verifyKey(root, id, value, { fetch = globalThis.fetch } = {}) {
  const key = String(value || '').trim();
  try {
    if (id === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (res.ok) return { ok: true, detail: 'the Claude API accepted it' };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'the Claude API refused it (check that you copied the whole key)' };
      return { ok: null, detail: `couldn't check it (Claude API answered ${res.status})` };
    }
    if (id === 'uploadpost') {
      const res = await fetch(`${process.env.UPLOAD_POST_API || 'https://api.upload-post.com'}/api/uploadposts/me`, { headers: { Authorization: `Apikey ${key}` } });
      if (res.ok) { const me = await res.json().catch(() => ({})); return { ok: true, detail: me.plan ? `${me.plan} plan` : 'Upload-Post accepted it' }; }
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'Upload-Post refused it (check that you copied the whole key)' };
      return { ok: null, detail: `couldn't check it (Upload-Post answered ${res.status})` };
    }
    if (id === 'postiz') {
      // Your own Postiz, at the address chosen in setup: listing its channels is free and read-only.
      const base = (loadConfig(root).publish?.postiz?.url || 'http://localhost:4007/api').replace(/\/+$/, '');
      const res = await fetch(`${base}/public/v1/integrations`, { headers: { Authorization: key } });
      if (res.ok) {
        const list = [].concat(await res.json().catch(() => [])).filter((c) => c && !c.disabled);
        return { ok: true, detail: list.length ? `${list.length} channel${list.length === 1 ? '' : 's'} connected (${[...new Set(list.map((c) => c.identifier))].join(', ')})` : 'Postiz accepted it, but no channels are connected there yet' };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'your Postiz refused it (check that you copied the whole key)' };
      return { ok: null, detail: `couldn't check it (your Postiz at ${base} answered ${res.status})` };
    }
    if (id === 'elevenlabs') {
      const a = await new ElevenLabs({ key, server: voiceConfig(root).elevenlabs.server, fetch }).account();
      const left = Number.isFinite(a.characters_left) ? ` · ${a.characters_left.toLocaleString()} credits left` : '';
      return { ok: true, detail: `${a.tier} plan${left}${a.commercial_use ? ' · commercial use' : ' · free plan: non-commercial, credit ElevenLabs'}`, tier: a.tier };
    }
  } catch (e) {
    if (e.status === 401 && /permission/i.test(e.message)) return { ok: true, detail: 'it works, but can\'t read your plan (give the key the "User: read" permission to see credits here)' };
    if (e.auth || e.status === 401 || e.status === 403) return { ok: false, detail: 'ElevenLabs refused it (check that you copied the whole key)' };
    return { ok: null, detail: `couldn't check it (${e.message})` };
  }
  throw new UserError(`unknown key "${id}"`);
}

// ---- session.env: other keys handed to every session (names are shown, values never) ----

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function sessionKeyNames(root) {
  return Object.keys(readSessionEnv(root));
}

export function setSessionKey(root, name, value) {
  if (!ENV_NAME.test(name || '')) throw new UserError('key names are UPPER_CASE, e.g. GEMINI_API_KEY');
  if (Object.values(KEYS).some((k) => k.env === name)) throw new UserError(`${name} has its own place: \`mortiflix keys\` (or Settings › Keys)`);
  const v = value ? String(value).trim() : '';
  if (/[\r\n]/.test(v)) throw new UserError('a key is one line');
  const env = readSessionEnv(root);
  if (v) env[name] = v; else delete env[name];
  writeSessionEnv(root, env);
}
