#!/usr/bin/env node
// The music engine. One command per stage; each reads the files the stage before it wrote, checks its own work, and
// writes down what it found, so the whole piece can be followed from the brief to the master (music/MUSIC-SHEET.md).
//
//   node strudel.mjs genre                       music/genre.json → checked, music/GENRE.md            (songs)
//   node strudel.mjs plan                        music/blueprint.json → checked, music/BLUEPRINT.md
//   node strudel.mjs check [--video-sec S --fps F]  the score → harmony lock, story curve, hits; its MIDI:
//                                                music/notes.json + out/music/midi/ (every channel, the arrangement) + midi.zip
//   node strudel.mjs instruments                 the sound of every channel (music/instruments.json), checked against
//                                                the MIDI; with no file yet, lists the sounds and each channel's range
//   node strudel.mjs audition                    every instrument plays its part's lowest, middle and highest note
//   node strudel.mjs render [--stems] [--out f]  score + instruments → out/music/score.wav (+ out/music/stems/)
//   node strudel.mjs master                      render + stems + loudness → out/music/master.wav, master.mp3 (songs)
//   node strudel.mjs own-master                  the owner's own master (imported from their DAW): is it there, does it fit
//   node strudel.mjs midi                        out/music/midi/ again, with CUE-SHEET.md
//   node strudel.mjs sheet                       rewrites music/MUSIC-SHEET.md from whatever exists
//
// Every command but sheet exits 1 when its stage isn't right yet, with the problems in plain words.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hapsToChannels, checkBlueprint, checkScore, intensity, intensityChart, beatsPerBar, timeOf } from './lib/score.mjs';
import { checkHarmony, noteName } from './lib/harmony.mjs';
import { writeMidi } from './lib/midi.mjs';
import { profileProblems, profileMarkdown, signatureProblems, fmtSec } from './lib/genre.mjs';
import { SYNTHS, checkInstruments, instrumentCode, auditionCode, auditionNotes, registers, registerLine } from './lib/instruments.mjs';
import { readWav, levelOf, mixBalance } from './lib/wav.mjs';
import { masterTo, TARGET } from './lib/master.mjs';
import { zip, dirEntries } from './lib/zip.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2); return v === undefined || v.startsWith('--') ? true : v; };
const F = {
  genre: 'music/genre.json', blueprint: opt('blueprint', 'music/blueprint.json'), instruments: 'music/instruments.json',
  notes: 'music/notes.json', check: 'music/check.json', audition: 'music/audition.json', master: 'music/master.json',
  own: 'music/own-master/report.json', sheet: 'music/MUSIC-SHEET.md',
};
const out = opt('out', null);
const videoSec = Number(opt('video-sec', 0)) || null;
const fps = Number(opt('fps', 30));
const stems = Boolean(opt('stems', false));
const tailBars = Number(opt('tail-bars', 1));
const scorePath = args[0] || 'music/score.strudel.js';
const COMMANDS = ['genre', 'plan', 'check', 'instruments', 'audition', 'render', 'master', 'own-master', 'midi', 'sheet'];

const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (!existsSync(f)) return null; die(`${f}: ${e.message}`); } };
const write = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); };
const slug = (s) => String(s).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const fail = (problems, what) => { console.log(`\n✖ ${problems.length} problem${problems.length === 1 ? '' : 's'}${what ? ` ${what}` : ''}:\n  ${problems.join('\n  ')}`); process.exitCode = 1; };
if (!COMMANDS.includes(cmd)) die(`usage: strudel.mjs ${COMMANDS.join('|')} (see SKILL.md)`);

// ---- stages that need no Strudel ----

if (cmd === 'sheet') { writeSheet(); console.log(`✔ ${F.sheet}`); process.exit(0); }

