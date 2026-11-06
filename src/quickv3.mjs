// The v3 steps the studio does itself, with no session (pipelines/v3): stills, sound, artcraft, and the music plan that
// follows the voice. None of them calls a paid API on its own:
//   stills    svc/stills.mjs makeStills: one still per voice line (Kinetograph, local), submitted for review.
//   sound     svc/sfx.mjs makePlan: cues from the motion, library sounds copied in, a mix of what exists. New sounds are
//             paid (ElevenLabs credits): they stay "planned" until the owner confirms in the app (sfx.make confirm:true).
//   artcraft  svc/artcraft.mjs runChecks + writeArtcraft: the checks, then the .mortiflix file. ArtCraft is never launched.
//   music     svc/elmusic.mjs makeMusicPlan: the cue plan only. Making the cues costs credits; the owner confirms in the app.
// `studio` injects the parts tests (and the orchestrator) replace: renderStill, ask, runChecks, writeArtcraft, mixSounds.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { loadProject, projectPaths, projectPipeline, event } from './projects.mjs';
import { stepView, stepChecks, submit, needsYou } from './gates.mjs';
import { makeStills, stillsView, drawLines } from './svc/stills.mjs';
import { kinetographBatch } from './svc/stillsbatch.mjs';
import { quickStillsGroups } from './quickstills.mjs';
import { makePlan, mixSounds, summary, soundPaths, actionsOf, baseAudio, creditsFor } from './svc/sfx.mjs';
import { refreshMotionData } from './motiondata.mjs';
import { storyActionsFor } from './svc/storysfx.mjs';
import { runAs } from './models.mjs';
import { paths } from './studio.mjs';
import { runChecks, writeArtcraft } from './svc/artcraft.mjs';
import { makeMusicPlan, ensureMusicMix } from './svc/elmusic.mjs';
import { musicExpected, musicCues, musicHeld } from './svc/musicneed.mjs';
import { voiceConfig } from './voice/index.mjs';

export const V3_QUICK = ['stills', 'sound', 'artcraft'];

// The one v3 step the studio does alone now, or null (a session, or nothing, is next).
export function quickV3Step(root, id, config) {
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  if (pipeline.stage_set !== 'v3' || config.quickV3 === false) return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || !V3_QUICK.includes(runnable[0].key)) return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  return runnable[0];
}

const rel = (work, f) => relative(work, f);
// Every check the step lists, answered for what this step really verified.
function answer(root, id, key, notes) {
  return stepChecks(root, id, key).map((c) => {
    const n = notes[c.id];
    return n ? { id: c.id, result: n.result || 'pass', note: n.note } : { id: c.id, result: 'n/a', note: `Not measured by the studio for this step: look at it yourself (${c.title}).` };
  });
}
// Notes of the owner on a version being remade: every one answered, honestly.
const pins = (view, change) => (view.last_feedback?.verdict === 'changes' && view.last_feedback.notes > 0
  ? Array.from({ length: view.last_feedback.notes }, (_, i) => ({ note: i + 1, change, status: 'partly' })) : undefined);

export async function quickStills(args) {
  // Claude draws the stills, one scene at a time (quickstills.mjs). The old fixed template below is the demo path: no AI backend, or a test's renderStill.
  if (args.run && !args.studio?.renderStill && args.config?.stillsTemplate !== true) return quickStillsGroups(args);
  return quickStillsTemplate(args);
}

