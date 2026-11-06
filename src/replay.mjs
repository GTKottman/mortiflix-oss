// Replay mode: the whole studio run from recorded past generations, so the v3 pipeline can be beta-tested end to end
// with no spend. Off unless the service is started with MFX_REPLAY=<replay pack dir>, and then only in a studio that
// says it is a replay studio (a REPLAY-STUDIO file in its root) and is not the default ~/Mortiflix. Anything else with
// MFX_REPLAY set throws: replay never runs half on, and a real studio is never touched by it.
//
// While it is on (fail closed, every way out is covered):
//   - config: backend 'replay' (src/backends/replay.mjs: per step, the recorded files + a submit through the bridge, the
//     same gates as a session), claudeBin = bin/claude-replay.mjs (any Claude call answers "no recording", never Claude),
//     Kinetograph = bin/kg-replay.mjs (recorded clips/stills), Video Notes folder inside the studio, no studio browser.
//   - fetch: ElevenLabs answers with recorded audio from the pack (character-cost 0); every other host is refused.
//   - the real Claude backends and the ElevenLabs client throw if they are reached at all.
//   - the usage ledger marks each row replay:true with zero credits and tokens.
// Faults (to test the error paths): <studio>/run/replay-faults.json {"login":1,"billing":1,"render":1,"tablet":1}; each
// count is how many more times that fault fires (taken one at a time, written back).
//   login    the next replay session ends with Claude Code's "OAuth session expired · Please run /login"
//   billing  the next ElevenLabs call gets HTTP 402 quota_exceeded
//   render   the next render (Kinetograph stand-in or a motion scene) fails
//   tablet   the Video Notes tablet is offline (every send fails: its folder can't be written) until the fault is cleared
// Pack format: tools/replay/make-pack.mjs (replay.json "format": "mfx-replay-1").
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPLAY_FORMAT = 'mfx-replay-1';
export const MARKER = 'REPLAY-STUDIO';
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CLAUDE_STUB = join(REPO, 'bin', 'claude-replay.mjs');
export const KG_STUB = join(REPO, 'bin', 'kg-replay.mjs');

/** Replay is asked for (MFX_REPLAY set). Whether it is allowed is replayCheck's question. */
export const replayOn = () => Boolean(process.env.MFX_REPLAY);

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

let packCache = null;
/** The replay pack ({dir, ...replay.json}); throws when MFX_REPLAY doesn't name a valid one. */
export function replayPack() {
  const dir = process.env.MFX_REPLAY;
  if (!dir) return null;
  if (packCache?.dir === dir) return packCache;
  const f = join(dir, 'replay.json');
  if (!existsSync(f)) throw new Error(`MFX_REPLAY=${dir}: no replay.json there (make one with tools/replay/make-pack.mjs)`);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  if (j.format !== REPLAY_FORMAT) throw new Error(`MFX_REPLAY=${dir}: replay.json is "${j.format}", not ${REPLAY_FORMAT}`);
  packCache = { ...j, dir: resolve(dir) };
  return packCache;
}

/** Throws unless this studio may run in replay: marked, and never the owner's default studio. */
export function replayCheck(root) {
  if (!replayOn()) return false;
  const r = real(root);
  if (r === real(join(homedir(), 'Mortiflix'))) throw new Error('replay mode refuses the default studio ~/Mortiflix');
  if (!existsSync(join(r, MARKER))) throw new Error(`replay mode needs a replay studio: ${root} has no ${MARKER} file`);
  replayPack();
  return true;
}