if (cmd === 'genre') {
  const g = read(F.genre); if (!g) die(`no ${F.genre} yet (the genre step writes it: SKILL.md, "The genre")`);
  const problems = profileProblems(g);
  write('music/GENRE.md', profileMarkdown(g));
  console.log(`${g.name}: ${g.tempo?.min}-${g.tempo?.max} BPM, ${(g.meters || []).join(', ')}, ${g.length ? `${fmtSec(g.length.min_sec)}-${fmtSec(g.length.max_sec)}` : '?'} long, ${(g.unforgettable || []).length} unforgettable elements, ${(g.sources || []).length} sources`);
  if (problems.length) fail(problems, 'in the genre profile'); else console.log('✔ The genre profile is complete. music/GENRE.md is the readable version.');
  writeSheet(); process.exit();
}

const bp = read(F.blueprint);
if (!bp) die(`no blueprint at ${F.blueprint} (write it first: SKILL.md, "The blueprint")`);
const bpb = (() => { try { return beatsPerBar(bp.meter || '4/4'); } catch (e) { return die(`${F.blueprint}: ${e.message}`); } })();
const seconds = +(bp.bars * bpb * 60 / bp.bpm).toFixed(3);
const names = Object.fromEntries((bp.roles || []).map((r) => [r.channel, r.name]));

if (cmd === 'plan') {
  const genre = read(F.genre);
  const problems = [...checkBlueprint(bp)];
  if (genre) {
    problems.push(...signatureProblems(bp.genre_signature, genre).map((p) => `blueprint.json: ${p}`));
    const L = genre.length;
    if (L && !bp.length_fixed && (seconds < L.min_sec * 0.9 || seconds > L.max_sec * 1.1)) problems.push(`blueprint.json: the piece runs ${fmtSec(seconds)} (${bp.bars} bars at ${bp.bpm} BPM) but ${genre.name} tracks run ${fmtSec(L.min_sec)}-${fmtSec(L.max_sec)}: change "bars" and the sections (or set "length_fixed": true when the brief fixed the length)`);
  }
  if (bp.style !== undefined && String(bp.style).length > 1000) problems.push(`blueprint.json: "style" is ${String(bp.style).length} characters; keep it within 1000`);
  for (const r of bp.roles || []) if (!Number.isInteger(r.channel) || r.channel < 1 || r.channel > 16) problems.push(`blueprint.json: role "${r.name}" needs a channel 1-16 (drums on 10)`);
  if (new Set((bp.roles || []).map((r) => r.channel)).size !== (bp.roles || []).length) problems.push('blueprint.json: two roles share a channel; every part gets its own');
  write('music/BLUEPRINT.md', blueprintMarkdown(bp, genre));
  console.log(`${bp.title || 'Untitled'}: ${bp.bars} bars at ${bp.bpm} BPM (${bp.meter || '4/4'}) = ${fmtSec(seconds)}, ${bp.scale}, ${(bp.roles || []).length} parts, ${(bp.sections || []).length} sections`);
  if (problems.length) fail(problems, 'in the plan'); else console.log('✔ The plan holds together. music/BLUEPRINT.md is the readable version.');
  writeSheet(); process.exit();
}

