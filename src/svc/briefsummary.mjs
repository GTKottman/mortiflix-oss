// The live brief (plan 52): human sentences labelled specified / suggested / default, what is missing and what conflicts.
// Rule-based and instant: no AI call, nothing read from disk (the tray's rows are passed in).
import { SECTIONS, FIELD, normalizeBrief, valueOf, CHECKPOINTS } from './briefschema.mjs';

const WPS_DEFAULT = 2; // spoken words per second (120 a minute) until a voice has been measured (svc/pace.mjs)
const words = (t) => (String(t || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const label = (id, v) => (FIELD[id].choices || []).find((c) => String(c.value) === String(v))?.label || String(v);
const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a[0] || '');
const lower = (s) => String(s).toLowerCase();
const mmss = (s) => (s >= 90 ? `${Math.round(s / 6) / 10} min` : `${s} s`);
const originOf = (xs) => (xs.some((x) => x.origin === 'specified') ? 'specified' : xs.some((x) => x.origin === 'suggested') ? 'suggested' : 'default');

// `wpm`: the studio voice's measured pace (svc/pace.mjs); 2.5 words a second when none is given.
export function summarize(input, sources = [], { wpm = null } = {}) {
  const WPS = wpm ? wpm / 60 : WPS_DEFAULT;
  const { brief, errors } = normalizeBrief(input);
  const S = []; const missing = []; const conflicts = [];
  const v = (id) => valueOf(brief, id);
  const say = (section, path, text, origin) => S.push({ section, path, text, label: origin });
  const idea = String(brief.idea || '').trim();

  if (idea) say('story', 'idea', `The video is about: ${idea.replace(/\s+/g, ' ').slice(0, 220)}${idea.length > 220 ? '…' : ''}`, 'specified');
  else missing.push({ path: 'idea', text: 'Say what the video is about: the idea, who it is for, and the one thing a viewer should remember. Example: "How a heat pump moves heat, for homeowners deciding whether to switch."' });

  const aud = v('story.audience'); const know = v('story.knowledge_level'); const obj = v('story.objective');
  if (aud.value) say('story', 'story.audience', `For ${aud.value}${know.origin !== 'default' ? `, ${lower(label('story.knowledge_level', know.value))} level` : ''}.`, aud.origin);
  else missing.push({ path: 'story.audience', text: 'Who is watching? Without it the script assumes general viewers.' });
  if (obj.origin !== 'default') say('story', 'story.objective', `Goal: ${lower(label('story.objective', obj.value))}.`, obj.origin);
  const tone = v('story.tone'); const st = v('story.structure'); const hook = v('story.hook'); const depth = v('story.depth');
  const narr = [];
  if (tone.value.length) narr.push(`${list(tone.value.map((t) => lower(label('story.tone', t))))} tone`);
  if (st.origin !== 'default') narr.push(`${lower(label('story.structure', st.value))} structure`);
  if (hook.origin !== 'default') narr.push(`${lower(label('story.hook', hook.value))} opening`);
  if (depth.origin !== 'default') narr.push(`${lower(label('story.depth', depth.value))} depth`);
  if (narr.length) say('story', 'story.tone', `Narrative: ${list(narr)}.`, originOf([tone, st, hook, depth]));
  else say('story', 'story.tone', 'Narrative: the studio picks tone, structure and opening from the topic.', 'default');
  const cta = v('story.cta');
  if (cta.value) say('story', 'story.cta', `Ends with: ${cta.value}`, cta.origin);
  const rd = v('story.research_depth'); const ver = v('story.verification'); const cit = v('story.citations');
  say('story', 'story.research_depth', `Research is ${lower(label('story.research_depth', rd.value))}, fact checking ${lower(label('story.verification', ver.value))}${cit.value !== 'none' ? `, citations as ${lower(label('story.citations', cit.value))}` : ''}.`, originOf([rd, ver, cit]));
  for (const [id, what] of [['story.must_include', 'Must include'], ['story.excluded_claims', 'Must not claim'], ['story.forbidden_topics', 'Off limits'], ['story.preferred_sources', 'Trusted sources first']]) {
    const x = v(id);
    if (x.value.length) say('story', id, `${what}: ${list(x.value)}.`, x.origin);
  }

  const total = sources.length; const ready = sources.filter((s) => s.status === 'ready' || s.status === 'stored').length;
  const failed = sources.filter((s) => s.status === 'failed').length; const reading = sources.filter((s) => s.status === 'fetching').length;
  if (total) say('story', 'sources', `${total} source${total > 1 ? 's' : ''} in the tray: ${ready} ready${reading ? `, ${reading} still reading` : ''}${failed ? `, ${failed} could not be read` : ''}.`, 'specified');
  else if (rd.value === 'investigative') missing.push({ path: 'sources', text: 'Investigative research works best with at least one link or document in the source tray.' });

  const sty = v('visual.style'); const mot = v('visual.motion_intensity'); const cx = v('visual.animation_complexity');
  const styleText = sty.value.preset === 'custom' ? (sty.value.custom || 'custom') : sty.value.preset === 'auto' ? '' : label('visual.style', sty.value.preset);
  const look = [];
  if (styleText) look.push(`${lower(styleText)} style`);
  if (mot.origin !== 'default') look.push(`${lower(label('visual.motion_intensity', mot.value))} motion`);
  if (cx.origin !== 'default') look.push(`${lower(label('visual.animation_complexity', cx.value))} animation`);
  const brand = v('visual.brand').value;
  if (brand.colors.length || brand.preset || brand.heading_font || brand.logo_source) look.push('your brand kit');
  if (look.length) say('visual', 'visual.style', `Look: ${list(look)}, drawn in code.`, originOf([sty, mot, cx]));
  else say('visual', 'visual.style', 'Look: the studio designs it from the topic, drawn in code.', 'default');
  const cap = v('visual.captions');
  if (cap.origin !== 'default') say('visual', 'visual.captions', cap.value.mode === 'off' ? 'Captions off.' : `Captions ${cap.value.mode === 'on' ? 'on' : 'automatic'}, ${lower(cap.value.style)} style.`, cap.origin);

  const dl = brief.decide_later || {};
  const audio = [];
  for (const [k, name] of [['voice', 'voice'], ['music', 'music'], ['sound_design', 'sound design'], ['pauses', 'pauses']]) {
    const x = v(`voice.${k}`);
    if (dl[k] === true || x.origin === 'default') continue;
    const parts = Object.entries(x.value).filter(([key, val]) => val && val !== 'auto' && JSON.stringify(val) !== JSON.stringify(FIELD[`voice.${k}`].default[key])).map(([key, val]) => `${key.replace(/_/g, ' ')} ${val}`);
    if (parts.length) audio.push(`${name} (${parts.join(', ')})`);
  }
  if (audio.length) say('voice', 'voice.voice', `Audio preferences: ${list(audio)}. Refine them later in Voice & Music.`, 'specified');
  else say('voice', 'voice.voice', 'Voice and music: decided later in Voice & Music (an ElevenLabs voice is picked there; nothing paid starts from this form).', 'default');

  const dest = v('delivery.destination'); const asp = v('delivery.aspects'); const dur = v('delivery.duration'); const out = v('delivery.output');
  const manual = dur.value.mode === 'manual' && dur.value.seconds;
  say('delivery', 'delivery.destination', `For ${label('delivery.destination', dest.value)}, shaped ${list(asp.value)}${asp.value.length > 1 ? ` (${asp.value.length} files)` : ''}, ${manual ? mmss(dur.value.seconds) : 'length chosen from the topic'}.`, originOf([dest, asp, dur]));
  if (out.origin !== 'default') say('delivery', 'delivery.output', `Output ${label('delivery.output', out.value.resolution)} at ${out.value.fps} fps, ${out.value.quality} quality.`, out.origin);

  const cps = v('workflow.checkpoints');
  const names = CHECKPOINTS.filter((c) => cps.value.includes(c.value)).map((c) => lower(c.label));
  say('workflow', 'workflow.checkpoints', `You approve: ${list(names) || 'nothing before the final'}. "Create script" starts the script only, not the full video.`, cps.origin);

  const conflict = (id, paths, text, resolutions = []) => conflicts.push({ id, paths, text, resolutions });
  const secs = manual ? Number(dur.value.seconds) : null;
  if (secs) {
    const cap_w = Math.round(secs * WPS);
    const w = words(idea);
    if (w > cap_w * 1.5 && w > 60) conflict('long-text-short-video', ['idea', 'delivery.duration'], `Your idea text is about ${w} words, but ${mmss(secs)} of narration holds about ${cap_w}.`, [
      { text: `Make the video about ${mmss(Math.ceil(w / WPS))} long`, set: { 'delivery.duration': { mode: 'manual', seconds: Math.ceil(w / WPS) } } },
      { text: 'Let the studio choose the length', set: { 'delivery.duration': { mode: 'auto', seconds: null } } }]);
    if (secs <= 30 && rd.value === 'investigative') conflict('short-investigative', ['delivery.duration', 'story.research_depth'], `Investigative research does not fit in ${mmss(secs)}.`, [
      { text: 'Use standard research', set: { 'story.research_depth': 'standard' } }, { text: 'Make it 2 min', set: { 'delivery.duration': { mode: 'manual', seconds: 120 } } }]);
    if (dest.value === 'reels' && secs > 90) conflict('reels-length', ['delivery.destination', 'delivery.duration'], `Reels run up to 90 s; this is ${mmss(secs)}.`, [{ text: 'Make it 90 s', set: { 'delivery.duration': { mode: 'manual', seconds: 90 } } }, { text: 'Send it to YouTube instead', set: { 'delivery.destination': 'youtube' } }]);
    if (dest.value === 'tiktok' && secs > 600) conflict('tiktok-length', ['delivery.destination', 'delivery.duration'], `TikTok videos run up to 10 min; this is ${mmss(secs)}.`, [{ text: 'Make it 10 min', set: { 'delivery.duration': { mode: 'manual', seconds: 600 } } }]);
  }
  if (['tiktok', 'reels'].includes(dest.value) && !asp.value.includes('9:16')) conflict('vertical-destination', ['delivery.destination', 'delivery.aspects'], `${label('delivery.destination', dest.value)} is a vertical platform, but 9:16 is not one of the shapes.`, [{ text: 'Add 9:16', set: { 'delivery.aspects': [...asp.value, '9:16'] } }, { text: 'Make 9:16 the only shape', set: { 'delivery.aspects': ['9:16'] } }]);
  if (dest.value === 'presentation' && asp.value[0] === '9:16') conflict('presentation-vertical', ['delivery.destination', 'delivery.aspects'], 'A presentation is usually widescreen, but the first shape is 9:16.', [{ text: 'Use 16:9 first', set: { 'delivery.aspects': ['16:9'] } }]);
  if (ver.value === 'strict' && rd.value === 'quick') conflict('strict-quick', ['story.verification', 'story.research_depth'], 'Strict fact checking needs more than quick research.', [{ text: 'Use standard research', set: { 'story.research_depth': 'standard' } }, { text: 'Use light fact checking', set: { 'story.verification': 'light' } }]);
  const must = v('story.must_include').value; const no = [...v('story.excluded_claims').value, ...v('story.forbidden_topics').value];
  for (const m of must) for (const n of no) if (lower(m).includes(lower(n)) || lower(n).includes(lower(m))) conflict(`must-vs-banned-${conflicts.length}`, ['story.must_include', 'story.excluded_claims'], `"${m}" is a must-include, but "${n}" is excluded.`, []);
  const as = v('visual.asset_strategy').value;
  const hasMedia = sources.some((s) => ['image', 'video'].includes(s.kind));
  if (as.source === 'uploaded' && !hasMedia && !brand.logo_source) conflict('uploaded-only-nothing', ['visual.asset_strategy', 'sources'], 'Assets are set to uploaded only, but no image or video is in the tray.', [{ text: 'Use both uploaded and drawn visuals', set: { 'visual.asset_strategy': { source: 'both' } } }]);
  if (as.source !== 'drawn' && hasMedia && !as.rights_confirmed) missing.push({ path: 'visual.asset_strategy', text: 'Confirm you have the rights to the uploaded images or videos.' });
  if (brand.logo_source && !sources.some((s) => s.id === brand.logo_source)) conflict('logo-missing', ['visual.brand', 'sources'], `The logo (${brand.logo_source}) is not in the source tray.`, [{ text: 'Clear the logo', set: { 'visual.brand': { logo_source: '' } } }]);
  if (['persuade', 'sell'].includes(obj.value) && !cta.value) missing.push({ path: 'story.cta', text: `A ${obj.value} video needs a call to action: what should the viewer do next?` });
  if (failed) missing.push({ path: 'sources', text: `${failed} source${failed > 1 ? 's' : ''} could not be read. Remove or replace ${failed > 1 ? 'them' : 'it'}.` });
  for (const e of errors) conflict(`invalid-${e.path}`, [e.path], e.message, []);

  const customized = Object.fromEntries(SECTIONS.map((s) => [s.id, Object.keys(brief[s.id] || {}).length]));
  const estimate = {
    deliverables: { count: asp.value.length, shapes: asp.value },
    ...(secs ? { seconds: secs, speaking_words_about: Math.round(secs * WPS * 0.9), scenes_about: Math.max(1, Math.round(secs / 8)) } : { seconds: null, note: 'The studio picks the length the topic needs.' }),
  };
  return { ready: Boolean(idea) && !errors.length, sentences: S, missing, conflicts, customized, sources: { total, ready, failed, reading }, estimate };
}

export const shownValue = (val) => (Array.isArray(val) ? val.join(', ') : typeof val === 'object' && val ? Object.entries(val).filter(([, x]) => x !== '' && x !== null && !(Array.isArray(x) && !x.length)).map(([a, x]) => `${a.replace(/_/g, ' ')}: ${Array.isArray(x) ? x.join(', ') : x}`).join('; ') : String(val));

// The brief as plain text for the AI (only what was specified; defaults and "decide later" left out). Used by briefBlock.
export function briefText(brief, sources = []) {
  const { brief: b } = normalizeBrief(brief);
  const lines = [];
  const dl = b.decide_later || {};
  for (const [sec, vals] of Object.entries(b)) {
    if (!SECTIONS.some((s) => s.id === sec)) continue;
    for (const [k, val] of Object.entries(vals)) {
      if (sec === 'voice' && dl[k]) continue;
      const f = FIELD[`${sec}.${k}`];
      const shown = shownValue(val);
      if (shown) lines.push(`- ${f.label}: ${shown}${b.meta?.suggested?.includes(f.id) ? ' (accepted from an AI suggestion)' : ''}`);
    }
  }
  for (const s of sources) lines.push(`- Source ${s.id} (${s.kind}, ${s.status}): ${s.label}${s.url ? ` <${s.url}>` : ''}${s.text_file ? ` (full text: ${s.text_file})` : ''}${s.excerpt ? `\n  Excerpt: ${s.excerpt.slice(0, 600)}` : ''}`);
  return lines.join('\n');
}
