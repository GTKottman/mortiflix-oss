// The final video (Finish screen): ONE mp4 of the whole film, made locally with ffmpeg through the render queue (no Chrome,
// no paid call).
//   final.status  {}  -> {state: none|rendering|done|stale, file?, made_at?, length_sec?, size?, progress?: {done,total,phase}, job?, queued?, error?, stale_why?}
//   final.make    {}  -> {job, file, ...}; picture = out/animatic.mp4 when there is one (copied, not re-encoded), else the shots'
//                        video clips joined; sound = out/sound/final-mix.wav (else the animatic's own sound); captions from the
//                        handoff plan as a soft subtitle track (mov_text) when there are any
//   final.cancel  {}  -> {cancelled}
// File: <studio>/projects/<id>/out/final/final.mp4 (inside the studio folder, so the app's bridge /file route serves it).
// "stale" = any input (animatic, mix, any shot/voice/music file, voice timing) is newer than the file.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectPaths } from '../projects.mjs';
import { UserError } from '../studio.mjs';
import { handoffPlan } from './graph.mjs';
import { toSrt } from './artcraft.mjs';
import { buildFinalAudio, checkFinalAudio } from './finalaudio.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'final-run.mjs');
const LABEL = 'Final video';
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

export function finalPaths(root, id) {
  const work = projectPaths(root, id).work;
  const dir = join(work, 'out', 'final');
  return { work, dir, file: join(dir, 'final.mp4'), part: join(dir, 'final.part.mp4'), srt: join(dir, 'captions.srt'), list: join(dir, 'shots.txt'),
    animatic: join(work, 'out', 'animatic.mp4'), mix: join(work, 'out', 'sound', 'final-mix.wav'), timing: join(work, 'voice', 'timing.json') };
}

const abs = (work, p) => (p ? (isAbsolute(p) ? p : join(work, p)) : null);

// every file the video is made from
function inputsOf(fp, plan) {
  const files = new Set([fp.animatic, fp.mix, fp.timing, join(fp.work, 'sound', 'sfx-plan.json'), join(fp.work, 'music', 'cues.json')]);
  for (const c of plan?.clips || []) if (['shot', 'line', 'music'].includes(c.kind) && c.media?.path) files.add(abs(fp.work, c.media.path));
  return [...files].filter((f) => existsSync(f));
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 60_000 });
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
const lengthCache = new Map();
const lengthOf = (file, ms) => { const k = `${file}:${ms}`; if (!lengthCache.has(k)) { lengthCache.clear(); lengthCache.set(k, probe(file)); } return lengthCache.get(k); };

