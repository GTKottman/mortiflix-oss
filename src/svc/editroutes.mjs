// T2: canvas edits on deterministic things are done by code, not by a session. One "New take of this line" cost
// 866k tokens (16 Opus calls running ls, sed, ffprobe, mv): the work is `vo.mjs speak --only <id>`, a build and a master.
//
//   voice line, "New take" / "Read this line again"   speak that line again (a new take beside the old ones), build, master
//   voice line, "Change the words to: ..."            write the words to voice/lines.json first, then the same
//   voice line, any other free-text note              one small call (role respell) writes the spoken text, or asks a
//                                                     question; then the same. Never a session.
//   anything else (shots, cues, frames ...)           no route here: the session path (see config.editSession)
//
// (Still redraws and script wording already have direct calls: stills.fix / drawLine and script.edit.)
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../studio.mjs';
import { projectPaths, event } from '../projects.mjs';
import { loadEdits, setEditState, finishEdit, syncCanvas } from '../canvas.mjs';
import { voiceConfig, elevenKey } from '../voice/index.mjs';
import { runAs } from '../models.mjs';
import { syncVoiceWords } from './script.mjs';
import { recutScenes } from './restitch.mjs';

export const ROUTE_SETTLE_MS = 1500;
const TAKE = /^(?:New take of this line|Read this line again)/i;
const WORDS = /^Change the words to:\s*"(.*)"\.?\s*(?:Write them|$)/is;

// What route an edit has: {route: 'retake'} | {route: 'words', words} | {route: 'note', note} | null.
export function classifyEdit(edit) {
  if (!edit || edit.kind !== 'line' || edit.op) return null;
  const t = String(edit.text || '').trim();
  const w = WORDS.exec(t);
  if (w && w[1].trim()) return { route: 'words', words: w[1].trim() };
  if (TAKE.test(t)) {
    // the studio's own boilerplate is a plain retake; anything the owner added after it is a note
    const note = t.replace(TAKE, '').replace(/as written in voice\/lines\.json \([^)]*\)/i, '').replace(/\(keep it inside its slot\)/i, '')
      .replace(/,?\s*keeping it inside its slot/i, '').replace(/^[\s:.,]+|[\s:.,]+$/g, '');
    return note ? { route: 'note', note } : { route: 'retake' };
  }
  return t ? { route: 'note', note: t } : null;
}

export const NOTE_SCHEMA = { type: 'object', properties: {
  text: { type: 'string', description: 'the line as the voice should read it: the same meaning, with the owner\'s note applied (pace, emphasis, delivery tags if the voice takes them)' },
  question: { type: 'string', description: 'only when the note cannot be applied without guessing: one short plain question for the owner' },
} };

const notePrompt = (engine, line, note) => [
  `The owner asked for a new take of one narration line, with a note. Voice: ${engine === 'elevenlabs' ? 'ElevenLabs Eleven v4 (audio tags in [brackets] such as [warm] or [slowly], CAPITALS for emphasis, "/IPA/" for a hard name)' : 'a local voice that reads plain words only (no tags): change commas, ellipses and word spelling for pace and breath'}.`,
  `Line ${line.id}, as the voice reads it now:\n"${line.text}"`,
  `The owner's note:\n"${note}"`,
  'Answer with the JSON asked for. `text`: the line to read, with the SAME words (never add, drop or change words of the script unless the note asks for different words). If the note is too vague to apply without guessing, answer `question` instead. Nothing else.',
].join('\n\n');

function readLines(work) {
  const f = join(work, 'voice', 'lines.json');
  if (!existsSync(f)) return null;
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  return { f, raw, list: Array.isArray(raw) ? raw : raw.lines || [] };
}

