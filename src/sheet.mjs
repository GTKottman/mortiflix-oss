// One contact sheet of any number of images (ffmpeg tile, JPEG q85, 1280 px wide by default). Everything that shows images
// to an AI uses this: one small sheet read once instead of a full-size PNG each (a 1920x1080 PNG costs about 3.1k tokens
// and is carried through every later call; a 1280-wide sheet of four frames costs about as much as one of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PAD = 8;

// sheetFor(files, dest, { width: 1280, cols }) -> true when dest was written. cols defaults to the files' count up to 3, else 2.
export function sheetFor(files, dest, { width = 1280, cols } = {}) {
  if (!files?.length) return false;
  const n = files.length;
  const c = Math.max(1, Math.min(n, cols || (n <= 3 ? n : 2)));
  const rows = Math.ceil(n / c);
  const tw = Math.floor((width - PAD * (c + 1)) / c / 2) * 2;
  const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', files[0]], { encoding: 'utf8' });
  const [w0, h0] = String(p.stdout || '').trim().split(',').map(Number);
  const th = w0 && h0 ? Math.round((tw * h0) / w0 / 2) * 2 : Math.round((tw * 9) / 16 / 2) * 2;
  mkdirSync(dirname(dest), { recursive: true });
  const scale = (i) => `[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=0x303030[v${i}]`;
  const layout = files.map((_, i) => `${PAD + (i % c) * (tw + PAD)}_${PAD + Math.floor(i / c) * (th + PAD)}`).join('|');
  const stack = n === 1 ? '[v0]null[s]' : `${files.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=0x303030[s]`;
  const fc = `${files.map((_, i) => scale(i)).join(';')};${stack};[s]pad=${PAD + c * (tw + PAD)}:${PAD + rows * (th + PAD)}:0:0:color=0x303030`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', fc, '-frames:v', '1', '-q:v', '3', dest], { encoding: 'utf8' });
  return r.status === 0 && existsSync(dest);
}
