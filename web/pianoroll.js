// The Piano roll, read-only for now (doc 20 P1): one pattern (a part in a section) with the section's other parts as
// ghost notes, rows outside the song's scale shaded, the rows that fit each chord lit (its notes bright, the tensions a
// melody may hold faint, like Visual-Harmonics' bands: github.com/elias1328/Visual-Harmonics), the chord row, the bar ruler with the cut marks, the playhead,
// the Channel Rack column on the left (picking a part) and the part's Strudel row on the right (doc 28 §5.1), the bar
// under the pointer highlighted in both. Editing comes with P2.

const PARTS_W = 150;
const KEYS_W = 36;
const RULER = 18;
const CHORDS = 14;
const PANE_W = 300;
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const GM = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 40: 'snare', 41: 'low tom', 42: 'closed hat', 43: 'tom', 44: 'pedal hat', 45: 'mid tom', 46: 'open hat', 47: 'tom', 48: 'high tom', 49: 'crash', 51: 'ride', 54: 'tamb', 56: 'cowbell', 70: 'shaker' };
const MODES = { major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10] };
const ROOTS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const css = (el, name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

// Pitch classes of the song's scale (null when there is none: nothing is shaded).
export function scaleClasses(scale) {
  if (!scale?.root) return null;
  const root = ROOTS[scale.root] ?? ROOTS[scale.root[0].toUpperCase() + scale.root.slice(1)];
  const steps = MODES[String(scale.mode || 'major').toLowerCase()];
  if (root === undefined || !steps) return null;
  return new Set(steps.map((s) => (root + s) % 12));
}

// The rows shown: the active part's range plus 2 semitones each side, at least 2 octaves (doc 20 §1.2).
export function keyRange(notes) {
  if (!notes.length) return [48, 72];
  let lo = Math.min(...notes.map((n) => n.key)) - 2;
  let hi = Math.max(...notes.map((n) => n.key)) + 2;
  while (hi - lo < 24) { if (lo > 0) lo--; if (hi - lo < 24 && hi < 127) hi++; }
  return [Math.max(0, lo), Math.min(127, hi)];
}

// The chords of each bar of the section, from the chart (song bars): [] for none, one symbol, or two for a bar split
// in halves.
export function chordsFor(chart, startBar, bars) {
  if (!Array.isArray(chart)) return [];
  const out = [];
  for (let b = 0; b < bars; b++) {
    const bar = startBar + b;
    const row = chart.find((r) => Array.isArray(r.bars) && bar >= r.bars[0] && bar <= r.bars[1]);
    const cell = row ? row.chords[(bar - row.bars[0]) % row.chords.length] : null;
    out.push(cell ? [cell].flat() : []);
  }
  return out;
}

// How a row fits a chord: 2 a chord tone, 1 a tension a melody may hold, 0 neither (fits: the service's chord notes).
export function fitOf(fits, sym, key) {
  const f = fits?.[sym];
  if (!f) return 0;
  const pc = ((key % 12) + 12) % 12;
  return f.tones.includes(pc) ? 2 : f.tens.includes(pc) ? 1 : 0;
}

// view: { song, rows (Strudel per section/part), chart, muted }; at: { section, part }; lane timing from the song
// lane (ax, sections, cuts); onPick(part) picks another part, onOpenPart(part) goes to level 3.
export function pianoRoll({ h, view, at, cuts = [], ax, sectionInfo, onPick = () => {}, onOpenPart = () => {} }) {
  const { song } = view;
  const pat = song.patterns.find((p) => p.id === at.section);
  const active = song.channels.find((c) => c.id === at.part) || song.channels[0];
  const tpb = ax.tpb;
  const bars = pat.bars;
  const notes = (pat.notes[active.id] || []).map((n) => ({ ...n, vel: n.vel ?? 0.8 }));
  const muted = (view.muted || []).filter((m) => m.pattern === pat.id && m.channel === active.id).map((m) => m.note);
  const ghosts = song.channels.filter((c) => c.id !== active.id).map((c) => ({ c, notes: pat.notes[c.id] || [] }));
  const drums = active.kind === 'drums';
  const [lo, hi] = keyRange([...notes, ...muted]);
  const scale = drums ? null : scaleClasses(song.scale);
  const chords = chordsFor(view.chart, sectionInfo.startBar, bars);
  const strudel = view.rows?.[pat.id]?.[active.id] || '';
  let hoverBar = null;

  // the Channel Rack column (read-only here): a row per part; picking one makes it the active part
  const rack = h('ul', { class: 'pr-rack', 'aria-label': 'Parts' }, song.channels.map((c) => h('li', null,
    h('button', { class: `pr-part${c.id === active.id ? ' on' : ''}`, title: c.id === active.id ? `${c.name}: double-click for its instrument` : `Show ${c.name}`, onclick: () => onPick(c.id), ondblclick: () => onOpenPart(c.id) },
      h('i', { class: 'pr-dot', style: { background: c.colour || 'var(--muted)' } }), h('span', { class: 'pr-name' }, c.name),
      h('span', { class: 'pr-ms' }, h('b', { class: c.mute ? 'on' : '' }, 'M'), h('b', { class: c.solo ? 'on' : '' }, 'S'))))));
  const canvas = h('canvas', { class: 'pr-canvas', role: 'img', 'aria-label': `${active.name} in ${pat.id}: ${notes.length} notes, bars ${sectionInfo.startBar}–${sectionInfo.startBar + bars - 1}` });
  const playhead = h('div', { class: 'pr-playhead', 'aria-hidden': 'true' });
  const grid = h('div', { class: 'pr-grid' }, canvas, playhead);
  const code = h('pre', { class: 'pr-code', 'aria-label': `${active.name}'s Strudel in ${pat.id}` });
  const pane = h('div', { class: 'pr-pane' }, h('div', { class: 'pr-pane-head' }, `Strudel · ${pat.id} ${active.name}`), code);
  const el = h('div', { class: 'pr' }, rack, grid, pane);

  // the text: one line per line of the row; bar lines of the line-per-bar form highlight with the bar under the pointer
  function drawCode() {
    const lines = strudel.split('\n');
    // a line-per-bar row: the lines between `< and >` are bars 1, 2, …
    const first = lines.findIndex((l) => /`<\s*$/.test(l));
    code.replaceChildren(...lines.map((l, i) => {
      const bar = first >= 0 && i > first ? i - first : null;
      const on = hoverBar !== null && bar === hoverBar + 1;
      return h('span', { class: `pr-line${on ? ' on' : ''}`, 'data-bar': bar ?? '', onmouseenter: () => { if (bar) { hoverBar = bar - 1; draw(); drawCode(); } } }, h('span', { class: 'pr-ln' }, String(i + 1)), l || ' ', '\n');
    }));
  }

  function draw() {
    const W = Math.max(200, grid.clientWidth || 600);
    const H = Math.max(120, grid.clientHeight || 260);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = RULER + CHORDS;
    const rows = hi - lo + 1;
    const rowH = (H - top) / rows;
    const barW = (W - KEYS_W) / bars;
    const xOf = (t) => KEYS_W + (t / tpb) * barW;
    const yOf = (k) => top + (hi - k) * rowH;
    const line = css(el, '--line', '#303030'); const faint = css(el, '--faint', '#6e6e6e'); const muted2 = css(el, '--muted', '#b0b0b0');
    g.fillStyle = css(el, '--well', '#0e0e0e'); g.fillRect(0, 0, W, H);
    // rows: outside the scale shaded darker; C rows named
    for (let k = lo; k <= hi; k++) {
      const y = yOf(k);
      const inScale = !scale || scale.has(k % 12);
      g.fillStyle = inScale ? '#1a1a1a' : '#111';
      g.fillRect(KEYS_W, y, W - KEYS_W, rowH);
      g.fillStyle = NAMES[k % 12].includes('♯') ? '#222' : '#cfcfcf';
      g.fillRect(0, y, KEYS_W - 2, rowH - 0.5);
      if (drums ? GM[k] : k % 12 === 0) { g.fillStyle = drums ? muted2 : '#111'; g.font = `${Math.min(10, rowH - 1)}px Inter, sans-serif`; g.textBaseline = 'middle'; g.fillText(drums ? GM[k] : `C${Math.floor(k / 12) - 1}`, 2, y + rowH / 2); }
    }
    // bars and beats
    for (let b = 0; b <= bars; b++) {
      for (let q = 0; q < tpb / 960 && b < bars; q++) { g.strokeStyle = '#1f1f1f'; g.beginPath(); g.moveTo(xOf(b * tpb + q * 960) + 0.5, top); g.lineTo(xOf(b * tpb + q * 960) + 0.5, H); g.stroke(); }
      g.strokeStyle = line; g.beginPath(); g.moveTo(Math.round(xOf(b * tpb)) + 0.5, top); g.lineTo(Math.round(xOf(b * tpb)) + 0.5, H); g.stroke();
    }
    // the rows that fit the chord of each bar (or half bar), behind the notes
    if (!drums) {
      for (let b = 0; b < bars; b++) {
        const syms = chords[b] || [];
        syms.forEach((sym, i) => {
          const x0 = xOf(b * tpb + i * tpb / syms.length); const x1 = xOf(b * tpb + (i + 1) * tpb / syms.length);
          for (let k = lo; k <= hi; k++) {
            const f = fitOf(view.fits, sym, k);
            if (!f) continue;
            g.fillStyle = f === 2 ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.05)';
            g.fillRect(x0, yOf(k), x1 - x0, rowH);
          }
        });
      }
    }
    if (hoverBar !== null) { g.fillStyle = 'rgba(47,107,223,.10)'; g.fillRect(xOf(hoverBar * tpb), top, barW, H - top); }
    // ruler and chord row
    g.fillStyle = css(el, '--bg', '#1d1d1d'); g.fillRect(0, 0, W, top);
    g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle';
    for (let b = 0; b < bars; b++) {
      g.fillStyle = faint; g.fillText(String(sectionInfo.startBar + b), xOf(b * tpb) + 3, RULER / 2);
      if (chords[b]?.length) { g.fillStyle = muted2; g.fillText(chords[b].join(' '), xOf(b * tpb) + 3, RULER + CHORDS / 2); }
    }
    // locks on the ruler
    for (const l of song.locks || []) {
      if (l.scope.pattern !== pat.id || (l.scope.channel && l.scope.channel !== active.id)) continue;
      const a = l.scope.fromTick ?? 0; const z = l.scope.toTick ?? bars * tpb;
      g.fillStyle = l.by === 'ok' ? css(el, '--ok', '#2d9d78') : css(el, '--accent', '#2f6bdf');
      g.fillRect(xOf(a), RULER - 3, xOf(z) - xOf(a), 2);
    }
    // cut marks (from the song lane) on the ruler and down the grid
    g.setLineDash([3, 3]);
    for (const c of cuts) {
      const local = c.at - sectionInfo.from;
      if (local <= 0 || local >= sectionInfo.to - sectionInfo.from) continue;
      const cx = Math.round(xOf(local / (sectionInfo.to - sectionInfo.from) * bars * tpb)) + 0.5;
      g.strokeStyle = c.kind === 'hit' ? css(el, '--warn', '#f0f04f') : c.kind === 'miss' ? css(el, '--bad', '#dc513d') : faint;
      g.beginPath(); g.moveTo(cx, RULER); g.lineTo(cx, H); g.stroke();
      // the label sits after the bar number when the cut falls on a bar line
      const onBar = Math.abs(((local / (sectionInfo.to - sectionInfo.from)) * bars) % 1) < 0.02;
      g.fillStyle = g.strokeStyle; g.fillText(c.text, cx + (onBar ? 16 : 3), RULER / 2);
    }
    g.setLineDash([]);
    // ghosts: the other parts as outlines in their colours (only the keys in view)
    for (const { c, notes: ns } of ghosts) {
      g.strokeStyle = c.colour || '#555'; g.globalAlpha = 0.55;
      for (const n of ns) { if (n.key < lo || n.key > hi) continue; g.strokeRect(xOf(n.t) + 0.5, yOf(n.key) + 0.5, Math.max(2, xOf(n.t + n.len) - xOf(n.t) - 1), Math.max(2, rowH - 1)); }
    }
    g.globalAlpha = 1;
    // muted notes: hollow
    g.strokeStyle = active.colour || '#9a9a9a';
    for (const n of muted) g.strokeRect(xOf(n.t) + 1, yOf(n.key) + 1, Math.max(2, xOf(n.t + n.len) - xOf(n.t) - 2), Math.max(2, rowH - 2));
    // the active part's notes: solid, velocity as brightness
    for (const n of notes) {
      const x0 = xOf(n.t); const w = Math.max(2, xOf(n.t + n.len) - x0 - 1);
      g.fillStyle = active.colour || '#2f6bdf';
      g.globalAlpha = 0.45 + 0.55 * n.vel;
      g.fillRect(x0 + 0.5, yOf(n.key) + 0.5, w, Math.max(2, rowH - 1));
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(x0 + 0.5, yOf(n.key) + 0.5, w, Math.max(2, rowH - 1));
    }
  }

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const barW = (r.width - KEYS_W) / bars;
    const b = x < KEYS_W ? null : Math.min(bars - 1, Math.floor((x - KEYS_W) / barW));
    if (b !== hoverBar) { hoverBar = b; draw(); drawCode(); }
  });
  canvas.addEventListener('mouseleave', () => { hoverBar = null; draw(); drawCode(); });

  function setPlayhead(sec) {
    const r = grid.getBoundingClientRect();
    if (sec === null || sec < sectionInfo.from || sec >= sectionInfo.to) { playhead.style.display = 'none'; return; }
    const W = r.width || grid.clientWidth;
    playhead.style.display = 'block';
    playhead.style.transform = `translateX(${KEYS_W + (sec - sectionInfo.from) / (sectionInfo.to - sectionInfo.from) * (W - KEYS_W)}px)`;
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(grid);
  drawCode();
  el.roll = { draw, setPlayhead, stop: () => ro.disconnect(), active: active.id, range: [lo, hi] };
  return el;
}
