// Runs Strudel text in a separate, locked-down Node process (doc 28 §2.1): read access to the Strudel install and this
// folder only, no writes, no child processes. Each pattern gets 2 s; one that hangs gets its process killed by PID and
// a fresh one starts for the next request.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { notesFromHaps } from './derive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PPQ = 960;

export function createEvaluator({ strudelDir, timeoutMs = 2000 } = {}) {
  if (!strudelDir || !existsSync(join(strudelDir, 'node_modules', '@strudel', 'core'))) {
    throw new Error('Strudel is not installed: run mortiflix setup music');
  }
  strudelDir = realpathSync(strudelDir);   // the read permission is checked on real paths
  let child = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();

  function start() {
    child = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${strudelDir}`, `--allow-fs-read=${HERE}`,
      join(HERE, 'worker.mjs'), strudelDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const me = child;
    let stderr = '';
    me.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    ready = new Promise((ok, fail) => {
      createInterface({ input: me.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) return ok();
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      });
      me.on('exit', (code) => {
        if (child === me) child = null;
        fail(new Error(`the Strudel evaluator stopped (${code}): ${stderr.trim().split('\n').at(-1) || 'no message'}`));
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('the Strudel evaluator stopped')); }
        pending.clear();
      });
    });
    ready.catch(() => {});
  }

  function kill() {
    if (!child) return;
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    child = null;
  }

  // prelude / globals: an app's own helpers and their data, run before the text (see the worker).
  // mode 'haps': the raw events with their values, as headless Chrome returns them. `ms` overrides the timeout (a whole
  // song takes longer than one pattern).
  async function run(code, { bars, tpb = 4 * PPQ, mode, ms = timeoutMs, prelude, globals, drums = false }) {
    if (!child) start();
    await ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        kill();
        reject(new Error(`the pattern took longer than ${ms / 1000} s to run (an endless loop?)`));
      }, ms);
      // the notes, by derive.mjs's rule, unless the raw events were asked for
      const answer = (msg) => {
        if (!msg.ok || mode === 'haps') return resolve(msg);
        const d = notesFromHaps(msg.haps, { ticksPerBar: tpb, bars, drums });
        resolve({ id: msg.id, ok: true, cps: msg.cps, notes: d.notes, problems: d.problems, hints: d.hints });
      };
      pending.set(id, { resolve: answer, reject, timer });
      child.stdin.write(JSON.stringify({ id, code, bars, tpb, mode, prelude, globals }) + '\n');
    });
  }

  return { run, close: kill, pid: () => child?.pid ?? null };
}
