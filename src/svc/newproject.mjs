// New project screen (v3): the account's ElevenLabs voices for the optional voice pick. Listing voices and their
// preview_url samples costs no credits. No key: { voices: [], reason: 'no_key' }.
import { ElevenLabs } from '../voice/elevenlabs.mjs';
import { voiceConfig } from '../voice/index.mjs';
import { keyValue } from '../keys.mjs';

export async function voicesList(root, { fetch = globalThis.fetch } = {}) {
  const key = keyValue(root, 'elevenlabs');
  if (!key) return { voices: [], reason: 'no_key' };
  try {
    const el = new ElevenLabs({ key, server: voiceConfig(root).elevenlabs.server, fetch });
    const out = [];
    let token;
    for (let page = 0; page < 5; page++) {
      const r = await el.voices({ page_token: token, page_size: 100 });
      out.push(...r.voices.map((v) => ({ id: v.id, name: v.name, category: v.category || null, labels: v.labels || {}, preview_url: v.preview_url || null })));
      if (!r.next) break;
      token = r.next;
    }
    return { voices: out };
  } catch (e) {
    if (e.auth) return { voices: [], reason: 'bad_key' };
    return { voices: [], reason: 'unreachable', message: String(e.message).slice(0, 200) };
  }
}
