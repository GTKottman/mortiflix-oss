// The usage ledger (owner, 2026-11-02): Claude tokens + ElevenLabs credits, per day/project/stage/model, records, balance.
// Mock transcripts and mock fetch only: no real calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { writeSecret, paths } from '../src/studio.mjs';
import { logVoiceUse } from '../src/voiceusage.mjs';
import { bookSpend, costHeader } from '../src/voice/spend.mjs';
import { usageGet, record, bookSession, recordClaudeJson, recordApiMessage, readRows, ledgerFile, backfillDone, _forget } from '../src/svc/ledger.mjs';

const P = '261101-ledger-test-0001';
const Q = '261101-ledger-test-0002';
const J = (o) => JSON.stringify(o) + '\n';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function studio(t) {
  _forget();
  const root = tempStudio(t);
  for (const id of [P, Q]) {
    mkdirSync(join(paths(root).state, id, 'sessions'), { recursive: true });
    writeFileSync(join(paths(root).state, id, 'project.json'), JSON.stringify({ id, created_at: '2026-11-01T08:00:00.000Z' }));
    mkdirSync(join(paths(root).projects, id), { recursive: true });
  }
  return root;
}

function transcript(root, id, run, { old = true } = {}) {
  const f = join(paths(root).state, id, 'sessions', `${run}.jsonl`);
  const asst = (mid, model, usage, extra = {}) => J({ type: 'assistant', message: { id: mid, model, usage, content: [{ type: 'text', text: 'x'.repeat(400) }] }, ...extra });
  writeFileSync(f,
    J({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', tools: ['Read'] })
    + asst('m1', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 })
    + J({ type: 'result', usage: { output_tokens: 40 }, total_cost_usd: 0.01 })
    + J({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Bash', 'Task', 'Edit'] })
    + asst('m2', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 })
    + asst('m2', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }) // same message again: once
    + asst('m3', 'claude-opus-5-5', { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 })
    + J({ type: 'result', usage: { output_tokens: 200 }, total_cost_usd: 1 }));
  if (old) { const past = new Date(Date.now() - 3600_000); utimesSync(f, past, past); }
}

const seed = (root) => {
  transcript(root, P, '2026-11-01T09-00-00-000Z');
  const voice = join(paths(root).projects, P, 'sound', 'voice');
  mkdirSync(voice, { recursive: true });
  writeFileSync(join(voice, 'usage.jsonl'), [
    { t: '2026-11-01T09:05:00.000Z', engine: 'elevenlabs', model: 'eleven_multilingual_v2', line: 'l1', characters: 100 },
    { t: '2026-11-01T09:06:00.000Z', engine: 'elevenlabs', model: 'eleven_flash_v2_5', line: 'l2', characters: 100 },
    { t: '2026-11-01T09:07:00.000Z', engine: 'qwen', voice: 'x', lines: 3, seconds: 5 },
  ].map(J).join(''));
  mkdirSync(join(paths(root).projects, P, 'music'), { recursive: true });
  writeFileSync(join(paths(root).projects, P, 'music', 'calls.jsonl'), [
    { t: '2026-11-01T10:00:00.000Z', ok: true, seconds: 10, credits_estimate: 330 },
    { t: '2026-11-01T10:01:00.000Z', ok: true, cache: 'hit', credits_estimate: 0 },
    { t: '2026-11-01T10:02:00.000Z', ok: false, status: 402, seconds: 10 },
  ].map(J).join(''));
  mkdirSync(join(paths(root).projects, P, 'sound'), { recursive: true });
  writeFileSync(join(paths(root).projects, P, 'sound', 'calls.jsonl'), [
    { at: '2026-11-02T10:00:00.000Z', ok: true, seconds: 2, credits: 40 },
    { at: '2026-11-02T10:01:00.000Z', ok: true, cache: 'hit', credits: 0 },
  ].map(J).join(''));
};

test('backfill books transcripts, voice, music and sound logs once; no dollars anywhere', async (t) => {
  const root = studio(t);
  seed(root);
  const u = await usageGet(root, {}, { now: Date.parse('2026-11-02T12:00:00Z') });
  const c = u.totals.claude;
  // haiku quick call + opus session (m2 once, m3): fresh input 10+5+7, cache read 100+1000+2000, cache write 50+500
  assert.equal(c.input_tokens, 22);
  assert.equal(c.cache_read_tokens, 3100);
  assert.equal(c.cache_write_tokens, 550);
  assert.equal(c.output_tokens, 240); // the exact totals of the two results
  assert.equal(c.calls, 3);
  assert.equal(u.totals.elevenlabs.credits, 100 + 50 + 330 + 0 + 40); // flash half price; cache hits and the failed call are free
  const kinds = u.by_model.map((m) => `${m.provider}:${m.kind}:${m.model}`).sort();
  assert.ok(kinds.includes('claude:quick call:claude-haiku-4-5'));
  assert.ok(kinds.includes('claude:session:claude-opus-5-5'));
  assert.ok(kinds.includes('elevenlabs:music:music_v2_5'));
  assert.ok(kinds.includes('elevenlabs:sfx:null'));
  assert.equal(u.by_project[0].project, P);
  assert.equal(JSON.stringify(u).match(/cost|usd|characters|\$/i), null);
  assert.equal(readFileSync(ledgerFile(root), 'utf8').match(/cost|usd/i), null);
  // booking the same run again, or backfilling again, adds nothing
  const n = readRows(root).length;
  await bookSession(root, P, '2026-11-01T09-00-00-000Z', {});
  _forget();
  await backfillDone(root);
  assert.equal(readRows(root).length, n);
});

test('live rows: voice line, quick Claude calls, API call; records, streak, series, filters', async (t) => {
  const root = studio(t);
  seed(root);
  await backfillDone(root);
  const before = readRows(root).length;
  logVoiceUse(join(paths(root).projects, Q), { engine: 'elevenlabs', model: 'eleven_v4', line: 'a', characters: 70, credits: 70 });
  logVoiceUse(join(paths(root).projects, Q), { engine: 'qwen', voice: 'x', lines: 1, seconds: 2 }); // free: not booked
  recordClaudeJson(root, Q, { is_error: false, modelUsage: { 'claude-haiku-4-5': { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6 } } }, { role: 'options' });
  recordApiMessage(root, null, { model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2 } }, { role: 'name' });
  record(root, { provider: 'claude', project: P, kind: 'session', model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, ok: false, at: '2026-10-01T00:00:00Z' });
  const rows = readRows(root).slice(before);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].project, Q);
  assert.equal(rows[0].stage, 'voice');
  assert.equal(rows[1].role, 'options');
  assert.equal(rows[1].cache_write_tokens, 6);
  assert.equal(rows[2].project, null);
  assert.equal(rows[3].ok, false);

  const now = Date.parse('2026-11-02T12:00:00');
  const all = await usageGet(root, { project: P }, { now });
  assert.equal(all.series.length, 30);
  assert.equal(all.series.at(-1).date, '2026-11-02');
  assert.equal(all.series[0].date, '2026-10-04');
  assert.ok(all.records.longest_streak.days >= 1);
  assert.equal(all.records.biggest_call.elevenlabs.credits, 330);
  assert.ok(all.records.biggest_call.claude.cache_read_tokens >= 2000 || all.records.biggest_call.claude.input_tokens > 0);
  assert.equal(all.records.biggest_project.elevenlabs.project, P);
  assert.ok(all.records.biggest_day.elevenlabs.elevenlabs.credits > 0);
  const today = await usageGet(root, { range: 'today', project: P }, { now: Date.parse('2026-11-02T20:00:00') });
  assert.equal(today.totals.elevenlabs.credits, 40); // only the sound effect, made on the 2nd
  assert.equal(today.totals.claude.rows, 0);
  const week = await usageGet(root, { range: 'week' }, { now });
  assert.ok(week.totals.elevenlabs.credits > 0);
  await assert.rejects(usageGet(root, { range: 'year' }), /range must be/);
});

