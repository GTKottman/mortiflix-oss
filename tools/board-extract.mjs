#!/usr/bin/env node
// Copies the owner's design principles out of the Reddit-to-YouTube board into the three files the style frames and
// stills prompts read, WORD FOR WORD (pipelines/v3/design/PRINCIPLES.md, STILLS.md, INSPECTION.md). The service never
// reads the 1,588-line board at runtime. Re-run when the board changes: it prints a diff, so a change is never silent.
//   node tools/board-extract.mjs [board.md] [--out dir] [--check]
// --check writes nothing and exits 1 when the files on disk differ from what the board gives.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BOARD = join(homedir(), 'Documents/programs/mortiflix-app/docs/REDDIT-TO-YOUTUBE-BOARD.md');
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, '..', 'pipelines', 'v3', 'design');

// The note lines of one board section, with the "> " quote mark taken off and nothing else changed.
export function sectionNote(md, heading) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.replace(/\s+$/, '') === `## ${heading}`);
  if (at < 0) throw new Error(`the board has no section "${heading}"`);
  const out = [];
  let inNote = false;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) break;
    if (/^Note, in the person's own words:/.test(l)) { inNote = true; continue; }
    if (/^Wires (in|out)/.test(l)) break;
    if (inNote) out.push(l.replace(/^> ?/, ''));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  if (!out.length) throw new Error(`the section "${heading}" has no note`);
  return out.join('\n');
}

const pick = (note, starts) => {
  const found = starts.map((s) => note.split('\n').find((l) => l.startsWith(s)));
  const miss = starts.filter((_, i) => !found[i]);
  if (miss.length) throw new Error(`missing board lines: ${miss.join(' | ')}`);
  return found;
};

const HEAD = (what) => `<!-- Copied word for word from the owner's board (REDDIT-TO-YOUTUBE-BOARD.md) by tools/board-extract.mjs. ${what} Do not edit here: edit the board and run the script again. -->\n`;

export function extract(md) {
  const sec = (h) => `## ${h}\n\n${sectionNote(md, h)}\n`;
  const must = pick(sectionNote(md, 'Must include:'), ['Meaningful kinetic typography and visual metaphors']);
  const plan = pick(sectionNote(md, 'Plan all scenes and transitions before coding'), ['Initial visual state.', 'Final visual state.', 'Transition into the next scene.']);
  return {
    'PRINCIPLES.md': `${HEAD('Used by the style frame writer, every round.')}\n# Design principles\n\n${['Seven elements of art', 'Principles of design', 'Rules of composition', 'Establish the visual identity'].map(sec).join('\n')}\n## Must include (one line)\n\n${must[0]}\n`,
    'STILLS.md': `${HEAD('Used by the stills writer.')}\n# Scene stills\n\n${sec('Generate scene stills')}\n## From "Plan all scenes and transitions before coding" (what each scene's stills show)\n\n${plan.join('\n')}\n`,
    'INSPECTION.md': `${HEAD('Used by the AI inspection.')}\n# Inspection\n\n${sec('Inspection!!')}`,
  };
}

// A line-based diff, small and readable: "- removed" / "+ added" lines only.
export function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const inB = new Set(B), inA = new Set(A);
  return [...A.filter((l) => !inB.has(l) && l.trim()).map((l) => `- ${l}`), ...B.filter((l) => !inA.has(l) && l.trim()).map((l) => `+ ${l}`)];
}

export function run({ board = DEFAULT_BOARD, out = DEFAULT_OUT, check = false, log = console.log } = {}) {
  const files = extract(readFileSync(board, 'utf8'));
  let changed = 0;
  for (const [name, text] of Object.entries(files)) {
    const f = join(out, name);
    const old = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (old === text) { log(`${name}: unchanged`); continue; }
    changed++;
    log(`${name}: ${old ? 'CHANGED' : 'new'}`);
    for (const d of diffLines(old, text).slice(0, 60)) log(`  ${d}`);
    if (!check) { mkdirSync(out, { recursive: true }); writeFileSync(f, text); }
  }
  return { changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const o = args.indexOf('--out');
  const out = o >= 0 ? args.splice(o, 2)[1] : DEFAULT_OUT;
  const check = args.includes('--check');
  const board = args.find((a) => !a.startsWith('--')) || DEFAULT_BOARD;
  try { process.exit(run({ board, out, check }).changed && check ? 1 : 0); } catch (e) { console.error(e.message); process.exit(2); }
}
