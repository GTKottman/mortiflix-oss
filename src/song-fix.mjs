// The studio's side of Fix, fast (doc 28 §4.5): run the fast path for a section's edit request before any session.
// It answers through the project's backend in one short call; the demo backend answers by itself (doc 26 §8).
// Backends without a fast call yet (the real Claude call is M11) leave the request to a session, as before.
import { loadConfig } from './studio.mjs';
import { syncCanvas, finishEdit, setEditState, loadEdits } from './canvas.mjs';
import { event } from './projects.mjs';
import { fastFix } from './strudel/fix.mjs';
import { songWriteStrudel } from './song-ai.mjs';
import { undo } from './song-ops.mjs';
import { loadSong } from './song-store.mjs';
import { ticksPerBar } from './song.mjs';
import { notesToIdiomatic } from './strudel/notes.mjs';

// The demo's fixed answer: each asked part's bars up an octave (the drums thinned); after a refusal, thinned.
export function demoAsk(root, id) {
  return async (prompt) => {
    const { song } = loadSong(root, id);
    const tpb = ticksPerBar(song.meter[0]);
    const retry = /was refused/.test(prompt.user);
    return prompt.asked.map((x) => {
      const p = song.patterns.find((q) => q.id === x.section);
      const c = song.channels.find((q) => q.id === x.part);
      const [a, b] = x.bars;
      const take = (from, to) => (p.notes[x.part] || []).filter((n) => n.t >= (from - 1) * tpb && n.t < to * tpb).map((n) => ({ ...n, vel: n.vel ?? 0.8, t: n.t - (from - 1) * tpb }));
      let ns = take(a, b);
      if (!ns.length && a > 1) {
        // new empty bars ("Let the AI write them"): the bars just before, played again
        const k = b - a + 1;
        ns = take(Math.max(1, a - k), a - 1).filter((n) => n.t < k * tpb);
      } else if (c.kind === 'drums' || retry) ns = ns.filter((_, i) => i % 2 === 0);
      else ns = ns.map((n) => ({ ...n, key: Math.min(127, n.key + 12) }));
      const code = ns.length ? notesToIdiomatic(ns, { bars: b - a + 1, ticksPerBar: tpb, drums: c.kind === 'drums' }) : 'silence';
      return `// begin ${x.section} ${x.part} bars ${a}-${b}\n${code}\n// end ${x.section} ${x.part}`;
    }).join('\n');
  };
}

export function fastFixAvailable(root) { return loadConfig(root).backend === 'demo'; }

// Runs in the background after a Fix on a section with bars. Never throws: the edit ends done, or back to requested.
export async function runFastFix(root, id, editId) {
  const edit = loadEdits(root, id).find((e) => e.id === editId);
  if (!edit || edit.kind !== 'cue' || !fastFixAvailable(root) || !loadSong(root, id)) return { ok: false, skipped: true };
  setEditState(root, id, editId, 'fast');
  const t0 = performance.now();
  try {
    const r = await fastFix(root, id, edit, {
      ask: demoAsk(root, id),
      write: (blk) => songWriteStrudel(root, id, { section: blk.section, part: blk.part, bars: blk.bars, code: blk.code, edit: editId }),
      undoLast: () => undo(root, id),
    });
    const ms = Math.round(performance.now() - t0);
    if (r.ok) {
      syncCanvas(root, id);
      finishEdit(root, id, editId, { ok: true, note: `Fixed at once (${r.tries} ${r.tries === 1 ? 'try' : 'tries'}, ${ms} ms).`, via: 'fast' });
      return { ok: true, ...r, ms };
    }
    setEditState(root, id, editId, 'requested', { tried: r.reasons.slice(-3) });
    event(root, id, { event: 'FIX_FAST_GAVE_UP', details: `${editId}: ${r.reasons.at(-1)}` });
    return { ok: false, ...r, ms };
  } catch (e) {
    try { setEditState(root, id, editId, 'requested', { tried: [e.message] }); } catch { /* the edit is gone */ }
    return { ok: false, error: e.message };
  }
}
