import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { projectPaths } from '../src/projects.mjs';
import { castGet, castSet, lineSet, voiceCheck, splitTags, diffWords, voicecastHandlers } from '../src/svc/voicecast.mjs';

const ID = 'route-22-test';
function setup(t) {
  const root = tempStudio(t);
  const dir = join(projectPaths(root, ID).work, 'voice');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lines.json'), JSON.stringify([
    { id: 'a01', text: '[wry] Dale said it was fine.', script: 'Dale said it was fine.', gap_after: 0.4 },
    { id: 'a02', text: 'Not fine at all.', script: 'Not fine at all.' },
  ]));
  writeFileSync(join(dir, 'timing.json'), JSON.stringify({ lines: [
    { id: 'a01', words: ['Dale', 'said', 'it', 'was', 'fine.'].map((text) => ({ text, start: 0, end: 1 })) },
    { id: 'a02', words: ['Not', 'fine', 'at', 'the', 'all.'].map((text) => ({ text, start: 0, end: 1 })) },
  ] }));
  return { root, dir };
}

test('cast: save, clamp, reload', (t) => {
  const { root } = setup(t);
  assert.equal(castGet(root, ID).set, false);
  const r = castSet(root, ID, [{ role: 'Dale', name: 'Roger', voice_id: 'v1', settings: { stability: 3, speed: 9 }, gain_db: -40 }, { role: 'narrator', name: 'Mark', voice_id: 'v2' }]);
  assert.equal(r.cast[0].settings.stability, 1);
  assert.equal(r.cast[0].settings.speed, 1.2);
  assert.equal(r.cast[0].gain_db, -24);
  assert.equal(castGet(root, ID).cast[1].role, 'narrator');
  assert.throws(() => castSet(root, ID, [{ role: 'a' }, { role: 'a' }]), /twice/);
});

test('line.set: tags keep the script plain, retake only when needed', (t) => {
  const { root, dir } = setup(t);
  let r = lineSet(root, ID, { line: 'a01', gap_after: 0.9 });
  assert.equal(r.retake, false); assert.equal(r.changed.gap, true);
  r = lineSet(root, ID, { line: 'a01', tags: 'tired, wry' });
  assert.equal(r.retake, true);
  assert.equal(r.credits, '[tired, wry] Dale said it was fine.'.length);
  const l = JSON.parse(readFileSync(join(dir, 'lines.json'), 'utf8'))[0];
  assert.equal(l.text, '[tired, wry] Dale said it was fine.'); assert.equal(l.script, 'Dale said it was fine.'); assert.equal(l.gap_after, 0.9);
  r = lineSet(root, ID, { line: 'a01', tags: ['tired', 'wry'] });
  assert.equal(r.retake, false);
  r = lineSet(root, ID, { line: 'a02', role: 'dale', dry: true });
  assert.equal(r.retake, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'lines.json'), 'utf8'))[1].role, undefined); // dry changes nothing
  assert.throws(() => lineSet(root, ID, { line: 'zzz' }), /no line/);
});

test('handler sends one Fix only when something changed', (t) => {
  const { root } = setup(t);
  const calls = [];
  const h = voicecastHandlers({ root, needProject: () => ID, retake: (id, l) => { calls.push(l.id); return { id: 'e1' }; } });
  assert.equal(h['voice.line.set']({ line: 'a01', gap_after: 1 }).edit, null);
  assert.equal(h['voice.line.set']({ line: 'a02', role: 'dale', confirm: true }).edit.id, 'e1');
  assert.deepEqual(calls, ['a02']);
});

test('verbatim check', (t) => {
  const { root } = setup(t);
  const c = voiceCheck(root, ID);
  assert.equal(c.lines[0].ok, true); assert.deepEqual(c.lines[0].tags, ['wry']); assert.equal(c.lines[0].gap_after, 0.4);
  assert.equal(c.lines[1].ok, false);
  assert.deepEqual(c.lines[1].extra, ['the']);
  assert.deepEqual(c.bad, ['a02']);
  assert.deepEqual(splitTags('[a, b][c] hi').tags, ['a', 'b', 'c']);
  assert.deepEqual(diffWords(['a', 'b'], ['a']).missing, ['b']);
});

test('vo.mjs: role picks voice and settings, v4 never sends style/speed (mocked fetch, no network)', async (t) => {
  const { root, dir } = setup(t);
  castSet(root, ID, [{ role: 'dale', voice_id: 'DALE', settings: { stability: 0.3, style: 0.9, speed: 1.1 }, gain_db: -3 }]);
  const work = projectPaths(root, ID).work;
  writeFileSync(join(dir, 'lines.json'), JSON.stringify([{ id: 'a01', text: '[tired] Hi.', script: 'Hi.', role: 'dale' }, { id: 'a02', text: 'Yo.', script: 'Yo.' }]));
  const loader = join(work, 'run.mjs');
  const vo = new URL('../pipelines/_shared/skills/voiceover/vo.mjs', import.meta.url).pathname;
  writeFileSync(loader, `
    const seen = [];
    globalThis.fetch = async (url, init) => {
      url = String(url);
      if (url.includes('/text-to-speech/')) { seen.push({ url, body: JSON.parse(init.body) }); return new Response(new Uint8Array([1,2,3]), { headers: { 'request-id': 'r' } }); }
      return new Response('{}', { status: 500 });
    };
    process.on('exit', () => console.log('SEEN' + JSON.stringify(seen)));
    process.argv = ['node', ${JSON.stringify(vo)}, 'speak', 'voice/lines.json', '--max-takes', '1'];
    await import(${JSON.stringify(vo)});
  `);
  const home = new URL('..', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [loader], { cwd: work, encoding: 'utf8', env: { ...process.env, MFX_HOME: home, ELEVENLABS_API_KEY: 'k', MFX_VOICE: JSON.stringify({ engine: 'elevenlabs', elevenlabs: { voice_id: 'NARR', model_id: 'eleven_v4', stability: 0.5, check_model: 'off' } }) } });
  const seen = JSON.parse(r.stdout.split('SEEN')[1].split('\n')[0]);
  const a1 = seen.find((s) => s.body.text === '[tired] Hi.'); const a2 = seen.find((s) => s.body.text === 'Yo.');
  assert.ok(a1.url.includes('/DALE?')); assert.ok(a2.url.includes('/NARR?'));
  assert.deepEqual(a1.body.voice_settings, { stability: 0.3, similarity_boost: 0.75 });
});
