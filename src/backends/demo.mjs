// Backend: demo. A scripted stand-in for Claude that walks every gate with placeholder work (coloured style
// frames, a sample script, a test-pattern video made with ffmpeg). It goes through the same `mfx` bridge and the
// same gate rules as a real session, so you can try the whole review loop (and develop the UI) without an
// account or any cost. Nothing it makes is meant to be good.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { callStudio } from '../mfx.mjs';
import { loadProject, projectPipeline } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { songFromNotes } from '../song-import.mjs';
import { saveSong } from '../song-store.mjs';

export const name = 'demo';

export function available() {
  return { ok: true, detail: 'placeholder work, no Claude needed' };
}

const PALETTES = [['#0f172a', '#f97316'], ['#1e1b4b', '#22d3ee'], ['#052e16', '#facc15'], ['#3b0764', '#f472b6']];
// Names for the demo's looks (each frame is one look to pick from).
const LOOK_NAMES = ['Ember night', 'Cold neon', 'Olive and gold', 'Plum pop', 'Paper white', 'Rust and teal', 'Ink blue', 'Sun bleach'];
const MORE_PALETTES = [['#f5f0e6', '#1f2937'], ['#1c1917', '#14b8a6'], ['#0b1d3a', '#e2e8f0'], ['#fef3c7', '#b45309']];

