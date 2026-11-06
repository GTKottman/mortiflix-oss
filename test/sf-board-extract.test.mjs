// Style frames v3, version 1: the principles files are the board's words, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extract, sectionNote, run, DEFAULT_BOARD, DEFAULT_OUT } from '../tools/board-extract.mjs';

const BOARD = `## Seven elements of art
Step 7 · id x
Note, in the person's own words:
> Line: a.
> Shape: b.
Wires in: none

## Principles of design
Note, in the person's own words:
> Balance: c.
Wires out: none

## Rules of composition
Note, in the person's own words:
> 1. Rule of Thirds: d.
>
> 40. Compositional Tension: e.
Wires in: none

## Establish the visual identity
Note, in the person's own words:
> Pick a style.
Wires in: none

## Must include:
Note, in the person's own words:
> A cohesive visual design system.
>
> Meaningful kinetic typography and visual metaphors.
Wires in: none

## Plan all scenes and transitions before coding
Note, in the person's own words:
> Initial visual state.
> Final visual state.
> Transition into the next scene.
Wires in: none

## Generate scene stills
Note, in the person's own words:
> Capture:
> - Initial composition.
Wires in: none

## Inspection!!
Note, in the person's own words:
> VISUAL DESIGN
> - Professional appearance.
Wires in: none
`;

test('extract: sections word for word, only the wanted line of Must include', () => {
  const f = extract(BOARD);
  assert.match(f['PRINCIPLES.md'], /Line: a\.\nShape: b\./);
  assert.match(f['PRINCIPLES.md'], /40\. Compositional Tension: e\./);
  assert.match(f['PRINCIPLES.md'], /Meaningful kinetic typography and visual metaphors\./);
  assert.doesNotMatch(f['PRINCIPLES.md'], /cohesive visual design system/);
  assert.match(f['STILLS.md'], /Initial composition\./);
  assert.match(f['STILLS.md'], /Transition into the next scene\./);
  assert.match(f['INSPECTION.md'], /VISUAL DESIGN\n- Professional appearance\./);
  assert.throws(() => sectionNote(BOARD, 'Nope'), /no section/);
});

test('run: writes, prints the diff when the board changes, --check writes nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'be-'));
  writeFileSync(join(dir, 'b.md'), BOARD);
  const out = join(dir, 'out');
  const log = [];
  assert.equal(run({ board: join(dir, 'b.md'), out, log: (l) => log.push(l) }).changed, 3);
  assert.equal(run({ board: join(dir, 'b.md'), out, log: () => {} }).changed, 0);
  writeFileSync(join(dir, 'b.md'), BOARD.replace('Pick a style.', 'Pick two styles.'));
  const log2 = [];
  assert.equal(run({ board: join(dir, 'b.md'), out, check: true, log: (l) => log2.push(l) }).changed, 1);
  assert.ok(log2.some((l) => l.includes('- Pick a style.')) && log2.some((l) => l.includes('+ Pick two styles.')));
  assert.match(readFileSync(join(out, 'PRINCIPLES.md'), 'utf8'), /Pick a style\./); // --check wrote nothing
});

test('the committed files match the owner\'s real board word for word (skipped when the board is not on this machine)', { skip: !existsSync(DEFAULT_BOARD) }, () => {
  const board = readFileSync(DEFAULT_BOARD, 'utf8');
  for (const [name, text] of Object.entries(extract(board))) assert.equal(readFileSync(join(DEFAULT_OUT, name), 'utf8'), text, `${name} is stale: run node tools/board-extract.mjs`);
  // every line of every file (but the headings the script adds) is a line of the board
  const lines = new Set(board.split('\n').map((l) => l.replace(/^> ?/, '')));
  for (const name of ['PRINCIPLES.md', 'STILLS.md', 'INSPECTION.md']) {
    const text = readFileSync(join(DEFAULT_OUT, name), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('<!--'));
    for (const l of text) assert.ok(lines.has(l), `${name}: not in the board: ${l.slice(0, 80)}`);
  }
});
