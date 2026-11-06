// The script, line by line, for the app's Script panel and the chat's script card (doc 11 §9.1, doc 30 stage 1).
//
// The script is the session's own files: script/beats.json (beats with their words) and voice/lines.json (the
// narration lines `b01-1`, `b01-2` …, once the voice exists). This module reads them as beats → lines, and writes the
// owner's edits back into those same files, so the canvas graph (src/canvas.mjs) picks the change up as it always
// does: the beat gets a new version, the voice line its new words. Line ids are the voice line ids and are forever
// (a deleted line is kept, marked deleted, so it can be brought back).
//
// What a line feeds is the graph's own `says` edges (svc/graph.mjs): its voice line and the shots of its beat. An
// edit to a line's words remakes only those pieces that already exist (a Fix on each, so versions are kept and the AI
// runs ahead as usual); pieces not made yet will be made from the new words anyway.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canvasView, canvasPaths, readBeats, loadOwner, CanvasError } from '../canvas.mjs';
import { projectPaths, loadProject, projectPipeline, event } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { withLock, writeJson } from '../studio.mjs';
import { filmOrder, loadLayout } from './graph.mjs';
import { beatNames } from './beatnames.mjs';
import { speechPace } from './pace.mjs';
import { narratorVoice } from './voicecast.mjs';

const BEAT = /^b\d{2,3}$/;
const LINE = /^b\d{2,3}-\d{1,3}$/;
const MAX_WORDS = 2000;
const MAX_EDITS = 200;

const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// A short name for a beat that has none of its own: its first few words.
export function autoName(words) {
  const w = String(words || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  return w.replace(/[.,;:!?…]+$/, '');
}

// voice/lines.json is a list, or {lines: [...]}: read it as a list and write it back the same way.
function readVoice(work) {
  const raw = readOr(join(work, 'voice', 'lines.json'), null);
  if (!raw) return { raw: null, list: [] };
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.lines) ? raw.lines : [];
  return { raw, list: list.filter((l) => l && typeof l === 'object') };
}
function writeVoice(work, raw, list) {
  const out = Array.isArray(raw) ? list : { ...raw, lines: list };
  writeJson(join(work, 'voice', 'lines.json'), out);
}

// The script as stored: script/beats.json, else the beats read from script.md (the first edit writes beats.json).
function readScript(work) {
  const j = readOr(join(work, 'script', 'beats.json'), null);
  if (j?.beats?.length) return { ...j, beats: j.beats.filter((b) => b && BEAT.test(b.id)) };
  return { version: 1, beats: readBeats(work, []) };
}

// A stored line with only the fields the script keeps: a deleted one also keeps the OK its voice line had (`was`), so
// bringing it back puts the same voice line back as it was, OK and all, without remaking it.
const keepLine = (l) => ({ id: l.id, words: String(l.words || ''), ...(l.deleted ? { deleted: true } : {}), ...(l.deleted && l.was ? { was: l.was } : {}),
  ...(l.changed_at ? { changed_at: l.changed_at } : {}) });

// One beat's lines: its own `lines` once the owner edited it, then any voice line of the beat it doesn't have yet;
// before that the voice lines of the beat; before the voice exists, the beat's words as its one line.
const flat = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The words a line's kept take says, from the voice cache (sound/voice/lines/<id>.json, tags left out): null when the
 * take's words are unknown, undefined when there is no cache or a newer take (New take, booth) sits beside it. The
 * script's words go into voice/lines.json at once, so lines.json alone can't say a take is out of date. */
function takeSaid(work, id) {
  const meta = join(work, 'sound', 'voice', 'lines', `${id}.json`);
  try {
    const m = statSync(meta).mtimeMs;
    try { if (statSync(join(work, 'voice', 'clips', `${id}.wav`)).mtimeMs > m + 1000) return undefined; } catch { /* no clip */ }
    const t = JSON.parse(readFileSync(meta, 'utf8')).text;
    return t == null ? null : String(t).replace(/\[[^\]]*\]/g, ' ');
  } catch { return undefined; }
}