/** The studio's config as replay runs it (loadConfig calls this; a no-op when replay is off). */
export function replayConfig(root, cfg) {
  if (!replayOn()) return cfg;
  replayCheck(root);
  const out = { ...cfg, backend: 'replay', claudeBin: CLAUDE_STUB, sessionFallback: false, replayDelayMs: cfg.replayDelayMs ?? 1200 };
  delete out.browser;
  const vn = { ...(cfg.videoNotes || {}) };
  const inside = vn.folder && real(resolve(String(vn.folder))).startsWith(`${real(root)}/`);
  if (!inside) vn.folder = join(root, 'run', 'replay-tablet');
  // the tablet fault is a state, not one firing: the tablet stays offline while the faults file says so (every send
  // fails, whichever path queues it), and comes back when the fault is cleared
  if (process.env.MFX_REPLAY_TABLET_DOWN === '1' || peekFault(root, 'tablet')) vn.folder = '/proc/mfx-replay-tablet-offline';
  out.videoNotes = vn;
  return out;
}

// ---- faults ----
const faultsFile = (root) => join(root, 'run', 'replay-faults.json');
/** Whether a fault is armed, without taking it. */
export function peekFault(root, name) {
  if (!replayOn() || !root) return false;
  try { return (Number(JSON.parse(readFileSync(faultsFile(root), 'utf8'))[name]) || 0) > 0; } catch { return false; }
}
/** Takes one firing of a fault: true when it fires now. */
export function takeFault(root, name) {
  if (!replayOn() || !root) return false;
  const f = faultsFile(root);
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { return false; }
  const n = Number(j[name]) || 0;
  if (n <= 0) return false;
  j[name] = n - 1;
  writeFileSync(f, JSON.stringify(j));
  logReplay(root, { kind: 'fault', fault: name });
  return true;
}

