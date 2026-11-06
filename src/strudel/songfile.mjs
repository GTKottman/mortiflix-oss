// music/song.strudel.js (doc 28 §1, plain Strudel only, owner 2026-10-16): where the song's notes live. It is a normal
// Strudel program: pasted into the Strudel REPL, it plays the song. No helpers of ours, so everything an AI knows about
// Strudel applies to it.
//
//   // "The bet" · 96 BPM · 4/4 · D:dorian
//   setcpm(96 / 4)
//
//   // ch02 · Bass
//   $: arrange(
//     [8, note("<[d2 ~ d2 f2] [c2 ~ c2 e2]>")],   // m01 · Cold open · bars 1–8
//     [8, silence]                               // m02 · The bet · bars 9–16
//   ).midichan(2).s("sawtooth").lpf(600).gain(.8).pan(.5).orbit(2)
//
// - One $: line per part (channel); the channel is its .midichan(n).
// - Strudel's arrange() places the sections: one row per section, [bars, notes], in song order. arrange() starts
//   every row at its own bar 1, so a row's notes are in its section's time and moving a section never changes them.
// - Everything after arrange() is the part's sound (the instruments), the same for every section.
// - A row's notes may be any Strudel: the AI's own code, or an edit's arrange() of the original and hard-coded bars.
import { notesToIdiomatic } from './notes.mjs';
import { walk, closing, partsAt } from './text.mjs';
import { notesFromHaps } from './derive.mjs';

const fmt = (v) => { const s = String(+Number(v).toFixed(4)); return s.startsWith('0.') ? s.slice(1) : s.startsWith('-0.') ? `-${s.slice(2)}` : s; };
const strudelPan = (pan) => fmt(((Number(pan) || 0) + 1) / 2);

// A part's sound, from music/instruments.json (lib/instruments.mjs's format): its sound and methods, mix level, pan,
// and its own effects bus. Drums give each General MIDI number its own sound with .layer().
export function soundTail(part, channel) {
  if (!part) return `.orbit(${channel})`;
  const tail = (v, gain) => `.s(${JSON.stringify(v.sound)})${v.set || ''}.gain(${fmt(gain)}).pan(${strudelPan(part.pan)})`;
  if (part.kit) {
    const layers = Object.entries(part.kit).map(([gm, v]) => `\n    (p) => p.filterValues((v) => v.note === ${Number(gm)})${tail(v, (part.gain ?? 0.8) * (v.gain ?? 1))}`);
    return `.layer(${layers.join(',')}\n  ).orbit(${channel})`;
  }
  return `${tail(part, part.gain ?? 0.8)}.orbit(${channel})`;
}

const barsText = (a, b) => (a === b ? `bar ${a}` : `bars ${a}–${b}`);

// spec: { title, bpm, meter: { num, den }, scale: 'D:dorian' | null, sections: [{ id, name, bars }],
//         parts: [{ channel, name, drums, sound (instruments.json part or null), rows: { [sectionId]: notes } }] }
// A section with no notes for a part is `silence`.
export function buildSongFile(spec) {
  const num = spec.meter?.num ?? 4;
  const den = spec.meter?.den ?? 4;
  const tpb = 960 * 4 * num / den;
  const bpb = 4 * num / den;
  const out = [];
  out.push(`// ${JSON.stringify(spec.title || 'Untitled')} · ${spec.bpm} BPM · ${num}/${den}${spec.scale ? ` · ${spec.scale}` : ''}`);
  out.push('// One cycle is one bar. Each part is one $: line: arrange() places its sections, one row each, [bars, notes].');
  out.push(`setcpm(${spec.bpm} / ${bpb})`);
  for (const part of spec.parts) {
    out.push('', `// ch${String(part.channel).padStart(2, '0')} · ${part.name || 'Part'}`);
    let bar = 1;
    const rows = spec.sections.map((sec) => {
      const notes = part.rows?.[sec.id] || [];
      const music = notes.length ? notesToIdiomatic(notes, { bars: sec.bars, ticksPerBar: tpb, drums: !!part.drums }) : 'silence';
      const row = { text: `[${sec.bars}, ${music.replace(/\n/g, '\n    ')}]`, comment: `${sec.id} · ${sec.name || ''} · ${barsText(bar, bar + sec.bars - 1)}` };
      bar += sec.bars;
      return row;
    });
    const lines = rows.map((r, i) => `  ${r.text}${i < rows.length - 1 ? ',' : ''}   // ${r.comment}`);
    out.push(`$: arrange(\n${lines.join('\n')}\n).midichan(${part.channel})${soundTail(part.sound, part.channel)}`);
  }
  return out.join('\n') + '\n';
}

