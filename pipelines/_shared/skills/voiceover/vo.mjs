#!/usr/bin/env node
// vo.mjs: narration for a video, in the voice the studio set up (ElevenLabs, Qwen3-TTS on this machine's GPU, or the
// owner's own voice from the recording booth).
//
//   node .claude/skills/voiceover/vo.mjs check
//   node .claude/skills/voiceover/vo.mjs speak voice/lines.json [--only id,id] [--max-takes 3] [--jobs N]
//   node .claude/skills/voiceover/vo.mjs build voice/lines.json [--gap 0.4]     → voice/voice.wav + voice/timing.json
//
// voice/lines.json: [{ "id": "b01-1", "text": "[warm] The words as spoken.", "script": "The words as spoken.", "gap_after": 0.5 }]
//   text   what the voice reads (ElevenLabs v4 takes [audio tags] and "/IPA/"; the local voice reads `script` if given)
//   script the same words spelled normally, for the check (needed when text has tags or IPA)
//
// The voice comes from the studio's settings ($MFX_VOICE); keys are in the environment, never printed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const [cmd, file] = args;
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const die = (msg) => { console.error(`vo: ${msg}`); process.exit(1); };
const OUT = 'voice';

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
const words = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

// How much of the script was said: matched words (longest common subsequence) and the longest run left out or added.
function compare(script, transcript) {
  const a = words(script), b = words(transcript);
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, missing = 0, extra = 0, maxMissing = 0, maxExtra = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; missing = 0; extra = 0; }
    else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) { i++; maxMissing = Math.max(maxMissing, ++missing); extra = 0; }
    else { j++; maxExtra = Math.max(maxExtra, ++extra); missing = 0; }
  }
  const matched = dp[0][0];
  return { similarity: a.length + b.length ? Math.round((2 * matched / (a.length + b.length)) * 1000) / 1000 : 1, longest_missing: maxMissing, longest_extra: maxExtra };
}

