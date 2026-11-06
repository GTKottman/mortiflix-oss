// "Edit the video": the final as a Mortiflix Studio project. Every shot is its own clip on V1 (so one can be swapped at a time),
// every narration line its own clip on A1 at its time, the music on A2, a marker per beat. It is built with Mortiflix Studio's
// own headless engine (`mortiflix-studio-cli`), so the project is always in the format the installed Mortiflix Studio writes.
// out/edit/map.json ties every clip back to its canvas piece: click a clip in Mortiflix Studio, and the studio knows
// which shot, line or cue it is.
import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { projectPaths, loadProject } from './projects.mjs';
import { canvasView } from './canvas.mjs';
import { UserError } from './studio.mjs';

export const CONTROL_PORT = 9876;
const TPS = 254016000000; // Mortiflix Studio ticks per second

export function editPaths(root, id) {
  const dir = join(projectPaths(root, id).work, 'out', 'edit');
  return { dir, media: join(dir, 'media'), map: join(dir, 'map.json') };
}

// Mortiflix Studio, the desktop editor: its command line and app from the folder in MFX_STUDIO_BIN, else from PATH.
export function studioBin() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const dir of [process.env.MFX_STUDIO_BIN, ...(process.env.PATH || '').split(delimiter)].filter(Boolean)) {
    const cli = join(dir, `mortiflix-studio-cli${exe}`);
    if (!existsSync(cli)) continue;
    const app = join(dir, `mortiflix-studio${exe}`);
    const v = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return { cli, app: existsSync(app) ? app : null, version: (v.stdout || '').trim().split(/\s+/).pop() || null };
  }
  return null;
}

export function studioCli() {
  const fc = studioBin();
  if (!fc) throw new UserError('Mortiflix Studio isn\'t found: put mortiflix-studio-cli on PATH, or set MFX_STUDIO_BIN to its folder');
  return fc;
}

const run = (cmd, args, what) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
};

// Mortiflix Studio reads media best re-encoded: no B-frames (else frames show late), constant 48 kHz audio from time zero.
function prepVideo(src, dest, { from = null, to = null, audio = true } = {}) {
  const args = ['-y', '-loglevel', 'error'];
  if (from !== null) args.push('-ss', String(from));
  args.push('-i', src);
  if (to !== null && from !== null) args.push('-t', String(+(to - from).toFixed(3)));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-bf', '0', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ar', '48000', '-af', 'asetpts=N/SR/TB'); else args.push('-an');
  args.push(dest);
  run('ffmpeg', args, `preparing ${dest}`);
}
// Voice and music go in as 24-bit WAV (Mortiflix Studio reads it through Symphonia): 16-bit would round away 8 bits of the
// float mix with no dither (doc 15 §3). Anything not at 48 kHz is resampled once, by soxr at its best precision.
export const prepAudio = (src, dest) => run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-af', 'aresample=48000:resampler=soxr:precision=28', '-c:a', 'pcm_s24le', dest], `preparing ${dest}`);

