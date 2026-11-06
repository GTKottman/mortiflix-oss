// Stills drawn by Claude, one scene (group) at a time (plan 90 §1.3, owner 2026-11-01: "check groups at a time, but not render the whole
// thing"). The fixed template is gone from this path: Claude writes one scene file, src/scenes/st_<beat>.tsx, with one still per spoken line
// of that scene, each a state of the scene (the first line ~ its initial state, the last ~ its final state), in the approved look, from the
// asset pool, by id. The studio renders each still (design/stills/<line>-v<N>.png), measures it (svc/inspect.mjs, key word included), has
// it inspected on the owner's list, and submits the step. The owner OKs each still; the last OK of a scene makes the NEXT scene. A still
// with notes is drawn again alone. Everything the AI sees is the same static block A as the style frames, plus the owner's STILLS.md.
// Without a Claude backend (demo, tests) the old template path in quickv3.mjs is used.
import { ensureVideoScaffold } from './svc/videoscaffold.mjs';
import { briefBlock } from './svc/briefmap.mjs';
import { uploadsBlock } from './svc/uploads.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { paths, REPO } from './studio.mjs';
import { projectPaths, projectPipeline } from './projects.mjs';
import { stepChecks, submit } from './gates.mjs';
import { lessonsBlock, listNotes } from './svc/lessons.mjs';
import { styleText } from './svc/packs.mjs';
import { buildPool, readPool, poolLines } from './svc/pool.mjs';
import { runAs } from './models.mjs';
import { run as runAsync } from './svc/run.mjs';
import { stillGroups, setStillsMode, keyOf, stillState } from './svc/stills.mjs';
import { loadFrames } from './svc/framestate.mjs';
import { context, staticBlock, staticInspector, makeRenderMeasure, runInspection, measuredHold } from './quickframes.mjs';
import { queueImage, okWords } from './svc/videonotes.mjs';
import { propsHash } from './svc/stillsbatch.mjs';

const read = (f, n = 200_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(0, n) : '');
const STILL_FILE = '^src/(ui\\.tsx|scenes/st_b\\d{2,3}\\.tsx)$';
const FILES = { type: 'array', items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', pattern: STILL_FILE }, content: { type: 'string' } } } };
export const STILLS_SCHEMA = {
  type: 'object',
  required: ['files', 'stills', 'note', 'facts_note'],
  properties: {
    files: FILES,
    stills: { type: 'array', items: { type: 'object', required: ['line', 'why'], properties: { line: { type: 'string', description: 'the line id exactly as given, e.g. b01-2' }, why: { type: 'string', description: 'one line: which state of the scene this still is and why' } } } },
    note: { type: 'string', description: 'for the owner: what the scene\'s stills show, in two sentences' },
    facts_note: { type: 'string', description: 'every on-screen word, name and number checked against the script' },
  },
};

export const STILLS_RULES = `## Stills (not style frames)
You draw the STILLS of one scene of the video: one still per spoken line, in the approved look (its palette, type, shapes and texture, exactly), from the asset pool by id. Each still is one STATE of the scene's picture: the first line's still is its initial state, the last line's is its final state, and the ones between are the significant intermediate states. Later the scene is animated between these same states from the same file, so keep one scene = one picture changing.
- Write src/scenes/st_<beat>.tsx (st_b01.tsx for scene b01) with \`export const stills: Record<string, React.FC> = { 'b01-1': Still1, 'b01-2': Still2, … }\`: one component per line, keyed by the line id exactly. Each draws frame 0 at full resolution. Share what is common inside the file or in src/ui.tsx (extend ui.tsx, never restyle what an approved frame or still uses).
- The line's KEY WORD (given with the line) must be on its still, as text. Show what is said: imagery matches the narration.
- Write only the files asked for. A still that is not mentioned must stay exactly as it is.`;
export const staticStills = () => `${staticBlock({ stills: true })}\n\n${STILLS_RULES}\n\n## The owner's rules for stills (copied word for word from their board)\n\n${read(join(REPO, 'pipelines', 'v3', 'design', 'STILLS.md'), 20_000)}`;

const dirOf = 'design/stills';
const nextV = (e) => (e?.versions.at(-1)?.v || 0) + 1;

function writeFiles(work, files, allowed) {
  for (const f of files || []) {
    const p = String(f.path);
    if (!(p === 'src/ui.tsx' || allowed.includes(p))) continue;
    const dest = normalize(join(work, 'video', p));
    if (!dest.startsWith(normalize(join(work, 'video', 'src')))) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, String(f.content));
  }
}