// The demo's script: four numbered beats, so the canvas has beats, frames, shots and lines to line up.
const BEATS = [
  ['Open on a single shape that becomes the logo.', 'A dot grows out of the dark.'],
  ['Three ideas, one per beat, each on its own colour.', 'Three cards slide in from the left.'],
  ['The ideas join into one picture.', 'The cards fold together into a circle.'],
  ['Close on the title and a call to action.', 'The title settles; a link fades in.'],
];
const BEAT_SEC = 2;
const FPS = 24;

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
    // Edit requests from the canvas come first: remake just that piece, then report it.
    for (const e of await mfx('edits', {})) {
      say(`Remaking ${e.label} (${e.id}): ${e.text}`);
      await pause();
      const made = await remake(e);
      if (made !== true) { await mfx('edit-fail', { edit: e.id, note: made }); say(`${e.id} failed: ${made}`); continue; }
      await mfx('canvas-sync', {});
      await mfx('edit-done', { edit: e.id, note: `Demo: remade ${e.label} for "${e.text.slice(0, 80)}".` });
      say(`${e.label} remade (${e.id}).`);
      did++;
    }
    const project = loadProject(root, projectId);
    if (project.state !== 'queued' || project.questions.some((q) => !q.answered_at)) break;
    const view = stepView(project, pipeline);
    const step = view.find((s) => ['ready', 'working', 'changes'].includes(s.state));
    if (!step) break;
    // Its to-do list, like a real session keeps one: the live view shows it.
    onActivity({ kind: 'todo', text: 'To-do list', todos: view.filter((s) => !['skipped'].includes(s.state)).map((s) => ({ content: s.name, status: ['approved', 'done', 'in_review'].includes(s.state) ? 'completed' : s === step ? 'in_progress' : 'pending' })) });
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
      const beats = BEATS.map(([words, visual], i) => ({ id: `b0${i + 1}`, words: version > 1 && i === 1 ? `${words} (v${version})` : words, visual, target_sec: BEAT_SEC }));
      writeFileSync(file, `# ${project.title}: ${step.name} v${version}\n\n${beats.map((b) => `B${b.id.slice(1)} · ${b.words}\n*Visual: ${b.visual}*`).join('\n\n')}\n`);
      mkdirSync(join(workdir, 'script'), { recursive: true });
      writeFileSync(join(workdir, 'script', 'beats.json'), JSON.stringify({ version, beats }, null, 2));
      items.push({ path: `out/${step.key}-v${version}/script.md`, label: `${step.name} v${version}` });
    } else if (step.review === 'frames') {
      const frames = [];
      for (let i = 0; i < BEATS.length; i++) {
        const [bg, fg] = PALETTES[(i + version) % PALETTES.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="${bg}"/><circle cx="${460 + i * 330}" cy="540" r="${160 + i * 30}" fill="${fg}" opacity="0.9"/><text x="120" y="980" font-family="sans-serif" font-size="64" fill="#fff">SF0${i + 1} · ${escapeXml(project.title).slice(0, 40)} · v${version}</text></svg>`;
        writeFileSync(join(dir, `sf0${i + 1}.svg`), svg);
        const label = `SF0${i + 1} · ${['Open', 'Ideas', 'Together', 'Close'][i]}`;
        items.push({ path: `out/${step.key}-v${version}/sf0${i + 1}.svg`, label });
        frames.push({ id: `sf0${i + 1}`, file: `out/${step.key}-v${version}/sf0${i + 1}.svg`, label, beats: [`b0${i + 1}`], name: LOOK_NAMES[i % LOOK_NAMES.length], palette: [bg, fg, '#ffffff'], fonts: ['sans-serif'] });
      }
      if (step.key === 'transitions') {
        // The board's cuts: one between each pair of shots, so the canvas has transition nodes to show.
        const kinds = ['Crossfade', 'Match cut on the circle', 'Push left'];
        mkdirSync(join(workdir, 'transitions'), { recursive: true });
        writeFileSync(join(workdir, 'transitions', 'board.json'), JSON.stringify({ cuts: BEATS.slice(1).map((_, i) => ({ id: `t0${i + 1}`, from_scene: `s0${i + 1}`, to_scene: `s0${i + 2}`, transition: kinds[i % kinds.length] })) }, null, 2));
      } else {
        mkdirSync(join(workdir, 'design'), { recursive: true });
        writeFileSync(join(workdir, 'design', 'frames.json'), JSON.stringify({ frames }, null, 2));
      }
    } else if (step.review === 'video' || step.review === 'audio') {
      if (!hasFfmpeg) {
        await mfx('needs-you', { text: 'The demo needs ffmpeg to make its placeholder video. Install ffmpeg, then resume.' });
        await mfx('handoff', { text: 'Stopped: ffmpeg is missing.' });
        return { ok: true };
      }
      const file = step.review === 'video' ? 'preview.mp4' : 'preview.wav';
      const sec = BEATS.length * BEAT_SEC;
      const args = step.review === 'video'
        ? ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}:duration=${sec}`, '-f', 'lavfi', '-i', `sine=frequency=${330 + 110 * version}:duration=${sec}`, '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac', join(dir, file)]
        : ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, join(dir, file)];
      const job = await mfx('render', { label: `${step.name} v${version}`, argv: args, cwd: workdir });
      let r = job;
      while (!['done', 'failed'].includes(r.state)) r = await mfx('render-wait', { id: job.id, seconds: 30 });
      if (r.state === 'failed') return { ok: false, error: `the placeholder render failed: ${r.output_tail}` };
      items.push({ path: `out/${step.key}-v${version}/${file}`, label: `${step.name} v${version}` });
      // The narration: one line per beat with its time, so the voice nodes have lines (quiet tones).
      if (step.key === 'voice') writeDemoVoice(workdir);
      // The music step's blueprint: one section per beat (the canvas's music cues).
      if (step.key === 'music') {
        mkdirSync(join(workdir, 'music'), { recursive: true });
        const bars = 2;
        writeFileSync(join(workdir, 'music', 'blueprint.json'), JSON.stringify({ title: project.title, bpm: 120, meter: '4/4', bars: BEATS.length * bars, scale: 'A:minor',
          sections: BEATS.map(([words], i) => ({ id: `m0${i + 1}`, beat: `b0${i + 1}`, name: ['Arrival', 'Three ideas', 'Coming together', 'The close'][i], start_bar: i * bars + 1, end_bar: (i + 1) * bars, function: words, intensity: [3, 5, 7, 4][i] })),
          roles: [{ channel: 2, name: 'Bass', harmony: 'bass' }, { channel: 3, name: 'Keys', harmony: 'chords' }, { channel: 10, name: 'Drums', harmony: 'drums' }],
          chart: [{ bars: [1, 8], chords: ['Am', 'Am', 'F', 'F', 'C', 'C', 'G', 'G'] }] }, null, 2));
        writeDemoSong(root, projectId, workdir, project.title);
      }
      // The video's scenes, one per beat: the canvas cuts the shots out of it by these frames.
      if (step.review === 'video' && step.key !== 'music') {
        writeFileSync(join(workdir, 'out', 'scenes.json'), JSON.stringify({ made_from: `out/${step.key}-v${version}/${file}`, fps: FPS,
          scenes: BEATS.map(([words], i) => ({ key: `s0${i + 1}`, name: words.replace(/\.$/, ''), from_frame: i * BEAT_SEC * FPS, frames: BEAT_SEC * FPS, beat: `b0${i + 1}` })) }, null, 2));
        // A pipeline without a voice step: the animatic brings the narration.
        if (step.key === 'animatic' && !existsSync(join(workdir, 'voice', 'lines.json'))) writeDemoVoice(workdir);
      }
      // The score as mixed, for the music lane and the Mortiflix Studio hand-off (quiet).
      if (step.key === 'music') {
        mkdirSync(join(workdir, 'out', 'music'), { recursive: true });
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec}`, '-af', 'volume=0.08', '-ar', '48000', join(workdir, 'out', 'music', 'score.wav')]);
      }
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

  // One piece, remade alone: a shot gets its own clip, a frame a new picture, a beat new words. A note with the word
  // "fail" fails on purpose, so the failure path can be tried too.
  async function remake(e) {
    if (/\bfail\b/i.test(e.text)) return 'Demo: failed on purpose (the note said "fail").';
    const dir = join(workdir, 'edits', e.id);
    mkdirSync(dir, { recursive: true });
    const readJ = (rel) => JSON.parse(readFileSync(join(workdir, rel), 'utf8'));
    if (e.kind === 'shot' && ['insert', 'duplicate'].includes(e.op)) {
      if (!hasFfmpeg || !existsSync(join(workdir, 'out', 'scenes.json'))) return 'Demo: needs ffmpeg and the animatic to add a shot.';
      const sc = readJ('out/scenes.json');
      if (sc.scenes.some((x) => x.key === e.node)) return true;
      const file = `edits/${e.id}/${e.node}.mp4`;
      const job = await mfx('render', { label: `${e.label} (${e.id})`, argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=${FPS}:duration=${BEAT_SEC}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-bf', '0', join(workdir, file)], cwd: workdir });
      let r = job;
      while (!['done', 'failed'].includes(r.state)) r = await mfx('render-wait', { id: job.id, seconds: 30 });
      if (r.state === 'failed') return `Demo: the render failed: ${r.output_tail}`;
      sc.scenes.push({ key: e.node, name: `New shot (${e.op})`, from_frame: 0, frames: BEAT_SEC * FPS, beat: e.beat || null, file });
      writeFileSync(join(workdir, 'out', 'scenes.json'), JSON.stringify(sc, null, 2));
      return true;
    }
    if (e.kind === 'line') {
      if (!hasFfmpeg) return 'Demo: needs ffmpeg to remake a line.';
      const n = Number(String(e.id).replace(/\D/g, '')) || 1;
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + 40 * n}:duration=1.5`, '-af', 'volume=0.08', '-ar', '48000', join(workdir, 'voice', 'clips', `${e.node}.wav`)]);
      return true;
    }
    if (e.kind === 'shot') {
      if (!hasFfmpeg || !existsSync(join(workdir, 'out', 'scenes.json'))) return 'Demo: needs ffmpeg and the animatic to remake a shot.';
      const sc = readJ('out/scenes.json');
      const scene = sc.scenes.find((x) => x.key === e.node);
      if (!scene) return `Demo: ${e.node} isn't in out/scenes.json.`;
      const file = `edits/${e.id}/${e.node}.mp4`;
      const job = await mfx('render', { label: `${e.label} (${e.id})`, argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `smptebars=size=1280x720:rate=${FPS}:duration=${scene.frames / FPS}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-bf', '0',
        // each remake is its own file: the canvas dedupes versions by content, so a second Fix of the same shot that came
        // out byte for byte like the first was "no new version yet" (still v2)
        '-metadata', `comment=${e.id}`, join(workdir, file)], cwd: workdir });
      let r = job;
      while (!['done', 'failed'].includes(r.state)) r = await mfx('render-wait', { id: job.id, seconds: 30 });
      if (r.state === 'failed') return `Demo: the render failed: ${r.output_tail}`;
      scene.file = file;
      writeFileSync(join(workdir, 'out', 'scenes.json'), JSON.stringify(sc, null, 2));
      return true;
    }
    // "Make more looks" (look.more): a new frame of its own, a new look to pick from.
    if (e.kind === 'frame' && e.op === 'more') {
      const fr = readJ('design/frames.json');
      if (fr.frames.some((x) => x.id === e.node)) return true;
      const k = Number(e.node.replace(/\D/g, '')) || 1;
      const [bg, fg] = MORE_PALETTES[k % MORE_PALETTES.length];
      const name = LOOK_NAMES[(k - 1) % LOOK_NAMES.length];
      const file = `edits/${e.id}/${e.node}.svg`;
      writeFileSync(join(workdir, file), `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="${bg}"/><rect x="${300 + k * 60}" y="260" width="560" height="560" rx="80" fill="${fg}"/><circle cx="1360" cy="540" r="220" fill="none" stroke="${fg}" stroke-width="40"/><text x="120" y="980" font-family="serif" font-size="64" fill="${fg}">${e.node.toUpperCase()} · ${escapeXml(name)}</text></svg>`);
      fr.frames.push({ id: e.node, file, label: `${e.node.toUpperCase()} · ${name}`, name, beats: [], palette: [bg, fg], fonts: ['serif'] });
      writeFileSync(join(workdir, 'design', 'frames.json'), JSON.stringify(fr, null, 2));
      return true;
    }
    if (e.kind === 'frame') {
      const fr = readJ('design/frames.json');
      const f = fr.frames.find((x) => x.id === e.node);
      if (!f) return `Demo: ${e.node} isn't in design/frames.json.`;
      f.file = `edits/${e.id}/${e.node}.svg`;
      writeFileSync(join(workdir, f.file), `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#111"/><rect x="560" y="240" width="800" height="600" fill="#f97316"/><text x="120" y="980" font-family="sans-serif" font-size="64" fill="#fff">${escapeXml(f.label)} · remade (${e.id})</text></svg>`);
      writeFileSync(join(workdir, 'design', 'frames.json'), JSON.stringify(fr, null, 2));
      return true;
    }
    // A music section (doc 26 §8): something visible and safe in the asked bars, written through mfx song notes with the
    // edit request (so only its bars' locks lift): the notes up an octave, or the drums thinned; thinned when the octave
    // doesn't pass the harmony check.
    if (e.kind === 'cue') {
      let song;
      try { song = await mfx('song', {}); } catch { return 'Demo: the music has no song yet (it is made with the music step).'; }
      const sec = song.sections.find((x) => x.id === e.node);
      if (!sec) return `Demo: ${e.node} isn't in the song.`;
      const [a, b] = e.bars || [1, Number(sec.bars.split('–')[1]) - Number(sec.bars.split('–')[0]) + 1];
      const show = await mfx('song-show', { section: e.node, part: e.part || null, bars: [a, b] });
      const parts = [...new Set(show.notes.map((n) => n.part))];
      if (!parts.length) return `Demo: ${e.label} has no notes in bars ${a}–${b} to change.`;
      const up = (k) => k.replace(/(-?\d+)$/, (o) => String(Number(o) + 1));
      for (const part of parts) {
        const mine = show.notes.filter((n) => n.part === part).map(({ bar, beat, key, len, vel }) => ({ bar, beat, key, len, vel }));
        const drums = part === 'ch10';
        const tries = drums ? [mine.filter((_, i) => i % 2 === 0)] : [mine.map((n) => ({ ...n, key: up(n.key) })), mine.filter((_, i) => i % 2 === 0)];
        let wrote = null;
        for (const notes of tries) {
          try { await mfx('song-notes', { section: e.node, part, bars: [a, b], notes, edit: e.id, rev: show.rev }); wrote = true; break; } catch (err) { wrote = err.message; }
        }
        if (wrote !== true) return `Demo: ${wrote}`;
      }
      return true;
    }
    if (e.kind === 'beat') {
      const b = readJ('script/beats.json');
      const beat = b.beats.find((x) => x.id === e.node);
      if (!beat) return `Demo: ${e.node} isn't in script/beats.json.`;
      beat.words = `${beat.words.replace(/ \(changed.*\)$/, '')} (changed: ${e.text.slice(0, 40)})`;
      writeFileSync(join(workdir, 'script', 'beats.json'), JSON.stringify(b, null, 2));
      return true;
    }
    if (e.kind === 'transition') {
      const bd = readJ('transitions/board.json');
      const cut = bd.cuts.find((x) => x.id === e.node);
      if (!cut) return `Demo: ${e.node} isn't in transitions/board.json.`;
      cut.transition = (e.text.match(/"([^"]+)"/)?.[1] || e.text).slice(0, 80);
      writeFileSync(join(workdir, 'transitions', 'board.json'), JSON.stringify(bd, null, 2));
      return true;
    }
    return `Demo: can't remake a ${e.kind} yet.`;
  }
}

