// Video Notes inside Mortiflix: the owner reviews each Motion scene on their tablet (pen marks, spoken/typed notes, OK) and
// Mortiflix picks the notes up. This writes and reads the SAME files as the video-notes MCP
// (~/Documents/programs/video-notes/mcp/video_notes_mcp.py), so the tablet app needs no change:
//   <root>/queue.json {items:[...]} newest first · <id>/video.mp4 poster.jpg audio.wav transcript.json (written here)
//   <id>/status.json {status:"reviewing"|"done", at} · notes.json [{n,id,f,t,text,ink,snap,...}] · snaps/<note>.jpg (the app)
// Opt-in: config.videoNotes = {enabled: false, folder: null}. Nothing is queued until the owner turns it on in Settings.
// No port is opened: the tablet reads Morti Drive (:8443 on the tailnet, the LAN door on :8443 at home).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync, realpathSync, accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { loadConfig, saveConfig, UserError, isInside } from '../studio.mjs';
import { loadProject, projectPaths, update } from '../projects.mjs';
import { run as runAsync } from './run.mjs';
import { saveNote, sendNotes, sceneApprove, sceneGet, sceneState, sceneTablet, setSceneTablet, pickLessons } from './lessons.mjs';
import { loadFrames } from './framestate.mjs';

const FPS = 30;
const TABLET_PORT = 8443;
export const DEFAULT_FOLDER = () => resolve((process.env.VIDEO_NOTES_DIR || '~/MortiDrive/files/Video Notes').replace(/^~(?=$|\/)/, homedir()));
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeAtomic = (f, v) => { mkdirSync(join(f, '..'), { recursive: true }); const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o644 }); renameSync(t, f); };
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

// ---- config ----
export function vnConfig(root) {
  const c = loadConfig(root).videoNotes || {};
  return { enabled: c.enabled === true, folder: c.folder ? resolve(String(c.folder).replace(/^~(?=$|\/)/, homedir())) : DEFAULT_FOLDER() };
}
const folderProblem = (folder) => {
  if (!existsSync(folder)) { try { mkdirSync(folder, { recursive: true }); } catch { return `The Video Notes folder ${folder} does not exist and cannot be made.`; } }
  try { accessSync(folder, constants.W_OK); } catch { return `The Video Notes folder ${folder} is not writable.`; }
  return null;
};
// a cheap, sync view for setup.status
export function videoNotesLight(root) {
  const c = vnConfig(root);
  return { enabled: c.enabled, ready: c.enabled && existsSync(c.folder) };
}

// ---- status / setup (the settings screen) ----
const isTailnetIp = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
const ping = (url, timeout = 1500) => new Promise((ok) => {
  const req = (url.startsWith('https:') ? https : http).get(`${url}/lan-ping`, { timeout }, (res) => { res.resume(); ok(res.statusCode === 200); });
  req.on('timeout', () => { req.destroy(); ok(false); });
  req.on('error', () => ok(false));
});

