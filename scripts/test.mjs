// npm test: node --test on the test files only (test/fixtures holds helpers, not tests). The list is made here
// because cmd.exe doesn't expand test/*.test.mjs and Node only expands it itself from version 21 on.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/platform.mjs';

const files = readdirSync(join(REPO_ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: REPO_ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