/** A beat's words as sentences, one line each. */
const sentences = (text) => String(text || '').split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
/** The words lines say, as one flat string, deleted lines left out. */
const said = (lines) => flat(lines.filter((l) => !l.deleted).map((l) => l.words).join(' '));

/**
 * One beat's lines, always saying the beat's current words. Every edit through script.edit keeps `beat.words` equal to
 * its lines; when they differ, the words were rewritten after (a scene Fix, a new version), and the words win: the
 * Script screen must never show the old narration (RUN-BUGS Dir3). Lines then follow the sentences, with the voice
 * line ids in order, so each voice take is matched to its new words and shows as changed.
 */
export function linesOf(beat, voice) {
  const mine = voice.filter((l) => String(l.id || '').startsWith(`${beat.id}-`) && LINE.test(l.id))
    .map((l) => ({ id: l.id, words: String(l.script || l.text || '') }));
  const words = String(beat.words || '').trim();
  if (Array.isArray(beat.lines)) {
    const own = beat.lines.filter((l) => l && LINE.test(l.id)).map(keepLine);
    if (!words || said(own) === flat(words)) {
      // A voice line the script doesn't list is added, unless a script line already says its words: the voice split a
      // two-sentence line into b01-1 + b01-2, and showing both would say the second sentence twice (RUN-BUGS Dir1).
      const known = (m) => own.some((o) => flat(o.words).includes(flat(m.words)));
      return [...own, ...mine.filter((m) => !own.some((o) => o.id === m.id) && !known(m))];
    }
    return fromWords(beat.id, words, [...own, ...mine]);
  }
  if (mine.length && (!words || said(mine) === flat(words))) return mine;
  if (!words) return mine;
  return mine.length ? fromWords(beat.id, words, mine) : [{ id: `${beat.id}-1`, words }];
}

/** The words as lines, reusing the ids lines had. A sentence a line already says keeps that line (an anchor); between
 * anchors the other sentences go to the other lines in order, each taking as many sentences as it said before (a
 * "honey. Skiing?" line stays one line); sentences left over get new ids after every id used, and lines left with no
 * words are dropped. */
function fromWords(beatId, words, before) {
  const seen = new Set();
  const old = before.filter((l) => !l.deleted && !seen.has(l.id) && seen.add(l.id));
  let next = Math.max(0, ...before.map((l) => Number(String(l.id).split('-')[1]) || 0));
  const sents = sentences(words);
  const out = [];
  const fill = (ss, ls) => {
    let at = 0;
    ls.forEach((l, k) => {
      if (at >= ss.length) return;
      const n = Math.max(1, sentences(l.words).length);
      out.push({ id: l.id, words: ss.slice(at, at + n).join(' ') });
      at += n;
    });
    for (; at < ss.length; at++) out.push({ id: `${beatId}-${++next}`, words: ss[at] });
  };
  let i0 = 0; let k0 = 0;
  sents.forEach((t, i) => {
    const k = old.findIndex((l, x) => x >= k0 && flat(l.words) === flat(t));
    if (k < 0) return;
    fill(sents.slice(i0, i), old.slice(k0, k));
    out.push({ id: old[k].id, words: t });
    i0 = i + 1; k0 = k + 1;
  });
  fill(sents.slice(i0), old.slice(k0));
  return out;
}

const TAGS = /^(?:\s*\[[^\]]*\])+\s*/;

/**
 * voice/lines.json says the script's current words. A scene Fix (a session's EDIT_DONE) or a new version rewrites
 * script/beats.json or script.md without script.edit, so lines.json kept the OLD words: Voice & music showed them as
 * "words match" and a re-read would have read them again (RUN-BUGS Dir3). Every beat whose lines no longer say its
 * words gets the lines linesOf gives (the words win): a voice line's words change (its [tags] kept), a new sentence is
 * a new voice line, a voice line the words no longer have is taken out of lines.json (its take stays in the archive).
 * The kept takes are not touched: they still say the old words, so the line shows words_changed until it is re-read.
 * Cheap when nothing changed (the script is older than lines.json). Returns {changed, added, removed} line ids.
 */
