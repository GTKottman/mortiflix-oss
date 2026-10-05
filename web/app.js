// Mortiflix studio (web). No framework: a tiny DOM builder, hash routes, and live updates over SSE.
// Everything the studio or a session wrote is inserted as text, never as HTML.

const $app = document.getElementById('app');
const $status = document.getElementById('top-status');
let studio = null;
let projectsCache = [];
let current = { name: null, refresh: null };

// ---------- helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') opts.headers['x-mortiflix'] = '1';
  if (raw) { opts.body = raw; opts.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2600);
}

const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const fileUrl = (id, file, download = false) => `/files/${id}/${file.split('/').map(encodeURIComponent).join('/')}${download ? '?download' : ''}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const BACKEND_NAMES = { 'claude-code': 'Claude Code', 'anthropic-api': 'Claude API', demo: 'Demo' };
const ICONS = { approved: ['✓', 'done'], done: ['✓', 'done'], in_review: ['●', 'review'], changes: ['↺', 'changes'], working: ['…', ''], ready: ['○', ''], blocked: ['·', ''] };
const STATE_WORDS = { approved: 'approved', done: 'done', in_review: 'waiting for you', changes: 'changes asked', working: 'in progress', ready: 'up next', blocked: 'later' };
const icon = (state) => { const [g, c] = ICONS[state] || ['·', '']; return h('span', { class: `ico ${c}`, 'aria-hidden': 'true' }, g); };

// ---------- routing ----------

const routes = [
  [/^$/, studioView, 'studio'],
  [/^new(?:\/([a-z0-9_-]+))?$/, newView, 'new'],
  [/^p\/([a-z0-9-]+)$/, projectView, 'studio'],
  [/^p\/([a-z0-9-]+)\/review\/([a-z0-9_-]+)(?:\/(\d+))?$/, reviewView, 'studio'],
  [/^pipelines$/, pipelinesView, 'pipelines'],
  [/^settings$/, settingsView, 'settings'],
];

async function render() {
  const path = location.hash.replace(/^#\/?/, '');
  const hit = routes.find(([re]) => re.test(path));
  const [re, view, nav] = hit || routes[0];
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === nav);
  current = { name: view.name, refresh: null, args: path.match(re)?.slice(1) || [] };
  // The review room is wider; the header widens with it so both keep one left edge.
  document.body.classList.toggle('wide', view === reviewView);
  try {
    await view(...current.args);
  } catch (e) {
    fill($app, h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Something went wrong'), e.message));
  }
}

// replaceChildren() would print null as "null": skipped sections are dropped here.
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

function mount(...kids) {
  fill($app, ...kids);
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// ---------- live updates ----------

let refreshTimer = null;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadStudio();
      if (current.refresh) current.refresh();
    }, 150);
  });
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    const log = document.getElementById(`log-${a.project}`);
    if (log) appendLog(log, a);
  });
}

async function loadStudio() {
  try {
    studio = await api('/api/studio');
    projectsCache = await api('/api/projects');
  } catch { return; }
  const working = studio.runner ? projectsCache.find((p) => p.id === studio.runner.project) : null;
  fill($status,
    working ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null,
    working ? h('span', null, `Working on ${working.title}`) : null,
    h('span', { class: 'chip' }, BACKEND_NAMES[studio.config.backend] || studio.config.backend),
  );
}

// ---------- the studio (home) ----------

async function studioView() {
  const projects = projectsCache = await api('/api/projects');
  const turn = projects.filter((p) => p.state === 'waiting' || p.state === 'paused');
  const prod = projects.filter((p) => p.state === 'queued');
  const done = projects.filter((p) => p.state === 'delivered');
  const other = projects.filter((p) => p.state === 'draft' || p.state === 'cancelled');

  const turnRow = (p, first) => {
    const what = p.state === 'paused'
      ? `Needs you: ${p.needs_you?.text || 'paused'}`
      : p.in_review.length ? `${p.in_review.map((s) => `${s.name} v${s.version}`).join(', ')} ready to review`
        : p.open_questions ? 'A question for you' : 'Waiting for you';
    const to = p.in_review.length ? `#/p/${p.id}/review/${p.in_review[0].key}` : `#/p/${p.id}`;
    return h('li', { class: 'row turn' },
      h('span', { class: `ico ${p.state === 'paused' ? 'bad' : 'review'}` }, p.state === 'paused' ? '!' : '●'),
      h('div', { class: 'main' }, h('a', { class: 'title', href: `#/p/${p.id}` }, p.title), h('div', { class: 'meta' }, what)),
      h('div', { class: 'end' }, h('a', { class: `btn${first ? ' primary' : ''}`, href: to }, p.state === 'paused' ? 'Open' : 'Review')));
  };
  const prodRow = (p) => h('li', { class: 'row' },
    p.working ? h('span', { class: 'ico' }, h('span', { class: 'pulse' })) : icon('ready'),
    h('div', { class: 'main' }, h('a', { class: 'title', href: `#/p/${p.id}` }, p.title),
      h('div', { class: 'meta' }, p.working ? (p.status?.text || `Working on ${p.current?.name || 'it'}`) : 'Waiting for its turn')),
    h('div', { class: 'end' }, h('span', { class: 'chip' }, p.pipeline.name), `${p.done}/${p.total}`));
  const doneRow = (p) => h('li', { class: 'row' }, icon('done'),
    h('div', { class: 'main' }, h('a', { class: 'title', href: `#/p/${p.id}` }, p.title)),
    h('div', { class: 'end' }, h('span', { class: 'chip' }, p.pipeline.name), ago(p.delivered_at)));
  const otherRow = (p) => h('li', { class: 'row' }, icon('blocked'),
    h('div', { class: 'main' }, h('a', { class: 'title', href: `#/p/${p.id}` }, p.title)),
    h('div', { class: 'end' }, p.state));

  const section = (title, list, row) => (list.length ? h('section', null, h('h2', null, title, h('span', { class: 'count' }, list.length)), h('ul', { class: 'rows' }, list.map(row))) : null);

  mount(
    h('div', { class: 'head' }, h('h1', null, 'Studio'), h('div', { class: 'actions' }, h('a', { class: 'btn solid', href: '#/new' }, 'New video'))),
    projects.length ? null : h('section', null, h('div', { class: 'empty' },
      h('div', { class: 'big' }, 'Nothing in production yet.'),
      h('p', null, 'Pick what to make, write the brief, and approve each stage as it comes in.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn solid', href: '#/new' }, 'Make a video'),
        h('button', { class: 'btn', onclick: startDemo }, 'Try the demo'), h('span', { class: 'meta' }, 'a logo sting with placeholder work, free')))),
    section('Your turn', turn, (p, i) => turnRow(p, i === 0)),
    section('In production', prod, prodRow),
    section('Delivered', done, doneRow),
    other.length ? h('section', null, h('details', null, h('summary', null, `Drafts and cancelled (${other.length})`), h('ul', { class: 'rows' }, other.map(otherRow)))) : null,
  );
  current.refresh = () => studioView();
}