export function makeEditProject(root, id, { log = () => {} } = {}) {
  const fc = studioCli(root);
  const project = loadProject(root, id);
  const state = projectPaths(root, id).state;
  const g = canvasView(root, id);
  const fp = editPaths(root, id);
  rmSync(fp.dir, { recursive: true, force: true });
  mkdirSync(fp.media, { recursive: true });
  const n = g.nodes;
  const shots = g.order.shots.map((s) => n[s]).filter((s) => s && s.state !== 'cut' && s.versions?.length);
  if (!shots.length) throw new UserError('nothing to edit yet: the shots come with the animatic');
  const lines = g.order.lines.map((l) => n[l]).filter((l) => l && l.state !== 'cut' && l.versions?.find((v) => v.v === l.current)?.file);
  const music = n.music && !n.music.missing ? n.music : null;
  const current = (node) => node.versions.find((v) => v.v === node.current);

  // 1. Media, one file per piece and version, named so a person can read the bin.
  log(`Preparing ${shots.length} shot${shots.length === 1 ? '' : 's'}${lines.length ? `, ${lines.length} voice lines` : ''}${music ? ' and the music' : ''}`);
  const files = [];
  let t = 0;
  for (const s of shots) {
    const v = current(s);
    const dest = join(fp.media, `${s.label}-v${s.current}.mp4`);
    // Without separate voice lines, a shot keeps its own sound (narration and music are in it).
    prepVideo(join(state, v.file), dest, { from: v.from_sec ?? null, to: v.to_sec ?? null, audio: !lines.length && !music });
    const len = +(v.to_sec - (v.from_sec || 0)).toFixed(3);
    files.push({ node: s.id, kind: 'shot', version: s.current, beat: s.beat || null, file: dest, label: `${s.label} · ${s.title || ''}`.trim().slice(0, 80), start_sec: +t.toFixed(3), seconds: len, audio: !lines.length && !music });
    t += len;
  }
  const shotStart = Object.fromEntries(files.map((f) => [f.beat, f.start_sec]));
  let lineCursor = {};
  for (const l of lines) {
    const dest = join(fp.media, `${l.label}-v${l.current}.wav`);
    prepAudio(join(state, current(l).file), dest);
    // At its narration time; without one, at the start of its beat's shot, after the beat's earlier lines.
    const at = l.start_sec ?? ((shotStart[l.beat] ?? 0) + (lineCursor[l.beat] || 0));
    const len = l.end_sec !== null && l.start_sec !== null ? l.end_sec - l.start_sec : 0;
    lineCursor[l.beat] = (lineCursor[l.beat] || 0) + len;
    files.push({ node: l.id, kind: 'line', version: l.current, beat: l.beat || null, file: dest, label: `${l.label} · ${String(l.title).slice(0, 60)}`, start_sec: +at.toFixed(3) });
  }
  if (music) {
    const dest = join(fp.media, `Music-v${music.current}.wav`);
    prepAudio(join(state, current(music).file), dest);
    files.push({ node: 'music', kind: 'music', version: music.current, beat: null, file: dest, label: 'Music', start_sec: 0 });
  }

  // 2. The project, through Mortiflix Studio's own engine.
  const fcproj = join(fp.dir, `${project.title.replace(/[^\w .-]+/g, '').trim() || 'Mortiflix'}.mortiflix`);
  const cli = (args, what) => JSON.parse(run(fc.cli, ['--compact', ...args], what).trim() || 'null');
  const exec = (cmd, params) => cli(['--project', fcproj, '--save', 'exec', cmd, JSON.stringify(params)], cmd);
  cli(['--save-as', fcproj, 'exec', 'file.newProject', JSON.stringify({ name: project.title })], 'file.newProject');
  const imported = exec('file.import', { paths: files.map((f) => f.file) });
  if (imported.errors?.length) throw new Error(`Mortiflix Studio couldn't import: ${JSON.stringify(imported.errors).slice(0, 300)}`);
  files.forEach((f, i) => { f.item = imported.items[i]; });
  // The sequence takes the shots' own frame rate and size.
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', files[0].file], 'ffprobe')).streams[0];
  const [num, den] = String(probe.r_frame_rate).split('/').map(Number);
  const fps = +(num / (den || 1)).toFixed(3);
  const seq = exec('file.newSequence', { name: project.title, width: probe.width, height: probe.height, fps, video: 2, audio: 3 }).sequence;
  const placed = exec('timeline.place', { items: files.filter((f) => f.kind === 'shot').map((f) => f.item), track: 'V1', seconds: 0, insert: false, audio: !lines.length && !music });
  files.filter((f) => f.kind === 'shot').forEach((f, i) => { f.clip = placed.placed?.[i]?.[0] ?? placed.clips[i]; });
  for (const f of files.filter((x) => x.kind !== 'shot')) {
    const r = exec('timeline.place', { item: f.item, track: f.kind === 'music' ? 'A2' : 'A1', seconds: f.start_sec, insert: false, video: false });
    f.clip = r.clips[0];
  }
  // Names and beat markers in one run (no result needed from them).
  const script = [
    ...files.map((f) => ({ id: 'clip.rename', params: { clip: f.clip, name: f.label } })),
    ...files.filter((f) => f.kind === 'shot' && f.beat).map((f) => ({ id: 'markers.add', params: { target: 'program', time: Math.round(f.start_sec * TPS), name: `${n[f.beat]?.label || ''} ${String(n[f.beat]?.title || '').slice(0, 60)}`.trim(), ...(n[f.beat]?.colour?.label ? { color: n[f.beat].colour.label } : {}) } })),
  ];
  const jsonl = join(fp.dir, '.names.jsonl');
  writeFileSync(jsonl, script.map((x) => JSON.stringify(x)).join('\n'));
  spawnSync(fc.cli, ['--project', fcproj, '--save', '--keep-going', 'run', jsonl], { encoding: 'utf8', timeout: 120_000 });
  rmSync(jsonl, { force: true });

  const map = {
    format: 'mortiflix.edit', version: 1, project: id, fcproj, sequence: seq, fps, made_at: new Date().toISOString(), studio: fc.version,
    clips: files.map(({ node, kind, version, beat, item, clip, label, start_sec, seconds, file, audio }) => ({ node, kind, version, beat, item, clip, label, start_sec, seconds: seconds ?? null, file, ...(kind === 'shot' ? { audio } : {}) })),
  };
  writeFileSync(fp.map, JSON.stringify(map, null, 2));
  log(`Mortiflix Studio project: ${fcproj} (${files.length} clips)`);
  return map;
}

