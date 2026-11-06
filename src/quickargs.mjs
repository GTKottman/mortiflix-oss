// What a quick call (one `claude -p` with --json-schema or no tools: chat, beat names, the quick steps) needs on top of
// a session's lean flags, so its start-up context is as small as possible and byte-identical across projects (cached):
//   --disable-slash-commands                      no bundled skills listed (about 1.5-2k tokens)
//   --exclude-dynamic-system-prompt-sections      cwd, memory path, git status leave the system prompt (move into the first message)
//   --no-session-persistence                      nothing kept on disk for a one-shot
// and one shared working folder (run/quick/_shared) instead of one per project, so the system prompt is the same for
// every project. Files the prompt names (contact sheets) are reached by absolute path through --add-dir.
import { basename, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const QUICK_FLAGS = ['--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence'];

export const isQuick = (claudeArgs = []) => claudeArgs.includes('--json-schema');

// run/quick/<id> or run/quick -> run/quick/_shared; any other folder: null (leave the cwd alone).
export function sharedQuickDir(workdir) {
  const base = basename(workdir) === 'quick' ? workdir : basename(dirname(workdir)) === 'quick' ? dirname(workdir) : null;
  return base ? join(base, '_shared') : null;
}

export function withQuickFlags(args) {
  const out = [...args];
  for (const f of QUICK_FLAGS) if (!out.includes(f)) out.push(f);
  return out;
}

// { args, cwd } for a quick call that was going to run in `workdir`.
export function quickCall(args, workdir, { shareCwd = true } = {}) {
  const out = withQuickFlags(args);
  const shared = shareCwd ? sharedQuickDir(workdir) : null;
  if (!shared) return { args: out, cwd: workdir };
  mkdirSync(shared, { recursive: true });
  if (shared !== workdir) out.push('--add-dir', workdir);
  return { args: out, cwd: shared };
}