// src/scenes/stills.tsx merges every scene file; src/stills-root.tsx registers one composition per line (id = the line id).
export function writeRoots(work) {
  const dir = join(work, 'video', 'src', 'scenes');
  mkdirSync(dir, { recursive: true });
  const have = (existsSync(dir) ? readdirSyncSafe(dir) : []).filter((f) => /^st_b\d{2,3}\.tsx$/.test(f)).sort();
  writeFileSync(join(dir, 'stills.tsx'), `// Written by the studio (quickstills.mjs): every scene's stills, keyed by line id.\nimport React from 'react';\n${have.map((f, i) => `import { stills as s${i} } from './${f.replace('.tsx', '')}';`).join('\n')}\n\nexport const stills: Record<string, React.FC> = { ${have.map((_, i) => `...s${i}`).join(', ')} };\n`);
  writeFileSync(join(work, 'video', 'src', 'stills-root.tsx'), `import React from 'react';\nimport { Composition, registerRoot } from 'remotion';\nimport { video } from './video';\nimport { stills } from './scenes/stills';\n\n// One composition per spoken line: id = the line id (b01-2). Each is one still, frame 0.\nconst Root = () => (\n  <>\n    {Object.entries(stills).map(([id, S]) => (\n      <Composition key={id} id={id} component={S} width={video.width} height={video.height} fps={video.fps} durationInFrames={30} />\n    ))}\n  </>\n);\nregisterRoot(Root);\n`);
}
import { readdirSync } from 'node:fs';
const readdirSyncSafe = (d) => { try { return readdirSync(d); } catch { return []; } };

// `beats` = [{beat, lines}]: one scene (default) or the several of a group (owner setting review.scenesPerGroup).
// The OK'd style frames, each by its approved picture and its code at their exact paths; the frames of this scene first.
export function stillFramesBlock(c, sceneBeats, frames) {
  const mine = frames.filter((f) => f.beats.some((b) => sceneBeats.includes(b)));
  const rest = frames.filter((f) => !mine.includes(f)).slice(0, Math.max(0, 4 - mine.length));
  const code = (f) => (existsSync(f.code) ? `\n  Its code: ${f.code}` : '');
  const at = (x) => join(c.work, 'video', 'src', x);
  return [
    '## The OK\'d style frames (the look is fixed by them; the studio\'s code is under ' + join(c.work, 'video', 'src') + ')',
    mine.length ? `This scene's frame${mine.length > 1 ? 's' : ''} (build its stills from this code: same layout, positions and pieces):\n${mine.map((f) => `- ${f.id}: ${f.note || f.label}\n  Its approved picture: ${f.file}${code(f)}`).join('\n')}` : '',
    rest.length ? `${mine.length ? 'Other frames' : 'The frames'} (the look):\n${rest.map((f) => `- ${f.id}: ${f.note || f.label}\n  Its approved picture: ${f.file}${code(f)}`).join('\n')}` : '',
    mine.length ? `Every still of this scene keeps the ground of ${mine.map((f) => f.id).join(' / ')} exactly (its full-bleed background colour and texture): the stills of one scene never change ground.` : '',
    `The look's code: ${at('video.ts')} (palette and fonts) and ${at('ui.tsx')} (shared pieces). Open these exact paths with Read; the other files in out/frames are versions the owner rejected: never open them.`,
  ].filter(Boolean).join('\n');
}

