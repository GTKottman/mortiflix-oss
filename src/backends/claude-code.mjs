// Backend: your own Claude Code (`claude -p`), with your own login or plan. Each session is one headless run in
// the project's working folder; its stream-json transcript is kept in state/<id>/sessions/.
import { refuseReal } from '../replay.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, realpathSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { REPO } from '../studio.mjs';
import { craftDir, craftMcpFile } from '../craft.mjs';
import { kgDir } from '../kinetograph.mjs';
import { isQuick, quickCall } from '../quickargs.mjs';
import { command, withPath, groupOptions, killTreeHard, findGitBash } from '../platform.mjs';

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

export async function run({ root, workdir, prompt, env, transcript, onActivity, signal, config, onSpawn }) {
  refuseReal('the Claude Code backend');
  // The prompt goes in on stdin: it carries the start files (tens of kB), past Windows' 32k command-line limit.
  let args = ['-p', '--output-format', 'stream-json', '--verbose', ...leanArgs(withCraft(config.claudeArgs || [], workdir), config)];
  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('--effort', config.effort);
  // A quick call (the studio's own one-shot steps) starts as small as it can and in one shared folder: see quickargs.mjs.
  let cwd = workdir;
  if (isQuick(config.claudeArgs) && config.leanSessions !== false) ({ args, cwd } = quickCall(args, workdir, { shareCwd: !config.sandbox }));
  // Sessions use the studio browser through browser-harness; Claude in Chrome would drive the owner's own Chrome.
  if (!args.includes('--disallowedTools')) args.push('--disallowedTools', 'mcp__claude-in-chrome__*');
  // the service's own folder is denied even when the session has the owner's whole setup (leanSessions: false)
  if (!args.includes('--settings')) args.push('--settings', JSON.stringify({ permissions: { deny: serviceDeny() } }));
  const sessionEnv = withPath({
    ...process.env,
    ...env,
    // PATH: the repo's bin/ first (withPath), then env.PATH: the studio tools (e.g. Kinetograph) sessionToolsEnv puts first
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
  // A transcript that can't be written (disk full) is said once in the activity; with no 'error' listener the stream
  // would throw and end the whole service with every session in it.
  let outError = null;
  out.on('error', (e) => { if (!outError) { outError = e; onActivity({ kind: 'error', text: `The session's transcript can't be written (${e.message}).` }); } });
  // detached on Linux/macOS (a process group the kill below stops whole); on Windows windowsHide (no console window)
  // and taskkill /T stops the tree.
  const p = spawn(cmd, argv, { ...options, ...groupOptions(), cwd, env: sessionEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.on('error', () => { /* exited before reading it: the close below reports why */ });
  p.stdin.end(prompt);
  if (p.pid) onSpawn?.(p.pid);
  // Stop: SIGTERM to the session's process group, SIGKILL to what is left of it 5 s later. If a program outside the
  // group still holds the output pipes, 'close' never comes: 5 s more and the pipes are closed from this side.
  let pipesTimer = null;
  const kill = () => {
    killTreeHard(p.pid);
    pipesTimer = setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); }, 10_000);
    pipesTimer.unref?.();
  };
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
        // The session's own to-do list goes to the live view as it is (what it's doing, what's next).
        if (b.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) onActivity({ kind: 'todo', text: 'To-do list', todos: b.input.todos.slice(0, 40).map((x) => ({ content: String(x.content || '').slice(0, 200), status: x.status })) });
        else if (b.type === 'tool_use') onActivity({ kind: 'tool', text: describeTool(b.name, b.input) });
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
  clearTimeout(pipesTimer);
  out.end();
  const usage = result?.usage ? { input_tokens: (result.usage.input_tokens || 0) + (result.usage.cache_read_input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0), output_tokens: result.usage.output_tokens || 0, cache_read_input_tokens: result.usage.cache_read_input_tokens || 0, cache_creation_input_tokens: result.usage.cache_creation_input_tokens || 0 } : null;
  if (signal?.aborted) return { ok: false, error: 'stopped', usage };
  if (code !== 0 || result?.is_error) {
    return { ok: false, error: (result?.result || stderr || `claude exited with ${code}`).toString().slice(-1000), usage, cost_usd: result?.total_cost_usd, billing };
  }
  return { ok: true, usage, cost_usd: result?.total_cost_usd, billing, summary: result?.result, structured: result?.structured_output };
}

// The studio's Craft apps (written by prepareWorkdir when any is installed): their MCP servers, and their tools allowed
// (mcp__<app> allows every tool of that server), added to the owner's allow list or as one of its own.
export function withCraft(claudeArgs, workdir) {
  const file = craftMcpFile(workdir);
  if (!existsSync(file)) return claudeArgs;
  let ids;
  try { ids = Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers || {}); } catch { return claudeArgs; }
  if (!ids.length) return claudeArgs;
  const allow = ids.map((id) => `mcp__${id}`).join(' ');
  const out = [...claudeArgs];
  const i = out.findIndex((a) => a === '--allowedTools' || a === '--allowed-tools');
  if (i >= 0 && i + 1 < out.length) out[i + 1] = `${out[i + 1]} ${allow}`;
  else out.push('--allowedTools', allow);
  return [...out, '--mcp-config', file];
}

