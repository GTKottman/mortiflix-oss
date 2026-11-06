// How many sessions run at once, across projects (still one per project). Owner, 2026-11-02: "If you have the space,
// use it" (Dir1 and Dir2 sat queued while 61dc's Look ran). config.json `sessions.parallel`: a number, or "auto"
// (default) = min(4, floor(0.7 x available RAM / the measured peak of one session)), starting from SEED_PEAK until a
// session has been measured. An extra session never starts with under MIN_AVAILABLE free; the first one always may
// (the studio would otherwise stall). The same pattern as renders.parallel (src/renderq.mjs).
import { freemem } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const GB = 1024 ** 3;
export const SEED_PEAK = 1.5 * GB;
export const MIN_AVAILABLE = 4 * GB;
export const MAX_AUTO = 4;
const MIN_PEAK = 0.25 * GB; // a smaller measured peak is not trusted
const KEEP = 8;

export function sessionSlots({ setting = 'auto', available = freemem(), peak = SEED_PEAK } = {}) {
  const n = Number(setting);
  if (setting !== 'auto' && Number.isInteger(n) && n > 0) return n;
  return Math.max(1, Math.min(MAX_AUTO, Math.floor((0.7 * available) / Math.max(MIN_PEAK, peak))));
}

// May one more session start now, with `running` running? null = yes, else why not ('slot' | 'memory').
export function mayStartSession({ running, setting = 'auto', available = freemem(), peak = SEED_PEAK }) {
  if (running === 0) return null;
  if (running >= sessionSlots({ setting, available, peak })) return 'slot';
  if (available < MIN_AVAILABLE) return 'memory';
  return null;
}

// Measured peaks (bytes) of past sessions: the highest of the last few counts.
export function loadPeak(file) {
  try { const l = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(l) && l.length ? Math.max(...l) : SEED_PEAK; } catch { return SEED_PEAK; }
}
export function recordPeak(file, bytes) {
  if (!(bytes >= MIN_PEAK)) return;
  let l = [];
  try { l = JSON.parse(readFileSync(file, 'utf8')); if (!Array.isArray(l)) l = []; } catch { /* first */ }
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify([...l, Math.round(bytes)].slice(-KEEP))); } catch { /* kept nowhere: the seed stays */ }
}