if (cmd === 'instruments') {
  const notes = read(F.notes); if (!notes) die(`no ${F.notes}: run \`strudel.mjs check\` first (it captures the score's MIDI)`);
  const inst = read(F.instruments);
  const regs = registers(notes);
  console.log(`Where each channel plays (from the MIDI):\n  ${regs.map(registerLine).join('\n  ')}`);
  if (!inst) {
    console.log(`\nBuilt-in sounds (no downloads, no licence questions):\n  ${Object.entries(SYNTHS).map(([k, v]) => `${k.padEnd(9)} ${v.what}`).join('\n  ')}`);
    console.log(`\nShape any of them with "set": filters (.lpf .hpf .lpq .lpenv), envelopes (.attack .decay .sustain .release), FM (.fm .fmh),\n.vib, .penv (pitch envelope, for drums), .shape/.distort, .crush/.coarse (lo-fi), .room/.size, .delay/.delaytime/.delayfeedback.`);
    die(`no ${F.instruments} yet: choose a sound for every channel above (SKILL.md, "Instruments")`);
  }
  const r = checkInstruments(inst, notes);
  write('music/instruments-check.json', { ok: !r.errors.length, errors: r.errors, warnings: r.warnings, registers: r.registers });
  console.log(`\nInstruments (${inst.concept || ''}):\n  ${inst.parts.map((p) => `ch ${String(p.channel).padStart(2)} ${p.role || ''}: ${p.kit ? `kit ${Object.entries(p.kit).map(([k, v]) => `${k}=${v.sound}`).join(' ')}` : `${p.sound}${p.set || ''}`}  gain ${p.gain ?? 0.8} pan ${p.pan ?? 0}`).join('\n  ')}`);
  for (const w of r.warnings) console.log(`! ${w}`);
  if (r.errors.length) fail(r.errors, 'with the instruments'); else console.log('\n✔ Every channel has an instrument that fits it. Next: `strudel.mjs audition`.');
  writeSheet(); process.exit();
}

if (cmd === 'own-master') {
  const rep = read(F.own);
  if (!rep) die('No master from the owner yet. They make it from the MIDI pack and import it on the project page (Music › Import your master) or with `mortiflix music <project> --import <file>`.');
  console.log(`The owner's master: ${rep.source} (${rep.measured.seconds} s, ${rep.measured.lufs} LUFS, true peak ${rep.measured.true_peak} dBTP), imported ${rep.imported_at}`);
  for (const w of rep.warnings || []) console.log(`! ${w}`);
  if (rep.errors?.length) fail(rep.errors, 'with the owner\'s master'); else console.log(`✔ Use ${rep.file} as the music (it starts at bar 1 of the score).`);
  writeSheet(); process.exit();
}

// ---- stages that run Strudel (headless Chrome) ----

