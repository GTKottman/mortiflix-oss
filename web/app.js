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
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(text, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status' }, text);
  add(document.body, t);
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
const ICONS = { approved: ['✓', 'done'], done: ['✓', 'done'], skipped: ['–', ''], in_review: ['●', 'review'], changes: ['↺', 'changes'], working: ['…', ''], ready: ['○', ''], blocked: ['·', ''] };
const STATE_WORDS = { approved: 'approved', done: 'done', skipped: 'skipped', in_review: 'waiting for you', changes: 'changes asked', working: 'in progress', ready: 'up next', blocked: 'later' };
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

// append() would print null as "null" too.
function add(el, ...kids) {
  el.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
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
  const steps = h('section', null, h('h2', null, 'Steps', h('span', { class: 'count' }, `${d.steps.filter((s) => ['approved', 'done', 'skipped'].includes(s.state)).length}/${d.steps.length}`)),
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
      `${usage.sessions} session${usage.sessions === 1 ? '' : 's'}${usage.output_tokens ? ` · ${usage.output_tokens.toLocaleString()} output tokens` : ''}${usage.cost_text ? ` · ${usage.cost_text}` : ''}`),
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
  add(log, h('div', { class: 'l' }, h('span', { class: 't' }, t), h('span', { class: 'k' }, mark), h('span', { class: a.kind }, a.text)));
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
    add(wrap, b);
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
          h('button', { class: 'btn', onclick: () => { video.pause(); pinMode = !pinMode; add(stage, catcher); if (!pinMode) catcher.remove(); } }, 'Pin a spot in this frame'));
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
  let createdId = null;
  const err = h('div', { class: 'err' });
  const keysBox = h('div');

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
      if (!createdId) {
        const { id } = await api('/api/projects', { method: 'POST', body: { pipeline: slug, title, answers, backend } });
        for (const [fieldId, list] of Object.entries(files)) {
          for (const f of list) {
            startBtn.textContent = `Uploading ${f.name}…`;
            await api(`/api/projects/${id}/files?field=${encodeURIComponent(fieldId)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
          }
        }
        createdId = id;
      }
      const id = createdId;
      try {
        await api(`/api/projects/${id}/start`, { method: 'POST' });
      } catch (e) {
        // Keys this project needs: ask for them right here, then Start again.
        if (!e.data?.needs_keys) { location.hash = `#/p/${id}`; throw e; }
        const { keys } = await api('/api/keys');
        const drawKeys = (list) => fill(keysBox, h('section', null, h('h2', null, 'Before it starts'), h('p', { class: 'meta' }, e.message),
          list.filter((k) => e.data.needs_keys.includes(k.id)).map((k) => keyRow(k, (r) => drawKeys(r.keys)))));
        drawKeys(keys);
        throw new Error('Add the key above, then Start.');
      }
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
    keysBox,
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

  const voiceBlock = await voiceSection();
  add(body, await setupSection(), 
    h('section', null, h('h2', null, 'Who makes the videos'), h('ul', { class: 'rows' }, backendRows), extra,
      field('Session limit', h('input', { type: 'number', min: 5, max: 1440, value: c.maxSessionMinutes, oninput: (e) => { c.maxSessionMinutes = e.target.value; }, style: { maxWidth: '120px' } }), 'Minutes before a session is stopped (the next one picks up from its handoff).'),
      h('div', { class: 'form-end' }, msg, save)),
    voiceBlock,
    h('section', null, h('h2', null, 'The error checklist', h('span', { class: 'count' }, checks.proposed.length ? `${checks.proposed.length} proposed` : '')),
      h('p', { class: 'meta' }, 'When you point out a real mistake, the session proposes a check so it never reaches you again. Approved checks run on every future video.'),
      checks.proposed.length ? h('ul', { class: 'rows' }, checks.proposed.map((k) => h('li', { class: 'row' }, icon('in_review'),
        h('div', { class: 'main' }, h('span', { class: 'title' }, k.title), h('div', { class: 'meta', style: { whiteSpace: 'normal' } }, k.how)),
        h('div', { class: 'end' }, h('button', { class: 'btn', onclick: decideCheck(k.id, true) }, 'Add'), h('button', { class: 'btn link', onclick: decideCheck(k.id, false) }, 'Dismiss'))))) : null,
      checks.active.length ? h('ul', { class: 'rows' }, checks.active.map((k) => h('li', { class: 'row' }, icon('done'), h('div', { class: 'main' }, h('span', { class: 'title' }, k.title)), h('div', { class: 'end' }, (k.applies_to || []).join(', '))))) : h('p', { class: 'meta' }, 'No studio checks yet (each pipeline has its own).')),
    await keysSection(),
  );
  mount(h('div', { class: 'head' }, h('h1', null, 'Settings')), body);
  draw();
}

// ---------- setup (Settings › Setup): every part, why it's needed, what it installs ----------

async function setupSection() {
  const wrap = h('section', { id: 'setup' });
  let info = await api('/api/setup');
  let poll = null;
  const field = (label, control, help) => h('div', { class: 'field' }, h('label', null, label), h('div', null, control, help ? h('div', { class: 'help' }, help) : null));
  const chip = (ok, yes, no, neutral = false) => h('span', { class: `chip ${ok ? 'ok' : neutral ? '' : 'bad'}` }, ok ? yes : no);
  const refresh = async () => { info = await api('/api/setup'); draw(); };

  // One tool: its status, what installing it means, an Install button and the live log while it runs.
  const UPDATABLE = ['strudel', 'browser-harness', 'blender-addons'];   // the others are reused when found
  const toolRow = (id, label = info.tools[id].name) => {
    const st = info.status[id];
    const t = info.tools[id];
    const job = info.jobs[id];
    const running = job?.state === 'running';
    const btn = h('button', { class: 'btn', disabled: running || Object.values(info.jobs).some((j) => j.state === 'running'), onclick: async () => {
      try { await api(`/api/setup/install/${id}`, { method: 'POST' }); await refresh(); startPoll(); } catch (e) { toast(e.message, true); }
    } }, running ? 'Installing…' : st.ok ? 'Update' : 'Install');
    const log = job ? h('pre', { class: 'setup-log' }, job.log.join('\n') || '…') : null;
    if (log) setTimeout(() => { log.scrollTop = log.scrollHeight; });
    return h('div', { class: 'tool-row' },
      h('div', { class: 'actions' }, h('b', null, label), chip(st.ok, st.detail, st.detail), !st.ok || UPDATABLE.includes(id) || running ? btn : null),
      h('div', { class: 'help' }, `${t.what}. Goes to ${t.where} (${t.size}).`),
      job?.state === 'failed' ? h('div', { class: 'err' }, job.error) : null,
      job?.problems ? h('div', { class: 'err' }, job.problems) : null,
      log);
  };
  const startPoll = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!document.body.contains(wrap)) return clearInterval(poll);
      await refresh();
      if (!Object.values(info.jobs).some((j) => j.state === 'running')) { clearInterval(poll); loadStudio(); }
    }, 1200);
  };

  function draw() {
    const st = info.status;
    const part = (id) => info.parts.find((x) => x.id === id);
    const intro = (id) => [h('p', null, part(id).why), h('p', { class: 'meta' }, part(id).needs)];
    let sites = st.assets.sites.map((x) => x.url).join('\n');
    fill(wrap,
      h('h2', null, 'Setup'),
      h('p', { class: 'meta' }, 'What the studio uses, why, and what it installs. Everything goes into the studio folder (or your own user tools), never system-wide, and nothing installs until you press Install.'),
      field(part('claude').title, h('div', null, ...intro('claude'), h('p', { class: 'meta' }, 'Choose below, in "Who makes the videos".'))),
      field(part('narration').title, h('div', null, ...intro('narration'),
        h('p', { class: 'meta' }, `This computer: ${st.gpu.reason}`),
        st.gpu.fits ? toolRow('comfyui') : null,
        h('p', { class: 'meta' }, 'Pick the voice below, in "Narration".'))),
      field(part('music').title, h('div', null, ...intro('music'),
        choiceChips(['Original score', 'No music'], st.music.engine === 'none' ? 'No music' : 'Original score', async (v) => { info = await api('/api/setup/music', { method: 'PUT', body: { engine: v === 'No music' ? 'none' : 'strudel' } }); draw(); }),
        st.music.engine === 'none' ? null : h('div', null,
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: st.music.midi, onchange: async (e) => { info = await api('/api/setup/music', { method: 'PUT', body: { midi: e.target.checked } }); draw(); } }),
            'Also deliver a MIDI pack (every part, the stems and a cue sheet) to remake the music in your own DAW'),
          toolRow('strudel'), toolRow('chrome')))),
      field(part('assets').title, h('div', null, ...intro('assets'),
        h('p', null, 'If you have a website you use for assets, list it here, one per line. Without one, you won\'t get stock assets: sessions make every visual themselves.'),
        h('textarea', { rows: 3, placeholder: 'https://…', value: sites, oninput: (e) => { sites = e.target.value; } }),
        h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: async () => {
          try { info = await api('/api/setup/assets', { method: 'PUT', body: { sites: sites.split(/\n+/).map((x) => x.trim()).filter(Boolean) } }); draw(); toast('Asset sites saved'); } catch (e) { toast(e.message, true); }
        } }, 'Save sites')),
        st.assets.sites.length ? h('div', null, toolRow('browser-harness'),
          st['browser-harness'].ok && info.recordings ? h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: /enabled/i.test(info.recordings) && !/disabled/i.test(info.recordings), onchange: async (e) => { info = await api('/api/setup/recordings', { method: 'PUT', body: { enable: e.target.checked } }); draw(); } }),
            'Keep local browser recordings (screenshots and traces of what sessions do, on this machine only)') : null,
          h('p', { class: 'meta' }, 'Sessions use your own Chrome: sign in to these sites there. The first time, Chrome may ask you to allow remote debugging (chrome://inspect/#remote-debugging).')) : null)),
      field(part('3d').title, h('div', null, ...intro('3d'),
        toolRow('blender'),
        st.blender.ok ? toolRow('blender-addons') : null,
        st.blender.ok ? h('ul', { class: 'checks-list' }, info.addons.map((a) => h('li', null, h('span', null, h('b', null, a.name), h('span', { class: 'meta' }, ` · ${a.about}`))))) : null,
        st['blender-addons'].installed?.length ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { await api('/api/setup/blender', { method: 'POST' }); toast('Opening Blender'); } catch (e) { toast(e.message, true); } } }, 'Open the studio\'s Blender'),
          h('span', { class: 'meta' }, 'Camera Flight: 3D Viewport › N › Flight')) : null)),
    );
  }
  draw();
  if (Object.values(info.jobs).some((j) => j.state === 'running')) startPoll();
  return wrap;
}

