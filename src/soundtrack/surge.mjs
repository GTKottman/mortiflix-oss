// Surge XT parts (owner, 2026-10-23: better sounds, all open source). An instrument pack can give a part a Surge XT
// patch ({ source: "surge", patch: "Keys/…", sound: <a Strudel stand-in> }). Strudel renders the stand-in as usual (so
// the audition, the levels and the checks all run as before), then the engine plays the part's captured MIDI
// (music/notes.json) through Surge XT with that patch, the Surge stem replaces the stand-in's at the stand-in's level
// (RMS, peaks kept under -3 dBFS), and the score is the stems summed again. The stand-in stem is kept beside it.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, levelOf, db } from '../../pipelines/_shared/skills/music/lib/wav.mjs';
import { exec } from '../quickmusic.mjs';
import { enginePaths } from '../daw-engine.mjs';

const RATE = 48000;
const PEAK_MAX = -3;

// Where Surge XT lives: $MFX_SURGE, else the studio's tools/surge-xt (the release unpacked: lib/vst3, share/surge-xt).
export function surgePaths(root) {
  const dir = process.env.MFX_SURGE || join(root, 'tools', 'surge-xt');
  return { dir, vst3: join(dir, 'lib', 'vst3', 'Surge XT.vst3'), patches: [join(dir, 'share', 'surge-xt', 'patches_factory'), join(dir, 'share', 'surge-xt', 'patches_3rdparty')] };
}

// A patch named "Keys/Rhodes" (its folder and name under the factory or third-party patches, without .fxp).
export function surgePatch(root, name) {
  for (const base of surgePaths(root).patches) {
    const f = join(base, `${String(name).replace(/\.fxp$/i, '')}.fxp`);
    if (existsSync(f)) return f;
  }
  return null;
}