// Where the tablet can reach the PC: the tailnet name and IP from `tailscale status --json`, and the LAN addresses. Same
// place the tablet already reads (Morti Drive on :8443). Nothing is opened. `probe` (tests) replaces the three lookups.
export async function videoNotesStatus(root, { probe = {} } = {}) {
  const c = vnConfig(root);
  const problems = [];
  const addresses = [];
  const ts = probe.tailscale ? await probe.tailscale() : await runAsync('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  let tsj = null;
  if (ts?.error || ts?.status !== 0) problems.push(ts?.error?.code === 'ENOENT' ? 'Tailscale is not installed on this PC, so the tablet cannot reach it away from home. At home it can still use the local network.' : 'Tailscale is not running or not signed in on this PC, so the tablet cannot reach it away from home.');
  else { try { tsj = JSON.parse(ts.stdout); } catch { problems.push('Tailscale answered, but its status could not be read.'); } }
  if (tsj) {
    const name = String(tsj.Self?.DNSName || '').replace(/\.$/, '');
    if (tsj.BackendState && tsj.BackendState !== 'Running') problems.push(`Tailscale is ${String(tsj.BackendState).toLowerCase()}: turn it on so the tablet can reach this PC away from home.`);
    if (name) addresses.push({ kind: 'tailscale', url: `https://${name}:${TABLET_PORT}` });
    // (no http://<tailnet ip>:port entry: Tailscale serves this port as https on the name only)
    if (!name && !addresses.length) problems.push('Tailscale is running but gave this PC no name or address.');
  }
  const nets = probe.interfaces ? probe.interfaces() : networkInterfaces();
  for (const [ifname, list] of Object.entries(nets)) {
    if (/^(lo|docker|br-|veth|tailscale|virbr|zt|wg)/.test(ifname)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !isTailnetIp(a.address)) addresses.push({ kind: 'local', url: `http://${a.address}:${TABLET_PORT}` });
  }
  if (!addresses.some((a) => a.kind === 'local')) problems.push('No local network address was found on this PC, so the tablet cannot reach it at home.');
  const pinger = probe.ping || ping;
  let anyUp = false;
  // The PC often cannot resolve its own tailnet name, so the tailnet door is checked the way Tailscale serves it:
  // `tailscale serve` must publish this port, and the local place it forwards to must answer.
  const served = probe.serve ? await probe.serve() : await (async () => {
    const r = await runAsync('tailscale', ['serve', 'status', '--json'], { timeout: 5000 });
    try { const web = JSON.parse(r.stdout || '{}').Web || {}; const k = Object.keys(web).find((x) => x.endsWith(`:${TABLET_PORT}`)); return k ? web[k].Handlers?.['/']?.Proxy || null : null; } catch { return null; }
  })();
  for (const a of addresses) {
    if (a.kind === 'tailscale') { a.reachable = !!served && await pinger(served); if (!served) problems.push(`Tailscale does not share port ${TABLET_PORT} yet, so the tablet cannot reach this PC away from home. Run: tailscale serve --bg --https=${TABLET_PORT} http://127.0.0.1:8686`); }
    else a.reachable = await pinger(a.url);
    anyUp ||= a.reachable;
  }
  if (addresses.length && !anyUp) problems.push(`The tablet door (Morti Drive on port ${TABLET_PORT}) did not answer here. Start Morti Drive and its Video Notes home door, then check again.`);
  const fp = folderProblem(c.folder);
  if (fp) problems.push(fp);
  else {
    try {
      const drive = realpathSync(join(homedir(), 'MortiDrive', 'files'));
      if (!isInside(drive, realpathSync(c.folder))) problems.push('This folder is outside Morti Drive, so the tablet cannot see it. Pick a folder inside Morti Drive.');
    } catch { /* no Morti Drive here: nothing to compare with */ }
  }
  return { enabled: c.enabled, folder: c.folder, addresses, tablet_seen: tabletSeen(c.folder), problems };
}

// The last time the tablet touched anything: the newest progress / status / notes file across the queued videos.
export function tabletSeen(folder) {
  let best = 0;
  const q = readJson(join(folder, 'queue.json'), { items: [] }).items || [];
  for (const it of q.slice(0, 200)) for (const f of ['progress.json', 'status.json', 'notes.json']) best = Math.max(best, mtime(join(folder, it.id, f)));
  return best ? new Date(best).toISOString() : null;
}

export function videoNotesSetup(root, p = {}) {
  const cur = vnConfig(root);
  const enabled = p.enabled === undefined ? cur.enabled : p.enabled === true;
  const folder = p.folder === undefined ? undefined : (p.folder ? resolve(String(p.folder).replace(/^~(?=$|\/)/, homedir())) : null);
  if (folder) { const fp = folderProblem(folder); if (fp) throw new UserError(fp); }
  saveConfig(root, { videoNotes: { enabled, folder: folder === undefined ? (loadConfig(root).videoNotes?.folder || null) : folder } });
  return { ...videoNotesLight(root), folder: vnConfig(root).folder };
}

// ---- ok_words: what OK will do, in words (plan 90 §2.1, part 20 V8). The tablet shows `notes` on the OK button when the item has
// notes and `none` when it has none; an older app ignores the field and says "OK". Written on EVERY item the studio queues. ----
export function okWords(kind, { n = 1, last = false, group = false } = {}) {
  if (kind === 'scene') return { notes: `OK · Remake scene ${n}`, none: last ? 'OK · Done' : 'OK · Next scene' };
  if (kind === 'frame') return { notes: 'OK · Remake this frame', none: last ? 'OK · Done' : group ? 'OK · Next group' : 'OK · Next frame' };
  if (kind === 'still') return { notes: 'OK · Remake this still', none: last ? 'OK · Done' : group ? 'OK · Next group' : 'OK · Next still' };
  return { notes: 'OK · Send my notes', none: 'OK' };
}

// ---- queue a scene ----
const shortTitle = (t) => { const s = String(t || '').trim(); if (s.length <= 28) return s; const cut = s.slice(0, 28); return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s:,-]+$/, ''); };

