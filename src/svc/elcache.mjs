// Content-addressed cache of paid ElevenLabs audio, shared by every project of the studio (opt C4):
// <root>/cache/elevenlabs/<sha256(kind, prompt, seconds, model, influence)>.mp3. Checked before any paid call;
// a hit costs 0 credits and is shown as "from your library".
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const cacheKey = ({ kind, prompt, seconds, model, influence = null, instrumental = null }) =>
  createHash('sha256').update(JSON.stringify({ kind, prompt: String(prompt).trim(), seconds: Math.round(Number(seconds) * 1000) / 1000, model, influence, instrumental })).digest('hex');
export const cacheDir = (root) => join(root, 'cache', 'elevenlabs');
export const cachePath = (root, key) => join(cacheDir(root), `${key}.mp3`);
export const cacheHas = (root, key) => existsSync(cachePath(root, key));
export function cachePut(root, key, bytes) { mkdirSync(cacheDir(root), { recursive: true }); writeFileSync(cachePath(root, key), bytes); }
export function cacheCopy(root, key, to) { copyFileSync(cachePath(root, key), to); }