if (!existsSync(scorePath)) die(`no score at ${scorePath}`);
const bpErrors = checkBlueprint(bp);
if (bpErrors.length) die(bpErrors.join('\n  '));
const code = readFileSync(scorePath, 'utf8');
const inst = read(F.instruments);
const playable = () => (inst ? code + '\n' + instrumentCode(inst) : code);
const { HeadlessStrudel } = await import('./lib/headless.mjs');
const strudel = await new HeadlessStrudel().start().catch((e) => die(e.message));
try {
  if (cmd === 'check' || cmd === 'midi') {
    // A bar past the end catches parts that keep looping after the ending.
    const { cps, haps } = await strudel.haps(code, bp.bars + 1);
    const channels = hapsToChannels({ haps, cps, beatsPerCycle: bpb, names });
    const endBeat = bp.bars * bpb;
    const manifest = { title: bp.title || null, bpm: channels.bpm, meter: bp.meter || '4/4', beats_per_bar: bpb, bars: bp.bars,
      tracks: channels.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => n.start < endBeat) })) };
    if (cmd === 'check') {
      const score = checkScore(channels, bp, { video_sec: videoSec, fps });
      const harmony = checkHarmony(manifest, bp);
      const curve = intensity(manifest, bp);
      const errors = [...score.errors, ...harmony.errors, ...curve.problems];
      const report = { ok: errors.length === 0, errors, warnings: score.warnings, seconds: score.seconds, hits: score.hits, intensity: curve.sections,
        parts: manifest.tracks.map((t) => ({ channel: t.channel, name: t.name, notes: t.notes.length, velocity_range: t.notes.length ? [Math.min(...t.notes.map((n) => n.velocity)), Math.max(...t.notes.map((n) => n.velocity))] : null })) };
      write(F.check, report);
      console.log(`${bp.title || scorePath}: ${bp.bars} bars at ${bp.bpm} BPM (${bp.meter || '4/4'}) = ${score.seconds}s${bp.offset_sec ? `, starting ${bp.offset_sec}s into the video` : ''}`);
      console.log(`Parts: ${report.parts.map((p) => `${p.name} (${p.notes})`).join(', ')}`);
      console.log(`\nIntensity (asked vs measured, one block per bar):\n${intensityChart(curve)}`);
      if (score.hits.length) console.log(`\nHits:\n${score.hits.map((h) => `  ${h.ok ? '✔' : '✖'} ${String(h.t_sec).padStart(7)}s  bar ${h.bar} beat ${h.beat ?? 1} → ${h.music_sec}s (${h.off_sec >= 0 ? '+' : ''}${h.off_sec}s)  ${h.kind || 'direct'}: ${h.what}`).join('\n')}`);
      for (const w of score.warnings) console.log(`\n! ${w}`);
      if (errors.length) fail(errors);
      else {
        // The score passed: its MIDI is the music from here on. Instruments are chosen from it; any DAW can play it.
        write(F.notes, manifest);
        const files = writeMidiPack(manifest, out || 'out/music/midi');
        console.log(`\n✔ Check passed: harmony locked, the curve follows the story${bp.hits?.length ? ', hits on the picture' : ''}.`);
        console.log(`✔ MIDI: ${F.notes} and ${files} (every channel, the whole arrangement, CUE-SHEET.md).`);
        console.log(`  Where each channel plays:\n  ${registers(manifest).map(registerLine).join('\n  ')}`);
      }
    } else {
      console.log(`✔ ${writeMidiPack(manifest, out || 'out/music/midi')}: every channel, the arrangement, CUE-SHEET.md (tempo, sections and hits are markers in every file)`);
    }
  }

  if (cmd === 'audition') {
    const notes = read(F.notes); if (!notes) die(`no ${F.notes}: run \`strudel.mjs check\` first`);
    if (!inst) die(`no ${F.instruments}: choose the instruments first (\`strudel.mjs instruments\`)`);
    const r = checkInstruments(inst, notes);
    if (r.errors.length) die(`the instruments don't pass their check yet:\n  ${r.errors.join('\n  ')}`);
    const dir = out || 'out/music/audition'; mkdirSync(dir, { recursive: true });
    const auditionSrc = auditionCode(inst, r.registers);
    const results = []; const problems = [];
    for (const reg of r.registers) {
      const ns = auditionNotes(reg); const file = join(dir, `${String(reg.channel).padStart(2, '0')}-${slug(reg.name)}.wav`);
      await strudel.render(auditionSrc, ns.length, file, { channel: reg.channel });
      const wav = readWav(file); const bar = 2; // 120 BPM, 4/4: one note per 2-second bar
      const each = ns.map((n, i) => ({ note: reg.kind === 'drums' ? `GM ${n}` : noteName(n), ...levelOf(wav, i * bar, i * bar + 0.6) }));
      // Silence is judged by peak: a short hat is quiet on average but clearly there.
      const silent = each.filter((x) => x.peak_db < -50); const loud = each.filter((x) => x.peak_db > -0.3);
      const part = inst.parts.find((p) => p.channel === reg.channel);
      results.push({ channel: reg.channel, name: reg.name, file, notes: each, ok: !silent.length && !loud.length });
      console.log(`${silent.length || loud.length ? '✖' : '✔'} ch ${String(reg.channel).padStart(2)} ${reg.name}: ${each.map((x) => `${x.note} peak ${x.peak_db} rms ${x.rms_db}`).join(' · ')}  → ${file}`);
      for (const x of silent) problems.push(`ch ${reg.channel} (${reg.name}): ${x.note} is silent (peak ${x.peak_db} dBFS) on ${part.kit ? part.kit[x.note.replace('GM ', '')]?.sound : part.sound}: choose another sound or shorten the attack; a very low note can fall below what a filter lets through`);
      for (const x of loud) problems.push(`ch ${reg.channel} (${reg.name}): ${x.note} peaks at ${x.peak_db} dBFS on its own: lower its "gain"`);
    }
    write(F.audition, { ok: !problems.length, problems, parts: results });
    if (problems.length) fail(problems, 'in the audition'); else console.log('\n✔ Every instrument sounds across its whole range. Listen to the files to judge the sounds themselves.');
  }

  if (cmd === 'render' || cmd === 'master') {
    const file = cmd === 'master' ? 'out/music/mix.wav' : out || 'out/music/score.wav';
    mkdirSync(dirname(file), { recursive: true });
    const cycles = bp.bars + Math.max(0, tailBars);
    await strudel.render(playable(), cycles, file);
    console.log(`✔ ${file} (${bp.bars} bars + ${tailBars} bar tail${inst ? ', with music/instruments.json' : ', with the sounds written in the score'})`);
    const stemReport = [];
    if (stems || cmd === 'master') {
      const notes = read(F.notes);
      const chans = notes ? notes.tracks.map((t) => [t.channel, t.name]) : Object.entries(names).map(([c, n]) => [Number(c), n]);
      const dir = join(dirname(file), 'stems'); mkdirSync(dir, { recursive: true });
      for (const [ch, name] of chans) {
        const f = join(dir, `${String(ch).padStart(2, '0')}-${slug(name)}.wav`);
        await strudel.render(playable(), cycles, f, { channel: ch });
        const lv = levelOf(readWav(f)); stemReport.push({ channel: ch, name, file: f, ...lv });
        console.log(`  ✔ ${f}  (rms ${lv.rms_db} dB, peak ${lv.peak_db} dBFS)`);
      }
    }
    if (cmd === 'master') {
      const problems = [];
      for (const s of stemReport) if (s.peak_db > -0.3) problems.push(`${s.name} (ch ${s.channel}) peaks at ${s.peak_db} dBFS on its own: lower its "gain" in instruments.json`);
      for (const s of stemReport) if (s.peak_db < -50) problems.push(`${s.name} (ch ${s.channel}) is silent in the mix (peak ${s.peak_db} dBFS)`);
      const balance = mixBalance(readWav(file));
      const m = masterTo(file, 'out/music/master.wav');
      if (m.after.true_peak !== null && m.after.true_peak > TARGET.tp + 0.2) problems.push(`the master peaks at ${m.after.true_peak} dBTP (limit ${TARGET.tp}): lower the loudest parts and master again`);
      if (m.after.lufs !== null && Math.abs(m.after.lufs - TARGET.lufs) > 1) problems.push(`the master is ${m.after.lufs} LUFS (target ${TARGET.lufs} ± 1): the mix's peaks are holding it down; lower the loudest, peakiest parts`);
      write(F.master, { ok: !problems.length, problems, target: TARGET, mix: { file, before: m.before, balance }, master: { wav: m.wav, mp3: m.mp3, ...m.after }, stems: stemReport });
      console.log(`\nMix balance (measured): low end ${balance.lowPct}%, mud ${balance.mudPct}%, width ${balance.widthDb} dB`);
      for (const n of balance.notes) console.log(`! ${n}`);
      console.log(`Master: ${m.before.lufs} → ${m.after.lufs} LUFS, true peak ${m.after.true_peak} dBTP, ${m.after.seconds} s → ${m.wav}, ${m.mp3}`);
      if (problems.length) fail(problems, 'in the mix'); else console.log('✔ Mastered to the delivery level. These are measurements, not listening: listen to the master before you submit it.');
    }
  }
} catch (e) {
  die(e.message);
} finally {
  await strudel.close();
  try { writeSheet(); } catch { /* the sheet never blocks a stage */ }
}

