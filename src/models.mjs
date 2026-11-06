// The model for each kind of AI call (owner, 2026-10-20: "hand off to Haiku so that we're not wasting valuable opus
// tokens"). config.models maps a role to a model (an alias the claude CLI knows: opus, sonnet, haiku, or a full id);
// a role left out runs on the session's default. Roles:
//   brief    the brief and its research          script   the script
//   write    style frames, the board's choice, the animatic (the code that becomes the video)
//   review   a look at a render (contact sheet + checks), pass or fixed files
//   codefix  the video's code after a render or type error (the error and the code in, fixed files out)
//   fix      a plan the studio refused, sent back with only the errors (the music plan's fix rounds)
//   plan     the music plan                       respell  voice lines that failed the word check
//   chat     the chat's one-line JSON reply       name     beat names       lesson   a note turned into one lesson
//   options  a screen's option buttons (parts/95), cached per state token
// A cheaper model that gives no usable answer is never the end: the same call runs again on the default model.
export const ROLES = ['brief', 'script', 'write', 'review', 'codefix', 'fix', 'plan', 'respell', 'chat', 'name', 'lesson', 'options'];
// The studio's choice, tested 2026-10-20 on the Braille benchmark: Sonnet reviewed the animatic like Opus did (passed the
// approved one; caught two wrong numbers planted on screen, fixed them, passed the fix); Haiku fixed a refused music plan
// (both errors, nothing else changed) and re-spelled voice lines correctly. Writing, the script, the brief and the music
// plan stay on the default (Opus).
export const STUDIO_MODELS = { review: 'sonnet', codefix: 'sonnet', fix: 'haiku', respell: 'haiku', chat: 'haiku', name: 'haiku', lesson: 'haiku', options: 'haiku' };
// Thinking effort per role (claude --effort): the one-line jobs think least, a look at a render or a code fix a medium
// amount; writing, the script and the brief keep the default. config.efforts maps a role to a level (or null).
export const STUDIO_EFFORTS = { chat: 'low', name: 'low', lesson: 'low', options: 'low', review: 'medium', codefix: 'medium' };
export const effortFor = (config, role) => (config?.efforts ?? STUDIO_EFFORTS)[role] || null;
// A run that failed for a reason a bigger model can't fix (time, billing, login, stopped) is not run again.
export const NO_RETRY = /stopped|timed? ?out|took too long|billing|credit|quota|rate.?limit|overloaded|\b402\b|\b401\b|\/login|oauth|not logged in|unauthori[sz]ed|invalid api key/i;

const add = (a = {}, b = {}) => ({ input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0), output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0) });

export async function runAs(run, role, given) {
  const args = { ...given, role }; // the sent log (svc/sentlog.mjs) names the call by it
  const model = (args.config?.models ?? STUDIO_MODELS)[role];
  const effort = effortFor(args.config, role);
  if (!model) return effort ? run({ ...args, config: { ...args.config, effort } }) : run(args);
  const r = await run({ ...args, config: { ...args.config, model, ...(effort ? { effort } : {}) } });
  const wantsJson = (args.config?.claudeArgs || []).includes('--json-schema');
  if (r.ok && (!wantsJson || r.structured)) return { ...r, model };
  // only an answer that is missing or invalid goes to the default model: a timeout or a billing/login error would fail the same way
  if (!r.ok && NO_RETRY.test(String(r.error || ''))) return { ...r, model };
  const again = await run(args);
  return { ...again, usage: add(r.usage, again.usage), model: `default (after ${model} gave no answer)` };
}