async function probeFile(file, { timeout = 60_000 } = {}) {
  const r = await runAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file], { timeout });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${String(r.stderr || r.error?.message).slice(0, 200)}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = d ? n / d : FPS;
  const dur = Number(j.format?.duration || 0);
  return { codec: v.codec_name, h: v.height || 0, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'), fps: Math.round(fps * 1000) / 1000, duration_s: Math.round(dur * 1000) / 1000, frames: Number(v.nb_frames) || Math.round(dur * fps) };
}

// Review copy (H.264 MP4 with sound, <= 1080p): the clip is copied when it already is one, converted once otherwise; plus the
// poster and audio.wav the app reads. `media` (tests) replaces the ffmpeg work: ({src, dir}) -> {fps, frames, duration_s}.
async function makeReviewCopy(src, dir, media) {
  if (media) return media({ src, dir });
  const info = await probeFile(src);
  const dst = join(dir, 'video.mp4');
  if (info.codec === 'h264' && /\.mp4$/i.test(src) && info.h <= 1080 && info.hasAudio) copyFileSync(src, dst);
  else {
    const r = await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', src, '-vf', "scale=-2:'min(1080,ih)'", '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dst], { timeout: 15 * 60_000 });
    if (r.status !== 0) throw new Error(`converting the review copy failed: ${String(r.stderr || r.error?.message).slice(0, 200)}`);
  }
  const ps = await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-ss', String(Math.min(1, info.duration_s / 2)), '-i', dst, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', join(dir, 'poster.jpg')], { timeout: 120_000 });
  if (ps.status !== 0) throw new Error('making the poster frame failed');
  const au = await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', dst, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', join(dir, 'audio.wav')], { timeout: 10 * 60_000 });
  if (au.status !== 0) await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(info.duration_s || 1), '-c:a', 'pcm_s16le', join(dir, 'audio.wav')], { timeout: 120_000 });
  return info;
}

// The scene's narration words with frames relative to its clip: out/scenes/clips.json gives the clip's first frame (from),
// voice/timing.json the lines (id "<beat>-N", seconds from the start of the narration).
export function sceneTranscript(work, beats, from, fps = FPS) {
  const timing = readJson(join(work, 'voice', 'timing.json'), { lines: [] });
  const out = [];
  for (const l of timing.lines || []) {
    if (!beats.some((b) => String(l.id).startsWith(`${b}-`)) || !l.text) continue;
    const f0 = Math.max(0, Math.round(l.start * fps) - from);
    const f1 = Math.max(f0, Math.round((l.end ?? l.start) * fps) - from);
    out.push({ f0, f1, text: String(l.text) });
  }
  return out;
}