// ---------- keys (Settings › Keys, and New video when one is missing) ----------

const KEY_SOURCES = { saved: 'saved in this studio', 'session.env': 'from session.env', environment: 'from your environment' };

// One key: where it comes from (never its value) and a hidden field to set it. The server checks it with a free call
// before saving it.
function keyRow(k, onChange) {
  const input = h('input', { type: 'password', autocomplete: 'off', 'aria-label': k.name, placeholder: k.source === 'saved' ? 'Saved (paste to replace)' : k.source ? `Using ${k.env} ${KEY_SOURCES[k.source]}` : 'Paste your key' });
  const note = h('div', { class: 'help' }, `For ${k.for} Get one at ${k.get}.`);
  const save = h('button', { class: 'btn', onclick: async () => {
    if (!input.value.trim()) return input.focus();
    save.disabled = true;
    save.textContent = 'Checking…';
    try {
      const r = await api(`/api/keys/${k.id}`, { method: 'PUT', body: { value: input.value } });
      input.value = '';
      toast(r.check?.ok ? `${k.name}: ${r.check.detail}` : `${k.name} saved${r.check ? `, but ${r.check.detail}` : ''}`);
      onChange(r);
    } catch (e) {
      fill(note, h('span', { class: 'err' }, e.message));
      save.disabled = false;
      save.textContent = 'Save';
    }
  } }, 'Save');
  const remove = k.source === 'saved' ? h('button', { class: 'btn link', onclick: async () => { try { onChange(await api(`/api/keys/${k.id}`, { method: 'DELETE' })); } catch (e) { toast(e.message, true); } } }, 'Remove') : null;
  const chip = h('span', { class: `chip ${k.source ? 'ok' : k.in_use ? 'bad' : ''}` }, k.source ? KEY_SOURCES[k.source] : k.in_use ? 'needed' : 'not set');
  return h('div', { class: 'field' }, h('label', null, k.name, h('div', null, chip)), h('div', null, h('div', { class: 'actions' }, input, save, remove), note));
}

