// Soundtrack v1 (owner, 2026-10-19: "use what we learned to make a version 1 of something completely different that
// will work, no matter what"): the voice, the music, the effects and the mix as one system, each stage checked by
// measurement, never by ear.
//
//   voice    ElevenLabs lossless PCM + word times, never processed (voice.mjs)
//   music    one plan call (the craft, key words, reasons) -> notes by code (harmony lock) -> real instruments, no
//            sample boosted more than 12 dB, a synth wherever a sample still fails -> stems (quickmusic planAndCompose)
//   effects  the SFX pack, each hit on its moment (effects.mjs)
//   mix      Dubstage: the voice untouched, the score under it, effects by strength, one plain delivery gain; then the
//            proof: mix - (everything else) = the voice times one number, sample for sample
//
// Everything lands in <work>/sound/ (and the engine's music/, out/music/): mix.wav (lossless), mix.mp3 (320 kbps, plays
// anywhere), REPORT.md.
import { runAs } from '../models.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../studio.mjs';
import { context, planAndCompose, engine, exec } from '../quickmusic.mjs';
import { bpbOf, instrumentsFor, balanceGains, nudge, toSynth, usedParts, MAX_BOOST } from '../music/compose.mjs';
import { readWav, levelOf } from '../../pipelines/_shared/skills/music/lib/wav.mjs';
import { makeVoice } from './voice.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { loadPack, planEffects } from './effects.mjs';
import { projectPacks } from '../svc/projectpacks.mjs';
import { surgeStems } from './surge.mjs';

const FPS = 30;
const END_HOLD = 1.5; // the soundtrack runs this long after the last word (the end card)
const LEAD = 0.25; // a scene starts this long before its first word
const ROLE_OF = { 1: 'Bass', 2: 'Pad', 3: 'Keys', 4: 'Keys', 5: 'Keys', 10: 'Drums' };
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
export const DUBSTAGE = process.env.MFX_DUBSTAGE || 'dubstage';

// The picture's moments on the new voice: each scene from its beat's first word, each cut on the first word of the
// beat it lands on (the board says "the first word of beat N").
function moments(c, timing) {
  const beats = c.script.beats;
  const first = (bid) => timing.lines.find((l) => l.id.startsWith(`${bid}-`))?.words?.[0]?.start ?? null;
  const scenes = beats.map((b, i) => ({ key: `s${String(i + 1).padStart(2, '0')}`, beat: b.id, name: b.name, s: first(b.id) })).filter((x) => x.s !== null);
  scenes.forEach((x, i) => { x.start_sec = i ? Math.max(0, x.s - LEAD) : 0; });
  scenes.forEach((x, i) => { x.end_sec = scenes[i + 1]?.start_sec ?? timing.seconds + END_HOLD; delete x.s; });
  const cuts = (c.board.cuts || []).map((x, i) => {
    // where the cut lands: the scene the board names ("(b03, 14.16 s)" or "beat 3"), at its first word on this voice;
    // else the time the board wrote; else the next scene in order
    const on = String(x.lands_on || '');
    const bid = on.match(/\b(b\d{2,3})\b/)?.[1] || (on.match(/beat (\d+)/) ? beats[Number(on.match(/beat (\d+)/)[1]) - 1]?.id : null);
    const written = Number(on.match(/(\d+(?:\.\d+)?)\s*s\)/)?.[1]);
    const t = (bid && first(bid)) ?? (Number.isFinite(written) ? written : first(beats[i + 1]?.id));
    const what = `${typeof x.transition === 'string' ? x.transition : x.transition?.new || 'cut'} into ${x.to}`;
    return t === null ? null : { cut: i + 1, t_sec: t, frames: x.frames || 0, what };
  }).filter(Boolean);
  return { scenes, cuts };
}