test('streak: consecutive days, current streak counts through yesterday', async (t) => {
  const root = studio(t);
  for (const d of ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-01']) record(root, { provider: 'elevenlabs', kind: 'sfx', credits: 1, at: `${d}T12:00:00` });
  const u = await usageGet(root, {}, { now: Date.parse('2026-11-02T12:00:00') });
  assert.deepEqual(u.records.longest_streak, { days: 3, from: '2026-10-28', to: '2026-10-30', current: 1 });
});

test('ElevenLabs balance: from the subscription endpoint, cached 10 minutes, null with a reason otherwise', async (t) => {
  const root = studio(t);
  const now = Date.parse('2026-11-02T12:00:00Z');
  const none = await usageGet(root, {}, { now, fetch: async () => { throw new Error('no network call expected'); } });
  assert.equal(none.elevenlabs_balance, null);
  assert.match(none.elevenlabs_balance_why, /no ElevenLabs API key/);
  writeSecret(root, 'elevenlabs_api_key', 'k');
  let calls = 0;
  let fail = false;
  const fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/user/subscription');
    assert.equal(init.headers['xi-api-key'], 'k');
    if (fail) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ tier: 'creator', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1796000000 }) };
  };
  const a = await usageGet(root, {}, { now, fetch });
  assert.equal(a.elevenlabs_balance.remaining, 98800);
  assert.equal(a.elevenlabs_balance.limit, 100000);
  assert.equal(a.elevenlabs_balance.resets_at, new Date(1796000000 * 1000).toISOString());
  await usageGet(root, {}, { now: now + 5 * 60_000, fetch });
  assert.equal(calls, 1);
  fail = true;
  const stale = await usageGet(root, {}, { now: now + 11 * 60_000, fetch });
  assert.equal(calls, 2);
  assert.equal(stale.elevenlabs_balance.stale, true);
  assert.equal(stale.elevenlabs_balance.remaining, 98800);
  assert.match(stale.elevenlabs_balance_why, /could not refresh/);
});

