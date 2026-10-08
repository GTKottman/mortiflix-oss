// The genre a song is written from (from Mini Music, unchanged in substance): what a researched genre profile must hold
// (checked before anything trusts it), how it reads as text (music/GENRE.md), and the genre-signature check that makes a
// song's blueprint name which of the genre's unforgettable elements carry its hook and its beat.

export const METERS = ['4/4', '3/4', '2/4', '5/4', '7/4', '6/8', '9/8', '12/8'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const HARMONY = ['bass', 'chords', 'melody', 'pedal', 'noise', 'drums'];
export const ELEMENT_AREAS = ['hook', 'beat', 'bass', 'harmony', 'texture', 'arrangement'];

// A URL compared by what it points at: no fragment, no trailing slash, no "www.", lower-case host.
export const normUrl = (u) => { try { const x = new URL(String(u).trim()); return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`; } catch { return null; } };

export const PROFILE_SCHEMA = `{
  "name": "the genre's usual name",
  "aliases": ["other names"],
  "summary": "what the genre is, in 2-4 sentences a newcomer understands",
  "meaning": "what it expresses and where it comes from: the scene, the culture, why people make it (a paragraph)",
  "lineages": ["parent style: what it contributes"],
  "tempo": {"min": 70, "max": 100, "typical": 88},
  "meters": ["4/4"],                    // only these values: ${METERS.join(', ')} (describe half-time and similar feels in "feel")
  "feel": "subdivision, swing amount, where the groove sits (ahead / on / behind the beat)",
  "lineup": [{"role": "Breakbeat drums", "harmony": "drums (one of: bass, chords, melody, pedal, noise, drums)", "register": "", "sounds": "what it typically sounds like", "job": "its job in the music", "density": "how busy", "enters": "when it usually comes in"}],
  "beat": {"description": "the groove in words", "grids": [{"name": "Main groove", "steps": 16, "parts": {"kick": "x.....x...x.....", "snare": "....X.......X..g", "hat": "x.x.x.x.x.x.x.x."}}], "variations": ["fills, drops, half-time switches..."]},
  "bass": "how the bass behaves against the drums and the chords",
  "harmony": {"modes": ["minor", "dorian"], "progressions": ["i - VI - III - VII (e.g. Am F C G)"], "rhythm": "how often chords change", "voicings": "typical voicings and extensions"},
  "hook": {"range": "", "intervals": "", "rhythm_cells": "", "ornaments": "", "traits": ["what makes a hook in this genre"]},
  "sound": "sound design and mix character",
  "arrangement": "typical form, section lengths, how energy is built and released",
  "length": {"min_sec": 240, "max_sec": 360, "typical_sec": 300, "note": "how long tracks in this genre usually run, and why"},
  "unforgettable": [{"id": "kebab-case-id", "area": "hook | beat | bass | harmony | texture | arrangement", "element": "the element in a few words", "why": "why listeners remember it", "how": "exactly how to write it in notes (rhythm, pitches, placement)"}],
  "avoid": ["clichés and mistakes that make it sound fake"],
  "references": [{"artist": "", "title": "", "why": "what to study in it (never copy it)"}],
  "sources": [{"url": "https://...", "title": "", "used_for": "what this source told you"}]
}`;

// Problems with a researched profile (empty = fine). Every cited source must be a page the session actually read.
export function profileProblems(o) {
  const p = [];
  if (!isObj(o)) return ['The profile must be one JSON object.'];
  if (!isStr(o.name)) p.push('"name" is missing.');
  if (!isStr(o.summary, 80)) p.push('"summary" must say what the genre is (at least a few sentences).');
  if (!isStr(o.meaning, 120)) p.push('"meaning" must explain what the genre expresses and where it comes from (a paragraph).');
  const t = o.tempo || {};
  if (![t.min, t.max, t.typical].every(isNum) || t.min < 40 || t.max > 220 || !(t.min <= t.typical && t.typical <= t.max)) p.push('"tempo" needs numbers min <= typical <= max, all within 40-220 BPM.');
  if (!Array.isArray(o.meters) || !o.meters.length) p.push('"meters" must list at least one meter.');
  else for (const m of o.meters) if (!METERS.includes(m)) p.push(`meter "${m}" is not one this studio writes (${METERS.join(', ')}).`);
  if (!isStr(o.feel, 20)) p.push('"feel" must describe the subdivision and swing.');
  if (!Array.isArray(o.lineup) || o.lineup.length < 3 || o.lineup.length > 16) p.push('"lineup" needs 3 to 16 roles.');
  else o.lineup.forEach((r, i) => {
    if (!isStr(r?.role)) p.push(`lineup[${i}].role is missing.`);
    if (!HARMONY.includes(r?.harmony)) p.push(`lineup[${i}].harmony must be one of ${HARMONY.join(', ')}.`);
    if (!isStr(r?.job, 8)) p.push(`lineup[${i}].job should say what the role does.`);
  });
  const grids = o.beat?.grids;
  if (!isStr(o.beat?.description, 20)) p.push('"beat.description" must describe the groove.');
  if (!Array.isArray(grids) || !grids.length) p.push('"beat.grids" needs at least one step grid.');
  else grids.forEach((g, i) => {
    if (![8, 12, 16, 24, 32].includes(g?.steps)) p.push(`beat.grids[${i}].steps must be 8, 12, 16, 24 or 32.`);
    if (!isObj(g?.parts) || !Object.keys(g.parts).length) p.push(`beat.grids[${i}].parts needs at least one drum row.`);
    else for (const [k, row] of Object.entries(g.parts)) {
      if (typeof row !== 'string' || !/^[xXg.]+$/.test(row)) p.push(`beat.grids[${i}].parts.${k} must use only x (hit), X (accent), g (ghost) and . (rest).`);
      else if (row.length !== g.steps) p.push(`beat.grids[${i}].parts.${k} has ${row.length} steps; the grid has ${g.steps}.`);
    }
  });
  if (!isStr(o.bass, 20)) p.push('"bass" must describe how the bass behaves.');
  if (!Array.isArray(o.harmony?.modes) || !o.harmony.modes.length || !Array.isArray(o.harmony?.progressions) || !o.harmony.progressions.length) p.push('"harmony" needs "modes" and "progressions".');
  if (!isObj(o.hook) || !Array.isArray(o.hook.traits) || !o.hook.traits.length) p.push('"hook.traits" must list what makes a hook in this genre.');
  if (!isStr(o.arrangement, 20)) p.push('"arrangement" must describe the typical form.');
  const L = o.length || {};
  if (![L.min_sec, L.max_sec, L.typical_sec].every(isNum) || L.min_sec < 15 || L.max_sec > 1800 || !(L.min_sec <= L.typical_sec && L.typical_sec <= L.max_sec)) p.push('"length" needs min_sec <= typical_sec <= max_sec (how long tracks in this genre usually run, in seconds).');
  const els = o.unforgettable;
  if (!Array.isArray(els) || els.length < 5 || els.length > 14) p.push('"unforgettable" needs 5 to 14 elements.');
  else {
    const ids = new Set();
    els.forEach((e, i) => {
      if (!isStr(e?.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) p.push(`unforgettable[${i}].id must be kebab-case.`); else if (ids.has(e.id)) p.push(`unforgettable id "${e.id}" is used twice.`); else ids.add(e.id);
      if (!ELEMENT_AREAS.includes(e?.area)) p.push(`unforgettable[${i}].area must be one of ${ELEMENT_AREAS.join(', ')}.`);
      if (!isStr(e?.element, 3) || !isStr(e?.why, 10) || !isStr(e?.how, 20)) p.push(`unforgettable[${i}] needs "element", "why" and a concrete "how" (rhythm, pitches, placement).`);
    });
  }
  if (Array.isArray(els)) for (const area of ['hook', 'beat']) if (!els.some((e) => e?.area === area)) p.push(`"unforgettable" must include at least one element for the ${area}.`);
  if (!Array.isArray(o.avoid) || o.avoid.length < 2) p.push('"avoid" must list at least 2 clichés or mistakes.');
  if (!Array.isArray(o.references) || o.references.length < 2) p.push('"references" must list at least 2 tracks to study.');
  const src = Array.isArray(o.sources) ? o.sources : [];
  const urls = [...new Set(src.map((s) => normUrl(s?.url)).filter(Boolean))];
  if (urls.length < 5) p.push(`"sources" must cite at least 5 different web pages you read (found ${urls.length}).`);
  return p;
}

export const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const list = (a) => (Array.isArray(a) && a.length ? a.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '');
// The profile as markdown. full=false leaves out the sources and references (the song prompts don't need them).
export function profileMarkdown(o, { full = true } = {}) {
  if (!o) return '';
  const grid = (g) => `${g.name} (${g.steps} steps; x hit, X accent, g ghost):\n\`\`\`\n${Object.entries(g.parts).map(([k, row]) => `${k.padEnd(8)} ${row}`).join('\n')}\n\`\`\``;
  const parts = [
    `# ${o.name}${o.aliases?.length ? ` (also: ${o.aliases.join(', ')})` : ''}`,
    o.summary, `## What it means\n${o.meaning}`, o.lineages?.length ? `## Lineages\n${list(o.lineages)}` : '',
    `## Tempo and feel\n${o.tempo.min}-${o.tempo.max} BPM (typically ${o.tempo.typical}), ${o.meters.join(', ')}. ${o.feel}`,
    o.length ? `## Length\nTracks run ${fmtSec(o.length.min_sec)}-${fmtSec(o.length.max_sec)} (typically ${fmtSec(o.length.typical_sec)}).${o.length.note ? ` ${o.length.note}` : ''}` : '',
    `## Instrument lineup\n${o.lineup.map((r) => `- **${r.role}** (${r.harmony}${r.register ? `, ${r.register}` : ''}): ${r.job}${r.sounds ? `. Sounds: ${r.sounds}` : ''}${r.density ? `. Density: ${r.density}` : ''}${r.enters ? `. Enters: ${r.enters}` : ''}`).join('\n')}`,
    `## The beat\n${o.beat.description}\n\n${o.beat.grids.map(grid).join('\n\n')}${o.beat.variations?.length ? `\n\nVariations:\n${list(o.beat.variations)}` : ''}`,
    `## Bass\n${o.bass}`,
    `## Harmony\nModes: ${o.harmony.modes.join(', ')}.\nProgressions:\n${list(o.harmony.progressions)}${o.harmony.rhythm ? `\nHarmonic rhythm: ${o.harmony.rhythm}` : ''}${o.harmony.voicings ? `\nVoicings: ${o.harmony.voicings}` : ''}`,
    `## Hooks and melody\n${['range', 'intervals', 'rhythm_cells', 'ornaments'].filter((k) => o.hook[k]).map((k) => `${k.replace('_', ' ')}: ${o.hook[k]}`).join('\n')}\n${list(o.hook.traits)}`,
    o.sound ? `## Sound\n${o.sound}` : '', `## Arrangement\n${o.arrangement}`,
    `## What makes it unforgettable\n${o.unforgettable.map((e) => `- **${e.id}** [${e.area}] ${e.element}: ${e.why}\n  How: ${e.how}`).join('\n')}`,
    `## Avoid\n${list(o.avoid)}`,
    full ? `## Tracks to study\n${o.references.map((r) => `- ${r.artist}: ${r.title}${r.why ? ` (${r.why})` : ''}`).join('\n')}` : '',
    full ? `## Sources\n${o.sources.map((s) => `- [${s.title || s.url}](${s.url})${s.used_for ? `: ${s.used_for}` : ''}`).join('\n')}` : '',
  ];
  return parts.filter(Boolean).join('\n\n') + '\n';
}

// The genre-signature check for a song blueprint: the song must say which unforgettable elements carry its hook and its beat.
export function signatureProblems(sig, profile) {
  if (!profile?.unforgettable?.length) return [];
  const ids = new Map(profile.unforgettable.map((e) => [e.id, e])); const p = [];
  if (!Array.isArray(sig) || !sig.length) return ['"genre_signature" must list the genre elements this song uses for its hook and its beat (ids from the genre profile).'];
  for (const [i, s] of sig.entries()) {
    if (!ids.has(s?.id)) p.push(`genre_signature[${i}].id "${s?.id}" is not an element of the genre profile (use one of: ${[...ids.keys()].join(', ')}).`);
    if (!['hook', 'beat', 'bass', 'harmony', 'texture', 'arrangement'].includes(s?.carries)) p.push(`genre_signature[${i}].carries must be hook, beat, bass, harmony, texture or arrangement.`);
    if (!isStr(s?.how, 15) || !isStr(s?.where, 3)) p.push(`genre_signature[${i}] needs "how" this song uses it and "where" (which sections).`);
  }
  for (const area of ['hook', 'beat']) if (!sig.some((s) => s?.carries === area && ids.has(s?.id))) p.push(`"genre_signature" must name at least one genre element that carries the ${area}.`);
  return p;
}