export function syncVoiceWords(root, id) {
  const out = { changed: [], added: [], removed: [] };
  const work = projectPaths(root, id).work;
  const lf = join(work, 'voice', 'lines.json');
  const mt = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  const lm = mt(lf);
  if (!lm || Math.max(mt(join(work, 'script', 'beats.json')), mt(join(work, 'script.md'))) <= lm) return out;
  if (writing(root, id)) return out;
  const cp = canvasPaths(root, id);
  mkdirSync(cp.dir, { recursive: true });
  return withLock(join(cp.dir, '.script.lock'), () => {
    const { raw, list: voice } = readVoice(work);
    if (!raw || !voice.length) return out;
    const s = readScript(work);
    let beatsDirty = false;
    for (const b of s.beats) {
      const words = String(b.words || '').trim();
      if (!words) continue;
      const mine = voice.filter((l) => String(l.id || '').startsWith(`${b.id}-`) && LINE.test(l.id));
      const own = Array.isArray(b.lines) ? b.lines.filter((l) => l && LINE.test(l.id)).map(keepLine) : null;
      if (own ? said(own) === flat(words) : !mine.length || said(mine.map((l) => ({ id: l.id, words: String(l.script || l.text || '') }))) === flat(words)) continue;
      const target = linesOf(b, voice).filter((l) => !l.deleted);
      const at = new Date().toISOString();
      for (const [n, t] of target.entries()) {
        const v = voice.find((l) => l.id === t.id);
        if (v) {
          if (flat(v.script || v.text) === flat(t.words) && (v.script == null || v.script === t.words)) continue;
          const tags = (TAGS.exec(String(v.text || '')) || [''])[0];
          v.script = t.words;
          if ('text' in v || !('script' in v)) v.text = `${tags}${t.words}`;
          out.changed.push(t.id);
        } else {
          // a new sentence: a new voice line after the beat's line before it (or where the beat's lines start)
          const prev = n > 0 ? voice.findIndex((l) => l.id === target[n - 1].id) : -1;
          const first = voice.findIndex((l) => String(l.id || '').startsWith(`${b.id}-`));
          const nextBeat = voice.findIndex((l) => String(l.id || '').split('-')[0] > b.id);
          const idx = prev >= 0 ? prev + 1 : first >= 0 ? first : nextBeat >= 0 ? nextBeat : voice.length;
          voice.splice(idx, 0, { id: t.id, text: t.words, script: t.words, gap_after: 0.3 });
          out.added.push(t.id);
        }
      }
      for (const m of mine) {
        if (target.some((t) => t.id === m.id)) continue;
        voice.splice(voice.indexOf(m), 1);
        out.removed.push(m.id);
      }
      if (own) {
        // the beat's own lines follow too, so script.edit and script.get start from these ids
        b.lines = [...target.map((t) => ({ id: t.id, words: t.words, changed_at: at })), ...own.filter((l) => l.deleted)];
        beatsDirty = true;
      }
    }
    if (beatsDirty) writeJson(join(work, 'script', 'beats.json'), s);
    if (out.changed.length || out.added.length || out.removed.length) {
      writeVoice(work, raw, voice);
      try { event(root, id, { event: 'VOICE_LINES_SYNCED', actor: 'studio', details: `voice/lines.json follows the script: ${[out.changed.length && `${out.changed.length} changed (${out.changed.join(', ')})`, out.added.length && `${out.added.length} new (${out.added.join(', ')})`, out.removed.length && `${out.removed.length} taken out (${out.removed.join(', ')})`].filter(Boolean).join('; ')}; their takes still say the old words` }); } catch { /* no state */ }
    }
    return out;
  });
}

