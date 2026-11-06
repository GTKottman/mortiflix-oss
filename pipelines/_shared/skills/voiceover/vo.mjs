#!/usr/bin/env node
// vo.mjs: narration for a video, in the voice the studio set up (ElevenLabs, or the owner's own voice from the
// recording booth). ElevenLabs is the only generated voice: there is no local voice (removed 2026-11-01).
//
//   node .claude/skills/voiceover/vo.mjs check
//   node .claude/skills/voiceover/vo.mjs speak voice/lines.json [--only id,id] [--max-takes 3] [--jobs N] [--new-take]
//   node .claude/skills/voiceover/vo.mjs build voice/lines.json [--gap 0.4] [--no-trim] → voice/voice.wav + voice/timing.json
//        (each clip is trimmed to its words, 0.06 s before the first and 0.12 s after the last, when the check timed them)
//
// voice/lines.json: [{ "id": "b01-1", "text": "[warm] The words as spoken.", "script": "The words as spoken.", "gap_after": 0.5 }]
//   text   what the voice reads (ElevenLabs v4 takes [audio tags] and "/IPA/")
//   script the same words spelled normally, for the check (needed when text has tags or IPA)
//
// The voice comes from the studio's settings ($MFX_VOICE); keys are in the environment, never printed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const [cmd, file] = args;
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const die = (msg) => { console.error(`vo: ${msg}`); process.exit(1); };
const OUT = 'voice';

// --new-take (a retake of a line that already has one): a fresh seed from take 1, and a new file next to the old takes
// (voice/takes/<id>-t<N>), so nothing is overwritten and the old take stays to go back to.
const fresh = args.includes('--new-take');
const takeIdx = (id, n) => {
  if (!fresh) return n;
  let have = 0;
  try { have = readdirSync(join(OUT, 'takes')).filter((f) => f.startsWith(`${id}-t`) && /^t\d+\.(wav|mp3|opus)$/.test(f.slice(id.length + 1))).length; } catch { /* no takes yet */ }
  return n + have;
};

const voice = (() => { try { return JSON.parse(process.env.MFX_VOICE || '{}'); } catch { return {}; } })();
const engine = voice.engine || 'none';
const home = process.env.MFX_HOME;
const lib = async (name) => {
  if (!home) die('MFX_HOME is not set (run this inside a Mortiflix session)');
  return import(pathToFileURL(join(home, 'src', 'voice', name)).href);
};

// ---------------------------------------------------------------------------------------------------------------
// lines and the check

function lines() {
  if (!file || !existsSync(file)) die(`no lines file: ${file || '(missing)'}`);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const l of list) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(l.id || '') || !String(l.text || '').trim()) die(`bad line: ${JSON.stringify(l)}`);
    if (ids.has(l.id)) die(`line id ${l.id} appears twice`);
    ids.add(l.id);
  }
  const only = opt('only');
  return only ? list.filter((l) => only.split(',').includes(l.id)) : list;
}

// The words as they should be heard: tags and IPA out, spelled normally.
const heard = (l) => String(l.script || l.text).replace(/\[[^\]]*\]/g, ' ').replace(/"?\/[^/\s][^/]*\/"?/g, ' ');
// Judging lives in $MFX_HOME/src/voice/judge.mjs (casing, punctuation, digits and split names never fail a take).
let judgeLib = null;
const loadJudge = async () => { judgeLib ||= await lib('judge.mjs'); };
function judge(l, t) { // loadJudge() has run at the start of every speak
  return judgeLib.judge(heard(l), t.text, { events: t.events, threshold: Number(opt('threshold', 0.92)) });
}

