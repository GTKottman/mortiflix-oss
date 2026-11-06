// The song lane (doc 19 §1–2, mockup A): the music drawn under the shots it plays over, read-only for now. One time
// axis in video seconds: bar 1 starts at the song's offsetSec, and the shots, the bar ruler, the section blocks, the
// narration and the cut marks all sit on it, so "the section under the shot it plays over" is true by construction.
// Drawn on a <canvas> (a 200-bar song has tens of thousands of notes); the words around it are DOM.

const RULER = 18;
const LABELS = 64;          // the part names on the left
const ROW = 28;             // one part's mini row
const ROW_GAP = 2;
const BLOCK_HEAD = 24;
const MAX_ROWS = 6;         // more parts fold into the last row as "+N more parts"
const VOICE = 18;
const CUTS = 16;
const NODES = 118;          // the shot nodes row (mockup A)
const NODE_MIN = 72;        // narrowest node; narrower shots show only their number and beat colour
const MAX_PPS = 600;        // most zoomed in: px per second

const css = (el, name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

// Bars and ticks to video seconds (one tempo for now: the tempo map's first point).
export function timeAxis(song) {
  const bpm = song.tempo?.[0]?.bpm || 120;
  const m = song.meter?.[0] || { num: 4, den: 4 };
  const ppq = song.ppq || 960;
  const tpb = ppq * 4 * m.num / m.den;
  const secPerTick = 60 / bpm / ppq;
  const off = song.offsetSec || 0;
  return { tpb, tickSec: (tick) => off + tick * secPerTick, barSec: (bar) => off + (bar - 1) * tpb * secPerTick };
}

// The shots in the edit, back to back: [{ id, label, from, to }] in video seconds.
export function shotTimes(graph) {
  const n = graph?.nodes || {};
  let t = 0;
  const out = [];
  for (const sid of graph?.order?.shots || []) {
    const s = n[sid];
    if (!s || s.state === 'cut') continue;
    const v = (s.versions || []).find((x) => x.v === s.current);
    if (!v || v.to_sec === undefined) continue;
    const len = Math.max(0, v.to_sec - (v.from_sec || 0));
    out.push({ id: sid, label: s.label, colour: s.colour, from: t, to: t + len });
    t += len;
  }
  return out;
}

// What each cut gets: a hit that lands within one frame ("cut · hit"), one that misses ("missed by 0.21 s"), or none.
export function cutMarks(song, shots, fps = 30) {
  const ax = timeAxis(song);
  const hits = (song.markers || []).filter((m) => m.kind === 'hit').map((m) => ({ ...m, music: ax.tickSec(m.tick) }));
  return shots.slice(1).map((s) => {
    const at = s.from;
    const near = hits.filter((x) => Math.abs((x.sec ?? x.music) - at) <= 1).sort((a, b) => Math.abs(a.music - at) - Math.abs(b.music - at))[0];
    if (!near) return { at, kind: 'cut', text: 'cut' };
    const off = near.music - at;
    if (Math.abs(off) <= 1 / fps + 1e-6) return { at, kind: 'hit', text: 'cut · hit', hit: near.name };
    return { at, kind: 'miss', text: `missed by ${Math.abs(off).toFixed(2)} s`, hit: near.name };
  });
}

// shotNode(shot, { compact }) builds a shot's node (the canvas's own look); transitionOf(fromId, toId) names the cut.
// focus: { section, part } shows one section (and one part) fitted to the width (levels 2 and 3, doc 25 §2).
// onOpen(sectionId, channelId | null) is called on a double-click on a section block or one of its part rows.
// onSeek(sec) is called on a click on the bar ruler (video seconds).
// onSelect({ section, from, to, part } | null) reports the selected bars (song bars, 1-based, inside one section).
// rowHeight: a part's row (28 px in the song lane; screen B draws them at 40 px).
export function songLane({ h, song, graph, draft = false, shotNode = null, transitionOf = () => null, focus = null, onOpen = null, onSeek = null, onSelect = null, rowHeight = null }) {
  const ROWH = rowHeight || ROW;
  const ax = timeAxis(song);
  const shots = shotTimes(graph);
  const fps = graph?.fps || 30;
  const cuts = cutMarks(song, shots, fps);
  const cueNode = (id) => graph?.nodes?.[id];
  const items = (song.playlist?.items || []).filter((i) => i.kind === 'pattern').sort((a, b) => a.at.tick - b.at.tick);
  const sections = items.map((i) => {
    const p = song.patterns.find((x) => x.id === i.ref) || { notes: {} };
    const startBar = i.at.tick / ax.tpb + 1;
    const bars = i.len / ax.tpb;
    const from = ax.barSec(startBar);
    const to = ax.barSec(startBar + bars);
    const under = shots.find((s) => from >= s.from - 1e-6 && from < s.to - 1e-6);
    return { id: p.id || i.ref, name: p.name || '', startTick: i.at.tick, startBar, bars, from, to, notes: p.notes || {}, under: under?.label || null, colour: cueNode(p.id)?.colour || null };
  });
  const lastBar = sections.length ? sections.at(-1).startBar + sections.at(-1).bars : 1;
  const focused = focus?.section ? sections.find((x) => x.id === focus.section) : null;
  const lines = (graph?.order?.lines || []).map((l) => graph.nodes[l]).filter((l) => l && l.start_sec !== null && l.start_sec !== undefined && l.state !== 'cut');
  // the time range on screen: the whole song, or the focused section
  const t0 = focused ? focused.from : 0;
  const end = focused ? focused.to - focused.from : Math.max(ax.barSec(lastBar), shots.at(-1)?.to || 0, ...lines.map((l) => l.end_sec || 0), 1);

  // parts that play anywhere, in channel order; up to MAX_ROWS rows, the rest folded
  const playing = song.channels.filter((c) => song.patterns.some((p) => p.notes?.[c.id]?.length)).filter((c) => !focus?.part || c.id === focus.part);
  const shown = playing.length > MAX_ROWS ? playing.slice(0, MAX_ROWS - 1) : playing;
  const folded = playing.length > MAX_ROWS ? playing.slice(MAX_ROWS - 1) : [];
  const rows = shown.length + (folded.length ? 1 : 0);
  const range = new Map(playing.map((c) => {
    const keys = song.patterns.flatMap((p) => (p.notes?.[c.id] || []).map((n) => n.key));
    return [c.id, [Math.min(...keys), Math.max(...keys)]];
  }));
  const blockH = BLOCK_HEAD + rows * (ROWH + ROW_GAP) + 4;
  const voiceY = RULER + 4 + blockH + 6;
  const cutsY = voiceY + VOICE + 4;
  const H = cutsY + CUTS + 4;

  const canvas = h('canvas', { class: 'sl-canvas', role: 'img', 'aria-label': `The music under the shots: ${sections.length} sections, ${playing.length} parts, ${Math.round(lastBar - 1)} bars` });
  const nodeRow = h('div', { class: 'sl-nodes', style: { height: `${shots.length ? NODES : 0}px` } });
  const spacer = h('div', { class: 'sl-spacer' });
  // the playhead: its own layer, moved every frame without redrawing the notes
  const playhead = h('div', { class: 'sl-playhead', 'aria-hidden': 'true' });
  const pluses = h('div', { class: 'sl-pluses' });
  const scroller = h('div', { class: 'sl-scroll' }, spacer, nodeRow, canvas, playhead, pluses);
  const list = h('ol', { class: 'sr-only' }, sections.map((s) => h('li', null, `${s.id.toUpperCase()} ${s.name}: bars ${s.startBar}–${s.startBar + s.bars - 1}${s.under ? `, under ${s.under}` : ''}`)));
  const endNote = h('div', { class: 'sl-note sl-end' });
  const el = h('div', { class: 'sl' },
    draft ? h('div', { class: 'sl-note' }, 'From the score. The song is made when the music is imported (mortiflix music <project> --song).') : null,
    scroller, endNote, list);
  // zoom: px per second; 0 = fit the whole song (video mode starts there)
  let pps = 0;
  const fitPps = () => (Math.max(320, scroller.clientWidth || 900) - LABELS - 12) / end;
  const worldW = () => LABELS + end * pps + 12;

  // + at every section's end (doc 19 §2): DOM buttons on the lane's time axis, under the blocks
  function placePluses() {
    pluses.replaceChildren();
    if (!el.lane?.onPlus) return;
    for (const s of sections) {
      if (focused && s !== focused) continue;
      const b = h('button', { class: 'sl-plus', title: `Add bars at the end of ${s.id.toUpperCase()}`, 'aria-label': `Add bars at the end of ${s.id.toUpperCase()} ${s.name}`, onclick: () => el.lane.onPlus(s.id, s.bars + 1) }, '+');
      b.style.left = `${LABELS + (s.to - t0) * pps - 9}px`;
      pluses.append(b);
    }
  }

  function placeNodes() {
    // the label column covers nodes scrolled under it, as the canvas does for the parts
    nodeRow.replaceChildren(h('span', { class: 'sl-mask', style: { width: `${LABELS - 2}px` } }));
    if (!shotNode) return;
    const x = (sec) => LABELS + (sec - t0) * pps;
    shots.forEach((s, i) => {
      const w = (s.to - s.from) * pps - 4;
      const compact = w < NODE_MIN;
      const node = shotNode(s, { compact });
      node.classList.add('sl-node');
      if (compact) node.classList.add('compact');
      Object.assign(node.style, { left: `${x(s.from) + 2}px`, width: `${Math.max(compact ? 28 : NODE_MIN, w)}px` });
      nodeRow.append(node);
      const next = shots[i + 1];
      if (next) {
        const t = transitionOf(s.id, next.id);
        nodeRow.append(h('span', { class: 'sl-cut', title: t ? `${t.label}: ${t.title}` : 'Cut', style: { left: `${x(next.from) - 1}px` } }));
      }
    });
  }

  function draw() {
    if (!pps) pps = fitPps();
    pps = Math.max(fitPps(), Math.min(MAX_PPS, pps));
    const view = Math.max(320, scroller.clientWidth || 900);
    spacer.style.width = `${worldW()}px`;
    nodeRow.style.width = `${worldW()}px`;
    placeNodes();
    const left = scroller.scrollLeft;
    const width = view;
    const x = (sec) => LABELS + (sec - t0) * pps - left;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${H}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    const faint = css(el, '--faint', '#6e6e6e');
    const muted = css(el, '--muted', '#b0b0b0');
    const line = css(el, '--line', '#303030');
    const warn = css(el, '--warn', '#f0f04f');
    const bad = css(el, '--bad', '#dc513d');
    const panelBg = css(el, '--bg', '#1d1d1d');
    const font = (px, weight = 400) => `${weight} ${px}px Inter, system-ui, sans-serif`;
    const visible = (a, b) => b >= -2 && a <= width + 2;
    g.textBaseline = 'middle';

    // the bar ruler: a number every bar, or every 2 / 4 / 8 when bars are narrow
    g.font = font(10);
    const barPx = (ax.barSec(2) - ax.barSec(1)) * pps;
    const every = [1, 2, 4, 8, 16, 32].find((k) => barPx * k >= 22) || 64;
    for (let b = focused ? focused.startBar : 1; b <= (focused ? focused.startBar + focused.bars : lastBar); b++) {
      const bx = Math.round(x(ax.barSec(b))) + 0.5;
      if (bx < LABELS - 2 || bx > width + 30) continue;
      g.fillStyle = faint;
      g.strokeStyle = line;
      g.beginPath(); g.moveTo(bx, b % every === 1 || every === 1 ? 0 : RULER - 5); g.lineTo(bx, RULER); g.stroke();
      if ((b - 1) % every === 0 && b < lastBar) g.fillText(String(b), bx + 3, RULER / 2);
    }

    // the section blocks, each with a mini row per part
    const top = RULER + 4;
    for (const s of sections) {
      const x0 = x(s.from) + 1; const x1 = x(s.to) - 2;
      if (!visible(x0, x1) || (focused && s !== focused)) continue;
      g.fillStyle = s.colour?.hex || '#3a3a3a';
      roundRect(g, x0, top, x1 - x0, blockH, 4); g.fill();
      g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, blockH); g.clip();
      g.font = font(11, 600);
      const tag = s.id.toUpperCase();
      const tw = g.measureText(tag).width + 8;
      g.fillStyle = s.colour?.chip || 'rgba(255,255,255,.35)';
      roundRect(g, x0 + 5, top + 5, tw, 15, 3); g.fill();
      g.fillStyle = '#000'; g.fillText(tag, x0 + 9, top + 12.5);
      g.fillStyle = '#fff'; g.font = font(12);
      g.fillText(s.name, x0 + tw + 10, top + 12.5);
      const nameW = g.measureText(s.name).width;
      g.fillStyle = 'rgba(255,255,255,.65)'; g.font = font(11);
      g.fillText(`bars ${s.startBar}–${s.startBar + s.bars - 1}${s.under ? ` · under ${s.under}` : ''}`, x0 + tw + 16 + nameW, top + 12.5);
      // notes, small: x by time, y by pitch within the part's own range
      const rowsOf = [...shown.map((c) => [c]), ...(folded.length ? [folded] : [])];
      rowsOf.forEach((chs, r) => {
        const ry = top + BLOCK_HEAD + r * (ROWH + ROW_GAP);
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect(x0, ry, x1 - x0, ROWH);
        g.fillStyle = 'rgba(255,255,255,.85)';
        for (const c of chs) {
          const [lo, hi] = range.get(c.id);
          const span = Math.max(1, hi - lo);
          for (const n of s.notes[c.id] || []) {
            const nx = x(ax.tickSec(s.startTick + n.t));
            if (nx > width) break;
            const nw = Math.max(1.5, (ax.tickSec(s.startTick + n.t + n.len) - ax.tickSec(s.startTick + n.t)) * pps - 0.5);
            const ny = ry + 3 + (1 - (n.key - lo) / span) * (ROWH - 8);
            g.fillRect(nx, ny, nw, 2);
          }
        }
      });
      g.restore();
    }
    // the selection: a white outline across the selected bars (all parts, or the one part's row)
    if (sel) {
      const s0 = sections.find((x) => x.id === sel.section);
      if (s0) {
        const xa = x(ax.barSec(sel.from)); const xb = x(ax.barSec(sel.to + 1));
        const r = sel.part ? shown.findIndex((c) => c.id === sel.part) : -1;
        const y0 = r >= 0 ? top + BLOCK_HEAD + r * (ROWH + ROW_GAP) - 2 : top - 3;
        const hgt = r >= 0 ? ROWH + 4 : blockH + 6;
        g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(xa, y0, xb - xa, hgt);
        g.strokeStyle = css(el, '--selected', '#ebebeb'); g.lineWidth = 2;
        g.strokeRect(xa + 1, y0 + 1, xb - xa - 2, hgt - 2); g.lineWidth = 1;
      }
    }
    // the label column stays put while the lane scrolls under it
    g.fillStyle = panelBg; g.fillRect(0, 0, LABELS - 2, H);
    g.font = font(10); g.fillStyle = faint; g.fillText('Bar', 0, RULER / 2);
    g.font = font(11); g.fillStyle = muted;
    shown.forEach((c, r) => g.fillText(ellipsis(g, c.name, LABELS - 6), 0, top + BLOCK_HEAD + r * (ROWH + ROW_GAP) + ROWH / 2));
    if (folded.length) g.fillText(`+${folded.length} more`, 0, top + BLOCK_HEAD + shown.length * (ROWH + ROW_GAP) + ROWH / 2);

    // narration: one thin row
    for (const l of lines) {
      const lx = x(l.start_sec); const lw = Math.max(3, (l.end_sec - l.start_sec) * pps - 1);
      if (!visible(lx, lx + lw)) continue;
      g.fillStyle = css(el, '--clip-audio', '#2f6f4f');
      roundRect(g, lx, voiceY, lw, VOICE, 3); g.fill();
      g.fillStyle = '#fff'; g.font = font(10);
      g.save(); g.beginPath(); g.rect(lx, voiceY, lw, VOICE); g.clip();
      g.fillText(l.label, lx + 4, voiceY + VOICE / 2); g.restore();
    }

    // cut marks: dashed, coloured by whether the music lands on the cut
    g.setLineDash([3, 3]);
    for (const c of cuts) {
      const cx = Math.round(x(c.at)) + 0.5;
      if (cx < LABELS || cx > width) continue;
      const colour = c.kind === 'hit' ? warn : c.kind === 'miss' ? bad : faint;
      g.strokeStyle = colour; g.lineWidth = c.kind === 'cut' ? 1 : 2;
      g.beginPath(); g.moveTo(cx, top); g.lineTo(cx, cutsY + CUTS); g.stroke();
      g.fillStyle = colour; g.font = font(10);
      g.fillText(c.text, cx + 4, cutsY + CUTS / 2);
    }
    g.setLineDash([]); g.lineWidth = 1;
    g.fillStyle = panelBg; g.fillRect(0, voiceY - 2, LABELS - 2, VOICE + 4);
    g.fillStyle = muted; g.font = font(11); g.fillText('Voice', 0, voiceY + VOICE / 2);
    playhead.style.height = `${(shots.length ? NODES : 0) + H}px`;
    pluses.style.top = `${(shots.length ? NODES : 0) + cutsY - 2}px`;
    placePluses();
    // the music now ends before the video: how much (after Cut it)
    const musicEnd = ax.barSec(lastBar); const videoEnd = shots.at(-1)?.to || 0;
    endNote.textContent = !focused && videoEnd - musicEnd > 0.05 ? `The music ends ${(videoEnd - musicEnd).toFixed(1)} s before the video` : '';
    if (headAt !== null) setPlayhead(headAt);
  }

  // Ctrl + wheel zooms around the mouse; plain wheel scrolls the board; Shift + wheel scrolls sideways.
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const at = (scroller.scrollLeft + mx - LABELS) / pps;      // the second under the mouse (from the range's start)
    pps = Math.max(fitPps(), Math.min(MAX_PPS, pps * Math.exp(-e.deltaY * 0.0015)));
    spacer.style.width = `${worldW()}px`;
    scroller.scrollLeft = Math.max(0, LABELS + at * pps - mx);
    draw();
  }, { passive: false });
  scroller.addEventListener('scroll', () => requestAnimationFrame(draw));

  // Selecting bars (doc 19 §2): a bar number in the ruler (drag for a range, Shift-click to extend) picks those bars
  // in every part and moves the playhead to the first; a part's mini row picks that part only. One section at a time.
  let sel = null;               // { section, from, to, part } in song bars
  let dragFrom = null;
  const barAt = (mx) => { const sec = t0 + (mx + scroller.scrollLeft - LABELS) / pps; return { sec, bar: Math.floor((sec - (song.offsetSec || 0)) / (ax.barSec(2) - ax.barSec(1))) + 1 }; };
  const sectionOfBar = (bar) => sections.find((x) => bar >= x.startBar && bar < x.startBar + x.bars);
  function hit(e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    if (mx < LABELS) return null;
    const { sec, bar } = barAt(mx);
    const s = sectionOfBar(bar);
    if (!s) return null;
    const top = RULER + 4;
    if (my <= RULER + 2) return { kind: 'ruler', bar, sec, section: s };
    if (my < top || my > top + blockH) return null;
    const row = Math.floor((my - top - BLOCK_HEAD) / (ROWH + ROW_GAP));
    return { kind: 'row', bar, sec, section: s, part: row >= 0 && row < shown.length ? shown[row].id : null };
  }
  function setSel(next, { quiet = false } = {}) {
    sel = next;
    draw();
    if (!quiet) onSelect?.(sel ? { ...sel } : null);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    const hh = hit(e);
    if (!hh) return;
    if (e.shiftKey && sel && sel.section === hh.section.id) {
      setSel({ ...sel, from: Math.min(sel.from, hh.bar), to: Math.max(sel.to, hh.bar) });
      return;
    }
    dragFrom = { ...hh, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    onSelect?.(null);   // the popup waits until the drag ends
    setSel({ section: hh.section.id, from: hh.bar, to: hh.bar, part: hh.kind === 'row' ? hh.part : null }, { quiet: true });
    if (hh.kind === 'ruler') onSeek?.(ax.barSec(hh.bar));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragFrom || e.pointerId !== dragFrom.id) return;
    const r = canvas.getBoundingClientRect();
    const { bar } = barAt(e.clientX - r.left);
    const s = sections.find((x) => x.id === dragFrom.section.id);
    const b = Math.max(s.startBar, Math.min(s.startBar + s.bars - 1, bar));
    const next = { ...sel, from: Math.min(dragFrom.bar, b), to: Math.max(dragFrom.bar, b) };
    if (next.from !== sel.from || next.to !== sel.to) { sel = next; draw(); }
  });
  // the popup waits a moment: a double-click (going into the section) must not land on it
  let popTimer = null;
  canvas.addEventListener('pointerup', () => {
    if (!dragFrom) return;
    dragFrom = null;
    clearTimeout(popTimer);
    popTimer = setTimeout(() => onSelect?.(sel ? { ...sel } : null), 250);
  });

  let headAt = null;
  function setPlayhead(sec) {
    headAt = sec;
    if (sec === null || sec < t0 || sec > t0 + end) { playhead.style.display = 'none'; return; }
    playhead.style.display = 'block';
    playhead.style.transform = `translateX(${LABELS + (sec - t0) * pps}px)`;
  }

  // double-click: which section block, and which part row inside it
  canvas.addEventListener('dblclick', (e) => {
    clearTimeout(popTimer);
    if (!onOpen) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    if (mx < LABELS) return;
    const sec = t0 + (mx + scroller.scrollLeft - LABELS) / pps;
    const s = sections.find((x) => sec >= x.from && sec < x.to);
    const top = RULER + 4;
    if (!s || my < top || my > top + blockH) return;
    const row = Math.floor((my - top - BLOCK_HEAD) / (ROWH + ROW_GAP));
    const part = row >= 0 && row < shown.length ? shown[row].id : null;
    onOpen(s.id, part);
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(scroller);
  el.lane = { draw, sections, cuts, shots, end, stop: () => ro.disconnect(), zoom: (v) => { pps = v; draw(); }, get pps() { return pps; }, x: (sec) => LABELS + (sec - t0) * pps, focused, setPlayhead, ax, select: setSel, get selection() { return sel; } };
  return el;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

function ellipsis(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
