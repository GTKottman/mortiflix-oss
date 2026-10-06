// ElevenLabs, for setting a studio up (the account, models, voices, the Voice Library, a test line). Sessions make
// their narration with the voiceover skill's vo.mjs; this module is what Settings and `mortiflix voice` use.
// Reference: https://elevenlabs.io/docs (models, voices, text to speech, user/subscription), checked Oct 2026.

export const SERVERS = {
  default: 'https://api.elevenlabs.io',
  us: 'https://api.us.elevenlabs.io',
  eu: 'https://api.eu.residency.elevenlabs.io',
  in: 'https://api.in.residency.elevenlabs.io',
  sg: 'https://api.sg.residency.elevenlabs.io',
};

// What each output format needs (from the API reference): 192 kbps MP3 needs Creator or above, 44.1 kHz PCM/WAV Pro.
export const OUTPUT_FORMATS = [
  { id: 'mp3_44100_128', label: 'MP3 44.1 kHz 128 kbps', tier: null, note: 'default' },
  { id: 'mp3_44100_192', label: 'MP3 44.1 kHz 192 kbps', tier: 'creator' },
  { id: 'wav_44100', label: 'WAV 44.1 kHz', tier: 'pro' },
  { id: 'pcm_44100', label: 'PCM 44.1 kHz (raw)', tier: 'pro' },
  { id: 'wav_48000', label: 'WAV 48 kHz', tier: 'pro' },
  { id: 'wav_24000', label: 'WAV 24 kHz', tier: null },
  { id: 'opus_48000_128', label: 'Opus 48 kHz 128 kbps', tier: null },
];

const TIER_ORDER = ['free', 'starter', 'creator', 'pro', 'scale', 'business', 'enterprise'];
export const tierAtLeast = (tier, need) => !need || TIER_ORDER.indexOf(String(tier || 'free').toLowerCase().replace(/_.*/, '')) >= TIER_ORDER.indexOf(need);

// Concurrent requests per plan for the standard models (docs: Models > Concurrency and priority).
export const CONCURRENCY = { free: 2, starter: 3, creator: 5, pro: 10, scale: 15, business: 15 };

// Eleven v4 (and v4 Turbo) take only stability and similarity: no style, no speed, no SSML (docs: Eleven v4).
export const isV4 = (modelId) => /^eleven_v4/.test(modelId || '');

export const DEFAULTS = {
  model_id: 'eleven_v4',
  voice_id: null,
  voice_name: null,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  speed: 1,
  use_speaker_boost: true,
  output_format: 'mp3_44100_128',
  language_code: null,
  apply_text_normalization: 'auto',
  pronunciation_dictionaries: [],   // up to 3 {id, version_id, name}
  server: 'default',
  check_model: 'scribe_v2',         // speech to text for checking takes and word timing
  sfx: true,                        // sessions may make sound effects (eleven_text_to_sound_v2)
  music: false,                     // sessions may compose music beds (Eleven Music)
};

