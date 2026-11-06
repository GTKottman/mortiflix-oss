import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captionText, moneyHints } from '../src/svc/captionform.mjs';
import { speechRegions } from '../src/svc/elmusic.mjs';
import { checkFinalAudio } from '../src/svc/finalaudio.mjs';

test('captions use the written form', () => {
  const forms = [{ spoken: 'character a i', written: 'Character.AI' }];
  const money = moneyHints('"−$8–9M a month" and "Disney · $20M" and "20M+ monthly users"');
  assert.equal(captionText('Character A I has over twenty million monthly users.', forms, money), 'Character.AI has over 20 million monthly users.');
  assert.equal(captionText('On October twelfth it filed, losing eight to nine million a month.', forms, money), 'On October 12 it filed, losing $8–9 million a month.');
  assert.equal(captionText("Disney's twenty-million-dollar deal.", forms, money), "Disney's $20 million deal.");
  assert.equal(captionText('Forty attorneys general, two cats.', forms, money), '40 attorneys general, two cats.');
});

test('music ducks per voice line, not over the whole narration', () => {
  const t = { lines: [{ start: 0, end: 4, words: [{ start: 0, end: 4 }] }, { start: 4.3, end: 9, words: [{ start: 4.3, end: 9 }] }] };
  assert.equal(speechRegions(t).length, 1); // the old 0.6 s gap joins them
  assert.equal(speechRegions(t, { gap: 0.25, pad: 0.05, lines: true }).length, 2);
});

test('final-pass check fails when approved sounds or music are missing', () => {
  const w = mkdtempSync(join(tmpdir(), 'fa-'));
  for (const d of ['sound', 'music', 'out/sound']) mkdirSync(join(w, d), { recursive: true });
  const fx = join(w, 'fx1.wav'); writeFileSync(fx, 'x');
  writeFileSync(join(w, 'music', 'm1.mp3'), 'x');
  writeFileSync(join(w, 'sound', 'sfx-plan.json'), JSON.stringify({ cues: [{ id: 'fx1', status: 'ok', file: fx }, { id: 'fx2', status: 'cut' }] }));
  writeFileSync(join(w, 'music', 'cues.json'), JSON.stringify({ cues: [{ id: 'mc1', file: 'music/m1.mp3' }] }));
  assert.equal(checkFinalAudio(w).pass, false); // nothing built
  writeFileSync(join(w, 'out', 'sound', 'final-audio.json'), JSON.stringify({ music: [], sfx: [], lufs: -14, true_peak: -1.5 }));
  const bad = checkFinalAudio(w);
  assert.equal(bad.pass, false);
  assert.match(bad.problems.join(' '), /1 approved sound is missing/);
  assert.match(bad.problems.join(' '), /1 music cue is missing/);
  writeFileSync(join(w, 'out', 'sound', 'final-audio.json'), JSON.stringify({ music: ['mc1'], sfx: ['fx1'], lufs: -14.2, true_peak: -1.3 }));
  assert.equal(checkFinalAudio(w).pass, true);
  writeFileSync(join(w, 'out', 'sound', 'final-audio.json'), JSON.stringify({ music: ['mc1'], sfx: ['fx1'], lufs: -14.2, true_peak: 0.6 }));
  assert.match(checkFinalAudio(w).problems.join(' '), /true peak 0.6/);
});

test('quoted lines and sounds peaking over the voice', async () => {
  const { isQuote } = await import('../src/svc/finalaudio.mjs');
  assert.equal(isQuote('New York Attorney General Letitia James: This company has collected some of the most private thoughts.'), true);
  assert.equal(isQuote('He said “no”.'), true);
  assert.equal(isQuote('Disney\'s deal leaves the data out. No one has bid on it yet.'), false);
  const w = mkdtempSync(join(tmpdir(), 'fa-'));
  for (const d of ['sound', 'out/sound']) mkdirSync(join(w, d), { recursive: true });
  const fx = join(w, 'fx1.wav'); writeFileSync(fx, 'x');
  writeFileSync(join(w, 'sound', 'sfx-plan.json'), JSON.stringify({ cues: [{ id: 'fx1', status: 'ok', file: fx }] }));
  writeFileSync(join(w, 'out', 'sound', 'final-audio.json'), JSON.stringify({ music: [], sfx: ['fx1'], lufs: -14, true_peak: -1.5, voice: { lufs: -14, peak_db: -1.5 }, sfx_levels: [{ id: 'fx1', peak_db: 4.5 }] }));
  assert.match(checkFinalAudio(w).problems.join(' '), /1 sound peaks above the voice \(fx1 4.5 dB/);
});

test('an explaining colon is not a quote', async () => {
  const { isQuote } = await import('../src/svc/finalaudio.mjs');
  assert.equal(isQuote('The verdict: neither pressure nor friction plays a big part.'), false);
  assert.equal(isQuote("It's dipoles: water molecules have a partly positive end."), false);
  assert.equal(isQuote('New York Attorney General Letitia James: This company has collected...'), true);
});

test('sync runs from the motion code when the render gave no key words', async () => {
  const { codeKeys } = await import('../src/svc/artcraft.mjs');
  const w = mkdtempSync(join(tmpdir(), 'ck-'));
  mkdirSync(join(w, 'video/src'), { recursive: true });
  writeFileSync(join(w, 'video/src/timing.ts'), 'export const W = {\n  slippery: f(1.28), // 38\n  september: g(10.218), // 19\n};\n');
  const timing = { lines: [{ id: 'b01-1', text: 'Why is ice so slippery?', words: [{ text: 'Why', start: 0 }, { text: 'slippery?', start: 1.28 }] }, { id: 'b02-1', text: 'Plymouth voted.', words: [{ text: 'Plymouth', start: 5 }, { text: 'voted.', start: 5.5 }] }] };
  const r = codeKeys(w, [], timing, 30);
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].word, 'slippery');
  assert.match(r.items[0].text, /Nothing in the motion is timed on "Plymouth"/);
});