export async function makeSoundtrack({ root, id, run, runArgs = {}, config = {}, stages = ['voice', 'music', 'effects', 'mix'], videoSec = null, log = console.log }) {
  const c = context(root, id);
  const env = { ...process.env, ...(runArgs.env || {}) };
  const dir = join(c.work, 'sound');
  mkdirSync(dir, { recursive: true });
  const report = readJson(join(dir, 'report.json'), {});
  const save = () => writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
  const usage = { input_tokens: 0, output_tokens: 0 };

  // 1. the voice
  if (stages.includes('voice')) {
    const key = readJson(join(root, 'secrets.json'), {}).elevenlabs_api_key || env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('no ElevenLabs key');
    const el = voiceConfig(root).elevenlabs;
    const v = await makeVoice({ work: c.work, key, voice: el.voice_name || 'Tracy K', voiceId: el.voice_id, model: el.model_id, stability: el.stability, similarity: el.similarity_boost, speakerBoost: el.use_speaker_boost !== false, log });
    const lv = levelOf(readWav(v.file));
    report.voice = { file: 'sound/voice/voice.wav', source: `ElevenLabs ${v.model}, voice ${v.voice}, ${v.format} (lossless)`, seconds: v.timing.seconds, lines: v.timing.lines.length, peak_db: lv.peak_db, processing: 'none: silent edges cut, lines joined with the script\'s gaps' };
    save();
    log(`voice: ${v.timing.lines.length} lines, ${v.timing.seconds} s, ${v.format}, peak ${lv.peak_db} dBFS, unprocessed`);
  }
  // the soundtrack's own voice, or (a project voiced before soundtrack v1) the voice step's narration, used as it is
  const own = existsSync(join(dir, 'voice', 'voice.wav'));
  const timing = readJson(join(dir, 'voice', 'timing.json')) || readJson(join(c.work, 'voice', 'timing.json'));
  const voiceFile = own ? join(dir, 'voice', 'voice.wav') : join(c.work, 'out', 'voice', 'narration.wav');
  if (!timing || !existsSync(voiceFile)) throw new Error('no voice yet (stage voice)');
  c.timing = timing;
  const { scenes, cuts } = moments(c, timing);
  c.scenes = scenes;
  c.videoSec = videoSec || +(timing.seconds + END_HOLD).toFixed(3);
  const mu = join(c.work, 'music');

  // 2. the music
  if (stages.includes('music')) {
    const qdir = join(root, 'run', 'quick', id); mkdirSync(qdir, { recursive: true });
    const call = async (prompt, schema, role = 'plan') => {
      const r = await runAs(run, role, { ...runArgs, workdir: qdir, prompt, config: { ...config, claudeArgs: ['--tools', '', '--json-schema', JSON.stringify(schema)] } });
      usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
      return r;
    };
    log(`music: planning (${scenes.length} scenes, ${cuts.length} cuts)`);
    const pc = await planAndCompose({ c, cuts, call, config, env, onActivity: (a) => log(`music: ${a.text}`) });
    if (!pc.ok) throw new Error(`music: ${pc.error}`);
    const ck = await engine(c, env, 'check', '--video-sec', String(c.videoSec), '--fps', String(FPS));
    if (ck.code !== 0) throw new Error(`music: strudel.mjs check: ${ck.out.slice(-400)}`);
    // instruments: levelled from the audition, never boosted past MAX_BOOST; a part still silent or clipping -> synth
    const inst = instrumentsFor(pc.plan.palette, usedParts(pc.composed.notes), c.scoring);
    const fallbacks = [];
    let au = null;
    for (let round = 0; round < 8; round++) {
      writeFileSync(join(mu, 'instruments.json'), `${JSON.stringify(inst, null, 2)}\n`);
      const ins = await engine(c, env, 'instruments');
      if (ins.code !== 0) throw new Error(`music: strudel.mjs instruments: ${ins.out.slice(-400)}`);
      au = await engine(c, env, 'audition');
      const rep = readJson(join(mu, 'audition.json'), { parts: [] });
      if (au.code === 0) { if (round < 6 && balanceGains(inst, rep)) continue; break; }
      let changed = false;
      for (const p of rep.parts.filter((x) => !x.ok)) {
        const part = inst.parts.find((x) => x.channel === p.channel); if (!part) continue;
        for (const n of p.notes.filter((x) => x.peak_db < -50 || x.peak_db > -0.3)) {
          const gm = part.kit ? Number(String(n.note).replace('GM ', '')) : null;
          const v = part.kit ? part.kit[String(gm)] : part;
          if (!v) continue;
          const loud = n.peak_db > -0.3;
          // silent and already at the boost limit: the sample is wrong for this, a synth plays it
          if (!loud && (v.boost_db || 0) >= MAX_BOOST - 0.5) { if (toSynth(inst, p.channel, gm)) { fallbacks.push(`${p.name}${gm ? ` GM ${gm}` : ''}`); changed = true; } }
          else { nudge(v, loud ? -6 : Math.min(MAX_BOOST, -30 - n.peak_db)); changed = true; }
          if (!part.kit) break;
        }
      }
      if (!changed) break;
    }
    if (au.code !== 0) throw new Error(`music: the audition still fails: ${au.out.slice(-400)}`);
    // where two parts sound rough together, heard from the instruments' overtones (lib/roughness.mjs): reported only
    const rough = readJson(join(mu, 'audition.json'), {}).rough || [];
    if (rough.length) log(`music: sounds rough in ${rough.length} place${rough.length === 1 ? '' : 's'}: ${rough.slice(0, 3).map((r) => `${r.a} with ${r.b} at ${r.at} (×${r.x})`).join('; ')}`);
    // the stems (and the whole score), trimmed as a whole if the parts add up past -1 dBFS
    let score = null;
    for (let round = 0; round < 3; round++) {
      const r = await exec(process.execPath, [join(REPO, 'pipelines', '_shared', 'skills', 'music', 'strudel.mjs'), 'render', '--stems'], { cwd: c.work, env, timeout: 30 * 60_000 });
      if (r.code !== 0) throw new Error(`music: render: ${r.out.slice(-400)}`);
      // parts an instrument pack gives to Surge XT: their stems played by the engine, the score summed again
      report.surge = await surgeStems({ root, work: c.work, inst, bp: pc.bp, env, log });
      score = levelOf(readWav(join(c.work, 'out', 'music', 'score.wav')));
      if (score.peak_db <= -1) break;
      const k = 10 ** (Math.min(-6 - score.peak_db, -21 - score.rms_db) / 20);
      for (const p of inst.parts) p.gain = +Math.max(0.01, (p.gain ?? 0.8) * k).toFixed(4);
      writeFileSync(join(mu, 'instruments.json'), `${JSON.stringify(inst, null, 2)}\n`);
    }
    report.music = { title: pc.plan.title, bpm: pc.map.bpm, meter: pc.map.meter, scale: pc.plan.scale, bars: pc.map.bars, offset_sec: pc.map.offset_sec, palette: pc.plan.palette,
      parts: inst.parts.map((p) => ({ channel: p.channel, role: p.role, sound: p.surge?.patch ? `Surge XT: ${p.surge.patch}` : p.sound || 'kit', boost_db: p.boost_db || 0, fallback: p.fallback || null })),
      synth_fallbacks: fallbacks, rough: rough.slice(0, 20), score_peak_db: score.peak_db, key_words: pc.bp.key_words, dramatic_reading: pc.plan.dramatic_reading, tokens: { ...usage } };
    save();
    log(`music: "${pc.plan.title}", ${pc.map.bpm} BPM, ${pc.plan.scale}; fallbacks: ${fallbacks.join(', ') || 'none'}; score peak ${score.peak_db} dBFS`);
  }

  // 3. the effects
  if (stages.includes('effects')) {
    // the SFX pack picked in the New project window, else the studio's own
    const sfx = projectPacks(root, id).sfx?.id || 'explainer-basics';
    const pack = loadPack(join(root, 'packs', 'sfx', sfx));
    if (!pack) throw new Error(`no SFX pack (packs/sfx/${sfx})`);
    const lastBeat = c.script.beats.at(-1)?.id;
    const lastStart = timing.lines.find((l) => l.id.startsWith(`${lastBeat}-`))?.words?.[0]?.start ?? null;
    report.effects = planEffects({ pack, cuts, fps: FPS, lastBeatStart: lastStart });
    save();
    log(`effects: ${report.effects.map((e) => `${e.sound} at ${e.moment} s`).join(', ')}`);
  }

  // 4. the mix, and the proof the voice is untouched
  if (stages.includes('mix')) {
    const bp = readJson(join(mu, 'blueprint.json'));
    const notes = readJson(join(mu, 'notes.json'), { tracks: [] });
    const stems = notes.tracks.map((t) => { const f = join(c.work, 'out', 'music', 'stems', `${String(t.channel).padStart(2, '0')}-${t.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.wav`); return existsSync(f) ? `${f}=${ROLE_OF[t.channel] || 'Auto'}@${bp.offset_sec}:${t.name}` : null; }).filter(Boolean);
    const fx = (report.effects || []).map((e) => `${e.file}@${e.at}=${e.strength}:${e.label.replace(/\s+/g, '_')}`);
    const args = [join(dir, 'mix.wav'), '--voice', voiceFile, '--bpm', String(bp.bpm), '--offset', String(bp.offset_sec), '--bpb', String(bpbOf(bp.meter)),
      '--delivery', 'web', '--under', '20', '--gap-under', '10', '--report', join(dir, 'mix-report.json'), '--bus-out', join(dir, 'bus.wav'), ...stems, ...fx];
    const r = await exec(env.MFX_DUBSTAGE || DUBSTAGE, args, { timeout: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`mix: dubstage: ${r.out.slice(-400)}`);
    log(r.out);
    // the proof: mix - bus = the voice (centred) times one gain, to the last sample
    const mix = readWav(join(dir, 'mix.wav')); const bus = readWav(join(dir, 'bus.wav')); const voice = readWav(voiceFile);
    let xy = 0; let xx = 0;
    const n = Math.min(mix.channels[0].length, voice.channels[0].length);
    for (let i = 0; i < n; i++) { const d = mix.channels[0][i] - bus.channels[0][i]; const v = voice.channels[0][i] * Math.SQRT1_2; xy += d * v; xx += v * v; }
    const k = xy / xx; let err = 0; let sig = 0;
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) { const v = voice.channels[0][i] * Math.SQRT1_2 * k; const d = mix.channels[ch][i] - bus.channels[ch][i] - v; err += d * d; sig += v * v; }
    const residual = 10 * Math.log10(err / sig + 1e-30);
    const mr = readJson(join(dir, 'mix-report.json'), {});
    report.mix = { file: 'sound/mix.wav', mp3: 'sound/mix.mp3', lufs: mr.integrated_lufs, true_peak_dbtp: mr.true_peak_dbtp, delivery: mr.delivery, delivery_gain_db: mr.delivery_gain_db,
      music_under_voice_db: mr.music_under_voice_while_speaking_db, voice_gain_db: +(20 * Math.log10(k)).toFixed(3), voice_residual_db: +residual.toFixed(1), voice_untouched: residual < -90 };
    save();
    // the report names sound/mix.mp3 only when ffmpeg made it
    const mp3 = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(dir, 'mix.wav'), '-c:a', 'libmp3lame', '-b:a', '320k', join(dir, 'mix.mp3')]);
    if (mp3.code !== 0) { delete report.mix.mp3; save(); log(`mix.mp3 not made: ${String(mp3.out).slice(-300)}`); }
    log(`mix: ${mr.integrated_lufs} LUFS, ${mr.true_peak_dbtp} dBTP; voice gain ${report.mix.voice_gain_db} dB, residual ${report.mix.voice_residual_db} dB -> ${report.mix.voice_untouched ? 'the voice is untouched' : 'THE VOICE WAS CHANGED'}`);
    if (!report.mix.voice_untouched) throw new Error('the mix changed the voice');
  }
  writeReport(dir, report);
  return { ok: true, report, usage };
}

