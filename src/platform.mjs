// The few things that differ between Linux, macOS and Windows, in one place, so the rest of the code doesn't guess.
// Every function takes the platform and environment as options, so tests can ask "what would Windows do?" on Linux.
//
//   which(bin)        a program on the PATH, found without spawning a shell (Windows: tries PATHEXT, e.g. npm.cmd)
//   command(cmd, args) what to spawn: Windows can't spawn npm.cmd/npx.cmd directly (Node refuses .cmd/.bat without a
//                     shell since 20.12), so those go through cmd.exe with their arguments quoted for it
//   systemTar()       Windows' own tar.exe (bsdtar: unpacks .tar.gz and .zip). Git for Windows' GNU tar reads
//                     "C:\..." as a remote host, so it must not be the one found first on the PATH
//   findGitBash()     Git for Windows' bash.exe: Claude Code's Bash tool and the sessions' shell commands need it
//   openCommand(file) how to open a file in its default app
import { existsSync } from 'node:fs';
import { delimiter as hostDelimiter, dirname, join, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository's folder (works on Windows, where a file URL's pathname is "/C:/...").
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pathFor = (platform) => (platform === 'win32' ? win32 : posix);
const envGet = (env, name) => env[name] ?? env[Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())];

export function which(bin, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const p = pathFor(platform);
  const exts = platform === 'win32' ? ['', ...String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  // On Windows a bare name with no extension (npm's shell script for Git Bash) can't be spawned: skip it.
  const usable = (f) => exists(f) && (platform !== 'win32' || /\.[a-z0-9]+$/i.test(f));
  if (/[\\/]/.test(bin)) return exts.map((e) => bin + e).find(usable) || null;
  for (const dir of String(envGet(env, 'PATH') || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const e of exts) {
      const f = p.join(dir.replace(/^"(.*)"$/, '$1'), bin + e);
      if (usable(f)) return f;
    }
  }
  return null;
}

// cmd.exe quoting for one argument. Inside quotes, cmd only treats " and % specially; neither can be escaped
// reliably for a batch file's %*, so arguments carrying them are refused instead of being passed on mangled.
export function cmdQuote(arg) {
  const s = String(arg);
  if (/["%\r\n]/.test(s)) throw new Error(`can't pass ${JSON.stringify(s)} to a .cmd program: it contains " or %`);
  return s && !/[\s&()<>^|,;=!']/.test(s) ? s : `"${s}"`;
}

// What to spawn for `cmd args`: { file, args, options }. Pass `options` on to spawn/spawnSync.
export function command(cmd, args = [], { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return { file: cmd, args, options: {} };
  const found = which(cmd, { platform, env, exists }) || cmd;
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args, options: { windowsHide: true } };
  const line = [found, ...args].map(cmdQuote).join(' ');
  return { file: envGet(env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true, windowsHide: true } };
}

export function systemTar({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return 'tar';
  const own = win32.join(envGet(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'tar.exe');
  return exists(own) ? own : 'tar';
}

// Where Git for Windows keeps bash.exe: Claude Code's own setting first, then the usual install folders, then
// next to whichever git.exe is on the PATH (…\Git\cmd\git.exe → …\Git\bin\bash.exe).
export function findGitBash({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return which('bash', { platform, env, exists });
  const set = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  const places = [set];
  for (const base of [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)'), envGet(env, 'ProgramW6432')]) if (base) places.push(win32.join(base, 'Git', 'bin', 'bash.exe'));
  const local = envGet(env, 'LOCALAPPDATA');
  if (local) places.push(win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'));
  const git = which('git', { platform, env, exists });
  if (git) places.push(win32.join(win32.dirname(win32.dirname(git)), 'bin', 'bash.exe'));
  return places.filter(Boolean).find((f) => exists(f)) || null;
}

// The separator between PATH entries, for code that builds a session's PATH.
export const pathDelimiter = (platform = process.platform) => (platform === process.platform ? hostDelimiter : platform === 'win32' ? ';' : ':');

export function openCommand(file, { platform = process.platform } = {}) {
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"start "" ${cmdQuote(file)}"`], options: { windowsVerbatimArguments: true, windowsHide: true } };
  if (platform === 'darwin') return { file: 'open', args: [file], options: {} };
  return { file: 'xdg-open', args: [file], options: {} };
}
