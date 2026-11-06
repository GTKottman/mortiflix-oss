// Async child process for the service and the runner (R4): the same result shape as spawnSync ({status, stdout,
// stderr, error}) so call sites change by an `await`, but the event loop keeps answering requests while it runs.
// Options: cwd, env, timeout (ms, SIGKILL), maxBuffer (bytes per stream, output beyond it is dropped), encoding
// ('utf8' default; 'buffer' keeps stdout as a Buffer), input.
import { spawn } from 'node:child_process';
import { command } from '../platform.mjs';

export function run(cmd, args = [], { cwd, env, timeout = 0, maxBuffer = 16 * 1024 * 1024, encoding = 'utf8', input } = {}) {
  return new Promise((resolve) => {
    let child;
    const out = [], err = [];
    let nOut = 0, nErr = 0, done = false, timedOut = false, timer = null;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    const text = (chunks) => (encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding));
    // command(): the same cmd and args on Linux/macOS; on Windows npx/npm (.cmd) through cmd.exe and bash as Git Bash.
    try { const c = command(cmd, args, { env: env || process.env }); child = spawn(c.file, c.args, { ...c.options, cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); } catch (error) { return finish({ status: null, stdout: '', stderr: '', error }); }
    child.stdout.on('data', (d) => { if (nOut < maxBuffer) { out.push(d); nOut += d.length; } });
    child.stderr.on('data', (d) => { if (nErr < maxBuffer) { err.push(d); nErr += d.length; } });
    if (input !== undefined) child.stdin.end(input);
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', (error) => finish({ status: null, stdout: '', stderr: '', error }));
    child.on('close', (status, signal) => finish({
      status, signal, stdout: text(out), stderr: encoding === 'buffer' ? Buffer.concat(err).toString() : text(err),
      error: timedOut ? Object.assign(new Error(`${cmd} timed out after ${timeout} ms`), { code: 'ETIMEDOUT' }) : undefined,
    }));
  });
}