// The file's parts and rows, with their places in the text:
// { blocks: [{ channel, name, start, end, open, close, rows: [{ bars, text, start, end, section }], tail }], problems }
export function parseSongFile(text) {
  const problems = [];
  const starts = [];
  walk(text, (i, ch, depth) => {
    if (depth === 0 && ch === '$' && text[i + 1] === ':' && (i === 0 || text[i - 1] === '\n')) starts.push(i);
  });
  const blocks = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : text.length;
    const body = text.slice(s, end);
    const before = text.slice(0, s).trimEnd().split('\n').at(-1) || '';
    const name = before.match(/^\/\/\s*ch\d+\s*·\s*(.*)$/)?.[1]?.trim() || null;
    const at = body.search(/arrange\s*\(/);
    if (at < 0) { problems.push(`part ${k + 1} isn't an arrange() of its sections`); return null; }
    const open = s + body.indexOf('(', at);
    const close = closing(text, open);
    if (close < 0 || close > end) { problems.push(`part ${k + 1}: arrange( has no closing bracket`); return null; }
    const rows = partsAt(text, open + 1, close).map((r) => {
      const m = r.text.match(/^\[\s*(\d+)\s*,([\s\S]*)\]$/);
      if (!m) { problems.push(`part ${k + 1}: a row isn't [bars, notes]: ${r.text.slice(0, 40)}`); return null; }
      const lead = r.text.indexOf(',') + 1;
      const inner = m[2];
      const innerStart = r.start + lead + (inner.length - inner.trimStart().length);
      const lineEnd = text.indexOf('\n', r.end);
      const comment = text.slice(r.end, lineEnd < 0 ? text.length : lineEnd).match(/\/\/\s*(\S+)/)?.[1] || null;
      return { bars: Number(m[1]), text: inner.trim(), start: innerStart, end: innerStart + inner.trim().length, rowStart: r.start, rowEnd: r.end, section: comment };
    }).filter(Boolean);
    const tail = text.slice(close + 1, end).trimEnd();
    const channel = Number(tail.match(/^\s*\.midichan\(\s*(\d+)\s*\)/)?.[1]);
    if (!Number.isInteger(channel)) problems.push(`part ${k + 1} has no .midichan(n) right after its arrange()`);
    return { index: k, channel, name, start: s, end, open, close, rows, tail };
  }).filter(Boolean);
  return { blocks, problems };
}

// Replaces one row's notes text (the part at `channel`, section index `row`).
export function setRow(text, channel, row, music) {
  const { blocks } = parseSongFile(text);
  const b = blocks.find((x) => x.channel === channel);
  if (!b || !b.rows[row]) throw new Error(`there is no row ${row + 1} in part ch${channel}`);
  const r = b.rows[row];
  // lines of new music are indented under the row; lines already indented (text read from the file) stay as they are
  const indented = music.split('\n').map((l, i) => (i && !/^ {4}/.test(l) ? `    ${l}` : l)).join('\n');
  return text.slice(0, r.start) + indented + text.slice(r.end);
}

// The file with each part's sound left off (everything after its .midichan(n)): the notes are read from this, since a
// sound may re-pitch a note for its own reasons (a kick tuned with .note(31)) without changing the MIDI.
export function notesOnly(text, parsed = parseSongFile(text)) {
  let out = text;
  for (const b of [...parsed.blocks].sort((x, y) => y.start - x.start)) {
    const m = text.slice(b.close + 1, b.end).match(/^\s*\.midichan\(\s*\d+\s*\)/);
    if (!m) continue;
    const from = b.close + 1 + m[0].length;
    const to = b.close + 1 + text.slice(b.close + 1, b.end).trimEnd().length;
    out = out.slice(0, from) + out.slice(to);
  }
  return out;
}