// Queues the scenes that just became `review` (called after the studio built them). Does nothing when Video Notes is off.
// Returns the Video Notes ids, [] when off or nothing to queue. Never throws: a failed queue is noted on the scene instead.
export async function queueScenes(root, id, beatIds, { media = null, emit = null, resend = false } = {}) {
  const cfg = vnConfig(root);
  if (!cfg.enabled) return [];
  const made = [];
  for (const beat of beatIds) {
    try {
      const sc = sceneGet(root, id).scenes.find((s) => s.beat === beat);
      if (!sc?.clip) { setSceneTablet(root, id, beat, { error: 'no clip to queue' }); continue; }
      const { beats } = sceneState(root, id);
      const n = beats.findIndex((b) => b.id === beat) + 1;
      const project = loadProject(root, id);
      const prev = sceneTablet(root, id)[beat];
      const work = projectPaths(root, id).work;
      const clips = readJson(join(work, 'out', 'scenes', 'clips.json'), []);
      const clip = clips.find((c) => (c.beats || []).includes(beat));
      const stamp = new Date();
      const slug = `${project.title || id} scene ${n}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const vid = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}-${slug}-${createHash('sha1').update(sc.clip.file + stamp.toISOString()).digest('hex').slice(0, 4)}`;
      const dir = join(cfg.folder, vid);
      mkdirSync(dir, { recursive: true });
      const info = await makeReviewCopy(sc.clip.file, dir, media);
      const tr = sceneTranscript(work, clip?.beats || [beat], clip?.from ?? sc.clip.from ?? 0, info.fps || FPS);
      if (tr.length) writeAtomic(join(dir, 'transcript.json'), tr);
      const lessons = pickLessons(root, id, { step: 'animatic' }).chosen.length;
      const look_for = `Scene ${n} of ${beats.length}, made with ${lessons} lesson${lessons === 1 ? '' : 's'} from your earlier notes.${prev ? ' This is the fixed version.' : ''}`;
      const title = `${shortTitle(project.title || id)} · Scene ${n}`;
      const item = { id: vid, title, project: project.title || id, look_for, ok_words: okWords('scene', { n, last: n === beats.length }), video: `${vid}/video.mp4`, poster: `${vid}/poster.jpg`, audio: `${vid}/audio.wav`, fps: info.fps, frames: info.frames, duration_s: info.duration_s, added: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), source: sc.clip.file };
      const qf = join(cfg.folder, 'queue.json');
      const q = readJson(qf, { items: [] });
      // a resend replaces this scene's previous OPEN tablet item (not done, not handled): no duplicate on the tablet
      const old = resend && prev?.id && !prev.handled && prev.status !== 'done' ? prev.id : null;
      q.items = [item, ...(q.items || []).filter((x) => x.id !== old)];
      writeAtomic(qf, q);
      setSceneTablet(root, id, beat, { id: vid, status: 'to review', notes: 0, imported: [], handled: false, queued_at: item.added, error: null, ...(prev ? { prev: [...(prev.prev || []), ...(old ? [] : [prev.id])].filter(Boolean) } : {}) });
      made.push(vid);
    } catch (e) {
      try { setSceneTablet(root, id, beat, { error: String(e.message).slice(0, 300) }); } catch { /* state gone */ }
      console.error(`video notes: queueing scene ${beat}: ${e.message}`);
    }
  }
  if (made.length) emit?.('videonotes.changed', { project: id });
  return made;
}

// videonotes.resend {project, scene}: queue the scene's CURRENT clip on the tablet again, replacing its open item. Plain refusals.
export async function resendScene(root, id, beat, { media = null, emit = null } = {}) {
  if (!vnConfig(root).enabled) throw new UserError('Video Notes is off, so nothing can be sent to the tablet. Turn it on in Settings first.');
  const b = String(beat || '');
  const sc = sceneGet(root, id).scenes.find((s) => s.beat === b);
  if (!sc) throw new UserError(`no scene ${b || '(none)'}`);
  if (!sc.clip) throw new UserError(`Scene ${b} has no clip yet, so there is nothing to send.`);
  const ids = await queueScenes(root, id, [b], { media, emit, resend: true });
  if (!ids.length) throw new UserError(sceneTablet(root, id)[b]?.error || `Scene ${b} could not be sent to the tablet.`);
  return { scene: b, tablet: sceneGet(root, id).scenes.find((s) => s.beat === b).tablet };
}

