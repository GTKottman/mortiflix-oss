// v3 Stills: one still per spoken line (voice/lines.json ids like b01-1), drawn with Kinetograph in the chosen look.
// What is said is shown: each line has a key word (a number, a proper noun, else the longest word) and the still's
// own text layer (the scene's props, not OCR) must hold it. State: design/stills/stills.json, pictures
// design/stills/<line>-v<N>.png. The renderer is injectable (tests mock it); the default is `kinetograph still`.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as runAsync } from './run.mjs';
import { projectPaths, event, loadProject } from '../projects.mjs';
import { kgStill } from '../kinetograph.mjs';
import { UserError, writeJson } from '../studio.mjs';
import { readReviewSettings } from './reviewsize.mjs';
import { propsHash, BATCH_MAX } from './stillsbatch.mjs';
import { restartStep } from './restart.mjs';
import { listNotes, sendNotes, saveNote } from './lessons.mjs';
import { measureFrame } from './inspect.mjs';
import { readPool } from './pool.mjs';

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const LINE = /^b\d{2,3}-\d{1,3}$/;
const SMALL = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been', 'into', 'your', 'are', 'was', 'but', 'its', 'some', 'call', 'it', 'a', 'so', 'in', 'of', 'to', 'is',
  'has', 'had', 'not', 'you', 'they', 'them', 'their', 'there', 'then', 'than', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'will', 'would', 'could', 'should', 'can', 'did', 'does', 'doing', 'were', 'being', 'over', 'under', 'about', 'after', 'before', 'any', 'all', 'each', 'every', 'more', 'most', 'just', 'also', 'only', 'very', 'our', 'out', 'his', 'her', 'she', 'him', 'one', 'now', 'even', 'here', 'these', 'those', 'such', 'own', 'same', 'other', 'like', 'yet', 'still', 'may', 'might', 'must', 'use', 'get', 'got', 'let', 'say', 'said', 'too', 'off', 'onto', 'upon', 'per', 'via', 'because', 'while', 'until', 'though', 'although', 'either', 'neither', 'both', 'well', 'way']);
const clean = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
// a key word is a real content word: never a stop word, never 2 letters or fewer (a digit is always kept: "42", "5G")
const NUMBER_WORD = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dollars?|percent|second|third|fifth|twelfth)$/i;
// a spoken number ("twenty-million-dollar") may be set as digits ("$20M"), so it is not a key word
const spokenNumber = (w) => w.split('-').every((p) => NUMBER_WORD.test(p));
const content = (w) => /\d/.test(w) || (w.replace(/[^\p{L}]/gu, '').length > 2 && !SMALL.has(w.toLowerCase()) && !spokenNumber(w));

// The script's WRITTEN forms of names the voice spells out ("Character.AI" is spoken "Character A I"): words of the script
// with a dot inside or an acronym, as the voice says them. The key word is taken in its written form, as the still prints it.
const spokenOf = (w) => w.replace(/[.·]/g, ' ').replace(/\b\p{Lu}{2,4}\b/gu, (m) => ` ${m.split('').join(' ')} `).replace(/\s+/g, ' ').trim();
export function writtenForms(work) {
  let text = '';
  try { text = readFileSync(join(work, 'script.md'), 'utf8'); } catch { return []; }
  const seen = new Map();
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+|\b\p{Lu}{2,4}\b/gu)) {
    const w = m[0]; const spoken = spokenOf(w);
    if (spoken.toLowerCase() === w.toLowerCase()) continue;
    // the script's own spelling wins over a caps heading ("Character.AI", not "CHARACTER.AI")
    const old = seen.get(spoken.toLowerCase());
    if (!old || (old === old.toUpperCase() && w !== w.toUpperCase())) seen.set(spoken.toLowerCase(), w);
  }
  return [...seen].map(([spoken, written]) => ({ spoken, written })).sort((a, b) => b.spoken.length - a.spoken.length);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const toWritten = (text, forms = []) => forms.reduce((t, f) => t.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(f.spoken).replace(/ /g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'giu'), `$1${f.written}`), String(text));

