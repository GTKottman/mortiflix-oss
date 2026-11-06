// MIDI ⇄ Strudel, both ways (doc 28). `notes` runs a pattern's text and returns its notes; `edit` takes the text and
// the notes the owner wants and returns the smallest text change that runs to exactly those notes (the ladder, §3.4):
//   1. bar lines    the text is line-per-bar: write it again; only the edited bars' lines differ
//   2. in place     only pitch or velocity changed, each from one word used by no other note: change that word
//   3. arrangement  anything else: the original kept word for word, the edited bars hard-coded notes in their own
//                   section of Strudel's arrange() at that spot
//   4. fresh        the whole pattern in the short form (only if 3 can't be made exact)
// Every result is run and its notes must equal the wanted notes, or the next step is tried.
import { createEvaluator, PPQ } from './evaluator.mjs';
import { notesToStrudel, notesToIdiomatic, keyText, sortNotes, strip, sameNotes } from './notes.mjs';
import { lastStatement, splitSound, commaParts } from './text.mjs';

const NOTE_RE = /^([a-gA-G])([#bsf]*)(-?\d+)?$/;
const CH = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function tokenKey(tok) {
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { kind: 'num', key: Number(tok) };
  const m = tok.match(NOTE_RE);
  if (!m) return null;
  const acc = [...m[2]].reduce((s, c) => s + (c === '#' || c === 's' ? 1 : -1), 0);
  return { kind: 'name', key: (Number(m[3] ?? 3) + 1) * 12 + CH[m[1].toLowerCase()] + acc, flats: m[2].includes('b') };
}

export function createStrudel({ strudelDir, timeoutMs } = {}) {
  const ev = createEvaluator({ strudelDir, timeoutMs });

  async function notes(code, { bars, tpb = 4 * PPQ }) {
    const r = await ev.run(code, { bars, tpb });
    if (!r.ok) { const e = new Error(r.error); e.line = r.line; throw e; }
    return { notes: r.notes, problems: r.problems };
  }

  // fill: { from, to, code } puts that Strudel in bars from–to (1-based) as written, the rest of the text kept: the
  // arrangement step only, with the given code as the hard-coded section (a session's own bars, doc 26 §2).
  async function edit(code, wanted, { bars, tpb = 4 * PPQ, fill = null }) {
    const t0 = performance.now();
    const text = code.trim();
    const target = sortNotes(strip(wanted));
    for (const n of target) if (n.t < 0 || n.t >= bars * tpb) throw new Error(`a note at tick ${n.t} is outside the ${bars} bars`);
    const old = (await notes(text, { bars, tpb })).notes;
    const opts = { bars, ticksPerBar: tpb };
    const check = async (c) => { try { const r = await notes(c, { bars, tpb }); return sameNotes(r.notes, target) ? r : null; } catch { return null; } };
    const done = (level, c, r, extra = {}) => ({ level, code: c, notes: r.notes, problems: r.problems, ms: Math.round((performance.now() - t0) * 10) / 10, ...extra });

    if (fill) {
      const changed = [];
      for (let b = fill.from - 1; b < fill.to; b++) changed.push(b);
      const c = arrangement(text, target, changed, { bars, tpb, fill });
      const r = await check(c.code);
      if (r) return done('arrangement', c.code, r, { from: c.from, to: c.to });
      throw new Error('those bars, put in place, don\'t play the notes they make on their own');
    }
    // 1. bar lines
    let canonical = null;
    try { canonical = notesToStrudel(old, opts); } catch { canonical = null; }
    if (canonical === text) {
      const c = notesToStrudel(target, opts);
      const r = await check(c);
      if (r) return done('bar lines', c, r);
    }
    // 2. in place
    const inPlace = wordEdit(text, old, target);
    if (inPlace) { const r = await check(inPlace); if (r) return done('in place', inPlace, r); }
    // 3. arrangement: the original untouched, the edited bars hard-coded at that spot
    const changed = changedBars(old, target, tpb, bars);
    if (changed.length) {
      const c = arrangement(text, target, changed, { bars, tpb });
      const r = await check(c.code);
      if (r) return done('arrangement', c.code, r, { from: c.from, to: c.to });
    }
    // 4. fresh
    for (const c of [notesToIdiomatic(target, opts), notesToStrudel(target, opts)]) {
      const r = await check(c);
      if (r) return done('fresh', c, r);
    }
    throw new Error('no text runs to exactly these notes');
  }

  return { notes, edit, close: ev.close };
}

// ---- step 3: a new arrangement for the edit ----
// The pattern that made the music is kept word for word. The edited bars become hard-coded notes in their own section of
// Strudel's arrange(), at that spot; the original plays the bars around them. arrange() starts every section from the
// pattern's own beginning, so a section after an edit carries the original on with .early(<bars before it>). Sound-only
// methods at the end (.s, .lpf, .room…) stay outside arrange(), so the hard-coded bars sound the same.
// An earlier edit's arrange(): [{ len, offset }] for the original's sections, [{ len, text }] for hard-coded ones.
function sectionsOf(music, bars) {
  const m = music.match(/^arrange\(([\s\S]*)\)$/);
  if (!m) return null;
  const raw = [];
  for (const part of commaParts(m[1])) {
    const pm = part.match(/^\[([\s\S]*)\]$/);
    if (!pm) return null;
    const [len, ...rest] = commaParts(pm[1]);
    if (!/^\d+$/.test(len) || rest.length !== 1) return null;
    raw.push({ len: Number(len), text: rest[0] });
  }
  if (raw.reduce((s, x) => s + x.len, 0) !== bars) return null;
  // the original: whichever section says X.early(k); with none, the first section
  const early = raw.map((x) => x.text.match(/^([\s\S]*)\.early\((\d+)\)$/)).find(Boolean);
  const orig = early ? early[1] : raw[0].text;
  let at = 0;
  return { orig, sections: raw.map((x) => {
    const s = x.text === orig && at === 0 ? { len: x.len, offset: 0 } : x.text === `${orig}.early(${at})` ? { len: x.len, offset: at } : { len: x.len, text: x.text };
    at += x.len;
    return s;
  }) };
}

function arrangement(code, target, changed, { bars, tpb, fill = null }) {
  const { head, expr } = lastStatement(code);
  const { music, sound } = splitSound(expr);
  const prior = sectionsOf(music, bars);
  const orig = prior ? prior.orig : music;
  // label every bar: 'o' plays the original, a number is a hard-coded section (dirty ones are written again)
  const label = [];
  const dirty = new Set();
  const kept = new Map();
  if (prior) {
    let b = 0;
    prior.sections.forEach((s, i) => { for (let k = 0; k < s.len; k++) label[b++] = 'offset' in s ? 'o' : i; if (!('offset' in s)) kept.set(i, s.text); });
  } else for (let b = 0; b < bars; b++) label[b] = 'o';
  let next = 1000;
  for (const b of changed) {
    if (label[b] !== 'o') { dirty.add(label[b]); continue; }
    const g = b > 0 && label[b - 1] !== 'o' ? label[b - 1] : next++;
    label[b] = g;
    dirty.add(g);
  }
  const sections = [];
  for (let b = 0; b < bars;) {
    let e = b;
    while (e + 1 < bars && label[e + 1] === label[b]) e++;
    const len = e - b + 1;
    if (label[b] === 'o') sections.push(`[${len}, ${b ? `${orig}.early(${b})` : orig}]`);
    else if (!dirty.has(label[b])) sections.push(`[${len}, ${kept.get(label[b])}]`);
    else {
      const slice = target.filter((n) => n.t >= b * tpb && n.t < (e + 1) * tpb).map((n) => ({ ...n, t: n.t - b * tpb }));
      const given = fill && b === fill.from - 1 && e === fill.to - 1 ? fill.code : null;
      sections.push(`[${len}, ${given ?? notesToIdiomatic(slice, { bars: len, ticksPerBar: tpb })}]`);
    }
    b = e + 1;
  }
  const from = Math.min(...changed) + 1;
  const to = Math.max(...changed) + 1;
  return { code: `${head}arrange(\n  ${sections.join(',\n  ')}\n)${sound}`, from, to };
}

// Bars (0-based) where the notes differ.
function changedBars(a, b, tpb, bars) {
  const key = (n) => `${n.t}|${n.len}|${n.key}|${n.vel}`;
  const A = new Set(a.map(key));
  const B = new Set(b.map(key));
  const out = new Set();
  for (const n of a) if (!B.has(key(n))) out.add(Math.floor(n.t / tpb));
  for (const n of b) if (!A.has(key(n))) out.add(Math.floor(n.t / tpb));
  return [...out].filter((x) => x >= 0 && x < bars).sort((x, y) => x - y);
}

// Step 2: same notes at the same times, only pitch or velocity changed, each through a word only that note uses.
function wordEdit(code, oldNotes, target) {
  if (oldNotes.length !== target.length) return null;
  const group = (ns) => { const m = new Map(); for (const n of ns) { const k = `${n.t}|${n.len}`; if (!m.has(k)) m.set(k, []); m.get(k).push(n); } return m; };
  const olds = group(sortNotes(oldNotes));
  const news = group(target);
  const uses = new Map();
  for (const n of oldNotes) for (const l of n.loc || []) { const k = l.join(':'); uses.set(k, (uses.get(k) || 0) + 1); }
  const edits = [];
  for (const [k, os] of olds) {
    const ns = news.get(k);
    if (!ns || ns.length !== os.length) return null;
    const removed = os.filter((x) => !ns.some((y) => y.key === x.key && y.vel === x.vel));
    const added = ns.filter((y) => !os.some((x) => x.key === y.key && x.vel === y.vel));
    if (removed.length !== added.length) return null;
    for (let i = 0; i < removed.length; i++) {
      const was = removed[i];
      const now = added[i];
      let keyDone = now.key === was.key;
      let velDone = now.vel === was.vel;
      for (const l of was.loc || []) {
        if (uses.get(l.join(':')) !== 1) continue;
        const tok = code.slice(l[0], l[1]);
        const tk = tokenKey(tok);
        if (!keyDone && tk && tk.key === was.key) { edits.push([l[0], l[1], tk.kind === 'num' ? String(now.key) : keyText(now.key, { flats: tk.flats })]); keyDone = true; continue; }
        if (!velDone && /^\.?\d*\.?\d+$/.test(tok) && Number(tok) === was.vel) { edits.push([l[0], l[1], String(now.vel).replace(/^0\./, '.')]); velDone = true; }
      }
      if (!keyDone || !velDone) return null;
    }
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b[0] - a[0]);
  let c = code;
  for (const [s, e, t] of edits) c = c.slice(0, s) + t + c.slice(e);
  return c;
}
