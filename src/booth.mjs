// The recording booth: the owner narrates a project's script in their own voice, one line at a time.
// The session writes the script as voice/lines.json (the same file the AI voices read). Every take is kept on disk;
// the take the owner keeps for a line becomes voice/clips/<line>.wav, exactly where vo.mjs puts a generated line,
// so `vo.mjs build` makes the voice track the same way whichever voice spoke it.
//
// Three ways in, all through this module: the web booth (`mortiflix serve`), the terminal booth
// (`mortiflix record <project>`), and importing files recorded elsewhere (`mortiflix record <project> --import <dir>`).
//
//   projects/<id>/voice/lines.json            the script, from the session
//   projects/<id>/voice/takes/<line>-<n>.wav  every take
//   projects/<id>/voice/takes/takes.json      what each take measured, and which one is kept
//   projects/<id>/voice/clips/<line>.wav      the kept take (+ <line>.json, the same report shape vo.mjs writes)
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson, withLock, UserError } from './studio.mjs';
import { projectPaths } from './projects.mjs';

export const MAX_TAKE_BYTES = 60 * 1024 * 1024; // ~10 minutes of 48 kHz 16-bit mono
const LINE_ID = /^[A-Za-z0-9-]{1,40}$/;

export function boothPaths(root, id) {
  const voice = join(projectPaths(root, id).work, 'voice');
  return { voice, lines: join(voice, 'lines.json'), takes: join(voice, 'takes'), index: join(voice, 'takes', 'takes.json'), clips: join(voice, 'clips'), lock: join(voice, '.booth-lock') };
}

// The words as they should be heard: audio tags and IPA out (the same rule vo.mjs uses).
export const heard = (l) => String(l.script || l.text || '').replace(/\[[^\]]*\]/g, ' ').replace(/"?\/[^/\s][^/]*\/"?/g, ' ').replace(/\s+/g, ' ').trim();
// Delivery notes for the reader: the [tags] at the start of the line, if any.
const direction = (l) => [...String(l.text || '').matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).join(', ') || null;
// About 2.6 words a second is an unhurried narration pace.
const estSeconds = (s) => Math.max(1, Math.round((s.split(/\s+/).filter(Boolean).length / 2.6) * 10) / 10);

/** The script as the booth shows it, or null when the session hasn't written one yet. */
export function readLines(root, id) {
  const bp = boothPaths(root, id);
  if (!existsSync(bp.lines)) return null;
  let list;
  try { list = JSON.parse(readFileSync(bp.lines, 'utf8')); } catch { throw new UserError('voice/lines.json is not valid JSON'); }
  if (!Array.isArray(list)) throw new UserError('voice/lines.json must be a list of lines');
  return list
    .filter((l) => LINE_ID.test(l?.id || '') && heard(l))
    .map((l) => {
      const script = heard(l);
      return { id: l.id, script, direction: direction(l), est_seconds: estSeconds(script), gap_after: l.gap_after ?? null };
    });
}

function readIndex(bp) {
  return existsSync(bp.index) ? readJson(bp.index) : [];
}

/** Lines, every take, and which lines still have no kept take. */
export function boothStatus(root, id) {
  const bp = boothPaths(root, id);
  const lines = readLines(root, id);
  const takes = readIndex(bp);
  if (!lines) return { lines: null, takes, kept: 0, missing: [] };
  // A kept take counts only while its line still reads the same: if the session rewrote the line, record it again.
  const script = new Map(lines.map((l) => [l.id, l.script]));
  const kept = new Set(takes.filter((t) => t.kept && (t.script === undefined || t.script === script.get(t.line_id))).map((t) => t.line_id));
  return { lines, takes, kept: lines.filter((l) => kept.has(l.id)).length, missing: lines.filter((l) => !kept.has(l.id)).map((l) => l.id) };
}

// ------------------------------------------------------------------------------------------------ WAV

/** Reads a PCM WAV (16/24/32-bit integer or 32-bit float, any rate, mono or stereo) and measures it. */
export function wavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new UserError('not a WAV file');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const tag = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (tag === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (tag === 'data') { data = { start: body, end: Math.min(buf.length, body + size) }; break; }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new UserError('WAV is missing its format or data');
  const pcm = fmt.format === 1 || fmt.format === 0xfffe;
  const float = fmt.format === 3;
  if (!(pcm && [16, 24, 32].includes(fmt.bits)) && !(float && fmt.bits === 32)) throw new UserError('WAV must be PCM (16/24/32-bit) or 32-bit float');
  if (fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000 || fmt.rate > 192000) throw new UserError('WAV must be mono or stereo, 8–192 kHz');
  const bytes = fmt.bits / 8;
  const frame = bytes * fmt.channels;
  const frames = Math.floor((data.end - data.start) / frame);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    const o = data.start + i * frame; // first channel is enough to judge levels
    const v = float ? buf.readFloatLE(o) : bytes === 2 ? buf.readInt16LE(o) / 32768 : bytes === 3 ? buf.readIntLE(o, 3) / 8388608 : buf.readInt32LE(o) / 2147483648;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);
  return { rate: fmt.rate, channels: fmt.channels, duration_ms: Math.round((frames / fmt.rate) * 1000), peak_db: db(peak), rms_db: db(Math.sqrt(sum / Math.max(1, frames))) };
}

