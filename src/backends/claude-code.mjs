// Backend: your own Claude Code (`claude -p`), with your own login or plan. Each session is one headless run in
// the project's working folder; its stream-json transcript is kept in state/<id>/sessions/.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { REPO } from '../studio.mjs';
import { command, withPath, groupOptions, killTree, findGitBash } from '../platform.mjs';

export const name = 'claude-code';

export function available(config) {
  const c = command(config.claudeBin || 'claude', ['--version']);
  const r = spawnSync(c.file, c.args, { ...c.options, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? { ok: true, detail: r.stdout.trim() } : { ok: false, detail: `${config.claudeBin || 'claude'} not found: install Claude Code (https://claude.com/claude-code) and log in` };
}

// Set by a Claude Code conversation for its own tools. A run started from inside one (/mortiflix) must not hand its
// identity, socket or session to the studio's sessions: each session is its own Claude Code, as from a terminal.
export const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'];

export async function run({ root, workdir, prompt, env, transcript, onActivity, signal, config }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(config.claudeArgs || [])];
  if (config.model) args.push('--model', config.model);
  const sessionEnv = withPath({
    ...process.env,
    ...env,
    // A one-shot session ends when its turn ends: anything backgrounded would be killed mid-job.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  }, join(REPO, 'bin'));
  for (const k of PARENT_SESSION_VARS) delete sessionEnv[k];
  // Claude Code on Windows runs its shell commands in Git Bash: point it at the one we found, unless it's set.
  if (process.platform === 'win32' && !sessionEnv.CLAUDE_CODE_GIT_BASH_PATH) {
    const bash = findGitBash();
    if (bash) sessionEnv.CLAUDE_CODE_GIT_BASH_PATH = bash;
  }
  let cmd = config.claudeBin || 'claude';
  let argv = args;
  let options = {};
  if (config.sandbox && process.platform === 'linux') {
    const box = sandboxArgs({ root, workdir, socket: env.MFX_SOCKET, claudeBin: cmd, env: sessionEnv });
    argv = [...box, resolveBin(cmd), ...args];
    cmd = 'bwrap';
  } else ({ file: cmd, args: argv, options } = command(cmd, args, { env: sessionEnv }));

  const out = createWriteStream(transcript, { flags: 'a' });
  // The prompt goes in on stdin: no quoting to get wrong (claude.cmd on Windows runs through cmd.exe), no length limit.
  const p = spawn(cmd, argv, { ...options, ...groupOptions(), cwd: workdir, env: sessionEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.on('error', () => {});
  p.stdin.end(prompt);
  const kill = () => killTree(p.pid);
  signal?.addEventListener('abort', kill, { once: true });

  let result = null;
  let billing = null;   // 'plan' (a Claude subscription login: nothing charged per token) or 'api' (an API key: real spend)
  createInterface({ input: p.stdout }).on('line', (line) => {
    out.write(`${line}\n`);
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource !== undefined) billing = m.apiKeySource === 'none' ? 'plan' : 'api';
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) onActivity({ kind: 'text', text: b.text });
        if (b.type === 'tool_use') onActivity({ kind: 'tool', text: describeTool(b.name, b.input) });
      }
    } else if (m.type === 'user') {
      for (const b of m.message?.content || []) {
        if (b.type === 'tool_result' && b.is_error) onActivity({ kind: 'error', text: flatten(b.content).slice(0, 400) });
      }
    } else if (m.type === 'result') {
      result = m;
    }
  });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; out.write(JSON.stringify({ type: 'stderr', text: String(d) }) + '\n'); });

  const code = await new Promise((ok) => { p.on('close', ok); p.on('error', (e) => { stderr += e.message; ok(127); }); });
  signal?.removeEventListener('abort', kill);
  // Closed before returning: Windows can't delete a folder while a file in it is still open.
  await new Promise((ok) => out.end(ok));
  const usage = result?.usage ? { input_tokens: (result.usage.input_tokens || 0) + (result.usage.cache_read_input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0), output_tokens: result.usage.output_tokens || 0 } : null;
  if (signal?.aborted) return { ok: false, error: 'stopped', usage };
  if (code !== 0 || result?.is_error) {
    return { ok: false, error: (result?.result || stderr || `claude exited with ${code}`).toString().slice(-1000), usage, cost_usd: result?.total_cost_usd, billing };
  }
  return { ok: true, usage, cost_usd: result?.total_cost_usd, billing, summary: result?.result };
}

