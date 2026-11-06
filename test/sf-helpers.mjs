// Shared by the style frames v3 tests: a service harness on a temp studio (demo backend, no AI), and small file writers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createService } from '../src/service.mjs';

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export function harness(t, root, { runner = false } = {}) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) { const e = new Error(`${type}: ${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
  const events = (name) => out.filter((m) => m.event === name).map((m) => m.data);
  return { call, events, svc, out };
}
export const put = (root, rel, data = 'x') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), data); };
