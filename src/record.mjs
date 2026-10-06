// The recording booth in a terminal: `mortiflix record <project>`. Same booth as the web studio (src/booth.mjs),
// so takes made here and there are interchangeable. ffmpeg records from the system's default microphone:
//   Linux    PulseAudio / PipeWire (-f pulse), else ALSA
//   macOS    AVFoundation (-f avfoundation, device :0 unless --device)
//   Windows  DirectShow (-f dshow, needs --device "audio=<name>"; --list-devices shows the names)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import * as booth from './booth.mjs';

const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;

/** ffmpeg input arguments for a platform. `device` overrides: "pulse:<source>", "alsa:hw:1", ":1" (macOS), "audio=Mic" (Windows). */
export function captureInput(platform = process.platform, device = null) {
  if (device) {
    const m = /^(pulse|alsa|avfoundation|dshow):(.+)$/.exec(device);
    if (m) return ['-f', m[1], '-i', m[2]];
    if (platform === 'darwin') return ['-f', 'avfoundation', '-i', device.startsWith(':') ? device : `:${device}`];
    if (platform === 'win32') return ['-f', 'dshow', '-i', device.startsWith('audio=') ? device : `audio=${device}`];
    return ['-f', 'pulse', '-i', device];
  }
  if (platform === 'darwin') return ['-f', 'avfoundation', '-i', ':0'];
  if (platform === 'win32') return null; // DirectShow needs a device name
  return ['-f', 'pulse', '-i', 'default'];
}

/** The command that lists microphones on this platform. */
export function listDevicesArgs(platform = process.platform) {
  if (platform === 'darwin') return ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  if (platform === 'win32') return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  return null; // Linux: `pactl list short sources` (PipeWire/Pulse) or `arecord -l` (ALSA)
}