// ---- the tablet map (generalized, plan 90 §2.3): anything the owner reviews on the tablet is one entry, keyed `<kind>:<ref>`:
// `scene:b03` (a Motion scene: kept in mfx.motion_scenes.tablet[b03], as before), `frame:sf01` (a style frame) and `still:b01-2`
// (a still): kept in mfx.tablet[key]. Every entry is {id (the Video Notes id), status, notes, imported[], handled, prev[], queued_at}. ----
const keyOf = (kind, ref) => `${kind}:${ref}`;
export function tabletEntries(root, id) {
  const out = [];
  try { for (const [beat, t] of Object.entries(sceneTablet(root, id))) out.push({ key: keyOf('scene', beat), kind: 'scene', ref: beat, t }); } catch { /* no scenes yet */ }
  try { for (const [key, t] of Object.entries(loadProject(root, id).mfx?.tablet || {})) { const i = key.indexOf(':'); if (i > 0) out.push({ key, kind: key.slice(0, i), ref: key.slice(i + 1), t }); } } catch { /* no project */ }
  return out;
}
export function setTablet(root, id, kind, ref, patch) {
  if (kind === 'scene') return setSceneTablet(root, id, ref, patch);
  const key = keyOf(kind, ref);
  return update(root, id, (p) => { p.mfx ||= {}; const m = { ...(p.mfx.tablet || {}) }; if (patch === null) delete m[key]; else m[key] = { ...(m[key] || {}), ...patch }; p.mfx.tablet = m; });
}
export const tabletOf = (root, id, kind, ref) => tabletEntries(root, id).find((e) => e.kind === kind && e.ref === ref)?.t || null;

// ---- queue a picture (a style frame or a still): the same item as a video plus the image fields (plan 90 §2.1). The review copy is the
// full-size PNG (at most 2560 on the long side) plus a 1-second video of it and silence, so an older tablet app can still open and mark it.
async function makeImageCopy(src, dir, media) {
  if (media) return media({ src, dir, image: true });
  const dst = join(dir, 'image.png');
  const r = await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', src, '-vf', "scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', dst], { timeout: 120_000 });
  if (r.status !== 0) copyFileSync(src, dst);
  const info = await runAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', dst], { timeout: 30_000 });
  let w = 0, h = 0; try { const v = JSON.parse(info.stdout).streams[0]; w = v.width; h = v.height; } catch { /* unknown size */ }
  const v = await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-loop', '1', '-framerate', String(FPS), '-i', dst, '-t', '1', '-vf', "scale=-2:'min(1080,ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', join(dir, 'video.mp4')], { timeout: 120_000 });
  if (v.status !== 0) throw new Error(`making the compatibility video failed: ${String(v.stderr || v.error?.message).slice(0, 200)}`);
  await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', dst, '-vf', 'scale=640:-2', '-q:v', '4', join(dir, 'poster.jpg')], { timeout: 60_000 });
  await runAsync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', join(dir, 'audio.wav')], { timeout: 60_000 });
  return { w, h, fps: FPS, frames: FPS, duration_s: 1 };
}

/**
 * Queue one picture on the tablet. p = {kind: 'frame'|'still', ref ('sf01' | 'b01-2'), file (the PNG), title, look_for, group?, group_index?, group_count?,
 * ok_words?}. Never throws: a failure is noted on the entry. Returns the Video Notes id or null (Video Notes off, or it failed).
 */
export async function queueImage(root, id, p, { media = null, emit = null } = {}) {
  const cfg = vnConfig(root);
  if (!cfg.enabled) return null;
  const { kind, ref } = p;
  try {
    if (!existsSync(p.file)) throw new Error(`no picture at ${p.file}`);
    const project = loadProject(root, id);
    const prev = tabletOf(root, id, kind, ref);
    const stamp = new Date();
    const slug = `${project.title || id} ${kind} ${ref}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const pad = (n) => String(n).padStart(2, '0');
    const vid = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}-${slug}-${createHash('sha1').update(p.file + stamp.toISOString()).digest('hex').slice(0, 4)}`;
    const dir = join(cfg.folder, vid);
    mkdirSync(dir, { recursive: true });
    const info = await makeImageCopy(p.file, dir, media);
    const item = { id: vid, kind: 'image', title: String(p.title || ref).slice(0, 80), project: project.title || id, look_for: `${p.look_for || ''}${prev ? ' This is the fixed version.' : ''}`.trim(), image: `${vid}/image.png`, w: info.w || null, h: info.h || null, poster: `${vid}/poster.jpg`,
      ...(p.group ? { group: p.group, group_index: p.group_index || 1, group_count: p.group_count || 1 } : {}), ok_words: p.ok_words || okWords(kind), video: `${vid}/video.mp4`, audio: `${vid}/audio.wav`, fps: info.fps || FPS, frames: info.frames || FPS, duration_s: info.duration_s || 1, added: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), source: p.file };
    const qf = join(cfg.folder, 'queue.json');
    const q = readJson(qf, { items: [] });
    q.items = [item, ...(q.items || [])];
    writeAtomic(qf, q);
    setTablet(root, id, kind, ref, { id: vid, status: 'to review', notes: 0, imported: [], handled: false, queued_at: item.added, error: null, ...(prev ? { prev: [...(prev.prev || []), prev.id].filter(Boolean) } : {}) });
    emit?.('videonotes.changed', { project: id });
    return vid;
  } catch (e) {
    try { setTablet(root, id, kind, ref, { error: String(e.message).slice(0, 300) }); } catch { /* state gone */ }
    console.error(`video notes: queueing ${kind} ${ref}: ${e.message}`);
    return null;
  }
}

