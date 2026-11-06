// The New project brief (plan 52): schema, drafts, source tray, live summary, Improve my brief, presets, project.new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { saveConfig } from '../src/studio.mjs';
import { normalizeBrief, FIELDS } from '../src/svc/briefschema.mjs';
import { summarize } from '../src/svc/briefsummary.mjs';
import { htmlToText } from '../src/svc/briefstore.mjs';
import { titleFromIdea } from '../src/svc/briefmap.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20); } }
function harness(t, root, opts = {}) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0, ...opts });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) { const e = new Error(`${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
  return { call, events: (name) => out.filter((m) => m.event === name).map((m) => m.data) };
}
const page = (body, type = 'text/html') => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => Buffer.from(body) });

test('schema: 31 settings in 5 sections, each with a default; checkpoints map to gates', async (t) => {
  const root = tempStudio(t);
  const { call } = harness(t, root);
  const s = await call('brief.schema');
  assert.equal(s.version, 1);
  assert.deepEqual(s.sections.map((x) => x.id), ['story', 'visual', 'voice', 'delivery', 'workflow']);
  assert.equal(FIELDS.length, 31);
  for (const f of s.sections.flatMap((x) => x.fields)) assert.ok('default' in f && f.label && f.type, f.id);
  assert.deepEqual(s.decide_later.sort(), ['music', 'pauses', 'sound_design', 'voice']);
  assert.equal(s.checkpoints.find((c) => c.value === 'motion').gate, 'animatic');
  assert.equal(s.checkpoints.find((c) => c.value === 'outline').gate, null);
  assert.equal(s.sections[1].fields.find((f) => f.id === 'visual.asset_strategy').parts[0].choices[1].hint.includes('never an AI image model'), true);
});

test('validation: plain errors, partial objects, unknown keys, unsupported combos', () => {
  const r = normalizeBrief({ idea: 'x', story: { tone: ['serious', 'wry'], research_depth: 'mega', bogus: 1 }, delivery: { duration: { mode: 'manual', seconds: 2 }, output: { resolution: '2160p', fps: 60 } }, nope: 1 });
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['delivery.duration', 'delivery.output', 'nope', 'story.bogus', 'story.research_depth']);
  assert.deepEqual(r.brief.story.tone, ['serious', 'wry']);
  assert.match(r.errors.find((e) => e.path === 'story.research_depth').message, /must be one of: quick, standard, investigative/);
  assert.equal(normalizeBrief({ delivery: { duration: { mode: 'manual', seconds: 90 } } }).errors.length, 0);
});

test('drafts: autosave keeps valid parts, recovers newest, deletes', async (t) => {
  const root = tempStudio(t);
  const { call, events } = harness(t, root);
  assert.equal((await call('brief.draft.get')).draft, null);
  const a = await call('brief.draft.save', { brief: { idea: 'Heat pumps', story: { tone: ['warm'], research_depth: 'nope' } } });
  assert.match(a.draft, /^d-[0-9a-f]{8}$/);
  assert.equal(a.errors.length, 1);
  assert.equal(events('brief.draft.saved').length, 1);
  await call('brief.draft.save', { draft: 'd-aaaaaa', brief: { idea: 'Second' } });
  const got = await call('brief.draft.get', {});
  assert.equal(got.draft.id, 'd-aaaaaa');
  assert.deepEqual((await call('brief.draft.get', { draft: a.draft })).draft.brief.story, { tone: ['warm'] });
  assert.equal((await call('brief.draft.list')).drafts.length, 2);
  await assert.rejects(call('brief.draft.get', { draft: '../x' }), /not valid/);
  await call('brief.draft.delete', { draft: a.draft });
  assert.equal((await call('brief.draft.list')).drafts.length, 1);
});

test('sources: urls (html, pdf bytes, failures), invalid url, files, remove, preserved in the draft', async (t) => {
  const root = tempStudio(t);
  const fetch = async (u) => {
    if (u.includes('good')) return page('<html><head><title>Heat &amp; Pumps</title><style>x{}</style></head><body><h1>Intro</h1><p>Pumps move heat.</p><script>no()</script></body></html>');
    if (u.includes('down')) return { ok: false, status: 503, headers: { get: () => '' }, arrayBuffer: async () => Buffer.alloc(0) };
    if (u.includes('pic')) return page('x', 'image/png');
    throw new Error('boom');
  };
  const { call, events } = harness(t, root, { fetch });
  await assert.rejects(call('sources.add', { draft: 'd-aaaaaa', url: 'not a link' }), /not a web link/);
  await assert.rejects(call('sources.add', { draft: 'd-aaaaaa', url: 'ftp://x.com/a' }), /not a web link/);
  const a = await call('sources.add', { draft: 'd-aaaaaa', url: 'https://good.example.com/a' });
  assert.equal(a.source.status, 'fetching');
  await call('sources.add', { draft: 'd-aaaaaa', url: 'https://down.example.com/' });
  await call('sources.add', { draft: 'd-aaaaaa', url: 'https://pic.example.com/p' });
  await call('sources.add', { draft: 'd-aaaaaa', url: 'https://gone.example.com/' });
  await assert.rejects(call('sources.add', { draft: 'd-aaaaaa', url: 'https://good.example.com/a' }), /already in the tray/);
  const list = await until(async () => { const l = (await call('sources.list', { draft: 'd-aaaaaa' })).sources; return l.every((s) => s.status !== 'fetching') && l; });
  assert.deepEqual(list.map((s) => s.status), ['ready', 'failed', 'stored', 'failed']);
  assert.equal(list[0].label, 'Heat & Pumps');
  assert.match(list[1].error, /503/);
  assert.match(list[3].error, /Could not reach/);
  assert.equal(events('sources.changed').length, 4);
  // files: must be inside the draft's sources folder
  const dir = join(root, 'drafts', 'd-aaaaaa', 'sources'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-notes.txt'), 'My own notes about pumps.');
  writeFileSync(join(dir, '2-logo.png'), 'png');
  writeFileSync(join(root, 'outside.txt'), 'x');
  await assert.rejects(call('sources.add', { draft: 'd-aaaaaa', path: join(root, 'outside.txt') }), /uploaded to this draft/);
  const t1 = await call('sources.add', { draft: 'd-aaaaaa', path: join(dir, '1-notes.txt') });
  assert.equal(t1.source.name, 'notes.txt');
  const png = await call('sources.add', { draft: 'd-aaaaaa', path: join(dir, '2-logo.png') });
  assert.equal(png.source.status, 'stored');
  await until(async () => (await call('sources.list', { draft: 'd-aaaaaa' })).sources.find((s) => s.id === t1.source.id).status === 'ready');
  const rm = await call('sources.remove', { draft: 'd-aaaaaa', id: png.source.id });
  assert.equal(rm.removed, png.source.id);
  assert.equal(existsSync(join(dir, '2-logo.png')), false);
  assert.equal((await call('brief.draft.save', { draft: 'd-aaaaaa', brief: { idea: 'x' } })).errors.length, 0);
  assert.equal((await call('brief.draft.get', { draft: 'd-aaaaaa' })).draft.sources.length, 5);
});

test('an unnamed project is named from its idea, short and plain', () => {
  assert.equal(titleFromIdea('Your AI chatbot went bankrupt. Who gets your chats? A 60-second explainer.'), 'Your AI chatbot went bankrupt');
  assert.equal(titleFromIdea('How heat pumps work, for homeowners deciding this year. They should leave knowing.'), 'How heat pumps work');
  assert.equal(titleFromIdea('why is ice slippery?'), 'Why is ice slippery?');
  assert.equal(titleFromIdea(''), '');
});

test('htmlToText decodes named, numeric and double-encoded entities in titles', () => {
  assert.equal(htmlToText('<title>Flock &amp;mdash; city acts</title>').title, 'Flock \u2014 city acts');
  assert.equal(htmlToText('<title>A &ndash; B &#8217;s &#x2026;</title>').title, 'A \u2013 B \u2019s \u2026');
  assert.equal(htmlToText('<p>use &amp;lt;b&amp;gt;</p>').text, 'use &lt;b&gt;');
});

test('htmlToText strips markup', () => {
  assert.equal(htmlToText('<head><title>T</title></head><body><p>A &amp; B</p><p>C</p></body>').text, 'A & B\nC');
});

test('summary: labels, missing, conflicts, no AI', () => {
  const empty = summarize({});
  assert.equal(empty.ready, false);
  assert.match(empty.missing[0].text, /what the video is about/);
  assert.equal(empty.sentences.length > 0 && empty.sentences.every((s) => s.label === 'default'), true);
  const r = summarize({ idea: 'Word '.repeat(200), story: { tone: ['serious'], research_depth: 'quick', verification: 'strict', audience: 'plumbers' }, delivery: { destination: 'tiktok', duration: { mode: 'manual', seconds: 15 } }, meta: { suggested: ['story.tone'] } });
  assert.equal(r.ready, true);
  assert.equal(r.sentences.find((s) => s.path === 'story.audience').label, 'specified');
  assert.equal(r.sentences.find((s) => s.path === 'story.tone').label, 'suggested');
  const ids = r.conflicts.map((c) => c.id);
  assert.ok(ids.includes('long-text-short-video') && ids.includes('strict-quick') && ids.includes('vertical-destination'), ids.join());
  const long = r.conflicts.find((c) => c.id === 'long-text-short-video');
  assert.equal(long.resolutions[0].set['delivery.duration'].mode, 'manual');
  assert.equal(r.customized.story, 4);
  assert.equal(r.estimate.speaking_words_about, 27); // 15 s at 120 a minute (the measured default), less 10%
  assert.deepEqual(summarize({ idea: 'x', decide_later: { voice: true } }).sentences.find((s) => s.section === 'voice').label, 'default');
});

test('improve: one Haiku call; suggestions validated, never over set values or the idea', async (t) => {
  const root = tempStudio(t);
  const bin = join(root, 'fake-claude'); const calls = join(root, 'calls.log');
  const answer = JSON.stringify({ suggestions: [
    { kind: 'set', path: 'story.audience', value: 'homeowners', label: 'Audience: homeowners', why: 'The topic is domestic.' },
    { kind: 'set', path: 'story.tone', value: ['warm'], label: 'Warm tone', why: 'x' },
    { kind: 'set', path: 'story.research_depth', value: 'mega', label: 'bad value', why: 'x' },
    { kind: 'set', path: 'idea', value: 'rewrite', label: 'rewrite idea', why: 'x' },
    { kind: 'set', path: 'voice.voice', value: { pacing: 'slow' }, label: 'slow voice', why: 'x' },
    { kind: 'clarify', label: 'Which climate?', why: 'Heat pumps differ in cold climates.' }] });
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${calls}"\nprintf '%s' '${JSON.stringify({ type: 'result', is_error: false, result: answer }).replace(/'/g, "'\\''")}'\n`);
  chmodSync(bin, 0o755);
  saveConfig(root, { backend: 'claude-code', claudeBin: bin });
  const { call } = harness(t, root);
  const r = await call('brief.improve', { brief: { idea: 'How heat pumps work', story: { tone: ['serious'] } } });
  assert.equal(r.ai, true);
  assert.match(r.cost, /No credits/);
  assert.deepEqual(r.suggestions.map((s) => [s.kind, s.path || null]), [['set', 'story.audience'], ['clarify', null]]);
  const nCalls = () => (readFileSync(calls, 'utf8').match(/--no-session-persistence/g) || []).length;
  assert.equal(nCalls(), 1);
  assert.match(readFileSync(calls, 'utf8'), /--model haiku/);
  assert.equal((await call('brief.improve', { brief: {} })).suggestions.length, 0);
  assert.equal(nCalls(), 1, 'no idea: no call');
});