// The key word of a line, in the script's written form: a number in digits (a spoken number may be set as digits, so
// number words are not picked), else a proper noun
// (a written form like "Character.AI", or capitalised words not at the start), else the longest content word. Never a
// stop word or a word of 2 letters or fewer: "I" from the spoken "Character A I" was the bug (2026-11-02, d4fd b02-1).
export function pickKeyWord(text, forms = []) {
  const written = new Set(forms.map((f) => f.written));
  const words = toWritten(text, forms).split(/\s+/).map(clean).filter(Boolean);
  const digit = words.find((w) => /\d/.test(w));
  if (digit) return digit;
  const known = words.find((w) => written.has(w) && content(w));
  if (known) return known;
  const cap = (w, i) => w !== undefined && i > 0 && /^\p{Lu}/u.test(w) && content(w);
  const i0 = words.findIndex(cap);
  if (i0 >= 0) { let j = i0; while (cap(words[j + 1], j + 1)) j++; return words.slice(i0, j + 1).join(' '); }
  const pool = words.filter(content);
  return [...(pool.length ? pool : words)].sort((a, b) => b.length - a.length)[0] || '';
}
// A line's key word: the owner's or the stored one, unless it is not a content word (an old pick like "I"), else picked.
export const keyOf = (e, text, work) => {
  const k = String(e?.key_word || '').trim();
  return k && k.split(/\s+/).some(content) ? k : pickKeyWord(text, work ? writtenForms(work) : []);
};

const files = (root, id) => {
  const work = projectPaths(root, id).work;
  return { work, dir: join(work, 'design', 'stills'), state: join(work, 'design', 'stills', 'stills.json') };
};
const voiceLines = (work) => readOr(join(work, 'voice', 'lines.json'), []).filter((l) => LINE.test(String(l.id)) && String(l.text || '').trim());
const lookOf = (work) => {
  const b = readOr(join(work, 'design', 'look-brief.json'), {});
  const pal = Array.isArray(b.palette) && b.palette.length >= 2 ? b.palette : ['#11161d', '#eaedf1', '#237de7'];
  return { bg: pal[0], fg: pal[1], accent: pal[2] || pal[1], font: b.heading_font || b.font || '' };
};
const load = (root, id) => readOr(files(root, id).state, { lines: {} });
const save = (root, id, doc) => { const f = files(root, id); mkdirSync(f.dir, { recursive: true }); writeJson(f.state, doc); };

// The still's text layer: what the scene prints. The check reads this, not pixels.
export const sceneTexts = (props) => [props.kicker, props.key, props.text].filter(Boolean);
// matched on letters and digits only, so the written form matches however the still sets it ("Character.AI", "CHARACTER.AI")
const squash = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const keyWordVisible = (key, texts) => !key ? null : texts.some((t) => squash(t).includes(squash(key)));

const ROOT_TSX = `import React from 'react';
import { Composition, AbsoluteFill, registerRoot } from 'remotion';
// Written by the studio (svc/stills.mjs). One composition, "Still": props = { kicker, key, text, bg, fg, accent, font }.
const Still: React.FC<any> = ({ kicker, key: k, text, bg, fg, accent, font }) => (
  <AbsoluteFill style={{ background: bg, color: fg, fontFamily: font || 'sans-serif', padding: 120, justifyContent: 'center' }}>
    <div style={{ fontSize: 36, color: accent, marginBottom: 32, letterSpacing: 4 }}>{kicker}</div>
    <div style={{ fontSize: 220, fontWeight: 800, lineHeight: 1, marginBottom: 48 }}>{k}</div>
    <div style={{ width: 160, height: 12, background: accent, borderRadius: 6, marginBottom: 48 }} />
    <div style={{ fontSize: 56, lineHeight: 1.3, maxWidth: 1400, color: fg, opacity: 0.85 }}>{text}</div>
  </AbsoluteFill>
);
const Root = () => <Composition id="Still" component={Still} width={1920} height={1080} fps={30} durationInFrames={30} defaultProps={{ kicker: '', key: '', text: '', bg: '#11161d', fg: '#eaedf1', accent: '#237de7', font: '' }} />;
registerRoot(Root);
`;