// The real work for one line: speak again, build, master. Returns {ok, why}. Injectable for tests (deps.retake).
export async function retakeLine({ root, id, line, engine, env, onActivity }) {
  const { vo, master } = await import('../quickvoice.mjs');
  const work = projectPaths(root, id).work;
  if (engine === 'elevenlabs') {
    // the studio's one key lookup (secrets.json, session.env, the environment), then the caller's env as before
    const key = elevenKey(root) || env?.ELEVENLABS_API_KEY;
    if (!key) return { ok: false, why: 'no ElevenLabs key' };
    const { makeVoice } = await import('../soundtrack/voice.mjs');
    const el = voiceConfig(root).elevenlabs;
    let v;
    // `retake`: this line is recorded fresh and its old take stays until the new one arrives. (Deleting the cached take
    // first made makeVoice adopt the line's OLD clip as a take of the new words: nothing was recorded, 2026-11-02.)
    try {
      v = await makeVoice({ work, key, retake: [line], voice: el.voice_name || 'the studio voice', voiceId: el.voice_id, model: el.model_id, stability: el.stability, similarity: el.similarity_boost, speakerBoost: el.use_speaker_boost !== false, log: (t) => onActivity?.({ kind: 'info', text: t }) });
    } catch (e) { return { ok: false, why: `ElevenLabs: ${e.message}` }; }
    if (!v?.recorded?.includes(line)) return { ok: false, why: `ElevenLabs made no new take of ${line}` };
    // the take is saved; the voice is joined once every line has one (another line still waits for its read)
    if (v.joined === false) return { ok: true, take: 'ElevenLabs', joined: false, waiting: v.waiting };
    mkdirSync(join(work, 'out', 'voice'), { recursive: true });
    writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify(v.timing, null, 2));
    copyFileSync(v.file, join(work, 'voice', 'voice.wav'));
    copyFileSync(v.file, join(work, 'out', 'voice', 'narration.wav'));
    // the scene cuts beside it (out/voice/bNN.wav) follow the new voice too (they stayed from the first read, Dir3)
    recutScenes(work, v.timing);
    return { ok: true, take: 'ElevenLabs' };
  }
  const sp = await vo(work, env, ['speak', 'voice/lines.json', '--only', line, '--new-take']);
  if (!sp.ok) return { ok: false, why: sp.out.split('\n').slice(-3).join(' ').slice(0, 300) || 'the voice tool failed' };
  const b = await vo(work, env, ['build', 'voice/lines.json']);
  if (!b.ok || !existsSync(join(work, 'voice', 'voice.wav'))) return { ok: false, why: `build: ${b.out.slice(-300)}` };
  mkdirSync(join(work, 'out', 'voice'), { recursive: true });
  const m = master(join(work, 'voice', 'voice.wav'), join(work, 'out', 'voice', 'narration.wav'));
  if (!m.ok) return { ok: false, why: `loudness: ${m.why}` };
  return { ok: true };
}

// Do every open edit that has a route; returns { handled: [ids], left: [ids], failed: [ids], usage }. Never throws. An
// edit whose route fails is finished as failed with the reason (in `failed` and `handled`): never left to a session.
// One route at a time per project (the service routes a confirmed re-read at once, the runner routes before a session):
// each waits for the one before, and an edit is only ever taken while it is 'requested', so none is made twice.
const routing = new Map();
export function routeOpenEdits(args) {
  const prev = routing.get(args.id) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => routeOnce(args));
  routing.set(args.id, job);
  job.finally(() => { if (routing.get(args.id) === job) routing.delete(args.id); }).catch(() => {});
  return job;
}