test('service: usage.get handler and one debounced usage.changed per burst', async (t) => {
  const root = studio(t);
  seed(root);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0, fetch: async () => { throw new Error('offline'); } });
  t.after(() => svc.close());
  await svc.handle({ id: 1, type: 'usage.get', params: { range: 'all' } });
  const r = out.find((m) => m.id === 1);
  assert.equal(r.ok, true);
  assert.ok(r.result.totals.claude.total_tokens > 0);
  await svc.handle({ id: 2, type: 'usage.get', params: { range: 'nope' } });
  assert.equal(out.find((m) => m.id === 2).error.code, 'bad_request');
  record(root, { provider: 'elevenlabs', kind: 'sfx', credits: 1, project: P });
  record(root, { provider: 'elevenlabs', kind: 'sfx', credits: 2, project: P });
  record(root, { provider: 'elevenlabs', kind: 'music', credits: 3, project: Q });
  assert.equal(out.filter((m) => m.event === 'usage.changed').length, 0);
  await sleep(1300);
  const ev = out.filter((m) => m.event === 'usage.changed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.project, Q);
  assert.ok(existsSync(ledgerFile(root)));
});

test('session booking is incremental and never double counts; a crash keeps what was booked', async (t) => {
  const root = studio(t);
  const run = '2026-11-02T09-00-00-000Z';
  const f = join(paths(root).state, P, 'sessions', `${run}.jsonl`);
  const asst = (mid, usage) => J({ type: 'assistant', message: { id: mid, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'x'.repeat(40) }] } });
  writeFileSync(f, J({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Bash'] }) + asst('a', { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 }));
  await backfillDone(root);
  const sum = () => readRows(root).filter((r) => r.provider === 'claude').reduce((a, r) => a + r.input_tokens + r.cache_read_tokens, 0);
  assert.equal((await bookSession(root, P, run, { stage: 'script' })).length, 1);
  assert.equal(sum(), 110);
  assert.equal((await bookSession(root, P, run)).length, 0); // nothing new
  appendFileSync(f, asst('b', { input_tokens: 5, cache_read_input_tokens: 200, output_tokens: 1 }));
  assert.equal((await bookSession(root, P, run)).length, 1); // the new call only: a crash here lost nothing before it
  assert.equal(sum(), 315);
  appendFileSync(f, J({ type: 'result', usage: { output_tokens: 90 } }));
  await bookSession(root, P, run);
  assert.equal(sum(), 315); // the end books only what is left (the output total), never the input twice
  const u = await usageGet(root, {});
  assert.equal(u.totals.claude.input_tokens, 15);
  assert.equal(u.totals.claude.calls, 2);
  assert.ok(u.totals.claude.output_tokens >= 2);
});

test('session-side scripts append ledger rows; the service notices them; real header beats the estimate', async (t) => {
  const root = studio(t);
  seed(root);
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0, usagePollMs: 100 });
  t.after(() => svc.close());
  await svc.handle({ id: 1, type: 'usage.get', params: {} });
  const base = out.find((m) => m.id === 1).result.totals.elevenlabs.credits;
  const work = join(paths(root).projects, P);
  const env = { MFX_LEDGER: ledgerFile(root), MFX_PROJECT: P };
  assert.equal(bookSpend({ kind: 'tts', model: 'eleven_v4', credits: costHeader({ headers: new Headers({ 'character-cost': '42' }) }), cwd: work, env }), true);
  assert.equal(bookSpend({ kind: 'scribe check', model: 'scribe_v2', credits: null, seconds: 6, cwd: work, env: {} }), true); // project and ledger from the folder
  assert.equal(bookSpend({ kind: 'sfx', credits: 20, estimated: true, cwd: '/tmp', env: {} }), false); // not in a studio: nothing written
  await sleep(1500);
  assert.equal(out.filter((m) => m.event === 'usage.changed').length, 1);
  const u = await usageGet(root, {});
  assert.equal(u.totals.elevenlabs.credits, base + 42);
  const rows = readRows(root).filter((r) => r.id?.startsWith('el:'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].estimated, undefined);
  assert.equal(rows[0].stage, 'voice');
  assert.equal(rows[1].credits_unknown, true);
  assert.equal(rows[1].project, P);
  // in-process rows after a foreign append still count (the cache reloads)
  record(root, { provider: 'elevenlabs', kind: 'sfx', credits: 1, project: P });
  assert.equal(readFileSync(ledgerFile(root), 'utf8').trim().split('\n').length, readRows(root).length);
});