// The default renderer: one `kinetograph still` in the project's video folder.
export function kinetographRender(root, id) {
  return async ({ props, output }) => {
    const { work } = files(root, id);
    mkdirSync(join(work, 'video', 'src'), { recursive: true });
    writeFileSync(join(work, 'video', 'src', 'stills-root.tsx'), ROOT_TSX);
    mkdirSync(join(output, '..'), { recursive: true });
    const cmd = kgStill({ root, entry: 'src/stills-root.tsx', composition: 'Still', output, frame: 0, props });
    const r = await runAsync('bash', ['-c', cmd], { cwd: join(work, 'video'), encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'kinetograph failed').slice(-300));
  };
}

const ver = (e) => e.versions.find((v) => v.v === e.current) || e.versions.at(-1) || null;

// ---- groups (owner, 2026-11-01: "check groups at a time, but not render the whole thing"): a group is ONE SCENE's stills (plan 90 q3).
// Stills are written, drawn and checked a group at a time; the next group is written only when every still before it is OK, so the
// notes on one scene change how the next is drawn. doc.mode = "groups" once the studio draws them with Claude (svc quickstills.mjs); the
// older one-by-one template path (demo backend, tests) leaves it unset and nothing here holds the step. ----
const beatOf = (line) => String(line).split('-')[0];
// perGroup = scenes per group (the owner's setting review.scenesPerGroup, 1-6; default 1). A group's `beat` is its first scene, `beats` all of them.
export function stillGroups(root, id, { perGroup } = {}) {
  const per = perGroup ?? readReviewSettings(root).review.scenesPerGroup;
  const { work } = files(root, id);
  const beats = readOr(join(work, 'script', 'beats.json'), { beats: [] }).beats || [];
  const names = new Map(beats.map((b) => [b.id, b.name || b.id]));
  const doc = load(root, id);
  const byBeat = new Map();
  for (const l of voiceLines(work)) { const b = beatOf(l.id); if (!byBeat.has(b)) byBeat.set(b, []); byBeat.get(b).push(l.id); }
  const sorted = [...byBeat.keys()].sort();
  const order = []; for (let i = 0; i < sorted.length; i += per) order.push(sorted.slice(i, i + per));
  let open = true;
  return order.map((bs, i) => {
    const beat = bs[0];
    const lines = bs.flatMap((b) => byBeat.get(b));
    const st = lines.map((l) => { const e = doc.lines[l]; return !e ? 'todo' : e.drawing ? 'drawing' : e.state; });
    const allOk = st.every((x) => x === 'ok');
    const made = st.every((x) => ['check', 'ok', 'held'].includes(x));
    const current = open && !allOk;
    if (!allOk) open = false;
    return { beat, beats: bs, name: bs.length > 1 ? `${names.get(beat) || beat} + ${bs.length - 1} more` : names.get(beat) || beat, index: i + 1, count: order.length, lines, state: allOk ? 'ok' : made ? 'review' : current ? (st.includes('fix') ? 'fixing' : 'making') : 'waiting' };
  });
}
// The owner's OKs on the stills (stills.json, per line): {ok, total, waiting}, or null with no lines yet.
export function stillOks(root, id) {
  try {
    const lines = voiceLines(files(root, id).work);
    if (!lines.length) return null;
    const doc = load(root, id);
    const st = lines.map((l) => doc.lines[l.id]?.state);
    return { ok: st.filter((x) => x === 'ok').length, total: lines.length, waiting: st.filter((x) => ['check', 'held'].includes(x)).length };
  } catch { return null; }
}
export const stillsMode = (root, id) => load(root, id).mode || 'lines';
export function setStillsMode(root, id, mode) { const d = load(root, id); if (d.mode !== mode) { d.mode = mode; save(root, id, d); } }
// true while the group-by-group flow still has stills the owner has not OK'd (gates.mjs refuses to approve the step then)
export const stillsHeld = (root, id) => { try { const d = load(root, id); return d.mode === 'groups' && stillGroups(root, id).some((g) => g.state !== 'ok'); } catch { return false; } };

