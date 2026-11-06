// A cheap "did anything change" token for the open project (R6): the newest mtime, the file count and the total size of
// everything under projects/<id> and state/<id> (stats only, no reads, node_modules/.git skipped), plus the studio's
// config.json. The service's 1.5 s tick does its full work only when this changes (or something poked it).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../studio.mjs';

const SKIP = new Set(['node_modules', '.git', '.cache']);
const MAX_ENTRIES = 50_000;

function walk(dir, acc) {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { acc.gone++; return; }
  for (const e of list) {
    if (acc.n > MAX_ENTRIES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, acc); continue; }
    try { const st = statSync(p); acc.n++; acc.size += st.size; if (st.mtimeMs > acc.mtime) acc.mtime = st.mtimeMs; } catch { acc.gone++; }
  }
}

export function changeToken(root, id) {
  const P = paths(root);
  const acc = { n: 0, size: 0, mtime: 0, gone: 0 };
  walk(join(P.projects, id), acc);
  walk(join(P.state, id), acc);
  for (const f of [P.config]) { try { const st = statSync(f); acc.n++; acc.size += st.size; acc.mtime = Math.max(acc.mtime, st.mtimeMs); } catch { acc.gone++; } }
  return acc.n > MAX_ENTRIES ? `big:${Date.now()}` : `${acc.n}:${acc.size}:${acc.mtime}:${acc.gone}`;
}
