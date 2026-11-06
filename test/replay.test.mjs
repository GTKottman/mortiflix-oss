// Replay mode (src/replay.mjs, src/backends/replay.mjs): fenced off (marker, never ~/Mortiflix, bad packs refused), fail
// closed (real Claude/ElevenLabs clients refuse to exist, every network host but the ElevenLabs stand-in is blocked), the
// ledger marks rows replay with zero spend, the faults fire once each, and the whole v3 pipeline walks to a delivered
// project and a real final.mp4 from a tiny recorded pack, through the real runner and gates.
import { test } from 'node:test';
import { confirmCost } from '../src/svc/paidgate.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ensureStudio, saveConfig, loadConfig, writeSecret } from '../src/studio.mjs';
import { replayCheck, takeFault, installReplayFetch, MARKER, CLAUDE_STUB, KG_STUB, refuseReal } from '../src/replay.mjs';
import { kgCommand } from '../src/kinetograph.mjs';
import * as claudeCode from '../src/backends/claude-code.mjs';
import { ElevenLabs } from '../src/voice/elevenlabs.mjs';
import { record, readRows, _forget } from '../src/svc/ledger.mjs';
import { createProject, startProject, loadProject, projectPaths, projectPipeline, update } from '../src/projects.mjs';
import { respond, settle, stepView } from '../src/gates.mjs';
import { Runner } from '../src/runner.mjs';
import { replayStudio } from '../src/replay.mjs';
import { approveScene } from '../src/svc/stages.mjs';
import { sceneGet } from '../src/svc/lessons.mjs';
import { finalHandlers } from '../src/svc/final.mjs';
import { musicHandlers } from '../src/svc/elmusic.mjs';
import { framesView, okFrame, fixFrame } from '../src/svc/frames.mjs';