async function startDemo() {
  try {
    const { id } = await api('/api/projects', { method: 'POST', body: { pipeline: 'logo-sting', title: 'Demo sting', answers: { mood: 'calm and premium', length: '5 s' }, backend: 'demo' } });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="80" fill="#b18cff"/><text x="100" y="120" text-anchor="middle" font-size="60" font-family="sans-serif" fill="#120c22">M</text></svg>';
    await api(`/api/projects/${id}/files?field=logo&name=demo-logo.svg`, { method: 'POST', raw: new Blob([svg]) });
    await api(`/api/projects/${id}/start`, { method: 'POST' });
    location.hash = `#/p/${id}`;
  } catch (e) { toast(e.message, true); }
}

// ---------- a project ----------

async function projectView(id) {
  const d = await api(`/api/projects/${id}`);
  const p = d.project;
  const reviewing = d.steps.filter((s) => s.state === 'in_review');
  const openQs = p.questions.filter((q) => !q.answered_at);
  const currentStep = d.steps.find((s) => ['working', 'changes', 'ready'].includes(s.state));
  const act = (path, msg) => async () => { try { await api(`/api/projects/${id}/${path}`, { method: 'POST' }); toast(msg); } catch (e) { toast(e.message, true); } };

  let stateBlock;
  if (p.state === 'paused') {
    stateBlock = h('div', { class: 'needs' }, h('div', { class: 'what' }, p.needs_you?.by_you ? 'Paused.' : `Needs you: ${p.needs_you?.text || ''}`),
      h('div', { class: 'actions', style: { marginTop: '10px' } }, h('button', { class: 'btn solid', onclick: act('resume', 'Resumed') }, 'Resume')));
  } else if (reviewing.length) {
    const s = reviewing[0];
    const sub = d.submissions.filter((x) => x.step === s.key).at(-1);
    stateBlock = h('div', { class: 'turn-line' },
      h('div', null, h('div', { class: 'what' }, `${s.name} v${s.version} is ready for you`), h('div', { class: 'why' }, (sub?.note || '').slice(0, 160))),
      h('a', { class: 'btn primary', href: `#/p/${id}/review/${s.key}` }, 'Review'));
  } else if (openQs.length) {
    stateBlock = h('div', { class: 'turn-line' }, h('div', null, h('div', { class: 'what' }, openQs.length === 1 ? 'A question for you' : `${openQs.length} questions for you`), h('div', { class: 'why' }, 'Answer below; the studio carries on as soon as you do.')));
  } else if (p.state === 'queued') {
    stateBlock = h('div', { class: 'state-line' }, p.session?.running ? h('span', { class: 'pulse' }) : icon('ready'),
      p.session?.running ? `Claude is working on ${currentStep?.name || 'it'}` : 'Waiting for its turn',
      p.status ? h('span', { class: 'quiet' }, `· ${p.status.text}`) : null);
  } else if (p.state === 'delivered') {
    stateBlock = h('div', { class: 'state-line' }, icon('done'), `Delivered ${ago(p.delivered_at)}`);
  } else if (p.state === 'draft') {
    stateBlock = h('div', { class: 'state-line' }, 'Draft: not started.', h('button', { class: 'btn solid', onclick: act('start', 'Started') }, 'Start'));
  } else {
    stateBlock = h('div', { class: 'state-line' }, h('span', { class: 'quiet' }, 'Cancelled.'));
  }

  const deliverables = p.deliverables.length ? h('section', { class: 'deliver' }, h('h2', null, 'Your video'),
    p.deliverables.map((f) => h('div', null,
      f.kind === 'video' ? h('video', { src: fileUrl(id, f.file), controls: true, preload: 'metadata' }) : f.kind === 'image' ? h('img', { src: fileUrl(id, f.file), alt: f.label }) : f.kind === 'audio' ? h('audio', { src: fileUrl(id, f.file), controls: true }) : null,
      h('div', { class: 'row' }, icon('done'), h('div', { class: 'main' }, h('span', { class: 'title' }, f.label)), h('div', { class: 'end' }, h('a', { href: fileUrl(id, f.file, true) }, 'Download')))))) : null;

  const questions = openQs.length ? h('section', null, h('h2', null, 'Questions'), openQs.map((q) => questionForm(id, q))) : null;

  const subsByStep = (key) => d.submissions.filter((s) => s.step === key);
  const steps = h('section', null, h('h2', null, 'Steps', h('span', { class: 'count' }, `${d.steps.filter((s) => ['approved', 'done'].includes(s.state)).length}/${d.steps.length}`)),
    h('ul', { class: 'rows' }, d.steps.map((s) => h('li', { class: 'row' }, icon(s.state),
      h('div', { class: 'main' }, h('span', { class: 'title' }, s.name),
        h('div', { class: 'meta' }, s.review === 'internal' ? 'made in the studio' : `you review ${s.review === 'frames' ? 'the frames' : s.review === 'questions' ? 'questions' : `the ${s.review}`}`,
          subsByStep(s.key).length ? ' · ' : '', subsByStep(s.key).map((x, i) => [i ? ' ' : '', h('a', { href: `#/p/${id}/review/${s.key}/${x.version}` }, `v${x.version}`)]))),
      h('div', { class: 'end' }, s.state === 'in_review' ? h('a', { href: `#/p/${id}/review/${s.key}` }, 'Review') : h('span', null, STATE_WORDS[s.state]))))));

  const log = h('div', { class: 'log', id: `log-${id}` });
  for (const a of d.activity.slice(-150)) appendLog(log, a, false);
  const activity = h('section', null, h('h2', null, 'Activity', d.renders.length ? h('span', { class: 'count' }, d.renders.map((r) => `${r.label}: ${r.state}`).join(' · ')) : null),
    d.activity.length ? log : h('div', { class: 'empty' }, 'Nothing yet. What the studio does shows up here as it happens.'));

  const usage = p.usage;
  const brief = h('section', null, h('details', { 'data-key': 'brief' }, h('summary', null, 'Brief'),
    h('ul', { class: 'rows' }, d.pipeline.intake.map((q) => h('li', { class: 'row', style: { gridTemplateColumns: '200px 1fr' } },
      h('span', { class: 'meta' }, q.label || q.id),
      h('span', { style: { whiteSpace: 'pre-wrap' } }, q.type === 'files' ? (p.intake.files.filter((f) => f.field === q.id).map((f) => f.name).join(', ') || '-') : (p.intake.answers[q.id] || '-')))))));
  const events = h('section', null, h('details', { 'data-key': 'log' }, h('summary', null, `Project log (${d.events.length})`),
    h('ul', { class: 'rows events' }, d.events.slice().reverse().map((e) => h('li', { class: 'row' },
      h('span', { class: 'meta' }, new Date(e.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      h('span', null, h('b', null, e.event.toLowerCase().replace(/_/g, ' ')), e.step ? ` ${e.step}${e.version ? ` v${e.version}` : ''}` : '', e.details ? h('span', { class: 'meta' }, ` · ${e.details}`) : null))))));
  const journal = d.journal ? h('section', null, h('details', { 'data-key': 'journal' }, h('summary', null, 'Studio journal'), h('pre', { class: 'journal' }, d.journal))) : null;

  const actions = h('div', { class: 'actions' },
    ['queued', 'waiting'].includes(p.state) ? h('button', { class: 'btn', onclick: act('pause', 'Paused') }, 'Pause') : null,
    !['delivered', 'cancelled'].includes(p.state) ? h('button', { class: 'btn link danger', onclick: async () => { if (confirmInline(actions, 'Cancel this project?')) await act('cancel', 'Cancelled')(); } }, 'Cancel') : null);

  const open = new Set([...document.querySelectorAll('details[open][data-key]')].map((x) => x.dataset.key));
  mount(
    h('a', { class: 'crumb', href: '#/' }, '← Studio'),
    h('div', { class: 'head' }, h('div', null, h('h1', null, p.title), h('div', { class: 'sub' }, h('span', { class: 'chip' }, d.pipeline.name), h('span', null, p.backend ? `${BACKEND_NAMES[p.backend]} backend` : ''))), actions),
    stateBlock, deliverables, questions, steps, activity, brief, events, journal,
    h('p', { class: 'meta', style: { color: 'var(--faint)', fontSize: '12px', marginTop: '18px' } },
      `${usage.sessions} session${usage.sessions === 1 ? '' : 's'}${usage.output_tokens ? ` · ${usage.output_tokens.toLocaleString()} output tokens` : ''}${usage.cost_usd ? ` · $${usage.cost_usd}` : ''}`),
  );
  for (const det of document.querySelectorAll('details[data-key]')) if (open.has(det.dataset.key)) det.open = true;
  log.scrollTop = log.scrollHeight;
  current.refresh = () => projectView(id);
}

// A second click confirms (no browser dialogs).
function confirmInline(_el, _msg) {
  const now = Date.now();
  if (confirmInline.armed && now - confirmInline.armed < 4000) { confirmInline.armed = 0; return true; }
  confirmInline.armed = now;
  toast('Click again to confirm');
  return false;
}

function appendLog(log, a, scroll = true) {
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const t = new Date(a.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const mark = { text: '│', tool: '›', error: '!', info: '●' }[a.kind] || ' ';
  log.append(h('div', { class: 'l' }, h('span', { class: 't' }, t), h('span', { class: 'k' }, mark), h('span', { class: a.kind }, a.text)));
  if (log.children.length > 400) log.firstChild.remove();
  if (scroll && atEnd) log.scrollTop = log.scrollHeight;
}

function questionForm(id, q) {
  let value = '';
  const input = q.choices
    ? choiceChips(q.choices, null, (v) => { value = v; })
    : h('input', { type: 'text', placeholder: q.default ? `Default: ${q.default}` : 'Your answer', oninput: (e) => { value = e.target.value; } });
  const send = async (useDefault) => {
    try {
      await api(`/api/projects/${id}/questions/${q.id}`, { method: 'POST', body: { answer: useDefault ? null : value || null } });
      toast('Answered');
    } catch (e) { toast(e.message, true); }
  };
  return h('div', { class: 'qa' }, h('div', { class: 'q' }, q.text), input,
    h('div', { class: 'actions', style: { marginTop: '10px' } }, h('button', { class: 'btn solid', onclick: () => send(false) }, 'Answer'),
      q.default ? h('button', { class: 'btn link', onclick: () => send(true) }, `Your call (${q.default})`) : null));
}

function choiceChips(choices, selected, onPick) {
  const wrap = h('div', { class: 'choices', role: 'radiogroup' });
  for (const c of choices) {
    const b = h('button', { type: 'button', class: `choice${c === selected ? ' on' : ''}`, role: 'radio', 'aria-checked': String(c === selected), onclick: () => {
      for (const x of wrap.children) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }
      b.classList.add('on'); b.setAttribute('aria-checked', 'true');
      onPick(c);
    } }, c);
    wrap.append(b);
  }
  return wrap;
}

// ---------- the review room ----------

async function reviewView(id, stepKey, versionParam) {
  const d = await api(`/api/projects/${id}`);
  const step = d.steps.find((s) => s.key === stepKey);
  if (!step) throw new Error(`no step ${stepKey}`);
  const versions = d.submissions.filter((s) => s.step === stepKey);
  if (!versions.length) throw new Error(`${step.name} hasn't been sent yet`);
  const sub = versionParam ? versions.find((v) => v.version === Number(versionParam)) : versions.at(-1);
  if (!sub) throw new Error('no such version');
  const editable = step.state === 'in_review' && step.version === sub.version && !sub.feedback;
  const prev = versions.find((v) => v.version === sub.version - 1);
  const draftKey = `mfx-draft-${id}-${stepKey}-${sub.version}`;
  const draft = (editable && store.get(draftKey)) || { notes: [], answers: {}, overall: '' };
  const save = () => { if (editable) store.set(draftKey, draft); };
  const media = sub.items.map((it, i) => ({ ...it, i })).filter((it) => it.kind !== 'text');
  const texts = sub.items.map((it, i) => ({ ...it, i })).filter((it) => it.kind === 'text');
  let sel = media[0]?.i ?? null;
  let pinMode = false;

  const stageBox = h('div');
  const notesBox = h('div');
  const docBox = h('div');

  function whereText(n) {
    const it = n.item !== null && n.item !== undefined ? sub.items[n.item] : null;
    return [it?.label, n.time_sec !== undefined ? `at ${clock(n.time_sec)}` : null, n.x !== undefined ? 'pinned spot' : null, n.paragraph !== undefined ? `paragraph ${n.paragraph + 1}` : null].filter(Boolean).join(' · ') || 'general';
  }

  function addNote(n) {
    if (!editable) return;
    draft.notes.push({ text: '', ...n });
    save();
    drawNotes(true);
    drawStage();
    drawDoc();
  }

  function drawStage() {
    if (sel === null) return fill(stageBox);
    const it = sub.items[sel];
    const url = fileUrl(id, it.file);
    const pins = draft.notes.map((n, k) => ({ ...n, k })).filter((n) => n.item === sel && n.x !== undefined);
    const shown = editable ? pins : (sub.feedback?.notes || []).filter((n) => n.item === sel && n.x !== undefined).map((n) => ({ ...n, k: n.n - 1 }));
    let stage;
    const marks = (filter = () => true) => shown.filter(filter).map((n) => h('span', { class: 'pinmark', style: { left: `${n.x * 100}%`, top: `${n.y * 100}%` } }, n.k + 1));
    const spot = (e, el) => { const r = el.getBoundingClientRect(); return { x: Math.round(((e.clientX - r.left) / r.width) * 1e4) / 1e4, y: Math.round(((e.clientY - r.top) / r.height) * 1e4) / 1e4 }; };
    const tools = h('div', { class: 'stage-tools' });
    if (it.kind === 'image') {
      const img = h('img', { src: url, alt: it.label });
      stage = h('div', { class: `stage${editable ? ' pinning' : ''}` }, img, marks());
      if (editable) stage.addEventListener('click', (e) => addNote({ item: sel, ...spot(e, img) }));
      if (editable) tools.append(h('span', { class: 'meta' }, 'Click the picture to pin a note to that spot.'));
    } else if (it.kind === 'video') {
      const video = h('video', { src: url, controls: true, preload: 'metadata' });
      const near = (n) => n.time_sec !== undefined && Math.abs(n.time_sec - video.currentTime) < 0.6;
      const layer = h('div');
      const catcher = h('div', { class: 'catch', onclick: (e) => { addNote({ item: sel, ...spot(e, video), time_sec: Math.round(video.currentTime * 100) / 100 }); pinMode = false; drawStage(); } });
      stage = h('div', { class: 'stage' }, video, layer, pinMode ? catcher : null);
      video.addEventListener('timeupdate', () => fill(layer, ...marks(near)));
      if (editable) {
        tools.append(
          h('button', { class: 'btn', onclick: () => addNote({ item: sel, time_sec: Math.round(video.currentTime * 100) / 100 }) }, 'Note at this moment'),
          h('button', { class: 'btn', onclick: () => { video.pause(); pinMode = !pinMode; stage.append(catcher); if (!pinMode) catcher.remove(); } }, 'Pin a spot in this frame'));
      }
    } else if (it.kind === 'audio') {
      const audio = h('audio', { src: url, controls: true, style: { width: '100%' } });
      stage = h('div', { style: { padding: '12px 0' } }, audio);
      if (editable) tools.append(h('button', { class: 'btn', onclick: () => addNote({ item: sel, time_sec: Math.round(audio.currentTime * 100) / 100 }) }, 'Note at this moment'));
    } else {
      stage = h('div', { class: 'empty' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, `Open ${it.label}`));
      if (editable) tools.append(h('button', { class: 'btn', onclick: () => addNote({ item: sel }) }, 'Add a note about this'));
    }
    fill(stageBox,
      media.length > 1 ? h('div', { class: 'thumbs' }, media.map((m) => h('button', { class: `thumb${m.i === sel ? ' on' : ''}`, onclick: () => { sel = m.i; pinMode = false; drawStage(); } },
        m.kind === 'image' ? h('img', { src: fileUrl(id, m.file), alt: '' }) : h('div', { style: { aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: '#000', color: '#fff' } }, m.kind === 'video' ? '▶' : '♪'),
        h('span', null, m.label)))) : null,
      stage,
      h('div', { class: 'stage-label' }, h('span', null, it.label, it.section ? ` · ${it.section}` : ''), h('a', { href: fileUrl(id, it.file, true) }, 'Download')),
      tools);
  }

  function drawDoc() {
    fill(docBox, ...texts.map((it) => {
      const paras = it.text.split(/\n\s*\n/).filter((x) => x.trim());
      const notedParas = new Set((editable ? draft.notes : sub.feedback?.notes || []).filter((n) => n.item === it.i && n.paragraph !== undefined).map((n) => n.paragraph));
      return h('section', null, h('h2', null, it.label),
        h('div', { class: 'doc' }, paras.map((para, k) => h('div', { class: `para${notedParas.has(k) ? ' noted' : ''}` },
          h('span', { class: 'n' }, k + 1), para.trim(),
          editable ? h('button', { class: 'btn link add', onclick: () => addNote({ item: it.i, paragraph: k }) }, 'Comment') : null))));
    }));
  }

  function drawNotes(focusLast = false) {
    if (!editable) {
      const fb = sub.feedback;
      fill(notesBox, fb ? h('section', null, h('h2', null, fb.verdict === 'approve' ? 'You approved this' : 'You asked for changes'),
        fb.overall ? h('p', null, fb.overall) : null,
        h('ul', { class: 'notes' }, fb.notes.map((n) => h('li', null, h('span', { class: 'num' }, n.n), h('div', null, h('div', { class: 'where' }, whereText(n)), h('div', null, n.text)), h('span'))))) : h('section', null, h('p', { class: 'meta' }, 'A newer version replaced this one before you reviewed it.')));
      return;
    }
    const list = h('ul', { class: 'notes' }, draft.notes.map((n, k) => h('li', null,
      h('span', { class: 'num' }, k + 1),
      h('div', null, h('div', { class: 'where' }, whereText(n)),
        h('textarea', { placeholder: 'What should change (or what you love)?', value: n.text, oninput: (e) => { n.text = e.target.value; save(); } })),
      h('button', { class: 'x', 'aria-label': `Remove note ${k + 1}`, onclick: () => { draft.notes.splice(k, 1); save(); drawNotes(); drawStage(); drawDoc(); } }, '×'))));
    fill(notesBox, h('section', null, h('h2', null, 'Your notes', h('span', { class: 'count' }, draft.notes.length || '')),
      draft.notes.length ? list : h('p', { class: 'meta' }, media.length ? 'Pin notes on the work, or comment on a paragraph. No notes needed to approve.' : 'Comment on a paragraph, or approve as it is.'),
      h('button', { class: 'btn link', onclick: () => addNote({}) }, 'Add a general note')));
    if (focusLast) list.querySelector('li:last-child textarea')?.focus();
  }

  const questions = sub.questions.length ? h('section', null, h('h2', null, 'Questions'), sub.questions.map((q) => {
    const answered = sub.feedback?.answers?.find((a) => a.id === q.id);
    if (!editable) return h('div', { class: 'qa' }, h('div', { class: 'q' }, q.text), h('div', { class: 'meta' }, answered ? `${answered.answer}${answered.used_default ? ' (default)' : ''}` : '-'));
    const set = (v) => { draft.answers[q.id] = v; save(); };
    return h('div', { class: 'qa' }, h('div', { class: 'q' }, q.text),
      q.choices ? choiceChips(q.choices, draft.answers[q.id] ?? null, set) : null,
      h('input', { type: 'text', style: { marginTop: q.choices ? '8px' : '0' }, placeholder: q.default !== null ? `Default: ${q.default}` : 'Needs an answer', value: q.choices && q.choices.includes(draft.answers[q.id]) ? '' : (draft.answers[q.id] || ''), oninput: (e) => set(e.target.value) }));
  })) : null;

  const overall = editable ? h('section', null, h('h2', null, 'Anything else'), h('textarea', { placeholder: 'An overall comment (optional)', value: draft.overall, oninput: (e) => { draft.overall = e.target.value; save(); } })) : null;

  const err = h('div', { class: 'err' });
  const decide = async (verdict) => {
    err.textContent = '';
    const notes = draft.notes.map((n) => ({ item: n.item ?? null, x: n.x, y: n.y, time_sec: n.time_sec, paragraph: n.paragraph, text: (n.text || '').trim() }));
    if (notes.some((n) => !n.text)) { err.textContent = 'Every note needs some words (or remove it).'; return; }
    if (verdict === 'changes' && !notes.length && !draft.overall.trim()) { err.textContent = 'Say what to change: pin a note or write an overall comment.'; return; }
    try {
      await api(`/api/projects/${id}/reviews/${stepKey}/${sub.version}`, { method: 'POST', body: { verdict, notes, overall: draft.overall, answers: draft.answers } });
      store.del(draftKey);
      toast(verdict === 'approve' ? `${step.name} approved` : 'Changes sent: the studio is on it');
      location.hash = `#/p/${id}`;
    } catch (e) { err.textContent = e.message; }
  };

  const prevNotes = prev?.feedback?.notes || [];
  const changed = sub.pin_changes.length ? h('section', null, h('h2', null, 'What changed for your notes'),
    h('ul', { class: 'rows changed' }, sub.pin_changes.map((c) => h('li', null,
      h('div', { class: 'yours' }, `Your note ${c.note}: ${prevNotes[c.note - 1]?.text || ''}`),
      h('div', null, c.change, ' ', h('span', { class: `chip ${c.status === 'done' ? 'ok' : 'warn'}` }, c.status.replace('_', ' '))))))) : null;

  const checks = sub.error_checks.length ? h('section', null, h('details', null,
    h('summary', null, `Studio checks: ${sub.error_checks.filter((c) => c.result === 'pass').length} passed${sub.error_checks.some((c) => c.result === 'fixed') ? `, ${sub.error_checks.filter((c) => c.result === 'fixed').length} fixed` : ''}`),
    h('ul', { class: 'checks-list' }, sub.error_checks.map((c) => h('li', null, h('span', null, step.checks.find((x) => x.id === c.id)?.title || c.id, c.note ? h('span', { class: 'meta' }, ` · ${c.note}`) : null),
      h('span', { class: `chip ${c.result === 'pass' ? 'ok' : 'warn'}` }, c.result)))))) : null;

  mount(
    h('a', { class: 'crumb', href: `#/p/${id}` }, `← ${d.project.title}`),
    h('div', { class: 'head' }, h('div', null, h('h1', null, `${step.name} v${sub.version}`),
      h('div', { class: 'sub versions' }, `Sent ${ago(sub.submitted_at)}`, versions.length > 1 ? ' · ' : '',
        versions.length > 1 ? versions.map((v, i) => [i ? ' ' : '', v.version === sub.version ? h('b', null, `v${v.version}`) : h('a', { href: `#/p/${id}/review/${stepKey}/${v.version}` }, `v${v.version}`)]) : null))),
    h('div', { class: 'review' },
      h('div', { class: 'stage-wrap' }, h('div', { class: 'note-from' }, sub.note), changed, stageBox, docBox),
      h('aside', { class: 'side' }, notesBox, questions, overall, checks,
        editable ? h('div', { class: 'decide' }, err,
          h('button', { class: 'btn primary', onclick: () => decide('approve') }, 'Approve'),
          h('button', { class: 'btn', onclick: () => decide('changes') }, 'Ask for changes')) : null)),
  );
  drawStage();
  drawDoc();
  drawNotes();
  current.refresh = null; // never redraw under someone's half-written notes
}

// ---------- new video ----------

async function newView(slug) {
  const pipelines = (await api('/api/pipelines')).filter((p) => !p.error);
  if (!slug) {
    mount(h('div', { class: 'head' }, h('h1', null, 'New video')),
      h('section', null, h('h2', null, 'What are we making?'), pipelines.map((p) => h('div', { class: 'pick', onclick: () => { location.hash = `#/new/${p.slug}`; } },
        h('a', { class: 'title', href: `#/new/${p.slug}` }, p.name), h('span', { class: 'chip' }, p.makes),
        h('div', { class: 'desc' }, p.description),
        h('div', { class: 'chain' }, p.steps.filter((s) => s.review !== 'internal').map((s) => s.name).join(' → '))))));
    return;
  }
  const p = pipelines.find((x) => x.slug === slug);
  if (!p) throw new Error(`no pipeline ${slug}`);
  const answers = {};
  const files = {};
  for (const q of p.intake) if (q.type === 'choice' && q.default) answers[q.id] = q.default;
  let title = '';
  let backend = null;
  const err = h('div', { class: 'err' });

  const field = (label, control, { help, optional } = {}) => h('div', { class: 'field' }, h('label', null, label, optional ? h('div', { class: 'opt' }, 'optional') : null), h('div', null, control, help ? h('div', { class: 'help' }, help) : null));
  const fields = p.intake.map((q) => {
    let control;
    if (q.type === 'long') control = h('textarea', { oninput: (e) => { answers[q.id] = e.target.value; } });
    else if (q.type === 'choice') control = choiceChips(q.choices, q.default || null, (v) => { answers[q.id] = v; });
    else if (q.type === 'files') control = h('input', { type: 'file', multiple: true, onchange: (e) => { files[q.id] = [...e.target.files]; } });
    else control = h('input', { type: 'text', oninput: (e) => { answers[q.id] = e.target.value; } });
    return field(q.label || q.id, control, { help: q.help, optional: !q.required });
  });

  const startBtn = h('button', { class: 'btn solid', onclick: async () => {
    err.textContent = '';
    startBtn.disabled = true;
    try {
      const { id } = await api('/api/projects', { method: 'POST', body: { pipeline: slug, title, answers, backend } });
      for (const [fieldId, list] of Object.entries(files)) {
        for (const f of list) {
          startBtn.textContent = `Uploading ${f.name}…`;
          await api(`/api/projects/${id}/files?field=${encodeURIComponent(fieldId)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
        }
      }
      await api(`/api/projects/${id}/start`, { method: 'POST' }).catch((e) => { location.hash = `#/p/${id}`; throw e; });
      location.hash = `#/p/${id}`;
    } catch (e) {
      err.textContent = e.message;
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  } }, 'Start');

  mount(
    h('a', { class: 'crumb', href: '#/new' }, '← Everything we make'),
    h('div', { class: 'head' }, h('div', null, h('h1', null, p.name), h('div', { class: 'sub' }, p.description))),
    h('section', null,
      field('Title', h('input', { type: 'text', placeholder: p.name, oninput: (e) => { title = e.target.value; } })),
      fields,
      studio?.config.backend === 'demo' ? null
        : field('Made by', choiceChips([BACKEND_NAMES[studio?.config.backend] || 'Studio default', 'Demo (placeholder work, free)'], BACKEND_NAMES[studio?.config.backend] || 'Studio default', (v) => { backend = v.startsWith('Demo') ? 'demo' : null; }), { help: 'The demo walks every stage with placeholder work: handy to learn the review room.' })),
    h('div', { class: 'form-end' }, err, startBtn),
  );
}

// ---------- pipelines ----------

async function pipelinesView() {
  const pipelines = await api('/api/pipelines');
  mount(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Pipelines'), h('div', { class: 'sub' }, 'How each kind of video is made. Add your own in the studio folder\'s pipelines/ (see docs/PIPELINES.md).'))),
    pipelines.map((p) => h('section', null,
      h('h2', null, p.name || p.slug, h('span', { class: 'count' }, p.source)),
      p.error ? h('p', { class: 'err' }, p.error) : [
        h('p', null, p.description),
        h('ul', { class: 'rows' }, p.steps.map((s) => h('li', { class: 'row' }, icon(s.review === 'internal' ? 'blocked' : 'ready'),
          h('div', { class: 'main' }, h('span', { class: 'title' }, s.name), h('div', { class: 'meta' }, s.describe || (s.after.length ? `after ${s.after.join(', ')}` : 'first'))),
          h('div', { class: 'end' }, h('span', { class: 'chip' }, s.review === 'internal' ? 'studio' : `you review ${s.review}`))))),
        h('details', null, h('summary', null, `Error checks (${p.checks.length})`), h('ul', { class: 'checks-list' }, p.checks.map((c) => h('li', null, h('span', null, h('b', null, c.title), h('span', { class: 'meta' }, ` · ${c.how}`)))))),
      ])));
}

// ---------- settings ----------

async function settingsView() {
  studio = await api('/api/studio');
  const checks = await api('/api/checks');
  const c = { ...studio.config };
  let apiKey;
  const msg = h('span', { class: 'okmsg' });
  const field = (label, control, help) => h('div', { class: 'field' }, h('label', null, label), h('div', null, control, help ? h('div', { class: 'help' }, help) : null));
  const toggle = (key, text) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: c[key], onchange: (e) => { c[key] = e.target.checked; } }), text);

  const backendRows = Object.entries(studio.backends).map(([name, b]) => h('li', { class: 'row', style: { cursor: 'pointer' }, onclick: () => { c.backend = name; draw(); } },
    h('input', { type: 'radio', name: 'backend', checked: c.backend === name, 'aria-label': BACKEND_NAMES[name] }),
    h('div', { class: 'main' }, h('span', { class: 'title' }, { 'claude-code': 'Your Claude Code', 'anthropic-api': 'Claude API with your key', demo: 'Demo' }[name] || name),
      h('div', { class: 'meta' }, { 'claude-code': 'Runs `claude -p` with your own login or plan.', 'anthropic-api': 'Mortiflix runs the agent loop on the API; you pay per token.', demo: 'Placeholder work, no Claude: for trying the studio.' }[name])),
    h('div', { class: 'end' }, h('span', { class: `chip ${b.ok ? 'ok' : 'bad'}` }, b.ok ? 'ready' : 'not set up'))));

  const body = h('div');
  function draw() {
    for (const r of body.querySelectorAll('input[name=backend]')) r.checked = r.getAttribute('aria-label') === BACKEND_NAMES[c.backend];
    fill(extra, ...(c.backend === 'anthropic-api' ? [
      field('API key', h('input', { type: 'password', autocomplete: 'off', placeholder: studio.api_key_set ? 'Saved (type to replace)' : studio.api_key_env ? 'Using ANTHROPIC_API_KEY' : 'sk-ant-…', oninput: (e) => { apiKey = e.target.value; } }),
        'Stored only in the studio folder (secrets.json, readable by you alone). Never shown again, never sent anywhere but the Claude API.'),
      field('Model', h('input', { type: 'text', placeholder: 'claude-opus-5-5', value: c.model || '', oninput: (e) => { c.model = e.target.value; } })),
      field('Effort', choiceChips(['low', 'medium', 'high', 'xhigh', 'max'], c.effort, (v) => { c.effort = v; }), 'High suits most videos; higher is slower and costs more.'),
      field('Tools', h('div', null, toggle('webTools', 'Web search and fetch for research'), toggle('fallbacks', 'Refusal fallbacks (another model continues if one declines)'))),
    ] : c.backend === 'claude-code' ? [
      field('Model', h('input', { type: 'text', placeholder: 'Claude Code\'s default', value: c.model || '', oninput: (e) => { c.model = e.target.value; } })),
      field('Sandbox', toggle('sandbox', 'Run each session inside bubblewrap (Linux)'), 'The session then sees only its project folder, read-only system files and its Claude login.'),
    ] : []));
  }
  const extra = h('div');

  const save = h('button', { class: 'btn solid', onclick: async () => {
    try {
      const patch = { backend: c.backend, model: c.model || null, effort: c.effort, sandbox: c.sandbox, webTools: c.webTools, fallbacks: c.fallbacks, maxSessionMinutes: Number(c.maxSessionMinutes) };
      if (apiKey !== undefined && apiKey !== '') patch.api_key = apiKey;
      studio = await api('/api/config', { method: 'PUT', body: patch });
      msg.textContent = 'Saved';
      setTimeout(() => { msg.textContent = ''; }, 2000);
      loadStudio();
    } catch (e) { toast(e.message, true); }
  } }, 'Save');

  const decideCheck = (cid, approve) => async () => { try { await api(`/api/checks/${cid}`, { method: 'POST', body: { approve } }); settingsView(); } catch (e) { toast(e.message, true); } };

  body.append(
    h('section', null, h('h2', null, 'Who makes the videos'), h('ul', { class: 'rows' }, backendRows), extra,
      field('Session limit', h('input', { type: 'number', min: 5, max: 1440, value: c.maxSessionMinutes, oninput: (e) => { c.maxSessionMinutes = e.target.value; }, style: { maxWidth: '120px' } }), 'Minutes before a session is stopped (the next one picks up from its handoff).'),
      h('div', { class: 'form-end' }, msg, save)),
    h('section', null, h('h2', null, 'The error checklist', h('span', { class: 'count' }, checks.proposed.length ? `${checks.proposed.length} proposed` : '')),
      h('p', { class: 'meta' }, 'When you point out a real mistake, the session proposes a check so it never reaches you again. Approved checks run on every future video.'),
      checks.proposed.length ? h('ul', { class: 'rows' }, checks.proposed.map((k) => h('li', { class: 'row' }, icon('in_review'),
        h('div', { class: 'main' }, h('span', { class: 'title' }, k.title), h('div', { class: 'meta', style: { whiteSpace: 'normal' } }, k.how)),
        h('div', { class: 'end' }, h('button', { class: 'btn', onclick: decideCheck(k.id, true) }, 'Add'), h('button', { class: 'btn link', onclick: decideCheck(k.id, false) }, 'Dismiss'))))) : null,
      checks.active.length ? h('ul', { class: 'rows' }, checks.active.map((k) => h('li', { class: 'row' }, icon('done'), h('div', { class: 'main' }, h('span', { class: 'title' }, k.title)), h('div', { class: 'end' }, (k.applies_to || []).join(', '))))) : h('p', { class: 'meta' }, 'No studio checks yet (each pipeline has its own).')),
    h('section', null, h('h2', null, 'Keys for sessions'),
      h('p', null, studio.session_env ? 'session.env is set: its keys are handed to every session.' : 'Optional. To give sessions keys (for example ELEVENLABS_API_KEY for narration), put KEY=value lines in session.env in the studio folder.'),
      h('p', { class: 'meta' }, `Studio folder: ${studio.root}`)),
  );
  mount(h('div', { class: 'head' }, h('h1', null, 'Settings')), body);
  draw();
}

// ---------- start ----------

await loadStudio();
connect();
render();
