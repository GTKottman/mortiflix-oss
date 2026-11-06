// Session-side ElevenLabs spend, for the scripts a Claude session runs (pipelines/_shared/skills/voiceover/vo.mjs, sound.mjs):
// they append one row to the studio's usage ledger themselves (src/svc/ledger.mjs reads it like any other row).
// Imports nothing from the studio: only node. The ledger file comes from MFX_LEDGER, else from the working folder
// (<studio>/projects/<id>); the project from MFX_PROJECT, else the same folder. Never throws: the work still counts.
import { appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const STAGE = { tts: 'voice', 'scribe check': 'voice', sfx: 'sound', music: 'music' };

/** Book one ElevenLabs spend. `credits` from the response's `character-cost` header when it has one; otherwise the
 *  caller's estimate with `estimated: true`, or 0 with `credits_unknown: true`. */
export function bookSpend({ kind, model = null, credits = null, estimated = false, seconds = null, ok = true, cwd = process.cwd(), env = process.env } = {}) {
  try {
    const inStudio = basename(dirname(cwd)) === 'projects';
    const file = env.MFX_LEDGER || (inStudio ? join(dirname(dirname(cwd)), 'state', 'usage-ledger.jsonl') : null);
    if (!file || !existsSync(dirname(file))) return false;
    const project = env.MFX_PROJECT || (inStudio ? basename(cwd) : null);
    const known = Number.isFinite(Number(credits)) && credits !== null && credits !== '';
    appendFileSync(file, `${JSON.stringify({
      id: `el:${Date.now().toString(36)}:${randomBytes(4).toString('hex')}`,
      at: new Date().toISOString(), project: project && /^[a-z0-9][a-z0-9-]{2,80}$/.test(project) ? project : null,
      stage: STAGE[kind] || null, provider: 'elevenlabs', kind, model, credits: known ? Number(credits) : 0,
      ...(known && estimated ? { estimated: true } : {}), ...(!known ? { credits_unknown: true } : {}), ...(seconds ? { seconds: Number(seconds) } : {}), ok,
    })}\n`);
    return true;
  } catch { return false; }
}

/** The header ElevenLabs sends with a paid response: credits charged. */
export const costHeader = (res) => { const v = Number(res?.headers?.get?.('character-cost')); return Number.isFinite(v) && v > 0 ? v : null; };
