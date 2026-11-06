// Reading Strudel text without running it: where the code is (outside strings and comments), how deep in brackets,
// the statement that makes the music, its sound-only ending, and top-level comma-separated parts with their positions.
// Used by the edit ladder (edit.mjs) and the song file (songfile.mjs).

export const SOUND = new Set(('s sound bank gain postgain pan orbit lpf lpq hpf hpq bpf bpq cutoff resonance hcutoff hresonance bandf ' +
  'bandq ftype lpenv hpenv bpenv lpattack lpdecay lpsustain lprelease hpattack hpdecay hpsustain hprelease room roomsize size ' +
  'roomfade roomlp roomdim dry delay delaytime delayfeedback delayfb attack decay sustain release adsr att dec sus rel shape ' +
  'distort crush coarse vowel phaser phaserdepth phasercenter phasersweep chorus tremolo tremolodepth tremolosync vib vibmod ' +
  'fm fmh fmi fmenv fmattack fmdecay fmsustain fmrelease compressor speed begin end loop cut color punchcard pianoroll scope ' +
  'spectrum analyze _punchcard _pianoroll _scope _spectrum').split(' '));

// Walks the text outside strings and comments, calling visit(i, ch, depth) for every code character.
export function walk(code, visit) {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; i--; continue; }
    if (ch === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? code.length : j + 1; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (visit(i, ch, depth) === false) return;
  }
}

// { head, expr }: the last statement (the one that makes the music) and the lines before it.
export function lastStatement(code) {
  let cut = 0;
  walk(code, (i, ch, depth) => {
    if (depth !== 0) return;
    if (ch === ';') cut = i + 1;
    if (ch === '\n') { const rest = code.slice(i + 1).match(/^\s*(\S)/); if (rest && rest[1] !== '.' && !/[=+\-*/,(&|?:]\s*$/.test(code.slice(0, i))) cut = i + 1; }
  });
  return { head: code.slice(0, cut), expr: code.slice(cut).trim() };
}

// Splits "X.s(…).lpf(…)" into the music X and its sound-only ending.
export function splitSound(expr) {
  const calls = [];   // [dot, end] of each top-level .name(…)
  let open = null;
  walk(expr, (i, ch, depth) => {
    if (ch === '.' && depth === 0) { const m = expr.slice(i).match(/^\.\s*([A-Za-z_$][\w$]*)\s*\(/); if (m) open = { dot: i, name: m[1] }; }
    if (ch === ')' && depth === 0 && open) { calls.push({ ...open, end: i + 1 }); open = null; }
  });
  let at = expr.length;
  for (let k = calls.length - 1; k >= 0; k--) {
    const c = calls[k];
    if (!SOUND.has(c.name) || expr.slice(c.end, at).trim()) break;
    at = c.dot;
  }
  return { music: expr.slice(0, at).trimEnd(), sound: expr.slice(at) };
}

// Top-level comma-separated parts of a text.
export function commaParts(text) {
  const parts = [];
  let from = 0;
  walk(text, (i, ch, depth) => { if (ch === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; } });
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

// The index of the bracket that closes the one at `open` (code outside strings and comments), or -1.
export function closing(code, open) {
  let found = -1;
  const base = { depth: null };
  walk(code, (i, ch, depth) => {
    if (i < open) return;
    if (i === open) { base.depth = depth - 1; return; }
    if (')]}'.includes(ch) && depth === base.depth) { found = i; return false; }
  });
  return found;
}

// Top-level comma-separated parts of code[from, to), with positions: [{ start, end, text }] (text trimmed).
export function partsAt(code, from, to) {
  const out = [];
  let start = from;
  const inner = code.slice(from, to);
  walk(inner, (i, ch, depth) => { if (ch === ',' && depth === 0) { out.push([start, from + i]); start = from + i + 1; } });
  out.push([start, to]);
  return out.map(([a, z]) => {
    const { first, last } = codeSpan(code.slice(a, z));
    if (first < 0) return null;
    return { start: a + first, end: a + last + 1, text: code.slice(a + first, a + last + 1) };
  }).filter(Boolean);
}

// The first and last characters of code in a text (strings count as code; spaces and comments don't), or -1.
export function codeSpan(text) {
  let first = -1; let last = -1;
  const mark = (i) => { if (first < 0) first = i; last = i; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      mark(i);
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      i = Math.min(j, text.length - 1);
      mark(i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 1; continue; }
    if (!/\s/.test(ch)) mark(i);
  }
  return { first, last };
}