async function quickStillsTemplate({ root, id, view, studio = {}, onActivity = () => {}, renders = null, sessionId = null }) {
  const work = projectPaths(root, id).work;
  onActivity({ kind: 'info', text: 'Drawing one still per spoken line.' });
  // G3: one Kinetograph render (one bundle) for every picture to draw, through the render queue when there is one.
  // An injected studio.renderStill (tests) keeps the old one-by-one path.
  const batch = studio.renderStill ? null : kinetographBatch({ root, work, renders, projectId: id, sessionId });
  const opts = { render: studio.renderStill, renderBatch: batch };
  if (view.state === 'changes') {
    // the lines the owner has not signed off are drawn again; the ones they OK'd stay, and so do unchanged pictures
    await drawLines(root, id, stillsView(root, id).lines.filter((x) => x.state !== 'ok').map((x) => x.line), opts);
  }
  const made = await makeStills(root, id, opts);
  const lines = stillsView(root, id).lines;
  const drawn = lines.filter((l) => l.path && existsSync(l.path));
  if (!drawn.length) { needsYou(root, id, `No still could be drawn${lines.find((l) => l.error) ? `: ${lines.find((l) => l.error).error}` : ''}. Check the renderer, then resume.`); return { ok: false, error: 'no stills drawn' }; }
  const failed = lines.filter((l) => !l.path);
  const shown = drawn.filter((l) => l.key_word_visible !== false && l.check.key_word_visible !== false);
  const note = `${drawn.length} stills, one per spoken line, in the approved look. Each shows its line's words and its key word.${failed.length ? ` ${failed.length} line(s) could not be drawn: ${failed.map((l) => l.line).join(', ')}.` : ''} ${shown.length} of ${drawn.length} key words are on their picture.`;
  const basis = (what) => ({ note: `${what} Checked from the still's own text layer, not by measuring pixels.` });
  submit(root, id, 'stills', {
    note,
    questions: [],
    items: drawn.map((l) => ({ path: rel(work, l.path), label: `${l.line}: ${l.words}`.slice(0, 190), section: l.line.split('-')[0].toUpperCase() })),
    error_checks: answer(root, id, 'stills', {
      'spelling-and-facts': basis('Each still prints its line\'s words as written in the approved script (copied, not retyped).'),
      'flat-2d-buildable': { note: 'Every still is drawn by code in the approved look, from the studio\'s template and the project\'s asset pool (packs and the default textures) only.' },
    }),
    pin_changes: pins(view, 'Drew again every line you had not signed off, same look; your words are in the chat.'),
  });
  return { ok: true, made: made.made };
}

// ---- sound: plan + library sounds + a mix of what exists. Never a paid call. ----
// the owner's notes on the step's last version ("changes"), as plain text for a prompt; '' when none
export function ownerNote(work, step, view) {
  const fb = view?.last_feedback;
  if (!fb || fb.verdict !== 'changes') return '';
  try {
    const j = JSON.parse(readFileSync(join(work, 'feedback', `${step}-v${fb.version}.json`), 'utf8'));
    return [j.overall, ...(j.notes || []).map((n) => n.text)].map((x) => String(x || '').trim()).filter(Boolean).join('\n').slice(0, 4000);
  } catch { return ''; }
}

