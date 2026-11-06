// What the voice used, per project (owner, 2026-10-19: "if the user is using ElevenLabs, ElevenLabs should be listed in
// this token usage … if they're using internal tools, then their usage for the internal tools and internal voice model
// should be shown here as well"). One row per recording in <work>/sound/voice/usage.jsonl:
//   ElevenLabs   { engine: 'elevenlabs', voice, model, line, characters }   (billed by characters)
//   this computer { engine: 'qwen', voice, model, lines, seconds }          (free: the time it took)
// A project voiced before the log existed counts its cached ElevenLabs takes once each.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { recordForWork, ttsCredits } from './svc/ledger.mjs';

const file = (work) => join(work, 'sound', 'voice', 'usage.jsonl');

export function logVoiceUse(work, row) {
  try {
    mkdirSync(join(work, 'sound', 'voice'), { recursive: true });
    // Booked first: the ledger's one-time backfill reads this log as it was before this row.
    if (row.engine === 'elevenlabs') recordForWork(work, { kind: 'tts', model: row.model, credits: Number(row.credits) || ttsCredits(row.model, row.characters), estimated: !Number(row.credits) });
    // the first row: the takes made before the log existed go in first, so they still count
    if (!existsSync(file(work))) {
      const before = cached(work).filter((r) => r.line !== row.line);
      if (before.length) appendFileSync(file(work), before.map((r) => `${JSON.stringify({ ...r, before_log: true })}\n`).join(''));
    }
    appendFileSync(file(work), `${JSON.stringify({ t: new Date().toISOString(), ...row })}\n`);
  } catch { /* the voice still counts: only the record is lost */ }
}

export function voiceRows(work) { return rows(work); }

function rows(work) {
  if (existsSync(file(work))) {
    return readFileSync(file(work), 'utf8').split('\n').slice(-20000).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
  return cached(work);
}

// The ElevenLabs takes in the cache, one row each (a project voiced before the log existed).
function cached(work) {
  const dir = join(work, 'sound', 'voice', 'lines');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, 5000).flatMap((f) => {
    try { const m = JSON.parse(readFileSync(join(dir, f), 'utf8')); return [{ engine: 'elevenlabs', voice: m.voice, model: m.model, line: m.id, characters: String(m.text || '').length }]; } catch { return []; }
  });
}

// One entry per engine + voice + model: characters (ElevenLabs), lines, recordings, seconds (this computer), last use.
export function voiceUsage(work) {
  const by = new Map();
  for (const r of rows(work)) {
    if (!['elevenlabs', 'qwen'].includes(r.engine)) continue;
    const k = `${r.engine}|${r.voice || ''}|${r.model || ''}`;
    const u = by.get(k) || { engine: r.engine, voice: r.voice || null, model: r.model || null, characters: 0, lines: new Set(), recordings: 0, seconds: 0, last: null };
    u.characters += Number(r.characters) || 0;
    if (r.line) u.lines.add(r.line);
    u.recordings += r.engine === 'elevenlabs' ? 1 : Number(r.lines) || 0;
    u.seconds += Number(r.seconds) || 0;
    if (r.t && (!u.last || r.t > u.last)) u.last = r.t;
    by.set(k, u);
  }
  return [...by.values()].map((u) => ({ ...u, lines: u.engine === 'elevenlabs' ? u.lines.size : u.recordings, seconds: Math.round(u.seconds) }));
}