// Every patch Surge XT brings, as "Category/Name" (the factory's first).
export function surgeCatalog(root) {
  const out = [];
  for (const base of surgePaths(root).patches) {
    if (!existsSync(base)) continue;
    const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`); else if (/\.fxp$/i.test(e.name)) out.push(`${rel}${e.name.slice(0, -4)}`); } };
    walk(base, '');
  }
  return out;
}

function writeWav16(file, channels) {
  const frames = channels[0].length;
  const b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + frames * 4, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(frames * 4, 40);
  const [l, r] = [channels[0], channels[1] || channels[0]];
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  writeFileSync(file, b);
}

// The engine's song for one part: one channel playing Surge XT with the patch, the part's notes from bar 1.
function songFor({ bp, part, notes, vst3, patch, frames }) {
  const bpb = Number(String(bp.meter || '4/4').split('/')[0]);
  return {
    sampleRate: RATE,
    tempo: [{ tick: 0, bpm: bp.bpm }],
    meter: [{ tick: 0, num: bpb, den: Number(String(bp.meter || '4/4').split('/')[1]) || 4 }],
    channels: [{ id: 'surge', name: part.role, kind: 'pitched', instrument: { kind: 'vst3', path: vst3, surgePatch: patch }, volDb: 0, pan: 0 }],
    patterns: [{ id: 'part', notes: { surge: notes.map((n) => ({ key: n.pitch, t: Math.round(n.start * 960), len: Math.max(1, Math.round(n.dur * 960)), vel: n.velocity ?? 0.8 })) } }],
    // as long as the Strudel stem (its tail too): the engine renders nothing past the song's end
    playlist: { items: [{ kind: 'pattern', ref: 'part', at: { tick: 0 }, len: Math.max(bp.bars * bpb * 960, Math.ceil(frames / RATE * bp.bpm / 60 * 960)) }] },
    mixer: { master: { volDb: 0 }, inserts: [] },
  };
}

// Render every Surge part of instruments.json into its stem, then the score again from the stems. Returns what was
// done per part ({ role, patch, rms_db, peak_db, gain_db }), or [] when no part uses Surge.
export async function surgeStems({ root, work, inst, bp, env = process.env, log = () => {} }) {
  const parts = inst.parts.filter((p) => p.surge?.patch);
  if (!parts.length) return [];
  const { vst3 } = surgePaths(root);
  if (!existsSync(vst3)) throw new Error(`Surge XT isn't in ${surgePaths(root).dir} (lib/vst3/Surge XT.vst3)`);
  const bin = env.MFX_DAW_ENGINE || enginePaths(root).bin;
  if (!existsSync(bin)) throw new Error('the sound engine is not installed (mortiflix setup daw-engine)');
  const captured = JSON.parse(readFileSync(join(work, 'music', 'notes.json'), 'utf8'));
  const stems = join(work, 'out', 'music', 'stems');
  const done = [];
  for (const part of parts) {
    const patch = surgePatch(root, part.surge.patch);
    if (!patch) throw new Error(`no Surge XT patch "${part.surge.patch}"`);
    const track = captured.tracks.find((t) => t.channel === part.channel);
    const stem = readdirSync(stems).find((f) => f.startsWith(`${String(part.channel).padStart(2, '0')}-`) && f.endsWith('.wav') && !f.endsWith('.standin.wav'));
    if (!track || !stem) continue;
    const standin = readWav(join(stems, stem));
    const dir = join(work, 'music', 'surge', String(part.channel).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song.json'), JSON.stringify(songFor({ bp, part, notes: track.notes, vst3, patch, frames: standin.channels[0].length }), null, 1));
    // the same length as the Strudel stem, so the stems still line up and sum
    writeFileSync(join(dir, 'render.json'), JSON.stringify({ rate: RATE, threads: 4, fromSample: 0, toSample: standin.channels[0].length }));
    const r = await exec(bin, ['--render', join(dir, 'song.json'), '--settings', join(dir, 'render.json'), '--out', dir], { cwd: dir, env, timeout: 10 * 60_000 });
    if (r.code !== 0 || !existsSync(join(dir, 'mix-f32.wav'))) throw new Error(`Surge XT render of ${part.role} (${part.surge.patch}): ${r.out.slice(-400)}`);
    const wav = readWav(join(dir, 'mix-f32.wav'));
    const want = levelOf(standin); const got = levelOf(wav);
    if (got.peak_db < -80) throw new Error(`Surge XT played ${part.role} silent with "${part.surge.patch}"`);
    // the stand-in's level (its RMS), never past PEAK_MAX
    const gainDb = Math.min(want.rms_db - got.rms_db, PEAK_MAX - got.peak_db);
    const k = 10 ** (gainDb / 20);
    const chans = [0, 1].map((c) => { const src = wav.channels[c] || wav.channels[0]; const o = new Float32Array(standin.channels[0].length); for (let i = 0; i < o.length && i < src.length; i++) o[i] = src[i] * k; return o; });
    if (!existsSync(join(stems, stem.replace(/\.wav$/, '.standin.wav')))) renameSync(join(stems, stem), join(stems, stem.replace(/\.wav$/, '.standin.wav')));
    writeWav16(join(stems, stem), chans);
    const lv = levelOf(readWav(join(stems, stem)));
    done.push({ channel: part.channel, role: part.role, patch: part.surge.patch, gain_db: +gainDb.toFixed(1), standin_rms_db: want.rms_db, ...lv });
    log(`surge: ${part.role} played by Surge XT "${part.surge.patch}" (rms ${lv.rms_db} dB, peak ${lv.peak_db} dBFS; the stand-in was ${want.rms_db} dB)`);
  }
  // the score again: every stem summed
  const all = readdirSync(stems).filter((f) => /^\d\d-.*\.wav$/.test(f) && !f.endsWith('.standin.wav')).map((f) => readWav(join(stems, f)));
  const frames = Math.max(...all.map((w) => w.channels[0].length));
  const sum = [new Float32Array(frames), new Float32Array(frames)];
  for (const w of all) for (const c of [0, 1]) { const src = w.channels[c] || w.channels[0]; for (let i = 0; i < src.length; i++) sum[c][i] += src[i]; }
  writeWav16(join(work, 'out', 'music', 'score.wav'), sum);
  log(`surge: score summed again from ${all.length} stems (peak ${db(Math.max(...sum.map((ch) => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))).toFixed(1)} dBFS)`);
  return done;
}