// ---- the MIDI pack ----

function writeMidiPack(manifest, dir) {
  mkdirSync(dir, { recursive: true });
  const tracks = manifest.tracks.filter((t) => t.notes.length);
  const markers = [...(bp.sections || []).map((s) => ({ beat: (s.start_bar - 1) * bpb, text: s.name })),
    ...(bp.hits || []).map((h) => ({ beat: (h.bar - 1) * bpb + ((h.beat ?? 1) - 1), text: `HIT ${h.what}` }))];
  writeFileSync(join(dir, `${slug(bp.title || 'music')}-all.mid`), writeMidi({ bpm: bp.bpm, meter: bp.meter || '4/4', tracks, markers }));
  for (const t of tracks) writeFileSync(join(dir, `${String(t.channel).padStart(2, '0')}-${slug(t.name)}.mid`), writeMidi({ bpm: bp.bpm, meter: bp.meter || '4/4', tracks: [t], markers }));
  const sheet = [`# ${bp.title || 'Music'}: cue sheet`, '',
    `${bp.bpm} BPM, ${bp.meter || '4/4'}, ${bp.scale || ''}, ${bp.bars} bars (${fmtSec(seconds)}).${bp.offset_sec !== undefined ? ` Bar 1 starts ${bp.offset_sec}s into the video.` : ''}`, '',
    'To finish it in your own DAW: import the arrangement file (or one file per part), set the tempo above, put bar 1 at',
    'the start, give every channel its sound, mix, and export from bar 1 to the end (a reverb tail after it is fine).', '',
    '## Sections', '', '| Bars | Starts at | Section | What it does | Intensity |', '|---|---|---|---|---|',
    ...(bp.sections || []).map((s) => `| ${s.start_bar}-${s.end_bar} | ${timeOf(bp, s.start_bar).toFixed(2)}s | ${s.name} | ${s.function} | ${s.intensity} |`),
    ...(bp.hits?.length ? ['', '## Hit points', '', '| Video time | Bar.beat | How | What |', '|---|---|---|---|', ...bp.hits.map((h) => `| ${h.t_sec}s | ${h.bar}.${h.beat ?? 1} | ${h.kind || 'direct'} | ${h.what} |`)] : []),
    '', '## Channels', '', '| Channel | Part | Role | Its job | Range | Sound in the studio |', '|---|---|---|---|---|---|',
    ...(bp.roles || []).map((r) => { const t = manifest.tracks.find((x) => x.channel === r.channel); const reg = t ? registers({ tracks: [t] })[0] : null; const p = inst?.parts?.find((x) => x.channel === r.channel);
      return `| ${r.channel} | ${r.name} | ${r.harmony} | ${r.job || ''} | ${reg ? (reg.kind === 'drums' ? `GM ${reg.drums.join(' ')}` : `${noteName(reg.lowest)}-${noteName(reg.highest)}`) : 'silent'} | ${p ? (p.kit ? 'synth kit' : `${p.sound}${p.set || ''}`) : r.sound || ''} |`; }),
    '', `Chord chart: ${(bp.chart || []).map((c) => `bars ${c.bars[0]}-${c.bars[1]}: ${c.chords.map((x) => (Array.isArray(x) ? `[${x.join(' ')}]` : x)).join(' ')}`).join('; ')}`, ''];
  writeFileSync(join(dir, 'CUE-SHEET.md'), sheet.join('\n'));
  // The same pack as one file, to deliver or hand over.
  writeFileSync(join(dirname(dir), 'midi.zip'), zip(dirEntries(dir, 'midi')));
  return dir;
}