export function loadMap(root, id) {
  try { return JSON.parse(readFileSync(editPaths(root, id).map, 'utf8')); } catch { return null; }
}

// Open the project in desktop Mortiflix Studio with its control channel on (loopback only), so the studio can see what the
// owner clicks. On Hyprland it opens on workspace 9, out of the way of whatever the owner has open.
export function openInStudio(root, id, { port = CONTROL_PORT } = {}) {
  const fc = studioCli(root);
  const map = loadMap(root, id);
  if (!map || !existsSync(map.fcproj)) throw new UserError('make the Mortiflix Studio project first (Export › Edit the video)');
  if (!fc.app) throw new UserError('this Mortiflix Studio install has no desktop app');
  const argv = [fc.app, '--control', String(port), map.fcproj];
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    // On a workspace that isn't on screen Mortiflix Studio would stop drawing, and it answers its control channel only as it
    // draws: let its window keep drawing there (Mortiflix Studio's window only; gone at the next Hyprland reload).
    spawnSync('hyprctl', ['keyword', 'windowrule', 'render_unfocused on, match:class ^(com\\.mortiflix\\.studio)$']);
    spawnSync('hyprctl', ['dispatch', 'exec', `[workspace 9 silent] ${argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`]);
  } else {
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' }).unref();
  }
  return { opened: map.fcproj, port };
}

// ---- the control channel: what the owner clicked in Mortiflix Studio ----

// One request on Mortiflix Studio's control channel (JSON lines on 127.0.0.1, one reply per request).
export function control(method, params = undefined, { port = CONTROL_PORT, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Mortiflix Studio isn\'t answering (is it open, with its control channel on?)')); }, timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, method, ...(params ? { params } : {}) })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer); sock.end();
      let m; try { m = JSON.parse(buf.slice(0, nl)); } catch (e) { return reject(e); }
      if (!m.ok) return reject(new Error(m.error || 'Mortiflix Studio refused the request'));
      resolve(m.result);
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ECONNREFUSED' ? 'Mortiflix Studio isn\'t open (Open in Mortiflix Studio)' : e.message)); });
  });
}