function judge(l, t) {
  const c = compare(heard(l), t.text);
  const problems = [];
  if (c.similarity < Number(opt('threshold', 0.92))) problems.push(`said ${Math.round(c.similarity * 100)}% of the words right`);
  if (c.longest_missing >= 3) problems.push(`${c.longest_missing} words in a row missing`);
  if (c.longest_extra >= 3) problems.push(`${c.longest_extra} extra words in a row`);
  if (t.events?.length) problems.push(`non-speech sounds: ${t.events.join(', ')} (a tag became a sound effect?)`);
  return { pass: !problems.length, compare: c, problems };
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

async function speakEleven(list) {
  const ctx = await elevenlabs();
  const { el, cfg, api } = ctx;
  if (!cfg.voice_id) die('no ElevenLabs voice chosen: pick one in the studio\'s Settings (or `mortiflix voice`), then run again. mfx needs-you');
  const maxTakes = Number(opt('max-takes', 3));
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
    for (let n = 1; n <= maxTakes; n++) {
      const seed = Math.floor(Math.random() * 4294967295);
      const body = el.requestBody(cfg, l.text, { previous_text: k > 0 ? all[k - 1].text : undefined, next_text: k < all.length - 1 ? all[k + 1].text : undefined, seed });
      let res;
      try {
        res = await api(`/v1/text-to-speech/${encodeURIComponent(cfg.voice_id)}?output_format=${fmt}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) { report[l.id] = { pass: false, problems: [e.message] }; if (/40[13]|quota|credits/i.test(e.message)) break; continue; }
      const take = join(OUT, 'takes', `${l.id}-t${n}${ext}`);
      writeFileSync(take, Buffer.from(await res.arrayBuffer()));
      let t = null, verdict = { pass: true, compare: null, problems: [] };
      if (cfg.check_model !== 'off') {
        try { t = await listenEleven(ctx, take, l); verdict = judge(l, t); } catch (e) { verdict = { pass: true, compare: null, problems: [], note: `not checked: ${e.message}` }; }
      }
      const rep = { id: l.id, engine: `elevenlabs/${cfg.model_id}`, voice: cfg.voice_name || cfg.voice_id, take: n, seed, request_id: res.headers.get('request-id'), seconds: duration(take), ...verdict, words: t?.words || [], transcript: t?.text ?? null };
      report[l.id] = rep;
      const best = report[`${l.id}:best`];
      if (verdict.pass || !best || (verdict.compare?.similarity ?? 0) > (best.compare?.similarity ?? 0)) { keep(l, take, rep); report[`${l.id}:best`] = rep; }
      console.log(`${l.id} take ${n}: ${verdict.pass ? 'ok' : verdict.problems.join('; ')}${verdict.note ? ` (${verdict.note})` : ''}`);
      if (verdict.pass) break;
    }
  });
  finish(list, report);
}

// ---------------------------------------------------------------------------------------------------------------
// Qwen3-TTS through ComfyUI, on this machine's GPU

async function speakQwen(list) {
  const q = await lib('qwen.mjs');
  const cfg = { ...q.DEFAULTS, ...(voice.qwen || {}) };
  const comfy = new q.ComfyUI({ url: cfg.url });
  const st = await comfy.status();
  if (!st.ok) die(`${st.reason} mfx needs-you`);
  cfg.variant = q.ComfyUI.variant(st.models, cfg.model);
  if (!st.voices.includes(cfg.voice)) die(`voice ${cfg.voice} isn't offered by this model (${st.voices.join(', ')})`);
  const maxTakes = Number(opt('max-takes', 3));
  mkdirSync(join(OUT, 'takes'), { recursive: true });
  const report = {};
  let todo = list;
  for (let n = 1; n <= maxTakes && todo.length; n++) {
    // Speak everything, then free the GPU, then listen to everything: the two models take turns on the card.
    const made = [];
    for (const l of todo) {
      const seed = n === 1 ? 1 : Math.floor(Math.random() * 2 ** 31);
      try {
        const out = await comfy.run(q.speakGraph(cfg, heard(l).trim(), seed));
        const f = out['3'].audio[0];
        const raw = join(OUT, 'takes', `${l.id}-t${n}.${f.filename.split('.').pop()}`);
        writeFileSync(raw, await comfy.file(f));
        const take = join(OUT, 'takes', `${l.id}-t${n}.wav`);
        run(['ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-ar', '48000', '-ac', '1', take]);
        if (raw !== take) rmSync(raw, { force: true });
        made.push({ l, take, seed });
        console.log(`${l.id} take ${n}: spoken`);
      } catch (e) { report[l.id] = { pass: false, problems: [e.message] }; console.log(`${l.id} take ${n}: ${e.message}`); }
    }
    await comfy.free();
    const failed = [];
    for (const { l, take, seed } of made) {
      let t = null, verdict = { pass: true, compare: null, problems: [] };
      if (cfg.check && st.can_listen) {
        try { t = await listenQwen(comfy, q, cfg, take, `${l.id}-t${n}`); verdict = judge(l, t); } catch (e) { verdict = { pass: true, compare: null, problems: [], note: `not checked: ${e.message}` }; }
      }
      const rep = { id: l.id, engine: `qwen3-tts/${cfg.variant} (local)`, voice: cfg.voice, take: n, seed, seconds: duration(take), ...verdict, words: t?.words || [], transcript: t?.text ?? null };
      const best = report[`${l.id}:best`];
      if (verdict.pass || !best || (verdict.compare?.similarity ?? 0) > (best.compare?.similarity ?? 0)) { keep(l, take, rep); report[`${l.id}:best`] = rep; }
      report[l.id] = rep;
      console.log(`${l.id} take ${n}: ${verdict.pass ? 'ok' : verdict.problems.join('; ')}${verdict.note ? ` (${verdict.note})` : ''}`);
      if (!verdict.pass) failed.push(l);
    }
    await comfy.free();
    todo = failed;
  }
  finish(list, report);
}

async function listenQwen(comfy, q, cfg, path, name) {
  const form = new FormData();
  form.append('image', new Blob([readFileSync(path)]), `${name}.wav`);
  form.append('subfolder', 'mortiflix');
  form.append('type', 'input');
  const res = await fetch(`${comfy.url}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  const up = await res.json();
  const out = await comfy.run(q.listenGraph(cfg, up.subfolder ? `${up.subfolder}/${up.name}` : up.name));
  const d = JSON.parse(out['4'].text[0]);
  return { engine: `qwen3-asr/${cfg.asr_model} (local)`, text: d.text || '', words: (d.segments || []).flatMap((s) => s.words || []).map((w) => ({ text: w.text, start: Number(w.start), end: Number(w.end) })), events: [] };
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
  let t = 0;
  for (const l of list) {
    const clip = ['.wav', '.mp3', '.flac', '.opus'].map((e) => join(OUT, 'clips', `${l.id}${e}`)).find(existsSync);
    if (!clip) die(`no clip for ${l.id}: speak it first`);
    const wav = join(OUT, 'build', `${l.id}.wav`);
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', clip, '-ar', '48000', '-ac', '1', wav]);
    const d = duration(wav);
    const meta = existsSync(join(OUT, 'clips', `${l.id}.json`)) ? JSON.parse(readFileSync(join(OUT, 'clips', `${l.id}.json`), 'utf8')) : {};
    const ws = (meta.words || []).map((w) => ({ text: w.text, start: r3(t + w.start), end: r3(t + w.end) }));
    timing.push({ id: l.id, text: heard(l).replace(/\s+/g, ' ').trim(), start: r3(t), end: r3(t + d), words: ws, timing: ws.length ? 'words' : 'line' });
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
  } else if (engine === 'qwen') {
    const q = await lib('qwen.mjs');
    const cfg = { ...q.DEFAULTS, ...(voice.qwen || {}) };
    const st = await new q.ComfyUI({ url: cfg.url }).status();
    console.log(JSON.stringify({ engine, ...st, chosen: { model: cfg.model, voice: cfg.voice, language: cfg.language, instruct: /1\.7B/.test(cfg.model) ? cfg.instruct : '(the 0.6B model takes no instructions)' }, notes: 'tags and IPA are not read: write delivery into the instruction and spell names the way they sound' }, null, 2));
    if (!st.ok) process.exitCode = 1;
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
  else if (engine === 'qwen') await speakQwen(list);
  else if (engine === 'own') speakOwn(list);
  else die('no voice is set up in this studio (vo.mjs check)');
} else if (cmd === 'build') build();
else die('usage: vo.mjs check | speak <lines.json> [--only ids] [--max-takes 3] [--jobs N] | build <lines.json> [--gap 0.4]');
