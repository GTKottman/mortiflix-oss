// The roughness check (pipelines/_shared/skills/music/lib/roughness.mjs): partials measured from a played note, low
// close intervals reported, high ones and octaves not, and a bell's own partials heard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrumOf, checkRoughness, notesRough, HARMONIC, LIMIT } from '../pipelines/_shared/skills/music/lib/roughness.mjs';

const SR = 44100;
const tone = (hz, partials, sec = 1) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => partials.reduce((s, [r, a]) => s + a * Math.sin(2 * Math.PI * hz * r * i / SR), 0) / 4);
const man = (tracks) => ({ beats_per_bar: 4, bars: 2, tracks });
const part = (channel, name, notes) => ({ channel, name, kind: 'pitched', notes: notes.map(([pitch, start, dur]) => ({ pitch, start, dur, velocity: 127 })) });

test('spectrumOf: a harmonic tone measures as its partials, a bell as its own inharmonic ones', () => {
  const s = spectrumOf(tone(220, [[1, 1], [2, 0.5], [3, 0.25]]), SR, 220);
  assert.deepEqual(s.map(([r]) => Math.round(r * 100) / 100), [1, 2, 3]);
  assert.ok(Math.abs(s[1][1] - 0.5) < 0.03 && Math.abs(s[2][1] - 0.25) < 0.03);
  const bell = spectrumOf(tone(440, [[1, 1], [2.76, 0.6], [5.4, 0.4]]), SR, 440);
  assert.ok(bell.some(([r]) => Math.abs(r - 2.76) < 0.01) && bell.some(([r]) => Math.abs(r - 5.4) < 0.01), JSON.stringify(bell));
  assert.equal(spectrumOf(new Float32Array(SR), SR, 220), null);
});

test('the line sits at the classic low interval limits', () => {
  const x = (a, b) => notesRough(a, HARMONIC, 1, b, HARMONIC, 1) / LIMIT;
  assert.ok(x(36, 40) > 1, 'a major third at C2 is mud');
  assert.ok(x(60, 64) < 1, 'a major third at C4 is clear');
  assert.ok(x(45, 50) < 1 && x(60, 65) < 1, 'fourths from A2 up are clear');
});

test('checkRoughness: a low close third between two parts is reported once, with its place; high thirds and octaves are not', () => {
  const r = checkRoughness(man([part(1, 'Bass', [[36, 0, 4], [48, 4, 4]]), part(2, 'Pad', [[40, 0, 4], [60, 4, 4], [64, 4, 4]])]));
  assert.equal(r.rough.length, 1, JSON.stringify(r.rough));
  assert.deepEqual({ a: r.rough[0].a, b: r.rough[0].b, at: r.rough[0].at }, { a: 'Bass C2', b: 'Pad E2', at: 'bar 1 beat 1' });
  assert.match(r.warnings[0], /^Sounds rough in 1 place .*Bass C2 with Pad E2 at bar 1 beat 1 \(×\d/);
});

test('checkRoughness: drums and semitone rubs are left to other checks; a part never clashes with itself', () => {
  const r = checkRoughness(man([part(1, 'Bass', [[36, 0, 4], [40, 0, 4]]), part(2, 'Pad', [[37, 0, 4]]), { channel: 10, name: 'Drums', kind: 'drums', notes: [{ pitch: 38, start: 0, dur: 1, velocity: 127 }] }]));
  assert.ok(!r.rough.some((x) => /C#2/.test(x.b) && /C2/.test(x.a)), 'the C2/C#2 rub is the harmony lock\'s');
  assert.ok(!r.rough.some((x) => x.a === 'Bass C2' && x.b === 'Bass E2'));
  assert.ok(!r.rough.some((x) => /Drums/.test(x.a + x.b)));
});

test('checkRoughness hears the instrument: the same interval is rougher on a buzzy part than on a pure one', () => {
  const m = man([part(1, 'Low', [[48, 0, 4]]), part(2, 'High', [[52, 0, 4]])]);
  const pure = [{ pitch: 50, spectrum: [[1, 1]] }];
  const buzzy = [{ pitch: 50, spectrum: Array.from({ length: 12 }, (_, k) => [k + 1, 0.95 ** k]) }];   // bright: 12 strong partials
  assert.equal(checkRoughness(m, { 1: pure, 2: pure }).rough.length, 0);
  assert.equal(checkRoughness(m, { 1: buzzy, 2: buzzy }).rough.length, 1);
});

test('tension per scene: chord roughness ranks triads < 7ths < 9ths, and a plan that ignores the owner\'s tension is sent back', async () => {
  const { chordRoughness, tensionProblems } = await import('../src/music/compose.mjs');
  assert.ok(chordRoughness('C') < chordRoughness('Cmaj7') && chordRoughness('Cmaj7') < chordRoughness('C9'));
  assert.ok(Math.abs(chordRoughness('C') - chordRoughness('F#')) < 1e-9, 'only the chord\'s kind counts, not its key');
  const scenes = [{ key: 's01', beat: 'b01' }, { key: 's02', beat: 'b02' }, { key: 's03', beat: 'b03' }];
  const plan = (a, b) => ({ sections: [{ name: 'Calm', chords: a }, { name: 'Storm', chords: b }, { name: 'Free', chords: ['Bb13'] }] });
  assert.deepEqual(tensionProblems(plan(['C', 'F'], ['Am9', 'E7b9']), scenes, { b01: 0.1, b02: 0.9 }), []);
  const p = tensionProblems(plan(['Cmaj9', 'F13'], ['Am', 'E']), scenes, { b01: 0.1, b02: 0.9 });
  assert.equal(p.length, 1);
  assert.match(p[0], /^sections\[1\] "Storm": the owner asked more harmonic tension here \(0\.9\) than in sections\[0\] "Calm" \(0\.1\)/);
  assert.deepEqual(tensionProblems(plan(['Cmaj9'], ['Am']), scenes, { b01: 0.5, b02: 0.6 }), [], 'under 0.3 apart: the AI\'s call');
  assert.deepEqual(tensionProblems(plan(['Cmaj9'], ['Am']), scenes, {}), [], 'no tension set: nothing asked');
});

test('a cue keeps its tension (0..1, tenths; unset = the AI\'s)', async (t) => {
  const { tempStudio } = await import('./helpers.mjs');
  const { createProject } = await import('../src/projects.mjs');
  const { setCuePlan, loadTheme } = await import('../src/svc/theme.mjs');
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Tension', answers: { topic: 'storms' } });
  assert.equal(setCuePlan(root, p.id, 'm02', { tension: 0.87 }).tension, 0.9);
  assert.equal(setCuePlan(root, p.id, 'm03', { energy: 4 }).tension, null);
  assert.equal(setCuePlan(root, p.id, 'm02', { tension: 7 }).tension, 1);
  assert.equal(loadTheme(root, p.id).cues.find((c) => c.id === 'm02').tension, 1);
});
