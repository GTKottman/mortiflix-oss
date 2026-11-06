// First-run setup and Settings › Mortiflix (part 09): link the user's own Claude Code (the AI, no API needed), optional
// keys (Anthropic as a fallback only, ElevenLabs, Gemini, Upload-Post), and a tool check. Keys are kept by the
// studio (secrets.json / session.env, mode 600), never in project files, and never sent back to the app.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfig, saveConfig, readSessionEnv, UserError } from '../studio.mjs';
import { KEYS, keySource, keyValue, saveKey, verifyKey, setSessionKey } from '../keys.mjs';
import { which, command } from '../platform.mjs';
import { setupStatusSync, TOOLS, TOOL_INFO, dawEngineBin } from '../setup.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { runClaude } from './chat.mjs';
import { videoNotesLight } from './videonotes.mjs';

export const BACKENDS = ['claude-code', 'anthropic-api', 'demo'];
// Keys a session reads from its environment, kept in session.env (not in KEYS).
const SESSION_KEYS = {
  gemini: { name: 'Gemini API key', env: 'GEMINI_API_KEY', for: 'pictures and video made with Google Gemini / Veo, when a pipeline uses them. Optional.', get: 'aistudio.google.com › Get API key' },
};

// Claude Code: on the PATH (or config.claudeBin), its version, and whether it is logged in (`claude auth status`).
export function claudeStatus(root) {
  const config = loadConfig(root);
  const bin = config.claudeBin || 'claude';
  const path = bin.includes('/') || bin.includes('\\') ? bin : which(bin);
  if (!path) return { found: false, bin, detail: 'Claude Code is not installed: get it from https://claude.com/claude-code, then Link it here.', login_command: null };
  const sync = (args) => { const c = command(path, args); return spawnSync(c.file, c.args, { ...c.options, encoding: 'utf8', timeout: 15_000 }); }; // claude.cmd on Windows
  const v = sync(['--version']);
  if (v.status !== 0) return { found: false, bin, path, detail: `Claude Code didn't start: ${(v.stderr || v.error?.message || '').trim().slice(0, 200)}`, login_command: null };
  const a = sync(['auth', 'status', '--json']);
  let auth = null;
  try { auth = JSON.parse(a.stdout); } catch { auth = null; }
  return {
    found: true, bin, path, version: v.stdout.trim().slice(0, 100),
    logged_in: auth ? Boolean(auth.loggedIn) : null,
    auth_method: auth?.authMethod || null,
    subscription: auth?.subscriptionType || null,
    // Run in a terminal the app shows (the login opens the browser).
    login_command: [path, 'auth', 'login'],
    detail: auth?.loggedIn ? `Linked (${auth.authMethod || 'logged in'}${auth.subscriptionType ? `, ${auth.subscriptionType}` : ''}).` : auth ? 'Installed, not logged in: press Link Claude Code.' : 'Installed; login state unknown.',
  };
}

export function keysList(root) {
  const env = readSessionEnv(root);
  return [
    ...Object.entries(KEYS).map(([id, k]) => ({ id, name: k.name, for: k.for, get: k.get, set: Boolean(keySource(root, id)), source: keySource(root, id), optional: true })),
    ...Object.entries(SESSION_KEYS).map(([id, k]) => ({ id, name: k.name, for: k.for, get: k.get, set: Boolean(env[k.env] || process.env[k.env]), source: env[k.env] ? 'session.env' : process.env[k.env] ? 'environment' : null, optional: true })),
  ];
}

export function keySet(root, id, value) {
  const v = value === null || value === undefined ? null : String(value).trim();
  if (v !== null && (!v || v.length > 500 || /\s/.test(v))) throw new UserError('paste the key (one line, no spaces)');
  if (KEYS[id]) saveKey(root, id, v);
  else if (SESSION_KEYS[id]) setSessionKey(root, SESSION_KEYS[id].env, v);
  else throw new UserError(`unknown key "${id}" (${[...Object.keys(KEYS), ...Object.keys(SESSION_KEYS)].join(', ')})`);
  return keysList(root).find((k) => k.id === id);
}

