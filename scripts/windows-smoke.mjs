#!/usr/bin/env node
// The session half of Mortiflix on a real machine, end to end, with no model and no cost:
//
//   node scripts/windows-smoke.mjs            (SMOKE_REMOTION=1 also installs Remotion once, ~750 MB, to check its link)
//
// Written for Windows (CI's windows-latest, or your own PC); it runs on Linux and macOS too. It checks what tests
// can only simulate: the bridge on a named pipe, mfx from Git Bash and from cmd, the prompt reaching `claude` through
// claude.cmd, renders of .cmd programs, stopping a session's whole process tree, the API backend's Git Bash shell,
// Git Bash paths in its editor, secrets readable by you alone, and the Remotion template's link.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, lstatSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const studio = mkdtempSync(join(tmpdir(), 'mfx-smoke-'));
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// The real CLI, as a user would run it.
function mortiflix(args, { input, env } = {}) {
  const r = spawnSync(process.execPath, [join(REPO, 'bin', 'mortiflix'), '--studio', studio, ...args], { encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1', ...env } });
  if (r.status !== 0) throw new Error(`mortiflix ${args.join(' ')} exited ${r.status}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
const json = (args) => JSON.parse(mortiflix(args));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

console.log(`Mortiflix session smoke test on ${process.platform} (node ${process.version}), studio ${studio}\n`);
// What the studio itself needs (mortiflix doctor says the same): without them every later check fails confusingly.
for (const bin of ['ffmpeg', 'ffprobe']) {
  if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).status !== 0) {
    console.log(`FAIL  ${bin} isn't installed or isn't on the PATH: install it first (Windows: winget install Gyan.FFmpeg)`);
    rmSync(studio, { recursive: true, force: true });
    process.exit(1);
  }
}
mortiflix(['init', '--backend', 'demo', '--yes']);
const logo = join(studio, 'logo.svg');
writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');

// 1. The demo backend: every gate, through the real bridge (a named pipe on Windows).
check('demo project: brief to delivered through the bridge', () => {
  mortiflix(['new', 'logo-sting', '--title', 'Smoke demo', '--file', `logo=${logo}`, '--yes']);
  mortiflix(['run']);
  mortiflix(['respond', 'smoke-demo', 'directions', '--changes', '--note', '1@0.5,0.5: bigger']);
  mortiflix(['run']);
  must(json(['review', 'smoke-demo', '--json'])[0].reviews[0].pin_changes.length === 1, 'v2 did not answer the note');
  mortiflix(['respond', 'smoke-demo', 'directions', '--approve']);
  mortiflix(['run']);
  mortiflix(['respond', 'smoke-demo', 'final', '--approve']);
  const st = json(['status', 'smoke-demo', '--json']);
  must(st.state === 'delivered', `state is ${st.state}`);
  return `${st.deliverables.length} deliverable(s)`;
});

// 2. The claude-code backend with a stand-in claude (claude.cmd on Windows, like an npm install of Claude Code).
const fakeDir = join(studio, 'fake-claude');
mkdirSync(fakeDir);
const fake = join(REPO, 'scripts', 'windows-smoke', 'fake-claude.mjs');
const claudeBin = WIN ? join(fakeDir, 'claude.cmd') : join(fakeDir, 'claude');
writeFileSync(claudeBin, WIN ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
mortiflix(['config', 'claudeBin', claudeBin]);
let seen = null;
let pids = null;
check('claude-code session: started, prompt on stdin, mfx reachable', () => {
  mortiflix(['new', 'logo-sting', '--title', 'Smoke session', '--file', `logo=${logo}`, '--backend', 'claude-code', '--yes']);
  const before = Date.now();
  mortiflix(['run'], { env: { SMOKE_SLEEPER: join(REPO, 'scripts', 'windows-smoke', 'sleeper.mjs') } });
  const id = json(['list', '--json']).projects.find((p) => p.title === 'Smoke session').id;
  const f = join(studio, 'projects', id, '.smoke', 'seen.json');
  must(existsSync(f), `the session never ran (no ${f})\n${JSON.stringify(json(['status', id, '--json']).log.slice(-5), null, 2)}`);
  seen = JSON.parse(readFileSync(f, 'utf8'));
  const p = join(studio, 'projects', id, '.smoke', 'sleeper-pids.json');
  pids = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  must(/Read \.\/CLAUDE\.md fully/.test(seen.prompt), `prompt was ${JSON.stringify(seen.prompt.slice(0, 120))}`);
  must(!seen.argv.some((a) => /CLAUDE\.md/.test(a)), 'the prompt was also passed as an argument');
  const st = json(['status', id, '--json']);
  must(st.state === 'paused' && /smoke test/.test(st.needs_you || ''), `after the session: ${st.state}, ${st.needs_you}`);
  must(seen.mfx_socket && (WIN ? seen.mfx_socket.startsWith('\\\\.\\pipe\\') : seen.mfx_socket.endsWith('.sock')), `MFX_SOCKET is ${seen.mfx_socket}`);
  return `${Math.round((Date.now() - before) / 1000)} s, MFX_SOCKET ${seen.mfx_socket}`;
});
check('mfx from Claude Code\'s bash (Git Bash on Windows)', () => {
  must(seen, 'no session');
  if (WIN) must(seen.git_bash && /bash\.exe$/i.test(seen.git_bash), `CLAUDE_CODE_GIT_BASH_PATH is ${seen.git_bash}`);
  must(seen.bash_status_list.code === 0 && /"directions":/.test(seen.bash_status_list.out), `mfx status --list: ${JSON.stringify(seen.bash_status_list)}`);
  must(seen.bash_checks.code === 0, `mfx checks: ${JSON.stringify(seen.bash_checks)}`);
  return seen.git_bash || 'bash';
});
if (WIN) {
  check('mfx from cmd and PowerShell (mfx.cmd)', () => {
    must(seen?.cmd_status_list?.code === 0 && /"directions":/.test(seen.cmd_status_list.out), `cmd /c mfx status --list: ${JSON.stringify(seen?.cmd_status_list)}`);
    must(seen?.powershell_status_list?.code === 0 && /"directions":/.test(seen.powershell_status_list.out), `powershell mfx status --list: ${JSON.stringify(seen?.powershell_status_list)}`);
  });
}
check('a render of a .cmd program (npx) through the render queue', () => {
  must(seen, 'no session');
  must(seen.render_wait.code === 0 && /"state":\s*"done"/.test(seen.render_wait.out), `render-wait: ${seen.render_wait.out.slice(0, 600)}`);
});
check('ending a session stops its renders, children included', () => {
  must(pids, `the sleeper render never started: ${JSON.stringify(seen?.sleeper)}`);
  const left = [pids.parent, pids.child].filter(alive);
  must(!left.length, `still running after the session ended: ${left.join(', ')}`);
  return `stopped ${pids.parent} and its child ${pids.child}`;
});

// 3. The API backend's shell and editor (no API call: the pieces it runs locally).
const { Shell, confine } = await import(pathToFileURL(join(REPO, 'src', 'backends', 'anthropic-api.mjs')));
const platform = await import(pathToFileURL(join(REPO, 'src', 'platform.mjs')));
const { withPath } = platform;
{
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'mfx-shell-')));
  const shell = new Shell(work, withPath(process.env, join(REPO, 'bin')));
  const r = await shell.run('echo $((40+2)); command -v mfx; pwd');
  shell.close();
  check('anthropic-api shell: Git Bash, mfx on its PATH', () => {
    must(r.code === 0 && /^42$/m.test(r.output), `output: ${r.output}`);
    must(/mfx/.test(r.output), `mfx not found: ${r.output}`);
    return r.output.trim().split('\n').at(-1);
  });
  check('anthropic-api editor: a Git Bash path inside the project is allowed, outside is refused', () => {
    writeFileSync(join(work, 'a.txt'), 'x');
    const bashPath = r.output.trim().split('\n').at(-1); // pwd, as the shell sees it (/c/Users/... on Windows)
    must(confine(work, `${bashPath}/a.txt`) === join(work, 'a.txt'), `confine(${bashPath}/a.txt) = ${confine(work, `${bashPath}/a.txt`)}`);
    let refused = false;
    try { confine(work, WIN ? '/c/Windows/win.ini' : '/etc/hostname'); } catch { refused = true; }
    must(refused, 'a path outside the project was allowed');
  });
  rmSync(work, { recursive: true, force: true });
}

// 4. Secrets.
check('session.env is readable by you alone', () => {
  mortiflix(['keys', 'set', 'SMOKE_KEY'], { input: 'not-a-real-key\n' });
  const f = join(studio, 'session.env');
  if (!WIN) { must((lstatSync(f).mode & 0o777) === 0o600, `mode ${(lstatSync(f).mode & 0o777).toString(8)}`); return 'mode 600'; }
  const acl = spawnSync('icacls', [f], { encoding: 'utf8' }).stdout;
  const entries = acl.split('\n').map((l) => l.replace(f, '').trim()).filter((l) => /:\(/.test(l));
  // Windows always keeps SYSTEM and the Administrators group. Besides them: you, and nothing inherited.
  const others = entries.filter((e) => !/^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators):/i.test(e));
  const me = (e) => e.split(':(')[0].split('\\').at(-1).toLowerCase() === String(process.env.USERNAME).toLowerCase();
  must(others.length === 1 && me(others[0]), `expected only you besides SYSTEM and Administrators:\n${acl}`);
  must(!entries.some((e) => e.includes('(I)')), `inherited entries are left:\n${acl}`);
  return entries.join(', ');
});

// 5. The Remotion template's link to the studio's shared install (heavy: opt in).
let remotionProject = null;
if (process.env.SMOKE_REMOTION) {
  check('Remotion setup: one shared install, linked without admin rights (a junction on Windows)', () => {
    const project = mkdtempSync(join(tmpdir(), 'mfx-remotion-'));
    const shared = join(studio, 'run', 'shared');
    mkdirSync(shared, { recursive: true });
    const r = spawnSync(process.execPath, [join(REPO, 'pipelines', '_shared', 'skills', 'remotion-motion', 'setup.mjs'), 'video'], { cwd: project, encoding: 'utf8', env: { ...process.env, MFX_SHARED: shared } });
    must(r.status === 0, `setup.mjs exited ${r.status}\n${r.stdout}${r.stderr}`.slice(-2000));
    const modules = join(project, 'video', 'node_modules');
    must(lstatSync(modules).isSymbolicLink(), 'video/node_modules is not a link');
    must(existsSync(join(modules, 'remotion', 'package.json')), 'remotion is not reachable through the link');
    const again = spawnSync(process.execPath, [join(REPO, 'pipelines', '_shared', 'skills', 'remotion-motion', 'setup.mjs'), 'video'], { cwd: project, encoding: 'utf8', env: { ...process.env, MFX_SHARED: shared } });
    must(again.status === 0 && /already there/.test(again.stdout), `second run: ${again.stdout}${again.stderr}`);
    remotionProject = join(project, 'video');
    return realpathSync(modules);
  });
  // A real clip from the template, launched the way the render queue launches it (npx is npx.cmd on Windows).
  check('Remotion renders the template: 15 frames to an mp4', () => {
    must(remotionProject, 'no Remotion project');
    const { command } = platform;
    const out = join(remotionProject, 'out', 'smoke.mp4');
    const c = command('npx', ['remotion', 'render', 'src/index.ts', 'Main', out, '--frames=0-14']);
    const r = spawnSync(c.file, c.args, { ...c.options, cwd: remotionProject, encoding: 'utf8', maxBuffer: 64 << 20 });
    must(r.status === 0 && existsSync(out), `remotion render exited ${r.status}\n${`${r.stdout}${r.stderr}`.slice(-2000)}`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    must(parseInt(probe.stdout, 10) === 15, `the clip has ${String(probe.stdout).trim()} frames`); // some builds print "15,"
    return `${out}, 15 frames`;
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
rmSync(studio, { recursive: true, force: true, maxRetries: 5 });
process.exit(failed.length ? 1 : 0);