// The clips selected in Mortiflix Studio, each with the canvas piece it is: by clip id from map.json, else through the media
// item (a clip that was cut with the razor or moved keeps its media item).
export async function studioSelection(root, id, opts = {}) {
  const map = loadMap(root, id);
  if (!map) return { open: false, selected: [] };
  const ui = await control('ui.inspect', undefined, opts);
  const ids = (ui.selection || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { open: true, selected: [] };
  const byClip = new Map(map.clips.map((c) => [c.clip, c]));
  let itemOf = null;
  const out = [];
  for (const clip of ids) {
    let c = byClip.get(clip);
    if (!c) {
      if (!itemOf) {
        const seq = await control('engine.execute', { command: 'sequence.inspect' }, opts);
        itemOf = new Map([...(seq.video || []), ...(seq.audio || [])].flatMap((t) => (t.items || []).map((x) => [x.clip, x.item])));
      }
      c = map.clips.find((x) => x.item === itemOf.get(clip));
    }
    // A clip and its linked sound are one piece.
    if (c && !out.some((x) => x.node === c.node)) out.push({ clip, node: c.node, kind: c.kind, label: c.label, version: c.version });
  }
  return { open: true, selected: out };
}

// ---- a new version goes into Mortiflix Studio ----

// A piece got a new version on the canvas (the owner's request, made by a session): it replaces the old one in the
// Mortiflix Studio project, at the same place on the timeline, its linked sound with it. The old version stays in the bin, so
// Mortiflix Studio's own undo (or replacing back from the bin) brings it back. Through the open app when Mortiflix Studio is open,
// else straight into the project file with the headless engine.
export async function swapIntoEdit(root, id, node, { log = () => {} } = {}) {
  const map = loadMap(root, id);
  if (!map) return { swapped: false, why: 'no Mortiflix Studio project' };
  const entries = map.clips.filter((c) => c.node === node);
  if (!entries.length) return { swapped: false, why: `${node} isn't in the Mortiflix Studio project` };
  const g = canvasView(root, id);
  const n = g.nodes[node];
  const v = n?.versions?.find((x) => x.v === n.current);
  if (!v?.file || entries.every((c) => c.version === n.current)) return { swapped: false, why: 'already the newest version' };
  const state = projectPaths(root, id).state;
  const fp = editPaths(root, id);
  const isAudio = entries[0].kind !== 'shot';
  const dest = join(fp.media, `${n.label}-v${n.current}.${isAudio ? 'wav' : 'mp4'}`);
  if (isAudio) prepAudio(join(state, v.file), dest);
  else prepVideo(join(state, v.file), dest, { from: v.from_sec ?? null, to: v.to_sec ?? null, audio: entries[0].audio !== false });
  const name = entries[0].label;

  let via;
  try {
    await control('ui.inspect', undefined, { timeoutMs: 2500 });
    via = 'app';
  } catch { via = 'file'; }
  const exec = via === 'app'
    ? (command, params) => control('engine.execute', { command, params }, { timeoutMs: 30_000 })
    : async (command, params) => JSON.parse(run(studioCli(root).cli, ['--compact', '--project', map.fcproj, '--save', 'exec', command, JSON.stringify(params)], command).trim() || 'null');
  const imp = await exec('file.import', { paths: [dest] });
  if (imp?.errors?.length || !imp?.items?.length) throw new Error(`Mortiflix Studio couldn't import ${dest}`);
  const item = imp.items[0];
  await exec('clip.replaceFromBin', { clips: entries.map((c) => c.clip), item });
  for (const c of entries) await exec('clip.rename', { clip: c.clip, name });
  if (via === 'app') await exec('file.save', {});
  for (const c of entries) { (c.previous ||= []).push({ version: c.version, item: c.item, file: c.file }); Object.assign(c, { version: n.current, item, file: dest }); }
  writeFileSync(fp.map, JSON.stringify(map, null, 2));
  log(`${n.label} v${n.current} is in Mortiflix Studio (${via === 'app' ? 'the open app' : 'the project file'})`);
  return { swapped: true, via, node, version: n.current, item };
}

// ---- the big render: the edited timeline, out of Mortiflix Studio ----

export const RENDER_PRESET = 'Match Source – Adaptive High Bitrate';

// Saves the open project (when Mortiflix Studio is open), then exports the sequence with Mortiflix Studio's own engine. Resolves with
// the rendered file; `onLine` gets Mortiflix Studio's progress lines.
export async function renderFromEdit(root, id, { onLine = () => {} } = {}) {
  const fc = studioCli(root);
  const map = loadMap(root, id);
  if (!map || !existsSync(map.fcproj)) throw new UserError('there is no Mortiflix Studio project for this video yet');
  try { await control('engine.execute', { command: 'file.save', params: {} }, { timeoutMs: 5000 }); onLine('Saved the open Mortiflix Studio project'); } catch { /* not open: the file is current */ }
  const project = loadProject(root, id);
  const outDir = join(editPaths(root, id).dir, 'render');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${project.title.replace(/[^\w .-]+/g, '').trim() || 'Mortiflix'} (edited).mp4`);
  rmSync(out, { force: true });
  await new Promise((resolve, reject) => {
    const p = spawn(fc.cli, ['--project', map.fcproj, 'export', out, '--preset', RENDER_PRESET], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (d) => { tail = (tail + d).slice(-4000); for (const l of String(d).split(/\r?\n/).filter(Boolean)) onLine(l.slice(0, 300)); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && existsSync(out) ? resolve() : reject(new Error(`Mortiflix Studio's export failed (${code}): ${tail.trim().split('\n').pop() || ''}`))));
  });
  return out;
}
