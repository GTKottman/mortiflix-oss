// The canvas: a project as a Mortiflix Studio-style workspace. A 38 px header with Import / Edit / Export, then panels on
// black gutters, each part of the work in its own corner, and the board along the bottom where Mortiflix Studio has its
// timeline. The AI fills it as it works; the owner looks, plays and steers from here.
//
// app.js passes its helpers in (`ui`), so this module has no imports of its own and no copy of them.

export function canvasView(ui, id, mode = 'edit') {
  const { h, fill, api, fileUrl, clock, store } = ui;
  const keepKey = `mfx-canvas-keep-${id}`;
  let d = null;
  let graph = null;
  let pieces = [];
  let sel = 0;
  let keep = store.get(keepKey) ?? true;
  let boardView = store.get(`mfx-canvas-board-${id}`) || 'shots';
  // The music level (doc 25 §2): the song, a section (?music=m02) or a part in it (?music=m02/ch02). Each level is
  // its own address, so the browser's Back / Forward and the mouse's back button move between them.
  let level = { section: null, part: null };
  let tsel = null; // a transition node picked on the noodle graph: the Monitor shows the cut and the library
  let library = null;
  let fcInfo = null;
  let selTimer = null;
  let rightTab = 'doing';
  const asked = h('div', { class: 'cv-body cv-questions' });
  const answers = {};
  let lastQ = 0;
  let advance = null;

  const monitor = h('div', { class: 'cv-body cv-monitor' });
  const script = h('div', { class: 'cv-body cv-script' });
  const board = h('div', { class: 'cv-body cv-board' });
  const crumbs = h('nav', { class: 'cv-crumbs', 'aria-label': 'Where you are in the music' });
  const doing = h('div', { class: 'cv-body cv-doing' });
  const head = h('header', { class: 'cv-head' });
  const root = h('div', { class: 'canvas' });

  const panel = (name, body, extra = null, cls = '') => h('section', { class: `cv-panel ${cls}` },
    h('div', { class: 'cv-tabs' }, h('span', { class: 'cv-tab on' }, name), extra), body);

  // The shots, in film order, each in its beat's colour: from the project graph (src/canvas.mjs). A shot plays its own
  // seconds of the animatic; a planned shot (before the animatic) shows its style frame.
  function shotPieces() {
    const n = graph?.nodes || {};
    return (graph?.order?.shots || []).map((sid) => {
      const s = n[sid];
      const v = s.versions?.find((x) => x.v === s.current);
      const look = s.look ? n[s.look] : null;
      const lookFile = look?.versions?.find((x) => x.v === look.current)?.file || null;
      const beat = s.beat ? n[s.beat] : null;
      return { kind: v?.file ? 'shot' : lookFile ? 'image' : 'planned', id: sid, file: v?.file || lookFile, from: v?.from_sec ?? null, to: v?.to_sec ?? null,
        still: lookFile, label: `${s.label} · ${s.title || ''}`.trim(), beatLabel: beat?.label || null, beatTitle: beat?.title || null, colour: s.colour,
        stepName: v?.file ? (v.from_sec === 0 && s.versions.length > 1 ? 'Remade' : 'Animatic') : 'Planned shot', version: s.current || 1, planned: !v?.file, step: null,
        state: s.state, owner: s.owner, pending: s.pending, failed: s.failed, versions: s.versions?.length || 0 };
    });
  }

  // Every picture, video and sound the project has so far, in pipeline order (latest version of each step).
  function collect() {
    const shots = shotPieces();
    if (shots.length) return shots;
    const out = [];
    for (const s of d.steps) {
      const sub = d.submissions.filter((x) => x.step === s.key).at(-1);
      if (!sub) continue;
      sub.items.forEach((it, i) => {
        if (it.kind === 'text' && !it.text) return;
        out.push({ ...it, step: s.key, stepName: s.name, version: sub.version, i });
      });
    }
    return out;
  }

  function drawHead() {
    const tab = (key, label, href, live = true) => h('a', { class: `cv-mode${mode === key ? ' on' : ''}${live ? '' : ' off'}`, href: live ? href : null }, label);
    const finalSub = Boolean(finalOf());
    const turn = d.steps.find((s) => s.state === 'in_review');
    fill(head,
      h('a', { class: 'cv-brand', href: '#/' }, h('img', { src: 'img/mark.png', alt: '' }), h('span', null, 'Mortiflix')),
      h('span', { class: 'cv-title' }, d.title),
      h('nav', { class: 'cv-modes' },
        tab('import', 'Import', `#/p/${id}/canvas/import`),
        tab('edit', 'Edit', `#/p/${id}/canvas`),
        tab('export', 'Export', `#/p/${id}/canvas/export`, finalSub)),
      h('div', { class: 'cv-status' },
        d.status ? h('span', { class: 'cv-live' }, d.running ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null, h('span', null, d.status)) : null,
        turn ? (turn.review === 'questions' ? h('button', { class: 'btn primary', onclick: () => { rightTab = 'questions'; draw(); } }, `Your turn: ${turn.name}`)
          : turn.canvas ? [h('span', { class: 'cv-turn-hint' }, `${turn.name}: OK or cut each piece, or`),
            h('button', { class: 'btn primary', onclick: async () => {
              try { await api(`/api/projects/${id}/reviews/${turn.key}/${turn.version}`, { method: 'POST', body: { verdict: 'approve', notes: [], overall: 'Approved on the canvas.', answers: {} } }); ui.toast(`${turn.name} approved`); } catch (e) { ui.toast(e.message, true); }
            } }, `Approve ${turn.name}`)]
            : h('a', { class: 'btn primary', href: `#/p/${id}/review/${turn.key}` }, `Your turn: ${turn.name}`)) : null,
        h('a', { class: 'cv-out', href: `#/p/${id}` }, 'Project page')));
  }

  function media(it, { autoplay = false } = {}) {
    const url = fileUrl(id, it.file || '');
    if (it.kind === 'shot') {
      // Only this shot's seconds of the video: start at its first frame, stop (or go on) at its last.
      const v = h('video', { src: `${url}#t=${it.from},${it.to}`, controls: true, preload: 'auto', playsinline: true });
      v.addEventListener('loadedmetadata', () => { v.currentTime = it.from; if (autoplay) v.play().catch(() => {}); });
      v.addEventListener('timeupdate', () => { if (v.currentTime >= it.to - 0.02) { v.pause(); if (keep && !v.dataset.done) { v.dataset.done = '1'; go(sel + 1, true); } } });
      return v;
    }
    if (it.kind === 'planned') return h('div', { class: 'cv-empty' }, h('div', { class: 'big' }, 'Planned'), h('p', null, 'This shot is made with the animatic.'));
    if (it.kind === 'image') return h('img', { src: url, alt: it.label });
    if (it.kind === 'video') {
      const v = h('video', { src: url, controls: true, preload: 'metadata', autoplay, playsinline: true });
      v.addEventListener('ended', () => { if (keep) go(sel + 1, true); });
      return v;
    }
    if (it.kind === 'audio') {
      const a = h('audio', { src: url, controls: true, autoplay });
      a.addEventListener('ended', () => { if (keep) go(sel + 1, true); });
      return a;
    }
    return h('pre', { class: 'cv-text' }, it.text || '');
  }

  function drawMonitor(autoplay = false) {
    clearTimeout(advance);
    if (tp?.playing) { monitorBusy = true; tp.stop(); monitorBusy = false; }
    if (tsel) return drawTransition();
    const it = pieces[sel];
    if (!it) {
      return fill(monitor, h('div', { class: 'cv-empty' }, h('div', { class: 'big' }, 'Nothing to show yet'),
        h('p', null, d.status || 'The first frames appear here as soon as they are made.')));
    }
    // A still holds for 3 s when "Keep playing" is on, then the next piece plays.
    if (autoplay && keep && it.kind === 'image') advance = setTimeout(() => go(sel + 1, true), 3000);
    fill(monitor,
      h('div', { class: 'cv-stage' }, media(it, { autoplay })),
      h('div', { class: 'cv-caption' },
        it.beatLabel ? h('span', { class: 'cv-beat', style: { borderLeft: `3px solid ${it.colour?.chip || 'transparent'}` } }, it.beatLabel) : null,
        h('span', { class: 'cv-label' }, it.label),
        h('span', { class: 'cv-meta' }, `${it.stepName} · v${it.version}${it.from !== null && it.from !== undefined ? ` · ${clock(it.from)}–${clock(it.to)}` : ''} · ${sel + 1} of ${pieces.length}`),
        it.step ? h('a', { href: `#/p/${id}/review/${it.step}/${it.version}` }, 'Open in the review room') : null),
      it.beatTitle ? h('div', { class: 'cv-says' }, it.beatTitle) : null,
      it.id && graph?.nodes?.[it.id] ? actions(it) : null);
  }

  // OK / Fix / Cut it on the shot in the Monitor. Each one is sent at once: a Fix starts remaking that shot while you
  // go on to the next.
  const STATE_WORDS = { ready: 'ready', approved: 'OK', cut: 'cut', generating: 'remaking', 'needs you': 'needs you' };
  function actions(it) {
    const send = async (body) => {
      try { graph = await api(`/api/projects/${id}/canvas/nodes/${it.id}`, { method: 'POST', body }); pieces = collect(); drawMonitor(); drawBoard(); }
      catch (e) { ui.toast(e.message, true); }
    };
    const fixBox = h('textarea', { rows: 2, placeholder: `What should change in ${it.id.toUpperCase()}? (sent at once; it's remade while you carry on)` });
    const fixRow = h('div', { class: 'cv-fix', hidden: true }, fixBox,
      h('div', { class: 'cv-fix-end' }, h('button', { class: 'btn', onclick: () => { fixRow.hidden = true; } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => { const text = fixBox.value.trim(); if (!text) return ui.toast('Say what to change', true); await send({ action: 'fix', text }); if (keep) go(sel + 1, true); } }, 'Send')));
    const status = it.pending ? `Remaking (${it.pending.id}): ${it.pending.text}` : it.failed ? `Couldn't remake (${it.failed.id}): ${it.failed.note || it.failed.text}` : null;
    return h('div', { class: 'cv-actions' },
      h('div', { class: 'cv-act-row' },
        h('button', { class: `btn${it.owner === 'ok' ? ' on' : ''}`, onclick: async () => { await send({ action: it.owner === 'ok' ? 'clear' : 'ok' }); if (it.owner !== 'ok' && keep) go(sel + 1, true); } }, it.owner === 'ok' ? 'OK ✓' : 'OK'),
        h('button', { class: 'btn', disabled: Boolean(it.pending), onclick: () => { fixRow.hidden = false; fixBox.focus(); } }, 'Fix'),
        h('button', { class: `btn${it.owner === 'cut' ? ' on' : ''}`, onclick: () => send({ action: it.owner === 'cut' ? 'clear' : 'cut' }) }, it.owner === 'cut' ? 'Cut ✓ (bring back)' : 'Cut it'),
        h('span', { class: `cv-state st-${String(it.state).replace(' ', '-')}` }, STATE_WORDS[it.state] || it.state, it.versions > 1 ? ` · ${it.versions} versions` : ''),
        status ? h('span', { class: 'cv-status-text' }, status) : null),
      fixRow);
  }

  function drawBoard() {
    if (!pieces.length) return fill(board, h('div', { class: 'cv-empty' }, 'Pieces line up here, in order, as they are made.'));
    if (boardView === 'music') return drawMusic();
    if (boardView === 'nodes' && pieces[0]?.id) return drawNodes();
    fill(board, h('ol', { class: 'cv-strip' }, pieces.map((it, k) => h('li', null,
      h('button', { class: `cv-card${k === sel ? ' on' : ''}${it.state ? ` st-${String(it.state).replace(' ', '-')}` : ''}`, onclick: () => go(k, true), title: it.label, style: it.colour ? { background: it.colour.hex } : null },
        it.beatLabel ? h('span', { class: 'cv-ribbon', style: { background: it.colour?.chip } }, it.beatLabel) : null,
        h('span', { class: `cv-thumb kind-${it.kind}` },
          it.still ? h('img', { src: fileUrl(id, it.still), alt: '', loading: 'lazy' })
          : it.kind === 'image' ? h('img', { src: fileUrl(id, it.file), alt: '', loading: 'lazy' })
            : it.kind === 'video' ? h('video', { src: `${fileUrl(id, it.file)}#t=0.5`, preload: 'metadata', muted: true })
              : h('span', { class: 'cv-kind' }, it.kind === 'audio' ? 'Sound' : 'Text')),
        h('span', { class: 'cv-name' }, it.label),
        h('span', { class: 'cv-step' }, it.state && it.state !== 'ready' ? `${STATE_WORDS[it.state] || it.state} · ${it.stepName}` : it.stepName))))));
    board.querySelector('.cv-card.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // The noodle graph: the shots as nodes, left to right, each in its beat's colour, joined by noodles through a
  // transition node (the cut between two shots). Same shots, same selection as the Shots view.
  function drawNodes() {
    const n = graph?.nodes || {};
    const cutBetween = (a, b) => Object.values(n).find((x) => x.kind === 'transition' && !x.missing && x.from === a && x.to === b);
    const items = [];
    pieces.forEach((it, k) => {
      const s = n[it.id] || {};
      items.push(h('button', { class: `cv-node${k === sel ? ' on' : ''}${it.state ? ` st-${String(it.state).replace(' ', '-')}` : ''}`, 'data-k': k, onclick: () => go(k, true), title: it.label },
        h('span', { class: 'cv-node-head', style: { background: it.colour?.hex || 'var(--clip-video)' } },
          h('span', { class: 'cv-node-beat', style: { background: it.colour?.chip || 'transparent' } }, it.beatLabel || ''), h('span', null, s.label || it.id)),
        h('span', { class: 'cv-node-still' }, it.still ? h('img', { src: fileUrl(id, it.still), alt: '', loading: 'lazy' }) : h('span', { class: 'cv-kind' }, it.planned ? 'Planned' : 'Shot')),
        h('span', { class: 'cv-node-title' }, s.title || it.label),
        h('span', { class: 'cv-node-state' }, it.planned ? 'planned' : `v${it.version} · ${STATE_WORDS[it.state] || it.state || 'ready'}`),
        h('span', { class: 'cv-sock in', 'aria-hidden': 'true' }), h('span', { class: 'cv-sock out', 'aria-hidden': 'true' })));
      const next = pieces[k + 1];
      if (next) {
        const t = cutBetween(it.id, next.id);
        items.push(h('button', { class: `cv-tnode${tsel?.from === it.id ? ' on' : ''}${t?.pending ? ' st-generating' : ''}`, title: t ? `${t.label}: ${t.title}` : 'A cut (no transition chosen yet)',
          onclick: () => { if (!t) return ui.toast('This cut has no transition node yet: it appears with the transition board', true); tsel = { id: t.id, from: it.id, to: next.id }; drawMonitor(); drawBoard(); } },
          h('span', { class: 'cv-tnode-kind' }, 'Transition'), h('span', { class: 'cv-tnode-name' }, t?.title || 'Cut'),
          h('span', { class: 'cv-sock in', 'aria-hidden': 'true' }), h('span', { class: 'cv-sock out', 'aria-hidden': 'true' })));
      }
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cv-noodles');
    const row = h('div', { class: 'cv-nodes-row' }, items);
    const wrap = h('div', { class: 'cv-nodes' }, svg, row);
    fill(board, wrap);
    // Noodles: from each node's out socket to the next node's in socket, drawn once the layout is known.
    requestAnimationFrame(() => {
      const box = wrap.getBoundingClientRect();
      svg.setAttribute('width', row.scrollWidth); svg.setAttribute('height', row.scrollHeight);
      const all = [...row.children];
      const paths = [];
      for (let i = 0; i < all.length - 1; i++) {
        const a = all[i].querySelector('.cv-sock.out').getBoundingClientRect();
        const b = all[i + 1].querySelector('.cv-sock.in').getBoundingClientRect();
        const x1 = a.left + a.width / 2 - box.left + wrap.scrollLeft; const y1 = a.top + a.height / 2 - box.top + wrap.scrollTop;
        const x2 = b.left + b.width / 2 - box.left + wrap.scrollLeft; const y2 = b.top + b.height / 2 - box.top + wrap.scrollTop;
        const dx = Math.max(24, (x2 - x1) / 2);
        paths.push(`<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`);
      }
      svg.innerHTML = paths.join('');
      row.querySelector('.cv-node.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }

  // The AI's questions, right in the canvas: the brief's (all at once, one Send) and any it asks mid-step.
  function openQuestions() {
    const brief = d.steps.find((s) => s.review === 'questions' && s.state === 'in_review');
    const sub = brief ? d.submissions.filter((x) => x.step === brief.key).at(-1) : null;
    const fromBrief = sub ? (sub.questions || []).map((q) => ({ ...q, from: 'brief' })) : [];
    const mid = (d.project.questions || []).filter((q) => !q.answered_at).map((q) => ({ ...q, from: 'ask' }));
    return { brief, sub, list: [...fromBrief, ...mid] };
  }

  function drawQuestions() {
    const { brief, sub, list } = openQuestions();
    if (!list.length) return fill(asked, h('div', { class: 'cv-empty' }, 'No questions right now. When the AI needs you to decide something, it asks here.'));
    const row = (q) => {
      const key = `${q.from}:${q.id}`;
      const set = (v) => { answers[key] = v; };
      const ctl = q.choices ? ui.customChips(q.choices, answers[key] ?? null, set)
        : h('input', { type: 'text', value: answers[key] || '', placeholder: q.default ? `Your call: ${q.default}` : 'Your answer', oninput: (e) => set(e.target.value) });
      return h('div', { class: 'cv-q' }, h('div', { class: 'cv-q-text' }, q.text),
        q.default ? h('div', { class: 'cv-q-default' }, `Going with: ${q.default} unless you say otherwise`) : h('div', { class: 'cv-q-default need' }, 'Needs your answer'),
        ctl,
        q.from === 'ask' ? h('div', { class: 'cv-fix-end' }, h('button', { class: 'btn primary', onclick: async () => {
          try { await api(`/api/projects/${id}/questions/${q.id}`, { method: 'POST', body: { answer: answers[key] || null } }); ui.toast('Answered'); } catch (e) { ui.toast(e.message, true); }
        } }, 'Answer')) : null);
    };
    const briefQs = list.filter((q) => q.from === 'brief');
    const wrong = h('textarea', { rows: 2, placeholder: 'Something wrong with the brief? Say what, and it is redone instead.' });
    fill(asked,
      brief && sub?.note ? h('div', { class: 'cv-q-note' }, sub.note) : null,
      list.map(row),
      briefQs.length ? h('div', { class: 'cv-q-send' }, wrong, h('div', { class: 'cv-fix-end' },
        h('button', { class: 'btn', onclick: async () => {
          if (!wrong.value.trim()) return ui.toast('Say what is wrong with the brief', true);
          try { await api(`/api/projects/${id}/reviews/${brief.key}/${sub.version}`, { method: 'POST', body: { verdict: 'changes', notes: [], overall: wrong.value.trim(), answers: {} } }); ui.toast('Sent: the brief is redone'); } catch (e) { ui.toast(e.message, true); }
        } }, 'Redo the brief'),
        h('button', { class: 'btn primary', onclick: async () => {
          const out = Object.fromEntries(briefQs.map((q) => [q.id, answers[`brief:${q.id}`]]).filter(([, v]) => v !== undefined && String(v).trim()));
          try { await api(`/api/projects/${id}/reviews/${brief.key}/${sub.version}`, { method: 'POST', body: { verdict: 'approve', notes: [], overall: '', answers: out } }); ui.toast('Sent'); rightTab = 'doing'; } catch (e) { ui.toast(e.message, true); }
        } }, 'Send the answers'))) : null);
  }

  // Where the computer's at, in detail: what it's doing now, the steps, any render with its progress and time left,
  // the session's own to-do list, the files it made this session, a few counters, then everything it did.
  // The music: the score's sections in their beats' colours (bars, what each does, how intense), and the MIDI pack:
  // every part on its own channel, a clip per section, and the import steps for the owner's DAW (REAPER…).
  // The Music tab: the song lane under the shots (doc 19), read-only; the MIDI pack below it.
  let lane = null;
  let tp = null;            // the transport: the last render plays, the Monitor follows (doc 19 §4)
  let roll = null;          // the Piano roll, at a part's level
  let monitorBusy = false;
  async function drawMusic() {
    const [ms, sv] = await Promise.all([api(`/api/projects/${id}/music`).catch(() => null), api(`/api/projects/${id}/music/song`).catch(() => null)]);
    if (boardView !== 'music') return;
    lane?.lane?.stop();
    const n = graph?.nodes || {};
    // the same node as the Nodes board, for each shot in the edit; clicking one selects it like there
    const shotNode = (shot, { compact }) => {
      const k = pieces.findIndex((it) => it.id === shot.id);
      const it = pieces[k] || {};
      const s = n[shot.id] || {};
      return h('button', { class: `cv-node${k === sel ? ' on' : ''}`, title: `${s.label || shot.id} · ${s.title || ''}`, onclick: () => { if (k >= 0) go(k, true); } },
        h('span', { class: 'cv-node-head', style: { background: it.colour?.hex || s.colour?.hex || 'var(--clip-video)' } },
          h('span', { class: 'cv-node-beat', style: { background: it.colour?.chip || s.colour?.chip || 'transparent' } }, compact ? (s.label || shot.id).replace(/^S0?/, '') : it.beatLabel || ''), compact ? null : h('span', null, s.label || shot.id)),
        h('span', { class: 'cv-node-still' }, it.still ? h('img', { src: fileUrl(id, it.still), alt: '', loading: 'lazy' }) : h('span', { class: 'cv-kind' }, 'Shot')),
        h('span', { class: 'cv-node-title' }, s.title || it.label || ''));
    };
    const transitionOf = (a, b) => Object.values(n).find((x) => x.kind === 'transition' && !x.missing && x.from === a && x.to === b) || null;
    const song = sv?.song || null;
    drawCrumbs(song);
    // the same song, shots and level as on screen: keep the lane (its zoom and scroll) as it is
    const key = JSON.stringify([song?.rev, sv?.draft, graph?.rev, level, ms?.midi?.length]);
    if (board.contains(roll || lane) && (roll || lane)?.dataset.key === key) return;
    const focus = level.section && song?.patterns.some((p) => p.id === level.section) ? level : null;
    const atPart = focus?.part && song.channels.some((c) => c.id === focus.part);
    // screen A (the song) and screen B (a section, rows at 40 px) are the lane; the Piano roll uses its timing
    lane = song ? ui.songLane({ h, song, graph, draft: sv.draft, shotNode, transitionOf, focus: focus ? { section: focus.section } : null, rowHeight: focus ? 40 : null,
      onOpen: (sec, part) => openLevel(sec, part), onSeek: (t) => tp?.seek(t), onSelect: (sel) => barPopup(sel, song, sv.draft) }) : null;
    if (lane) lane.dataset.key = key;
    if (lane && !sv.draft) lane.lane.onPlus = (sectionId, atBar) => plusMenu(sectionId, atBar, song);
    const info = focus ? lane.lane.sections.find((x) => x.id === focus.section) : null;
    roll?.roll?.stop(); roll = null;
    if (atPart) {
      roll = ui.pianoRoll({ h, view: sv, at: focus, cuts: lane.lane.cuts, ax: lane.lane.ax, sectionInfo: info,
        onPick: (part) => openLevel(focus.section, part),
        onOpenPart: (part) => ui.toast(`${song.channels.find((c) => c.id === part)?.name}'s instrument and effects open here once the sound engine and plugins are in (it plays its Strudel sound for now)`) });
      roll.dataset.key = key;
    }
    // the transport: the last render (the canvas's music node) is the clock without the sound engine
    tp?.destroy(); tp = null;
    const mus = n.music && !n.music.missing ? n.music.versions?.find((v) => v.v === n.music.current) : null;
    // the sound engine when it's installed (it plays the song itself, edits heard at once), else the last render
    const daw = await api('/api/daw').catch(() => null);
    const useEngine = Boolean(daw?.available) && !sv.draft;
    let bar = null;
    if (lane && (useEngine || mus?.file)) {
      const shotsSrc = lane.lane.shots.map((s) => {
        const v = (n[s.id]?.versions || []).find((x) => x.v === n[s.id].current) || {};
        return { ...s, src: fileUrl(id, v.file), srcFrom: v.from_sec || 0 };
      });
      const pos = h('span', { class: 'tp-pos' }, 'bar 1.1 · 0:00.0');
      const btn = h('button', { class: 'btn', onclick: () => (tp.playing ? tp.stop() : tp.play()) }, '▶ Play');
      const ax = lane.lane.ax;
      const avKey = 'mfx-av-offset';
      const avOffset = () => { try { return Number(store.get(avKey)) || 0; } catch { return 0; } };
      const source = useEngine
        ? ui.engineSource({ api, project: id, offsetSec: song.offsetSec || 0, avOffsetMs: avOffset, subscribe: ui.onServerEvent })
        : ui.audioSource(h, fileUrl(id, mus.file));
      tp = ui.createTransport({ h, source, shots: shotsSrc, fps: graph?.fps || 30,
        onTime: (t) => {
          lane.lane.setPlayhead(t);
          roll?.roll.setPlayhead(t);
          const barF = Math.max(0, (t - (song.offsetSec || 0)) / (ax.barSec(2) - ax.barSec(1)));
          const beatsPerBar = ax.tpb / (song.ppq || 960);
          pos.textContent = `bar ${Math.floor(barF) + 1}.${Math.floor((barF % 1) * beatsPerBar) + 1} · ${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
        },
        onState: (playing) => {
          btn.textContent = playing ? '■ Stop' : '▶ Play';
          if (playing) fill(monitor, tp.stage, h('div', { class: 'cv-caption' }, h('span', { class: 'cv-cap-name' }, 'The cut, with the music')));
          else if (monitor.contains(tp.stage) && !monitorBusy) drawMonitor();
        } });
      lane.lane.setPlayhead(focus ? info.from : 0);
      lane.transport = tp;   // its frame-error log is read by the sync test
      // the picture's offset against the sound, per viewer (screens and speakers have their own delay; doc 19 §4)
      const av = h('input', { type: 'range', min: -200, max: 200, step: 5, value: avOffset(), class: 'tp-av', 'aria-label': 'Picture offset against the sound, in milliseconds',
        oninput: () => { try { store.set(avKey, Number(av.value)); } catch { /* per viewer only */ } avLabel.textContent = `${av.value > 0 ? '+' : ''}${av.value} ms`; } });
      const avLabel = h('span', { class: 'tp-av-label' }, `${avOffset() > 0 ? '+' : ''}${avOffset()} ms`);
      bar = h('div', { class: 'tp-bar' }, btn, pos,
        h('span', { class: 'tp-note' }, useEngine ? 'The sound engine plays the song: edits are heard on the next pass' : 'Playing the last render: install the sound engine to hear edits at once (Settings › Setup)'),
        useEngine ? h('label', { class: 'tp-av-wrap', title: 'Move the picture earlier (−) or later (+) if it looks out of step with the sound' }, 'Picture', av, avLabel) : null);
    }
    // screen B: the section's Strudel beside its rows (doc 28 §5.1), read-only for now
    const strudelColumn = () => h('div', { class: 'sb-code', 'aria-label': `The Strudel of ${focus.section}` },
      song.channels.filter((c) => sv.rows?.[focus.section]?.[c.id] !== undefined).map((c) => h('section', { class: 'sb-part' },
        h('div', { class: 'sb-part-head' }, h('i', { class: 'pr-dot', style: { background: c.colour || 'var(--muted)' } }), `${c.name}`),
        h('pre', { class: 'sb-pre' }, sv.rows[focus.section][c.id]))));
    fill(board, h('div', { class: 'cv-music' },
      bar,
      !song ? h('div', { class: 'cv-empty' }, sv?.error ? `The music couldn't be drawn: ${sv.error}` : 'The music appears here under the shots once the score passes its check.')
        : atPart ? roll
          : focus ? h('div', { class: 'sb' }, lane, strudelColumn())
            : lane,
      atPart ? null
        : focus ? h('p', { class: 'help' }, 'Double-click a part to open its notes. Right-click empty space or press Alt+← to go back.')
          : ms?.midi?.length ? ui.musicPanel(id, ms) : h('p', { class: 'help' }, 'When the score passes its check, its MIDI pack shows here: every part on its own channel, a clip per section, and the steps to bring it into your DAW (Settings › Your DAW). Double-click a section to open it.')));
  }

  // The verdict popup on selected bars (doc 19 §2, mockup A): OK locks them as approved; Fix sends an edit request on
  // the section with the bars (counted inside it), the part and the owner's words. Cut it / Repeat / Mute come next.
  let popup = null;
  function barPopup(sel, song, draft) {
    popup?.remove(); popup = null;
    if (!sel || !lane) return;
    const pat = song.patterns.find((p) => p.id === sel.section);
    const at = lane.lane.sections.find((x) => x.id === sel.section);
    const inFrom = sel.from - at.startBar + 1; const inTo = sel.to - at.startBar + 1;
    const ch = sel.part ? song.channels.find((c) => c.id === sel.part) : null;
    const bars = sel.from === sel.to ? `Bar ${sel.from}` : `Bars ${sel.from}–${sel.to}`;
    const words = h('textarea', { class: 'sl-pop-text', rows: 2, placeholder: 'Drop the drums, bigger bass into the cut…', 'aria-label': 'What to change' });
    const msg = h('div', { class: 'sl-pop-msg', role: 'status' });
    const tpb = lane.lane.ax.tpb;
    const close = () => { popup?.remove(); popup = null; lane.lane.select(null); };
    const ok = async () => {
      if (draft) return fill(msg, 'Import the song first (it locks bars once it exists).');
      try {
        await api(`/api/projects/${id}/music/song/ops`, { method: 'POST', body: { ops: [{ op: 'lock.add', lockBy: 'ok', scope: { pattern: sel.section, ...(sel.part ? { channel: sel.part } : {}), fromTick: (inFrom - 1) * tpb, toTick: inTo * tpb } }] } });
        ui.toast(`${bars} OK'd: the AI won't change them`);
        close();
      } catch (e) { fill(msg, e.message); }
    };
    const send = async () => {
      const text = words.value.trim();
      if (!text) { words.focus(); return fill(msg, 'Say what to change.'); }
      try {
        await api(`/api/projects/${id}/canvas/nodes/${sel.section}`, { method: 'POST', body: { action: 'fix', text, bars: [inFrom, inTo], ...(sel.part ? { part: sel.part } : {}) } });
        ui.toast(`Fix sent: ${bars} of ${pat.id.toUpperCase()}${ch ? ` (${ch.name})` : ''}`);
        close();
      } catch (e) { fill(msg, e.message); }
    };
    // Cut it, Repeat, Mute a part: the owner's own edits, at once (heard after the next render until the engine)
    const songOps = async (ops, said) => {
      if (draft) return fill(msg, 'Import the song first (mortiflix music <project> --song).');
      try { await api(`/api/projects/${id}/music/song/ops`, { method: 'POST', body: { ops } }); ui.toast(said); close(); drawBoard(); } catch (e) { fill(msg, e.message); }
    };
    const playing = song.channels.filter((c) => Object.keys(pat.notes || {}).includes(c.id));
    const mutePart = h('select', { class: 'sl-pop-select', 'aria-label': 'Part to mute' }, playing.map((c) => h('option', { value: c.id, selected: c.id === sel.part }, c.name)));
    popup = h('div', { class: 'sl-pop', role: 'dialog', 'aria-label': 'Selected bars' },
      h('div', { class: 'sl-pop-title' }, `${bars} · ${pat.id.toUpperCase()} ${pat.name || ''}${at.under ? ` · under ${at.under}` : ''}${ch ? ` · ${ch.name}` : ''}`),
      h('div', { class: 'sl-pop-row' },
        h('button', { class: 'btn', onclick: ok }, 'OK'),
        h('button', { class: 'btn', onclick: () => songOps([{ op: 'section.time', section: sel.section, kind: 'cut', from: inFrom, to: inTo }], `${bars} cut: the music after them moved up`) }, 'Cut it'),
        h('button', { class: 'btn', onclick: () => songOps([{ op: 'section.time', section: sel.section, kind: 'repeat', from: inFrom, to: inTo }], `${bars} repeated: the music after them moved on`) }, 'Repeat'),
        h('span', { class: 'sl-pop-mute' }, h('button', { class: 'btn', onclick: () => songOps([{ op: 'note.mute', pattern: sel.section, channel: mutePart.value, bars: [inFrom, inTo] }], `${song.channels.find((c) => c.id === mutePart.value)?.name} muted in ${bars.toLowerCase()}`) }, 'Mute'), mutePart)),
      h('div', { class: 'sl-pop-hint' }, 'or say what to fix:'),
      words,
      msg,
      h('div', { class: 'sl-pop-row end' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: send }, 'Fix')));
    words.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); if (e.key === 'Escape') close(); });
    const left = Math.max(8, Math.min(lane.clientWidth - 338, lane.lane.x(lane.lane.ax.barSec(sel.from)) - lane.querySelector('.sl-scroll').scrollLeft));
    popup.style.left = `${left}px`;
    lane.append(popup);
  }

  // + on a section boundary (doc 19 §2): add 1 / 2 / 4 / 8 bars, empty, repeating the bars before, or written by the AI
  // (empty bars plus a Fix for them, which the fast path answers).
  function plusMenu(sectionId, atBar, song) {
    popup?.remove(); popup = null;
    const pat = song.patterns.find((p) => p.id === sectionId);
    const count = h('select', { class: 'sl-pop-select', 'aria-label': 'How many bars' }, [1, 2, 4, 8].map((n) => h('option', { value: n, selected: n === 2 }, `${n} bar${n > 1 ? 's' : ''}`)));
    const how = h('select', { class: 'sl-pop-select', 'aria-label': 'What goes in them' }, h('option', { value: 'empty' }, 'Empty'), h('option', { value: 'repeat' }, 'Repeat the bars before'), h('option', { value: 'ai' }, 'Let the AI write them'));
    const msg = h('div', { class: 'sl-pop-msg', role: 'status' });
    const close = () => { popup?.remove(); popup = null; };
    const add = async () => {
      const n = Number(count.value);
      const at = atBar;   // inside the section, 1-based: where the new bars start
      try {
        if (how.value === 'repeat') {
          const from = Math.max(1, at - n);
          await api(`/api/projects/${id}/music/song/ops`, { method: 'POST', body: { ops: [{ op: 'section.time', section: sectionId, kind: 'repeat', from, to: at - 1 }] } });
        } else {
          await api(`/api/projects/${id}/music/song/ops`, { method: 'POST', body: { ops: [{ op: 'section.time', section: sectionId, kind: 'add', at, n }] } });
          if (how.value === 'ai') await api(`/api/projects/${id}/canvas/nodes/${sectionId}`, { method: 'POST', body: { action: 'fix', text: 'write these new bars: lead on from the bars before into what comes next', bars: [at, at + n - 1], write: true } });
        }
        ui.toast(`${n} bar${n > 1 ? 's' : ''} added to ${sectionId.toUpperCase()}`);
        close(); drawBoard();
      } catch (e) { fill(msg, e.message); }
    };
    popup = h('div', { class: 'sl-pop', role: 'dialog', 'aria-label': 'Add bars' },
      h('div', { class: 'sl-pop-title' }, `Add bars at the end of ${pat.id.toUpperCase()} ${pat.name || ''}`),
      h('div', { class: 'sl-pop-row' }, count, how), msg,
      h('div', { class: 'sl-pop-row end' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: add }, 'Add')));
    const s0 = lane.lane.sections.find((x) => x.id === sectionId);
    popup.style.left = `${Math.max(8, Math.min(lane.clientWidth - 338, lane.lane.x(s0.to) - lane.querySelector('.sl-scroll').scrollLeft - 300))}px`;
    lane.append(popup);
  }

  // Song › m02 The bet › Bass: each earlier crumb goes back to its level.
  function drawCrumbs(song) {
    if (boardView !== 'music') return fill(crumbs);
    const sec = level.section ? song?.patterns.find((p) => p.id === level.section) : null;
    const ch = level.part ? song?.channels.find((c) => c.id === level.part) : null;
    const items = [['Song', base()]];
    if (sec) items.push([`${sec.id} ${sec.name || ''}`.trim(), `${base()}?music=${sec.id}`]);
    if (sec && ch) items.push([ch.name, `${base()}?music=${sec.id}/${ch.id}`]);
    fill(crumbs, items.map(([label, href], i) => [i ? h('span', { class: 'cv-crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      i === items.length - 1 ? h('span', { class: 'cv-crumb on', 'aria-current': 'page' }, label) : h('a', { class: 'cv-crumb', href }, label)]));
  }
  const base = () => `#/p/${id}/canvas`;
  function openLevel(section, part) { location.hash = `${base()}?music=${section}${part ? `/${part}` : ''}`.slice(1); }
  // Back is a navigation, never an edit: the browser's own history.
  const back = () => { if (level.section) history.back(); };
  const parseLevel = (q) => {
    const m = new URLSearchParams(q || '').get('music')?.match(/^(m\d{2,3}|p\d{2,3})(?:\/(ch\d{2,}))?$/);
    return { section: m?.[1] || null, part: m?.[2] || null };
  };
  // A level change redraws the board only: the Monitor (and its video) is left alone.
  function syncBoardChrome() {
    root.querySelector('.cv-grid')?.classList.toggle('cv-board-music', boardView === 'music');
    for (const b of root.querySelectorAll('.cv-p-board .cv-tab')) b.classList.toggle('on', b.textContent === { shots: 'Shots', nodes: 'Nodes', music: 'Music' }[boardView]);
  }
  // Right-click on empty space goes back a level (press and release within 4 px; a drag is never a back).
  let rightDown = null;
  board.addEventListener('mousedown', (e) => { if (e.button === 2) rightDown = [e.clientX, e.clientY]; });
  board.addEventListener('contextmenu', (e) => {
    if (!level.section || e.target.closest('button, a, input, textarea, select')) return;
    const moved = rightDown ? Math.hypot(e.clientX - rightDown[0], e.clientY - rightDown[1]) : 0;
    rightDown = null;
    e.preventDefault();
    if (moved <= 4) back();
  });

  function drawDoing() {
    const acts = d.activity || [];
    let from = acts.length - 1;
    while (from >= 0 && !/^Session started/.test(acts[from].text || '')) from--;
    const session = from >= 0 ? acts.slice(from) : [];
    const live = d.running && session.length && !session.some((a) => /^Session ended/.test(a.text || ''));
    const todos = [...session].reverse().find((a) => a.kind === 'todo')?.todos || null;
    const rel = (p) => String(p).replace(/^.*\/projects\/[a-z0-9-]+\//, '');
    const files = [...new Set(session.filter((a) => a.kind === 'tool' && /^(Write|Edit) /.test(a.text)).map((a) => rel(a.text.replace(/^(Write|Edit) /, ''))))];
    const tools = session.filter((a) => a.kind === 'tool').length;
    const mins = session.length ? Math.max(0, Math.round((Date.parse(session.at(-1).t) - Date.parse(session[0].t)) / 60000)) : 0;
    const log = h('div', { class: 'log', id: `log-${id}` });
    for (const a of acts) if (a.kind !== 'todo') ui.appendLog(log, a, false);
    const clockLeft = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`);
    fill(doing,
      h('div', { class: 'cv-now' }, d.running ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null, h('span', null, d.status || 'Waiting')),
      h('ol', { class: 'cv-steps' }, d.steps.map((s) => h('li', { class: `st-${s.state}` }, ui.icon(s.state), h('span', null, s.name)))),
      (d.renders || []).map((r) => h('div', { class: 'cv-render' },
        h('div', { class: 'cv-render-top' }, h('span', null, r.state === 'waiting' ? `Waiting to render: ${r.label}${r.renders_ahead ? ` (${r.renders_ahead} ahead)` : ''}` : `Rendering: ${r.label}`),
          r.progress ? h('span', { class: 'cv-meta' }, [r.progress.percent !== undefined ? `${r.progress.percent}%` : null, r.progress.total ? `${r.progress.phase === 'encoding' ? 'encoded' : 'frame'} ${r.progress.done}/${r.progress.total}` : r.progress.seconds !== undefined ? `${Math.round(r.progress.seconds)} s done` : null, r.progress.seconds_left !== undefined ? `${clockLeft(r.progress.seconds_left)} left` : null].filter(Boolean).join(' · ')) : null),
        h('div', { class: 'cv-bar' }, h('i', { style: { width: `${r.progress?.percent ?? (r.state === 'running' ? 8 : 0)}%` } })))),
      todos ? h('div', { class: 'cv-todo' }, h('div', { class: 'cv-sub' }, 'Its to-do list'),
        h('ul', null, todos.map((x) => h('li', { class: `td-${x.status}` }, h('span', { class: 'td-mark' }, x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '●' : '○'), x.content)))) : null,
      files.length ? h('div', { class: 'cv-files' }, h('div', { class: 'cv-sub' }, `Files this session (${files.length})`), h('div', { class: 'cv-file-list' }, files.slice(-12).map((f) => h('code', null, f)))) : null,
      session.length ? h('div', { class: 'cv-counters' }, `${live ? 'This session' : 'Last session'}: ${mins} min · ${tools} actions · ${files.length} files`) : null,
      log);
    log.scrollTop = log.scrollHeight;
  }

  // The script area walks you through the script: every beat in order, in its colour, the playing one lit. Click a
  // beat to play its shot; "Change the words" asks for a new version of just that beat.
  function drawScript() {
    const n = graph?.nodes || {};
    const beats = (graph?.order?.beats || []).map((b) => n[b]).filter(Boolean);
    if (!beats.length) return fill(script, h('div', { class: 'cv-empty' }, 'The script appears here, beat by beat, as soon as it is written.'));
    const playing = pieces[sel]?.beatLabel?.toLowerCase() || null;
    const shotOf = (bid) => pieces.findIndex((x) => x.id && n[x.id]?.beat === bid);
    fill(script,
      h('ol', { class: 'cv-beats' }, beats.map((b) => {
        const k = shotOf(b.id);
        const on = playing === b.id;
        const pend = b.pending;
        const box = h('textarea', { rows: 2, placeholder: 'What should these words say instead?' });
        const row = h('div', { class: 'cv-fix', hidden: true }, box, h('div', { class: 'cv-fix-end' },
          h('button', { class: 'btn', onclick: () => { row.hidden = true; } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => {
            const text = box.value.trim(); if (!text) return ui.toast('Say what to change', true);
            try { graph = await api(`/api/projects/${id}/canvas/nodes/${b.id}`, { method: 'POST', body: { action: 'fix', text } }); pieces = collect(); drawScript(); } catch (e) { ui.toast(e.message, true); }
          } }, 'Send')));
        return h('li', { class: `cv-beat-row${on ? ' on' : ''}${b.state === 'cut' ? ' st-cut' : ''}`, style: { borderLeftColor: b.colour?.chip || 'transparent' } },
          h('button', { class: 'cv-beat-btn', onclick: () => { if (k >= 0) go(k, true); } },
            h('span', { class: 'cv-beat-id' }, b.label, b.versions?.length > 1 ? h('span', { class: 'cv-beat-v' }, ` v${b.current}`) : null),
            h('span', { class: 'cv-beat-words' }, b.title),
            b.visual ? h('span', { class: 'cv-beat-visual' }, b.visual) : null),
          pend ? h('div', { class: 'cv-status-text' }, `Rewriting (${pend.id}): ${pend.text}`) : on ? h('button', { class: 'btn link cv-beat-change', onclick: () => { row.hidden = false; box.focus(); } }, 'Change the words') : null,
          row);
      })),
      h('div', { class: 'cv-walk' }, h('button', { class: 'btn', onclick: () => { keep = true; store.set(keepKey, true); draw(); go(Math.max(0, shotOf(beats[0].id)), true); } }, '▶ Walk through')));
    script.querySelector('.cv-beat-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  // A transition node: the cut between two shots. Pick one from the transition library (or say it in your own words);
  // Preview plays the last seconds of the shot before into the first seconds of the one after, across the cut.
  async function drawTransition() {
    const n = graph?.nodes || {};
    const t = n[tsel.id];
    const a = pieces.find((x) => x.id === tsel.from);
    const b = pieces.find((x) => x.id === tsel.to);
    if (!library) library = await api('/api/transitions').catch(() => ({ installed: false, transitions: [], families: [] }));
    let query = '';
    let picked = null;
    const list = h('div', { class: 'cv-tlist' });
    const famName = (slug) => library.families.find((f) => f.slug === slug)?.name || slug;
    const drawList = () => {
      const q = query.toLowerCase();
      const shown = library.transitions.filter((x) => !q || `${x.name} ${x.summary} ${x.uses.join(' ')} ${famName(x.family)}`.toLowerCase().includes(q));
      fill(list, shown.length ? shown.map((x) => h('button', { class: `cv-titem${picked?.id === x.id ? ' on' : ''}`, onclick: () => { picked = x; drawList(); } },
        h('span', { class: 'cv-tname' }, x.name, h('span', { class: 'cv-tfam' }, ` · ${famName(x.family)}`)), h('span', { class: 'cv-tsum' }, x.summary)))
        : h('div', { class: 'cv-empty' }, library.installed ? 'Nothing matches.' : 'The transition library isn\'t installed (Settings › Setup › Transitions). Say what you want below.'));
    };
    const own = h('textarea', { rows: 2, placeholder: 'Or say it in your own words: "a whip pan to the right", "cut on the beat"…' });
    const stage = h('div', { class: 'cv-stage cv-tstage' });
    const preview = () => {
      if (!a?.file || !b?.file || a.kind !== 'shot' || b.kind !== 'shot') return ui.toast('Preview needs both shots made (the animatic)', true);
      const blend = !picked || picked.structure !== 'instant';
      const va = h('video', { src: fileUrl(id, a.file), muted: false, playsinline: true });
      const vb = h('video', { src: fileUrl(id, b.file), playsinline: true, class: 'cv-tb' });
      fill(stage, va, vb);
      const lead = Math.min(1.5, a.to - a.from);
      va.addEventListener('loadedmetadata', () => { va.currentTime = a.to - lead; va.play().catch(() => {}); });
      vb.addEventListener('loadedmetadata', () => { vb.currentTime = b.from; });
      va.addEventListener('timeupdate', () => {
        const left = a.to - va.currentTime;
        if (blend && left < 0.5) { vb.style.opacity = String(1 - left / 0.5); if (vb.paused) vb.play().catch(() => {}); }
        if (left <= 0.02) { va.pause(); vb.style.opacity = '1'; if (vb.paused) vb.play().catch(() => {}); }
      });
      vb.addEventListener('timeupdate', () => { if (vb.currentTime >= Math.min(b.to, b.from + 1.5)) vb.pause(); });
    };
    fill(monitor,
      stage,
      h('div', { class: 'cv-caption' },
        h('span', { class: 'cv-label' }, `${t?.label || tsel.id.toUpperCase()} · the cut from ${tsel.from.toUpperCase()} to ${tsel.to.toUpperCase()}`),
        h('span', { class: 'cv-meta' }, `Now: ${t?.title || 'Cut'}${t?.pending ? ` · changing (${t.pending.id})` : ''}`),
        h('button', { class: 'btn', onclick: preview }, '▶ Preview across the cut')),
      h('div', { class: 'cv-tpick' },
        h('input', { type: 'text', placeholder: `Search ${library.transitions.length || ''} transitions: crossfade, match cut, push…`, oninput: (e) => { query = e.target.value; drawList(); } }),
        list, own,
        h('div', { class: 'cv-fix-end' }, h('button', { class: 'btn', onclick: () => { tsel = null; drawMonitor(); drawBoard(); } }, 'Back to the shot'),
          h('button', { class: 'btn primary', disabled: !t, onclick: async () => {
            const words = own.value.trim();
            const text = picked ? `Use the "${picked.name}" transition (${picked.id})${words ? `: ${words}` : ''}` : words;
            if (!text) return ui.toast('Pick a transition or say what you want', true);
            try { graph = await api(`/api/projects/${id}/canvas/nodes/${tsel.id}`, { method: 'POST', body: { action: 'fix', text } }); pieces = collect(); drawTransition(); drawBoard(); } catch (e) { ui.toast(e.message, true); }
          } }, 'Use this transition'))));
    drawList();
    if (a?.still) fill(stage, h('img', { src: fileUrl(id, a.still), alt: '' }));
  }

  function go(k, autoplay = false) {
    tsel = null;
    // Keep playing steps over shots the owner cut.
    if (autoplay) { const dir = k >= sel ? 1 : -1; while (pieces[k]?.state === 'cut' && k !== sel) k += dir; }
    if (k < 0 || k >= pieces.length) return;
    sel = k;
    drawMonitor(autoplay);
    drawBoard();
    drawScript();
  }

  async function load() {
    const raw = await api(`/api/projects/${id}`);
    const p = raw.project;
    const runner = ui.studio()?.runner;
    graph = await api(`/api/projects/${id}/canvas`).catch(() => null);
    fcInfo = mode === 'export' ? await api(`/api/projects/${id}/edit`).catch(() => null) : null;
    d = { ...raw, title: p.title, status: p.status || (p.state === 'waiting' ? 'Waiting for you' : p.state === 'done' ? 'Delivered' : null),
      running: runner?.project === id, intake: p.intake, pipelineName: raw.pipeline?.name, intakeQs: raw.pipeline?.intake || [] };
    const keyOf = (x) => x.id || `${x.step}/${x.version}/${x.i}`;
    const before = pieces[sel] ? keyOf(pieces[sel]) : null;
    pieces = collect();
    const at = before ? pieces.findIndex((x) => keyOf(x) === before) : -1;
    if (at >= 0) sel = at; else sel = Math.min(sel, Math.max(0, pieces.length - 1));
  }

  // Skills and tools: the project's SKILLS.md as rows; click a skill to read its SKILL.md.
  function skillsPanel() {
    const body = h('div', { class: 'cv-body cv-skills' }, h('div', { class: 'cv-empty' }, 'Loading…'));
    api(`/api/projects/${id}/skills`).then((list) => {
      const notSet = list.items.filter((x) => x.state !== 'ready').length;
      const reader = h('pre', { class: 'cv-skill-text', hidden: true });
      const row = (x) => h('li', { class: 'cv-skill' },
        h('button', { class: 'cv-skill-btn', disabled: x.kind !== 'skill', onclick: async () => {
          try { const r = await api(`/api/projects/${id}/skills/${x.name}`); reader.textContent = r.text; reader.hidden = false; reader.scrollIntoView({ block: 'nearest' }); } catch (e) { ui.toast(e.message, true); }
        } },
          h('span', { class: 'cv-skill-name' }, x.name),
          h('span', { class: 'chip' }, x.kind === 'mcp' ? 'MCP' : x.kind),
          h('span', { class: `chip ${x.state === 'ready' ? 'ok' : 'warn'}` }, x.state),
          x.from ? h('span', { class: 'cv-skill-from' }, x.from === 'pipeline' ? 'pipeline (pinned)' : x.from) : null),
        h('div', { class: 'cv-skill-use' }, x.use || x.where || '', x.fix ? h('span', { class: 'cv-skill-fix' }, ` Fix: ${x.fix}`) : null));
      fill(body,
        h('p', { class: 'help' }, `${list.items.length} skills, tools and servers · ${notSet ? `${notSet} not set up` : 'all set up'} · backend ${list.backend}. Sessions read this as SKILLS.md.`),
        ['skill', 'tool', 'mcp'].map((k) => {
          const xs = list.items.filter((x) => x.kind === k);
          return xs.length ? [h('h2', null, k === 'skill' ? 'Skills' : k === 'tool' ? 'Tools' : 'MCP servers'), h('ul', { class: 'cv-skill-list' }, xs.map(row))] : null;
        }),
        reader);
    }).catch((e) => fill(body, h('p', { class: 'err' }, e.message)));
    return body;
  }

  function drawImport() {
    const brief = Object.entries(d.intake?.answers || {}).filter(([, v]) => String(v).trim());
    return h('div', { class: 'cv-grid cv-grid-two' },
      panel('Skills and tools', skillsPanel(), null, 'cv-p-skills'),
      panel('Idea', h('div', { class: 'cv-body' },
        h('dl', { class: 'cv-brief' }, h('dt', null, 'Name'), h('dd', null, d.title), h('dt', null, 'Preset'), h('dd', null, d.pipelineName),
          brief.map(([k, v]) => [h('dt', null, d.intakeQs.find((q) => q.id === k)?.label || k), h('dd', null, String(v))])))));
  }

  // The final: the delivering step's latest version.
  function finalOf() {
    const step = d.steps.find((s) => s.delivers);
    const sub = step ? d.submissions.filter((x) => x.step === step.key).at(-1) : null;
    return sub ? { step, sub } : null;
  }

  // Export: the final, and the last choice. Get the video takes it as it is; Edit the video opens it in Mortiflix Studio as a
  // project, every scene and sound its own clip, so small changes are made before the big render.
  function drawExport() {
    const f = finalOf();
    if (!f) return h('div', { class: 'cv-grid cv-grid-one' }, panel('Export', h('div', { class: 'cv-body' }, h('div', { class: 'cv-empty' }, h('div', { class: 'big' }, 'No final yet'), h('p', null, 'The final appears here once everything before it is approved.')))));
    const { step, sub } = f;
    // Once delivered from Mortiflix Studio, the edited final is the one to show.
    const edited = d.project.steps?.[step.key]?.delivered_from === 'edit' ? (d.project.deliverables || []).find((x) => x.kind === 'video') : null;
    const video = edited || sub.items.find((it) => it.kind === 'video');
    const waiting = step.state === 'in_review' && step.version === sub.version;
    const editing = step.state === 'editing';
    // What the owner clicked in Mortiflix Studio, asked for every second while the project is open.
    const selBox = h('div', { class: 'cv-fcsel' });
    const drawSel = (r) => {
      const s = r?.selected?.[0];
      if (!r?.open) return fill(selBox, h('p', { class: 'help' }, r?.error ? `${r.error}.` : 'Open it in Mortiflix Studio, then click a scene or a sound there.'));
      if (!s) return fill(selBox, h('p', { class: 'help' }, 'In Mortiflix Studio, click a scene or a sound: it shows here, and you can ask for a different version of it.'));
      if (selBox.dataset.node === s.node && selBox.querySelector('textarea')) return;
      selBox.dataset.node = s.node;
      const node = graph?.nodes?.[s.node];
      const box = h('textarea', { rows: 2, placeholder: `What should be different in ${s.label.split(' · ')[0]}?` });
      fill(selBox,
        h('div', { class: 'cv-label' }, `In Mortiflix Studio you clicked: ${s.label}`),
        node?.pending ? h('p', { class: 'cv-status-text' }, `Making a new version (${node.pending.id}): ${node.pending.text}`) : null,
        box,
        h('div', { class: 'cv-fix-end' }, h('button', { class: 'btn primary', onclick: async () => {
          const text = box.value.trim(); if (!text) return ui.toast('Say what to change', true);
          try { graph = await api(`/api/projects/${id}/canvas/nodes/${s.node}`, { method: 'POST', body: { action: 'fix', text } }); box.value = ''; ui.toast(`Asked for a new ${s.label.split(' · ')[0]}`); } catch (e) { ui.toast(e.message, true); }
        } }, 'Make a different version')));
    };
    clearInterval(selTimer);
    if (editing && fcInfo?.map) {
      // Stops once this panel is gone (redrawn or left); the first call runs before it is on the page.
      let first = true;
      const poll = async () => { if (!first && !selBox.isConnected) return clearInterval(selTimer); first = false; drawSel(await api(`/api/projects/${id}/edit/selection`).catch(() => null)); };
      selTimer = setInterval(poll, 1000); poll();
    }
    const job = fcInfo?.job;
    const map = fcInfo?.map;
    const fcBlock = () => {
      if (job?.state === 'making') return h('p', { class: 'cv-status-text' }, `Making your Mortiflix Studio project… ${job.log.at(-1) || ''}`);
      if (job?.state === 'rendering') return h('p', { class: 'cv-status-text' }, `Rendering the final from Mortiflix Studio… ${job.log.at(-1) || ''}`);
      if (job?.state === 'failed' && job.kind === 'make') return h('div', null, h('p', { class: 'err' }, `Couldn't make the Mortiflix Studio project: ${job.error}`),
        h('button', { class: 'btn', onclick: async () => { await api(`/api/projects/${id}/edit/make`, { method: 'POST' }); } }, 'Try again'));
      if (map) return h('div', { class: 'cv-fc' },
        h('p', { class: 'okmsg' }, `Your Mortiflix Studio project is ready: ${map.clips.length} clips, every shot${map.clips.some((c) => c.kind === 'line') ? ', voice line' : ''}${map.clips.some((c) => c.kind === 'music') ? ' and the music' : ''} on its own.`),
        h('div', { class: 'cv-export-actions' }, h('button', { class: 'btn primary', onclick: async () => {
          try { await api(`/api/projects/${id}/edit/open`, { method: 'POST' }); ui.toast('Opening Mortiflix Studio'); } catch (e) { ui.toast(e.message, true); }
        } }, 'Open in Mortiflix Studio'),
          h('button', { class: 'btn', onclick: async () => {
            try { await api(`/api/projects/${id}/edit/render`, { method: 'POST' }); ui.toast('Rendering the final from Mortiflix Studio'); } catch (e) { ui.toast(e.message, true); }
          } }, 'Render the final and get the video')),
        job?.state === 'failed' && job.error ? h('p', { class: 'err' }, job.error) : null,
        selBox,
        h('p', { class: 'help' }, `The project file: ${map.fcproj}`));
      return h('p', { class: 'cv-status-text' }, 'Making your Mortiflix Studio project…');
    };
    const msg = h('div', { class: 'err' });
    const decide = async (verdict) => {
      try { await api(`/api/projects/${id}/reviews/${step.key}/${sub.version}`, { method: 'POST', body: { verdict, notes: [], overall: '', answers: {} } }); ui.toast(verdict === 'approve' ? 'The video is yours' : 'Making your Mortiflix Studio project'); }
      catch (e) { msg.textContent = e.message; }
    };
    return h('div', { class: 'cv-grid cv-grid-one' }, panel('Export', h('div', { class: 'cv-body cv-export' },
      video ? h('div', { class: 'cv-stage cv-export-stage' }, h('video', { src: fileUrl(id, video.file), controls: true, preload: 'metadata', playsinline: true })) : null,
      h('div', { class: 'cv-export-side' },
        h('div', { class: 'cv-label' }, edited ? `${step.name}, edited in Mortiflix Studio` : `${step.name} v${sub.version}`),
        !edited && sub.note ? h('p', { class: 'cv-says' }, sub.note) : null,
        waiting ? h('div', null,
          h('p', { class: 'cv-q-text' }, 'Do you want the video, or do you want to edit the video?'),
          h('div', { class: 'cv-export-actions' },
            h('button', { class: 'btn primary', onclick: () => decide('approve') }, 'Get the video'),
            h('button', { class: 'btn', onclick: () => decide('edit') }, 'Edit the video')),
          h('p', { class: 'help' }, 'Edit the video opens it in Mortiflix Studio as a project: every scene, voice line and music cue its own clip. Click one and ask for a different version; small changes happen before the big render.'),
          msg)
          : editing ? fcBlock()
            : d.project.state === 'delivered' ? h('div', null, h('p', { class: 'okmsg' }, 'Delivered.'),
              (d.project.deliverables || []).map((x) => h('div', null, h('a', { href: fileUrl(id, x.file, true) }, `Download ${x.label}`))))
              : h('p', { class: 'cv-status-text' }, STATE_WORDS[step.state] || step.state)))));
  }

  function draw() {
    drawHead();
    if (mode === 'import') return fill(root, head, drawImport());
    if (mode === 'export') return fill(root, head, drawExport());
    const keepBox = h('label', { class: 'cv-keep' }, h('input', { type: 'checkbox', checked: keep, onchange: (e) => { keep = e.target.checked; store.set(keepKey, keep); } }), 'Keep playing into the next piece');
    fill(root, head, h('div', { class: `cv-grid${boardView === 'music' ? ' cv-board-music' : ''}` },
      panel('Script', script, null, 'cv-p-script'),
      panel('Monitor', monitor, null, 'cv-p-monitor'),
      h('section', { class: 'cv-panel cv-p-doing' },
        h('div', { class: 'cv-tabs' },
          h('button', { class: `cv-tab${rightTab === 'doing' ? ' on' : ''}`, onclick: () => { rightTab = 'doing'; draw(); } }, 'What the AI is doing'),
          h('button', { class: `cv-tab${rightTab === 'questions' ? ' on' : ''}`, onclick: () => { rightTab = 'questions'; draw(); } }, 'Questions',
            openQuestions().list.length ? h('span', { class: 'cv-count' }, ` ${openQuestions().list.length}`) : null)),
        rightTab === 'questions' ? asked : doing),
      h('section', { class: 'cv-panel cv-p-board' },
        h('div', { class: 'cv-tabs' },
          ['shots', 'nodes', 'music'].map((v) => h('button', { class: `cv-tab${boardView === v ? ' on' : ''}`, onclick: () => { boardView = v; store.set(`mfx-canvas-board-${id}`, v); draw(); } }, { shots: 'Shots', nodes: 'Nodes', music: 'Music' }[v])),
          crumbs, keepBox),
        board)));
    drawMonitor();
    drawBoard();
    drawScript();
    drawDoing();
    drawQuestions();
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    // Alt+← / Alt+→: back and forward between music levels (doc 25 §2.3); the arrows alone step through the shots
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (e.key === 'ArrowLeft' && !level.section) return;   // at the song: the browser's own Back leaves the canvas
      e.preventDefault();
      return e.key === 'ArrowLeft' ? back() : history.forward();
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Space plays and stops the music with the cut while the Music tab is open
    if (e.key === ' ' && boardView === 'music' && tp && !e.target.closest('video, audio, button')) { e.preventDefault(); return tp.playing ? tp.stop() : tp.play(); }
    if (e.key === 'ArrowRight') go(sel + 1, true);
    else if (e.key === 'ArrowLeft') go(sel - 1, true);
  };

  return {
    async show(query = '') {
      level = parseLevel(query);
      if (level.section) boardView = 'music';
      await load();
      document.body.classList.add('in-canvas');
      document.addEventListener('keydown', onKey);
      lastQ = openQuestions().list.length;
      if (lastQ) rightTab = 'questions';
      draw();
      return root;
    },
    async refresh() {
      const playing = monitor.querySelector('video, audio');
      const busy = playing && !playing.paused;
      await load();
      drawHead();
      // Never redraw under the owner's typing.
      if (mode === 'import' || mode === 'export') return root.contains(document.activeElement) && document.activeElement.matches('textarea, input') ? undefined : draw();
      drawBoard();
      drawScript();
      drawDoing();
      // The Questions tab's count changed: redraw the frame (not while a video plays). Otherwise only refresh the
      // questions, and never under the owner's typing.
      const qn = openQuestions().list.length;
      if (qn !== lastQ && !busy) { lastQ = qn; draw(); return; }
      if (!asked.contains(document.activeElement)) drawQuestions();
      if (!busy) drawMonitor();
    },
    // The address changed inside this canvas (a level, Back, Forward): no rebuild.
    route(query = '') {
      const was = JSON.stringify(level);
      level = parseLevel(query);
      if (level.section && boardView !== 'music') { boardView = 'music'; syncBoardChrome(); }
      if (JSON.stringify(level) !== was) drawBoard();
    },
    leave() {
      tp?.destroy();
      clearTimeout(advance);
      clearInterval(selTimer);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('in-canvas');
    },
  };
}
