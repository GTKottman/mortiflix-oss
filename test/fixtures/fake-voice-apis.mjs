// Loaded with `node --import` into vo.mjs for tests: answers ElevenLabs and ComfyUI requests from memory.
// FAKE_WAV is a real audio file every "generation" returns; FAKE_LOG collects the requests for assertions.
import { readFileSync, appendFileSync } from 'node:fs';

const wav = readFileSync(process.env.FAKE_WAV);
const LINES = { 'Every city has a heartbeat.': 'every city has a heartbeat', 'Ours runs on bikes, all night long.': 'ours runs on bikes all night long' };
let stt = 0;
let prompts = 0;
const graphs = {};
const log = (row) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(row) + '\n');
const json = (v, init = {}) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
const words = (text) => text.split(' ').map((w, i) => ({ text: w, type: 'word', start: i * 0.3, end: i * 0.3 + 0.25 }));

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method || 'GET';
  if (url.hostname.endsWith('elevenlabs.io')) {
    if (url.pathname.startsWith('/v1/text-to-speech/')) {
      const body = JSON.parse(init.body);
      log({ api: 'tts', voice: url.pathname.split('/').pop(), format: url.searchParams.get('output_format'), body });
      return new Response(wav, { status: 200, headers: { 'request-id': `req-${Math.random().toString(36).slice(2, 8)}` } });
    }
    if (url.pathname === '/v1/speech-to-text') {
      stt++;
      const keyterms = init.body.getAll('keyterms');
      log({ api: 'stt', model: init.body.get('model_id'), keyterms });
      // The second check (line 2, take 1) hears words missing: the line must be retaken.
      const heard = stt === 2 ? 'ours runs' : stt === 1 ? LINES['Every city has a heartbeat.'] : LINES['Ours runs on bikes, all night long.'];
      return json({ text: heard, words: words(heard) });
    }
    if (url.pathname === '/v1/user/subscription') return json({ tier: 'creator', character_count: 1000, character_limit: 100000 });
  }
  if (url.port === '8188') {
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '0.35.0' }, devices: [{ name: 'cuda:0 Fake GPU : cudaMallocAsync', vram_total: 10 * 2 ** 30, vram_free: 9 * 2 ** 30 }] });
    if (url.pathname === '/object_info/Qwen3TTSEngineNode') return json({ Qwen3TTSEngineNode: { input: { required: {
      model_variant: [['TTS - CustomVoice 1.7B (Presets + Instruction)', 'TTS - CustomVoice 0.6B (Presets)', '1.7B', '0.6B']],
      voice_preset: [['None (Zero-shot / Custom)', 'Ryan', 'Aiden']], language: [['Auto', 'English']] },
      // As on a real install: runtime_mode is an optional input.
      optional: { runtime_mode: [['Main Environment', '⚠️ Shared Runtime']] } } } });
    if (url.pathname === '/object_info/UnifiedASRTranscribeNode') return json({ UnifiedASRTranscribeNode: { input: { required: {} } } });
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/free') { log({ api: 'free' }); return json({}); }
    if (url.pathname === '/prompt') {
      const { prompt } = JSON.parse(init.body);
      const id = `p${++prompts}`;
      graphs[id] = prompt;
      log({ api: 'prompt', classes: Object.values(prompt).map((n) => n.class_type), engine: prompt['1'].inputs });
      return json({ prompt_id: id });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/').pop();
      const g = graphs[id];
      if (g['3'].class_type === 'PreviewAudio') return json({ [id]: { status: { status_str: 'success' }, outputs: { 3: { audio: [{ filename: `${id}.flac`, subfolder: '', type: 'temp' }] } } } });
      const said = 'every city has a heartbeat';
      return json({ [id]: { status: { status_str: 'success' }, outputs: { 4: { text: [JSON.stringify({ text: said, segments: [{ words: words(said) }] })] } } } });
    }
    if (url.pathname === '/view') return new Response(wav, { status: 200 });
    if (url.pathname === '/upload/image' && method === 'POST') return json({ name: 'take.wav', subfolder: 'mortiflix', type: 'input' });
  }
  throw new Error(`fake: no route for ${method} ${url}`);
};