export async function quickSound({ root, id, view, studio = {}, onActivity = () => {}, run = null, runArgs = {}, config = {} }) {
  const work = projectPaths(root, id).work;
  // the sound mixes the music: it waits for the voice step's music, made and OK'd (Look and Motion did not need it)
  const held = musicHeld(root, id);
  if (held) { needsYou(root, id, `The sound mixes the music, and ${held}. Do it on Voice & music, then press Resume.`); return { ok: false, error: held }; }
  // the motion's actions are read off the approved scenes; missing or failed (an inspect crash), they are read again
  // first, never a plan of 0 sound moments over approved motion (d4fd 2026-11-02)
  let md = null; try { md = JSON.parse(readFileSync(join(work, 'out', 'scenes.json'), 'utf8')).motion_data; } catch { /* no scenes yet */ }
  if (!actionsOf(work).length && md && md.ok === false) {
    onActivity({ kind: 'info', text: 'Reading the actions off the approved motion again (the last read failed).' });
    const r = await refreshMotionData({ root, work, probe: studio.motionProbe || null });
    if (!r.ok) { needsYou(root, id, `The sound plans from the motion's actions, and they could not be read: ${r.error}. Press Resume to try again.`); return { ok: false, error: r.error }; }
  }
  // the music made at Voice goes under the voice first; the sounds go on that mix
  const mm = ensureMusicMix(work);
  if (mm && !mm.ok) { needsYou(root, id, `The sound mixes the music, and the voice and music mix failed: ${mm.error}`); return { ok: false, error: mm.error }; }
  if (mm?.fresh) onActivity({ kind: 'info', text: 'Mixed the music under the voice (out/voice/mix.wav).' });
  onActivity({ kind: 'info', text: 'Planning the sound from the motion (library sounds only; nothing paid is made).' });
  // the story actions a sound designer would mark: the Motion's own marks, else one call over the approved motion code
  let story = null; let storyWhy = null;
  let scenesN = 0; try { scenesN = (JSON.parse(readFileSync(join(work, 'out', 'scenes.json'), 'utf8')).scenes || []).length; } catch { /* none */ }
  // the owner's note on the last plan goes to the story call (2026-11-02, bdb9: "Make it again" with a note planned 0 in 0.1 s)
  const ownerSaid = ownerNote(work, 'sound', view);
  if (actionsOf(work).length || scenesN) {
    const ask = studio.storyAsk || (run ? async (prompt, schema) => {
      const dir = join(paths(root).run, 'quick', id); mkdirSync(dir, { recursive: true });
      return runAs(run, 'review', { ...runArgs, workdir: dir, prompt, config: { ...config, claudeArgs: ['--tools', '', '--json-schema', JSON.stringify(schema)] } });
    } : null);
    let voiceSec = null; try { voiceSec = Number(JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8')).seconds) || null; } catch { /* none */ }
    if (ask || existsSync(join(work, 'video', 'src', 'sfx'))) {
      onActivity({ kind: 'info', text: 'Naming the story actions a sound should mark, from the approved motion code.' });
      const st = await storyActionsFor(work, { ask, rawActs: actionsOf(work), seconds: voiceSec, note: ownerSaid });
      if (st.actions?.length) { story = st.actions; onActivity({ kind: 'info', text: `${story.length} story actions (${st.source}).` }); }
      else { storyWhy = st.error || 'the story call named no actions'; onActivity({ kind: 'info', text: `No story actions (${storyWhy}): the sound marks the main moves instead.` }); }
    } else storyWhy = 'no AI call is available to read the approved scene code';
  }
  let plan;
  try { plan = makePlan(work, { story }); } catch (e) {
    if (e.code !== 'not_ready' || !baseAudio(work) || actionsOf(work).length || scenesN) {
      const why = scenesN ? `no sound moments were found in the ${scenesN} approved scenes (${storyWhy || e.message})` : e.message;
      const p = soundPaths(work); mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.plan, JSON.stringify({ made: new Date().toISOString(), shots: [], cues: [], why }, null, 2));
      needsYou(root, id, `The sound plan failed: ${why}. Press Resume to try again.`); return { ok: false, error: why };
    }
    // the motion lists no sound moments: the voice and music go through unchanged
    const p = soundPaths(work); mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.plan, JSON.stringify({ made: new Date().toISOString(), shots: [], cues: [] }, null, 2));
    plan = { cues: [] };
  }
  // approved motion and 0 moments is never a plan (bdb9 v2 "0 sound moments planned")
  if (!(plan.cues || []).length && scenesN) {
    const why = `no sound moments were found in the ${scenesN} approved scenes (${storyWhy || 'none named'})`;
    const p = soundPaths(work); writeFileSync(p.plan, JSON.stringify({ made: new Date().toISOString(), shots: [], cues: [], why }, null, 2));
    needsYou(root, id, `The sound plan failed: ${why}. Press Resume to try again.`); return { ok: false, error: why };
  }
  let mix;
  try { mix = (studio.mixSounds || mixSounds)(work); } catch (e) { needsYou(root, id, `The sound mix failed: ${e.message}`); return { ok: false, error: e.message }; }
  const cues = plan.cues || [];
  const ready = cues.filter((c) => c.status === 'ready' || c.status === 'ok').length;
  const paid = cues.filter((c) => c.source === 'generate' && c.status === 'planned');
  const sm = summary({ cues });
  const credits = sm.credits; // a repeated sound is made once
  const note = `${cues.length} sound moments planned from the ${plan.from === 'story' ? 'story actions in the motion' : 'motion'}: ${ready} are library sounds already in the mix${paid.length ? `, ${paid.length} use new sounds (${sm.sounds_to_make} distinct sound${sm.sounds_to_make === 1 ? '' : 's'} to make, about ${credits} ElevenLabs credits). None is made until you confirm the credits in Sound.` : '.'}`;
  const file = mix.file;
  submit(root, id, 'sound', {
    note,
    questions: [],
    items: [{ path: rel(work, file), label: `Mix with ${mix.sounds} sound${mix.sounds === 1 ? '' : 's'}` }],
    error_checks: answer(root, id, 'sound', {
      sync: { note: `Each sound sits at its action's time from the motion (${cues.length} cues); not measured against the voice by ear.` },
    }),
    pin_changes: pins(view, 'Planned the cues again from the motion; the sounds you edited or made stay.'),
  });
  return { ok: true, cues: cues.length, paid: paid.length };
}

