// The project brief (plan 52, owner's New Project redesign): one versioned object the New Project screen builds, autosaves
// as a draft, and sends to project.new. `brief.schema` hands this to the screen so it renders from it. A setting that is
// absent from the brief is "default" (never written by the service); a present one is "specified" (or "suggested" when
// listed in meta.suggested after the owner accepted an AI suggestion).
export const BRIEF_VERSION = 1;

const c = (value, label, hint) => ({ value, label, ...(hint ? { hint } : {}) });
const AUTO = c('auto', 'Auto', 'the studio decides from the topic');

export const SECTIONS = [
  { id: 'story', label: 'Story & research', summary: 'Audience, tone, research, structure and what must or must not be said' },
  { id: 'visual', label: 'Visual direction', summary: 'Style, brand, motion, assets, captions and safe zones (all visuals are drawn in code)' },
  { id: 'voice', label: 'Voice & sound', summary: 'Starting preferences, refined later in Voice & Music. Decide later is fine.' },
  { id: 'delivery', label: 'Delivery settings', summary: 'Where it plays, shapes, length and output quality' },
  { id: 'workflow', label: 'Production workflow', summary: 'Where the studio stops for your approval' },
];

// type: choice (one of `choices`, or free words when custom), multi (array; same), text, long, list (array of short strings),
// bool, number, object (parts). `used_by`: the stages whose prompts or code read it today; [] = stored only.
export const FIELDS = [
  // ---- Story & research (15)
  { id: 'story.audience', section: 'story', label: 'Target audience', type: 'text', default: '', help: 'Who is watching, in a few words.', used_by: ['brief', 'script'] },
  { id: 'story.knowledge_level', section: 'story', label: 'Viewer knowledge', type: 'choice', default: 'auto', choices: [AUTO, c('newcomer', 'Newcomer', 'has never heard of it'), c('some', 'Some knowledge'), c('informed', 'Informed'), c('expert', 'Expert')], used_by: ['brief', 'script'] },
  { id: 'story.objective', section: 'story', label: 'Video objective', type: 'choice', default: 'auto', choices: [AUTO, c('educate', 'Educate'), c('entertain', 'Entertain'), c('persuade', 'Persuade'), c('explain', 'Explain'), c('sell', 'Sell')], used_by: ['brief', 'script'] },
  { id: 'story.tone', section: 'story', label: 'Tone and personality', type: 'multi', custom: true, default: [], choices: [c('serious', 'Serious'), c('humorous', 'Humorous'), c('cinematic', 'Cinematic'), c('investigative', 'Investigative'), c('warm', 'Warm'), c('energetic', 'Energetic')], help: 'Pick any, or add your own words.', used_by: ['brief', 'script'] },
  { id: 'story.depth', section: 'story', label: 'Explanation depth', type: 'choice', default: 'auto', choices: [AUTO, c('beginner', 'Beginner'), c('intermediate', 'Intermediate'), c('advanced', 'Advanced'), c('expert', 'Technical expert')], used_by: ['brief', 'script'] },
  { id: 'story.hook', section: 'story', label: 'Opening hook', type: 'choice', custom: true, default: 'auto', choices: [AUTO, c('question', 'A question'), c('bold_claim', 'A bold claim'), c('story', 'A short story'), c('surprising_fact', 'A surprising fact'), c('problem', 'The problem'), c('cold_open', 'Cold open')], used_by: ['script'] },
  { id: 'story.cta', section: 'story', label: 'Call to action', type: 'text', default: '', help: 'What the viewer should do at the end. Empty = none.', used_by: ['script'] },
  { id: 'story.research_depth', section: 'story', label: 'Research depth', type: 'choice', default: 'standard', choices: [c('quick', 'Quick', 'check what you are unsure of'), c('standard', 'Standard'), c('investigative', 'Investigative', 'cross-check every claim')], help: 'Changing this never starts research by itself.', used_by: ['brief', 'script'] },
  { id: 'story.preferred_sources', section: 'story', label: 'Preferred sources', type: 'list', default: [], help: 'Sites, papers or people to trust first.', used_by: ['brief', 'script'] },
  { id: 'story.citations', section: 'story', label: 'Citations', type: 'choice', default: 'none', choices: [c('none', 'None'), c('end_card', 'Sources end card'), c('on_screen', 'On screen where claimed')], used_by: ['script'] },
  { id: 'story.verification', section: 'story', label: 'Fact verification', type: 'choice', default: 'standard', choices: [c('light', 'Light'), c('standard', 'Standard'), c('strict', 'Strict', 'every number and name checked')], used_by: ['brief', 'script'] },
  { id: 'story.structure', section: 'story', label: 'Story structure', type: 'choice', custom: true, default: 'auto', choices: [AUTO, c('documentary', 'Documentary'), c('explainer', 'Explainer'), c('countdown', 'Countdown'), c('narrative', 'Narrative')], used_by: ['brief', 'script'] },
  { id: 'story.must_include', section: 'story', label: 'Mandatory facts', type: 'list', default: [], used_by: ['brief', 'script'] },
  { id: 'story.excluded_claims', section: 'story', label: 'Excluded claims', type: 'list', default: [], used_by: ['brief', 'script'] },
  { id: 'story.forbidden_topics', section: 'story', label: 'Forbidden topics', type: 'list', default: [], used_by: ['brief', 'script'] },
  // ---- Visual direction (7)
  { id: 'visual.style', section: 'visual', label: 'Visual style', type: 'object', default: { preset: 'auto', custom: '' }, parts: [
    { key: 'preset', type: 'choice', choices: [AUTO, c('editorial', 'Editorial'), c('kinetic_typography', 'Kinetic typography'), c('3d', '3D'), c('minimalist', 'Minimalist'), c('custom', 'Custom')] },
    { key: 'custom', type: 'text', help: 'Your own words for the style (used when preset is custom).' }], used_by: ['stills', 'look'] },
  { id: 'visual.brand', section: 'visual', label: 'Brand kit', type: 'object', default: { preset: '', colors: [], heading_font: '', body_font: '', logo_source: '' }, parts: [
    { key: 'preset', type: 'text', help: 'A saved identity preset (slug).' },
    { key: 'colors', type: 'list', help: 'Hex colours, e.g. #7c5cff.' },
    { key: 'heading_font', type: 'text' }, { key: 'body_font', type: 'text' },
    { key: 'logo_source', type: 'text', help: 'Id of a source in the tray that is the logo.' }], used_by: ['stills', 'look'] },
  { id: 'visual.motion_intensity', section: 'visual', label: 'Motion intensity', type: 'choice', default: 'balanced', choices: [c('calm', 'Calm', 'slow drifts and long holds'), c('balanced', 'Balanced', 'something moves on every beat'), c('lively', 'Lively', 'quick pushes and wipes'), c('intense', 'Intense', 'constant movement and hard cuts')], used_by: ['stills'] },
  { id: 'visual.animation_complexity', section: 'visual', label: 'Animation complexity', type: 'choice', default: 'standard', choices: [c('simple', 'Simple', 'type and shapes only'), c('standard', 'Standard', 'layered scenes'), c('rich', 'Rich', 'many moving parts per scene')], used_by: ['stills'] },
  { id: 'visual.asset_strategy', section: 'visual', label: 'Asset strategy', type: 'object', default: { source: 'both', precedence: 'uploaded_first', rights_confirmed: false }, parts: [
    { key: 'source', type: 'choice', choices: [c('uploaded', 'Uploaded assets only'), c('drawn', 'Code-drawn visuals only', 'drawn in code, never an AI image model'), c('both', 'Both')] },
    { key: 'precedence', type: 'choice', choices: [c('uploaded_first', 'Uploaded assets win'), c('drawn_first', 'Drawn visuals win')] },
    { key: 'rights_confirmed', type: 'bool', help: 'I have the rights to use the uploaded files.' }], used_by: ['stills'] },
  { id: 'visual.captions', section: 'visual', label: 'Captions and on-screen type', type: 'object', default: { mode: 'auto', style: 'clean' }, parts: [
    { key: 'mode', type: 'choice', choices: [AUTO, c('on', 'On'), c('off', 'Off')] },
    { key: 'style', type: 'choice', custom: true, choices: [c('clean', 'Clean'), c('bold', 'Bold'), c('word_by_word', 'Word by word')] }], used_by: [] },
  { id: 'visual.safe_zones', section: 'visual', label: 'Platform safe zones', type: 'choice', default: 'auto', choices: [c('auto', 'Auto', 'follows the destination'), c('on', 'Always keep text inside'), c('off', 'Off')], used_by: [] },
  // ---- Voice & sound (4): all start as "decide later"
  { id: 'voice.voice', section: 'voice', label: 'Voice', type: 'object', decide_later: true, default: { language: 'English', accent: '', delivery: 'auto', pacing: 'natural' }, parts: [
    { key: 'language', type: 'text' }, { key: 'accent', type: 'text' },
    { key: 'delivery', type: 'choice', custom: true, choices: [AUTO, c('conversational', 'Conversational'), c('calm', 'Calm'), c('energetic', 'Energetic'), c('dramatic', 'Dramatic')] },
    { key: 'pacing', type: 'choice', choices: [c('slow', 'Slow'), c('natural', 'Natural'), c('brisk', 'Brisk')] }], help: 'Starting preferences. The ElevenLabs voice is picked later in Voice & Music.', used_by: [] },
  { id: 'voice.music', section: 'voice', label: 'Music', type: 'object', decide_later: true, default: { genre: '', mood: '', energy: 'auto', instrumentation: '' }, parts: [
    { key: 'genre', type: 'text' }, { key: 'mood', type: 'text' },
    { key: 'energy', type: 'choice', choices: [AUTO, c('low', 'Low'), c('medium', 'Medium'), c('high', 'High')] },
    { key: 'instrumentation', type: 'text' }], help: 'Music is made with ElevenLabs, with your OK on the cost first.', used_by: [] },
  { id: 'voice.sound_design', section: 'voice', label: 'Sound design', type: 'object', decide_later: true, default: { intensity: 'subtle', transitions: 'auto' }, parts: [
    { key: 'intensity', type: 'choice', choices: [c('none', 'None'), c('subtle', 'Subtle'), c('moderate', 'Moderate'), c('rich', 'Rich')] },
    { key: 'transitions', type: 'choice', custom: true, choices: [AUTO, c('cut', 'Plain cuts'), c('whoosh', 'Whooshes'), c('hit', 'Hits')] }], used_by: [] },
  { id: 'voice.pauses', section: 'voice', label: 'Pauses and silence', type: 'object', decide_later: true, default: { narrative_pauses: 'auto', silence: '' }, parts: [
    { key: 'narrative_pauses', type: 'choice', choices: [AUTO, c('fewer', 'Fewer'), c('more', 'More')] },
    { key: 'silence', type: 'text', help: 'Where to leave intentional silence, in your words.' }], used_by: [] },
  // ---- Delivery (4)
  { id: 'delivery.destination', section: 'delivery', label: 'Destination', type: 'choice', default: 'youtube', choices: [c('youtube', 'YouTube'), c('tiktok', 'TikTok'), c('reels', 'Reels'), c('presentation', 'Presentation'), c('website', 'Website')], help: 'Recommends a shape and length. It never changes your picks.', used_by: ['script'] },
  { id: 'delivery.aspects', section: 'delivery', label: 'Aspect ratios', type: 'multi', default: ['16:9'], choices: [c('16:9', '16:9'), c('9:16', '9:16'), c('1:1', '1:1'), c('4:5', '4:5')], help: 'Each ratio is one more deliverable. The first is the one the video is designed for.', used_by: ['look', 'stills'] },
  { id: 'delivery.duration', section: 'delivery', label: 'Duration', type: 'object', default: { mode: 'auto', seconds: null }, parts: [
    { key: 'mode', type: 'choice', choices: [c('auto', 'Auto', 'the topic sets the length'), c('manual', 'Set a length')] },
    { key: 'seconds', type: 'number', min: 5, max: 3600 }], used_by: ['script', 'voice'] },
  { id: 'delivery.output', section: 'delivery', label: 'Resolution, frame rate and quality', type: 'object', default: { resolution: '1080p', fps: 30, quality: 'standard' }, parts: [
    { key: 'resolution', type: 'choice', choices: [c('720p', '720p'), c('1080p', '1080p'), c('1440p', '1440p'), c('2160p', '4K')] },
    { key: 'fps', type: 'choice', choices: [c(24, '24'), c(30, '30'), c(60, '60')] },
    { key: 'quality', type: 'choice', choices: [c('draft', 'Draft'), c('standard', 'Standard'), c('high', 'High')] }], unsupported: [{ resolution: '2160p', fps: 60 }], used_by: [] },
  // ---- Production workflow (1 setting + preset)
  { id: 'workflow.checkpoints', section: 'workflow', label: 'Approval checkpoints', type: 'multi', default: ['script', 'voice_music', 'look', 'stills', 'motion', 'sound', 'final'], choices: [], used_by: [] },
];