async function keysSection() {
  const wrap = h('section', { id: 'keys' });
  const draw = ({ keys, other }) => {
    let name = '';
    let value = '';
    const addOther = async () => {
      try { draw(await api(`/api/keys/${encodeURIComponent(name.trim().toUpperCase())}`, { method: 'PUT', body: { value } })); } catch (e) { toast(e.message, true); }
    };
    fill(wrap, h('h2', null, 'Keys'),
      h('p', { class: 'meta' }, 'Mortiflix runs on your own accounts. Keys stay in the studio folder (secrets.json and session.env, readable by you alone) and are never shown again.'),
      keys.map((k) => keyRow(k, draw)),
      h('div', { class: 'field' }, h('label', null, 'Other keys', h('div', { class: 'opt' }, 'handed to every session')),
        h('div', null,
          other.length ? h('div', { class: 'actions' }, other.map((n) => h('span', { class: 'chip' }, n, h('button', { class: 'btn link', 'aria-label': `Remove ${n}`, onclick: async () => { try { draw(await api(`/api/keys/${n}`, { method: 'DELETE' })); } catch (e) { toast(e.message, true); } } }, '×')))) : null,
          h('div', { class: 'actions', style: { marginTop: other.length ? '10px' : '0' } },
            h('input', { type: 'text', placeholder: 'NAME, e.g. GEMINI_API_KEY', 'aria-label': 'Key name', oninput: (e) => { name = e.target.value; }, style: { maxWidth: '240px' } }),
            h('input', { type: 'password', autocomplete: 'off', placeholder: 'value', 'aria-label': 'Key value', oninput: (e) => { value = e.target.value; } }),
            h('button', { class: 'btn', onclick: addOther }, 'Add')),
          h('div', { class: 'help' }, 'For tools a pipeline uses that read a key from the environment.'))),
      h('p', { class: 'meta' }, `Studio folder: ${studio.root}`));
  };
  draw(await api('/api/keys'));
  return wrap;
}

