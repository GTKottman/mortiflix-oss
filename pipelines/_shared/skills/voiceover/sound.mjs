#!/usr/bin/env node
// sound.mjs: sound effects and music beds from ElevenLabs, when the studio has them switched on.
//
//   node .claude/skills/voiceover/sound.mjs sfx "soft glassy whoosh, left to right" --seconds 1.2 [--loop] [--influence 0.3] --out sfx/whoosh.mp3
//   node .claude/skills/voiceover/sound.mjs music "warm, minimal synth bed, 90 bpm, no vocals" --seconds 45 [--vocals] --out music/bed.mp3
//
// sfx:   eleven_text_to_sound_v2, 0.5 to 30 s (or let it choose), --loop for a seamless loop, --influence 0-1 (how
//        literally it follows the prompt; default 0.3).
// music: Eleven Music (music_v2_5 by default, --model to change), 3 s to 10 min, instrumental unless --vocals.
//        Usage terms for music depend on the ElevenLabs plan: https://elevenlabs.io/music-terms
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const [kind, prompt] = args;
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const die = (msg) => { console.error(`sound: ${msg}`); process.exit(1); };

const voice = (() => { try { return JSON.parse(process.env.MFX_VOICE || '{}'); } catch { return {}; } })();
const cfg = voice.elevenlabs || {};
const key = process.env.ELEVENLABS_API_KEY;
const SERVERS = { default: 'https://api.elevenlabs.io', us: 'https://api.us.elevenlabs.io', eu: 'https://api.eu.residency.elevenlabs.io', in: 'https://api.in.residency.elevenlabs.io', sg: 'https://api.sg.residency.elevenlabs.io' };

if (!['sfx', 'music'].includes(kind) || !prompt) die('usage: sound.mjs sfx|music "prompt" [--seconds N] --out file.mp3');
if (voice.engine !== 'elevenlabs' || !key) die('ElevenLabs isn\'t set up in this studio: make the sound another way (or ask the owner).');
if (kind === 'sfx' && cfg.sfx === false) die('the studio switched ElevenLabs sound effects off');
if (kind === 'music' && !cfg.music) die('the studio hasn\'t switched Eleven Music on (Settings › Voice). Use another music source.');
const out = opt('out') || die('--out file.mp3 is required');
const seconds = opt('seconds') === null ? null : Number(opt('seconds'));

let path, body;
if (kind === 'sfx') {
  if (seconds !== null && !(seconds >= 0.5 && seconds <= 30)) die('--seconds must be 0.5 to 30 for a sound effect');
  const influence = Number(opt('influence', 0.3));
  if (!(influence >= 0 && influence <= 1)) die('--influence must be 0 to 1');
  path = '/v1/sound-generation';
  body = { text: prompt, model_id: 'eleven_text_to_sound_v2', prompt_influence: influence, loop: args.includes('--loop'), ...(seconds !== null ? { duration_seconds: seconds } : {}) };
} else {
  if (seconds !== null && !(seconds >= 3 && seconds <= 600)) die('--seconds must be 3 to 600 for music');
  path = '/v1/music';
  body = { prompt, model_id: opt('model', 'music_v2_5'), force_instrumental: !args.includes('--vocals'), ...(seconds !== null ? { music_length_ms: Math.round(seconds * 1000) } : {}) };
}

const res = await fetch(new URL(`${path}?output_format=mp3_44100_128`, SERVERS[cfg.server] || SERVERS.default), {
  method: 'POST',
  headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) die(`ElevenLabs ${res.status} ${(await res.text()).slice(0, 300)}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`${out}: ${kind}${seconds ? `, ${seconds} s` : ''}. Note its prompt in assets/SOURCES.md.`);
