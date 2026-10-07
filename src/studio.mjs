// The studio: one folder on this machine that holds the settings, the projects and their history.
//
//   <studio>/
//     config.json          settings (backend, model, port...). No secrets.
//     secrets.json         your Anthropic, ElevenLabs and Upload-Post keys (mode 600), set with `mortiflix keys`. Never served, never logged.
//     session.env          other keys handed to every session (e.g. GEMINI_API_KEY=...), mode 600, also set with `mortiflix keys`
//     checks.json          the studio's error checklist (grows from your feedback)
//     pipelines/<slug>/    your own pipelines (override the built-in ones with the same slug)
//     projects/<id>/       the session's working folder (it runs here)
//     state/<id>/          the project's record: what was submitted, what you said. Sessions never write here.
//     run/                 the runner lock, sockets, render logs
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// A refusal caused by what someone asked for (bad input, wrong state): shown to them, never a crash.
export class UserError extends Error {}

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  backend: 'claude-code',          // 'claude-code' | 'anthropic-api' | 'demo'
  model: null,                      // null = the backend's default (anthropic-api: claude-opus-5-5)
  effort: 'high',                   // anthropic-api only: low | medium | high | xhigh | max
  claudeBin: 'claude',
  claudeArgs: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Skill TodoWrite'],
  webTools: true,                   // anthropic-api: give sessions web search + web fetch
  fallbacks: true,                  // anthropic-api: server-side refusal fallbacks
  sandbox: false,                   // claude-code on Linux: run each session inside bubblewrap
  maxSessionMinutes: 240,
  renderPrefix: [],                 // wraps every `mfx render` command, e.g. a machine-wide queue: ["render-queue", "-l", "{label}", "--"]
  maxTurns: 500,                    // anthropic-api: tool-use turns per session
  host: '127.0.0.1',
  port: 4646,
};

export function studioRoot(explicit) {
  return resolve(explicit || process.env.MORTIFLIX_STUDIO || join(homedir(), 'Mortiflix'));
}

export function paths(root) {
  return {
    root,
    config: join(root, 'config.json'),
    secrets: join(root, 'secrets.json'),
    sessionEnv: join(root, 'session.env'),
    checks: join(root, 'checks.json'),
    pipelines: join(root, 'pipelines'),
    projects: join(root, 'projects'),
    state: join(root, 'state'),
    run: join(root, 'run'),
  };
}

export function ensureStudio(root) {
  const p = paths(root);
  // A new studio is yours alone: it holds your keys and your clients' material.
  if (!existsSync(p.root)) mkdirSync(p.root, { recursive: true, mode: 0o700 });
  for (const d of [p.pipelines, p.projects, p.state, p.run]) mkdirSync(d, { recursive: true });
  if (!existsSync(p.config)) writeJson(p.config, { backend: DEFAULT_CONFIG.backend });
  if (!existsSync(p.checks)) writeJson(p.checks, { active: [], proposed: [] });
  return p;
}

export function loadConfig(root) {
  const p = paths(root);
  const saved = existsSync(p.config) ? readJson(p.config) : {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(root, patch) {
  const p = paths(root);
  const saved = existsSync(p.config) ? readJson(p.config) : {};
  const next = { ...saved, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writeJson(p.config, next);
  return { ...DEFAULT_CONFIG, ...next };
}

export function readSecret(root, key) {
  const p = paths(root).secrets;
  if (!existsSync(p)) return null;
  try { return readJson(p)[key] ?? null; } catch { return null; }
}

export function writeSecret(root, key, value) {
  const p = paths(root).secrets;
  const cur = existsSync(p) ? readJson(p) : {};
  if (value) cur[key] = value; else delete cur[key];
  writeJson(p, cur, 0o600);
}

// session.env: KEY=value lines handed to every session's environment (never shown anywhere).
export function readSessionEnv(root) {
  const p = paths(root).sessionEnv;
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export function writeSessionEnv(root, env) {
  const p = paths(root).sessionEnv;
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

// ---- small file helpers used everywhere ----

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

// A cross-process lock (a directory, because mkdir is atomic). The CLI and the web server may both write a
// project at once; every read-modify-write goes through this.
export function withLock(lockPath, fn, { staleMs = 15_000, waitMs = 10_000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { rmSync(lockPath, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > waitMs) throw new Error(`timed out waiting for ${lockPath}`);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

// Is `child` inside `parent` (both already resolved)?
export function isInside(parent, child) {
  const rel = child.slice(parent.length);
  return child === parent || (child.startsWith(parent) && (rel.startsWith('/') || rel.startsWith('\\')));
}