/** The beat's lines no longer say its words (rewritten after the lines were stored). */
const stale = (beat) => Array.isArray(beat.lines) && Boolean(String(beat.words || '').trim()) && said(beat.lines) !== flat(beat.words);

// Is the AI still writing the script? (Its step is being worked on and the project is running.)
function writing(root, id) {
  try {
    const p = loadProject(root, id);
    const step = stepView(p, projectPipeline(root, id)).find((s) => s.key === 'script');
    return Boolean(step && ['ready', 'working', 'changes'].includes(step.state) && p.state === 'queued');
  } catch { return false; }
}

// What each beat's lines feed: the beat's voice line (by id) and the beat's shots, in film order.
function feedsOf(g, film) {
  const shotsOf = (beat) => film.filter((s) => g.nodes[s]?.beat === beat && !g.nodes[s]?.missing);
  return (beat, line) => {
    const out = [];
    const v = g.nodes[line];
    if (v && v.kind === 'line' && !v.missing) out.push(v);
    for (const s of shotsOf(beat)) out.push(g.nodes[s]);
    return out.map((n) => ({ node: n.id, kind: n.kind, label: n.label, state: n.state, current: n.current ?? null, made: Boolean(n.versions?.some((x) => x.file)), remaking: Boolean(n.pending) }));
  };
}

// script.get: beats → lines with ids, what each line feeds and whether those pieces are being remade.
export function scriptView(root, id) {
  const work = projectPaths(root, id).work;
  try { syncVoiceWords(root, id); } catch (e) { console.error(`voice words sync ${id}: ${e.message}`); }
  const g = canvasView(root, id);
  const film = filmOrder(g, loadLayout(root, id));
  const feeds = feedsOf(g, film);
  const { list: voice } = readVoice(work);
  const s = readScript(work);
  const busy = writing(root, id);
  let names = {};
  try { names = beatNames(root, id, readBeats(work, [])); } catch { /* the words alone */ }
  const beats = s.beats.map((b, i) => {
    const node = g.nodes[b.id];
    const all = linesOf(b, voice);
    // Deleted lines are kept (ids are forever): the app shows the ones it deleted with Undo, in their place (`after` =
    // the line shown before it, null = first in the beat).
    const deleted = all.map((l, i) => ({ l, after: all.slice(0, i).filter((x) => !x.deleted).at(-1)?.id ?? null })).filter((x) => x.l.deleted)
      .slice(-50).map(({ l, after }) => ({ id: l.id, words: l.words, after, changed_at: l.changed_at || null }));
    const lines = all.filter((l) => !l.deleted).map((l) => {
      const f = feeds(b.id, l.id);
      const remaking = f.filter((x) => x.remaking);
      // the voice take says other words than the script now (the scene was rewritten): it needs a re-read
      const take = voice.find((v) => v.id === l.id);
      const was = take ? takeSaid(work, l.id) : undefined;
      const reread = Boolean(take) && (was !== undefined ? was === null || flat(was) !== flat(l.words) : flat(take.script || take.text) !== flat(l.words));
      return { id: l.id, words: l.words, feeds: f, changed: Boolean(l.changed_at) || reread, changed_at: l.changed_at || null, words_changed: reread,
        remaking: { shots: remaking.filter((x) => x.kind === 'shot').length, lines: remaking.filter((x) => x.kind === 'line').length } };
    });
    return { id: b.id, no: i + 1, name: b.name || names[b.id]?.name || autoName(b.words), name_auto: !b.name, name_from: b.name ? 'script' : names[b.id]?.from || 'words', colour: node?.colour || null,
      visual: b.visual || null, target_sec: b.target_sec ?? null, state: node?.state || null, lines, deleted };
  });
  // While the AI writes, the newest line is the one being written: read-only until it is done.
  const last = busy ? beats.at(-1)?.lines.at(-1) : null;
  for (const b of beats) for (const l of b.lines) l.read_only = l === last;
  const d = readDraft(root, id);
  // words a minute this project's narrator really speaks (svc/pace.mjs): the app's scene times and the length fit use it
  let wpm = 120; try { wpm = speechPace(root, { voiceId: narratorVoice(root, id).voice_id }).wpm; } catch { /* the default */ }
  return { project: id, rev: g.rev, writing: busy, version: s.version ?? null, beats, draft: d?.draft ?? null, draft_at: d?.at ?? null, words_per_minute: wpm };
}