export function finalHandlers({ root, needProject, queue, poke = () => {} }) {
  const jobFor = (id) => queue.list().filter((j) => j.project === id && j.label === LABEL).at(-1) || null;
  const planOf = (id) => { try { return handoffPlan(root, id); } catch { return null; } };

  function status(id) {
    const fp = finalPaths(root, id);
    const job = jobFor(id);
    const live = job && ['waiting', 'running'].includes(job.state);
    const out = {};
    if (existsSync(fp.file)) {
      const st = statSync(fp.file);
      Object.assign(out, { file: fp.file, made_at: new Date(st.mtimeMs).toISOString(), length_sec: lengthOf(fp.file, st.mtimeMs), size: st.size });
      // what the film's sound really has, measured, and the final-pass check against the plan
      const ck = checkFinalAudio(fp.work, { final: fp.file });
      out.audio = ck.manifest ? { music: ck.manifest.music?.length ?? 0, sfx: ck.manifest.sfx?.length ?? 0, lufs: ck.manifest.lufs, true_peak: ck.manifest.true_peak, left_out: ck.manifest.left_out || [], moved: (ck.manifest.notes || []).filter((n) => / moved /.test(n)) } : null;
      out.audio_check = { pass: ck.pass, problems: ck.problems };
    }
    if (live) {
      out.state = 'rendering';
      out.job = job.id;
      if (job.state === 'waiting') { out.queued = true; out.renders_ahead = job.renders_ahead ?? 0; }
      const p = job.progress;
      const total = planOf(id)?.sequence?.length_sec || (existsSync(fp.animatic) ? lengthOf(fp.animatic, mtime(fp.animatic)) : null);
      if (p) out.progress = p.total ? { done: p.done, total: p.total, phase: p.phase } : { done: Math.min(p.seconds ?? 0, total || p.seconds || 0), total: total || null, phase: p.phase };
      return out;
    }
    if (!out.file) {
      out.state = 'none';
      if (job?.state === 'failed' && !job.cancelled) out.error = (job.output_tail || '').trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'the render failed';
      return out;
    }
    const madeMs = statSync(fp.file).mtimeMs;
    const newer = inputsOf(fp, planOf(id)).filter((f) => mtime(f) > madeMs + 1);
    out.state = newer.length ? 'stale' : 'done';
    if (newer.length) out.stale_why = `${newer.length} file${newer.length === 1 ? ' is' : 's are'} newer than the video`;
    if (job?.state === 'failed' && !job.cancelled && Date.parse(job.ended_at || 0) > madeMs) out.error = 'the last try failed; this is the earlier video';
    return out;
  }

  function make(id) {
    const fp = finalPaths(root, id);
    const now = jobFor(id);
    if (now && ['waiting', 'running'].includes(now.state)) return { ...status(id), already: true };
    const plan = planOf(id);
    const shots = (plan?.clips || []).filter((c) => c.kind === 'shot');
    mkdirSync(fp.dir, { recursive: true });
    rmSync(fp.part, { force: true });
    const args = [];
    let v;
    if (existsSync(fp.animatic)) { args.push('-i', fp.animatic); v = 'copy'; }
    else {
      if (!shots.length) throw new UserError('There is nothing to join yet: make the shots first.');
      const bad = shots.filter((s) => s.media?.kind !== 'video' || !existsSync(abs(fp.work, s.media.path)));
      if (bad.length) throw new UserError(`${bad.length} shot${bad.length === 1 ? ' has' : 's have'} no video yet (${bad.slice(0, 4).map((s) => s.name.split(' ')[0]).join(', ')}): make the shots first.`);
      const q = (f) => `'${f.replace(/'/g, `'\\''`)}'`;
      writeFileSync(fp.list, shots.map((s) => `file ${q(abs(fp.work, s.media.path))}\n${s.media.from_sec ? `inpoint ${s.media.from_sec}\n` : ''}${s.media.to_sec ? `outpoint ${s.media.to_sec}\n` : ''}`).join(''));
      args.push('-f', 'concat', '-safe', '0', '-i', fp.list); v = 'encode';
    }
    // the film's sound, built now from the approved voice, music and sounds, mastered (svc/finalaudio.mjs)
    const fa = buildFinalAudio(fp.work);
    if (!fa.ok) throw new UserError(`The final sound couldn't be made: ${fa.error}`);
    let next = 1;
    const maps = ['-map', '0:v'];
    if (fa.file && existsSync(fa.file)) { args.push('-i', fa.file); maps.push('-map', `${next++}:a`); }
    else if (v === 'copy') maps.push('-map', '0:a?');
    const caps = plan?.captions || [];
    if (caps.length) { writeFileSync(fp.srt, toSrt(caps)); args.push('-i', fp.srt); maps.push('-map', `${next++}:s`); }
    args.push(...maps);
    args.push(...(v === 'copy' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', `scale=${plan.sequence.width}:${plan.sequence.height}:force_original_aspect_ratio=decrease,pad=${plan.sequence.width}:${plan.sequence.height}:(ow-iw)/2:(oh-ih)/2,fps=${plan.sequence.fps}`]));
    args.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
    if (caps.length) args.push('-c:s', 'mov_text');
    args.push('-shortest', '-movflags', '+faststart', '-f', 'mp4', fp.part);
    const job = queue.add({ projectId: id, label: LABEL, cwd: fp.work, env: process.env, argv: [process.execPath, RUN, fp.file, ...args] });
    poke();
    return { ...status(id), job: job.id };
  }

  return {
    'final.status': (p) => status(needProject(p)),
    'final.make': (p) => make(needProject(p)),
    'final.cancel': (p) => {
      const id = needProject(p);
      const job = jobFor(id);
      if (!job || !['waiting', 'running'].includes(job.state)) return { cancelled: false };
      queue.cancel(job.id);
      poke();
      return { cancelled: true, job: job.id };
    },
  };
}
