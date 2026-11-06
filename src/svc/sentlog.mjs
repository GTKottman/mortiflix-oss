// What each AI call was sent (owner, 2026-11-05: "There shouldn't be a lot of mystery in the application."). One JSON file
// per call under state/<project>/sent/ plus index.jsonl for the list, kept out of the project folder so no session
// reads them back. Never the env: only the prompt, the answer and how much they used.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths } from '../projects.mjs';

const STEP_LABEL = { brief: 'Brief', script: 'Script', voice: 'Voice & music', music: 'Voice & music', frames: 'Look', transitions: 'Motion', animatic: 'Motion', scene: 'Motion', sound: 'Sound', artcraft: 'Finish', edit: 'Edit', session: 'Full AI session' };

export const sentDir = (root, id) => join(projectPaths(root, id).state, 'sent');

function schemaOf(args) {
  const a = args.config?.claudeArgs || [];
  const at = a.indexOf('--json-schema');
  if (at < 0) return null;
  try { return JSON.parse(a[at + 1]); } catch { return a[at + 1]; }
}

let serial = 0;
function record(root, id, step, args, r, started) {
  const dir = sentDir(root, id);
  mkdirSync(dir, { recursive: true });
  const at = new Date(started).toISOString();
  const file = `${at.replace(/[:.]/g, '-')}-${String(++serial).padStart(4, '0')}.json`;
  const session = !args.role && !schemaOf(args);
  const entry = {
    at, step, stage: STEP_LABEL[step] || step, role: args.role || null, model: args.config?.model || 'default',
    ok: !!r?.ok, error: r?.error || null, seconds: Math.round((Date.now() - started) / 1000), usage: r?.usage || null,
  };
  const body = { ...entry, prompt: String(args.prompt ?? ''), answer_format: schemaOf(args), answer: r?.structured ?? r?.summary ?? null };
  if (session) body.also_reads = 'CLAUDE.md in the project folder (see Made, Project notes)';
  writeFileSync(join(dir, file), JSON.stringify(body, null, 1));
  appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify({ ...entry, file, prompt_chars: body.prompt.length })}\n`);
}

// Wraps a backend's run. `step()` says which step is calling. A failed log never fails the call.
export function sentLog(run, { root, id, step }) {
  return async (args) => {
    const started = Date.now();
    let r = null;
    try {
      r = await run(args);
      return r;
    } catch (e) {
      r = { ok: false, error: e.message };
      throw e;
    } finally {
      try { record(root, id, step(), args, r, started); } catch (e) { console.error(`sent log: ${e.message}`); }
    }
  };
}

export function sentList(root, id) {
  const f = join(sentDir(root, id), 'index.jsonl');
  if (!existsSync(f)) return [];
  const rows = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a half-written last line */ }
  }
  return rows.reverse();
}
