// Notes → Strudel text (doc 28 §3). Plain functions with no Strudel inside, so they run anywhere.
// A note is { t, len, key, vel }: t and len are whole ticks from the pattern's start (960 per quarter), key is MIDI
// 0–127, vel is 0–1 with 3 decimals. Two writers:
// - notesToStrudel: one line per bar. Line i is bar i, always, so an edit in bar 7 changes line 7 and nothing else.
// - notesToIdiomatic: the short form for a pattern written fresh from notes (repeats folded, one velocity said once).
// Both are exact: running the text gives back the same notes (checked by the caller, which runs it).

export const PPQ = 960;
const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
export const r3 = (v) => Math.round(v * 1000) / 1000;
const fmtNum = (v) => { const s = String(r3(v)); return s.startsWith('0.') ? s.slice(1) : s; };

export function keyText(key, { drums = false, flats = false } = {}) {
  if (drums || key < 12 || key > 119) return String(key);
  return `${(flats ? FLAT : SHARP)[key % 12]}${Math.floor(key / 12) - 1}`;
}

// The smallest-digit decimal that turns `slot` ticks back into exactly `len` ticks. It must land well inside the tick
// (within 0.4), not on a .5 boundary: Strudel's times are floats, and 903 × 0.5 = 451.5 can come back as 451.49999.
function clipText(len, slot) {
  for (let d = 1; d <= 8; d++) {
    const s = (len / slot).toFixed(d);
    if (Math.abs(slot * Number(s) - len) < 0.4) return String(Number(s));
  }
  throw new Error(`no clip for ${len}/${slot}`);
}

// ---- notes -> canonical Strudel (one line per bar) ----

export function notesToStrudel(notes, { bars, ticksPerBar = 4 * PPQ, drums = false, flats = false } = {}) {
  const byBar = Array.from({ length: bars }, () => []);
  for (const n of notes) {
    const b = Math.floor(n.t / ticksPerBar);
    if (b < 0 || b >= bars) throw new Error(`note at tick ${n.t} is outside the region (${bars} bars)`);
    byBar[b].push(n);
  }
  let needClip = false;
  const cells = byBar.map((ns, b) => {
    const c = barCell(ns, b * ticksPerBar, ticksPerBar, { drums, flats });
    if (c.clip) needClip = true;
    return c.text;
  });
  return '`<\n' + cells.map((c) => `  ${c}\n`).join('') + '>`' + `.as("note:velocity${needClip ? ':clip' : ''}")`;
}

function barCell(notes, barStart, barLen, opts) {
  if (!notes.length) return { text: '~', clip: false };
  // events: chords = same start + same length
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.len - b.len || a.key - b.key);
  const events = [];
  if (opts.drums) {
    for (const n of sorted) events.push({ start: n.t - barStart, len: n.len, keys: [n], group: n.key });
  } else {
    for (const n of sorted) {
      const last = events.at(-1);
      if (last && last.start === n.t - barStart && last.len === n.len && !last.keys.some((k) => k.key === n.key)) last.keys.push(n);
      else events.push({ start: n.t - barStart, len: n.len, keys: [n], group: 0 });
    }
  }
  // voices: interval partitioning (drums: per key first)
  const groups = new Map();
  for (const e of events) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group).push(e); }
  const voices = [];
  for (const g of [...groups.keys()].sort((a, b) => a - b)) {
    const vs = [];
    for (const e of groups.get(g)) {
      const end = Math.min(e.start + e.len, barLen);
      const v = vs.find((x) => x.end <= e.start);
      if (v) { v.events.push(e); v.end = end; } else vs.push({ events: [e], end });
    }
    voices.push(...vs);
  }
  let clip = false;
  const texts = voices.map((v) => {
    const a = voiceRests(v.events, barLen, opts);
    const b = voiceSlots(v.events, barLen, opts);
    const pick = b && b.text.length < a.text.length ? b : a;
    if (pick.clip) clip = true;
    return pick;
  });
  if (texts.length === 1 && texts[0].whole) return { text: texts[0].atom, clip };
  return { text: `[${texts.map((x) => x.text).join(', ')}]`, clip };
}

function atom(e, clipStr, opts) {
  const one = (n) => opts.noVel ? `${keyText(n.key, opts)}${clipStr ? `::${clipStr}` : ''}` : `${keyText(n.key, opts)}:${fmtNum(n.vel)}${clipStr ? `:${clipStr}` : ''}`;
  return e.keys.length === 1 ? one(e.keys[0]) : `[${e.keys.map(one).join(',')}]`;
}

// Rests form: slots between events are rests; a note ringing past the bar end gets a clip.
function voiceRests(events, barLen, opts) {
  const pts = [barLen];
  for (const e of events) { pts.push(e.start, Math.min(e.start + e.len, barLen)); }
  const g = pts.reduce(gcd, 0) || barLen;
  const items = []; let pos = 0; let clip = false;
  for (const e of events) {
    if (e.start > pos) items.push({ tok: '~', w: (e.start - pos) / g });
    const end = Math.min(e.start + e.len, barLen);
    const c = e.start + e.len > barLen ? clipText(e.len, end - e.start) : null;
    if (c) clip = true;
    items.push({ tok: atom(e, c, opts), w: (end - e.start) / g });
    pos = end;
  }
  if (pos < barLen) items.push({ tok: '~', w: (barLen - pos) / g });
  return serialize(items, clip);
}