// The checkpoints and the v3 review gate each one is (null = no gate yet). Every v3 gate stays on whatever is picked.
export const CHECKPOINTS = [
  c('outline', 'Outline', 'generate and review an outline before the script'),
  c('script', 'Script'), c('voice_music', 'Voice and music'), c('look', 'Look'), c('stills', 'Stills'), c('motion', 'Motion'), c('sound', 'Sound'), c('final', 'Final export'),
].map((x) => ({ ...x, gate: { outline: null, script: 'script', voice_music: 'voice', look: 'style-frames', stills: 'stills', motion: 'animatic', sound: 'sound', final: 'artcraft' }[x.value] }));
FIELDS.find((f) => f.id === 'workflow.checkpoints').choices = CHECKPOINTS.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) }));

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.id, f]));
export const TOP = ['version', 'idea', 'title', 'sources', 'decide_later', 'meta', 'story', 'visual', 'voice', 'delivery', 'workflow'];
export const QUICK = ['delivery.destination', 'delivery.duration']; // the compact controls above the accordions

const bad = (m) => { const e = new Error(m); e.code = 'bad_request'; throw e; };
export const defaultOf = (f) => structuredClone(f.default);
export const valuesOf = (f) => (f.choices || []).map((x) => x.value);

// One value against a type spec; returns the clean value or throws a plain sentence.
function cleanValue(spec, v, label) {
  const vals = valuesOf(spec);
  const inChoices = (x) => vals.some((y) => y === x || String(y) === String(x));
  const pick = (x) => vals.find((y) => y === x || String(y) === String(x));
  switch (spec.type) {
    case 'text': return String(v ?? '').slice(0, 500);
    case 'long': return String(v ?? '').slice(0, 20_000);
    case 'bool': if (typeof v !== 'boolean') bad(`${label} is yes or no`); return v;
    case 'number': {
      const n = Number(v);
      if (v === null || v === '') return null;
      if (!Number.isFinite(n) || (spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) bad(`${label} is a number from ${spec.min} to ${spec.max}`);
      return Math.round(n);
    }
    case 'list': {
      if (!Array.isArray(v)) bad(`${label} is a list`);
      return v.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 40);
    }
    case 'choice': {
      if (inChoices(v)) return pick(v);
      if (spec.custom && String(v ?? '').trim()) return String(v).trim().slice(0, 300);
      bad(`${label} must be one of: ${vals.join(', ')}${spec.custom ? ', or your own words' : ''}`);
      break;
    }
    case 'multi': {
      if (!Array.isArray(v)) bad(`${label} is a list`);
      const out = [];
      for (const x of v) {
        if (inChoices(x)) out.push(pick(x));
        else if (spec.custom && String(x ?? '').trim()) out.push(String(x).trim().slice(0, 300));
        else bad(`${label}: "${x}" is not one of ${vals.join(', ')}`);
      }
      return [...new Set(out)];
    }
    default: bad(`${label}: unknown type`);
  }
  return v;
}

