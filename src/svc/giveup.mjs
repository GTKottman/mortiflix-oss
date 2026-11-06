// T1: a quick path that can't finish no longer starts a full session (fallback from 1.0 to 3.5M tokens each; a repair
// call costs 15-40k). The ladder: one small repair call that sees only the failure, then the project pauses with the
// plain reason and the last artifacts. A session runs only when the owner presses "Let the AI take over"
// (project.takeover) or the studio is set to `sessionFallback: true`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../studio.mjs';
import { loadProject, event, update, now } from '../projects.mjs';
import { needsYou } from '../gates.mjs';
import { runAs } from '../models.mjs';
import { failureSignature, fixText, HARD } from './failures.mjs';

export const REPAIR_SCHEMA = { type: 'object', required: ['cause', 'next'], properties: {
  cause: { type: 'string', description: 'one plain sentence: what went wrong' },
  next: { type: 'string', description: 'one plain sentence: the one thing the owner should do or try' },
} };

export const repairPrompt = (label, why) => [
  `The studio's own code was making the ${label} and could not finish. Failure, verbatim:`,
  `"""\n${String(why).slice(0, 1500)}\n"""`,
  'Answer with the JSON asked for: `cause` (one plain sentence, no jargon) and `next` (the one thing the owner should do or try). You have no tools: do not guess at files you cannot see. Nothing else.',
].join('\n\n');

export const takeoverRequested = (root, id) => Boolean(loadProject(root, id).mfx?.takeover);

// The runner's `fallback(why)` for the quick paths. `run` = the backend's run (null: no repair call), `session` = a
// function that runs the full session (only on takeover / sessionFallback).
export function makeFallback({ root, id, run, runArgs, config, onActivity = () => {}, session, label = 'step' }) {
  return async (why = 'it gave no reason') => {
    why = String(why);
    event(root, id, { event: 'QUICK_GAVE_UP', actor: 'studio', details: `${label}: ${why}`.slice(0, 400) });
    if (config.sessionFallback === true || takeoverRequested(root, id)) {
      if (takeoverRequested(root, id)) update(root, id, (p) => { if (p.mfx) delete p.mfx.takeover; });
      onActivity({ kind: 'info', text: `The studio couldn't finish the ${label} by itself (${why}): a session does it (you allowed it).` });
      return session();
    }
    const sig = failureSignature(why);
    const usage = { input_tokens: 0, output_tokens: 0 };
    let cause = '';
    let next = '';
    // One repair call, only for failures an AI can say something about: not for a missing tool, a hard machine or
    // account failure, or a stop.
    const environment = /could not find the approved|no render queue|isn'?t set up|couldn'?t be fetched|no ElevenLabs key|not set|brief asks for no music/i.test(why);
    if (run && !sig && !environment && !runArgs?.signal?.aborted) {
      try {
        const dir = join(paths(root).run, 'quick');
        mkdirSync(dir, { recursive: true });
        const r = await runAs(run, 'codefix', { ...runArgs, workdir: dir, prompt: repairPrompt(label, why), config: { ...config, claudeArgs: ['--tools', '', '--json-schema', JSON.stringify(REPAIR_SCHEMA)] } });
        usage.input_tokens += r.usage?.input_tokens || 0;
        usage.output_tokens += r.usage?.output_tokens || 0;
        if (r.structured?.cause) { cause = String(r.structured.cause).trim(); next = String(r.structured.next || '').trim(); }
      } catch { /* the plain reason is enough */ }
    }
    const text = [`The ${label} couldn't be finished by the studio: ${why.slice(0, 400)}`, cause && `Likely cause: ${cause}`, next || fixText(sig) || 'Check the activity log, then press Resume, or press "Let the AI take over" to have a full session try (it costs far more).'].filter(Boolean).join(' ');
    onActivity({ kind: 'error', text });
    needsYou(root, id, text);
    update(root, id, (p) => { p.needs_you = { ...p.needs_you, at: now(), cause: sig && HARD.has(sig) ? sig : 'gave-up', takeover: true }; });
    return { ok: false, paused: true, error: why, usage };
  };
}