// The tools a lean session has: the built-in ones the allow list names, plus Task (sessions hand big jobs to helpers).
export const SESSION_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite', 'Task'];

// A session is a Mortiflix worker, not your own Claude Code: without these it starts with every MCP server, plugin,
// skill and global CLAUDE.md you have (about 38k tokens before its first word, re-read on every step). Lean, it gets
// only the project's own CLAUDE.md and .claude/skills, the studio's Craft servers (--mcp-config) and the tools above
// (about 20k). Your login and plan still apply. config.leanSessions: false gives sessions your whole setup again;
// a flag already in claudeArgs is left as you set it.
export function leanArgs(args, config = {}) {
  if (config.leanSessions === false) return args;
  const out = [...args];
  const has = (f) => out.includes(f);
  if (!has('--strict-mcp-config')) out.push('--strict-mcp-config');
  if (!has('--setting-sources')) out.push('--setting-sources', 'project,local');
  if (!has('--tools')) out.push('--tools', SESSION_TOOLS.join(' '));
  if (!has('--settings')) {
    const userMd = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'CLAUDE.md');
    out.push('--settings', JSON.stringify({ claudeMdExcludes: [userMd], permissions: { deny: serviceDeny() } }));
  }
  return out;
}

// A session works on its project, never on the studio: the service's own folder (its source, its pipelines' originals) is denied
// to every file tool and to any shell command that names it (2026-11-02, Dir2 d4fd: a takeover session read src/quickframes.mjs
// to copy the measured checks). The project's pipeline/ copy and the mfx commands on PATH are what a session uses.
export function serviceDeny(repo = REPO) {
  const dirs = [...new Set([repo, (() => { try { return realpathSync(repo); } catch { return repo; } })()])].map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));
  return dirs.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`, `Write(/${d}/**)`, `Bash(*${d}*)`]);
}

export function describeTool(name, input = {}) {
  if (name === 'Bash') return `$ ${String(input.command || '').split('\n')[0].slice(0, 200)}`;
  if (['Read', 'Write', 'Edit'].includes(name)) return `${name} ${input.file_path || ''}`;
  if (name === 'WebSearch') return `Search: ${input.query || ''}`;
  if (name === 'WebFetch') return `Fetch: ${input.url || ''}`;
  if (name === 'Skill') return `Skill: ${input.skill || input.name || ''}`;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}: ${mcp[2]}${input.path ? ` ${input.path}` : ''}`;
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
  // Installs shared by every project (e.g. the Kinetograph video template, via the remotion-motion skill's setup.mjs).
  const shared = join(root, 'run', 'shared');
  mkdirSync(shared, { recursive: true });
  a.push('--bind', shared, shared);
  a.push('--ro-bind', REPO, REPO);
  // The renderer: the studio's Kinetograph (on the session's PATH) and a local build the owner named with MFX_KINETOGRAPH.
  // (A cli.js is bound with its package folder, dist/..)
  const own = env.MFX_KINETOGRAPH && existsSync(env.MFX_KINETOGRAPH) ? (statSync(env.MFX_KINETOGRAPH).isDirectory() ? env.MFX_KINETOGRAPH : dirname(dirname(env.MFX_KINETOGRAPH))) : null;
  for (const k of [kgDir(root), own]) if (k && existsSync(k)) a.push('--ro-bind', k, k);
  // The Craft apps' programs (their MCP servers run inside the sandbox, with the session).
  if (existsSync(craftDir(root))) a.push('--ro-bind', craftDir(root), craftDir(root));
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
