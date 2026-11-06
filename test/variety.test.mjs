// A full piece is a full arrangement (at least 6 parts) and not the last piece again (key, tempo, opening progression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { REPO } from '../src/studio.mjs';
import { partsProblems, varietyProblems, opening, MIN_PARTS } from '../pipelines/_shared/skills/music/lib/variety.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { writeTorch, prepareWorkdir } from '../src/torch.mjs';

const GENRE = { name: 'Trip hop', lineup: [{ role: 'Breakbeat drums' }, { role: 'Dub bass' }, { role: 'Strings' }] };
const roles = (n) => Array.from({ length: n }, (_, i) => ({ channel: i === n - 1 ? 10 : i + 1, harmony: i === n - 1 ? 'drums' : 'chords', name: `Part ${i + 1}` }));
const BP = { title: 'Fog', bpm: 88, meter: '4/4', bars: 96, scale: 'A minor', chart: [{ bars: [1, 8], chords: ['Am9', ['Fmaj7', 'G'], 'Em7', 'Am9'] }], roles: roles(7) };

test('variety: a full piece needs 6 parts; a loop kit or a brief-fixed small piece may be leaner', () => {
  assert.equal(MIN_PARTS, 6);
  assert.deepEqual(partsProblems(BP, GENRE), []);
  assert.match(partsProblems({ ...BP, roles: roles(4) }, GENRE)[0], /4 parts is a sketch[\s\S]*at least 6[\s\S]*Breakbeat drums, Dub bass, Strings/);
  assert.deepEqual(partsProblems({ ...BP, roles: roles(4), loops: true }, GENRE), []);
  assert.deepEqual(partsProblems({ ...BP, roles: roles(4), length_fixed: true }, GENRE), []);
  assert.deepEqual(partsProblems({ ...BP, roles: roles(4) }, null), []); // no genre researched: not a full song
});

test('variety: the same key, tempo and opening as a recent piece is refused; two of three is a warning', () => {
  assert.deepEqual(opening(BP), ['am9', 'fmaj7', 'g', 'em7']);
  const twin = { title: 'Harbour', scale: 'A:minor', bpm: 90, opening: ['Am9', 'Fmaj7', 'G', 'Em7'] };
  const v = varietyProblems(BP, [twin]);
  assert.match(v.errors[0], /"Harbour" again: the same key \(A minor\), tempo \(88 vs 90 BPM\) and opening progression/);
  const close = varietyProblems(BP, [{ ...twin, opening: ['Dm', 'C', 'Bb', 'A'] }]);
  assert.deepEqual(close.errors, []);
  assert.match(close.warnings[0], /close to "Harbour" \(same key A minor, 90 BPM\)/);
  assert.deepEqual(varietyProblems(BP, [{ ...twin, scale: 'D dorian', bpm: 120, opening: ['Dm7'] }]), { errors: [], warnings: [] });
});

test('variety: `strudel.mjs plan` holds a full piece to both', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-variety-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'music'));
  const plan = (bp, recent) => {
    writeFileSync(join(dir, 'music/blueprint.json'), JSON.stringify(bp));
    writeFileSync(join(dir, 'music/genre.json'), JSON.stringify(GENRE));
    writeFileSync(join(dir, 'music/recent.json'), JSON.stringify({ pieces: recent }));
    return spawnSync(process.execPath, [join(REPO, 'pipelines/_shared/skills/music/strudel.mjs'), 'plan'], { cwd: dir, encoding: 'utf8' });
  };
  const sections = [{ name: 'Fog on the water', start_bar: 1, end_bar: 96, function: 'one long rise from nothing', intensity: 5 }];
  const thin = plan({ ...BP, sections, roles: roles(4), length_fixed: false }, []);
  assert.match(thin.stdout, /4 parts is a sketch/);
  const twin = plan({ ...BP, sections }, [{ title: 'Harbour', scale: 'A minor', bpm: 88, opening: ['Am9', 'Fmaj7', 'G', 'Em7'] }]);
  assert.match(twin.stdout, /"Harbour" again/);
  const fine = plan({ ...BP, sections }, [{ title: 'Harbour', scale: 'C major', bpm: 120, opening: ['C'] }]);
  assert.doesNotMatch(fine.stdout, /sketch|again/);
});

test('variety: before a session the studio writes the owner\'s recent pieces into the project', (t) => {
  const root = tempStudio(t);
  const a = createProject(root, { pipeline: 'song', title: 'Harbour', answers: { genre: 'trip hop', topic: 'fog' } });
  startProject(root, a.id);
  mkdirSync(join(projectPaths(root, a.id).work, 'music'), { recursive: true });
  writeFileSync(join(projectPaths(root, a.id).work, 'music', 'blueprint.json'), JSON.stringify({ ...BP, title: 'Harbour' }));
  const b = createProject(root, { pipeline: 'song', title: 'Next', answers: { genre: 'trip hop', topic: 'rain' } });
  startProject(root, b.id);
  prepareWorkdir(root, b.id);
  writeTorch(root, b.id, { backend: 'demo', reason: 'test' });
  const w = projectPaths(root, b.id).work;
  const recent = JSON.parse(readFileSync(join(w, 'music', 'recent.json'), 'utf8')).pieces;
  assert.deepEqual(recent.map((r) => [r.title, r.scale, r.bpm, r.parts, r.opening.join(' ')]), [['Harbour', 'A minor', 88, 7, 'am9 fmaj7 g em7']]);
  assert.match(readFileSync(join(w, 'CLAUDE.md'), 'utf8'), /## The owner's last pieces of music \(make this one different\)\n\n- Harbour: A minor, 88 BPM, 4\/4, 96 bars, 7 parts, opens am9 fmaj7 g em7/);
});
