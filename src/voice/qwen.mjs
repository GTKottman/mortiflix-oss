// Local narration: Qwen3-TTS (Apache-2.0) through ComfyUI and the TTS Audio Suite custom nodes, on your own graphics
// card. Nothing leaves the machine and nothing is billed. This module detects the GPU, checks ComfyUI, and makes a test
// line for Settings and `mortiflix voice`; sessions use the voiceover skill's vo.mjs, which builds the same graphs.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Built into the CustomVoice checkpoints (Qwen's model card): name, native language, character.
export const PRESETS = [
  { id: 'Ryan', language: 'English', about: 'dynamic male voice with strong rhythmic drive' },
  { id: 'Aiden', language: 'English', about: 'sunny American male voice, clear midrange' },
  { id: 'Vivian', language: 'Chinese', about: 'bright, slightly edgy young female voice' },
  { id: 'Serena', language: 'Chinese', about: 'warm, gentle young female voice' },
  { id: 'Uncle_Fu', language: 'Chinese', about: 'seasoned male voice, low and mellow' },
  { id: 'Dylan', language: 'Chinese (Beijing)', about: 'youthful Beijing male voice' },
  { id: 'Eric', language: 'Chinese (Sichuan)', about: 'lively Chengdu male voice, slightly husky' },
  { id: 'Ono_Anna', language: 'Japanese', about: 'playful Japanese female voice' },
  { id: 'Sohee', language: 'Korean', about: 'warm Korean female voice, rich emotion' },
];

export const DEFAULTS = {
  url: 'http://127.0.0.1:8188',
  model: 'CustomVoice 1.7B',        // matched against the installed node's model list
  voice: 'Ryan',
  language: 'English',
  instruct: 'A calm, clear, warm narrator. Steady, unhurried pace, natural pauses between ideas.',
  runtime_mode: 'Main Environment', // the suite's own options; some installs need its "Shared Runtime"
  check: true,                      // listen back to every take with Qwen3-ASR (word timings come from it)
  asr_model: '1.7B',
};

// Measured: the 1.7B voice model needs about 6.5 GB free while it speaks, the 1.7B listening model about 6 GB (they
// take turns, so the card needs room for one at a time). The 0.6B models fit in about half.
export const NEEDS = { '1.7B': 8, '0.6B': 4 };

// The machine's graphics cards (NVIDIA through nvidia-smi; ComfyUI's own report covers the rest when it's running).
export function detectGpus() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, total, used] = line.split(',').map((s) => s.trim());
    return { name, vram_gb: round(Number(total) / 1024), used_gb: round(Number(used) / 1024), vendor: 'nvidia' };
  });
}

// Which model this card can run, or why not.
export function recommend(gpus) {
  const best = [...gpus].sort((a, b) => b.vram_gb - a.vram_gb)[0];
  if (!best) return { fits: false, model: null, reason: 'No NVIDIA graphics card found. Qwen3-TTS can run on other GPUs through ComfyUI, but Mortiflix can only check NVIDIA cards itself.' };
  if (best.vram_gb >= NEEDS['1.7B']) return { fits: true, model: 'CustomVoice 1.7B', gpu: best, reason: `${best.name} (${best.vram_gb} GB) runs the 1.7B voice, which takes delivery instructions.` };
  if (best.vram_gb >= NEEDS['0.6B']) return { fits: true, model: 'CustomVoice 0.6B', gpu: best, reason: `${best.name} (${best.vram_gb} GB) fits the 0.6B voice (preset voices, no delivery instructions).` };
  return { fits: false, model: null, gpu: best, reason: `${best.name} has ${best.vram_gb} GB; Qwen3-TTS needs at least ${NEEDS['0.6B']} GB.` };
}

const round = (v) => Math.round(v * 10) / 10;

export class ComfyUI {
  constructor({ url = DEFAULTS.url, fetch = globalThis.fetch } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.fetch = fetch;
  }

