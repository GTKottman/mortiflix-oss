// MIDI ⇄ Strudel (doc 28): one pattern's notes on the left, its Strudel text on the right, both live.
// Change a note on the left and the server writes the smallest text change that plays exactly the new notes (the
// ladder in src/strudel/edit.mjs); type on the right and the server runs the text and the notes redraw.
// Hover a note to see the letters that make it; put the cursor in the text to see the notes it makes.
//
// app.js passes its helpers in (`ui`), so this module has no imports of its own.

const PPQ = 960;
const TPB = 4 * PPQ;            // 4/4 for now: ticks per bar
const KEYS_W = 44;              // the keyboard column
const RULER_H = 22;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const SNAPS = [['1/4', 960], ['1/8', 480], ['1/16', 240], ['1/32', 120], ['1/8 triplet', 320], ['1/16 triplet', 160], ['off', 1]];

const EXAMPLES = [
  { name: 'AI bass line (4 bars that loop)', bars: 8, code: 'note("<[d2 ~ d2 f2] [c2 ~ c2 e2] [g1 ~ g1 a1] [d2 d2 f2 a2]>").velocity(.8)' },
  { name: 'Undertow sub (Count With Me, one line per bar)', bars: 8, code: '`<\n  ~\n  ~\n  ~\n  ~\n  [~ d1:.6 ~ d1:.5 ~ d1:.55 ~ d2:.5]\n  [~ d1:.6 ~ d1:.5 ~ d1:.55 ~ d2:.5]\n  [~ d#1:.6 ~ d#1:.5 ~ d#1:.55 ~ d#2:.5]\n  [~ d#1:.6 ~ d#1:.5 ~ d#1:.55 ~ d#2:.5]\n>`.as("note:velocity")' },
  { name: 'Scale steps with some randomness', bars: 4, code: 'n("0 2 4 7".add("<0 3 5 3>")).scale("D3:dorian").sometimesBy(.3, (x) => x.velocity(.5)).velocity(.8)' },
  { name: 'Chords', bars: 4, code: 'chord("<Dm7 G7 Cmaj7 A7>").voicing().velocity(.6)' },
];

const noteName = (k) => `${NAMES[k % 12]}${Math.floor(k / 12) - 1}`;