// A still held ONLY by the studio's measured checks is measured again from its saved inspect.json and picture, once per
// service start, while no session runs: when every check now passes (a check was fixed), it is no longer held and goes to
// the owner's check. A still showing "Held" over all-✓ checks after a reload was the bug (2026-11-02). Held for the AI
// inspection's reasons stays held.
const STARTED = new Date().toISOString();
const studioHeld = (e) => e.state === 'held' && (e.held || []).length > 0 && e.held.every((t) => String(t).startsWith('Studio check · '));
function recheckHeld(root, id, doc, work) {
  try { if (loadProject(root, id).session) return; } catch { return; }
  const freed = [];
  for (const [line, e] of Object.entries(doc.lines || {})) {
    const v = studioHeld(e) && ver(e);
    if (!v || v.rechecked_at === STARTED) continue;
    v.rechecked_at = STARTED;
    const at = (x) => join(work, x);
    try {
      const inspect = JSON.parse(readFileSync(at(v.file.replace(/\.png$/, '.inspect.json')), 'utf8'));
      const code = ['src/ui.tsx', `src/scenes/st_${beatOf(line)}.tsx`].map((x) => (existsSync(at(`video/${x}`)) ? readFileSync(at(`video/${x}`), 'utf8') : '')).join('\n');
      const key = e.key_word || null;
      const m = measureFrame({ inspect, png: readFileSync(at(v.file)), pool: readPool(root, id), code, work, keys: key ? [key] : null });
      v.measured = { ok: m.ok, problems: m.problems, checks: Object.fromEntries(Object.entries(m.checks || {}).map(([k, x]) => [k, { pass: x.pass, note: x.note }])) };
      if (m.ok) {
        Object.assign(e, { state: 'check', held: null });
        if (v.inspection) v.inspection = { ...v.inspection, held: false, unresolved: [], rechecked: true };
        freed.push(line);
      } else e.held = m.problems.map((t) => `Studio check · ${t}`.slice(0, 500));
    } catch { /* no inspect.json or picture: stays held as it was */ }
  }
  save(root, id, doc);
  if (freed.length) { try { event(root, id, { event: 'STILLS_RECHECKED', actor: 'studio', details: `measured again, every check passes, no longer held: ${freed.join(', ')}` }); } catch { /* no log */ } }
}

// stills.get
export function stillsView(root, id) {
  const { work } = files(root, id);
  const doc = load(root, id);
  if (Object.values(doc.lines || {}).some((e) => studioHeld(e) && ver(e)?.rechecked_at !== STARTED)) recheckHeld(root, id, doc, work);
  const lines = voiceLines(work).map((l) => {
    const e = doc.lines[l.id];
    const v = e && ver(e);
    const key = keyOf(e, l.text, work);
    return {
      line: l.id, words: l.text, key_word: key, path: v ? join(work, v.file) : null, versions: e?.versions.length || 0,
      state: !e ? 'todo' : e.drawing ? 'drawing' : e.state,
      beat: beatOf(l.id), version: v?.v ?? null, inspection: v?.inspection || null, held: e?.held || null, why: e?.why || '',
      error: e?.error || null,
      // what the studio measured wrong on this version (the app shows it, never a ✓ over a failing check)
      problems: e?.state === 'ok' ? [] : v?.measured?.problems || [],
      check: { key_word_visible: v ? keyWordVisible(key, v.texts) : null },
    };
  });
  return { project: id, mode: doc.mode || 'lines', lines, groups: stillGroups(root, id) };
}