// ---- readable versions ----

function blueprintMarkdown(b, genre) {
  const chords = (c) => c.chords.map((x) => (Array.isArray(x) ? `[${x.join(' ')}]` : x)).join(' · ');
  return [`# ${b.title || 'Untitled'}`, '',
    `**${b.bpm} BPM · ${b.meter || '4/4'} · ${b.scale} · ${b.bars} bars (${fmtSec(seconds)})**${genre ? ` · ${genre.name}` : ''}`, '',
    b.dramatic_reading ? `**The story:** ${b.dramatic_reading}` : '', b.style ? `**Style:** ${b.style}` : '', '',
    b.genre_signature?.length ? ['## What makes it this genre', '', ...b.genre_signature.map((s) => `- **${s.id}** carries the ${s.carries}: ${s.how} (${s.where})`), ''].join('\n') : '',
    b.motif ? ['## The hook', '', Object.entries(b.motif).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n'), ''].join('\n') : '',
    '## The story, section by section', '', '| Bars | Section | What happens | Intensity |', '|---|---|---|---|',
    ...(b.sections || []).map((s) => `| ${s.start_bar}-${s.end_bar} | ${s.name} | ${s.function}${s.picture ? ` *(picture: ${s.picture})*` : ''} | ${'▮'.repeat(Math.round(s.intensity))}${'▯'.repeat(10 - Math.round(s.intensity))} ${s.intensity} |`), '',
    '## Chords', '', ...(b.chart || []).map((c) => `- bars ${c.bars[0]}-${c.bars[1]}: ${chords(c)}`), '',
    '## The parts (one MIDI channel each)', '', '| Channel | Part | Role | Its job | Sound idea |', '|---|---|---|---|---|',
    ...(b.roles || []).map((r) => `| ${r.channel} | ${r.name} | ${r.harmony} | ${r.job || ''} | ${r.instrument_idea || r.sound || ''} |`), '',
    b.hits?.length ? ['## Hits on the picture', '', ...b.hits.map((h) => `- ${h.t_sec}s → bar ${h.bar} beat ${h.beat ?? 1}, ${h.kind || 'direct'}: ${h.what}`), ''].join('\n') : '',
    b.ending ? `**The ending:** ${b.ending}` : null].filter((x) => x !== null && x !== false).join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// music/MUSIC-SHEET.md: one page with every decision and every measurement so far, rewritten after each stage.
function writeSheet() {
  const b = read(F.blueprint); if (!b) return;
  const genre = read(F.genre); const notes = read(F.notes); const check = read(F.check); const ins = read(F.instruments);
  const aud = read(F.audition); const mas = read(F.master); const own = read(F.own);
  const icheck = read('music/instruments-check.json');
  const mark = (ok, label) => `${ok === true ? '✔' : ok === false ? '✖' : '·'} ${label}`;
  const stages = [
    genre ? mark(profileProblems(genre).length === 0, 'Genre researched') : null,
    mark(checkBlueprint(b).length === 0, 'Blueprint'),
    mark(check ? check.ok : null, 'Score checked'), mark(notes ? true : null, 'MIDI captured'),
    mark(icheck ? icheck.ok : null, 'Instruments chosen'), mark(aud ? aud.ok : null, 'Audition'),
    mas || !own ? mark(mas ? mas.ok : null, 'Mastered (Strudel)') : null, own ? mark(!own.errors?.length, 'Owner\'s master imported') : null,
  ].filter(Boolean);
  const regs = notes ? registers(notes) : [];
  const lines = [`# ${b.title || 'Music'}: how it was made`, '',
    'Written by the music engine after every stage. Each line below is something it checked or measured.', '',
    stages.join(' · '), '',
    `**${b.bpm} BPM · ${b.meter || '4/4'} · ${b.scale} · ${b.bars} bars (${fmtSec(b.bars * beatsPerBar(b.meter || '4/4') * 60 / b.bpm)})**${genre ? ` · genre: ${genre.name}` : ''}`,
    b.dramatic_reading ? `\nThe story: ${b.dramatic_reading}` : '', b.style ? `\nStyle: ${b.style}` : '',
    b.genre_signature?.length ? `\nGenre signature: ${b.genre_signature.map((s) => `${s.id} (${s.carries})`).join(', ')}` : '', '',
    '## Channels', '', '| Ch | Part | Role | Plays | Notes | Instrument | Level / pan | Audition | Why this sound |', '|---|---|---|---|---|---|---|---|---|',
    ...(b.roles || []).map((r) => {
      const reg = regs.find((x) => x.channel === r.channel); const p = ins?.parts?.find((x) => x.channel === r.channel); const a = aud?.parts?.find((x) => x.channel === r.channel);
      const plays = !reg ? (notes ? 'never' : '') : reg.kind === 'drums' ? `GM ${reg.drums.join(' ')}` : `${noteName(reg.lowest)}–${noteName(reg.highest)}`;
      const sound = !p ? '' : p.kit ? Object.entries(p.kit).map(([k, v]) => `${k}: ${v.sound}`).join(', ') : `\`${p.sound}${p.set || ''}\``;
      return `| ${r.channel} | ${r.name} | ${r.harmony} | ${plays} | ${reg?.notes ?? ''} | ${sound} | ${p ? `${p.gain ?? 0.8} / ${p.pan ?? 0}` : ''} | ${a ? (a.ok ? '✔' : '✖') : ''} | ${p?.why || ''} |`;
    }), '',
    ins?.concept ? `Sound concept: ${ins.concept}\n` : '',
    check?.intensity?.length ? ['## The story, measured', '', '| Section | Bars | Asked | Measured |', '|---|---|---|---|', ...check.intensity.map((s) => `| ${s.name} | ${s.bars[0]}-${s.bars[1]} | ${s.asked} | ${s.measured} |`), ''].join('\n') : '',
    check?.hits?.length ? ['## Hits', '', ...check.hits.map((h) => `- ${h.ok ? '✔' : '✖'} ${h.t_sec}s → bar ${h.bar}.${h.beat ?? 1} (${h.off_sec >= 0 ? '+' : ''}${h.off_sec}s): ${h.what}`), ''].join('\n') : '',
    check && !check.ok ? `## Open problems in the score\n\n${check.errors.map((e) => `- ${e}`).join('\n')}\n` : '',
    icheck?.warnings?.length || icheck?.errors?.length ? `## Instrument notes\n\n${[...(icheck.errors || []), ...(icheck.warnings || [])].map((e) => `- ${e}`).join('\n')}\n` : '',
    mas ? ['## The master (Strudel)', '', `- ${mas.master.lufs} LUFS integrated, true peak ${mas.master.true_peak} dBTP, ${mas.master.seconds} s (target ${mas.target.lufs} LUFS, ${mas.target.tp} dBTP)`,
      `- balance: ${mas.mix.balance.lowPct}% low end, ${mas.mix.balance.mudPct}% mud, width ${mas.mix.balance.widthDb} dB`, ...mas.mix.balance.notes.map((n) => `- ! ${n}`), ...(mas.problems || []).map((p) => `- ✖ ${p}`), ''].join('\n') : '',
    own ? ['## The owner\'s master', '', `- ${own.source}: ${own.measured.seconds} s, ${own.measured.lufs} LUFS, true peak ${own.measured.true_peak} dBTP${own.measured.offset_sec !== undefined ? `, first sound ${own.measured.offset_sec >= 0 ? '+' : ''}${own.measured.offset_sec} s from the MIDI's first note` : ''}`, ...(own.warnings || []).map((w) => `- ! ${w}`), ...(own.errors || []).map((e) => `- ✖ ${e}`), ''].join('\n') : '',
    '## Files', '', '- `music/blueprint.json` the plan · `music/score.strudel.js` the notes · `music/notes.json` + `out/music/midi/` the MIDI',
    '- `music/instruments.json` the sound of each channel · `out/music/audition/` each instrument across its range',
    `- ${own ? '`music/own-master/master.wav` the owner\'s master' : '`out/music/master.wav` + `.mp3` the master · `out/music/stems/` one file per channel'}`, ''];
  write(F.sheet, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
}
