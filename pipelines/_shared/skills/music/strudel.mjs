#!/usr/bin/env node
// The music skill's tool: check a Strudel cue against its blueprint and the picture, render it, export MIDI.
//
//   node strudel.mjs check  [music/score.strudel.js] [--blueprint music/blueprint.json] [--video-sec 120] [--fps 30]
//   node strudel.mjs render [score] [--out out/music/score.wav] [--stems] [--tail-bars 1]
//   node strudel.mjs midi   [score] [--out out/music/midi]
//
// `check` must pass (0 errors) before a render goes to the owner: the score's own checks, the harmony lock against the
// chart, every hit point within a frame of the picture, and the intensity curve following the sections' asks.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { HeadlessStrudel } from './lib/headless.mjs';
import { hapsToChannels, checkBlueprint, checkScore, intensity, intensityChart, beatsPerBar, timeOf } from './lib/score.mjs';
import { checkHarmony } from './lib/harmony.mjs';
import { writeMidi } from './lib/midi.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2); return v === undefined || v.startsWith('--') ? true : v; };
const blueprintPath = opt('blueprint', 'music/blueprint.json');
const out = opt('out', null);
const videoSec = Number(opt('video-sec', 0)) || null;
const fps = Number(opt('fps', 30));
const stems = Boolean(opt('stems', false));
const tailBars = Number(opt('tail-bars', 1));
const scorePath = args[0] || 'music/score.strudel.js';

const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
if (!['check', 'render', 'midi'].includes(cmd)) die('usage: strudel.mjs check|render|midi [score] (see SKILL.md)');
if (!existsSync(scorePath)) die(`no score at ${scorePath}`);
if (!existsSync(blueprintPath)) die(`no blueprint at ${blueprintPath} (write it first: SKILL.md step 3)`);
const code = readFileSync(scorePath, 'utf8');
let bp;
try { bp = JSON.parse(readFileSync(blueprintPath, 'utf8')); } catch (e) { die(`${blueprintPath}: ${e.message}`); }
const bpErrors = checkBlueprint(bp);
if (bpErrors.length) die(bpErrors.join('\n  '));
const bpb = beatsPerBar(bp.meter || '4/4');
const names = Object.fromEntries((bp.roles || []).map((r) => [r.channel, r.name]));