  async get(path) {
    const res = await this.fetch(this.url + path, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ComfyUI ${res.status} on ${path}`);
    return res.json();
  }

  async post(path, body) {
    const res = await this.fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`ComfyUI ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : {};
  }

  // Is ComfyUI up, is the TTS Audio Suite installed, and what does it offer? Everything comes from the installed
  // nodes, so a newer suite with other model names or options still works.
  async status() {
    let stats;
    try { stats = await this.get('/system_stats'); } catch (e) {
      return { ok: false, step: 'comfyui', reason: `ComfyUI isn't answering at ${this.url} (${e.cause?.code || e.message}).` };
    }
    const dev = stats.devices?.[0] || {};
    const base = { comfyui: stats.system?.comfyui_version || null, gpu: dev.name ? String(dev.name).replace(/^cuda:\d+\s*/, '').replace(/\s*:.*$/, '') : null, vram_gb: dev.vram_total ? round(dev.vram_total / 2 ** 30) : null, vram_free_gb: dev.vram_free ? round(dev.vram_free / 2 ** 30) : null };
    let info;
    try { info = await this.get('/object_info/Qwen3TTSEngineNode'); } catch { info = {}; }
    const engine = info.Qwen3TTSEngineNode;
    if (!engine) return { ok: false, step: 'suite', ...base, reason: 'ComfyUI is running, but the TTS Audio Suite (with Qwen3-TTS) isn\'t installed.' };
    // Some inputs (runtime_mode) are optional on the node: read both.
    const inputs = { ...(engine.input.optional || {}), ...(engine.input.required || {}) };
    const options = (k) => (Array.isArray(inputs[k]?.[0]) ? inputs[k][0] : []);
    const variants = options('model_variant');
    let asr = false;
    try { asr = Boolean((await this.get('/object_info/UnifiedASRTranscribeNode')).UnifiedASRTranscribeNode); } catch { /* older suite */ }
    return {
      ok: true,
      ...base,
      models: variants.filter((v) => /CustomVoice|VoiceDesign|Base/.test(v) && !v.startsWith('local:')),
      asr_models: variants.filter((v) => /^\d(\.\d)?B$/.test(v)),
      voices: options('voice_preset').filter((v) => !v.startsWith('None')),
      languages: options('language'),
      runtime_modes: options('runtime_mode'),
      can_listen: asr,
    };
  }

  // The installed model variant that matches a short name like "CustomVoice 1.7B".
  static variant(models, want) {
    const [kind, size] = String(want).split(/\s+/);
    return models.find((m) => m.includes(kind) && m.includes(size)) || models.find((m) => m.includes(kind)) || models[0];
  }

  async run(graph, { timeoutMs = 30 * 60_000 } = {}) {
    const { prompt_id: id } = await this.post('/prompt', { prompt: graph, client_id: randomUUID() });
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const h = await this.get(`/history/${id}`);
      if (h[id]) {
        const st = h[id].status || {};
        if (st.status_str === 'error') {
          const err = (st.messages || []).find((m) => m[0] === 'execution_error')?.[1] || {};
          throw new Error(`${err.node_type || 'ComfyUI'}: ${err.exception_message || 'failed'}`.trim());
        }
        return h[id].outputs;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    throw new Error('ComfyUI took too long');
  }

  async file({ filename, subfolder, type }) {
    const q = new URLSearchParams({ filename, subfolder: subfolder || '', type: type || 'temp' });
    const res = await this.fetch(`${this.url}/view?${q}`);
    if (!res.ok) throw new Error(`ComfyUI ${res.status} fetching audio`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Unload models between speaking and listening: the two don't share a mid-size card. Only when ComfyUI has nothing
  // else queued or running, so someone else's ComfyUI work is never pulled out from under it.
  async free() {
    try {
      const q = await this.get('/queue');
      if ((q.queue_running || []).length || (q.queue_pending || []).length) return false;
      await this.post('/free', { unload_models: true, free_memory: true });
      return true;
    } catch { return false; /* older ComfyUI */ }
  }

  // One line in the chosen voice, for "Try it".
  async sample(cfg, text, status) {
    const s = status || await this.status();
    if (!s.ok) throw new Error(s.reason);
    const graph = speakGraph({ ...cfg, variant: ComfyUI.variant(s.models, cfg.model) }, text, 1);
    const out = await this.run(graph);
    const f = out['3'].audio[0];
    return { audio: await this.file(f), format: (f.filename.split('.').pop() || 'flac') };
  }
}

// The graph that speaks one line: the Qwen3-TTS engine node, the suite's text node, a preview (kept in ComfyUI's temp
// folder, which empties on restart, so takes don't pile up there).
export function speakGraph(cfg, text, seed) {
  const instructable = /CustomVoice 1\.7B/.test(cfg.variant);
  return {
    1: { class_type: 'Qwen3TTSEngineNode', inputs: {
      model_variant: cfg.variant, device: 'auto', voice_preset: cfg.voice, language: cfg.language || 'English',
      instruct: instructable ? (cfg.instruct || '') : '', top_k: 50, top_p: 1.0, temperature: 0.8, repetition_penalty: 1.05,
      max_new_tokens: 4096, asr_use_forced_aligner: true, runtime_mode: cfg.runtime_mode || DEFAULTS.runtime_mode } },
    2: { class_type: 'UnifiedTTSTextNode', inputs: {
      TTS_engine: ['1', 0], text, narrator_voice: 'none', seed, enable_audio_cache: false, enable_chunking: true,
      max_chars_per_chunk: 400, chunk_combination_method: 'silence_padding', silence_between_chunks_ms: 250 } },
    3: { class_type: 'PreviewAudio', inputs: { audio: ['2', 0] } },
  };
}

// The graph that listens to one take (uploaded to ComfyUI's input folder) and returns its words with timings.
export function listenGraph(cfg, inputName) {
  return {
    1: { class_type: 'Qwen3TTSEngineNode', inputs: {
      model_variant: cfg.asr_model || DEFAULTS.asr_model, device: 'auto', voice_preset: 'None (Zero-shot / Custom)', language: cfg.language || 'English',
      instruct: '', top_k: 50, top_p: 1.0, temperature: 0.8, repetition_penalty: 1.05, max_new_tokens: 4096,
      asr_use_forced_aligner: true, runtime_mode: cfg.runtime_mode || DEFAULTS.runtime_mode } },
    2: { class_type: 'LoadAudio', inputs: { audio: inputName } },
    3: { class_type: 'UnifiedASRTranscribeNode', inputs: { engine: ['1', 0], audio: ['2', 0], language: cfg.language || 'English', task: 'transcribe', timestamps: 'word', enable_asr_cache: false } },
    4: { class_type: 'PreviewAny', inputs: { source: ['3', 1] } },
  };
}