// Draw (or redraw) one line. {text}: new words for the picture; {key_word}: another key word.
export async function drawLine(root, id, line, { text, key_word } = {}, { render } = {}) {
  const { work, dir } = files(root, id);
  const src = voiceLines(work).find((l) => l.id === line);
  if (!src) throw new UserError(`No voice line ${line}.`);
  const doc = load(root, id);
  const e = (doc.lines[line] ||= { versions: [], current: null, state: 'check' });
  if (e.drawing) throw new UserError(`${line} is being drawn.`);
  if (key_word) e.key_word = String(key_word).trim().slice(0, 60);
  const words = String(text ?? e.words ?? src.text).trim().slice(0, 300);
  e.words = words;
  const key = keyOf(e, words, work);
  const n = (e.versions.at(-1)?.v || 0) + 1;
  const file = `design/stills/${line}-v${n}.png`;
  e.drawing = true; save(root, id, doc);
  const look = lookOf(work);
  const props = { kicker: line.toUpperCase(), key, text: words, ...look };
  try {
    await (render || kinetographRender(root, id))({ line, props, output: join(work, file) });
    const d2 = load(root, id);
    const e2 = d2.lines[line];
    e2.versions.push({ v: n, file, text: words, texts: sceneTexts(props), hash: propsHash(props), at: new Date().toISOString() });
    Object.assign(e2, { current: n, state: 'check', drawing: false, error: null });
    save(root, id, d2);
    return { ok: true, line, version: n };
  } catch (err) {
    const d2 = load(root, id);
    Object.assign(d2.lines[line], { drawing: false, error: String(err.message).slice(0, 300) });
    save(root, id, d2);
    try { event(root, id, { event: 'STILL_FAILED', details: `${line}: ${err.message}`.slice(0, 300) }); } catch { /* no log */ }
    return { ok: false, line, error: err.message };
  }
}

// Several lines in one go (G3). Lines whose picture would not change (same props hash as the current version, file
// there) are skipped, never redrawn. With `renderBatch` ([{line, props, output}] -> draws all in one Kinetograph render)
// the rest are drawn together: one bundle for all of them; without it each goes through drawLine as before.
export async function drawLines(root, id, lineIds, opts = {}) {
  const { render, renderBatch } = opts;
  const { work } = files(root, id);
  const srcs = new Map(voiceLines(work).map((l) => [l.id, l]));
  const out = { drawn: [], skipped: [], failed: [] };
  const doc = load(root, id);
  const items = [];
  for (const line of lineIds) {
    const src = srcs.get(line);
    if (!src) { out.failed.push({ line, error: `No voice line ${line}.` }); continue; }
    const e = (doc.lines[line] ||= { versions: [], current: null, state: 'check' });
    if (e.drawing) { out.failed.push({ line, error: `${line} is being drawn.` }); continue; }
    const words = String(e.words ?? src.text).trim().slice(0, 300);
    e.words = words;
    const props = { kicker: line.toUpperCase(), key: keyOf(e, words, work), text: words, ...lookOf(work) };
    const cur = ver(e);
    if (cur && cur.hash === propsHash(props) && existsSync(join(work, cur.file))) { out.skipped.push(line); continue; }
    const n = (e.versions.at(-1)?.v || 0) + 1;
    items.push({ line, props, n, file: `design/stills/${line}-v${n}.png`, output: join(work, `design/stills/${line}-v${n}.png`) });
  }
  if (!renderBatch) {
    save(root, id, doc);
    for (const it of items) { const r = await drawLine(root, id, it.line, {}, { render }); (r.ok ? out.drawn : out.failed).push(r.ok ? it.line : { line: it.line, error: r.error }); }
    return out;
  }
  for (const it of items) doc.lines[it.line].drawing = true;
  save(root, id, doc);
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const chunk = items.slice(i, i + BATCH_MAX);
    let err = null;
    try { await renderBatch(chunk.map(({ line, props, output }) => ({ line, props, output }))); } catch (e) { err = e; }
    const d2 = load(root, id);
    for (const it of chunk) {
      const e2 = d2.lines[it.line];
      const ok = !err && existsSync(it.output);
      if (ok) {
        e2.versions.push({ v: it.n, file: it.file, text: it.props.text, texts: sceneTexts(it.props), hash: propsHash(it.props), at: new Date().toISOString() });
        Object.assign(e2, { current: it.n, state: 'check', drawing: false, error: null });
        out.drawn.push(it.line);
      } else {
        const msg = String(err?.message || 'no picture').slice(0, 300);
        Object.assign(e2, { drawing: false, error: msg });
        out.failed.push({ line: it.line, error: msg });
        try { event(root, id, { event: 'STILL_FAILED', details: `${it.line}: ${msg}`.slice(0, 300) }); } catch { /* no log */ }
      }
    }
    save(root, id, d2);
  }
  return out;
}

