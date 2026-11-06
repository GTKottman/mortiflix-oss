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
import { replayConfig } from './replay.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { restrictToOwner, pidAlive, procStart } from './platform.mjs';

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
  leanSessions: true,               // claude-code: sessions skip your own MCP servers, plugins, skills and global CLAUDE.md
  quickScript: true,                // claude-code: the script is written by one quick call, not a whole session
  sandbox: false,                   // claude-code on Linux: run each session inside bubblewrap
  maxSessionMinutes: 240,
  maxSessionTokens: 1_160_000,      // fresh tokens (input + cache writes + output) one session may use before it is stopped (runner.mjs)
  paid: { ask_first: true },        // cost first: a step that spends ElevenLabs (voice, music, sound) waits for the owner's OK on the cost (src/svc/paidgate.mjs)
  sessions: { parallel: 'auto' },   // sessions at once across projects (one per project): a number, or "auto" (free RAM decides, src/svc/sessionslots.mjs)
  renders: { parallel: 'auto' },  // renders at once: a number, or "auto" (CPU threads and free RAM decide, src/renderq.mjs)
  renderPrefix: [],                 // wraps every `mfx render` command, e.g. a machine-wide queue: ["render-queue", "-l", "{label}", "--"]
  maxTurns: 500,                    // anthropic-api: tool-use turns per session
  videoNotes: { enabled: false, folder: null }, // the owner's tablet reviews Motion scenes (svc/videonotes.mjs); opt-in, folder null = the Video Notes folder in Morti Drive
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
  return replayConfig(root, { ...DEFAULT_CONFIG, ...saved });
}

// Read, merge and write under the lock: the service, the CLI and the web server are separate processes.
export function saveConfig(root, patch) {
  const p = paths(root);
  return withLock(`${p.config}.lock`, () => {
    const saved = existsSync(p.config) ? readJson(p.config) : {};
    const next = { ...saved, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    writeJson(p.config, next);
    return { ...DEFAULT_CONFIG, ...next };
  });
}

export function readSecret(root, key) {
  const p = paths(root).secrets;
  if (!existsSync(p)) return null;
  try { return readJson(p)[key] ?? null; } catch { return null; }
}

export function writeSecret(root, key, value) {
  const p = paths(root).secrets;
  withLock(`${p}.lock`, () => {
    const cur = existsSync(p) ? readJson(p) : {};
    if (value) cur[key] = value; else delete cur[key];
    writeJson(p, cur, 0o600);
  });
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
  restrictToOwner(tmp);
  renameSync(tmp, p);
}

// ---- small file helpers used everywhere ----

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// A JSON list file: [] when it does not exist yet. A file that exists but is damaged or not a list is an error, never
// read as empty: callers append and write back, so an empty read would wipe every entry in it.
export function readJsonList(file) {
  if (!existsSync(file)) return [];
  let j;
  try { j = readJson(file); } catch (e) { throw new UserError(`${file} is damaged and was not changed (${e.message}). Fix or remove it, then try again.`); }
  if (!Array.isArray(j)) throw new UserError(`${file} is not a list and was not changed. Fix or remove it, then try again.`);
  return j;
}

export function writeJson(file, value, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  // Secrets (600): on Windows the mode means nothing, so they get an ACL for you alone instead.
  if (mode === 0o600) restrictToOwner(tmp);
  else if (mode) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

// A cross-process lock (a directory, because mkdir is atomic: the proper-lockfile design). The CLI and the web
// server may both write a project at once; every read-modify-write goes through this.
// The holder writes its pid, its process start time and a random tag into <lock>/owner. A waiter takes a lock over
// only when its holder is gone (crashed or killed), never because it is slow: a holder copying a big file keeps it
// (a 15 s age limit let a second writer in during long copies and lost a change). A lock with no owner file is
// taken over after `staleMs` (made by an older version, or its maker died between mkdir and writing the file).
// The holder removes the lock only while it is still its own.
const MY_START = procStart(process.pid) ?? '-';
export function withLock(lockPath, fn, { staleMs = 15_000, waitMs = 10_000 } = {}) {
  const me = `${process.pid} ${MY_START} ${randomBytes(6).toString('hex')}`;
  const ownerFile = join(lockPath, 'owner');
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const seen = abandonedLock(lockPath, ownerFile, staleMs);
      // Take it over only if it is still the abandoned one we looked at (another waiter may have done so already).
      // rename, not rm: rename is atomic, so of two waiters that saw the same dead owner only one moves it aside (the
      // other's rename fails), and nobody can delete a lock another waiter has just taken
      if (seen !== null && readOwner(ownerFile) === seen) {
        const aside = `${lockPath}.stale-${randomBytes(4).toString('hex')}`;
        try { renameSync(lockPath, aside); } catch { continue; }
        if (readOwner(join(aside, 'owner')) === seen) rmSync(aside, { recursive: true, force: true });
        else { try { renameSync(aside, lockPath); } catch { /* the live lock stays aside; its holder's finally still finds itself gone */ } }
        continue;
      }
      if (Date.now() - start > waitMs) throw new Error(`timed out waiting for ${lockPath}`);
      sleepSync(5);
      continue;
    }
    try { writeFileSync(ownerFile, me); } catch (e) { rmSync(lockPath, { recursive: true, force: true }); throw e; }
    break;
  }
  try {
    return fn();
  } finally {
    if (readOwner(ownerFile) === me) rmSync(lockPath, { recursive: true, force: true });
  }
}

// <lock>/owner's text, '' when the lock has no owner file, null when the lock itself is gone.
function readOwner(ownerFile) {
  try { return readFileSync(ownerFile, 'utf8'); } catch (e) { return e.code === 'ENOENT' && existsSync(dirname(ownerFile)) ? '' : null; }
}

// The owner text of a lock whose holder is gone ('' for an old lock with no owner file), else null (held, or gone).
function abandonedLock(lockPath, ownerFile, staleMs) {
  const owner = readOwner(ownerFile);
  if (owner === null) return null;
  const m = /^(\d+) (\S+) [0-9a-f]{12}$/.exec(owner);
  // no owner file, or one still being written: judged by the lock's age, as before
  if (!m) {
    try { return Date.now() - statSync(lockPath).mtimeMs > staleMs ? owner : null; } catch { return null; }
  }
  const n = Number(m[1]);
  const started = m[2];
  if (!pidAlive(n)) return owner;
  // the same pid, now another program (the system reused it): the holder is gone
  const now = procStart(n);
  return started !== '-' && now !== null && now !== started ? owner : null;
}

// Is `child` inside `parent` (both already resolved)?
export function isInside(parent, child) {
  const rel = child.slice(parent.length);
  return child === parent || (child.startsWith(parent) && (rel.startsWith('/') || rel.startsWith('\\')));
}
