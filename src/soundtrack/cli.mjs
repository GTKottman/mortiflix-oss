#!/usr/bin/env node
// node src/soundtrack/cli.mjs <studio root> <project id> [voice music effects mix]   (no stages = all four)
import { join } from 'node:path';
import { loadConfig, readSessionEnv, REPO, paths } from '../studio.mjs';
import { sessionToolsEnv } from '../setup.mjs';
import * as cc from '../backends/claude-code.mjs';
import { makeSoundtrack } from './index.mjs';

const [root, id, ...stages] = process.argv.slice(2);
if (!root || !id) { console.error('usage: cli.mjs <studio root> <project id> [voice music effects mix]'); process.exit(2); }
const config = loadConfig(root);
const env = { ...readSessionEnv(root), ...sessionToolsEnv(root), MFX_HOME: REPO, MFX_SHARED: join(paths(root).run, 'shared') };
const t0 = Date.now();
try {
  const r = await makeSoundtrack({ root, id, run: cc.run, config, stages: stages.length ? stages : undefined,
    runArgs: { root, projectId: id, env, transcript: join(root, 'state', id, 'sessions', 'quick.jsonl'), onActivity: () => {}, signal: null } });
  console.log(JSON.stringify({ ok: true, usage: r.usage, sec: (Date.now() - t0) / 1000 }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message, sec: (Date.now() - t0) / 1000 }));
  process.exitCode = 1;
}
