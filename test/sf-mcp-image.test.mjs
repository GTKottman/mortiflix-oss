// Style frames v3, version 11: the Video Notes MCP (python, no dependencies) adds pictures. Driven over stdio with a temp folder
// (VIDEO_NOTES_DIR): never the owner's real Video Notes. Needs python3 and ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { encodePng } from '../src/svc/png.mjs';

const MCP = join(homedir(), 'Documents/programs/video-notes/mcp/video_notes_mcp.py');
const ok = existsSync(MCP) && spawnSync('python3', ['--version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

function rpc(dir, calls) {
  const input = ['{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}', ...calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: c[0], arguments: c[1] } }))].join('\n') + '\n';
  const r = spawnSync('python3', [MCP], { input, encoding: 'utf8', env: { ...process.env, VIDEO_NOTES_DIR: dir }, timeout: 120_000 });
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  return { init: out[0].result, results: out.slice(1).map((o) => ({ text: o.result.content.map((c) => c.text).join('\n'), err: o.result.isError })) };
}

test('MCP: add_image queues a picture (kind image, w/h, group, ok_words, 1-second video); get_notes says Still image; add_video carries ok_words', { skip: !ok }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vnmcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = join(dir, 'frame.png');
  writeFileSync(png, encodePng(320, 180, new Uint8Array(320 * 180 * 4).fill(180)));
  const { init, results } = rpc(dir, [
    ['add_image', { path: png, title: 'Frame 1', project: 'Black October', look_for: 'Frame 1 of 3.', group: 'Black October · Look', group_index: 1, group_count: 3, ok_words: { notes: 'OK · Remake this frame', none: 'OK · Next frame' } }],
    ['queue', {}],
  ]);
  assert.match(init.instructions, /single picture use add_image/);
  assert.equal(results[0].err, false, results[0].text);
  const q = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')).items[0];
  assert.equal(q.kind, 'image'); assert.equal(q.w, 320); assert.equal(q.h, 180);
  assert.deepEqual([q.group, q.group_index, q.group_count], ['Black October · Look', 1, 3]);
  assert.deepEqual(q.ok_words, { notes: 'OK · Remake this frame', none: 'OK · Next frame' });
  assert.equal(q.duration_s, 1); assert.equal(q.video, `${q.id}/video.mp4`);
  for (const f of ['image.png', 'video.mp4', 'poster.jpg', 'audio.wav']) assert.ok(existsSync(join(dir, q.id, f)), f);
  assert.match(results[1].text, /"kind": "image"/);
  // a note on it: get_notes says Still image, no frame number
  mkdirSync(join(dir, q.id), { recursive: true });
  writeFileSync(join(dir, q.id, 'notes.json'), JSON.stringify([{ n: 1, id: 'a', f: 0, t: 0, text: 'Headline too small.' }]));
  const g = rpc(dir, [['get_notes', { id: q.id }]]).results[0].text;
  assert.match(g, /Still image reviewed:/); assert.match(g, /## 1\. Still image/); assert.match(g, /Note: Headline too small\./); assert.ok(!/Frame 0/.test(g));
  // add_video: defaults the OK words
  const mp4 = join(dir, 'c.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mp4]);
  const v = rpc(dir, [['add_video', { path: mp4, title: 'Vid' }], ['add_video', { path: mp4, title: 'Scene 2', ok_words: { notes: 'OK · Remake scene 2', none: 'OK · Next scene' } }]]);
  const items = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')).items;
  assert.deepEqual(items.find((i) => i.title === 'Vid').ok_words, { notes: 'OK · Send my notes', none: 'OK' });
  assert.deepEqual(items.find((i) => i.title === 'Scene 2').ok_words, { notes: 'OK · Remake scene 2', none: 'OK · Next scene' });
  assert.ok(!('kind' in items.find((i) => i.title === 'Vid')), 'a video item has no kind (missing = video)');
});
