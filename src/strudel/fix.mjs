// Fix, fast (doc 28 §4): before any session starts, one short call asks the AI for only the marked bars, as Strudel.
// The answer is checked (asked for, runs, inside its bars, the rest untouched, locks, harmony, hits), put in place with
// the rest of each row kept word for word, and the edit request is done at once. Two failed retries hand it to a full
// session, with the reasons. The prompt and the song stay plain Strudel: no helpers of ours.
import { ticksPerBar, sectionLayout, PPQ } from '../song.mjs';
import { loadSong, songPaths } from '../song-store.mjs';
import { parseSongFile } from './songfile.mjs';
import { notesToStrudel } from './notes.mjs';
import { existsSync, readFileSync } from 'node:fs';

export const FIX_SYSTEM = `You rewrite marked bars of a film score written in Strudel. One cycle = one bar.
Reply with only the blocks asked for. Each block starts and ends with the marker lines given and holds ONE plain
Strudel expression whose cycle 0 is the first bar named in its begin line.
Notes only: note() or n() with .scale(), mini-notation, .velocity(). No .s(), effects, setcpm, samples or
declarations. Stay in the key and on the chords. Put a note on every hit listed. Keep the part's register.`;

const begin = (sec, part, a, b) => `// begin ${sec} ${part} bars ${a}-${b}`;
const end = (sec, part) => `// end ${sec} ${part}`;

// The request: the song's key and tempo, the owner's words, the chords and hits in the bars, the locks, the bars
// before and after (every part, line per bar), the asked parts' rows as they are, and the empty blocks to fill.
export function buildFixPrompt(song, text, edit, { blueprint = null } = {}) {
  const tpb = ticksPerBar(song.meter[0]);
  const layout = sectionLayout(song);
  const at = layout.find((x) => x.id === edit.node);
  const pat = song.patterns.find((x) => x.id === edit.node);
  const [a, b] = edit.bars || [1, pat.bars];
  const parts = song.channels.filter((c) => (!edit.part || c.id === edit.part) && (pat.notes[c.id]?.length || edit.part));
  const songBar = (bar) => at.startBar + bar - 1;
  const lines = [];
  lines.push(`Song "${song.title}": ${song.tempo[0].bpm} BPM, ${song.meter[0].num}/${song.meter[0].den}${song.scale ? `, ${song.scale.root} ${song.scale.mode}` : ''}.`);
  lines.push(`Rewrite ${edit.node} "${pat.name || ''}" bars ${a}-${b} (song bars ${songBar(a)}-${songBar(b)})${edit.part ? ` for ${parts[0]?.name || edit.part} only` : ' for every part'}. The other bars stay exactly as they are.`);
  if (edit.text) lines.push(`Owner's words: ${edit.text}`);
  if (blueprint?.chart) {
    const chords = [];
    for (let bar = songBar(Math.max(1, a - 1)); bar <= songBar(Math.min(pat.bars, b + 1)); bar++) {
      const row = blueprint.chart.find((r) => bar >= r.bars[0] && bar <= r.bars[1]);
      const cell = row ? row.chords[(bar - row.bars[0]) % row.chords.length] : '?';
      chords.push(Array.isArray(cell) ? cell.join(' ') : cell);
    }
    lines.push(`Chords, song bars ${songBar(Math.max(1, a - 1))}-${songBar(Math.min(pat.bars, b + 1))}: ${chords.join(' | ')}`);
  }
  const hits = (song.markers || []).filter((m) => m.kind === 'hit' && m.tick >= at.startTick + (a - 1) * tpb && m.tick < at.startTick + b * tpb);
  for (const h of hits) lines.push(`Hit: bar ${(h.tick - at.startTick) / tpb + 1 | 0} beat ${((h.tick - at.startTick) % tpb) / PPQ + 1} of ${edit.node} = ${h.sec ?? '?'} s (${h.name}).`);
  const locks = (song.locks || []).filter((l) => l.scope.pattern === edit.node);
  for (const l of locks) lines.push(`Locked: ${edit.node} ${l.scope.channel || 'every part'}${l.scope.fromTick !== undefined ? ` bars ${l.scope.fromTick / tpb + 1}-${l.scope.toTick / tpb}` : ''} (${l.by === 'ok' ? 'approved' : 'the owner edited them'}): don't touch.`);
  const around = (from, to, label) => {
    if (from > to) return;
    lines.push('', `${label} (${edit.node} bars ${from}-${to}, every part):`);
    for (const c of song.channels) {
      const ns = (pat.notes[c.id] || []).filter((n) => n.t >= (from - 1) * tpb && n.t < to * tpb).map((n) => ({ ...n, vel: n.vel ?? 0.8, t: n.t - (from - 1) * tpb }));
      lines.push(`${c.id} ${c.name.padEnd(16)} ${ns.length ? notesToStrudel(ns, { bars: to - from + 1, ticksPerBar: tpb, drums: c.kind === 'drums' }).replace(/\n\s*/g, ' ') : 'silence'}`);
    }
  };
  around(Math.max(1, a - 2), a - 1, 'Coming from');
  around(b + 1, Math.min(pat.bars, b + 2), 'Going into');
  lines.push('', 'The parts now (their whole row in this section):');
  const blocks = parseSongFile(text).blocks;
  const row = layout.findIndex((x) => x.id === edit.node);
  for (const c of parts) {
    const blk = blocks.find((x) => x.channel === c.midiChannel);
    lines.push(`${c.id} ${c.name}: ${blk?.rows[row]?.text ?? 'silence'}`);
  }
  lines.push('', 'Reply with these blocks:');
  for (const c of parts) lines.push(begin(edit.node, c.id, a, b), end(edit.node, c.id));
  return { system: FIX_SYSTEM, user: lines.join('\n'), asked: parts.map((c) => ({ section: edit.node, part: c.id, bars: [a, b] })) };
}