// stills.make: every line that has no still yet (the pipeline's `stills` step): one batch with `renderBatch`, else one after another.
export async function makeStills(root, id, opts = {}) {
  const todo = stillsView(root, id).lines.filter((l) => l.state === 'todo');
  if (opts.renderBatch) {
    const r = await drawLines(root, id, todo.map((l) => l.line), opts);
    return { made: r.drawn.length, failed: r.failed.length };
  }
  const done = [];
  for (const l of todo) done.push(await drawLine(root, id, l.line, {}, opts));
  return { made: done.filter((d) => d.ok).length, failed: done.filter((d) => !d.ok).length };
}

// stills.ok: the owner signs a still off. Refuses when there is no picture.
export function okLine(root, id, line) {
  const doc = load(root, id);
  const e = doc.lines[line];
  if (!e || !ver(e)) throw new UserError(`${line} has no still to OK.`);
  // OK on a held still is the owner's "OK anyway": what was not satisfied stays on the version, marked as their call
  if (e.state === 'held') { const v = ver(e); if (v) v.ok_anyway = e.held || []; e.held = null; }
  e.state = 'ok';
  save(root, id, doc);
  return { line, state: 'ok' };
}

// stills.ok in the group flow: this still is the owner's. When it was the last of its scene and a scene is left, the step restarts and the
// next group is written. Returns {line, state, next: "group"|"wait"|"done"}.
export function okStill(root, id, line) {
  const r = okLine(root, id, line);
  const g = stillGroups(root, id);
  const mine = g.find((x) => x.lines.includes(line));
  const next = g.every((x) => x.state === 'ok') ? 'done' : mine?.state === 'ok' ? 'group' : 'wait';
  if (next === 'group') { try { restartStep(root, id, 'stills', `${mine.beats.length > 1 ? `Scenes ${mine.beats.join(', ')} are` : `Scene ${mine.beat} is`} OK: draw the stills of the next ${mine.beats.length > 1 ? 'scenes' : 'scene'}, with the owner's notes on the scenes so far.`); } catch { /* the runner continues by itself */ } }
  return { ...r, next };
}

