// Two things a full piece owes the owner, held by `strudel.mjs plan`:
//
//   partsProblems(bp, genre)     a full song or MIDI pack is a full arrangement: at least 6 parts, each on its own
//                                channel (a loop kit, or a piece whose brief fixed it small, may be leaner)
//   varietyProblems(bp, recent)  it isn't the last piece again: not the same key, tempo and opening progression as one
//                                of the owner's recent pieces (music/recent.json, written by the studio before a session)

export const MIN_PARTS = 6;

// A full piece: researched from a genre (songs and MIDI packs), not a loop kit, length not fixed small by the brief.
export const isFullPiece = (bp, genre) => Boolean(genre) && !bp.loops && !bp.length_fixed;

export function partsProblems(bp, genre) {
  if (!isFullPiece(bp, genre)) return [];
  const n = (bp.roles || []).length;
  if (n >= MIN_PARTS) return [];
  return [`blueprint.json: ${n} part${n === 1 ? '' : 's'} is a sketch, not a full arrangement: a full piece has at least ${MIN_PARTS} (most land at 7-10), each on its own channel with its own job. Start from the genre's lineup (${(genre.lineup || []).map((r) => r.role).join(', ') || 'see GENRE.md'}) and add the counter-lines, textures, percussion and doubles the story needs.`];
}

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#]/g, '').replace(/major$|maj$/, 'major').replace(/minor$|min$|aeolian$/, 'minor');
const flat = (chart) => (chart || []).flatMap((c) => (c.chords || []).flat()).map((x) => String(x).replace(/\s+/g, '').toLowerCase());
export const opening = (bp) => flat(bp.chart).slice(0, 4);

export function varietyProblems(bp, recent = []) {
  const errors = []; const warnings = [];
  const mine = opening(bp);
  for (const r of recent || []) {
    if (!r || !r.bpm) continue;
    const sameKey = key(r.scale) && key(r.scale) === key(bp.scale);
    const near = Math.abs(Number(r.bpm) - Number(bp.bpm)) <= 3;
    const sameStart = mine.length >= 2 && (r.opening || []).length >= 2 && mine.join(' ') === (r.opening || []).map((x) => String(x).replace(/\s+/g, '').toLowerCase()).join(' ');
    if (sameKey && near && sameStart) errors.push(`blueprint.json: this is "${r.title}" again: the same key (${bp.scale}), tempo (${bp.bpm} vs ${r.bpm} BPM) and opening progression (${mine.join(' ')}). Change at least two of them: every piece should sound like itself.`);
    else if ((sameKey && near) || (sameKey && sameStart) || (near && sameStart)) warnings.push(`close to "${r.title}" (${[sameKey ? `same key ${bp.scale}` : null, near ? `${r.bpm} BPM` : null, sameStart ? 'same opening progression' : null].filter(Boolean).join(', ')}): make sure it doesn't sound like it`);
  }
  return { errors, warnings };
}