// ---- the owner's unsaved script changes (the app's draft), kept per project so nothing typed is lost ----
// The app sends its draft whenever it changes (`script.draft {draft}`, null = none); it lives beside the canvas in
// state/<id>/canvas/script-draft.json, so it survives a service restart, a project switch and a crash. The service
// never reads into it: it is the app's own shape, handed back as is by script.get. Saving the script clears it.
const MAX_DRAFT = 256 * 1024;
const draftFile = (root, id) => join(canvasPaths(root, id).dir, 'script-draft.json');

export function readDraft(root, id) {
  const d = readOr(draftFile(root, id), null);
  return d && typeof d === 'object' && d.draft && typeof d.draft === 'object' && !Array.isArray(d.draft) ? d : null;
}

export function saveDraft(root, id, draft) {
  const f = draftFile(root, id);
  if (draft === null || draft === undefined) {
    rmSync(f, { force: true });
    return { project: id, saved: false, cleared: true };
  }
  if (typeof draft !== 'object' || Array.isArray(draft)) throw new CanvasError('the draft is an object (or null)');
  const text = JSON.stringify({ draft, at: new Date().toISOString() });
  if (text.length > MAX_DRAFT) throw new CanvasError(`the draft is at most ${MAX_DRAFT / 1024} KB`);
  mkdirSync(canvasPaths(root, id).dir, { recursive: true });
  writeFileSync(`${f}.tmp`, text);
  renameSync(`${f}.tmp`, f);
  return { project: id, saved: true, cleared: false };
}

