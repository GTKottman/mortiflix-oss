// The setup probes (claude, blender, browser-harness, ...) take seconds and used to run with spawnSync inside the
// service, so every request waited behind them (R1). Now a child process runs them; the answer is cached for 5 minutes
// and served stale while a background refresh runs. A cold cache is warmed at service start. `invalidate()` marks it
// stale and refreshes at once (setup.backend, keys.set, an install finishing).
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const WORKER = fileURLToPath(new URL('./setup-worker.mjs', import.meta.url));

export function createSetupCache(root, { ttlMs = 300_000, timeoutMs = 90_000, worker = WORKER } = {}) {
  const entries = new Map(); // kind -> { value, at, pending }
  const entry = (kind) => { if (!entries.has(kind)) entries.set(kind, { value: undefined, at: 0, pending: null }); return entries.get(kind); };

  function refresh(kind) {
    const e = entry(kind);
    if (e.pending) return e.pending;
    e.pending = run(process.execPath, [worker, root, kind], { timeout: timeoutMs, env: process.env })
      .then((r) => {
        if (r.status !== 0 || r.error) throw new Error(`the tool check failed: ${String(r.error?.message || r.stderr).trim().slice(-300)}`);
        e.value = JSON.parse(r.stdout.trim().split('\n').pop());
        e.at = Date.now();
        return e.value;
      })
      .finally(() => { e.pending = null; });
    e.pending.catch(() => {}); // a background refresh that fails keeps the old value
    return e.pending;
  }

  return {
    // The cached value at once; stale -> refresh in the background; cold (or `force`) -> wait for the child.
    async get(kind, { force = false } = {}) {
      const e = entry(kind);
      if (force) return refresh(kind);
      if (e.value === undefined) return refresh(kind);
      if (Date.now() - e.at > ttlMs) refresh(kind);
      return e.value;
    },
    warm() { for (const k of ['heavy', 'components']) refresh(k).catch(() => {}); },
    invalidate() { for (const [k, e] of entries) if (e.value !== undefined || e.pending) { e.at = 0; refresh(k).catch(() => {}); } },
    peek: (kind) => entries.get(kind)?.value,
    at: (kind) => entries.get(kind)?.at || 0,
  };
}