/** Plays a WAV with whatever this machine has. */
function playFile(file) {
  const players = [['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]], ['afplay', [file]], ['paplay', [file]], ['aplay', ['-q', file]]];
  for (const [bin, args] of players) {
    const r = spawnSync(bin, args, { stdio: 'ignore' });
    if (!r.error) return true;
  }
  return false;
}

/** Starts recording; returns stop(), which resolves with the WAV once ffmpeg has finished (after a short post-roll). */
function startCapture(input, file) {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const done = new Promise((ok, fail) => {
    ff.on('error', fail);
    ff.on('close', (code) => (code === 0 || code === 255 ? ok() : fail(new Error(`ffmpeg could not record (${err.trim().split('\n').pop() || `exit ${code}`}). Try --device, or mortiflix record --list-devices.`))));
  });
  return {
    stop: async () => {
      await new Promise((r) => setTimeout(r, 400)); // post-roll: keep the end of the last word
      ff.stdin.write('q');
      ff.stdin.end();
      await done;
      return readFileSync(file);
    },
    failed: done,
  };
}

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, acc: (s) => `\x1b[35m${s}\x1b[0m`,
};

/** The interactive terminal booth. Resolves with the booth status when the owner quits or finishes. */
export async function terminalBooth(root, id, { device = null, out = process.stdout, input = process.stdin } = {}) {
  if (!input.isTTY) throw new Error('the terminal booth needs an interactive terminal (or use --import <folder>)');
  if (!has('ffmpeg')) throw new Error('recording needs ffmpeg (https://ffmpeg.org/download.html)');
  const inArgs = captureInput(process.platform, device);
  if (!inArgs) throw new Error('on Windows, pass the microphone: --device "audio=<name>" (mortiflix record --list-devices)');
  let st = booth.boothStatus(root, id);
  if (!st.lines) throw new Error('this project has no script to record yet (the studio writes voice/lines.json first)');

  const tmp = mkdtempSync(join(tmpdir(), 'mfx-rec-'));
  const say = (s = '') => out.write(`${s}\n`);
  let idx = Math.max(0, st.lines.findIndex((l) => st.missing.includes(l.id)));
  let capture = null;
  let busy = false;

  const takesFor = (lineId) => st.takes.filter((t) => t.line_id === lineId);
  const show = () => {
    const l = st.lines[idx];
    const takes = takesFor(l.id);
    say(`\n${C.b(`Line ${idx + 1} of ${st.lines.length}`)}  ${C.dim(`${st.kept} kept`)}${l.direction ? `  ${C.acc(`[${l.direction}]`)}` : ''}  ${C.dim(`about ${l.est_seconds} s`)}`);
    if (st.lines[idx - 1]) say(C.dim(`  ${st.lines[idx - 1].script}`));
    say(`  ${C.b(l.script)}`);
    if (st.lines[idx + 1]) say(C.dim(`  ${st.lines[idx + 1].script}`));
    if (takes.length) say(`  takes: ${takes.map((t) => `${t.take_no}${t.kept ? '✓' : ''} (${(t.duration_ms / 1000).toFixed(1)} s)`).join('  ')}`);
    say(C.dim('  [Enter] record / stop   [p] play last take   [k] keep last take   [1-9] play that take   [n] next   [b] back   [q] quit'));
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  show();
  try {
    await new Promise((resolve) => {
      input.on('keypress', async (str, key) => {
        if (busy) return;
        const l = st.lines[idx];
        const last = takesFor(l.id).at(-1);
        try {
          busy = true;
          if (key?.ctrl && key.name === 'c') return resolve();
          if (key?.name === 'return') {
            if (!capture) {
              capture = startCapture(inArgs, join(tmp, 'take.wav'));
              capture.failed.catch((e) => { say(C.red(e.message)); capture = null; });
              say(C.red('  ● recording… press Enter to stop'));
            } else {
              const wav = await capture.stop();
              capture = null;
              const t = booth.addTake(root, id, l.id, wav, { source: 'terminal' });
              st = booth.boothStatus(root, id);
              say(`  take ${t.take_no}: ${(t.duration_ms / 1000).toFixed(1)} s, peak ${t.peak_db} dB${t.flags.length ? C.red(`  · ${booth.FLAG_ADVICE[t.flags[0]]}`) : ''}`);
              if (!playFile(booth.takeFile(root, id, l.id, t.take_no))) say(C.dim('  (no audio player found to play it back: install ffmpeg\'s ffplay)'));
              say(C.dim('  [k] keep it   [Enter] try again   [p] play it again'));
            }
          } else if (capture) {
            // While recording, only Enter (stop) does anything.
          } else if (str === 'p' && last) playFile(booth.takeFile(root, id, l.id, last.take_no));
          else if (/^[1-9]$/.test(str || '') && takesFor(l.id)[Number(str) - 1]) playFile(booth.takeFile(root, id, l.id, Number(str)));
          else if (str === 'k' && last) {
            booth.keepTake(root, id, l.id, last.take_no);
            st = booth.boothStatus(root, id);
            say(C.green(`  ✔ kept take ${last.take_no}`));
            if (!st.missing.length) return resolve();
            const next = st.lines.findIndex((x, i) => i > idx && st.missing.includes(x.id));
            idx = next !== -1 ? next : st.lines.findIndex((x) => st.missing.includes(x.id));
            show();
          } else if (str === 'n') { idx = Math.min(st.lines.length - 1, idx + 1); show(); }
          else if (str === 'b') { idx = Math.max(0, idx - 1); show(); }
          else if (str === 'q') return resolve();
        } catch (e) {
          say(C.red(`  ${e.message}`));
        } finally {
          busy = false;
        }
      });
    });
  } finally {
    if (capture) await capture.stop().catch(() => {});
    input.setRawMode(false);
    input.pause();
    input.removeAllListeners('keypress');
    rmSync(tmp, { recursive: true, force: true });
  }
  return booth.boothStatus(root, id);
}