const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 }); assert.equal(r.status, 0, r.stderr); };
const put = (f, data) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 1)); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Two beats, one line each, 2 s per beat.
function tinyPack(dir) {
  const beats = [{ id: 'b01', name: 'Open', words: 'Kettles boil water.', visual: 'A kettle.', target_sec: 2 }, { id: 'b02', name: 'Close', words: 'Steam lifts the lid.', visual: 'Steam.', target_sec: 2 }];
  const lines = [{ id: 'b01-1', text: beats[0].words, file: 'voice/clips/b01-1.wav' }, { id: 'b02-1', text: beats[1].words, file: 'voice/clips/b02-1.wav' }];
  const timing = { seconds: 4, lines: [
    { id: 'b01-1', text: beats[0].words, start: 0.3, end: 1.8, words: [{ text: 'Kettles', start: 0.3, end: 0.8 }] },
    { id: 'b02-1', text: beats[1].words, start: 2.3, end: 3.8, words: [{ text: 'Steam', start: 2.3, end: 2.8 }] }] };
  const s = (k) => join(dir, 'steps', k);
  put(join(s('brief'), 'submission.json'), { note: 'The brief, restated.', questions: [{ id: 'pace', text: 'Calm or energetic?', choices: ['Calm', 'Energetic'], default: 'Calm' }], items: [] });
  put(join(s('script'), 'work', 'script', 'beats.json'), { beats });
  put(join(s('script'), 'work', 'script.md'), '# Script\n\nB01 · Kettles boil water.\n\nB02 · Steam lifts the lid.\n');
  put(join(s('script'), 'submission.json'), { note: 'Two beats.', items: [{ path: 'script.md', label: 'Script' }] });
  const v = join(s('voice'), 'work');
  put(join(v, 'voice', 'lines.json'), lines);
  put(join(v, 'voice', 'timing.json'), timing);
  for (const l of lines) { mkdirSync(join(v, 'voice', 'clips'), { recursive: true }); ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.5', '-ar', '48000', join(v, l.file)]); }
  mkdirSync(join(v, 'out', 'voice'), { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-ar', '48000', '-ac', '2', join(v, 'out', 'voice', 'narration.wav')]);
  ff(['-i', join(v, 'out', 'voice', 'narration.wav'), join(v, 'voice', 'narration.wav')]);
  put(join(s('voice'), 'submission.json'), { note: 'Narration.', items: [{ path: 'out/voice/narration.wav', label: 'Narration' }] });
  const f = join(s('style-frames'), 'work');
  put(join(f, 'design', 'sf01.png'), PNG); put(join(f, 'design', 'sf02.png'), PNG);
  put(join(f, 'design', 'frames.json'), { frames: [{ id: 'sf01', file: 'design/sf01.png', label: 'SF01', beats: ['b01'], name: 'Steel', palette: ['#111', '#eee'], fonts: ['sans-serif'] }, { id: 'sf02', file: 'design/sf02.png', label: 'SF02', beats: ['b02'], name: 'Steel', palette: ['#111', '#eee'], fonts: ['sans-serif'] }] });
  put(join(s('style-frames'), 'submission.json'), { note: 'Two frames.', items: [{ path: 'design/sf01.png', label: 'SF01' }, { path: 'design/sf02.png', label: 'SF02' }] });
  for (const [b, sec] of [['b01', 2.05], ['b02', 2.95]]) {
    mkdirSync(join(dir, 'motion', 'clips'), { recursive: true });
    ff(['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${sec}`, '-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec}:sample_rate=48000`, '-ac', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'motion', 'clips', `${b}.mp4`)]);
  }
  put(join(dir, 'motion', 'scenes.json'), [{ beat: 'b01', file: 'motion/clips/b01.mp4', seconds: 2.05 }, { beat: 'b02', file: 'motion/clips/b02.mp4', seconds: 2.95 }]);
  put(join(dir, 'motion', 'actions.json'), [{ shot: 's01', at_sec: 0.5, what: 'Kettle in', sound: 'whoosh' }, { shot: 's02', at_sec: 2.5, what: 'Lid pops', sound: 'pop' }]);
  put(join(dir, 'stills', 'b01-1.png'), PNG); put(join(dir, 'stills', 'b02-1.png'), PNG);
  for (const k of ['tts', 'music', 'sfx']) { mkdirSync(join(dir, 'audio', k), { recursive: true }); ff(['-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', join(dir, 'audio', k, `${k}1.mp3`)]); }
  put(join(dir, 'claude', 'music-plan.json'), { cues: [{ from_sec: 0, mood: 'calm', prompt: 'soft piano, no vocals' }] });
  put(join(dir, 'replay.json'), { format: 'mfx-replay-1', name: 'tiny', made_at: new Date().toISOString(), source: { studio: 'test', project: 'tiny', title: 'Tiny kettle' },
    project: { title: 'Tiny kettle', pipeline: 'v3', answers: { topic: 'How a kettle works' } }, look_brief: { vibe: 'flat' }, motion_brief: { motion_pack: null, rule_packs: [], words: 'the AI decides' },
    steps: Object.fromEntries(['brief', 'script', 'voice', 'style-frames'].map((k) => [k, { submission: `steps/${k}/submission.json`, work: `steps/${k}/work` }])),
    motion: { scenes: 'motion/scenes.json', actions: 'motion/actions.json' }, stills: 'stills',
    audio: { tts: ['audio/tts/tts1.mp3'], music: ['audio/music/music1.mp3'], sfx: ['audio/sfx/sfx1.mp3'] }, claude: { 'music-plan': 'claude/music-plan.json' } });
  return dir;
}

let PACK = null;
function setup(t, { marker = true } = {}) {
  PACK ||= tinyPack(mkdtempSync(join(tmpdir(), 'mfx-pack-')));
  const root = mkdtempSync(join(tmpdir(), 'mfx-replay-'));
  ensureStudio(root);
  saveConfig(root, { backend: 'claude-code', voice: { engine: 'elevenlabs', elevenlabs: { music: true } }, videoNotes: { enabled: true, folder: join(root, 'tablet') } });
  if (marker) writeFileSync(join(root, MARKER), 'replay studio');
  writeSecret(root, 'elevenlabs_api_key', 'replay-fake-key-not-real'); // as the beta studio has: the stand-in answers, never ElevenLabs
  const prev = { r: process.env.MFX_REPLAY, s: process.env.MORTIFLIX_STUDIO, f: globalThis.fetch };
  process.env.MFX_REPLAY = PACK;
  process.env.MORTIFLIX_STUDIO = root;
  t.after(() => {
    if (prev.r === undefined) delete process.env.MFX_REPLAY; else process.env.MFX_REPLAY = prev.r;
    if (prev.s === undefined) delete process.env.MORTIFLIX_STUDIO; else process.env.MORTIFLIX_STUDIO = prev.s;
    globalThis.fetch = prev.f;
    _forget();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('replay is fenced: an unmarked studio, ~/Mortiflix and a bad pack are refused; off without MFX_REPLAY', (t) => {
  const root = setup(t, { marker: false });
  assert.throws(() => replayCheck(root), /REPLAY-STUDIO/);
  assert.throws(() => loadConfig(root), /REPLAY-STUDIO/, 'no config (so nothing runs) in an unmarked studio');
  assert.throws(() => replayCheck(join(homedir(), 'Mortiflix')), /refuses the default studio/);
  writeFileSync(join(root, MARKER), 'x');
  const keep = process.env.MFX_REPLAY;
  process.env.MFX_REPLAY = root; // no replay.json there
  assert.throws(() => replayCheck(root), /no replay.json/);
  process.env.MFX_REPLAY = keep;
  assert.equal(replayCheck(root), true);
  delete process.env.MFX_REPLAY;
  assert.equal(loadConfig(root).backend, 'claude-code', 'off: the saved backend, untouched');
  assert.notEqual(kgCommand(root)[1], KG_STUB);
  process.env.MFX_REPLAY = keep;
});

test('replay config: replay backend, the Claude and Kinetograph stand-ins, Video Notes inside the studio', (t) => {
  const root = setup(t);
  saveConfig(root, { videoNotes: { enabled: true, folder: join(homedir(), 'video-notes') }, browser: { cdpUrl: 'http://127.0.0.1:9333' } });
  const c = loadConfig(root);
  assert.equal(c.backend, 'replay');
  assert.equal(c.claudeBin, CLAUDE_STUB);
  assert.equal(c.browser, undefined, 'no studio browser');
  assert.ok(c.videoNotes.folder.startsWith(root), 'the owner\'s tablet folder is never used');
  assert.deepEqual(kgCommand(root), [process.execPath, KG_STUB]);
  // the tablet fault is a state: offline while armed, back when cleared
  mkdirSync(join(root, 'run'), { recursive: true });
  writeFileSync(join(root, 'run', 'replay-faults.json'), JSON.stringify({ tablet: 1 }));
  assert.equal(loadConfig(root).videoNotes.folder, '/proc/mfx-replay-tablet-offline');
  assert.equal(loadConfig(root).videoNotes.folder, '/proc/mfx-replay-tablet-offline', 'reading the config does not use it up');
  writeFileSync(join(root, 'run', 'replay-faults.json'), '{}');
  assert.ok(loadConfig(root).videoNotes.folder.startsWith(root));
  const r = spawnSync(process.execPath, [CLAUDE_STUB, '-p', '--output-format', 'json'], { input: 'hello', encoding: 'utf8', env: { ...process.env, MORTIFLIX_STUDIO: root } });
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.is_error, true); assert.equal(j.total_cost_usd, 0); assert.equal(j.usage.input_tokens, 0);
});

test('fail closed: the real Claude backend and a real ElevenLabs client refuse; the network is blocked but for the recorded ElevenLabs', async (t) => {
  const root = setup(t);
  await assert.rejects(claudeCode.run({ root, workdir: root, prompt: 'x', env: {}, transcript: join(root, 't.jsonl'), onActivity: () => {}, config: loadConfig(root) }), /must never be reached/);
  assert.throws(() => new ElevenLabs({ key: 'k', fetch: async () => new Response('') }), /must never be reached/);
  assert.throws(() => refuseReal('x'), /must never be reached/);
  installReplayFetch(() => root);
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }), /blocked/);
  await assert.rejects(fetch('http://127.0.0.1:9333/json/version'), /blocked/, 'not even the studio browser');
  const el = new ElevenLabs({ key: 'fake' }); // the stand-in fetch is allowed
  assert.ok(el);
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200); assert.equal(res.headers.get('character-cost'), '0');
  assert.ok((await res.arrayBuffer()).byteLength > 100);
  // billing fault: one 402, then it works again
  writeFileSync(join(root, 'run', 'replay-faults.json'), JSON.stringify({ billing: 1 }));
  assert.equal((await fetch('https://api.elevenlabs.io/v1/music', { method: 'POST' })).status, 402);
  assert.equal((await fetch('https://api.elevenlabs.io/v1/music', { method: 'POST' })).status, 200);
  assert.equal(takeFault(root, 'billing'), false);
});

test('the ledger books replay rows with zero spend', (t) => {
  const root = setup(t);
  record(root, { provider: 'elevenlabs', kind: 'sfx', credits: 120, project: 'p' });
  record(root, { provider: 'claude', kind: 'call', input_tokens: 5000, output_tokens: 900, project: 'p' });
  const rows = readRows(root);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.replay === true));
  assert.equal(rows[0].credits, 0); assert.equal(rows[1].input_tokens, 0); assert.equal(rows[1].output_tokens, 0);
});

test('replay walks v3 to delivered and a real final.mp4; a lost login pauses and Resume carries on; nothing paid', async (t) => {
  const root = setup(t);
  installReplayFetch(() => root);
  const pack = JSON.parse(readFileSync(join(PACK, 'replay.json'), 'utf8'));
  const p = createProject(root, { pipeline: 'v3', title: pack.project.title, answers: pack.project.answers });
  startProject(root, p.id);
  const id = p.id;
  const work = projectPaths(root, id).work;
  saveConfig(root, { replayDelayMs: 0 });
  // ArtCraft's CLI is the app's: stood in here like v3-walk does
  const studio = { ...replayStudio(root), writeArtcraft: (r, pid) => { const f = join(projectPaths(r, pid).state, 'v3.mortiflix'); writeFileSync(f, '{}'); return { file: f, clips: 2, sound: 1, markers: 2, captions: 0 }; } };
  const runner = new Runner(root, { studio });
  runner.acquire();
  t.after(() => runner.release());
  const view = () => stepView(loadProject(root, id), projectPipeline(root, id));
  const reviewing = () => view().find((s) => s.state === 'in_review');
  const approve = (extra = {}) => { const s = reviewing(); return respond(root, id, s.key, s.version, { verdict: 'approve', ...extra }); };

  // the login fault on the first session: paused with cause login, nothing submitted
  writeFileSync(join(root, 'run', 'replay-faults.json'), JSON.stringify({ login: 1 }));
  await runner.loop();
  let pr = loadProject(root, id);
  assert.equal(pr.state, 'paused');
  assert.equal(pr.needs_you?.cause, 'login', JSON.stringify(pr.needs_you));
  update(root, id, (x) => { x.state = 'queued'; x.needs_you = null; x.queued_at = new Date().toISOString(); });

  await runner.loop(); assert.equal(reviewing()?.key, 'brief'); approve();
  await runner.loop(); assert.equal(reviewing().key, 'script');
  // Fix with notes: v2 answers the note
  respond(root, id, 'script', 1, { verdict: 'changes', notes: [{ item: 0, text: 'shorter' }] });
  await runner.loop(); assert.equal(reviewing().key, 'script'); assert.equal(reviewing().version, 2); approve();
  // cost first: the voice waits for the owner's OK on its estimate, then goes on (svc/paidgate.mjs)
  await runner.loop();
  pr = loadProject(root, id);
  if (pr.needs_you?.kind === 'cost_ok') {
    assert.equal(pr.needs_you.step, 'voice');
    confirmCost(root, id, 'voice');
    await runner.loop();
  }
  assert.equal(reviewing().key, 'voice');
  assert.ok(existsSync(join(work, 'music', 'cues.json')), 'the music plan came from the recorded answer');
  // the voice step makes the music (cost first, the recorded Eleven Music answers); the last cue OK approves the step
  const music = musicHandlers({ root, ProtocolError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } }, needProject: () => id });
  for (const c of JSON.parse(readFileSync(join(work, 'music', 'cues.json'), 'utf8')).cues) await music['music.cue.make']({ cue: c.id, confirm: true });
  for (const c of JSON.parse(readFileSync(join(work, 'music', 'cues.json'), 'utf8')).cues) music['music.cue.ok']({ cue: c.id });
  if (reviewing()?.key === 'voice') approve();
  update(root, id, (q) => { q.mfx = { ...(q.mfx || {}), look_brief: pack.look_brief, motion_brief: pack.motion_brief }; settle(q, projectPipeline(root, id)); });
  // the Look in rounds, as the app checks it: OK each frame (one Fix first: a new recorded version), then the step
  await runner.loop(); assert.equal(reviewing().key, 'style-frames');
  let fixed = false;
  for (let i = 0; i < 12; i++) {
    const fv = framesView(root, id);
    const r = fv.frames.find((f) => f.state === 'review');
    if (!r) break;
    if (!fixed) { await fixFrame(root, id, r.id, { text: 'bigger title' }); fixed = true; } else okFrame(root, id, r.id);
    if (view().find((x) => x.key === 'style-frames').state === 'changes') await runner.loop();
  }
  assert.ok(framesView(root, id).frames.every((f) => f.state === 'ok'), JSON.stringify(framesView(root, id).frames.map((f) => [f.id, f.state, f.version])));
  assert.ok(framesView(root, id).frames.some((f) => f.version === 2), 'the Fix made a v2');
  if (reviewing()?.key === 'style-frames') approve();
  await runner.loop(); assert.equal(reviewing().key, 'stills', 'stills drawn by the real studio code, recorded pictures'); approve();
  // motion: the render fault first (paused with the reason), then scene by scene
  writeFileSync(join(root, 'run', 'replay-faults.json'), JSON.stringify({ render: 1 }));
  await runner.loop();
  pr = loadProject(root, id);
  assert.match(pr.needs_you?.text || '', /render failed/);
  update(root, id, (x) => { x.state = 'queued'; x.needs_you = null; x.queued_at = new Date().toISOString(); });
  await runner.loop();
  assert.equal(reviewing().key, 'animatic');
  for (let i = 0; i < 6 && reviewing()?.key === 'animatic' && sceneGet(root, id).scenes.some((s) => s.state !== 'ok'); i++) {
    const sc = sceneGet(root, id).scenes.find((s) => s.state === 'review') || sceneGet(root, id).scenes.find((s) => s.state !== 'ok');
    approveScene(root, id, sc.beat);
    if (view().find((x) => x.key === 'animatic').state === 'changes') await runner.loop();
  }
  assert.ok(existsSync(join(work, 'out', 'animatic.mp4')));
  approve();
  await runner.loop(); assert.equal(reviewing().key, 'sound', 'the real sound plan and mix'); approve();
  await runner.loop(); assert.equal(reviewing().key, 'artcraft'); approve();
  assert.equal(loadProject(root, id).state, 'delivered');

  // the final: real ffmpeg through the render queue
  const fin = finalHandlers({ root, needProject: (x) => x.project, queue: runner.renders });
  fin['final.make']({ project: id });
  for (let i = 0; i < 300 && fin['final.status']({ project: id }).state === 'rendering'; i++) await new Promise((ok) => setTimeout(ok, 100));
  const st = fin['final.status']({ project: id });
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.ok(st.length_sec > 3);

  // nothing paid: every ledger row is a replay row with no credits or tokens
  const rows = readRows(root);
  assert.ok(rows.every((r) => r.replay === true && !(r.credits > 0) && !(r.input_tokens > 0) && !(r.output_tokens > 0)), JSON.stringify(rows.slice(0, 3)));
  assert.ok(!readFileSync(join(root, 'run', 'replay', 'log.jsonl'), 'utf8').includes('"blocked-fetch"'), 'no network call was even tried');
});