// stills.fix in the group flow: the notes on this still go as one fix; only that still is drawn again, alone (a new version, old ones kept).
// The words a still's Fix sends back to the studio: every note's own text, marked as winning over the checks (2026-11-02,
// 61dc: the feedback said only "draw that still again" and the session never saw what the owner asked for). As Look.
export function stillFixWords(line, fixNotes = []) {
  const words = (fixNotes || []).map((n) => n.text || (n.image ? '(pen marks only)' : '')).filter(Boolean);
  return `The owner's ${words.length} note${words.length === 1 ? '' : 's'} on still ${line}: draw that still again with ${words.length === 1 ? 'it' : 'every one'}. The owner's notes win over every check and every other rule; a fix for a check keeps what they ask.\n${words.map((w, i) => `${i + 1}. ${w}`).join('\n')}`;
}
export async function fixStill(root, id, line, { text = '', ask = null } = {}) {
  const doc = load(root, id);
  const e = doc.lines[line];
  if (e && !ver(e) && e.error) return drawFresh(root, id, line, doc, { text, ask });
  if (!e || !ver(e)) throw new UserError(`${line} has no still to fix.`);
  if (String(text).trim()) await saveNote(root, id, { node: line, text, send: false }, { ask });
  const pending = listNotes(root, id, line).notes.some((n) => n.pending);
  if (!pending && !(e.state === 'held' && e.held?.length)) throw new UserError(`Fix needs a note on ${line}: type what to change (Enter keeps it) or mark the still`);
  const sent = pending ? sendNotes(root, id, line, { fix: null }) : { notes: [] };
  const notes = listNotes(root, id, line).notes.filter((n) => sent.notes.includes(n.id));
  const d2 = load(root, id);
  // a held still's Fix also carries what was not satisfied (the measured check's boxes and px)
  const checks = e.state === 'held' ? (e.held || []).map((t) => ({ text: t, image: null })) : [];
  Object.assign(d2.lines[line], { state: 'fix', fix_notes: [...notes.map((n) => ({ text: n.text || '', image: n.image || null })), ...checks], held: null });
  const v = ver(d2.lines[line]); if (v) v.notes = notes.length;
  save(root, id, d2);
  try { event(root, id, { event: 'STILL_FIX', actor: 'you', details: `${line}: ${notes.length} note${notes.length === 1 ? '' : 's'}` }); } catch { /* no log */ }
  try { restartStep(root, id, 'stills', stillFixWords(line, d2.lines[line].fix_notes)); } catch { /* the runner picks it up */ }
  return { line, fixing: true, notes: notes.length };
}
// A still whose first draw failed (an error, no picture) has nothing to fix: "Draw again" draws it fresh. The line goes
// back to todo with the error cleared, so the group flow draws it with its scene (targets are the lines with no
// version). The step is restarted only when no session runs on the project (a running one picks the line up itself).
async function drawFresh(root, id, line, doc, { text = '', ask = null } = {}) {
  const e = doc.lines[line];
  const failed = e.error;
  if (String(text).trim()) await saveNote(root, id, { node: line, text, send: false }, { ask });
  Object.assign(e, { state: 'todo', error: null, drawing: false, held: null, fix_notes: [] });
  save(root, id, doc);
  try { event(root, id, { event: 'STILL_REDRAW', actor: 'you', details: `${line}: first draw failed (${String(failed).slice(0, 200)})` }); } catch { /* no log */ }
  let session = null;
  try { session = loadProject(root, id).session ?? null; } catch { /* no project file */ }
  let restarted = false;
  if (!session) { try { restarted = Boolean(restartStep(root, id, 'stills', `Still ${line} could not be drawn (${String(failed).slice(0, 200)}): draw it fresh.`)); } catch { /* the runner picks it up */ } }
  return { line, fixing: true, fresh: true, notes: 0, restarted };
}
export const stillState = { load, save, files, ver, voiceLines, beatOf };

// stills.send_anyway {line}: the AI inspection was not satisfied after 3 rounds; the owner looks at the still as it is.
export function sendStillAnyway(root, id, line) {
  const doc = load(root, id);
  const e = doc.lines[line];
  if (!e || e.state !== 'held') throw new UserError(`${line} is not held.`);
  e.state = 'check';
  const v = ver(e); if (v?.inspection) v.inspection.sent_anyway = true;
  save(root, id, doc);
  return { line, state: 'check', sent: true };
}
// stills.retry {line}: the unresolved inspection items go back to the writer as corrections (a new version of that still).
export function retryStill(root, id, line) {
  const doc = load(root, id);
  const e = doc.lines[line];
  if (!e || e.state !== 'held') throw new UserError(`${line} is not held.`);
  Object.assign(e, { state: 'fix', fix_notes: (e.held || []).map((t) => ({ text: `Inspection: ${t}`, image: null })), held: null });
  save(root, id, doc);
  try { restartStep(root, id, 'stills', `Still ${line} did not pass the inspection list: draw it again with these corrections.`); } catch { /* the runner picks it up */ }
  return { line, retrying: true };
}
