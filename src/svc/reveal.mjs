// files.reveal: show a studio file (or folder) in the computer's file manager. Only paths inside the studio are
// shown; the path is resolved through links first, so "../" or a link can't reach outside it.
// Linux opens the file's folder (xdg-open); Windows opens Explorer with the file selected; macOS Finder (open -R).
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isInside } from '../studio.mjs';

const badRequest = (message) => Object.assign(new Error(message), { code: 'bad_request' });

/** The command that shows `target` in the file manager. `isDir` = the target is itself a folder. */
export function revealCommand(target, { platform = process.platform, isDir = false } = {}) {
  if (platform === 'win32') {
    // Explorer wants `/select,"C:\a b\c.mp4"` as one verbatim argument; a folder is just opened.
    const arg = isDir ? `"${target}"` : `/select,"${target}"`;
    return { file: 'explorer.exe', args: [arg], options: { windowsVerbatimArguments: true, windowsHide: true } };
  }
  if (platform === 'darwin') return { file: 'open', args: isDir ? [target] : ['-R', target], options: {} };
  return { file: 'xdg-open', args: [isDir ? target : dirname(target)], options: {} };
}

/** Checks the path is inside the studio and shows it. Answers { revealed: <the real path>, folder }. */
export function revealPath(root, path, { platform = process.platform, run = launch } = {}) {
  const asked = String(path ?? '').trim();
  if (!asked) throw badRequest('files.reveal needs a path');
  let real;
  try {
    real = realpathSync(isAbsolute(asked) ? asked : join(root, asked));
  } catch {
    throw badRequest('That file is not there any more.');
  }
  const studio = realpathSync(resolve(root));
  if (!isInside(studio, real)) throw badRequest('Only files inside the studio can be shown.');
  const isDir = statSync(real).isDirectory();
  run(revealCommand(real, { platform, isDir }));
  return { revealed: real, folder: isDir ? real : dirname(real) };
}

// Starts the file manager without waiting for it (Explorer answers 1 even when it worked).
function launch({ file, args, options }) {
  const child = spawn(file, args, { ...options, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
