#!/usr/bin/env node
// vo.mjs: narration for a video.
//
//   node .claude/skills/voiceover/vo.mjs check                         is a voice service set up?
//   node .claude/skills/voiceover/vo.mjs speak voice/lines.json [--voice ID] [--model ID] [--force]
//        one clip per line → voice/clips/<id>.mp3 (ElevenLabs; needs ELEVENLABS_API_KEY in the session)
//   node .claude/skills/voiceover/vo.mjs time voice/lines.json      word timings per clip (speech-to-text)
//   node .claude/skills/voiceover/vo.mjs build voice/lines.json [--gap 0.4]
//        joins the clips with gaps → voice/voice.wav + voice/timing.json (line and word start times in the video)
//
// voice/lines.json: [{ "id": "b01", "text": "The exact words.", "gap_after": 0.4 }, ...]  (ids: letters, digits, -)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.elevenlabs.io/v1';
const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (name, def = null) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };
const key = process.env.ELEVENLABS_API_KEY;

function lines() {
  if (!file || !existsSync(file)) die(`no lines file: ${file || '(missing)'}`);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  for (const l of list) if (!/^[A-Za-z0-9-]{1,40}$/.test(l.id || '') || !String(l.text || '').trim()) die(`bad line: ${JSON.stringify(l)}`);
  return list;
}

function die(msg) { console.error(`vo: ${msg}`); process.exit(1); }

function duration(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

async function speak() {
  if (!key) die('ELEVENLABS_API_KEY is not set. Add it to the studio\'s session.env, or make the video without narration (ask the owner first).');
  const voice = opt('voice', process.env.ELEVENLABS_VOICE_ID);
  if (!voice) die('no voice: pass --voice <voice id> or set ELEVENLABS_VOICE_ID');
  const model = opt('model', process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2');
  mkdirSync('voice/clips', { recursive: true });
  for (const l of lines()) {
    const out = join('voice/clips', `${l.id}.mp3`);
    if (existsSync(out) && !rest.includes('--force')) { console.log(`skip ${l.id} (exists; --force to remake)`); continue; }
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: l.text, model_id: model }),
    });
    if (!res.ok) die(`${l.id}: ElevenLabs ${res.status} ${(await res.text()).slice(0, 300)}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`${l.id}: ${duration(out).toFixed(2)} s`);
  }
}

// Word timings from speech-to-text on the audio itself (more reliable than the synthesizer's own timestamps).
async function time() {
  if (!key) die('ELEVENLABS_API_KEY is not set (speech-to-text needs it).');
  mkdirSync('voice/timing', { recursive: true });
  for (const l of lines()) {
    const clip = join('voice/clips', `${l.id}.mp3`);
    if (!existsSync(clip)) die(`${clip} is missing: speak first`);
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('file', new Blob([readFileSync(clip)], { type: 'audio/mpeg' }), `${l.id}.mp3`);
    const res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
    if (!res.ok) die(`${l.id}: speech-to-text ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const words = (body.words || []).filter((w) => w.type === 'word' || !w.type).map((w) => ({ word: w.text, start: w.start, end: w.end }));
    writeFileSync(join('voice/timing', `${l.id}.json`), JSON.stringify({ id: l.id, heard: body.text, words }, null, 2));
    const said = norm(body.text), meant = norm(l.text);
    console.log(`${l.id}: ${words.length} words${said === meant ? '' : `  ⚠ heard "${body.text}"`}`);
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

function build() {
  const list = lines();
  const defaultGap = Number(opt('gap', 0.4));
  mkdirSync('voice/build', { recursive: true });
  const parts = [];
  const timing = [];
  let t = 0;
  for (const l of list) {
    const clip = [join('voice/clips', `${l.id}.mp3`), join('voice/clips', `${l.id}.wav`)].find(existsSync);
    if (!clip) die(`no clip for ${l.id}`);
    const wav = join('voice/build', `${l.id}.wav`);
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', clip, '-ar', '48000', '-ac', '1', wav]);
    const d = duration(wav);
    const words = existsSync(join('voice/timing', `${l.id}.json`))
      ? JSON.parse(readFileSync(join('voice/timing', `${l.id}.json`), 'utf8')).words.map((w) => ({ ...w, start: r3(t + w.start), end: r3(t + w.end) }))
      : [];
    timing.push({ id: l.id, text: l.text, start: r3(t), end: r3(t + d), words });
    parts.push(wav);
    t += d;
    const gap = l.gap_after ?? defaultGap;
    if (gap > 0) {
      const sil = join('voice/build', `gap-${l.id}.wav`);
      run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(gap), sil]);
      parts.push(sil);
      t += gap;
    }
  }
  writeFileSync('voice/build/list.txt', parts.map((p) => `file '${p.replace(/^voice\/build\//, '')}'`).join('\n') + '\n');
  run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'voice/build/list.txt', '-c', 'pcm_s16le', 'voice/voice.wav']);
  writeFileSync('voice/timing.json', JSON.stringify({ seconds: r3(t), lines: timing }, null, 2));
  console.log(`voice/voice.wav: ${t.toFixed(2)} s, ${timing.length} lines → voice/timing.json`);
}

function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  if (r.status !== 0) die(`${argv[0]} failed: ${r.stderr.slice(-400)}`);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

if (cmd === 'check') console.log(key ? 'ElevenLabs: key present' : 'No voice service: ELEVENLABS_API_KEY is not set');
else if (cmd === 'speak') await speak();
else if (cmd === 'time') await time();
else if (cmd === 'build') build();
else die('usage: vo.mjs check | speak <lines.json> | time <lines.json> | build <lines.json>');