function cleanField(f, v) {
  if (f.type !== 'object') return cleanValue(f, v, f.label);
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${f.label} is a group of settings`);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const part = f.parts.find((p) => p.key === k);
    if (!part) bad(`${f.label}: unknown setting "${k}"`);
    out[k] = cleanValue(part, x, `${f.label} / ${k}`);
  }
  for (const u of f.unsupported || []) {
    const merged = { ...f.default, ...out };
    if (Object.entries(u).every(([k, x]) => String(merged[k]) === String(x))) bad(`${f.label}: ${Object.entries(u).map(([k, x]) => `${k} ${x}`).join(' with ')} is not supported`);
  }
  return out;
}

// Check a whole brief. Returns { brief, errors: [{path, message}] }; the brief keeps only what is valid. Unset = absent.
export function normalizeBrief(input) {
  const errors = [];
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { version: BRIEF_VERSION };
  if (b.version != null && Number(b.version) > BRIEF_VERSION) errors.push({ path: 'version', message: `This brief is version ${b.version}; the studio reads up to ${BRIEF_VERSION}.` });
  for (const k of Object.keys(b)) if (!TOP.includes(k)) errors.push({ path: k, message: `Unknown brief setting "${k}".` });
  if (b.idea != null) out.idea = String(b.idea).slice(0, 20_000);
  if (b.title != null && String(b.title).trim()) out.title = String(b.title).trim().slice(0, 200);
  if (Array.isArray(b.sources)) out.sources = [...new Set(b.sources.map(String))].slice(0, 100);
  if (b.decide_later && typeof b.decide_later === 'object') {
    out.decide_later = {};
    for (const [k, x] of Object.entries(b.decide_later)) if (FIELD[`voice.${k}`]?.decide_later) out.decide_later[k] = Boolean(x);
  }
  if (b.meta && typeof b.meta === 'object') {
    out.meta = {};
    if (Array.isArray(b.meta.suggested)) out.meta.suggested = b.meta.suggested.filter((p) => FIELD[p] || p === 'idea').map(String);
    if (b.meta.preset) out.meta.preset = String(b.meta.preset).slice(0, 80);
  }
  for (const sec of SECTIONS) {
    const group = b[sec.id];
    if (group == null) continue;
    if (typeof group !== 'object' || Array.isArray(group)) { errors.push({ path: sec.id, message: `${sec.label} is a group of settings.` }); continue; }
    out[sec.id] = {};
    for (const [k, v] of Object.entries(group)) {
      const f = FIELD[`${sec.id}.${k}`];
      if (!f) { errors.push({ path: `${sec.id}.${k}`, message: `Unknown setting "${sec.id}.${k}".` }); continue; }
      try { out[sec.id][k] = cleanField(f, v); } catch (e) { errors.push({ path: f.id, message: e.message }); }
    }
  }
  return { brief: out, errors };
}

// The value in force: what the brief says, else the default; and where it came from.
export function valueOf(brief, id) {
  const [sec, k] = id.split('.');
  const f = FIELD[id];
  const set = brief?.[sec]?.[k];
  if (set === undefined) return { value: defaultOf(f), origin: 'default' };
  const merged = f.type === 'object' ? { ...defaultOf(f), ...set } : set;
  return { value: merged, origin: brief?.meta?.suggested?.includes(id) ? 'suggested' : 'specified' };
}

export function schemaView() {
  return {
    version: BRIEF_VERSION,
    required: ['idea'],
    top: { idea: { type: 'long', label: 'What should your video be about?', required: true, max: 20_000, help: 'The only required input. The idea, who it is for, and the one thing a viewer should remember.' },
      title: { type: 'text', label: 'Project name', default: '' }, sources: { type: 'ids', label: 'Source tray', help: 'Ids from sources.add, in this draft.' } },
    quick: QUICK,
    sections: SECTIONS.map((s) => ({ ...s, fields: FIELDS.filter((f) => f.section === s.id) })),
    checkpoints: CHECKPOINTS,
    decide_later: Object.keys(FIELD).filter((k) => FIELD[k].decide_later).map((k) => k.split('.')[1]),
    stored_only: FIELDS.filter((f) => !f.used_by.length).map((f) => f.id),
    source_kinds: ['url', 'pdf', 'docx', 'text', 'image', 'video', 'audio', 'other'],
  };
}