// Only the blocks: text around them is ignored. Returns [{ section, part, bars, code }] or throws in plain words.
export function parseReply(reply, asked) {
  const out = [];
  const re = /\/\/\s*begin\s+(\S+)\s+(ch\d{2,})\s+bars\s+(\d+)-(\d+)\s*\n([\s\S]*?)\n\s*\/\/\s*end\s+\1\s+\2/g;
  for (let m; (m = re.exec(String(reply)));) out.push({ section: m[1], part: m[2], bars: [Number(m[3]), Number(m[4])], code: m[5].trim() });
  if (!out.length) throw new Error('the reply has no blocks between the begin and end lines');
  for (const o of out) {
    if (!asked.some((x) => x.section === o.section && x.part === o.part && x.bars[0] === o.bars[0] && x.bars[1] === o.bars[1])) throw new Error(`a block for ${o.section} ${o.part} bars ${o.bars.join('-')} wasn't asked for`);
    if (!o.code) throw new Error(`the block for ${o.part} is empty (a silent block says silence)`);
    if (/\b(setcpm|setcps|samples|soundfont|hush)\s*\(|\.(s|sound|bank|orbit|room|delay|lpf|hpf)\s*\(|^\s*(const|let|var|function)\b/m.test(o.code)) throw new Error(`the block for ${o.part} has sound settings or declarations: notes only`);
  }
  for (const x of asked) if (!out.some((o) => o.part === x.part)) throw new Error(`the reply has no block for ${x.part}`);
  return out;
}

// The hits inside the bars still have a note starting within one video frame (in the asked part, or any part).
function hitsLanded(song, edit, fps = 30) {
  const tpb = ticksPerBar(song.meter[0]);
  const at = sectionLayout(song).find((x) => x.id === edit.node);
  const pat = song.patterns.find((x) => x.id === edit.node);
  const [a, b] = edit.bars || [1, pat.bars];
  const tickSec = 60 / song.tempo[0].bpm / PPQ;
  const frameTicks = 1 / fps / tickSec;
  const missed = [];
  for (const h of (song.markers || []).filter((m) => m.kind === 'hit')) {
    const local = h.tick - at.startTick;
    if (local < (a - 1) * tpb || local >= b * tpb) continue;
    const parts = edit.part ? [edit.part] : Object.keys(pat.notes);
    if (!parts.some((c) => (pat.notes[c] || []).some((n) => Math.abs(n.t - local) <= frameTicks))) missed.push(`no note starts on the hit "${h.name}" (bar ${Math.floor(local / tpb) + 1})`);
  }
  return missed;
}

// The whole fast path for one edit request. ask(prompt) → the AI's reply text. Returns { ok, tries, reasons }.
// All or nothing across parts: a part that fails takes back the parts already put in.
export async function fastFix(root, id, edit, { ask, write, undoLast, maxTries = 3 }) {
  const reasons = [];
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const { song, text } = loadSong(root, id);
    const bpPath = songPaths(root, id).blueprint;
    const blueprint = existsSync(bpPath) ? JSON.parse(readFileSync(bpPath, 'utf8')) : null;
    const prompt = buildFixPrompt(song, text, edit, { blueprint });
    if (reasons.length) prompt.user += `\n\nYour last answer was refused: ${reasons.at(-1)}\nFix that and reply again.`;
    let put = 0;
    try {
      const blocks = parseReply(await ask(prompt), prompt.asked);
      for (const blk of blocks) { await write(blk); put++; }
      const missed = hitsLanded(loadSong(root, id).song, edit);
      if (missed.length) throw new Error(missed.join('; '));
      return { ok: true, tries: attempt, reasons };
    } catch (e) {
      for (let k = 0; k < put; k++) await undoLast();
      reasons.push(String(e.message || e).replace(/^refused: /, ''));
    }
  }
  return { ok: false, tries: maxTries, reasons };
}