// ---- artcraft: checks, then the .mortiflix file. ArtCraft is not launched. ----
export async function quickArtcraft({ root, id, view, studio = {}, onActivity = () => {} }) {
  const work = projectPaths(root, id).work;
  onActivity({ kind: 'info', text: 'Running the final checks and writing the ArtCraft project.' });
  let checks; let made;
  try {
    checks = (studio.runChecks || runChecks)(root, id);
    made = await (studio.writeArtcraft || writeArtcraft)(root, id, studio.cli ? { cli: studio.cli } : {});
  } catch (e) { needsYou(root, id, `The ArtCraft file could not be made: ${e.message}`); return { ok: false, error: e.message }; }
  const out = join(work, 'out', 'artcraft'); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  const items = [];
  const video = join(work, 'out', 'animatic.mp4');
  if (existsSync(video)) items.push({ path: rel(work, video), label: 'Video (the approved motion)' });
  if (made?.file && existsSync(made.file)) { const dest = join(out, basename(made.file)); copyFileSync(made.file, dest); items.push({ path: rel(work, dest), label: 'ArtCraft project (.mortiflix)' }); }
  // a check that did not run is "Not checked (why)", never OK (2026-11-02, 61dc: "All final checks are clean" over two
  // checks that never ran)
  const ran = (c) => c.checked !== false && !c.unverified;
  const bad = checks.filter((c) => ran(c) && !c.ok);
  const passed = checks.filter((c) => ran(c) && c.ok);
  const skipped = checks.filter((c) => !ran(c));
  const lines = checks.map((c) => (!ran(c) ? `Not checked ${c.key} (${String(c.reason || c.note || 'no data').replace(/^not checked: /, '')})`
    : `${c.ok ? 'OK' : 'LOOK'} ${c.key}${c.items?.length ? `: ${c.items.length} thing(s), first: ${c.items[0].text}` : c.note ? `: ${c.note}` : ''}`));
  const headline = `${passed.length} check${passed.length === 1 ? '' : 's'} passed${bad.length ? `, ${bad.length} found something to look at` : ''}${skipped.length ? `, ${skipped.length} not checked` : ''}:`;
  // sounds Finish left out of the film, each with its reason
  let fa = null; try { fa = JSON.parse(readFileSync(join(work, 'out', 'sound', 'final-audio.json'), 'utf8')); } catch { /* not built */ }
  if (fa?.left_out?.length) lines.push(`Left out of the final sound (${fa.left_out.length}): ${fa.left_out.map((x) => `${x.id} "${x.what}" at ${x.at_sec}s: ${x.why}`).join('; ')}`);
  submit(root, id, 'artcraft', {
    note: `The ArtCraft project is written (${made?.clips ?? 0} clips, ${made?.sound ?? 0} sounds, ${made?.markers ?? 0} markers, ${made?.captions ?? 0} captions). ${headline}\n${lines.join('\n')}\nArtCraft is not opened for you: use Open in ArtCraft.`,
    questions: [],
    items: items.length ? items : [{ text: 'No video file yet.' }],
    error_checks: answer(root, id, 'artcraft', {}),
  });
  return { ok: true, clean: !bad.length };
}

export const V3_RUN = { stills: quickStills, sound: quickSound, artcraft: quickArtcraft };

// The music plan after the voice: cues only, no ElevenLabs call (making them costs credits: the owner confirms in the app).
export async function planMusicAfterVoice(root, id, { studio = {}, onActivity = () => {} } = {}) {
  const pipeline = projectPipeline(root, id);
  if (pipeline.stage_set !== 'v3') return null;
  const v = stepView(loadProject(root, id), pipeline).find((s) => s.key === 'voice');
  if (!v || !['in_review', 'approved', 'done'].includes(v.state)) return null;
  // the v3 voice step makes the music: planned whatever the sessions' Eleven Music switch says (it is off by default,
  // and Director 1's voice was approved with no music planned at all, 2026-11-02); planning is free
  if (!musicExpected(root, id) && !voiceConfig(root).elevenlabs.music) return null;
  if (musicCues(root, id).length) return null;
  try {
    const j = await makeMusicPlan({ root, id }, studio.ask ? { ask: studio.ask } : {});
    onActivity({ kind: 'info', text: `Music plan ready: ${j.cues.length} cues (not made yet: you confirm the credits).` });
    event(root, id, { event: 'MUSIC_PLAN', actor: 'studio', details: `${j.cues.length} cues, ${j.source}` });
    return j;
  } catch (e) { onActivity({ kind: 'info', text: `No music plan yet: ${e.message}` }); return null; }
}
