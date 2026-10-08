import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as plat from '../src/platform.mjs';

// A pretend Windows machine: which files exist, and its environment.
const files = (...list) => { const set = new Set(list.map((f) => f.toLowerCase())); return (f) => set.has(f.toLowerCase()); };
const WIN_ENV = {
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs\\;"C:\\Program Files\\Git\\cmd"',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  ProgramFiles: 'C:\\Program Files',
};
const win = (exists, env = WIN_ENV) => ({ platform: 'win32', env, exists });

test('REPO_ROOT is the repository folder, from a file URL', () => {
  assert.ok(existsSync(join(plat.REPO_ROOT, 'package.json')));
  assert.ok(existsSync(join(plat.REPO_ROOT, 'src', 'platform.mjs')));
});

test('which on Windows: PATHEXT, quoted PATH entries, and npm\'s extensionless shell script is skipped', () => {
  const fs = files('C:\\Program Files\\nodejs\\npm', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(plat.which('npm', win(fs)), 'C:\\Program Files\\nodejs\\npm.cmd');
  assert.equal(plat.which('node', win(fs)), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(plat.which('git', win(fs)), 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(plat.which('ffmpeg', win(fs)), null);
  // Environment names are case-insensitive on Windows (PATH vs Path).
  assert.equal(plat.which('node', win(fs, { PATH: 'C:\\Program Files\\nodejs' })), 'C:\\Program Files\\nodejs\\node.exe');
});

test('which on Linux searches PATH with ":"', () => {
  const fs = files('/usr/bin/ffmpeg');
  assert.equal(plat.which('ffmpeg', { platform: 'linux', env: { PATH: '/bin:/usr/bin' }, exists: fs }), '/usr/bin/ffmpeg');
  assert.equal(plat.which('npm', { platform: 'linux', env: { PATH: '/bin:/usr/bin' }, exists: fs }), null);
});

test('command: .cmd programs go through cmd.exe, quoted; .exe and Linux run directly', () => {
  const fs = files('C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe');
  const npm = plat.command('npm', ['install', '--prefix', 'C:\\Users\\Ada Lovelace\\Mortiflix\\tools\\strudel'], win(fs));
  assert.equal(npm.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(npm.args, ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install --prefix "C:\\Users\\Ada Lovelace\\Mortiflix\\tools\\strudel""']);
  assert.equal(npm.options.windowsVerbatimArguments, true);
  const node = plat.command('node', ['-v'], win(fs));
  assert.deepEqual([node.file, node.args], ['C:\\Program Files\\nodejs\\node.exe', ['-v']]);
  assert.deepEqual(plat.command('npm', ['i'], { platform: 'linux' }), { file: 'npm', args: ['i'], options: {} });
});

test('cmdQuote: plain words stay bare, cmd metacharacters are quoted, " and % are refused', () => {
  assert.equal(plat.cmdQuote('--yes'), '--yes');
  assert.equal(plat.cmdQuote('a&b'), '"a&b"');
  assert.equal(plat.cmdQuote('chrome-headless-shell@stable'), 'chrome-headless-shell@stable');
  assert.equal(plat.cmdQuote(''), '""');
  assert.throws(() => plat.cmdQuote('say "hi"'), /contains " or %/);
  assert.throws(() => plat.cmdQuote('%PATH%'), /contains " or %/);
});

test('systemTar prefers Windows\' own tar.exe over whatever tar is first on the PATH', () => {
  assert.equal(plat.systemTar(win(files('C:\\Windows\\System32\\tar.exe'))), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(plat.systemTar(win(files())), 'tar');
  assert.equal(plat.systemTar({ platform: 'linux' }), 'tar');
});

test('findGitBash: Claude Code\'s setting, the usual folder, or next to git.exe', () => {
  const custom = 'D:\\Tools\\Git\\bin\\bash.exe';
  assert.equal(plat.findGitBash(win(files(custom), { ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: custom })), custom);
  assert.equal(plat.findGitBash(win(files('C:\\Program Files\\Git\\bin\\bash.exe'))), 'C:\\Program Files\\Git\\bin\\bash.exe');
  const scoop = { ...WIN_ENV, Path: 'C:\\Users\\a\\scoop\\apps\\git\\current\\cmd', ProgramFiles: 'C:\\Nowhere' };
  assert.equal(plat.findGitBash(win(files('C:\\Users\\a\\scoop\\apps\\git\\current\\cmd\\git.exe', 'C:\\Users\\a\\scoop\\apps\\git\\current\\bin\\bash.exe'), scoop)),
    'C:\\Users\\a\\scoop\\apps\\git\\current\\bin\\bash.exe');
  assert.equal(plat.findGitBash(win(files())), null);
});

test('openCommand per platform', () => {
  assert.equal(plat.openCommand('/a/b.png', { platform: 'linux' }).file, 'xdg-open');
  assert.equal(plat.openCommand('/a/b.png', { platform: 'darwin' }).file, 'open');
  const w = plat.openCommand('C:\\My Videos\\final.mp4', { platform: 'win32' });
  assert.deepEqual(w.args, ['/d', '/s', '/c', '"start "" "C:\\My Videos\\final.mp4""']);
});

test('pathDelimiter', () => {
  assert.equal(plat.pathDelimiter('win32'), ';');
  assert.equal(plat.pathDelimiter('linux'), ':');
});