// Slots form: each note's slot runs to the next note; a clip says how much of it sounds.
function voiceSlots(events, barLen, opts) {
  const pts = [barLen, ...events.map((e) => e.start)];
  const g = pts.reduce(gcd, 0) || barLen;
  const items = []; let clip = false;
  if (events[0].start > 0) items.push({ tok: '~', w: events[0].start / g });
  events.forEach((e, i) => {
    const slotEnd = i + 1 < events.length ? events[i + 1].start : barLen;
    const slot = slotEnd - e.start;
    const c = e.len !== slot ? clipText(e.len, slot) : null;
    if (c) clip = true;
    items.push({ tok: atom(e, c, opts), w: slot / g });
  });
  return serialize(items, clip);
}

function serialize(items, clip) {
  if (items.length === 1) return { text: items[0].tok, atom: items[0].tok, whole: true, clip };
  // a whole bar of the same hit: "42:.6*16"
  if (items.every((x) => x.w === 1 && x.tok === items[0].tok) && !items[0].tok.startsWith('['))
    return { text: `${items[0].tok}*${items.length}`, atom: null, whole: false, clip };
  const parts = [];
  for (let i = 0; i < items.length;) {
    let j = i; while (items[i].w === 1 && j + 1 < items.length && items[j + 1].tok === items[i].tok && items[j + 1].w === 1) j++;
    const w = items[i].w === 1 ? '' : `@${items[i].w}`;
    const rep = j > i ? `!${j - i + 1}` : '';
    parts.push(`${items[i].tok}${w}${rep}`);
    i = j + 1;
  }
  return { text: parts.join(' '), atom: null, whole: false, clip };
}

export const strip = (ns) => ns.map(({ t, len, key, vel }) => ({ t, len, key, vel }));
export const sortNotes = (ns) => [...ns].sort((a, b) => a.t - b.t || a.key - b.key || a.len - b.len || a.vel - b.vel);
export const sameNotes = (a, b) => JSON.stringify(sortNotes(strip(a))) === JSON.stringify(sortNotes(strip(b)));

// ---- idiomatic form: for a region written fresh from MIDI (import). Verified exact by the caller. ----
export function notesToIdiomatic(notes, { bars, ticksPerBar = 4 * PPQ, drums = false, flats = false } = {}) {
  if (!notes.length) return 'silence';
  const vels = new Set(notes.map((n) => n.vel));
  const uniform = vels.size === 1 ? [...vels][0] : null;
  const opts = { drums, flats, noVel: uniform !== null };
  // a steady line whose pitches cycle against the bar: {a b c}%n
  const poly = polymeter(notes, bars, ticksPerBar, opts);
  if (poly && uniform !== null) return `${poly}.velocity(${fmtNum(uniform)})`;
  const byBar = Array.from({ length: bars }, () => []);
  for (const n of notes) byBar[Math.floor(n.t / ticksPerBar)].push(n);
  let clip = false;
  let cells = byBar.map((ns, b) => { const c = barCell(ns, b * ticksPerBar, ticksPerBar, opts); if (c.clip) clip = true; return c.text; });
  if (clip && opts.noVel) { opts.noVel = false; cells = byBar.map((ns, b) => barCell(ns, b * ticksPerBar, ticksPerBar, opts).text); }
  let p = 1; while (p < bars && !cells.every((c, i) => c === cells[i % p])) p++;
  const used = cells.slice(0, p);
  // one bar's worth: "d2 ~ d2 g2", not "<[d2 ~ d2 g2]>"
  const one = p === 1 && /^\[[^,]*\]$/.test(used[0]) && !/[\[\]]/.test(used[0].slice(1, -1)) ? used[0].slice(1, -1) : null;
  const body = one !== null ? `"${one}"` : used.join(' ').length <= 90 ? `"<${used.join(' ')}>"` : '`<\n' + used.map((c) => `  ${c}\n`).join('') + '>`';
  // .8 is what a note with no velocity plays at, so it isn't written
  if (opts.noVel) return uniform === 0.8 ? `note(${body})` : `note(${body}).velocity(${fmtNum(uniform)})`;
  return `${body}.as("note:velocity${clip ? ':clip' : ''}")`;
}

function polymeter(notes, bars, tpb, opts) {
  const ns = [...notes].sort((a, b) => a.t - b.t);
  const s = ns.length > 1 ? ns[1].t - ns[0].t : 0;
  if (!s || ns[0].t !== 0 || tpb % s || ns.length !== bars * tpb / s) return null;
  if (!ns.every((n, i) => n.t === i * s && n.len === ns[0].len)) return null;
  let k = 1; while (k < ns.length && !ns.every((n, i) => n.key === ns[i % k].key)) k++;
  const steps = tpb / s;
  if (k >= ns.length || steps % k === 0) return null;   // no repeat, or it lines up with the bar anyway
  const seq = ns.slice(0, k).map((n) => keyText(n.key, opts)).join(' ');
  const c = ns[0].len !== s ? clipText(ns[0].len, s) : null;
  return `note("${steps === 1 ? `<${seq}>` : `{${seq}}%${steps}`}")${c ? `.legato(${c})` : ''}`;
}
