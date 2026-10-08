// A render that never ends and starts a child of its own, so the smoke test can check that stopping a session stops
// the whole process tree. Writes both pids to the file it's given.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