// The voice settings a model actually uses.
export function voiceSettings(cfg, model) {
  const s = { stability: num(cfg.stability, 0.5), similarity_boost: num(cfg.similarity_boost, 0.75) };
  if (isV4(cfg.model_id)) return s;
  if (!model || model.can_use_style !== false) s.style = num(cfg.style, 0);
  if (!model || model.can_use_speaker_boost !== false) s.use_speaker_boost = cfg.use_speaker_boost !== false;
  s.speed = Math.min(1.2, Math.max(0.7, num(cfg.speed, 1)));
  return s;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export class ElevenLabs {
  constructor({ key, server = 'default', fetch = globalThis.fetch }) {
    if (!key) throw new Error('no ElevenLabs API key');
    this.key = key;
    this.base = SERVERS[server] || SERVERS.default;
    this.fetch = fetch;
  }

  async call(path, { method = 'GET', body, query, raw = false } = {}) {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x); else url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      method,
      headers: { 'xi-api-key': this.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      let kind = null;
      try {
        const j = JSON.parse(text);
        detail = j.detail?.message || j.detail?.[0]?.msg || j.detail || text;
        kind = j.detail?.type || j.detail?.status || j.detail?.code || null;
      } catch { /* plain text */ }
      const err = new Error(`ElevenLabs ${res.status}: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`);
      err.status = res.status;
      // A bad key isn't always a 401: ElevenLabs answers some with 400 { type: "authentication_error", status: "invalid_api_key" }.
      err.auth = res.status === 401 || res.status === 403 || /authentication_error|invalid_api_key|unauthorized/i.test(`${kind} ${text}`);
      err.code = kind;
      throw err;
    }
    if (raw) return res;
    return res.json();
  }

  // The plan, credits and what it allows. Free-plan audio may only be used non-commercially, with attribution.
  async account() {
    const s = await this.call('/v1/user/subscription');
    const tier = String(s.tier || 'free').toLowerCase();
    return {
      tier,
      status: s.status,
      characters_used: s.character_count,
      character_limit: s.character_limit,
      characters_left: Math.max(0, (s.character_limit || 0) - (s.character_count || 0)),
      resets_at: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
      commercial_use: !tier.startsWith('free'),
      instant_cloning: Boolean(s.can_use_instant_voice_cloning),
      professional_cloning: Boolean(s.can_use_professional_voice_cloning),
      voice_slots: { used: s.voice_slots_used, limit: s.voice_limit },
      concurrency: CONCURRENCY[tier.replace(/_.*/, '')] ?? null,
    };
  }

  // Text-to-speech models, newest recommendation first.
  async models() {
    const list = await this.call('/v1/models');
    const tts = list.filter((m) => m.can_do_text_to_speech);
    const rank = (id) => ['eleven_v4', 'eleven_multilingual_v2', 'eleven_v3', 'eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_flash_v2'].indexOf(id);
    return tts
      .map((m) => ({
        id: m.model_id,
        name: m.name,
        description: m.description,
        languages: (m.languages || []).length,
        max_characters: m.maximum_text_length_per_request ?? null,
        can_use_style: isV4(m.model_id) ? false : m.can_use_style !== false,
        can_use_speaker_boost: isV4(m.model_id) ? false : m.can_use_speaker_boost !== false,
        recommended: m.model_id === 'eleven_v4',
        alpha: Boolean(m.requires_alpha_access),
      }))
      .sort((a, b) => (rank(a.id) < 0 ? 99 : rank(a.id)) - (rank(b.id) < 0 ? 99 : rank(b.id)));
  }

  // Voices in the account (the default voices included): GET /v2/voices.
  async voices({ search, page_token, page_size = 50 } = {}) {
    const r = await this.call('/v2/voices', { query: { search, next_page_token: page_token, page_size, include_total_count: true } });
    return { voices: r.voices.map(voiceCard), next: r.has_more ? r.next_page_token : null, total: r.total_count ?? null };
  }

  // The public Voice Library: GET /v1/shared-voices.
  async library({ search, gender, age, accent, language, use_cases, page = 0, page_size = 30 } = {}) {
    const r = await this.call('/v1/shared-voices', { query: { search, gender, age, accent, language, use_cases, page, page_size } });
    return {
      voices: (r.voices || []).map((v) => ({
        id: v.voice_id,
        owner: v.public_owner_id,
        name: v.name,
        description: v.description,
        labels: { gender: v.gender, age: v.age, accent: v.accent, language: v.language, use_case: v.use_case, descriptive: v.descriptive },
        preview_url: v.preview_url,
        free_users_allowed: v.free_users_allowed,
      })),
      more: Boolean(r.has_more),
    };
  }

  // Copy a Voice Library voice into the account so it can be used: POST /v1/voices/add/{owner}/{voice}.
  async addFromLibrary(owner, voiceId, name) {
    const r = await this.call(`/v1/voices/add/${encodeURIComponent(owner)}/${encodeURIComponent(voiceId)}`, { method: 'POST', body: { new_name: name } });
    return { id: r.voice_id };
  }

  async dictionaries() {
    const r = await this.call('/v1/pronunciation-dictionaries', { query: { page_size: 100 } });
    return (r.pronunciation_dictionaries || []).map((d) => ({ id: d.id, version_id: d.latest_version_id, name: d.name, description: d.description }));
  }

  // One line in the chosen voice and settings, for "Try it". Costs credits like any generation.
  async sample(cfg, text) {
    const res = await this.call(`/v1/text-to-speech/${encodeURIComponent(cfg.voice_id)}`, {
      method: 'POST',
      raw: true,
      query: { output_format: 'mp3_44100_128' },
      body: requestBody(cfg, text),
    });
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      concurrency: Number(res.headers.get('maximum-concurrent-requests')) || null,
      characters: String(text).length,
    };
  }
}

// The body of a text-to-speech request: only what the chosen model takes.
export function requestBody(cfg, text, { previous_text, next_text, seed, model } = {}) {
  const body = { text, model_id: cfg.model_id || DEFAULTS.model_id, voice_settings: voiceSettings(cfg, model) };
  if (cfg.language_code) body.language_code = cfg.language_code;
  if (cfg.apply_text_normalization && cfg.apply_text_normalization !== 'auto') body.apply_text_normalization = cfg.apply_text_normalization;
  const dicts = (cfg.pronunciation_dictionaries || []).slice(0, 3);
  if (dicts.length) body.pronunciation_dictionary_locators = dicts.map((d) => ({ pronunciation_dictionary_id: d.id, ...(d.version_id ? { version_id: d.version_id } : {}) }));
  if (previous_text) body.previous_text = previous_text;
  if (next_text) body.next_text = next_text;
  if (Number.isInteger(seed)) body.seed = seed;
  return body;
}

function voiceCard(v) {
  return {
    id: v.voice_id,
    name: v.name,
    category: v.category,
    description: v.description || '',
    labels: v.labels || {},
    preview_url: v.preview_url || null,
    languages: (v.verified_languages || []).map((l) => l.language).filter(Boolean),
    models: v.high_quality_base_model_ids || [],
    mine: Boolean(v.is_owner),
  };
}

// Voice preview files live on ElevenLabs' storage; the studio fetches them for the page (its CSP allows only itself).
export function previewAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'storage.googleapis.com' || u.hostname.endsWith('.elevenlabs.io') || u.hostname === 'elevenlabs.io');
  } catch { return false; }
}