const shortOf = (project, id) => shortTitle(project.title || id);
// The style frames that just became `review` (the studio made them): one image item each, grouped "<title> · Look", frame N of M.
export async function queueFrames(root, id, frameIds, { media = null, emit = null } = {}) {
  if (!vnConfig(root).enabled) return [];
  const work = projectPaths(root, id).work;
  const st = loadFrames(work);
  const project = loadProject(root, id);
  const lessons = pickLessons(root, id, { step: 'frames' }).chosen.length;
  const made = [];
  for (const fid of frameIds) {
    const i = st.frames.findIndex((f) => f.id === fid);
    const f = st.frames[i];
    const v = f?.versions.find((x) => x.v === f.current);
    if (!f || !v || f.state !== 'review') continue;
    const left = st.frames.filter((x) => !['ok', 'skipped'].includes(x.state)).length;
    const nextRound = st.frames.some((x) => x.state === 'todo');
    const ow = okWords('frame', { last: left <= 1 && !nextRound, group: false });
    const vid = await queueImage(root, id, { kind: 'frame', ref: fid, file: join(work, v.file), title: `${shortOf(project, id)} · Frame ${i + 1}`,
      look_for: `Frame ${i + 1} of ${st.frames.length}: ${f.note || f.label}. Made with ${lessons} lesson${lessons === 1 ? '' : 's'} from your earlier notes.`,
      group: `${shortOf(project, id)} · Look`, group_index: i + 1, group_count: st.frames.length, ok_words: ow }, { media, emit });
    if (vid) made.push(vid);
  }
  return made;
}

// ---- pick up ----
const sig = new Map(); // Video Notes id -> "mtime|mtime" last looked at (cheap: two stats per waiting scene)
let busy = false;

// One look at the current project's queued scenes. Called by the service tick; two stats per waiting scene when nothing
// changed. `actions` = {send(beat), approve(beat), ask} so the service's own handlers do the work (and wake the runner).
export async function pollTablet(root, id, { actions, emit = null } = {}) {
  if (!id || busy) return false;
  const cfg = vnConfig(root);
  if (!cfg.enabled) return false;
  let entries;
  try { entries = tabletEntries(root, id).filter((e) => e.t.id && !e.t.handled); } catch { return false; }
  let changed = false;
  busy = true;
  try {
    for (const e of entries) {
      const { t } = e;
      const dir = join(cfg.folder, t.id);
      const key = `${mtime(join(dir, 'status.json'))}|${mtime(join(dir, 'notes.json'))}`;
      if (sig.get(t.id) === key) continue;
      sig.set(t.id, key);
      const status = readJson(join(dir, 'status.json'), {}).status || 'to review';
      const notes = readJson(join(dir, 'notes.json'), []);
      if (status !== t.status || notes.length !== t.notes) { setTablet(root, id, e.kind, e.ref, { status, notes: notes.length }); changed = true; }
      if (status !== 'done') continue; // reviewing: the notes can still change, import nothing yet
      await importAndAct(root, id, e, cfg.folder, notes, actions);
      changed = true;
    }
  } finally { busy = false; }
  if (changed) emit?.('videonotes.changed', { project: id });
  return changed;
}