// The notes of every part and section, worked out by running the whole file once (without the sounds).
// sections: [{ id, bars }] in song order. Returns { parts: { [channel]: { [sectionId]: notes } }, problems }.
export async function songNotes(evaluator, text, sections, { ticksPerBar = 3840, beatsPerBar = 4, drumChannels = [10], ms = 30000 } = {}) {
  const parsed = parseSongFile(text);
  if (parsed.problems.length) return { parts: {}, problems: parsed.problems };
  const total = sections.reduce((s, x) => s + x.bars, 0);
  const r = await evaluator.run(notesOnly(text, parsed), { bars: total, mode: 'haps', ms });
  if (!r.ok) return { parts: {}, problems: [`the song file doesn't run: ${r.error}${r.line ? ` (line ${r.line})` : ''}`] };
  const starts = [];
  let acc = 0;
  for (const s of sections) { starts.push(acc); acc += s.bars; }
  const parts = {};
  const problems = [];
  const byBlock = new Map();
  for (const h of r.haps) { if (!byBlock.has(h.block)) byBlock.set(h.block, []); byBlock.get(h.block).push(h); }
  for (const b of parsed.blocks) {
    const haps = byBlock.get(b.index) || [];
    parts[b.channel] = {};
    sections.forEach((sec, i) => {
      const from = starts[i]; const to = from + sec.bars;
      const mine = haps.filter((h) => h.begin >= from - 1e-9 && h.begin < to - 1e-9).map((h) => ({ ...h, begin: h.begin - from, end: h.end - from }));
      const d = notesFromHaps(mine, { ticksPerBar, beatsPerBar, drums: drumChannels.includes(b.channel), bars: sec.bars });
      parts[b.channel][sec.id] = d.notes.map(({ t, len, key, vel, fine }) => ({ t, len, key, vel, ...(fine ? { fine } : {}) }));
      for (const p of d.problems) if (!/makes no notes/.test(p)) problems.push(`ch${String(b.channel).padStart(2, '0')} ${sec.id}: ${p}`);
    });
  }
  return { parts, problems };
}

// Replaces a whole row: [bars, music] (the music indented under it, like setRow).
export function replaceRow(text, channel, row, bars, music) {
  const { blocks } = parseSongFile(text);
  const b = blocks.find((x) => x.channel === channel);
  if (!b || !b.rows[row]) throw new Error(`there is no row ${row + 1} in part ch${channel}`);
  const r = b.rows[row];
  const indented = music.split('\n').map((l, i) => (i && !/^ {4}/.test(l) ? `    ${l}` : l)).join('\n');
  return text.slice(0, r.rowStart) + `[${bars}, ${indented}]` + text.slice(r.rowEnd);
}

// Writes the row comments again from the sections (ids, names, song bars), in every part: a section that changed
// length moves the bars of every section after it.
export function renumberRows(text, sections) {
  let out = text;
  const blocks = parseSongFile(out).blocks.sort((a, b) => b.start - a.start);
  for (const blk of blocks) {
    let bar = sections.reduce((s, x) => s + x.bars, 1);
    for (let i = blk.rows.length - 1; i >= 0; i--) {
      const r = blk.rows[i];
      const sec = sections[i];
      if (!sec) continue;
      bar -= sec.bars;
      const lineEnd = out.indexOf('\n', r.rowEnd);
      const tail = out.slice(r.rowEnd, lineEnd < 0 ? out.length : lineEnd);
      const comma = tail.match(/^\s*,/) ? ',' : '';
      const comment = `   // ${sec.id} · ${sec.name || ''} · ${sec.bars === 1 ? `bar ${bar}` : `bars ${bar}–${bar + sec.bars - 1}`}`;
      out = out.slice(0, r.rowEnd) + comma + comment + out.slice(lineEnd < 0 ? out.length : lineEnd);
    }
  }
  return out;
}

// A row's music with bars cut, repeated or added, in plain Strudel: arrange() of the music and the music carried on
// with .early(n) (arrange starts every row at its own bar 1). Bars are 1-based inside the section; len is its length.
//   cut a–b:    [a-1, X], [len-b, X.early(b)]
//   repeat a–b: [b, X], [b-a+1, X.early(a-1)], [len-b, X.early(b)]
//   add n at p: [p-1, X], [n, silence], [len-p+1, X.early(p-1)]
export function retimeMusic(music, len, { kind, from, to, n, at }) {
  if (music.trim() === 'silence') return 'silence';
  const X = music.includes('\n') ? music : music;
  const early = (k) => (k ? `${X}.early(${k})` : X);
  const rows = [];
  if (kind === 'cut') { rows.push([from - 1, early(0)], [len - to, early(to)]); }
  else if (kind === 'repeat') { rows.push([to, early(0)], [to - from + 1, early(from - 1)], [len - to, early(to)]); }
  else if (kind === 'add') { rows.push([at - 1, early(0)], [n, 'silence'], [len - at + 1, early(at - 1)]); }
  else throw new Error(`kind must be cut, repeat or add (got ${kind})`);
  const kept = rows.filter(([k]) => k > 0);
  if (kept.length === 1 && kept[0][1] === X) return X;
  return `arrange(\n  ${kept.map(([k, m]) => `[${k}, ${m}]`).join(',\n  ')}\n)`;
}
