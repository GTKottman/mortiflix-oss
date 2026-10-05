// Backend: demo. A scripted stand-in for Claude that walks every gate with placeholder work (coloured style
// frames, a sample script, a test-pattern video made with ffmpeg). It goes through the same `mfx` bridge and the
// same gate rules as a real session, so you can try the whole review loop (and develop the UI) without an
// account or any cost. Nothing it makes is meant to be good.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callStudio } from '../mfx.mjs';
import { loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';

export const name = 'demo';

export function available() {
  return { ok: true, detail: 'placeholder work, no Claude needed' };
}

const PALETTES = [['#0f172a', '#f97316'], ['#1e1b4b', '#22d3ee'], ['#052e16', '#facc15'], ['#3b0764', '#f472b6']];

export async function run({ root, projectId, workdir, env, onActivity, signal, config }) {
  const mfx = (cmd, args) => callStudio(cmd, args, env);
  const pause = (ms = config.demoDelayMs ?? 400) => new Promise((ok) => setTimeout(ok, ms));
  const say = (text) => onActivity({ kind: 'text', text });
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  const pipeline = projectPipeline(root, projectId);
  const statusKeys = Object.keys(pipeline.status_lines);
  let did = 0;

  for (let guard = 0; guard < 50; guard++) {
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    const project = loadProject(root, projectId);
    if (project.state !== 'queued' || project.questions.some((q) => !q.answered_at)) break;
    const step = stepView(project, pipeline).find((s) => ['ready', 'working', 'changes'].includes(s.state));
    if (!step) break;
    const version = step.version + 1;
    say(`Working on ${step.name}${step.state === 'changes' ? ` (v${version}, answering your notes)` : ''}.`);
    if (statusKeys.length) await mfx('status', { key: statusKeys[did % statusKeys.length], mode: 'working' });
    await pause();
    const checks = (await mfx('checks', { step: step.key })).map((c) => ({ id: c.id, result: 'pass' }));

    if (step.review === 'internal') {
      await mfx('step-done', { step: step.key, checks });
      say(`${step.name} done (internal).`);
      did++;
      continue;
    }

    const items = [];
    const dir = join(workdir, 'out', `${step.key}-v${version}`);
    mkdirSync(dir, { recursive: true });
    const questions = [];
    if (step.review === 'questions') {
      questions.push({ id: 'pace', text: 'Should it feel calm or energetic?', choices: ['Calm', 'Energetic'], default: 'Energetic' });
      questions.push({ id: 'ending', text: 'What should the last card say?', default: 'Your title and a link' });
    } else if (step.review === 'document') {
      const file = join(dir, 'script.md');
      writeFileSync(file, `# ${project.title}: ${step.name} v${version}\n\nOpen on a single shape that becomes the logo. This is placeholder copy from the demo studio.\n\nThe middle shows three ideas, one per beat, each on its own colour.\n\nClose on the title and a call to action.\n`);
      items.push({ path: `out/${step.key}-v${version}/script.md`, label: `${step.name} v${version}` });
    } else if (step.review === 'frames') {
      for (let i = 0; i < 3; i++) {
        const [bg, fg] = PALETTES[(i + version) % PALETTES.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="${bg}"/><circle cx="${560 + i * 400}" cy="540" r="${180 + i * 40}" fill="${fg}" opacity="0.9"/><text x="120" y="980" font-family="sans-serif" font-size="64" fill="#fff">SF0${i + 1} · ${escapeXml(project.title).slice(0, 40)} · v${version}</text></svg>`;
        writeFileSync(join(dir, `sf0${i + 1}.svg`), svg);
        items.push({ path: `out/${step.key}-v${version}/sf0${i + 1}.svg`, label: `SF0${i + 1} · ${['Open', 'Middle', 'End'][i]}` });
      }
    } else if (step.review === 'video' || step.review === 'audio') {
      if (!hasFfmpeg) {
        await mfx('needs-you', { text: 'The demo needs ffmpeg to make its placeholder video. Install ffmpeg, then resume.' });
        await mfx('handoff', { text: 'Stopped: ffmpeg is missing.' });
        return { ok: true };
      }
      const file = step.review === 'video' ? 'preview.mp4' : 'preview.wav';
      const args = step.review === 'video'
        ? ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${3 + version}`, '-f', 'lavfi', '-i', `sine=frequency=${330 + 110 * version}:duration=${3 + version}`, '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', join(dir, file)]
        : ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${3 + version}`, join(dir, file)];
      const job = await mfx('render', { label: `${step.name} v${version}`, argv: args, cwd: workdir });
      let r = job;
      while (!['done', 'failed'].includes(r.state)) r = await mfx('render-wait', { id: job.id, seconds: 30 });
      if (r.state === 'failed') return { ok: false, error: `the placeholder render failed: ${r.output_tail}` };
      items.push({ path: `out/${step.key}-v${version}/${file}`, label: `${step.name} v${version}` });
    }

    const fb = step.last_feedback;
    const pin_changes = fb?.verdict === 'changes'
      ? Array.from({ length: fb.notes }, (_, i) => ({ note: i + 1, change: `Demo: pretended to fix note ${i + 1}.`, status: 'done' }))
      : [];
    const submission = { note: `Demo ${step.name}, version ${version}. Placeholder work: try pinning a note, asking for changes, or approving.`, questions, items, error_checks: checks, pin_changes };
    writeFileSync(join(workdir, 'submission.json'), JSON.stringify(submission, null, 2));
    await mfx('submit', { step: step.key, submission });
    say(`Sent ${step.name} v${version} for review.`);
    did++;
  }
  await mfx('handoff', { text: did ? `Demo session: moved ${did} step(s) forward.` : 'Demo session: nothing to do.' });
  return { ok: true, usage: { input_tokens: 0, output_tokens: 0 } };
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