const strudel = await new HeadlessStrudel().start().catch((e) => die(e.message));
try {
  // A bar past the end catches parts that keep looping after the ending.
  const { cps, haps } = await strudel.haps(code, bp.bars + 1);
  const channels = hapsToChannels({ haps, cps, beatsPerCycle: bpb, names });

  if (cmd === 'check') {
    const score = checkScore(channels, bp, { video_sec: videoSec, fps });
    const endBeat = bp.bars * bpb;
    const manifest = { bpm: channels.bpm, meter: bp.meter || '4/4', beats_per_bar: bpb, bars: bp.bars,
      tracks: channels.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => n.start < endBeat) })) };
    const harmony = checkHarmony(manifest, bp);
    const curve = intensity(manifest, bp);
    const errors = [...score.errors, ...harmony.errors, ...curve.problems];
    const report = { ok: errors.length === 0, errors, warnings: score.warnings, seconds: score.seconds, hits: score.hits, intensity: curve.sections,
      parts: manifest.tracks.map((t) => ({ channel: t.channel, name: t.name, notes: t.notes.length, velocity_range: t.notes.length ? [Math.min(...t.notes.map((n) => n.velocity)), Math.max(...t.notes.map((n) => n.velocity))] : null })) };
    mkdirSync('music', { recursive: true });
    writeFileSync(join(dirname(blueprintPath), 'check.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`${bp.title || basename(scorePath)}: ${bp.bars} bars at ${bp.bpm} BPM (${bp.meter || '4/4'}) = ${score.seconds}s${bp.offset_sec ? `, starting ${bp.offset_sec}s into the video` : ''}`);
    console.log(`Parts: ${report.parts.map((p) => `${p.name} (${p.notes})`).join(', ')}`);
    console.log(`\nIntensity (asked vs measured, one block per bar):\n${intensityChart(curve)}`);
    if (score.hits.length) console.log(`\nHits:\n${score.hits.map((h) => `  ${h.ok ? '✔' : '✖'} ${String(h.t_sec).padStart(7)}s  bar ${h.bar} beat ${h.beat ?? 1} → ${h.music_sec}s (${h.off_sec >= 0 ? '+' : ''}${h.off_sec}s)  ${h.kind || 'direct'}: ${h.what}`).join('\n')}`);
    for (const w of score.warnings) console.log(`\n! ${w}`);
    if (errors.length) { console.log(`\n✖ ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n  ${errors.join('\n  ')}`); process.exitCode = 1; }
    else console.log('\n✔ Check passed: harmony locked, hits on the picture, the curve follows the story.');
  }

  if (cmd === 'render') {
    const file = out || 'out/music/score.wav';
    mkdirSync(dirname(file), { recursive: true });
    const cycles = bp.bars + Math.max(0, tailBars);
    await strudel.render(code, cycles, file);
    console.log(`✔ ${file} (${bp.bars} bars + ${tailBars} bar tail)`);
    if (stems) {
      const dir = join(dirname(file), 'stems');
      mkdirSync(dir, { recursive: true });
      for (const t of channels.tracks) {
        const f = join(dir, `${String(t.channel).padStart(2, '0')}-${t.name.replace(/[^\w-]+/g, '-').toLowerCase()}.wav`);
        await strudel.render(code, cycles, f, { channel: t.channel });
        console.log(`  ✔ ${f}`);
      }
    }
  }

  if (cmd === 'midi') {
    const dir = out || 'out/music/midi';
    mkdirSync(dir, { recursive: true });
    const endBeat = bp.bars * bpb;
    const tracks = channels.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => n.start < endBeat) })).filter((t) => t.notes.length);
    const markers = [...(bp.sections || []).map((s) => ({ beat: (s.start_bar - 1) * bpb, text: s.name })),
      ...(bp.hits || []).map((h) => ({ beat: (h.bar - 1) * bpb + ((h.beat ?? 1) - 1), text: `HIT ${h.what}` }))];
    const slug = (s) => String(s).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    writeFileSync(join(dir, `${slug(bp.title || 'cue')}-all.mid`), writeMidi({ bpm: bp.bpm, meter: bp.meter || '4/4', tracks, markers }));
    for (const t of tracks) writeFileSync(join(dir, `${String(t.channel).padStart(2, '0')}-${slug(t.name)}.mid`), writeMidi({ bpm: bp.bpm, meter: bp.meter || '4/4', tracks: [t], markers }));
    const sheet = [`# ${bp.title || 'Cue'}: cue sheet`, '', `${bp.bpm} BPM, ${bp.meter || '4/4'}, ${bp.scale || ''}, ${bp.bars} bars. Bar 1 starts ${bp.offset_sec || 0}s into the video.`, '',
      '## Sections', '', '| Bars | Starts at | Section | What it does | Intensity |', '|---|---|---|---|---|',
      ...(bp.sections || []).map((s) => `| ${s.start_bar}-${s.end_bar} | ${timeOf(bp, s.start_bar).toFixed(2)}s | ${s.name} | ${s.function} | ${s.intensity} |`),
      '', '## Hit points', '', '| Video time | Bar.beat | How | What |', '|---|---|---|---|',
      ...(bp.hits || []).map((h) => `| ${h.t_sec}s | ${h.bar}.${h.beat ?? 1} | ${h.kind || 'direct'} | ${h.what} |`),
      '', '## Parts', '', '| Channel | Part | Role | Its job |', '|---|---|---|---|',
      ...(bp.roles || []).map((r) => `| ${r.channel} | ${r.name} | ${r.harmony} | ${r.job || ''} |`),
      '', `Chord chart: ${(bp.chart || []).map((c) => `bars ${c.bars[0]}-${c.bars[1]}: ${c.chords.map((x) => (Array.isArray(x) ? `[${x.join(' ')}]` : x)).join(' ')}`).join('; ')}`, ''];
    writeFileSync(join(dir, 'CUE-SHEET.md'), sheet.join('\n'));
    console.log(`✔ ${dir}: ${tracks.length} part${tracks.length === 1 ? '' : 's'} + the full arrangement + CUE-SHEET.md (tempo, sections and hits are markers in every file)`);
  }
} catch (e) {
  die(e.message);
} finally {
  await strudel.close();
}