/** The booth's take checks, worded for the reader. */
export function takeFlags(info, line) {
  const flags = [];
  if (info.peak_db > -0.5) flags.push('clipped');
  if (info.peak_db < -28) flags.push('quiet');
  const s = info.duration_ms / 1000;
  if (line?.est_seconds && s < line.est_seconds * 0.5) flags.push('short');
  if (line?.est_seconds && s > line.est_seconds * 2 + 1.5) flags.push('long');
  return flags;
}

export const FLAG_ADVICE = {
  clipped: 'it hit the top: move back a little or speak a touch softer',
  quiet: 'it is very quiet: move closer to the microphone',
  short: 'it seems short for this line: check it has every word',
  long: 'it runs long: a little quicker, or trim the pauses',
};

// ------------------------------------------------------------------------------------------------ takes

function lineFor(root, id, lineId) {
  if (!LINE_ID.test(lineId || '')) throw new UserError(`bad line id "${lineId}"`);
  const lines = readLines(root, id);
  if (!lines) throw new UserError('This project has no script to record yet (voice/lines.json).');
  const line = lines.find((l) => l.id === lineId);
  if (!line) throw new UserError(`no line "${lineId}" in voice/lines.json`);
  return line;
}

/** Saves a take (a WAV buffer) for a line. Returns the take record. */
export function addTake(root, id, lineId, wav, { source = 'booth' } = {}) {
  const line = lineFor(root, id, lineId);
  if (wav.length > MAX_TAKE_BYTES) throw new UserError('that take is too long (over 10 minutes)');
  const info = wavInfo(wav);
  if (info.duration_ms < 200) throw new UserError('that take is under a fifth of a second: hold the button while you speak');
  const bp = boothPaths(root, id);
  mkdirSync(bp.takes, { recursive: true });
  return withLock(bp.lock, () => {
    const takes = readIndex(bp);
    const take_no = takes.filter((t) => t.line_id === lineId).reduce((n, t) => Math.max(n, t.take_no), 0) + 1;
    const file = `${lineId}-${take_no}.wav`;
    writeFileSync(join(bp.takes, file), wav);
    const take = { line_id: lineId, take_no, file, ...info, flags: takeFlags(info, line), source, kept: false, at: new Date().toISOString() };
    takes.push(take);
    writeJson(bp.index, takes);
    return take;
  });
}

/** Keeps one take for its line: it becomes voice/clips/<line>.wav for vo.mjs build. */
export function keepTake(root, id, lineId, takeNo) {
  const line = lineFor(root, id, lineId);
  const bp = boothPaths(root, id);
  return withLock(bp.lock, () => {
    const takes = readIndex(bp);
    const take = takes.find((t) => t.line_id === lineId && t.take_no === Number(takeNo));
    if (!take) throw new UserError(`no take ${takeNo} for line ${lineId}`);
    for (const t of takes) if (t.line_id === lineId) t.kept = t === take;
    take.script = line.script;
    writeJson(bp.index, takes);
    mkdirSync(bp.clips, { recursive: true });
    for (const ext of ['.mp3', '.wav', '.flac', '.opus']) rmSync(join(bp.clips, `${lineId}${ext}`), { force: true });
    copyFileSync(join(bp.takes, take.file), join(bp.clips, `${lineId}.wav`));
    // The same report shape vo.mjs writes for a generated line. No word timings: build times this line as a whole.
    writeJson(join(bp.clips, `${lineId}.json`), {
      id: lineId, engine: 'own voice', voice: 'the owner', script: line.script, take: take.take_no, seconds: take.duration_ms / 1000,
      pass: true, peak_db: take.peak_db, rms_db: take.rms_db, flags: take.flags, words: [], transcript: null,
    });
    return take;
  });
}

/** Absolute path of a take's audio, for playback. */
export function takeFile(root, id, lineId, takeNo) {
  const bp = boothPaths(root, id);
  const take = readIndex(bp).find((t) => t.line_id === lineId && t.take_no === Number(takeNo));
  if (!take) throw new UserError(`no take ${takeNo} for line ${lineId}`);
  return join(bp.takes, take.file);
}

// ------------------------------------------------------------------------------------------------ import

/**
 * Imports takes recorded elsewhere (a DAW, a phone): files named after the line ids (`b01-1.wav`, `b01-1.m4a`, …).
 * WAVs are read directly; other formats are converted with ffmpeg. Each imported file becomes a kept take.
 */
export function importFolder(root, id, dir) {
  if (!existsSync(dir)) throw new UserError(`no folder ${dir}`);
  const lines = readLines(root, id);
  if (!lines) throw new UserError('This project has no script to record yet (voice/lines.json).');
  const files = readdirSync(dir);
  const done = [];
  const skipped = [];
  for (const line of lines) {
    const f = files.find((n) => basename(n, extname(n)) === line.id && /\.(wav|mp3|m4a|flac|ogg|opus|aiff?)$/i.test(n));
    if (!f) { skipped.push(line.id); continue; }
    let wav;
    if (/\.wav$/i.test(f)) wav = readFileSync(join(dir, f));
    else {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, f), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: MAX_TAKE_BYTES });
      if (r.status !== 0) throw new UserError(`could not convert ${f} (is ffmpeg installed?)`);
      wav = r.stdout;
    }
    const take = addTake(root, id, line.id, wav, { source: 'import' });
    keepTake(root, id, line.id, take.take_no);
    done.push({ line: line.id, file: f, ...take });
  }
  return { imported: done, missing: skipped };
}