export function logReplay(root, row) {
  try { mkdirSync(join(root, 'run', 'replay'), { recursive: true }); appendFileSync(join(root, 'run', 'replay', 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); } catch { /* the log is a help, not a need */ }
}

// ---- fail closed: real clients refuse to exist in replay ----
export function refuseReal(what) {
  if (replayOn()) throw new Error(`replay mode: ${what} must never be reached (MFX_REPLAY is set)`);
}

// ---- ElevenLabs stand-in ----
const ROUND = new Map();
/** The next recorded file of a pool (tts | music | sfx), round robin. */
export function poolFile(kind) {
  const p = replayPack();
  const list = (p.audio?.[kind] || []).map((f) => join(p.dir, f)).filter((f) => existsSync(f));
  if (!list.length) throw new Error(`replay pack has no ${kind} audio`);
  const i = ROUND.get(kind) || 0;
  ROUND.set(kind, i + 1);
  return list[i % list.length];
}

const ELEVEN = /(^|\.)elevenlabs\.io$/;

// The pack's recorded per-line takes (the voice step's sound/voice/lines/<id>.pcm + .json with the alignment).
function recordedTake(body) {
  const p = replayPack();
  const dir = p.steps?.voice?.work && join(p.dir, p.steps.voice.work, 'sound', 'voice', 'lines');
  if (!dir || !existsSync(dir)) return null;
  const takes = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); return { text: j.text, alignment: j.alignment || null, pcm: join(dir, f.replace(/\.json$/, '.pcm')) }; } catch { return null; }
  }).filter((t) => t && existsSync(t.pcm));
  if (!takes.length) return null;
  let text = null;
  try { text = JSON.parse(typeof body === 'string' ? body : '{}').text; } catch { /* not JSON */ }
  const same = text && takes.find((t) => t.text === text);
  if (same) return same;
  const i = ROUND.get('take') || 0;
  ROUND.set('take', i + 1);
  return takes[i % takes.length];
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function elevenAnswer(root, url, init) {
  const path = url.pathname;
  const method = String(init?.method || 'GET').toUpperCase();
  if (method !== 'GET' && takeFault(root, 'billing')) {
    return json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota (replay fault: billing 402).' } }, 402);
  }
  const audio = (kind) => {
    const f = poolFile(kind);
    logReplay(root, { kind: 'elevenlabs', path, file: f });
    return new Response(readFileSync(f), { status: 200, headers: { 'content-type': extname(f) === '.wav' ? 'audio/wav' : 'audio/mpeg', 'character-cost': '0', 'x-mfx-replay': '1' } });
  };
  if (/\/sound-generation/.test(path)) return audio('sfx');
  if (/\/music/.test(path)) return audio('music');
  if (/\/text-to-speech\/[^/]+\/with-timestamps/.test(path)) {
    // a recorded line take (the studio asks for PCM with timings): the one with the same words, else the next one
    const take = recordedTake(init?.body);
    if (take) {
      logReplay(root, { kind: 'elevenlabs', path, file: take.pcm });
      return json({ audio_base64: readFileSync(take.pcm).toString('base64'), alignment: take.alignment, normalized_alignment: take.alignment }, 200, { 'character-cost': '0', 'x-mfx-replay': '1' });
    }
    logReplay(root, { kind: 'elevenlabs-unknown', path, method, why: 'no recorded line take in the pack' });
    return json({ detail: { status: 'replay_unrecorded', message: 'replay: the pack has no recorded line take (sound/voice/lines)' } }, 404);
  }
  if (/\/text-to-speech\//.test(path)) return audio('tts');
  if (/\/user\/subscription/.test(path)) return json({ tier: 'replay', character_count: 0, character_limit: 1_000_000, next_character_count_reset_unix: null });
  if (/\/user$/.test(path)) return json({ subscription: { tier: 'replay', character_count: 0, character_limit: 1_000_000 } });
  if (/\/voices/.test(path)) return json({ voices: [{ voice_id: 'replay-voice', name: 'Replay voice', category: 'premade', labels: {} }], has_more: false });
  if (/\/models/.test(path)) return json([{ model_id: 'eleven_v4', name: 'Eleven v4 (replay)', maximum_text_length_per_request: 5000 }]);
  logReplay(root, { kind: 'elevenlabs-unknown', path, method });
  return json({ detail: { status: 'replay_unrecorded', message: `replay: no recording for ${method} ${path}` } }, 404);
}

/** Installs the replay fetch: ElevenLabs is answered from the pack, every other host refused. Idempotent. */
export function installReplayFetch(rootOf) {
  if (!replayOn() || globalThis.fetch?.mfxReplay) return;
  const fake = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const root = rootOf();
    if (ELEVEN.test(url.hostname)) return elevenAnswer(root, url, init);
    logReplay(root, { kind: 'blocked-fetch', url: `${url.origin}${url.pathname}` });
    throw new Error(`replay mode: network call to ${url.hostname} blocked`);
  };
  fake.mfxReplay = true;
  globalThis.fetch = fake;
}
export const isReplayFetch = (f) => Boolean(f?.mfxReplay);

// ---- the injected v3 studio parts (Runner `studio`): stills from the pack, the music plan from its recorded answer ----
export function replayStudio(root) {
  const p = replayPack();
  return {
    renderStill: async ({ line: lineId, output, props }) => {
      if (takeFault(root, 'render')) throw new Error('Kinetograph: the render failed (replay fault: render)');
      const line = lineId || String(props?.kicker || '').toLowerCase() || null;
      const dir = join(p.dir, p.stills || 'stills');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
      if (!files.length) throw new Error('replay pack has no stills');
      const pick = (line && files.find((f) => f === `${line}.png`)) || files[(ROUND.get('still') || 0) % files.length];
      ROUND.set('still', (ROUND.get('still') || 0) + 1);
      mkdirSync(join(output, '..'), { recursive: true });
      writeFileSync(output, readFileSync(join(dir, pick)));
      logReplay(root, { kind: 'still', line, file: pick });
    },
    ask: async () => {
      const f = p.claude?.['music-plan'] && join(p.dir, p.claude['music-plan']);
      if (!f || !existsSync(f)) throw new Error('replay pack has no recorded music plan');
      logReplay(root, { kind: 'claude-ask', role: 'music-plan' });
      return readFileSync(f, 'utf8');
    },
  };
}
