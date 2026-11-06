// Runs one ffmpeg command for final.make, inside the render queue. The video is written to <final>.part.mp4 and only
// moved onto <final> when ffmpeg exits 0, so a cancelled or failed run never leaves a half file where the old video was.
// usage: node final-run.mjs <final.mp4> <ffmpeg args ... last arg = the .part.mp4 path>
import { spawn } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';

const [final, ...args] = process.argv.slice(2);
const part = args.at(-1);
const p = spawn('ffmpeg', ['-hide_banner', '-y', ...args], { stdio: 'inherit' });
p.on('error', (e) => { console.error(`ffmpeg did not start: ${e.message}`); process.exit(127); });
p.on('close', (code, sig) => {
  if (code === 0) { renameSync(part, final); process.exit(0); }
  try { rmSync(part, { force: true }); } catch { /* gone */ }
  process.exit(code ?? (sig ? 128 : 1));
});
