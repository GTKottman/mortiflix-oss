// One new scene by the studio, not a session: which scenes come here, and how the scene joins the video. No AI, no render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToMain, sceneSchema, sceneSpan } from '../src/quickscene.mjs';
import { REVIEW_SCHEMA, WRITE_SCHEMA } from '../src/quickanimatic.mjs';

const MAIN = `import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { SCENES } from './timing';
import { B01 } from './scenes/m_b01';

export const Main = () => (
  <AbsoluteFill>
    <Audio src={staticFile('mix.wav')} />
    <Sequence from={SCENES.b01.from} durationInFrames={SCENES.b01.frames}>
      <B01 />
    </Sequence>
  </AbsoluteFill>
);
`;

test('the scene joins Main after the scenes in it, once', () => {
  const once = addToMain(MAIN, 'b02');
  assert.match(once, /import \{ B01 \} from '\.\/scenes\/m_b01';\nimport \{ B02 \} from '\.\/scenes\/m_b02';/);
  assert.ok(once.indexOf('<B01 />') < once.indexOf('<B02 />'));
  assert.ok(once.indexOf('<B02 />') < once.indexOf('</AbsoluteFill>'));
  assert.equal(addToMain(once, 'b02'), once);
});

test('a Main with no scenes yet is not guessed at: that scene stays a session', () => {
  assert.equal(addToMain("import { Sequence } from 'remotion';\n", 'b01'), null);
});

test('the scene keeps the frames of the project clock', () => {
  const ts = 'export const SCENES = {\n  b01: { from: 0, frames: 258 },\n  b02: { from: 258, frames: 152 },\n};';
  assert.deepEqual(sceneSpan(ts, 'b02'), { from: 258, to: 410 });
  assert.equal(sceneSpan(ts, 'b09'), null);
});

test('the answer shapes accept the scene file (Texas b07: the shared list refused it)', () => {
  for (const schema of [WRITE_SCHEMA, REVIEW_SCHEMA]) {
    assert.deepEqual(sceneSchema(schema, 'b07').properties.files.items.properties.path.enum, ['src/scenes/m_b07.tsx']);
    assert.equal(sceneSchema(schema, 'b07').required, schema.required);
  }
});