function duration(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  if (r.status !== 0) die(`${argv[0]} failed: ${r.stderr.slice(-400)}`);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function keep(l, take, rep) {
  mkdirSync(join(OUT, 'clips'), { recursive: true });
  for (const ext of ['.mp3', '.wav', '.flac', '.opus']) rmSync(join(OUT, 'clips', `${l.id}${ext}`), { force: true });
  copyFileSync(take, join(OUT, 'clips', `${l.id}${extname(take)}`));
  writeFileSync(join(OUT, 'clips', `${l.id}.json`), JSON.stringify(rep, null, 2));
}

// ---------------------------------------------------------------------------------------------------------------
// ElevenLabs

async function elevenlabs() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) die('ELEVENLABS_API_KEY is not set: the studio\'s voice is ElevenLabs but no key reached this session. mfx needs-you');
  const el = await lib('elevenlabs.mjs');
  const cfg = { ...el.DEFAULTS, ...(voice.elevenlabs || {}) };
  const base = el.SERVERS[cfg.server] || el.SERVERS.default;
  const api = async (path, init = {}) => {
    const res = await fetch(new URL(path, base), { ...init, headers: { 'xi-api-key': key, ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} ${(await res.text()).slice(0, 300)}`);
    // the studio's usage ledger: every paid call (speech, the speech-to-text check), credits from the response header
    const kind = /\/text-to-speech\//.test(String(path)) ? 'tts' : /\/speech-to-text/.test(String(path)) ? 'scribe check' : null;
    if (kind) {
      try {
        const { bookSpend, costHeader } = await lib('spend.mjs');
        const real = costHeader(res);
        let chars = null;
        try { chars = JSON.parse(init.body)?.text?.length ?? null; } catch { /* a form body */ }
        const model = kind === 'tts' ? (cfg.model_id || null) : (cfg.check_model || 'scribe_v2');
        const flash = /flash|turbo/i.test(String(model));
        bookSpend({ kind, model, credits: real ?? (kind === 'tts' && chars !== null ? (flash ? chars / 2 : chars) : null), estimated: real === null && kind === 'tts' && chars !== null });
      } catch { /* the call still counts */ }
    }
    return res;
  };
  return { el, cfg, api };
}

async function listenEleven({ api, cfg }, path, l) {
  const form = new FormData();
  form.append('model_id', cfg.check_model || 'scribe_v2');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'true');
  if (cfg.language_code) form.append('language_code', cfg.language_code);
  // Names and unusual words from the line help the transcriber spell what it hears.
  for (const k of [...new Set(heard(l).match(/\b[A-Z][\p{L}\p{N}'-]{2,}\b/gu) || [])].slice(0, 50)) form.append('keyterms', k);
  form.append('file', new Blob([readFileSync(path)]), `take${extname(path)}`);
  const body = await (await api('/v1/speech-to-text', { method: 'POST', body: form })).json();
  const all = body.words || [];
  return {
    engine: `elevenlabs/${cfg.check_model || 'scribe_v2'}`,
    text: body.text || '',
    words: all.filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end })),
    events: all.filter((w) => w.type === 'audio_event').map((w) => w.text),
  };
}

// The cast (voice/cast.json, src/svc/voicecast.mjs): a line's `role` picks its voice, model, settings and clip gain.
// A line may also carry its own stability. Lines without a role (or roles not in the cast) use the studio's voice.
function castOf() {
  try { return JSON.parse(readFileSync(join(OUT, 'cast.json'), 'utf8')).cast || []; } catch { return []; }
}
function roleCfg(cfg, l, cast = castOf()) {
  const c = cast.find((x) => x.role === (l.role || 'narrator'));
  const out = { ...cfg };
  if (c) {
    if (c.voice_id) out.voice_id = c.voice_id;
    if (c.name) out.voice_name = c.name;
    if (c.model) out.model_id = c.model;
    for (const k of ['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost']) if (c.settings?.[k] !== undefined) out[k] = c.settings[k];
  }
  if (Number.isFinite(l.stability)) out.stability = l.stability;
  return out; // eleven_v4 drops style and speed in el.voiceSettings, so they are stored but never sent
}
const gainOf = (l, cast) => Number(cast.find((x) => x.role === (l.role || 'narrator'))?.gain_db) || 0;

async function speakEleven(list) {
  await loadJudge();
  const ctx = await elevenlabs();
  const { el, api } = ctx;
  const cast = castOf();
  const cfg = ctx.cfg;
  if (!cfg.voice_id && !cast.some((c) => c.voice_id)) die('no ElevenLabs voice chosen: pick one in the studio\'s Settings (or `mortiflix voice`), then run again. mfx needs-you');
  const maxTakes = Number(opt('max-takes', 2)); // each ElevenLabs take is paid: take 1, a re-spelling, then one more at most
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const fmt = cfg.output_format || 'mp3_44100_128';
  const ext = fmt.startsWith('wav') ? '.wav' : fmt.startsWith('opus') ? '.opus' : fmt.startsWith('pcm') ? '.pcm' : '.mp3';
  if (ext === '.pcm') die('pcm output has no container; choose WAV in Settings for narration');
  // Parallel lines: the plan's concurrency (saved when the key was connected) minus one, so the studio's own checks fit.
  const jobs = Number(opt('jobs', 0)) || Math.max(1, (el.CONCURRENCY[String(cfg.tier || '').replace(/_.*/, '')] ?? 3) - 1);
  mkdirSync(join(OUT, 'takes'), { recursive: true });
  const report = {};
  await pool(list, jobs, async (l) => {
    const k = all.findIndex((x) => x.id === l.id);
    const cfg = roleCfg(ctx.cfg, l, cast);
    if (!cfg.voice_id) { report[l.id] = { pass: false, problems: [`no voice for role ${l.role || 'narrator'}`] }; return; }
    for (let n = 1; n <= maxTakes; n++) {
      const seed = Math.floor(Math.random() * 4294967295);
      const body = el.requestBody(cfg, l.text, { previous_text: k > 0 ? all[k - 1].text : undefined, next_text: k < all.length - 1 ? all[k + 1].text : undefined, seed });
      let res;
      try {
        res = await api(`/v1/text-to-speech/${encodeURIComponent(cfg.voice_id)}?output_format=${fmt}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) { report[l.id] = { pass: false, problems: [e.message] }; if (/40[13]|quota|credits/i.test(e.message)) break; continue; }
      const take = join(OUT, 'takes', `${l.id}-t${takeIdx(l.id, n)}${ext}`);
      writeFileSync(take, Buffer.from(await res.arrayBuffer()));
      let t = null, verdict = { pass: true, compare: null, problems: [] };
      if (cfg.check_model !== 'off') {
        try { t = await listenEleven(ctx, take, l); verdict = judge(l, t); } catch (e) { verdict = { pass: true, compare: null, problems: [], note: `not checked: ${e.message}` }; }
      }
      const rep = { id: l.id, role: l.role || 'narrator', engine: `elevenlabs/${cfg.model_id}`, voice: cfg.voice_name || cfg.voice_id, take: n, seed, request_id: res.headers.get('request-id'), seconds: duration(take), ...verdict, words: t?.words || [], transcript: t?.text ?? null };
      report[l.id] = rep;
      const best = report[`${l.id}:best`];
      if (verdict.pass || !best || (verdict.compare?.similarity ?? 0) > (best.compare?.similarity ?? 0)) { keep(l, take, rep); report[`${l.id}:best`] = rep; }
      console.log(`${l.id} take ${n}: ${verdict.pass ? 'ok' : verdict.problems.join('; ')}${verdict.note ? ` (${verdict.note})` : ''}`);
      if (verdict.pass) break;
    }
  });
  finish(list, report);
}