// `only`: the routes to take (the service's immediate route takes 'retake' and 'words', which need no AI call).
async function routeOnce({ root, id, run = null, runArgs = {}, config = {}, onActivity = () => {}, env = {}, deps = {}, settleMs = ROUTE_SETTLE_MS, only = null }) {
  const out = { handled: [], left: [], failed: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const engine = voiceConfig(root).engine;
  // a re-read reads the script's current words (a scene Fix may have rewritten them after voice/lines.json)
  try { syncVoiceWords(root, id); } catch (e) { onActivity({ kind: 'info', text: `voice words sync: ${e.message}` }); }
  // Edits that arrive while these are made are routed too (the queue sends its takes one by one: run 2026-11-02, the
  // third New take landed 60 ms after the route started, went to the Claude session, and that session recorded the line
  // twice by hand). Each edit is looked at once.
  const seen = new Set();
  const next = () => loadEdits(root, id).filter((e) => e.state === 'requested' && !e.route_failed && !seen.has(e.id));
  // after the last one, a short wait for one more (the app sends the next take as soon as the last call answers)
  const more = async () => {
    let open = next();
    if (!open.length && out.handled.length && settleMs > 0) { await new Promise((ok) => setTimeout(ok, settleMs)); open = next(); }
    return open;
  };
  for (let open = await more(); open.length; open = await more()) for (const edit of open) {
    seen.add(edit.id);
    const c = classifyEdit(edit);
    if (!c || engine !== 'elevenlabs' || (only && !only.includes(c.route))) { out.left.push(edit.id); continue; }
    const work = projectPaths(root, id).work;
    const lines = readLines(work);
    const row = lines?.list.find((l) => l.id === edit.node);
    setEditState(root, id, edit.id, 'fast');
    try {
      if (!row) throw new Error(`${edit.node} is not a line of voice/lines.json`);
      let words = c.route === 'words' ? c.words : null;
      if (c.route === 'note') {
        if (!run) throw new Error('no AI call available for the note');
        const r = await runAs(run, 'respell', { ...runArgs, workdir: join(paths(root).run, 'quick'), prompt: notePrompt(engine, row, c.note), config: { ...config, claudeArgs: ['--tools', '', '--json-schema', JSON.stringify(NOTE_SCHEMA)] } });
        out.usage.input_tokens += r.usage?.input_tokens || 0;
        out.usage.output_tokens += r.usage?.output_tokens || 0;
        if (r.structured?.question) {
          finishEdit0(root, id, edit, false, `Question: ${r.structured.question}`);
          out.handled.push(edit.id);
          onActivity({ kind: 'info', text: `${edit.label}: ${r.structured.question}` });
          continue;
        }
        words = String(r.structured?.text || '').trim();
        if (!words) throw new Error('the note call gave no text');
      }
      if (words) {
        const fresh = readLines(work);
        const l = fresh.list.find((x) => x.id === edit.node);
        l.text = words;
        if (c.route === 'words') l.script = words; // new words: what is checked changes too (a note keeps the script's words)
        writeFileSync(fresh.f, JSON.stringify(fresh.raw, null, 2));
      }
      onActivity({ kind: 'info', text: `${edit.label}: a new take, done by the studio (no session).` });
      const r = await (deps.retake || retakeLine)({ root, id, line: edit.node, engine, env, onActivity });
      if (!r.ok) throw new Error(r.why || 'the retake failed');
      syncCanvas(root, id);
      finishEdit0(root, id, edit, true, `New take made by the studio${words ? ' with the new words' : ''}.`);
      out.handled.push(edit.id);
    } catch (e) {
      // A voice line's new take is never handed to a Claude session: the session's own voice tools made an MP3 take
      // beside the lossless one and recorded the line twice (run 2026-11-02, Dir2: 4 calls for 3 lines, "take 5 of 5").
      // It fails here, plainly, and the owner presses Make again.
      event(root, id, { event: 'EDIT_ROUTE_FAILED', details: `${edit.id} ${edit.label}: ${e.message}`.slice(0, 300) });
      try { finishEdit0(root, id, edit, false, `No new take was made: ${String(e.message).slice(0, 300)}. Press Make again to try once more.`); } catch { /* gone */ }
      out.failed.push(edit.id);
      out.handled.push(edit.id);
    }
  }
  return out;
}

function finishEdit0(root, id, edit, ok, note) {
  finishEdit(root, id, edit.id, { ok, note, via: 'code' });
}
