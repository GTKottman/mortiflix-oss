import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { clip } from './client.mjs';

// Stuck-point recorder: what the driver was waiting for, the last state, needs_you and the last 5 events.
export class StuckRecorder {
  constructor(path) { this.path = path; this.points = []; }
  record({ step, waitingFor, state, status, needs_you, events, note }) {
    const p = { path: this.path, step, waitingFor, state: clip(state, 400), stage_status: clip(status, 500), needs_you: needs_you ?? null, last_events: events || [], note: note || undefined, at: new Date().toISOString() };
    this.points.push(p); return p;
  }
}

const SPEND_FIELDS = ['credits', 'credits_used', 'credit', 'tokens', 'input', 'output', 'cache_write', 'cache_read', 'cost', 'cost_usd', 'usd', 'characters', 'chars', 'total'];

const SPEND_RE = /token|credit|cost|usd|char/i;

// Rows of the usage ledger after `fromByte`. Zero spend = every row has replay:true and no spend number above 0.
export function readLedgerRows(file, fromByte = 0) {
  if (!existsSync(file)) return { rows: [], bad: [] };
  const size = statSync(file).size; if (size <= fromByte) return { rows: [], bad: [] };
  const fd = openSync(file, 'r'); const b = Buffer.alloc(size - fromByte);
  try { readSync(fd, b, 0, b.length, fromByte); } finally { closeSync(fd); }
  const rows = [], bad = [];
  for (const line of b.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad.push(line.slice(0, 120)); }
  }
  return { rows, bad };
}

export function spendCheck(file, fromByte = 0) {
  const { rows, bad } = readLedgerRows(file, fromByte);
  const offenders = [];
  for (const r of rows) {
    const why = [];
    if (r.replay !== true) why.push('replay is not true');
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && v > 0 && (SPEND_FIELDS.includes(k) || SPEND_RE.test(k))) why.push(`${k}=${v}`);
    for (const [k, v] of Object.entries(r.usage && typeof r.usage === 'object' ? r.usage : {})) if (typeof v === 'number' && v > 0) why.push(`usage.${k}=${v}`);
    if (why.length) offenders.push({ why, row: clip(r, 240) });
  }
  for (const b of bad) offenders.push({ why: ['unreadable ledger line'], row: b });
  return { ok: offenders.length === 0, rows: rows.length, offenders };
}

// Gaps in replay: rows of <studio>/run/replay/log.jsonl after `fromByte` whose kind is claude-call, blocked-fetch or
// elevenlabs-unknown (something the pack has no recording for, or a way out replay had to block).
export const GAP_KINDS = ['claude-call', 'blocked-fetch', 'elevenlabs-unknown'];
export function replayGaps(file, fromByte = 0) {
  const { rows } = readLedgerRows(file, fromByte);
  return rows.filter((r) => GAP_KINDS.includes(r.kind)).map((r) => clip(r, 240));
}

export function markdown(report) {
  const L = [];
  L.push(`# Beta drive ${report.started}`, '', `pack: ${report.pack}  studio: ${report.studio}`, '');
  L.push('| path | final.mp4 | duration | steps | stuck | protocol errors | faults | spend |', '|---|---|---|---|---|---|---|---|');
  for (const p of report.paths) {
    L.push(`| ${p.path} | ${p.final?.ok ? 'yes' : 'NO'} | ${p.final?.duration ?? '-'} | ${p.steps.length} | ${p.stuck.length} | ${p.protocol_errors.length} | ${p.faults.map((f) => `${f.fault}:${f.recovered ? 'recovered' : 'NOT'}`).join(' ') || '-'} | ${p.spend?.ok ? 'zero' : 'SPEND'} |`);
  }
  if (report.replay_gaps?.length) { L.push('', `## Replay gaps (${report.replay_gaps.length})`); for (const g of report.replay_gaps.slice(0, 30)) L.push(`- ${g}`); }
  if (report.spend_total && !report.spend_total.ok) L.push('', `## SPEND over the whole run: ${report.spend_total.offenders.length} rows`);
  for (const p of report.paths) {
    if (p.faults?.length) { L.push('', `## Faults: ${p.path}`); for (const f of p.faults) L.push(`- ${f.fault} at ${f.step}: surfaced ${f.surfaced} (${f.cause ?? '-'}: ${clip(f.text, 140)}); ${f.how} ${f.recovered ? 'recovered' : 'NOT recovered'}`); }
    if (p.notes?.length) { L.push('', `## Notes: ${p.path}`); for (const n of p.notes) L.push(`- ${n}`); }
    if (p.stuck.length) { L.push('', `## Stuck points: ${p.path}`); for (const s of p.stuck) L.push(`- ${s.step}: waiting for ${s.waitingFor}; needs_you ${clip(s.needs_you, 160)}`); }
    if (p.protocol_errors.length) { L.push('', `## Protocol errors: ${p.path}`); for (const e of p.protocol_errors.slice(0, 20)) L.push(`- ${e.type} ${e.code || ''}: ${e.message}${e.expected ? ' (expected)' : ''}`); }
    if (p.spend && !p.spend.ok) { L.push('', `## SPEND: ${p.path}`); for (const o of p.spend.offenders.slice(0, 10)) L.push(`- ${o.why.join(', ')}: ${o.row}`); }
  }
  return L.join('\n') + '\n';
}