// What the owner's OK means for each kind of thing (the same as the app's keys): scene (motion.scene.*), frame (frames.ok / frames.fix),
// still (stills.*). With notes -> the notes are imported (once each) and THAT thing is remade; with none -> it is OK'd and the next is made.
// A thing the owner already settled in the app is left alone: only the notes are kept (the app wins).
const settled = (root, id, kind, ref) => {
  if (kind === 'scene') return sceneGet(root, id).scenes.find((s) => s.beat === ref)?.state !== 'review';
  if (kind === 'frame') return loadFrames(projectPaths(root, id).work).frames.find((f) => f.id === ref)?.state !== 'review';
  return false;
};
async function importAndAct(root, id, e, folder, notes, actions) {
  const { kind, ref, t } = e;
  const item = (readJson(join(folder, 'queue.json'), { items: [] }).items || []).find((x) => x.id === t.id) || {};
  const still = item.kind === 'image' || kind !== 'scene';
  const fps = item.fps || FPS;
  const dir = join(folder, t.id);
  const imported = [...(t.imported || [])];
  const ordered = [...notes].sort((a, b) => (a.f || 0) - (b.f || 0) || (a.n || 0) - (b.n || 0));
  for (const n of ordered) {
    const nid = String(n.id ?? `n${n.n}`);
    if (imported.includes(nid)) continue; // never the same note twice
    const snap = snapOf(dir, n.snap);
    const f = still ? 0 : Math.max(0, Math.round(Number(n.f) || 0)); // a picture has no frame number or time: the service ignores them
    const text = String(n.text || '').trim() || (snap ? '' : '(no words: see the marks)');
    await saveNote(root, id, { node: ref, time: f / fps, frame: f, text, send: false, tablet: `${t.id}/${nid}`, ...(snap ? { image_png_base64: snap, image_ext: 'jpg' } : {}) }, { ask: actions.ask });
    imported.push(nid);
    setTablet(root, id, kind, ref, { imported });
  }
  if (settled(root, id, kind, ref)) { setTablet(root, id, kind, ref, { handled: true, status: 'done', notes: notes.length }); return; }
  const verb = imported.length ? 'send' : 'approve';
  const fn = kind === 'scene' ? actions[verb] : actions[`${kind}${imported.length ? 'Fix' : 'Ok'}`];
  // handled only after the action worked: a failed OK or send stays waiting (with the reason) and is tried again the
  // next time the tablet's files change or the service starts, instead of being lost
  try {
    if (fn) await fn(ref);
    setTablet(root, id, kind, ref, { handled: true, status: 'done', notes: notes.length, failed: null });
  } catch (err) {
    console.error(`video notes: ${imported.length ? 'sending the notes' : 'approving'} for ${kind} ${ref}: ${err.message}`);
    setTablet(root, id, kind, ref, { status: 'done', notes: notes.length, failed: String(err.message || err).slice(0, 300) });
  }
}

// A note's snapshot (a file name the tablet app wrote into the shared notes.json): read only when its real path is
// inside that video's own folder, so "../../.ssh/id_rsa" or a link out of the folder is never read.
function snapOf(dir, snap) {
  if (!snap) return null;
  try {
    const top = realpathSync(dir);
    const real = realpathSync(resolve(top, String(snap)));
    return isInside(top, real) && real !== top && statSync(real).isFile() ? readFileSync(real).toString('base64') : null;
  } catch { return null; }
}

// The owner approved or fixed the thing in the app first: tell the tablet (the same status.json the app writes) so it stops
// showing it as waiting, and stop watching it. Idempotent. Notes still on the tablet at that moment are left there.
// `ref` is a scene's beat (b03), a frame (sf01) or a still; `kind` narrows it when the same ref could be two things.
export function closeOnApp(root, id, ref, kind = null) {
  try {
    const cfg = vnConfig(root);
    const e = tabletEntries(root, id).find((x) => x.ref === ref && (!kind || x.kind === kind) && x.t.id && !x.t.handled);
    if (!e) return false;
    setTablet(root, id, e.kind, e.ref, { handled: true, status: 'done', closed_in_app: true });
    const f = join(cfg.folder, e.t.id, 'status.json');
    if (existsSync(join(cfg.folder, e.t.id)) && readJson(f, {}).status !== 'done') writeAtomic(f, { status: 'done', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    return true;
  } catch { return false; }
}

export const _test = { sig };