// ---------- narration (Settings › Voice) ----------

const ENGINE_LABELS = {
  elevenlabs: ['ElevenLabs', 'The most natural voices, 90+ languages, your own voice clones. Paid per character (their free plan is non-commercial).'],
  qwen: ['This computer (Qwen3-TTS)', 'Open model on your graphics card through ComfyUI: free, private, nothing leaves the machine.'],
  none: ['No narration', 'Videos carry their story with on-screen text, music and sound.'],
};

async function voiceSection() {
  let v = await api('/api/voice');
  const wrap = h('section', { id: 'voice' });
  const msg = h('span', { class: 'okmsg' });
  const save = async (patch, note = 'Saved') => {
    try { v = await api('/api/voice', { method: 'PUT', body: patch }); msg.textContent = note; setTimeout(() => { msg.textContent = ''; }, 1800); }
    catch (e) { toast(e.message, true); }
  };
  const field = (label, control, help) => h('div', { class: 'field' }, h('label', null, label), h('div', null, control, help ? h('div', { class: 'help' }, help) : null));

  async function draw() {
    const chip = (name) => {
      if (name === 'elevenlabs') return h('span', { class: `chip ${v.elevenlabs_key ? 'ok' : ''}` }, v.elevenlabs_key ? 'key saved' : 'needs a key');
      if (name === 'qwen') return h('span', { class: `chip ${v.local.fits ? 'ok' : 'warn'}` }, v.local.fits ? `${v.local.gpu.name.replace(/^NVIDIA (GeForce )?/, '')} · ${v.local.gpu.vram_gb} GB fits` : 'no suitable GPU found');
      return null;
    };
    const rows = h('ul', { class: 'rows' }, Object.entries(ENGINE_LABELS).map(([name, [title, about]]) => h('li', { class: 'row', style: { cursor: 'pointer' }, onclick: async () => { if (v.engine !== name) { await save({ engine: name }); draw(); } } },
      h('input', { type: 'radio', name: 'voice-engine', checked: v.engine === name, 'aria-label': title }),
      h('div', { class: 'main' }, h('span', { class: 'title' }, title), h('div', { class: 'meta', style: { whiteSpace: 'normal' } }, about)),
      h('div', { class: 'end' }, chip(name)))));
    const panel = h('div');
    fill(wrap, h('h2', null, 'Narration', msg), rows, panel);
    if (v.engine === 'elevenlabs') await elevenPanel(panel);
    else if (v.engine === 'qwen') await qwenPanel(panel);
    else fill(panel, h('p', { class: 'meta', style: { padding: '12px 0' } }, v.local.fits
      ? `Want a voice? ${v.local.reason} Pick "This computer" to narrate for free, or ElevenLabs for the most natural voices.`
      : 'Want a voice? Pick ElevenLabs above (a key from elevenlabs.io).'));
  }

  // ---- ElevenLabs ----
  async function elevenPanel(panel) {
    const e = v.elevenlabs;
    const keyInput = h('input', { type: 'password', autocomplete: 'off', placeholder: v.elevenlabs_key === 'saved' ? 'Saved (type to replace)' : v.elevenlabs_key ? 'Using ELEVENLABS_API_KEY' : 'xi-… from elevenlabs.io › Developers › API keys' });
    const account = h('div', { class: 'help' });
    const accountRow = field('API key', h('div', null, h('div', { class: 'actions' }, keyInput, h('button', { class: 'btn', onclick: async () => {
      if (keyInput.value.trim()) await save({ elevenlabs_key: keyInput.value.trim() }, 'Key saved');
      keyInput.value = '';
      draw();
    } }, 'Connect')), account), 'Kept only in the studio folder (secrets.json). Sessions get it only while ElevenLabs is the narration engine.');
    fill(panel, accountRow);
    if (!v.elevenlabs_key) return;

    let acct = null;
    try {
      acct = await api('/api/voice/elevenlabs/account');
      fill(account,
        h('span', { class: 'chip ok' }, `${acct.tier} plan`), ' ',
        `${acct.characters_left.toLocaleString()} of ${acct.character_limit.toLocaleString()} credits left`,
        acct.resets_at ? ` · resets ${new Date(acct.resets_at).toLocaleDateString()}` : '', ' ',
        acct.commercial_use ? h('span', { class: 'chip ok' }, 'commercial use') : h('span', { class: 'chip bad' }, 'free plan: non-commercial, credit ElevenLabs'),
        acct.concurrency ? ` · ${acct.concurrency} lines at once` : '');
    } catch (err) { fill(account, h('span', { class: 'err' }, err.message)); return; }

    const models = await api('/api/voice/elevenlabs/models').catch(() => []);
    const model = models.find((m) => m.id === e.model_id) || { id: e.model_id, can_use_style: !/^eleven_v4/.test(e.model_id), can_use_speaker_boost: !/^eleven_v4/.test(e.model_id) };
    const v4 = /^eleven_v4/.test(e.model_id);

    // The voice: current choice, then a picker (my voices / Voice Library) with previews.
    const picker = h('div');
    const current = h('div', { class: 'actions' }, h('span', { class: 'title' }, e.voice_name || 'No voice chosen yet'),
      h('button', { class: 'btn', onclick: () => openPicker('mine') }, 'Choose a voice'),
      h('button', { class: 'btn link', onclick: () => openPicker('library') }, 'Browse the Voice Library'));
    const play = (url) => { const a = new Audio(url); a.play().catch(() => toast('Could not play the preview', true)); };
    async function openPicker(where, search = '') {
      const input = h('input', { type: 'text', placeholder: where === 'mine' ? 'Search your voices (name, accent, use…)' : 'Search the Voice Library (e.g. "warm narrator", "British")', value: search });
      const list = h('ul', { class: 'rows' }, h('li', { class: 'meta' }, 'Loading…'));
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openPicker(where, input.value); });
      fill(picker, h('div', { class: 'actions', style: { margin: '10px 0' } }, input, h('button', { class: 'btn', onclick: () => openPicker(where, input.value) }, 'Search'),
        h('button', { class: 'btn link', onclick: () => openPicker(where === 'mine' ? 'library' : 'mine', input.value) }, where === 'mine' ? 'Voice Library instead' : 'My voices instead'),
        h('button', { class: 'btn link', onclick: () => fill(picker) }, 'Close')), list);
      try {
        const r = where === 'mine'
          ? await api(`/api/voice/elevenlabs/voices?search=${encodeURIComponent(search)}`)
          : await api(`/api/voice/elevenlabs/library?search=${encodeURIComponent(search)}`);
        fill(list, r.voices.length ? r.voices.map((x) => h('li', { class: 'row' },
          x.preview_url ? h('button', { class: 'btn link', 'aria-label': `Play ${x.name}`, onclick: () => play(`/api/voice/elevenlabs/preview?url=${encodeURIComponent(x.preview_url)}`) }, '▶') : h('span'),
          h('div', { class: 'main' }, h('span', { class: 'title' }, x.name),
            h('div', { class: 'meta', style: { whiteSpace: 'normal' } }, Object.values(x.labels || {}).filter(Boolean).join(' · ') || x.category || '', where === 'library' && x.free_users_allowed === false ? ' · paid plans only' : '')),
          h('div', { class: 'end' }, h('button', { class: 'btn', onclick: async () => {
            try {
              let id = x.id;
              if (where === 'library') id = (await api('/api/voice/elevenlabs/library/add', { method: 'POST', body: { owner: x.owner, voice_id: x.id, name: x.name } })).id;
              await save({ elevenlabs: { voice_id: id, voice_name: x.name } }, `${x.name} chosen`);
              draw();
            } catch (err) { toast(err.message, true); }
          } }, where === 'library' ? 'Add & use' : 'Use')))) : h('li', { class: 'meta' }, 'No voices match.'));
      } catch (err) { fill(list, h('li', { class: 'err' }, err.message)); }
    }

    const slider = (key, label, lo, hi, step, help) => {
      const out = h('span', { class: 'meta' }, String(e[key]));
      return field(label, h('div', { class: 'actions' }, h('input', { type: 'range', min: lo, max: hi, step, value: e[key], style: { width: '220px' },
        oninput: (ev) => { out.textContent = ev.target.value; }, onchange: (ev) => save({ elevenlabs: { [key]: Number(ev.target.value) } }) }), out), help);
    };
    const select = (key, options, help, label) => field(label, h('select', { style: { maxWidth: '320px' }, onchange: (ev) => save({ elevenlabs: { [key]: ev.target.value } }) },
      options.map((o) => h('option', { value: o.value, selected: String(e[key] ?? '') === String(o.value), disabled: o.disabled }, o.label))), help);

    const dicts = await api('/api/voice/elevenlabs/dictionaries').catch(() => []);
    const chosenDicts = new Set((e.pronunciation_dictionaries || []).map((d) => d.id));
    const sampleText = h('textarea', { style: { minHeight: '60px' } }, v4 ? '[warm] Every city has a heartbeat. Ours runs on bikes.' : 'Every city has a heartbeat. Ours runs on bikes.');
    const player = h('div');

    fill(panel, accountRow,
      field('Voice', h('div', null, current, picker), 'Your voices, the default voices and any you add from the Voice Library. ▶ plays the voice\'s own preview (free).'),
      field('Model', choiceChips(models.map((m) => m.id), e.model_id, (id) => save({ elevenlabs: { model_id: id } }).then(draw)),
        models.length ? `${models.find((m) => m.id === e.model_id)?.name || e.model_id}: ${models.find((m) => m.id === e.model_id)?.languages || '?'} languages, up to ${(models.find((m) => m.id === e.model_id)?.max_characters || 0).toLocaleString()} characters a line. eleven_v4 is ElevenLabs' newest and recommended for narration.` : null),
      slider('stability', 'Stability', 0, 1, 0.05, 'Lower: more expressive and varied. Higher: steadier. Promos 0.4–0.5, long narration 0.55–0.65.'),
      slider('similarity_boost', 'Similarity', 0, 1, 0.05, 'How closely it sticks to the original voice. Raise it if a clone drifts.'),
      v4 ? field('Direction', h('div', { class: 'meta', style: { whiteSpace: 'normal' } }, 'Eleven v4 is directed in the script itself: audio tags like [warm] or [whispers], CAPITALS for emphasis, ellipses for pauses, and "/IPA/" for names. It has no style or speed settings and ignores SSML.')) : null,
      !v4 && model.can_use_style ? slider('style', 'Style', 0, 1, 0.05, 'Exaggerates the voice\'s style. Above 0 can cost stability and speed.') : null,
      !v4 ? slider('speed', 'Speed', 0.7, 1.2, 0.05, '1.0 is the voice\'s natural pace.') : null,
      !v4 && model.can_use_speaker_boost ? field('Speaker boost', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: e.use_speaker_boost, onchange: (ev) => save({ elevenlabs: { use_speaker_boost: ev.target.checked } }) }), 'Closer to the original speaker (slightly slower)')) : null,
      field('Language', h('input', { type: 'text', style: { maxWidth: '140px' }, placeholder: 'auto', value: e.language_code || '', onchange: (ev) => save({ elevenlabs: { language_code: ev.target.value.trim().toLowerCase() } }) }), 'Optional ISO 639-1 code (en, es, de…) to force a language and its number reading. Blank: detected from the text.'),
      select('apply_text_normalization', [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Always spell out numbers, dates…' }, { value: 'off', label: 'Off (read exactly as written)' }], 'How numbers, dates and abbreviations are read. Writing them out in the script is the most reliable.', 'Text normalization'),
      dicts.length ? field('Pronunciation', h('div', null, dicts.map((d) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: chosenDicts.has(d.id), onchange: (ev) => {
        const next = [...(e.pronunciation_dictionaries || []).filter((x) => x.id !== d.id), ...(ev.target.checked ? [{ id: d.id, version_id: d.version_id, name: d.name }] : [])].slice(0, 3);
        save({ elevenlabs: { pronunciation_dictionaries: next } });
      } }), d.name))), 'Up to 3 of your pronunciation dictionaries, applied in order. Phoneme rules work on v4, v3 and Flash v2; other models use alias rules only.') : null,
      select('output_format', v.output_formats.map((f) => ({ value: f.id, label: `${f.label}${f.tier ? ` (${f.tier} plan or above)` : ''}`, disabled: f.tier && !tierOk(acct.tier, f.tier) })), 'What each line is saved as. MP3 128 kbps is plenty for narration under music.', 'Audio format'),
      select('server', v.servers.map((x) => ({ value: x, label: { default: 'Default (global)', us: 'United States', eu: 'EU data residency', in: 'India data residency', sg: 'Singapore data residency' }[x] })), 'Only change this if your account lives on a data-residency server.', 'Server'),
      select('check_model', [{ value: 'scribe_v2', label: 'Check every line with Scribe v2 (recommended)' }, { value: 'off', label: 'Don\'t check' }], 'Speech to text listens to every take, retakes lines with missing words, and gives the animation exact word timings. Costs a little extra.', 'Checks'),
      field('Also use for', h('div', null,
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: e.sfx, onchange: (ev) => save({ elevenlabs: { sfx: ev.target.checked } }) }), 'Sound effects (whooshes, hits, ambience: up to 30 s, loopable)'),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: e.music, onchange: (ev) => save({ elevenlabs: { music: ev.target.checked } }) }), 'Music beds (Eleven Music: instrumental, 3 s to 10 min)')),
        h('span', null, 'Music usage terms depend on your plan: ', h('a', { href: 'https://elevenlabs.io/music-terms', target: '_blank', rel: 'noopener' }, 'elevenlabs.io/music-terms'))),
      field('Try it', h('div', null, sampleText, h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => trySample('elevenlabs', sampleText.value, player) }, 'Speak this line'), h('span', { class: 'meta' }, 'uses about one credit per character')), player)),
      h('p', { class: 'meta', style: { padding: '10px 0' } }, 'Zero-retention mode (no logs at ElevenLabs) is for Enterprise accounts only, so it isn\'t offered here. Voice clones: only of your own voice or with the speaker\'s consent.'),
    );
  }

  // ---- Qwen3-TTS through ComfyUI ----
  async function qwenPanel(panel) {
    const qc = v.qwen;
    const status = h('div', { class: 'help' }, 'Checking ComfyUI…');
    const url = h('input', { type: 'text', value: qc.url, style: { maxWidth: '280px' } });
    const gpuLine = h('p', { class: 'meta', style: { padding: '8px 0', whiteSpace: 'normal' } }, v.local.reason);
    fill(panel, gpuLine, field('ComfyUI', h('div', null, h('div', { class: 'actions' }, url, h('button', { class: 'btn', onclick: async () => { await save({ qwen: { url: url.value.trim() } }); draw(); } }, 'Check')), status)));
    let st;
    try { st = await api(`/api/voice/qwen/status?url=${encodeURIComponent(qc.url)}`); } catch (err) { st = { ok: false, reason: err.message }; }
    if (!st.ok) {
      fill(status, h('span', { class: 'err' }, st.reason));
      add(panel, h('div', { class: 'field' }, h('label', null, 'Set it up'), h('ol', { style: { margin: 0, paddingLeft: '18px' } },
        st.step !== 'suite' ? h('li', null, 'Install ComfyUI and start it (', h('a', { href: 'https://www.comfy.org/download', target: '_blank', rel: 'noopener' }, 'comfy.org/download'), '). It listens on http://127.0.0.1:8188 by default.') : null,
        h('li', null, 'In ComfyUI Manager, install "TTS Audio Suite" (or clone ', h('a', { href: 'https://github.com/diodiogod/TTS-Audio-Suite', target: '_blank', rel: 'noopener' }, 'diodiogod/TTS-Audio-Suite'), ' into custom_nodes and run its install.py).'),
        h('li', null, 'Restart ComfyUI, then press Check. The Qwen3-TTS models (Apache-2.0) download from Hugging Face on first use: about 4 GB for 1.7B.'))));
      return;
    }
    fill(status, h('span', { class: 'chip ok' }, 'ready'), ` ComfyUI ${st.comfyui || ''} · TTS Audio Suite · ${st.gpu || 'GPU'}${st.vram_free_gb !== null ? ` · ${st.vram_free_gb} GB free now` : ''}`, st.can_listen ? '' : ' · (this suite version has no Qwen3-ASR: lines won\'t be checked)');
    const custom = st.models.filter((m) => /CustomVoice/.test(m));
    const pickModel = (m) => (/1\.7B/.test(m) ? 'CustomVoice 1.7B' : 'CustomVoice 0.6B');
    const sampleText = h('textarea', { style: { minHeight: '60px' } }, 'Every city has a heartbeat. Ours runs on bikes.');
    const player = h('div');
    const is17 = /1\.7B/.test(qc.model);
    add(panel, 
      field('Model', choiceChips(custom.map(pickModel), qc.model, (m) => save({ qwen: { model: m } }).then(draw)), is17 ? 'Takes a delivery instruction. Needs about 6.5 GB of free GPU memory while it speaks.' : 'Preset voices only, no delivery instruction. About half the memory of 1.7B.'),
      field('Voice', h('select', { style: { maxWidth: '100%' }, onchange: (ev) => save({ qwen: { voice: ev.target.value } }) },
        st.voices.map((name) => { const p = v.presets.find((x) => x.id === name); return h('option', { value: name, selected: qc.voice === name }, p ? `${name} · ${p.language} · ${p.about}` : name); })),
        'Built into the model (no cloning, no consent question). Each speaks all 10 languages; the listed one is its native language.'),
      field('Language', h('select', { style: { maxWidth: '200px' }, onchange: (ev) => save({ qwen: { language: ev.target.value } }) }, st.languages.map((l) => h('option', { value: l, selected: qc.language === l }, l)))),
      is17 ? field('Delivery', h('textarea', { style: { minHeight: '60px' }, onchange: (ev) => save({ qwen: { instruct: ev.target.value } }) }, qc.instruct), 'How it should sound, in plain words: pace, warmth, energy. Inline tags like [warm] are not read.') : null,
      st.runtime_modes.length ? field('Runtime', h('select', { style: { maxWidth: '240px' }, onchange: (ev) => save({ qwen: { runtime_mode: ev.target.value } }) }, st.runtime_modes.map((m) => h('option', { value: m, selected: qc.runtime_mode === m }, m))), 'The suite\'s own setting. Try Main Environment first; if ComfyUI reports a transformers version error, choose its Shared Runtime.') : null,
      field('Checks', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: qc.check, disabled: !st.can_listen, onchange: (ev) => save({ qwen: { check: ev.target.checked } }) }), 'Listen back to every line with Qwen3-ASR (retakes misread lines, gives word timings)')),
      field('Try it', h('div', null, sampleText, h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => trySample('qwen', sampleText.value, player) }, 'Speak this line'), h('span', { class: 'meta' }, 'the first run downloads the model')), player)),
    );
  }

  async function trySample(engine, text, player) {
    fill(player, h('span', { class: 'meta' }, 'Speaking…'));
    try {
      const res = await fetch('/api/voice/sample', { method: 'POST', headers: { 'x-mortiflix': '1', 'content-type': 'application/json' }, body: JSON.stringify({ engine, text }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      fill(player, h('audio', { src: url, controls: true, autoplay: true, style: { width: '100%', marginTop: '8px' } }));
    } catch (err) { fill(player, h('span', { class: 'err' }, err.message)); }
  }

  await draw();
  return wrap;
}

const TIERS = ['free', 'starter', 'creator', 'pro', 'scale', 'business', 'enterprise'];
const tierOk = (tier, need) => TIERS.indexOf(String(tier || 'free').replace(/_.*/, '')) >= TIERS.indexOf(need);

// ---------- start ----------

await loadStudio();
connect();
render();