// A free check that a saved key works (network: only when the owner presses Check).
export async function keyCheck(root, id) {
  if (!KEYS[id]) return { ok: null, detail: 'no free check for this key' };
  const value = keyValue(root, id);
  if (!value) return { ok: null, detail: 'no key saved' };
  return verifyKey(root, id, value);
}

// Tools: what's there, what each is for, all skippable. Node is the one running this service.
export function toolsStatus(root) {
  let tools = {};
  try { tools = setupStatusSync(root); } catch (e) { tools = { error: e.message }; }
  return {
    node: { ok: true, version: process.version, path: process.execPath },
    ffmpeg: { ok: Boolean(which('ffmpeg')), path: which('ffmpeg'), for: 'every render and the demo' },
    ffprobe: { ok: Boolean(which('ffprobe')), path: which('ffprobe') },
    engine: { ok: existsSync(dawEngineBin(root)), path: dawEngineBin(root), for: 'plays the music mix' },
    installable: TOOLS.map((t) => ({ id: t, ...(TOOL_INFO[t] || {}) })),
    studio: tools,
  };
}

// The cheap part of the status: config and key reads only, always live.
export function setupStatusLight(root) {
  const config = loadConfig(root);
  return {
    backend: config.backend, backends: BACKENDS, chat_backend: config.chatBackend || null,
    keys: keysList(root),
    voice: (({ engine }) => ({ engine }))(voiceConfig(root)),
    videoNotes: videoNotesLight(root),
    first_run: !config.mfx_setup_done,
  };
}

// The slow part: it runs `claude --version`, `claude auth status`, `blender --version` and the other tool probes
// (seconds, spawnSync). The service never calls it in-process: svc/setup-cache.mjs runs it in a child and caches it.
export function setupStatusHeavy(root) {
  return { claude: claudeStatus(root), tools: toolsStatus(root) };
}

export function setupStatus(root) {
  return { ...setupStatusLight(root), ...setupStatusHeavy(root) };
}

// The backend, and (part 09) where `claude` is: the app finds it in the install folders a desktop app's PATH lacks.
export function setBackend(root, backend, claudeBin) {
  const patch = {};
  if (backend !== undefined || claudeBin === undefined) {
    if (!BACKENDS.includes(backend)) throw new UserError(`backend: ${BACKENDS.join(', ')}`);
    patch.backend = backend;
  }
  if (claudeBin !== undefined) {
    const bin = String(claudeBin || '').trim() || 'claude';
    if (bin.length > 4096 || /[\r\n\0]/.test(bin) || (bin !== 'claude' && !isAbsolute(bin))) throw new UserError('claudeBin is `claude` or an absolute path');
    patch.claudeBin = bin;
  }
  const c = saveConfig(root, patch);
  return { backend: c.backend, claudeBin: c.claudeBin };
}

export function setupDone(root, done = true) {
  saveConfig(root, { mfx_setup_done: done ? new Date().toISOString() : null });
  return { done: Boolean(done) };
}

// The test message that proves the chat works: one short `claude -p` with no tools, on the user's own login.
export async function claudeTest(root) {
  const config = loadConfig(root);
  const t0 = Date.now();
  const out = await runClaude(config, ['-p', 'Reply with exactly: Mortiflix is linked.', '--output-format', 'json', '--tools', '', '--no-session-persistence'], process.cwd(), { timeoutMs: 120_000 });
  let j;
  try { j = JSON.parse(out); } catch { throw new UserError('Claude Code answered, but not in JSON: update Claude Code'); }
  if (j.is_error) throw new UserError(String(j.result || 'Claude Code said no').slice(0, 300));
  return { ok: true, reply: String(j.result || '').slice(0, 300), seconds: Math.round((Date.now() - t0) / 100) / 10, billing: j.total_cost_usd !== undefined ? 'reported' : null };
}
