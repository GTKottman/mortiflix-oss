// A stand-in for `claude -p`, for the Windows smoke test: it does what a real session does with the studio (reads its
// prompt, runs mfx from Claude Code's shell, queues renders) and writes down what it saw in .smoke/ for the test to
// check. No model, no network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '.smoke');
mkdirSync(dir, { recursive: true });
const seen = { prompt: readFileSync(0, 'utf8'), argv: process.argv.slice(2), mfx_socket: process.env.MFX_SOCKET || null, git_bash: process.env.CLAUDE_CODE_GIT_BASH_PATH || null };

// Claude Code's Bash tool: Git Bash on Windows (the backend says where), bash elsewhere.
const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash';
const sh = (script) => {
  const r = spawnSync(bash, ['-c', script], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim() };
};
seen.bash_status_list = sh('mfx status --list');
seen.bash_checks = sh('mfx checks directions');
// Claude Code's PowerShell tool and cmd find mfx.cmd instead.
if (process.platform === 'win32') {
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mfx status --list'], { encoding: 'utf8' });
  seen.cmd_status_list = { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'mfx status --list'], { encoding: 'utf8' });
  seen.powershell_status_list = { code: ps.status, out: `${ps.stdout || ''}${ps.stderr || ''}`.trim() };
}
// A render through a .cmd program (npx on Windows), waited for.
const queued = sh('mfx render --label "npx version" -- npx --version');
seen.render_queued = queued;
const id = (queued.out.match(/"id":\s*(\d+)/) || [])[1];
seen.render_wait = id ? sh(`mfx render-wait ${id} 120`) : { code: -1, out: 'no render id' };
// A render that never ends, with a child of its own: the studio has to stop the whole tree when the session ends.
const slash = (p) => p.replaceAll('\\', '/'); // Git Bash reads backslashes in double quotes as escapes
seen.sleeper = sh(`mfx render --label sleeper -- node "${slash(process.env.SMOKE_SLEEPER)}" "${slash(join(dir, 'sleeper-pids.json'))}"`);
sh('sleep 3');
seen.handoff = sh('mfx handoff "smoke test session"');
// Pause the project, so the runner doesn't start another session.
seen.needs_you = sh('mfx needs-you "smoke test: this session is a stand-in, nothing to make"');

writeFileSync(join(dir, 'seen.json'), JSON.stringify(seen, null, 2));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'smoke ok', usage: { input_tokens: 1, output_tokens: 1 } }));
