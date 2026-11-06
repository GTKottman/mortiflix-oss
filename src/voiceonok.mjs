// The voice starts when the owner OKs a scene (owner, 2026-10-19: "the voice should technically start being generated
// when the person okays the line"): that scene's lines are recorded in the background with the studio's ElevenLabs
// voice, into the same cache the voice step uses (sound/voice/lines), so by the time the Script gate passes most of
// the voice is already there. Lines recorded before are kept; a line whose words changed is recorded again. One scene
// at a time per project, in the order they were OK'd.
import { projectPaths } from './projects.mjs';
import { scriptView } from './svc/script.mjs';
import { linesFromScript } from './quickvoice.mjs';
import { voiceConfig, elevenKey } from './voice/index.mjs';
import { recordLines } from './soundtrack/voice.mjs';
import { askFirst, checkCap } from './svc/paidgate.mjs';
import { ttsCredits } from './svc/ledger.mjs';
import { narratorVoice } from './svc/voicecast.mjs';
import { narratorTake } from './svc/voicecost.mjs';

const queues = new Map(); // project -> the promise of its last scene

// The voice step waits for this before it records (owner, 2026-11-02: a scene's OK and the voice step recorded the same
// 7 lines at once, 23 calls for 16 lines).
export function voiceQueueIdle(id) { return queues.get(id) || Promise.resolve(); }

export function voiceOnOk(root, id, beat, onActivity = () => {}) {
  const v = voiceConfig(root);
  if (v.engine !== 'elevenlabs') return null;
  // cost first (paid.ask_first, the default): a scene's OK records nothing. The voice is made once, after the script,
  // when the owner OKs its cost and voice (src/svc/paidgate.mjs).
  if (askFirst(root)) return null;
  const key = elevenKey(root);
  if (!key) return null;
  const el = v.elevenlabs;
  const scene = String(beat).replace(/^b0*/, '');
  const say = (text, extra = {}) => onActivity({ project: id, kind: 'voice', scene: beat, engine: 'ElevenLabs', voice: el.voice_name || null, text, ...extra });
  const job = async () => {
    const lines = linesFromScript(scriptView(root, id)).filter((l) => l.id.startsWith(`${beat}-`));
    if (!lines.length) return;
    const n = narratorVoice(root, id); const t = narratorTake(root, n);
    const take = {
      work: projectPaths(root, id).work, key, lines, voice: n.name || el.voice_name || 'the studio voice', voiceId: t.voiceId, model: t.model,
      stability: t.stability, similarity: t.similarity, speakerBoost: t.speakerBoost,
    };
    // the daily credit cap holds here too (svc/paidgate.mjs checkCap): this path records without a cost OK. Only the
    // lines with no take yet count (confirm: false plans and records nothing).
    const plan = await recordLines({ ...take, confirm: false });
    if (plan.needs_confirm) checkCap(root, ttsCredits(t.model, plan.characters));
    const r = await recordLines({
      ...take,
      log: (_t, at) => say(`Recording scene ${scene}'s voice: line ${at.line.replace(/^b0*/, '')} (${at.n} of ${at.of}) on ElevenLabs${el.voice_name ? `, ${el.voice_name}` : ''}`, { line: at.line, n: at.n, of: at.of, state: 'recording' }),
    });
    say(r.recorded.length ? `Scene ${scene}'s voice recorded: ${r.recorded.length} line${r.recorded.length === 1 ? '' : 's'} on ElevenLabs` : `Scene ${scene}'s voice was already recorded`, { state: 'done', recorded: r.recorded });
  };
  const next = (queues.get(id) || Promise.resolve()).then(job).catch((e) => say(`Scene ${scene}'s voice failed: ${e.message}`, { state: 'failed' }));
  queues.set(id, next);
  return next;
}