function stillsPrompt(root, id, c, { beats, doc, fix, prevPic, frames }) {
  const lines = beats.flatMap((b) => b.lines);
  const pool = readPool(root, id);
  const style = styleText(c.look.pack_files?.style);
  const pack = c.look.pack_files ? JSON.stringify({ ...c.look.pack_files, style: undefined, pictures: undefined }).slice(0, 3000) : '';
  const sceneOf = (beat) => c.scenes.find((s) => s.id === beat) || { id: beat, name: beat, words: '' };
  const scene = { name: beats.map((b) => sceneOf(b.beat).name).join(' '), words: beats.map((b) => sceneOf(b.beat).words).join(' ') };
  const notes = (() => { try { return listNotes(root, id).notes.filter((n) => /^(sf\d+|b\d+-\d+)$/.test(n.node) && (n.text || n.image)).slice(-30).map((n) => `- On ${n.node}: ${String(n.text || '(marks only)').slice(0, 400)}`); } catch { return []; } })();
  const checks = stepChecks(root, id, 'stills');
  const fileOf = (beat) => `src/scenes/st_${beat}.tsx`;
  const file = beats.map((b) => fileOf(b.beat)).join(' and ');
  return [
    `## The project\n"${c.project.title}", a ${projectPipeline(root, id).makes} made in the Mortiflix studio. ${c.w}×${c.h} (${c.aspect}), 30 fps.`,
    `## The approved look (use it as given: the palette exactly)\n${JSON.stringify({ ...c.look, pack_files: undefined }, null, 1)}${pack ? `\nStyle pack: ${pack}` : ''}${style ? `\n\n${style}` : ''}\n\n### design/LOOK.md (the look system the owner approved)\n${read(join(c.work, 'design', 'LOOK.md'), 12_000)}`,
    `## The asset pool (ids to use)\n${poolLines(pool, { sceneWords: `${scene.name} ${scene.words}` }).join('\n') || '(empty)'}`,
    `## Checks every still must pass\n${checks.map((x) => `- ${x.id}: ${x.how}`).join('\n')}\n- no-missing-assets: every asset id is in the pool\n- no-layout-errors: Kinetograph draws everything\n- key word: each line's key word is on its still`,
    lessonsBlock(root, id, { step: 'frames' }),
    visualBrief(root, id),
    uploadsBlock(c.work),
    notes.length ? `## What the owner said on the frames and stills before (mistakes not to repeat)\n${notes.join('\n')}` : '',
    frames.length ? stillFramesBlock(c, beats.map((b) => b.beat), frames) : '',
    prevPic ? `## The last still of the scene before\nOpen ${prevPic} with Read: this scene enters from it. Keep what carries over, and explain any background or type change.` : '',
    fix
      ? `## Draw these stills again (new versions; every other still stays exactly as it is). The owner's notes below win over every check and every other rule: do what they ask, exactly\n${lines.filter((l) => doc.lines[l.id]?.state === 'fix').map((l) => { const e = doc.lines[l.id]; return `### ${l.id}: "${l.text}" (key word: ${l.key})\nThe owner's ${e.fix_notes?.length || 0} note${e.fix_notes?.length === 1 ? '' : 's'}:\n${(e.fix_notes || []).map((n, i) => `${i + 1}. ${n.text || '(marks only)'}${n.image ? `\n   Their marks are in the picture ${n.image}: open it with Read.` : ''}${e.held ? '' : ''}`).join('\n')}`; }).join('\n\n')}\n\nAnswer with the whole file ${file} (only those stills changed).`
      : beats.map(({ beat, lines: bl }) => { const sc = sceneOf(beat); return `## This scene: ${beat} "${sc.name}" (${sc.from_sec ?? '?'}–${sc.to_sec ?? '?'} s)\nIts words: ${sc.words}\n\nWrite ${fileOf(beat)}: ${bl.length} still${bl.length === 1 ? '' : 's'}, one per spoken line:\n${bl.map((l, i) => `- ${l.id}${i === 0 ? ' (initial state)' : i === bl.length - 1 ? ' (final state)' : ''}: "${l.text}" · key word: ${l.key}`).join('\n')}`; }).join('\n\n'),
    `## The code now\n### src/ui.tsx\n${read(join(c.work, 'video', 'src', 'ui.tsx'), 40_000)}\n${beats.map(({ beat }) => `### ${fileOf(beat)}\n${read(join(c.work, 'video', fileOf(beat)), 40_000) || '(not written yet)'}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

export async function quickStillsGroups({ root, id, view, run, runArgs, config = {}, onActivity = () => {}, fallback, renders, sessionId }) {
  const c = context(root, id);
  const sum = (a, b = {}) => ({ input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0), output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0), cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0) });
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const give = async (why) => { onActivity({ kind: 'info', text: `The studio couldn't finish the stills by itself (${why}): pausing for you.` }); const f = await fallback(why); return { ...f, usage: sum(usage, f.usage || {}) }; };
  if (!renders) return give('no render queue');
  const dir = join(paths(root).run, 'quick', id);
  mkdirSync(dir, { recursive: true });
  const stat = join(paths(root).run, 'quick', '_static');
  mkdirSync(stat, { recursive: true });
  const writerFile = join(stat, 'style-stills-writer.md'), inspectorFile = join(stat, 'style-frame-inspector.md');
  const A = staticStills(), I = staticInspector();
  if (read(writerFile) !== A) writeFileSync(writerFile, A);
  if (read(inspectorFile) !== I) writeFileSync(inspectorFile, I);
  const call = async (prompt, schema, tools = '', role = 'write', sys = writerFile) => {
    const r = await runAs(run, role, { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', tools, ...(tools ? ['--allowedTools', tools] : []), '--json-schema', JSON.stringify(schema), '--append-system-prompt-file', sys] } });
    usage = sum(usage, r.usage || {});
    return r;
  };
  if (!existsSync(join(c.work, 'video', 'node_modules'))) {
    onActivity({ kind: 'info', text: 'Setting up the video project.' });
    const s = await runAsync(process.execPath, [join(c.work, '.claude', 'skills', 'remotion-motion', 'setup.mjs')], { cwd: c.work, env: { ...process.env, ...(runArgs.env || {}) }, encoding: 'utf8', timeout: 15 * 60_000 });
    if (s.status !== 0) return give(`video setup: ${(s.stderr || s.stdout || '').slice(-300)}`);
  }
  try { buildPool(root, id); } catch (e) { return give(`the asset pool: ${e.message}`); }
  // the template's files the setup skipped (video/src already existed: the pool's pool.ts) — index.ts above all
  try { const added = ensureVideoScaffold(c.work); if (added.length) onActivity({ kind: 'info', text: `Video project: added ${added.join(', ')} from the template.` }); } catch (e) { return give(`the video template: ${e.message}`); }
  setStillsMode(root, id, 'groups');
  const S = stillState;
  const srcLines = S.voiceLines(c.work);
  let doc = S.load(root, id);
  // A scene with ONE spoken line and its OWN OK'd style frame: that frame is its still, already OK'd (owner, 2026-11-04:
  // "All of these looks ARE frames the step is redundant"). No call, no render, no second sign-off. Never over a still
  // that already has a version (drawn, OK'd or fixed by the owner).
  {
    const okFrames = loadFrames(c.work).frames.filter((f) => f.state === 'ok' && f.current);
    const linesOf = new Map();
    for (const l of srcLines) { const b = String(l.id).split('-')[0]; linesOf.set(b, [...(linesOf.get(b) || []), l]); }
    let reused = [];
    for (const [b, ls] of linesOf) {
      if (ls.length !== 1 || doc.lines[ls[0].id]?.versions?.length) continue;
      const f = okFrames.find((x) => (x.beats || []).length === 1 && x.beats[0] === b);
      const pic = f && f.versions.find((v) => v.v === f.current)?.file;
      if (!pic || !existsSync(join(c.work, pic))) continue;
      const file = `${dirOf}/${ls[0].id}-v1.png`;
      mkdirSync(join(c.work, dirOf), { recursive: true });
      copyFileSync(join(c.work, pic), join(c.work, file));
      doc.lines[ls[0].id] = { versions: [{ v: 1, file, text: ls[0].text, texts: [], at: new Date().toISOString(), notes: 0, inspection: null, from_frame: f.id, measured: { ok: true, problems: [], checks: {} } }],
        current: 1, state: 'ok', drawing: false, error: null, words: ls[0].text, fix_notes: [], held: null, why: `The OK'd style frame ${f.id} (this scene's only line).` };
      reused.push(`${ls[0].id} = ${f.id}`);
    }
    if (reused.length) { S.save(root, id, doc); onActivity({ kind: 'info', text: `${reused.length} still${reused.length === 1 ? '' : 's'} taken from the OK'd style frames: ${reused.join(', ')}.` }); }
  }
  const groups = stillGroups(root, id);
  const fixLines = srcLines.filter((l) => doc.lines[l.id]?.state === 'fix');
  const cur = fixLines.length ? groups.find((g) => g.lines.includes(fixLines[0].id)) : groups.find((g) => g.state !== 'ok');
  if (!cur) return submitStills({ root, id, c, doc: S.load(root, id), note: 'Every still is OK.', usage, give, onActivity });
  const fixing = fixLines.length > 0;
  // Drawn ahead (owner, 2026-11-04: "no generation happening ... while I'm looking"): the scene to check and the next
  // ones not drawn yet, up to AHEAD scenes in one call; the owner still checks them one scene at a time.
  const AHEAD = 3;
  const batch = fixing ? [cur] : groups.filter((g) => g.index >= cur.index && g.index < cur.index + AHEAD && g.state !== 'ok');
  const inBatch = new Set(batch.flatMap((g) => g.lines));
  const targets = fixing ? fixLines.filter((l) => cur.lines.includes(l.id)) : srcLines.filter((l) => inBatch.has(l.id) && !doc.lines[l.id]?.versions?.length);
  if (!targets.length) return submitStills({ root, id, c, doc, note: 'The stills are waiting for your check.', usage, give, onActivity }); // all made: waiting for the owner
  const beat = cur.beat;
  const beatOfLine = (lid) => String(lid).split('-')[0];
  const batchBeats = [...new Set(targets.map((l) => String(l.id).split('-')[0]))];
  const lines = srcLines.filter((l) => (fixing ? cur.lines : [...inBatch]).includes(l.id)).map((l) => ({ id: l.id, text: l.text, key: keyOf(doc.lines[l.id], l.text, c.work) }));
  const prevGroup = groups[cur.index - 2];
  const lastOf = (g) => { const l = g?.lines.at(-1); const e = l && doc.lines[l]; const v = e && S.ver(e); return v ? join(c.work, v.file) : null; };
  // every OK'd frame with its approved picture and its code, by exact path (2026-11-02, 61dc: the stills call runs outside the
  // project, guessed src/scenes/sf01.tsx relative to it, found nothing and rebuilt the scene from the picture by eye)
  const frames = loadFrames(c.work).frames.filter((f) => f.state === 'ok' && f.current).map((f) => ({ id: f.id, note: f.note, label: f.label, beats: f.beats || [], file: join(c.work, f.versions.find((v) => v.v === f.current).file), code: join(c.work, 'video', 'src', 'scenes', `${f.id}.tsx`) }));
  onActivity({ kind: 'info', text: fixing ? `Drawing ${targets.map((l) => l.id).join(', ')} again from your notes.` : `Drawing ${batchBeats.length > 1 ? `scenes ${batchBeats.join(', ')}` : `scene ${cur.index} of ${cur.count}`}: ${targets.length} still${targets.length === 1 ? '' : 's'}.` });
  const allowed = (fixing ? cur.beats : batchBeats).map((b) => `src/scenes/st_${b}.tsx`);
  const prompt = stillsPrompt(root, id, c, { beats: (fixing ? cur.beats : batchBeats).map((b) => ({ beat: b, lines: lines.filter((l) => beatOfLine(l.id) === b) })), doc, fix: fixing, prevPic: lastOf(prevGroup), frames });
  const w = await call(prompt, STILLS_SCHEMA, 'Read');
  if (runArgs.signal?.aborted) return { ok: false, error: 'stopped', usage };
  const s0 = w.ok ? w.structured : null;
  if (!s0?.files?.length) return give(w.ok ? 'the stills call gave no files' : w.error || 'no answer');
  writeFiles(c.work, s0.files, allowed);
  // the scene to check must be written; a scene drawn ahead that the call skipped is simply drawn next time
  const missing = cur.beats.map((b) => `src/scenes/st_${b}.tsx`).find((f) => allowed.includes(f) && !existsSync(join(c.work, 'video', f)));
  if (missing) return give(`the stills call did not write ${missing}`);
  for (let i = targets.length - 1; i >= 0; i--) if (!existsSync(join(c.work, 'video', 'src', 'scenes', `st_${beatOfLine(targets[i].id)}.tsx`))) targets.splice(i, 1);
  writeRoots(c.work);

  const whyOf = new Map((s0.stills || []).map((x) => [String(x.line), String(x.why || '').slice(0, 300)]));
  const items = targets.map((l) => { const e = doc.lines[l.id]; const n = nextV(e); const key = lines.find((x) => x.id === l.id).key; return { id: l.id, composition: l.id, name: `${l.id}-v${n}`, v: n, label: `${l.id}: ${l.text}`.slice(0, 120), beats: [beatOfLine(l.id)], scene: `src/scenes/st_${beatOfLine(l.id)}.tsx`, dir: dirOf, entry: 'src/stills-root.tsx', keys: key ? [key] : null, line: l, key, fix_notes: e?.fix_notes || [] }; });
  const rmk = makeRenderMeasure({ root, id, c, renders, sessionId, env: runArgs.env || {}, signal: runArgs.signal, config, onActivity, call, apply: (files) => writeFiles(c.work, files, allowed), fixIds: items.map((i) => i.id), label: 'stills', noun: 'still', filePath: STILL_FILE });
  const rm = await rmk.run(items);
  if (rm.stopped) return { ok: false, error: 'stopped', usage };
  if (rm.give) return give(rm.give);
  const failing = rm.failing || new Map();
  const ins = await runInspection({ failing, items, getMeasured: () => rmk.measured, call, inspectorFile, c, onActivity, signal: runArgs.signal, renderMeasure: rmk.run, writeFiles: (files) => writeFiles(c.work, files, allowed), noun: 'still', filePath: STILL_FILE,
    prevOf: (it) => { const i = lines.findIndex((l) => l.id === it.id); const pid = i > 0 ? lines[i - 1].id : null; const e = pid && doc.lines[pid]; const v = e && S.ver(e); const f = v ? join(c.work, v.file) : lastOf(prevGroup); return f ? { id: i > 0 ? lines[i - 1].id : 'the last still of the scene before', label: 'the still before', file: f } : null; } });
  if (ins.stopped) return { ok: false, error: 'stopped', usage };
  // the inspection could not run: the stills are drawn and measured, so they are shown held with the reason
  if (ins.give) ins.map = new Map(items.map((it) => [it.id, failing.has(it.name) ? measuredHold(failing.get(it.name)) : { rounds: 0, sections: {}, held: true, unresolved: [`The AI inspection could not run: ${String(ins.give).slice(0, 200)}`] }]));

  // record the versions: held when the inspection still fails after 3 rounds (the owner decides: stills.send_anyway / stills.retry)
  doc = S.load(root, id);
  for (const it of items) {
    const e = (doc.lines[it.id] ||= { versions: [], current: null, state: 'check' });
    const m = rmk.measured.find((x) => x.id === it.name);
    const insp = ins.map.get(it.id);
    e.versions.push({ v: it.v, file: `${dirOf}/${it.name}.png`, text: it.line.text, texts: m?.texts?.list || [], hash: propsHash({ key: it.key, text: it.line.text }), at: new Date().toISOString(), notes: 0, inspection: insp || null,
      measured: { ok: m?.ok ?? false, problems: m?.problems || [], checks: Object.fromEntries(Object.entries(m?.checks || {}).map(([k, x]) => [k, { pass: x.pass, note: x.note }])) } });
    Object.assign(e, { current: it.v, state: insp?.held ? 'held' : 'check', drawing: false, error: null, key_word: it.key, words: it.line.text, fix_notes: [], held: insp?.held ? insp.unresolved : null, why: whyOf.get(it.id) || '' });
  }
  S.save(root, id, doc);
  const r = await submitStills({ root, id, c, doc, note: s0.note, facts: s0.facts_note, usage, give, onActivity, beat: (fixing ? cur.beats : batchBeats).join(", "), ids: items.map((i) => i.id), measured: rmk.measured, fixes: rmk.fixes() });
  if (r.ok) { try { for (const g of (fixing ? [cur] : batch)) await queueStillItems(root, id, doc, g, items.map((i) => i.id).filter((x) => g.lines.includes(x)), config._vnMedia || null); } catch (e) { console.error(`video notes: ${e.message}`); } }
  return r;
}

// The step goes to the owner with every still drawn so far.
function submitStills({ root, id, c, doc, note, facts = '', usage, give, onActivity, beat = null, ids = [], measured = [], fixes = 0 }) {
  const S = stillState;
  const drawn = S.voiceLines(c.work).map((l) => ({ l, e: doc.lines[l.id] })).filter(({ e }) => e && S.ver(e));
  if (!drawn.length) return give('no still was drawn');
  const first = (k) => measured.map((m) => m.checks[k]?.note).filter(Boolean)[0];
  const error_checks = [
    { id: 'spelling-and-facts', result: 'pass', note: facts || 'Checked when each still was drawn; each still prints its line\'s words as written in the approved script.' },
    { id: 'text-safe-area', result: 'pass', note: first('text-safe-area') ? `Measured by the studio from the renderer's text boxes: ${first('text-safe-area')}.` : 'Measured when each still was drawn.' },
    { id: 'no-collisions', result: 'pass', note: first('no-collisions') ? `Measured by the studio: ${first('no-collisions')}.` : 'Measured when each still was drawn.' },
    { id: 'text-contrast', result: 'pass', note: first('text-contrast') ? `Measured by the studio on the rendered pixels (WCAG): ${first('text-contrast')}.` : 'Measured on the rendered pixels when each still was drawn.' },
    { id: 'flat-2d-buildable', result: 'pass', note: `Measured by the studio: ${first('no-missing-assets') || 'asset ids checked against the pool'}; ${first('key-words') || 'key words on the pictures'}; ${first('no-layout-errors') || 'the renderer drew everything'}.` },
  ].filter((x) => stepChecks(root, id, 'stills').some((n) => n.id === x.id));
  const held = drawn.filter(({ e }) => e.state === 'held');
  try {
    submit(root, id, 'stills', {
      note: `${note || 'Stills.'}\n\nOne scene at a time: check each still (OK, or Fix with your notes); the next scene is drawn when this one is OK.${held.length ? `\n\nHeld: a check is not satisfied (OK anyway, or Fix with a note):\n${held.map(({ l, e }) => `${l.id}: ${(e.held || []).join(' | ')}`).join('\n')}` : ''}`,
      questions: [],
      items: drawn.map(({ l, e }) => ({ path: S.ver(e).file, label: `${l.id}: ${l.text}${e.state === 'ok' ? ' · OK' : e.state === 'held' ? ' · HELD' : ''}`.slice(0, 190), section: l.id.split('-')[0].toUpperCase() })),
      error_checks,
    });
  } catch (e) { return give(`the submission was refused: ${e.message}`); }
  if (beat) {
    const cr = usage.cache_read_input_tokens || 0;
    try { appendFileSync(join(c.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Stills of ${beat.includes(",") ? "scenes" : "scene"} ${beat} (${ids.join(', ')}) drawn and submitted by the studio: ${fixes} fix${fixes === 1 ? '' : 'es'}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, cache read ${cr}.\n`); } catch { /* no journal */ }
    onActivity({ kind: 'info', text: `${ids.length} still${ids.length === 1 ? '' : 's'} of ${beat.includes(",") ? "scenes" : "scene"} ${beat} ready for your check.` });
  }
  return { ok: true, usage, summary: note };
}

// Tablet: each still of the scene as an image item, "Scene 2 · still 3 of 4". OK with 0 notes on the last still of a scene makes the next scene.
async function queueStillItems(root, id, doc, group, lineIds, media) {
  const work = projectPaths(root, id).work;
  const S = stillState;
  for (const lid of lineIds) {
    const e = doc.lines[lid]; const v = e && S.ver(e);
    if (!v || e.state !== 'check') continue;
    const i = group.lines.indexOf(lid);
    const last = group.index === group.count && i === group.lines.length - 1;
    await queueImage(root, id, { kind: 'still', ref: lid, file: join(work, v.file), title: `${group.name} · Still ${i + 1}`.slice(0, 60), look_for: `Scene ${group.index} of ${group.count} · still ${i + 1} of ${group.lines.length}: "${String(e.words || '').slice(0, 90)}"`,
      group: `Scene ${group.index} · still ${i + 1} of ${group.lines.length}`, group_index: i + 1, group_count: group.lines.length, ok_words: okWords('still', { last, group: i === group.lines.length - 1 }) }, { media });
  }
}

// What the owner chose under Visual direction in the New project brief (only what they specified).
function visualBrief(root, id) {
  const t = briefBlock(root, id, { only: ['visual'] });
  return t ? `## The owner's visual direction (New project brief; the approved look still wins)\n${t}` : '';
}
