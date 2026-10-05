#!/usr/bin/env node
// qc.mjs: the automated half of the final pass (the other half is you looking at the frame sheet).
//
//   node .claude/skills/final-pass/qc.mjs out/final.mp4 [--size 1920x1080] [--fps 30] [--duration 60]
//        [--lufs -14] [--true-peak -1] [--allow-black] [--end-hold] [--sheet checks/final-sheet.png] [--json checks/qc-final.json]
//
// --end-hold: a still stretch that runs to the very end is designed (a logo that settles and holds), not frozen.
//
// Checks: format (size, frame rate, codecs, duration), black frames, frozen stretches, integrated loudness and true
// peak. Writes a contact sheet (about one frame a second, at most 60) and a JSON report. Exits 1 if anything fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, extname } from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !isValue(a));
function isValue(a) { const i = args.indexOf(a); return i > 0 && args[i - 1].startsWith('--') && !['--allow-black', '--end-hold'].includes(args[i - 1]); }
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
if (!file) { console.error('usage: qc.mjs <video> [--size WxH] [--fps N] [--duration S] [--lufs -14] [--true-peak -1]'); process.exit(2); }

const stem = basename(file, extname(file));
const sheetPath = opt('sheet', `checks/${stem}-sheet.png`);
const jsonPath = opt('json', `checks/qc-${stem}.json`);
const checks = [];
const add = (id, ok, detail) => checks.push({ id, result: ok ? 'pass' : 'fail', detail });

// ---- format ----
const probe = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
if (probe.status !== 0) { console.error(`ffprobe failed: ${probe.stderr}`); process.exit(2); }
const info = JSON.parse(probe.stdout);
const video = info.streams.find((s) => s.codec_type === 'video');
const audio = info.streams.find((s) => s.codec_type === 'audio');
const duration = Number(info.format.duration);
const fps = video ? evalRate(video.avg_frame_rate) : 0;
const rFps = video ? evalRate(video.r_frame_rate) : 0;
if (video) {
  const want = opt('size');
  add('format.size', !want || want === `${video.width}x${video.height}`, `${video.width}x${video.height}${want ? ` (want ${want})` : ''}`);
  const wantFps = Number(opt('fps', 0));
  add('format.fps', (!wantFps || Math.abs(fps - wantFps) < 0.01) && Math.abs(fps - rFps) < 0.5, `${round(fps, 3)} fps${wantFps ? ` (want ${wantFps})` : ''}${Math.abs(fps - rFps) >= 0.5 ? ' · variable frame rate' : ''}`);
  add('format.codec', video.codec_name === 'h264' && (!audio || audio.codec_name === 'aac'), `${video.codec_name}${audio ? ` + ${audio.codec_name}` : ' (no audio)'} · ${video.pix_fmt}`);
  add('format.pixel', video.pix_fmt === 'yuv420p', `${video.pix_fmt} (yuv420p plays everywhere)`);
}
const wantDur = Number(opt('duration', 0));
add('format.duration', !wantDur || Math.abs(duration - wantDur) <= wantDur * 0.05, `${round(duration, 2)} s${wantDur ? ` (want ${wantDur} s ±5%)` : ''}`);

// ---- black and frozen frames (one decoding pass) ----
if (video) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.05:pix_th=0.10,freezedetect=n=0.001:d=1.5', '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const blacks = [...r.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const freezes = [...r.stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const freezeEnds = [...r.stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  // A fade from or to black at the very start or end is normal.
  const inside = blacks.filter(([a, b]) => a > 0.5 && b < duration - 0.5);
  add('frames.black', args.includes('--allow-black') || !inside.length, inside.length ? `black at ${inside.map(([a, b]) => `${round(a, 2)}–${round(b, 2)} s`).join(', ')}` : `none mid-video${blacks.length ? ` (${blacks.length} at the start/end)` : ''}`);
  const all = freezes.map((a, i) => [a, freezeEnds[i] ?? duration]);
  const atEnd = ([, b]) => b >= duration - 0.1;
  const stretches = args.includes('--end-hold') ? all.filter((s) => !atEnd(s)) : all;
  const hold = all.find(atEnd);
  add('frames.frozen', !stretches.length, stretches.length ? `no motion at ${stretches.map(([a, b]) => `${round(a, 1)}–${round(b, 1)} s`).join(', ')} (fine if it's a designed hold: say so)` : `none${hold && args.includes('--end-hold') ? ` (end hold ${round(duration - hold[0], 2)} s)` : ''}`);
}

// ---- loudness ----
if (audio) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1]);
  const wantI = Number(opt('lufs', -14));
  const wantPeak = Number(opt('true-peak', -1));
  add('audio.loudness', Number.isFinite(I) && Math.abs(I - wantI) <= 1, `${Number.isFinite(I) ? `${I} LUFS` : 'unmeasured'} (want ${wantI} ±1)`);
  add('audio.true-peak', Number.isFinite(peak) ? peak <= wantPeak : true, `${Number.isFinite(peak) ? `${peak} dBTP` : 'silent'} (want ≤ ${wantPeak})`);
}

// ---- the frame sheet ----
if (video && duration > 0) {
  const frames = Math.min(60, Math.max(1, Math.round(duration)));
  const cols = Math.min(6, frames);
  const rows = Math.ceil(frames / cols);
  mkdirSync(dirname(sheetPath), { recursive: true });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `fps=${frames / duration},scale=320:-2,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', '-update', '1', sheetPath], { encoding: 'utf8' });
  add('frames.sheet', r.status === 0, r.status === 0 ? `${sheetPath} (${frames} frames): look at it` : r.stderr.trim().slice(-300));
}

const failed = checks.filter((c) => c.result === 'fail');
const report = { file, duration: round(duration, 3), result: failed.length ? 'FAIL' : 'PASS', checks };
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
for (const c of checks) console.log(`${c.result === 'pass' ? 'PASS' : 'FAIL'}  ${c.id.padEnd(16)} ${c.detail}`);
console.log(`\n${report.result} (${jsonPath})`);
process.exit(failed.length ? 1 : 0);

function evalRate(r) { const [a, b] = String(r).split('/').map(Number); return b ? a / b : a; }
function round(v, d) { return Math.round(v * 10 ** d) / 10 ** d; }