export function midiStrudelView(ui) {
  const { h, api, store } = ui;
  const saved = store.get('mfx-midistrudel') || {};
  let code = typeof saved.code === 'string' ? saved.code : EXAMPLES[0].code;
  let bars = saved.bars || EXAMPLES[0].bars;
  let snap = saved.snap || 240;
  let notes = [];               // { t, len, key, vel, loc }
  let problems = [];
  let error = null;             // { text, line }
  let flash = new Set();        // changed line numbers (0-based), shown for a moment
  let hoverNote = null;
  let caretNotes = new Set();
  let drag = null;
  let lastLen = 480;
  let seq = 0;                  // newest request wins
  let typeTimer = null;
  let flashTimer = null;
  let velTimer = null;
  let LOW = 36;                 // the keys shown: fitted to the notes, a whole octave either side
  let HIGH = 72;
  let ROW = 14;                 // px per key row: fills the panel, 12–22

  // ---------- layout ----------
  const status = h('div', { class: 'ms-status' });
  const exampleSel = h('select', { class: 'ms-select', 'aria-label': 'Start from', onchange: () => {
    const ex = EXAMPLES[Number(exampleSel.value)];
    if (!ex) return;
    code = ex.code; bars = ex.bars; barsIn.value = bars;
    setText(code); derive();
    exampleSel.value = '';
  } }, h('option', { value: '' }, 'Start from…'), EXAMPLES.map((ex, i) => h('option', { value: i }, ex.name)));
  const barsIn = h('input', { class: 'ms-num', type: 'number', min: 1, max: 64, value: bars, 'aria-label': 'Bars', onchange: () => {
    bars = Math.min(64, Math.max(1, Math.round(Number(barsIn.value)) || 1)); barsIn.value = bars; derive();
  } });
  const snapSel = h('select', { class: 'ms-select', 'aria-label': 'Snap', onchange: () => { snap = Number(snapSel.value); keep(); } },
    SNAPS.map(([n, v]) => h('option', { value: v, selected: v === snap }, n)));

  const roll = h('canvas', { class: 'ms-roll' });
  const rollWrap = h('div', { class: 'ms-roll-wrap' }, roll);
  const info = h('div', { class: 'ms-info' });

  const gutter = h('pre', { class: 'ms-gutter', 'aria-hidden': 'true' });
  const paint = h('pre', { class: 'ms-paint', 'aria-hidden': 'true' });
  const text = h('textarea', { class: 'ms-text', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Strudel code' });
  const editor = h('div', { class: 'ms-editor' }, gutter, h('div', { class: 'ms-code' }, paint, text));
  const errBox = h('div', { class: 'ms-error' });

  const panel = (name, body, extra) => h('section', { class: 'cv-panel' }, h('div', { class: 'cv-tabs' }, h('span', { class: 'cv-tab on' }, name), extra), body);
  const root = h('div', { class: 'canvas ms' },
    h('header', { class: 'cv-head' },
      h('a', { class: 'cv-brand', href: '#/' }, h('img', { src: 'img/mark.png', alt: '' }), h('span', null, 'Mortiflix')),
      h('span', { class: 'cv-title' }, 'MIDI ⇄ Strudel'),
      h('div', { class: 'ms-tools' }, exampleSel, h('label', { class: 'ms-label' }, 'Bars', barsIn), h('label', { class: 'ms-label' }, 'Snap', snapSel)),
      status),
    h('div', { class: 'ms-grid' },
      panel('MIDI', h('div', { class: 'cv-body ms-left' }, rollWrap, info), h('span', { class: 'ms-hint' }, 'click: add · drag: move · drag the end: length · wheel: velocity · right-click: delete')),
      panel('Strudel', h('div', { class: 'cv-body ms-right' }, editor, errBox))));

  // ---------- the text side ----------
  function setText(v) { text.value = v; code = v; paintText(); keep(); }

  function lineOf(pos) { return code.slice(0, pos).split('\n').length - 1; }

  function paintText() {
    const lines = code.split('\n');
    gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n') + '\n';
    // marks: [start, end, class]
    const marks = [];
    const add = (n, cls) => { for (const [s, e] of n.loc || []) if (e > s) marks.push([s, e, cls]); };
    if (hoverNote) add(hoverNote, 'hot');
    const frag = document.createDocumentFragment();
    let pos = 0;
    lines.forEach((ln, i) => {
      const cls = ['ln', flash.has(i) ? 'flash' : '', error?.line === i + 1 ? 'err' : ''].filter(Boolean).join(' ');
      const span = document.createElement('span');
      span.className = cls;
      let at = 0;
      const mine = marks.filter(([s, e]) => s < pos + ln.length && e > pos).sort((a, b) => a[0] - b[0]);
      for (const [s, e, c] of mine) {
        const a = Math.max(s - pos, at); const b = Math.min(e - pos, ln.length);
        if (a > at) span.append(ln.slice(at, a));
        if (b > a) { const m = document.createElement('mark'); m.className = c; m.textContent = ln.slice(a, b); span.append(m); }
        at = Math.max(at, b);
      }
      span.append(ln.slice(at) + '\n');
      frag.append(span);
      pos += ln.length + 1;
    });
    paint.replaceChildren(frag);
    syncScroll();
  }

  function syncScroll() { paint.scrollTop = text.scrollTop; paint.scrollLeft = text.scrollLeft; gutter.scrollTop = text.scrollTop; }

  function changedLines(a, b) {
    const A = a.split('\n'); const B = b.split('\n');
    let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
    const out = new Set(); for (let i = p; i < B.length - s; i++) out.add(i);
    return out;
  }

  function showFlash(lines) {
    flash = lines; paintText();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = new Set(); paintText(); }, 1600);
  }

  text.addEventListener('input', () => {
    code = text.value; keep(); paintText();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(derive, 150);
  });
  text.addEventListener('scroll', syncScroll);
  const caretMoved = () => {
    const at = text.selectionStart;
    caretNotes = new Set(notes.filter((n) => (n.loc || []).some(([s, e]) => at >= s && at <= e)).map((n) => n));
    drawRoll();
  };
  text.addEventListener('keyup', caretMoved);
  text.addEventListener('click', caretMoved);
  text.addEventListener('blur', () => { caretNotes = new Set(); drawRoll(); });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = text.selectionStart; text.setRangeText('  ', s, text.selectionEnd, 'end'); text.dispatchEvent(new Event('input')); }
  });

  // Text → notes.
  async function derive() {
    const my = ++seq;
    const sent = code;
    keep();
    try {
      const t0 = performance.now();
      const r = await api('/api/strudel/notes', { method: 'POST', body: { code: sent, bars } });
      if (my !== seq) return;
      notes = r.notes; problems = r.problems || []; error = null; hoverNote = null; caretNotes = new Set(); info.textContent = "";
      say(`${notes.length} notes · read in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      if (my !== seq) return;
      error = { text: e.message, line: e.data?.line ?? null };
      say('The text has an error: the notes stay as they were', true);
    }
    showError(); paintText(); fitKeys(true); fitView(); drawRoll();
  }

  // Notes → text.
  async function commit(wanted, what) {
    const my = ++seq;
    const sent = code;
    const before = notes;
    notes = wanted.map((n) => ({ ...n, loc: [] }));   // drawn at once; the text follows
    drawRoll();
    try {
      const t0 = performance.now();
      const r = await api('/api/strudel/edit', { method: 'POST', body: { code: sent, bars, notes: wanted.map(({ t, len, key, vel }) => ({ t, len, key, vel })) } });
      if (my !== seq || text.value !== sent) return;
      const lines = changedLines(sent, r.code);
      notes = r.notes; problems = r.problems || []; error = null; hoverNote = null; caretNotes = new Set(); info.textContent = "";
      setText(r.code);
      const how = { 'bar lines': `rewrote ${lines.size === 1 ? 'line' : 'lines'} ${[...lines].map((i) => i + 1).join(', ')}`, 'in place': 'changed the note in place', arrangement: `hard-coded bar${r.from === r.to ? ` ${r.from}` : `s ${r.from}–${r.to}`} in a new arrangement`, fresh: 'wrote the pattern fresh' }[r.level] || r.level;
      say(`${what}: ${how} · ${Math.round(performance.now() - t0)} ms`);
      showFlash(lines);
      fitKeys(); fitView();
    } catch (e) {
      if (my !== seq) return;
      notes = before;
      say(`Couldn't write that: ${e.message}`, true);
    }
    showError(); drawRoll();
  }

  function showError() {
    errBox.replaceChildren(...(error ? [h('b', null, error.line ? `Line ${error.line}: ` : 'Error: '), error.text] : problems.length ? [h('b', null, 'Note: '), [...new Set(problems)].slice(0, 3).join(' · ')] : []));
    errBox.classList.toggle('on', Boolean(error || problems.length));
    errBox.classList.toggle('warn', !error && problems.length > 0);
  }

  function say(t, bad = false) { status.textContent = t; status.classList.toggle('bad', bad); }

  function keep() { store.set('mfx-midistrudel', { code, bars, snap }); }

  // ---------- the MIDI side ----------
  let W = 0; let H = 0; let barW = 0; let dpr = 1;
  const x2t = (x) => (x - KEYS_W) / barW * TPB;
  const t2x = (t) => KEYS_W + t / TPB * barW;
  const y2k = (y) => HIGH - Math.floor((y - RULER_H) / ROW);
  const k2y = (k) => RULER_H + (HIGH - k) * ROW;

  // Keys: an octave above and below the notes (C to B), at least 3 octaves. Only widened while the owner drags.
  function fitKeys(force = false) {
    const ks = notes.map((n) => n.key);
    const lo = ks.length ? Math.min(...ks) : 48;
    const hi = ks.length ? Math.max(...ks) : 60;
    if (!force && lo >= LOW && hi <= HIGH) return;
    let a = Math.max(0, Math.floor(lo / 12) * 12 - 12);
    let b = Math.min(127, Math.ceil((hi + 1) / 12) * 12 + 11);
    while (b - a + 1 < 36) { if (a > 0) a -= 12; if (b - a + 1 < 36 && b < 127) b = Math.min(127, b + 12); if (a === 0 && b === 127) break; }
    LOW = a; HIGH = b;
  }

  function fitView() {
    const wrapW = rollWrap.clientWidth || 800;
    const wrapH = rollWrap.clientHeight || 600;
    ROW = Math.max(12, Math.min(22, Math.floor((wrapH - RULER_H) / (HIGH - LOW + 1))));
    barW = Math.max(60, (wrapW - KEYS_W) / bars);
    W = Math.round(KEYS_W + barW * bars);
    H = RULER_H + (HIGH - LOW + 1) * ROW;
    dpr = window.devicePixelRatio || 1;
    if (roll.width !== Math.round(W * dpr) || roll.height !== Math.round(H * dpr)) {
      roll.width = Math.round(W * dpr); roll.height = Math.round(H * dpr);
      roll.style.width = `${W}px`; roll.style.height = `${H}px`;
    }
  }

  let scrolledOnce = false;
  function scrollToNotes() {
    if (scrolledOnce || !notes.length) return;
    scrolledOnce = true;
    const mid = (Math.max(...notes.map((n) => n.key)) + Math.min(...notes.map((n) => n.key))) / 2;
    rollWrap.scrollTop = Math.max(0, k2y(mid) - rollWrap.clientHeight / 2);
  }

  function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

  function drawRoll() {
    if (!barW) fitView();
    const g = roll.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // rows
    for (let k = LOW; k <= HIGH; k++) {
      const y = k2y(k);
      g.fillStyle = BLACK.has(k % 12) ? '#151515' : '#1b1b1b';
      g.fillRect(KEYS_W, y, W - KEYS_W, ROW);
      if (k % 12 === 0) { g.fillStyle = '#2a2a2a'; g.fillRect(KEYS_W, y + ROW - 1, W - KEYS_W, 1); }
    }
    // beat and bar lines
    for (let b = 0; b <= bars * 4; b++) {
      const x = Math.round(t2x(b * PPQ)) + 0.5;
      g.fillStyle = b % 4 === 0 ? '#3a3a3a' : '#262626';
      g.fillRect(x, RULER_H, 1, H - RULER_H);
    }
    // notes
    const accent = css('--accent') || '#2f6bdf';
    for (const n of notes) {
      const x = t2x(n.t); const w = Math.max(3, n.len / TPB * barW - 1); const y = k2y(n.key);
      const hot = n === hoverNote || caretNotes.has(n) || drag?.note === n;
      g.globalAlpha = 0.35 + 0.65 * n.vel;
      g.fillStyle = hot ? '#5794ec' : accent;
      g.fillRect(x, y + 1, w, ROW - 2);
      g.globalAlpha = 1;
      g.strokeStyle = hot ? '#ebebeb' : '#0e0e0e';
      g.lineWidth = 1;
      g.strokeRect(Math.round(x) + 0.5, y + 1.5, Math.max(2, Math.round(w) - 1), ROW - 3);
      if (w > 22) { g.fillStyle = '#ffffff'; g.font = '9px Inter, sans-serif'; g.fillText(noteName(n.key), x + 3, y + ROW - 3); }
    }
    // keyboard
    for (let k = LOW; k <= HIGH; k++) {
      const y = k2y(k);
      g.fillStyle = BLACK.has(k % 12) ? '#0e0e0e' : '#cfcfcf';
      g.fillRect(0, y, KEYS_W - 1, ROW - (BLACK.has(k % 12) ? 0 : 1));
      if (k % 12 === 0) { g.fillStyle = '#1d1d1d'; g.font = '9px Inter, sans-serif'; g.fillText(noteName(k), 4, y + ROW - 3); }
    }
    // ruler (stays on top while scrolling)
    const top = rollWrap.scrollTop;
    g.fillStyle = '#1d1d1d'; g.fillRect(0, top, W, RULER_H);
    g.fillStyle = '#303030'; g.fillRect(0, top + RULER_H - 1, W, 1);
    g.fillStyle = '#b0b0b0'; g.font = '11px Inter, sans-serif';
    for (let b = 0; b < bars; b++) g.fillText(String(b + 1), t2x(b * TPB) + 4, top + 15);
    scrollToNotes();
  }
  rollWrap.addEventListener('scroll', () => drawRoll());

  function noteAt(x, y) {
    const k = y2k(y); const t = x2t(x);
    for (let i = notes.length - 1; i >= 0; i--) { const n = notes[i]; if (n.key === k && t >= n.t && t < n.t + n.len) return n; }
    return null;
  }
  const pos = (e) => { const r = roll.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const snapT = (t) => Math.round(t / snap) * snap;
  const clampT = (t) => Math.max(0, Math.min(bars * TPB - 1, t));

  roll.addEventListener('contextmenu', (e) => e.preventDefault());
  roll.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    if (x < KEYS_W || y < rollWrap.scrollTop + RULER_H) return;
    const n = noteAt(x, y);
    if (e.button === 2) {
      if (n) commit(notes.filter((m) => m !== n), `Deleted ${noteName(n.key)}`);
      return;
    }
    if (e.button !== 0) return;
    roll.setPointerCapture(e.pointerId);
    if (n) {
      const edge = t2x(n.t + n.len) - x < 6;
      drag = { note: n, mode: edge ? 'len' : 'move', x0: x, y0: y, t0: n.t, k0: n.key, len0: n.len, moved: false };
    } else {
      const t = Math.floor(clampT(x2t(x)) / snap) * snap;
      const fresh = { t, len: Math.min(lastLen, bars * TPB - t), key: y2k(y), vel: 0.8, loc: [] };
      notes = [...notes, fresh];
      drag = { note: fresh, mode: 'len', x0: x, y0: y, t0: t, k0: fresh.key, len0: fresh.len, moved: true, added: true };
    }
    drawRoll();
  });
  roll.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e);
    if (!drag) {
      const n = x >= KEYS_W ? noteAt(x, y) : null;
      roll.style.cursor = n ? (t2x(n.t + n.len) - x < 6 ? 'ew-resize' : 'grab') : 'crosshair';
      if (n !== hoverNote) {
        hoverNote = n; paintText(); drawRoll();
        info.textContent = n ? `${noteName(n.key)} · bar ${Math.floor(n.t / TPB) + 1}, beat ${Math.round((n.t % TPB / PPQ + 1) * 100) / 100} · ${Math.round(n.len / PPQ * 100) / 100} beats · velocity ${n.vel}` : '';
      }
      return;
    }
    const n = drag.note;
    if (drag.mode === 'move') {
      const dt = snapT(x2t(x) - x2t(drag.x0));
      n.t = clampT(drag.t0 + dt);
      n.key = Math.max(LOW, Math.min(HIGH, drag.k0 + y2k(y) - y2k(drag.y0)));
    } else {
      const rawEnd = n.t + drag.len0 + x2t(x) - x2t(drag.x0);
      const end = snap > 1 ? Math.round(rawEnd / snap) * snap : Math.round(rawEnd);
      n.len = Math.max(snap > 1 ? snap : 1, Math.min(bars * TPB - n.t, end - n.t));
    }
    drag.moved = drag.moved || n.t !== drag.t0 || n.key !== drag.k0 || n.len !== drag.len0;
    drawRoll();
  });
  roll.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) { drawRoll(); return; }
    if (d.mode === 'len') lastLen = d.note.len;
    const what = d.added ? `Added ${noteName(d.note.key)}` : d.mode === 'len' ? `Changed the length of ${noteName(d.note.key)}` : `Moved ${noteName(d.k0)}${d.k0 !== d.note.key ? ` to ${noteName(d.note.key)}` : ''}`;
    commit(notes.map((n) => ({ ...n })), what);
  });
  roll.addEventListener('wheel', (e) => {
    const [x, y] = pos(e);
    const n = noteAt(x, y);
    if (!n) return;
    e.preventDefault();
    n.vel = Math.round(Math.min(1, Math.max(0.01, n.vel + (e.deltaY < 0 ? 0.05 : -0.05))) * 100) / 100;
    info.textContent = `${noteName(n.key)} · velocity ${n.vel}`;
    drawRoll();
    clearTimeout(velTimer);
    velTimer = setTimeout(() => commit(notes.map((m) => ({ ...m })), `Velocity of ${noteName(n.key)} to ${n.vel}`), 350);
  }, { passive: false });

  const onResize = () => { fitView(); drawRoll(); };

  return {
    show() {
      document.body.classList.add('in-canvas');
      window.addEventListener('resize', onResize);
      setText(code);
      requestAnimationFrame(() => { fitView(); drawRoll(); derive(); });
      return root;
    },
    leave() {
      document.body.classList.remove('in-canvas');
      window.removeEventListener('resize', onResize);
      clearTimeout(typeTimer); clearTimeout(flashTimer); clearTimeout(velTimer);
    },
  };
}
