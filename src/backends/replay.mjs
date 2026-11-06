// Backend: replay (src/replay.mjs). A stand-in for the Claude session that, for each runnable step, writes the files a
// past real generation made (the replay pack) and submits them through the same `mfx` bridge and gate rules a session
// uses, after a short delay. So the gates, events, needs_you, stage.status and the app behave as in a real run, with no
// Claude and nothing paid. The v3 studio steps (stills, sound, artcraft) are not done here: the runner runs the real
// studio code for them, with the pack's stills injected (replayStudio). The motion step is built scene by scene like
// src/quickanimatic.mjs: the pack's recorded scene clips, joined by the real assemble(), sceneBuilt, the Video Notes queue.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { callStudio } from '../mfx.mjs';
import { loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { replayPack, takeFault, logReplay } from '../replay.mjs';
import { scriptView } from '../svc/script.mjs';
import { buildTarget, assemble, scenesFromTiming } from '../quickanimatic.mjs';
import { sceneBuilt } from '../svc/lessons.mjs';
import { queueScenes, queueFrames } from '../svc/videonotes.mjs';
import { ensurePlan, loadFrames, saveFrames, nextAction } from '../svc/frames.mjs';
import { readReviewSettings } from '../svc/reviewsize.mjs';
import { V3_QUICK } from '../quickv3.mjs';
import { run as runAsync } from '../svc/run.mjs';

export const name = 'replay';
export const LOGIN_ERROR = 'OAuth session expired · Please run /login (replay fault: login)';
const FPS = 30;

export function available() {
  try { const p = replayPack(); return p ? { ok: true, detail: `recorded generations from ${p.source?.project || p.name}` } : { ok: false, detail: 'MFX_REPLAY is not set' }; } catch (e) { return { ok: false, detail: e.message }; }
}

const readJ = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export async function run({ root, projectId, workdir, env, onActivity, signal, config }) {
  const pack = replayPack();
  const mfx = (cmd, args) => callStudio(cmd, args, env);
  const pause = (ms = config.replayDelayMs ?? 1200) => new Promise((ok) => setTimeout(ok, ms));
  const say = (text) => onActivity({ kind: 'text', text });
  // a lost Claude login ends the session before it does anything, as Claude Code does
  if (takeFault(root, 'login')) { say('Claude Code: OAuth session expired. Please run /login.'); return { ok: false, error: LOGIN_ERROR }; }
  const pipeline = projectPipeline(root, projectId);
  let did = 0;

  for (let guard = 0; guard < 30; guard++) {
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    // edit requests from the canvas: replay has no new generation for them, so the recorded piece is kept and said so
    for (const e of await mfx('edits', {})) {
      await pause(300);
      const made = await remake({ e, workdir, pack, root });
      if (made !== true) { await mfx('edit-fail', { edit: e.id, note: made }); say(`${e.label}: ${made}`); continue; }
      await mfx('canvas-sync', {});
      await mfx('edit-done', { edit: e.id, note: `Replay: a new version of ${e.label} from the recording for "${String(e.text).slice(0, 80)}".` });
      say(`${e.label} remade from the recording (${e.id}).`);
      did++;
    }
    const project = loadProject(root, projectId);
    if (project.state !== 'queued' || project.questions.some((q) => !q.answered_at)) break;
    const view = stepView(project, pipeline);
    const step = view.find((s) => ['ready', 'working', 'changes'].includes(s.state));
    if (!step) break;
    if (V3_QUICK.includes(step.key)) break; // the studio's own code does these (runner), not a session
    const version = step.version + 1;
    say(`Working on ${step.name}${step.state === 'changes' ? ` (v${version}, answering your notes)` : ''} from the recording.`);
    await mfx('status', { key: Object.keys(pipeline.status_lines || {})[0] || step.key, mode: 'working' }).catch(() => {});
    await pause();
    const checks = (await mfx('checks', { step: step.key })).map((c) => ({ id: c.id, result: 'pass', note: 'Replay: the recorded generation passed this when it was made.' }));
    if (step.review === 'internal') { await mfx('step-done', { step: step.key, checks }); did++; continue; }

    const fb = step.last_feedback;
    const pin_changes = fb?.verdict === 'changes' ? Array.from({ length: fb.notes || 0 }, (_, i) => ({ note: i + 1, change: 'Replay: the recording has no new version for this note; the same work is sent again.', status: 'partly' })) : [];
    let submission;
    let afterSubmit = null;
    if (step.key === 'style-frames') {
      const made = styleFrames({ root, projectId, workdir, pack, step });
      if (!made.ok) {
        await mfx('needs-you', { text: made.error });
        return { ok: false, error: made.error, usage: { input_tokens: 0, output_tokens: 0 } };
      }
      submission = { note: made.note, questions: [], items: made.items };
      await mfx('submit', { step: step.key, submission: { ...submission, error_checks: checks, pin_changes } });
      logReplay(root, { kind: 'submit', project: projectId, step: step.key, version, frames: made.ids });
      try { await queueFrames(root, projectId, made.ids); } catch (err) { say(`Video Notes: ${err.message}`); }
      say(`Sent style frames ${made.ids.join(', ')} for your check (recorded).`);
      did++;
      continue;
    }
    if (step.key === 'animatic') {
      const made = await motion({ root, projectId, workdir, pack, step, say });
      if (!made.ok) {
        await mfx('needs-you', { text: made.error });
        await mfx('handoff', { text: `Stopped at the animatic: ${made.error}` });
        return { ok: false, error: made.error, usage: { input_tokens: 0, output_tokens: 0 } };
      }
      submission = { note: made.note, questions: [], items: made.items };
      afterSubmit = made.after;
    } else {
      const rec = pack.steps?.[step.key];
      if (!rec) {
        const why = `The replay pack has no recording for ${step.name}.`;
        await mfx('needs-you', { text: why });
        return { ok: false, error: why, usage: { input_tokens: 0, output_tokens: 0 } };
      }
      if (rec.work && existsSync(join(pack.dir, rec.work))) cpSync(join(pack.dir, rec.work), workdir, { recursive: true, force: true });
      const sub = readJ(join(pack.dir, rec.submission), {});
      submission = { note: `${sub.note || `${step.name} (recorded).`}${version > 1 ? `\n\n(Replay v${version}: the recorded work, sent again.)` : ''}`, questions: sub.questions || [], items: sub.items || [] };
    }
    submission = { ...submission, error_checks: checks, pin_changes };
    writeFileSync(join(workdir, 'submission.json'), JSON.stringify(submission, null, 2));
    await mfx('submit', { step: step.key, submission });
    if (afterSubmit) await afterSubmit();
    logReplay(root, { kind: 'submit', project: projectId, step: step.key, version });
    say(`Sent ${step.name} v${version} for review (recorded).`);
    did++;
  }
  await mfx('handoff', { text: did ? `Replay session: moved ${did} step(s) forward from the recording.` : 'Replay session: nothing to do.' });
  return { ok: true, usage: { input_tokens: 0, output_tokens: 0 } };
}

// The motion step from the recorded scene clips, as quickanimatic.mjs builds it: the scene(s) the owner checks now, joined
// with the approved ones into out/animatic.mp4 (real ffmpeg, stream copy), scenes.json, the actions for the sound step,
// sceneBuilt and the Video Notes queue.
async function motion({ root, projectId, workdir, pack, step, say }) {
  if (takeFault(root, 'render')) return { ok: false, error: 'The animatic render failed (Kinetograph exited 1: replay fault: render). Press Resume to try again.' };
  const recorded = readJ(join(pack.dir, pack.motion?.scenes || 'motion/scenes.json'), []);
  const clipOf = (beat) => { const s = recorded.find((x) => x.beat === beat); return s && join(pack.dir, s.file); };
  const script = scriptView(root, projectId);
  const timing = readJ(join(workdir, 'voice', 'timing.json'), null);
  if (!timing?.lines?.length) return { ok: false, error: 'No voice timing (voice/timing.json): the motion is built on the approved voice.' };
  const target = buildTarget(root, projectId, script.beats, timing);
  const missing = target.ids.filter((b) => !clipOf(b) || !existsSync(clipOf(b)));
  if (missing.length) return { ok: false, error: `The replay pack has no motion clip for ${missing.join(', ')}.` };
  const out = join(workdir, 'out');
  mkdirSync(join(out, 'scenes'), { recursive: true });
  const joinClips = async (files, dest) => {
    if (files.length === 1) { copyFileSync(files[0], dest); return { ok: true }; }
    const list = `${dest}.txt`;
    writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await runAsync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', dest], { encoding: 'utf8', timeout: 5 * 60_000 });
    rmSync(list, { force: true });
    return r.status === 0 ? { ok: true } : { ok: false, error: `the recorded clips could not be joined: ${String(r.stderr || '').slice(-200)}` };
  };
  say(target.partial ? `Building scene ${target.ids.join('+')} from the recording.` : `Building the whole animatic (${target.ids.length} scenes) from the recording.`);
  let total;
  let scenes;
  if (target.partial) {
    const file = `scenes/${target.ids.join('+')}.mp4`;
    const j = await joinClips(target.ids.map(clipOf), join(out, file));
    if (!j.ok) return j;
    const asm = await assemble(workdir, target, file);
    if (!asm.ok) return asm;
    total = target.to;
    scenes = target.all.filter((x) => x.from_frame < target.to);
  } else {
    const j = await joinClips(target.ids.map(clipOf), join(out, 'animatic.mp4'));
    if (!j.ok) return j;
    rmSync(join(out, 'scenes', 'clips.json'), { force: true });
    total = target.all.length ? target.all.at(-1).from_frame + target.all.at(-1).frames : Math.round((timing.seconds + 1) * FPS);
    scenes = scenesFromTiming(script.beats, timing, total);
  }
  writeFileSync(join(out, 'scenes.json'), JSON.stringify({ made_from: 'out/animatic.mp4', fps: FPS, scenes, motion_data: { ok: false, error: 'replay: not read off a render' } }, null, 2));
  const actions = pack.motion?.actions && join(pack.dir, pack.motion.actions);
  if (actions && existsSync(actions)) { mkdirSync(join(workdir, 'video', 'src'), { recursive: true }); copyFileSync(actions, join(workdir, 'video', 'src', 'actions.json')); }
  // after the submit (as quickanimatic.mjs): the scene shows for the owner's OK, and goes to the tablet
  const after = target.partial ? async () => {
    sceneBuilt(root, projectId, target.ids);
    // the tablet fault (replayConfig): while it is armed the send fails and the scene says so
    await queueScenes(root, projectId, target.ids);
  } : null;
  const secs = Math.round(total / FPS);
  return {
    ok: true,
    after,
    note: `${target.partial ? `Scene ${target.ids.join('+')} (recorded), joined with the approved scenes` : `The whole animatic, ${target.ids.length} scenes (recorded)`}: ${secs} s. Replay: the motion is a past real render, not made for this script.`,
    items: [{ path: 'out/animatic.mp4', label: target.partial ? `Animatic up to scene ${target.ids.at(-1)} (${secs} s)` : `Animatic (${secs} s)` }],
  };
}


// The style frames as quickframes.mjs makes them: planned from the script's parts in rounds (svc/frames.mjs), each round's
// frames get a new version (a recorded frame of the same part) and wait for the owner's OK or Fix, one round at a time.
function styleFrames({ root, projectId, workdir, pack, step }) {
  const rec = pack.steps?.['style-frames'];
  const recDir = rec?.work ? join(pack.dir, rec.work) : null;
  const recorded = (readJ(join(recDir || '', 'design', 'frames.json'), {}).frames || []).filter((f) => f.file && existsSync(join(recDir, f.file)));
  if (!recorded.length) return { ok: false, error: 'The replay pack has no recorded style frames.' };
  // the look's other files (look brief, LOOK.md, layouts) as the recording had them; frames.json is the frame state's to write
  for (const f of ['design/look-brief.json', 'design/LOOK.md', 'design/layouts.json']) if (existsSync(join(recDir, f)) && !existsSync(join(workdir, f))) { mkdirSync(join(workdir, 'design'), { recursive: true }); copyFileSync(join(recDir, f), join(workdir, f)); }
  const script = scriptView(root, projectId);
  const timing = readJ(join(workdir, 'voice', 'timing.json'), { lines: [] });
  const scenes = script.beats.map((b) => { const ls = (timing.lines || []).filter((l) => l.id.startsWith(`${b.id}-`)); return { id: b.id, name: b.name, words: (b.lines || []).map((l) => l.words).join(' '), visual: b.visual || '', from_sec: ls[0]?.start ?? null, to_sec: ls.at(-1)?.end ?? null }; });
  const st = ensurePlan(workdir, scenes, { perRound: readReviewSettings(root).review.framesPerRound });
  const act = nextAction(st);
  if (act.kind === 'write' || act.kind === 'fix') {
    if (takeFault(root, 'render')) return { ok: false, error: 'The style frame render failed (Kinetograph exited 1: replay fault: render). Press Resume to try again.' };
    act.frames.forEach((f, i) => {
      const src = recorded.find((r) => (r.beats || []).some((b) => (f.beats || []).includes(b))) || recorded[(st.frames.indexOf(f) + i) % recorded.length];
      const v = (f.versions.at(-1)?.v || 0) + 1;
      const file = `out/frames/${f.id}-v${v}${extname(src.file) || '.png'}`;
      mkdirSync(join(workdir, 'out', 'frames'), { recursive: true });
      copyFileSync(join(recDir, src.file), join(workdir, file));
      f.versions.push({ v, file, at: new Date().toISOString(), notes: 0, measured: { ok: true, problems: [], checks: {} }, inspection: null });
      f.current = v; f.state = 'review'; f.fix_notes = []; f.held = null;
      f.why = `Replay: the recorded frame ${src.id} (${src.label || ''}).`.slice(0, 400);
    });
    st.rounds.push({ round: act.round, kind: act.kind, frames: act.frames.map((f) => f.id), at: new Date().toISOString(), calls: 0, fixes: 0, input_tokens: 0, output_tokens: 0, replay: true });
    saveFrames(workdir, st);
  }
  const made = st.frames.filter((f) => f.current);
  if (!made.length) return { ok: false, error: 'No style frame was made.' };
  const ids = (act.kind === 'write' || act.kind === 'fix') ? act.frames.map((f) => f.id) : [];
  const okN = made.filter((f) => f.state === 'ok').length;
  return { ok: true, ids,
    note: `Style frames${act.round ? ` round ${act.round}` : ''} (recorded): ${okN} of ${st.frames.length} frames are OK so far. Check each frame: OK, or Fix with your notes. Replay: the pictures are a past real generation.`,
    items: made.map((f) => ({ path: f.versions.find((x) => x.v === f.current).file, label: `${f.label} · v${f.current} · ${f.state === 'ok' ? 'OK' : 'to check'}` })) };
}

// A canvas edit answered from the recording: a new version of the piece (a recorded file of the same kind, or the beat's
// words marked as changed), or a plain refusal for what replay can't remake.
async function remake({ e, workdir, pack, root }) {
  const readW = (rel) => readJ(join(workdir, rel), null);
  if (e.kind === 'beat') {
    const b = readW('script/beats.json');
    const beat = b?.beats?.find((x) => x.id === e.node);
    if (!beat) return `Replay: ${e.node} isn't in script/beats.json.`;
    beat.words = `${String(beat.words || '').replace(/ \(changed: .*\)$/, '')} (changed: ${String(e.text).slice(0, 40)})`;
    writeFileSync(join(workdir, 'script', 'beats.json'), JSON.stringify(b, null, 2));
    return true;
  }
  if (e.kind === 'shot') {
    if (takeFault(root, 'render')) return 'The shot render failed (replay fault: render).';
    const sc = readW('out/scenes.json');
    const scene = sc?.scenes?.find((x) => x.key === e.node);
    const rec = readJ(join(pack.dir, pack.motion?.scenes || 'motion/scenes.json'), []);
    const clip = rec.find((x) => x.beat === scene?.beat) || rec[0];
    if (!clip) return 'Replay: no recorded clip for this shot.';
    const file = `edits/${e.id}/${e.node}.mp4`;
    mkdirSync(join(workdir, 'edits', e.id), { recursive: true });
    const r = await runAsync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', join(pack.dir, clip.file), '-c', 'copy', '-metadata', `comment=${e.id}`, join(workdir, file)], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) return `Replay: the recorded clip could not be copied: ${String(r.stderr).slice(-160)}`;
    if (scene) { scene.file = file; writeFileSync(join(workdir, 'out', 'scenes.json'), JSON.stringify(sc, null, 2)); }
    return true;
  }
  if (e.kind === 'line') {
    const list = pack.audio?.tts || [];
    if (!list.length) return 'Replay: no recorded voice takes.';
    const src = join(pack.dir, list[Math.floor(Math.random() * list.length)]);
    mkdirSync(join(workdir, 'voice', 'clips'), { recursive: true });
    const r = await runAsync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', src, '-ar', '48000', '-metadata', `comment=${e.id}`, join(workdir, 'voice', 'clips', `${e.node}.wav`)], { encoding: 'utf8', timeout: 120_000 });
    return r.status === 0 ? true : `Replay: the recorded take could not be copied: ${String(r.stderr).slice(-160)}`;
  }
  return `Replay can't remake a ${e.kind} (no recording for that kind of change).`;
}