function writeReport(dir, r) {
  const L = ['# Soundtrack v1', ''];
  if (r.voice) L.push('## Voice', '', `- ${r.voice.source}`, `- ${r.voice.lines} lines, ${r.voice.seconds} s, peak ${r.voice.peak_db} dBFS`, `- Processing: ${r.voice.processing}`, '');
  if (r.music) {
    L.push('## Music', '', `- "${r.music.title}": ${r.music.bpm} BPM, ${r.music.meter}, ${r.music.scale}, ${r.music.bars} bars from ${r.music.offset_sec} s`, `- ${r.music.dramatic_reading}`, '',
      '| ch | part | sound | boost (dB, max 12) | note |', '|---|---|---|---|---|', ...r.music.parts.map((p) => `| ${p.channel} | ${p.role} | ${p.sound} | ${p.boost_db} | ${p.fallback ? `synth fallback (${p.fallback})` : ''} |`), '');
    if (r.music.rough?.length) L.push(`- Sounds rough (two parts' overtones beat; ×1 = a major third at B♭2-D3): ${r.music.rough.map((x) => `${x.a} with ${x.b} at ${x.at} (×${x.x})`).join('; ')}`, '');
  }
  if (r.effects) L.push('## Effects', '', ...r.effects.map((e) => `- ${e.moment} s: ${e.sound} (${e.strength}): ${e.why}`), '');
  if (r.mix) L.push('## Mix (Dubstage)', '', `- ${r.mix.lufs} LUFS, true peak ${r.mix.true_peak_dbtp} dBTP (${r.mix.delivery}), one plain gain ${r.mix.delivery_gain_db} dB, no limiter`, `- Music ${r.mix.music_under_voice_db} dB under the voice while it speaks`,
    `- Voice proof: mix minus everything else = the voice x ${r.mix.voice_gain_db} dB, leftover ${r.mix.voice_residual_db} dB: ${r.mix.voice_untouched ? 'untouched' : 'CHANGED'}`, '');
  writeFileSync(join(dir, 'REPORT.md'), L.join('\n'));
}