test('improve: demo backend says so, no call', async (t) => {
  const root = tempStudio(t);
  const { call } = harness(t, root);
  const r = await call('brief.improve', { brief: { idea: 'x' } });
  assert.equal(r.source, 'demo');
});

test('presets: save a brief preset, list it with the others, delete it; pipeline presets untouched', async (t) => {
  const root = tempStudio(t);
  const { call } = harness(t, root);
  await assert.rejects(call('presets.save', { name: '', brief: {} }), /name/);
  const r = await call('presets.save', { name: 'My Explainer!', brief: { idea: 'not kept', story: { tone: ['warm'] }, delivery: { aspects: ['9:16'] } } });
  assert.equal(r.slug, 'my-explainer');
  const l = await call('presets.list');
  assert.ok(l.built_in.length);
  assert.equal(l.briefs[0].customized, 2);
  assert.equal(l.briefs[0].brief.idea, undefined);
  await call('presets.delete', { slug: 'my-explainer', kind: 'brief' });
  assert.equal((await call('presets.list')).briefs.length, 0);
});

test('project.new with a brief: mapped into the intake, saved, sources moved, read by the script prompt', async (t) => {
  const root = tempStudio(t);
  const fetch = async () => page('<title>Pumps</title><p>Heat pumps move heat instead of making it.</p>');
  const { call } = harness(t, root, { fetch });
  const sa = await call('sources.add', { draft: 'd-bbbbbb', url: 'https://good.example.com/pumps' });
  await until(async () => (await call('sources.list', { draft: 'd-bbbbbb' })).sources[0].status === 'ready');
  const brief = { idea: 'How heat pumps work', title: 'Heat pumps', story: { audience: 'homeowners', tone: ['warm'], must_include: ['COP'] }, visual: { style: { preset: 'editorial' } }, voice: { music: { genre: 'ambient' } }, delivery: { aspects: ['9:16'], duration: { mode: 'manual', seconds: 45 }, output: { fps: 24 } }, workflow: { checkpoints: ['script', 'final'] }, meta: { suggested: ['story.tone'] } };
  await assert.rejects(call('project.new', { preset: 'v3', start: false, brief: { idea: 'x', story: { research_depth: 'bad' } } }), /must be one of/);
  const r = await call('project.new', { preset: 'v3', start: false, brief, draft: 'd-bbbbbb' });
  const id = r.project.id;
  assert.equal(r.brief_saved, true);
  assert.ok(r.stored_only.includes('delivery.output'));
  const a = r.project.intake.answers;
  assert.equal(a.topic, 'How heat pumps work');
  assert.equal(a.audience, 'homeowners');
  assert.equal(a.length, '45 s');
  assert.equal(a.aspect, '9:16');
  assert.equal(a.source_url, 'https://good.example.com/pumps');
  assert.equal(r.project.title, 'Heat pumps');
  const saved = JSON.parse(readFileSync(join(root, 'state', id, 'brief.json'), 'utf8'));
  assert.deepEqual(saved.brief.story.must_include, ['COP']);
  assert.equal(saved.sources[0].status, 'ready');
  assert.ok(existsSync(saved.sources[0].text_file));
  const { serviceBrief } = await import('../src/svc/brief.mjs');
  const text = serviceBrief(root, id);
  assert.match(text, /The production brief/);
  assert.match(text, /Mandatory facts: COP/);
  assert.match(text, /Target audience: homeowners \n?|Target audience: homeowners/);
  assert.match(text, /accepted from an AI suggestion/);
  assert.match(text, /Heat pumps move heat/);
  assert.doesNotMatch(text, /Voice:|decide later/i);
  // flat fields still win; absent length = Claude picks (today's behaviour)
  const r2 = await call('project.new', { preset: 'v3', start: false, idea: 'Flat idea', brief: { idea: 'brief idea' } });
  assert.equal(r2.project.intake.answers.topic, 'Flat idea');
  assert.equal(r2.project.intake.answers.length, undefined);
  const r3 = await call('project.new', { preset: 'v3', start: false, idea: 'No brief at all' });
  assert.equal(r3.brief_saved, undefined);
});