function finish(list, report) {
  const lines_ = list.map((l) => report[`${l.id}:best`] || report[l.id] || { id: l.id, pass: false });
  writeFileSync(join(OUT, 'speak-report.json'), JSON.stringify(lines_, null, 2));
  const bad = lines_.filter((r) => !r.pass);
  console.log(`\n${list.length - bad.length}/${list.length} lines passed${bad.length ? `; failing: ${bad.map((r) => r.id).join(', ')} (see voice/speak-report.json: fix the text, then --only those)` : ''}`);
  if (bad.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------------
// The owner's own voice: nothing to generate. The recording booth (web studio or `mortiflix record`) puts each kept
// take in voice/clips/<id>.wav with a report whose `script` says which words it was recorded for.

function speakOwn(list) {
  const report = list.map((l) => {
    const meta = existsSync(join(OUT, 'clips', `${l.id}.json`)) ? JSON.parse(readFileSync(join(OUT, 'clips', `${l.id}.json`), 'utf8')) : null;
    const clip = existsSync(join(OUT, 'clips', `${l.id}.wav`));
    const script = heard(l).replace(/\s+/g, ' ').trim();
    const pass = Boolean(clip && meta?.engine === 'own voice' && (meta.script === undefined || meta.script === script));
    return { id: l.id, engine: 'own voice', pass, ...(pass ? { take: meta.take, seconds: meta.seconds } : { problems: [clip && meta?.script !== script ? 'the line changed since it was recorded' : 'not recorded yet'] }) };
  });
  writeFileSync(join(OUT, 'speak-report.json'), JSON.stringify(report, null, 2));
  const todo = report.filter((r) => !r.pass);
  if (!todo.length) return console.log(`${list.length}/${list.length} lines recorded by the owner: run build next`);
  const project = process.env.MFX_PROJECT || '<project>';
  console.log(`${list.length - todo.length}/${list.length} lines recorded; ${todo.length} still need the owner's voice: ${todo.map((r) => r.id).join(', ')}`);
  console.log(`Ask the owner (then stop; they resume when it's done):\n  mfx needs-you "The narration script is ready: please record ${todo.length} line${todo.length === 1 ? '' : 's'} in the recording booth (open the project and choose Record narration, or run: mortiflix record ${project})."`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------------
// build: one track with gaps, and where every line and word lands in it

function build() {
  const list = lines();
  const defaultGap = Number(opt('gap', 0.4));
  mkdirSync(join(OUT, 'build'), { recursive: true });
  const parts = [];
  const timing = [];
  const cast = castOf();
  let t = 0;
  for (const l of list) {
    const clip = ['.wav', '.mp3', '.flac', '.opus'].map((e) => join(OUT, 'clips', `${l.id}${e}`)).find(existsSync);
    if (!clip) die(`no clip for ${l.id}: speak it first`);
    const wav = join(OUT, 'build', `${l.id}.wav`);
    const gain = gainOf(l, cast); // the role's clip gain, in dB
    const gainFx = gain ? `,volume=${gain}dB` : '';
    const meta = existsSync(join(OUT, 'clips', `${l.id}.json`)) ? JSON.parse(readFileSync(join(OUT, 'clips', `${l.id}.json`), 'utf8')) : {};
    // The dead air at a take's edges (up to 0.6 s on ElevenLabs) cut away: from just before the first word to just
    // after the last, with 20 ms fades so the cut never clicks. Untimed lines are kept whole.
    const timed = (meta.words || []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    const full = duration(clip);
    const cut = !args.includes('--no-trim') && timed.length
      ? [Math.max(0, timed[0].start - 0.06), Math.min(full || Infinity, timed.at(-1).end + 0.12)]
      : null;
    if (cut && cut[1] - cut[0] > 0.2) {
      const len = cut[1] - cut[0];
      run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', String(cut[0]), '-t', String(len), '-i', clip, '-af', `afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, len - 0.02)}:d=0.02${gainFx}`, '-ar', '48000', '-ac', '1', wav]);
    } else run(['ffmpeg', '-y', '-loglevel', 'error', '-i', clip, ...(gain ? ['-af', `volume=${gain}dB`] : []), '-ar', '48000', '-ac', '1', wav]);
    const d = duration(wav);
    const off = cut && cut[1] - cut[0] > 0.2 ? cut[0] : 0;
    const ws = (meta.words || []).map((w) => ({ text: w.text, start: r3(t + Math.max(0, w.start - off)), end: r3(t + Math.min(d, w.end - off)) }));
    timing.push({ id: l.id, role: l.role || 'narrator', text: heard(l).replace(/\s+/g, ' ').trim(), start: r3(t), end: r3(t + d), words: ws, timing: ws.length ? 'words' : 'line' });
    parts.push(wav);
    t += d;
    const gap = l.gap_after ?? defaultGap;
    if (gap > 0) {
      const sil = join(OUT, 'build', `gap-${l.id}.wav`);
      run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(gap), sil]);
      parts.push(sil);
      t += gap;
    }
  }
  writeFileSync(join(OUT, 'build', 'list.txt'), parts.map((p) => `file '${p.replace(/^voice\/build\//, '')}'`).join('\n') + '\n');
  run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'build', 'list.txt'), '-c', 'pcm_s16le', join(OUT, 'voice.wav')]);
  writeFileSync(join(OUT, 'timing.json'), JSON.stringify({ seconds: r3(t), lines: timing }, null, 2));
  console.log(`voice/voice.wav: ${t.toFixed(2)} s, ${timing.length} lines → voice/timing.json`);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------------------

async function check() {
  if (engine === 'elevenlabs') {
    const { el, cfg, api } = await elevenlabs();
    const s = await (await api('/v1/user/subscription')).json();
    const tier = String(s.tier || 'free');
    console.log(JSON.stringify({
      engine, model: cfg.model_id, voice: cfg.voice_name || cfg.voice_id, settings: el.voiceSettings(cfg),
      plan: tier, characters_left: Math.max(0, s.character_limit - s.character_count),
      commercial_use: !tier.startsWith('free') ? true : 'NO: free plan audio is non-commercial and needs attribution',
      parallel_lines: Math.max(1, (el.CONCURRENCY[tier.replace(/_.*/, '')] ?? 3) - 1),
      sound_effects: cfg.sfx !== false, music: Boolean(cfg.music),
      v4_rules: el.isV4(cfg.model_id) ? 'audio tags in [brackets], IPA as "/.../", CAPITALS for emphasis, no SSML, only stability + similarity' : null,
    }, null, 2));
  } else if (engine === 'own') {
    console.log(JSON.stringify({ engine, note: 'The owner narrates in their own voice. Write voice/lines.json, then `speak` lists the lines still to record and the mfx needs-you text for the owner; after they record, `speak` passes and `build` makes the track (timed per line).' }, null, 2));
  } else {
    console.log(JSON.stringify({ engine: 'none', note: 'No voice is set up in this studio. Make the video with on-screen text, or ask the owner (mfx ask) whether to wait for a voice.' }, null, 2));
  }
}

if (cmd === 'check') await check();
else if (cmd === 'speak') {
  const list = lines();
  if (engine === 'elevenlabs') await speakEleven(list);
  else if (engine === 'qwen') die('the local voice (Qwen3-TTS) was removed: the studio narrates with ElevenLabs (Settings › Narration)');
  else if (engine === 'own') speakOwn(list);
  else die('no voice is set up in this studio (vo.mjs check)');
} else if (cmd === 'build') build();
else die('usage: vo.mjs check | speak <lines.json> [--only ids] [--max-takes 3] [--jobs N] | build <lines.json> [--gap 0.4]');