// One quiet narration line per beat (b01-1 …), timed to its shot, with a placeholder clip each.
function writeDemoVoice(workdir) {
  mkdirSync(join(workdir, 'voice', 'clips'), { recursive: true });
  const lines = BEATS.map(([words], i) => ({ id: `b0${i + 1}-1`, script: words }));
  writeFileSync(join(workdir, 'voice', 'lines.json'), JSON.stringify(lines, null, 2));
  writeFileSync(join(workdir, 'voice', 'timing.json'), JSON.stringify({ lines: lines.map((l, i) => ({ id: l.id, start: i * BEAT_SEC + 0.2, end: i * BEAT_SEC + 1.7 })) }, null, 2));
  lines.forEach((l, i) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + 20 * i}:duration=1.5`, '-af', 'volume=0.08', '-ar', '48000', join(workdir, 'voice', 'clips', `${l.id}.wav`)]));
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// The demo's music as a song (doc 18 S11): notes, instruments and the mini DAW's song files, so the song lane and the
// Piano roll can be tried with no Claude, no Strudel and no sound engine. A minor, 120 BPM, four 2-bar sections.
export function demoNotes(title = 'Demo') {
  const roots = [45, 41, 48, 43];                      // A2 F2 C3 G2, one per section
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  const bass = []; const keys = []; const drums = [];
  for (let bar = 0; bar < 8; bar++) {
    const sec = Math.floor(bar / 2);
    const b = bar * 4;
    for (const [beat, dur, up] of [[0, 1.5, 0], [1.5, 0.5, 0], [2, 1, 12], [3, 1, 7]]) bass.push({ pitch: roots[sec] + up, start: b + beat, dur, velocity: beat === 0 ? 0.9 : 0.7 });
    for (const beat of [1, 3]) for (const k of chords[sec]) keys.push({ pitch: k, start: b + beat, dur: 0.5, velocity: 0.6 });
    for (let e = 0; e < 8; e++) drums.push({ pitch: 42, start: b + e / 2, dur: 0.25, velocity: e % 2 ? 0.45 : 0.6 });
    for (const beat of [0, 2]) drums.push({ pitch: 36, start: b + beat, dur: 0.25, velocity: 0.9 });
    for (const beat of [1, 3]) drums.push({ pitch: 38, start: b + beat, dur: 0.25, velocity: 0.8 });
  }
  const sort = (ns) => ns.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { title, bpm: 120, meter: '4/4', beats_per_bar: 4, bars: 8, tracks: [
    { channel: 2, name: 'Bass', kind: 'pitched', notes: sort(bass) },
    { channel: 3, name: 'Keys', kind: 'pitched', notes: sort(keys) },
    { channel: 10, name: 'Drums', kind: 'drums', notes: sort(drums) },
  ] };
}

export const DEMO_INSTRUMENTS = { concept: 'A plain demo kit.', parts: [
  { channel: 2, role: 'Bass', sound: 'sawtooth', set: '.lpf(500)', gain: 0.7, pan: 0 },
  { channel: 3, role: 'Keys', sound: 'triangle', set: '.release(.2)', gain: 0.45, pan: -0.2 },
  { channel: 10, role: 'Drums', gain: 0.8, kit: { 36: { sound: 'sine', set: '.penv(24).decay(.2).sustain(0)' }, 38: { sound: 'pink', set: '.decay(.12).sustain(0)', gain: 0.6 }, 42: { sound: 'white', set: '.decay(.04).sustain(0)', gain: 0.5 } } },
] };

function writeDemoSong(root, projectId, workdir, title) {
  const music = join(workdir, 'music');
  const bp = JSON.parse(readFileSync(join(music, 'blueprint.json'), 'utf8'));
  const notes = demoNotes(title);
  writeFileSync(join(music, 'notes.json'), JSON.stringify(notes));
  writeFileSync(join(music, 'instruments.json'), JSON.stringify(DEMO_INSTRUMENTS, null, 2));
  const { song, text } = songFromNotes({ blueprint: bp, notes, instruments: DEMO_INSTRUMENTS });
  // the song file is itself a score (setcpm, one part per channel): it stands in for the session's score
  writeFileSync(join(music, 'score.strudel.js'), text);
  saveSong(root, projectId, song, text);
  // the "last render": a click on every beat (120 BPM, 8 bars), so playing the cut with the music can be checked by ear
  mkdirSync(join(workdir, 'out', 'music'), { recursive: true });
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(if(lt(mod(t,2),0.5),1500,1000))*t)*exp(-40*mod(t,0.5))':s=48000:d=16", '-ac', '2', join(workdir, 'out', 'music', 'score.wav')]);
}