export function describeTool(name, input = {}) {
  if (name === 'Bash') return `$ ${String(input.command || '').split('\n')[0].slice(0, 200)}`;
  if (['Read', 'Write', 'Edit'].includes(name)) return `${name} ${input.file_path || ''}`;
  if (name === 'WebSearch') return `Search: ${input.query || ''}`;
  if (name === 'WebFetch') return `Fetch: ${input.url || ''}`;
  if (name === 'Skill') return `Skill: ${input.skill || input.name || ''}`;
  return name;
}

const flatten = (c) => (Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : String(c || ''));

function resolveBin(bin) {
  if (bin.includes('/')) return bin;
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.stdout.trim() || bin;
}

// Linux only (bubblewrap): the session sees the system read-only, its own working folder read-write, the Mortiflix
// code read-only, its own mfx socket, and Claude Code's install + login. Your other files, other projects and
// the studio's records are not there. The network is shared (Claude needs it).
export function sandboxArgs({ root, workdir, socket, claudeBin, env }) {
  const home = homedir();
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--symlink', 'usr/bin', '/sbin', '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/mnt', '--tmpfs', '/media', '--tmpfs', '/srv',
    '--tmpfs', '/var', '--tmpfs', '/root', '--dir', '/var/tmp'];
  if (existsSync('/opt')) a.push('--ro-bind', '/opt', '/opt');
  if (existsSync('/dev/dri')) a.push('--dev-bind', '/dev/dri', '/dev/dri');
  for (const d of ['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia-modeset']) if (existsSync(d)) a.push('--dev-bind', d, d);
  // Claude Code itself and its login.
  const bin = realpathSync(resolveBin(claudeBin));
  const install = installRoot(bin);
  a.push('--ro-bind', install, install);
  const claudeLink = resolveBin(claudeBin);
  if (claudeLink !== bin) a.push('--ro-bind', claudeLink, claudeLink);
  for (const p of [join(home, '.claude'), join(home, '.claude.json')]) if (existsSync(p)) a.push('--bind', p, p);
  // node/npx (often under ~/.nvm or similar): read-only.
  const node = realpathSync(process.execPath);
  if (!node.startsWith('/usr/')) a.push('--ro-bind', dirname(dirname(node)), dirname(dirname(node)));
  // A package cache that survives sessions, inside the studio.
  const npmCache = join(root, 'run', 'npm-cache');
  mkdirSync(npmCache, { recursive: true });
  a.push('--bind', npmCache, join(home, '.npm'));
  // Installs shared by every project (e.g. Remotion, via the remotion-motion skill's setup.mjs).
  const shared = join(root, 'run', 'shared');
  mkdirSync(shared, { recursive: true });
  a.push('--bind', shared, shared);
  a.push('--ro-bind', REPO, REPO);
  a.push('--bind', workdir, workdir);
  a.push('--bind', socket, socket);
  a.push('--chdir', workdir, '--setenv', 'HOME', home, '--setenv', 'PATH', env.PATH, '--setenv', 'TMPDIR', '/tmp');
  return a;
}

function installRoot(bin) {
  // ~/.local/share/claude/versions/x.y.z  ->  ~/.local/share/claude ; npm installs -> the package dir
  const m = bin.match(/^(.*\/claude)\/versions\//);
  if (m) return m[1];
  const n = bin.match(/^(.*\/node_modules\/@anthropic-ai\/claude-code)\//);
  if (n) return n[1];
  return dirname(bin);
}