// script.edit: one edit, or {edits: [...]} (the app's Save sends every draft change at once). Each edit:
//   {beat, beat_name}                 rename the beat ("" = back to its first words)
//   {beat, line, words}               new words for a line
//   {beat, add_after, words, key?}    a new line after `add_after` (a line id, a `key` from this batch, or null = first)
//   {beat, line, delete: true|false}  delete a line (kept, hidden) or bring it back
// Writes script/beats.json (and voice/lines.json once the voice exists) and returns what changed; the caller asks for
// the remakes (requestRemakes) so they go through the canvas's own Fix path.
export function applyScriptEdits(root, id, params) {
  const list = Array.isArray(params?.edits) ? params.edits : [params];
  if (!list.length) throw new CanvasError('no edits');
  if (list.length > MAX_EDITS) throw new CanvasError(`at most ${MAX_EDITS} edits at once`);
  if (writing(root, id) && list.some((e) => !e?.beat_name && e?.line)) {
    // the line the AI is writing right now is read-only
    const v = scriptView(root, id);
    const busy = v.beats.flatMap((b) => b.lines).find((l) => l.read_only);
    if (busy && list.some((e) => e?.line === busy.id)) throw new CanvasError(`${busy.id} is still being written`);
  }
  const work = projectPaths(root, id).work;
  const cp = canvasPaths(root, id);
  mkdirSync(cp.dir, { recursive: true });
  const at = new Date().toISOString();
  const decisions = loadOwner(root, id).decisions || {};
  return withLock(join(cp.dir, '.script.lock'), () => {
    const s = readScript(work);
    if (!s.beats.length) throw new CanvasError('there is no script yet');
    const { raw: voiceRaw, list: voice } = readVoice(work);
    const out = { changed: [], added: [], keys: {}, deleted: [], restored: [], renamed: [] };
    const touched = new Set();
    let voiceDirty = false;
    const prepared = new Set();
    for (const e of list) {
      if (!e || typeof e !== 'object') throw new CanvasError('each edit is an object');
      const beat = s.beats.find((b) => b.id === String(e.beat || ''));
      if (!beat) throw new CanvasError(`no scene ${String(e.beat || '').slice(0, 20) || '(none)'} in the script`);
      // once per beat per call: the edits in this batch change its lines before its words are set again below
      if (!prepared.has(beat.id) && (!Array.isArray(beat.lines) || stale(beat))) beat.lines = linesOf(beat, voice);
      prepared.add(beat.id);
      const words = e.words === undefined || e.words === null ? null : String(e.words).replace(/\s+/g, ' ').trim();
      if (words !== null && words.length > MAX_WORDS) throw new CanvasError(`a line is at most ${MAX_WORDS} characters`);
      if (e.beat_name !== undefined) {
        const name = String(e.beat_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (name) beat.name = name; else delete beat.name;
        out.renamed.push(beat.id);
        touched.add(beat.id);
        if (!e.line && e.add_after === undefined) continue;
      }
      if (e.add_after !== undefined) {
        if (!words) throw new CanvasError('a new line needs its words');
        const after = e.add_after === null || e.add_after === '' ? null : out.keys[String(e.add_after)] || String(e.add_after);
        const at_ = after === null ? -1 : beat.lines.findIndex((l) => l.id === after);
        if (after !== null && at_ < 0) throw new CanvasError(`no line ${after} in ${beat.id}`);
        // ids are forever: the next number after every line the beat ever had (deleted ones and voice lines too)
        const used = [...beat.lines, ...voice.filter((l) => String(l.id || '').startsWith(`${beat.id}-`))].map((l) => Number(String(l.id).split('-')[1]) || 0);
        const nid = `${beat.id}-${Math.max(0, ...used) + 1}`;
        beat.lines.splice(at_ + 1, 0, { id: nid, words, changed_at: at });
        if (e.key !== undefined) out.keys[String(e.key).slice(0, 40)] = nid;
        out.added.push(nid);
        // once the beat has voice lines, the new line is one too (in the beat's place in voice/lines.json)
        const beatVoice = voice.filter((l) => String(l.id || '').startsWith(`${beat.id}-`));
        if (voiceRaw && beatVoice.length) {
          const prev = after && voice.findIndex((l) => l.id === after);
          const idx = prev !== null && prev >= 0 ? prev + 1 : voice.indexOf(beatVoice[0]);
          voice.splice(idx, 0, { id: nid, script: words });
          voiceDirty = true;
        }
        touched.add(beat.id);
        continue;
      }
      const lid = out.keys[String(e.line || '')] || String(e.line || '');
      const line = beat.lines.find((l) => l.id === lid);
      if (!line) throw new CanvasError(`no line ${lid.slice(0, 20) || '(none)'} in ${beat.id}`);
      if (e.delete === true || e.delete === false) {
        if (e.delete) {
          if (line.deleted) continue;
          line.deleted = true;
          if (decisions[lid]?.verdict === 'ok') line.was = 'ok';
          out.deleted.push(lid);
        } else {
          if (!line.deleted) continue;
          out.restored.push(lid);
          // remakesFor reads `was` from this list (the file no longer has it once the line is back)
          out.was = { ...(out.was || {}), ...(line.was ? { [lid]: line.was } : {}) };
          delete line.deleted;
          delete line.was;
        }
        line.changed_at = at;
        touched.add(beat.id);
        continue;
      }
      if (!words) throw new CanvasError('the new words are empty (delete the line instead)');
      if (words === line.words) continue;
      line.words = words;
      line.changed_at = at;
      if (!out.changed.includes(lid)) out.changed.push(lid);
      const v = voice.find((l) => l.id === lid);
      if (v) { v.script = words; if ('text' in v) v.text = words; voiceDirty = true; }
      touched.add(beat.id);
    }
    // The beat's words are its lines as one paragraph (the canvas's beat node, the chat card, the brief).
    for (const b of s.beats.filter((x) => touched.has(x.id))) {
      b.lines = b.lines.map(keepLine);
      b.words = b.lines.filter((l) => !l.deleted).map((l) => l.words).join(' ');
    }
    mkdirSync(join(work, 'script'), { recursive: true });
    writeJson(join(work, 'script', 'beats.json'), s);
    if (voiceDirty) writeVoice(work, voiceRaw, voice);
    // saved: the draft those changes came from is done (the app sends what is still unsaved again)
    rmSync(draftFile(root, id), { force: true });
    out.beats = [...touched];
    return out;
  });
}

// The remakes an applied edit asks for, as canvas actions: [{node, action: fix|cut|clear, text}]. Only pieces that
// were already made are remade; a shot used by several changed lines gets one Fix naming them all.
export function remakesFor(root, id, done) {
  const g = canvasView(root, id);
  const film = filmOrder(g, loadLayout(root, id));
  const feeds = feedsOf(g, film);
  const work = projectPaths(root, id).work;
  const s = readScript(work);
  const wordsOf = (lid) => s.beats.flatMap((b) => b.lines || []).find((l) => l.id === lid)?.words || '';
  const beatOf = (lid) => lid.split('-')[0];
  const fixes = new Map();
  const add = (node, text) => { const f = fixes.get(node) || []; f.push(text); fixes.set(node, f); };
  const actions = [];
  for (const lid of done.changed) {
    // a made voice line is never remade here: it shows "words changed" on Voice until the owner presses Remake line
    // (owner, 2026-10-23: "if I don't click that button, the line should not be regenerated")
    for (const f of feeds(beatOf(lid), lid).filter((x) => x.made && x.kind !== 'line')) {
      add(f.node, `The narration over this shot changed (line ${lid}, now: "${wordsOf(lid)}"). Remake this shot so it fits the new words; keep its look and length.`);
    }
  }
  for (const lid of done.added) {
    const v = g.nodes[lid];
    if (v?.kind === 'line') add(lid, `A new line the owner added to the script: "${wordsOf(lid)}". Record it in the same voice, right after the line before it.`);
  }
  for (const [node, texts] of fixes) actions.push({ node, action: 'fix', text: texts.join(' ') });
  for (const lid of done.deleted) if (g.nodes[lid]?.kind === 'line' && g.nodes[lid].owner !== 'cut') actions.push({ node: lid, action: 'cut' });
  // Brought back: the same voice line as it was (its OK too), nothing remade.
  for (const lid of done.restored) if (g.nodes[lid]?.owner === 'cut') actions.push({ node: lid, action: done.was?.[lid] === 'ok' ? 'ok' : 'clear' });
  return actions;
}

// One plain sentence for the chat's grey line: "Script: 1 line changed · remaking 1 shot and 1 voice line".
export function scriptActionText(done, remade) {
  const n = (k, one, many) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  const parts = [];
  if (done.changed.length) parts.push(`${n(done.changed.length, 'line', 'lines')} changed`);
  const added = done.added.length;
  if (added) parts.push(`${n(added, 'line', 'lines')} added`);
  if (done.deleted.length) parts.push(`${n(done.deleted.length, 'line', 'lines')} deleted`);
  if (done.restored.length) parts.push(`${n(done.restored.length, 'line', 'lines')} back`);
  if (done.renamed.length) parts.push(`${n(done.renamed.length, 'scene', 'scenes')} renamed`);
  const shots = remade.filter((r) => r.kind === 'shot').length;
  const lines = remade.filter((r) => r.kind === 'line').length;
  const what = [shots && n(shots, 'shot', 'shots'), lines && n(lines, 'voice line', 'voice lines')].filter(Boolean).join(' and ');
  return `Script: ${parts.join(', ') || 'saved'}${what ? ` · remaking ${what}` : ''}`;
}

export const scriptLogged = (root, id, text) => event(root, id, { event: 'SCRIPT_EDITED', actor: 'you', details: text.slice(0, 300) });
