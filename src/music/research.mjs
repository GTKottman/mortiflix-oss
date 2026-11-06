// A genre researched once and kept (owner, 2026-10-23: "cache the information about the genre so that if the user
// wants to use that genre again, we don't have to relook everything up"). The first video in a genre runs one research
// call with web search (Mini Music's research prompt), checks the profile (src/music/genre.mjs) and saves it as a scoring
// pack: packs/scoring/<slug>/ pack.json + profile.json + profile.md. Every later video finds the pack and never
// researches again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAs } from '../models.mjs';
import { REPO } from '../studio.mjs';
import { PROFILE_SCHEMA, profileProblems, profileMarkdown, genreSlug } from './genre.mjs';
import { listAllPacks } from '../svc/packs.mjs';

const MELODY = join(REPO, 'pipelines', '_shared', 'skills', 'music', 'craft', 'melody-craft.md');
const MAX_TRIES = 3;

const SYSTEM = `You are a music researcher and producer. Research one music genre on the web and write its profile: what it is, what it
means, how its instruments line up, and above all the specific elements that make its hooks and beats unforgettable, written so a composer
can put them straight into notes.

How to work:
- Use WebSearch to find good sources (encyclopedias, music-theory and production articles, interviews, genre guides, academic or
  journalistic writing), then READ them with WebFetch. Read at least 5 different pages; read more for a broad genre.
- Prefer concrete, checkable facts: tempo ranges, drum patterns, typical chord moves, instruments and how they are played. Where sources
  disagree, say so in the text.
- Write the beat as step grids (x hit, X accent, g ghost, . rest); a 16-step grid is one bar of 16th notes in 4/4.
- "unforgettable": 5-8 elements, at least one for the hook and one for the beat. Each "how" must be specific enough to write in notes
  (rhythm, scale degrees or intervals, placement in the bar, which instrument).
- Cite in "sources" only pages you actually fetched in this research.

Return ONLY one \`\`\`json block shaped like this:
${PROFILE_SCHEMA}`;

const jsonFrom = (text) => {
  const m = String(text || '').match(/```json\s*([\s\S]*?)```/) || String(text || '').match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('the answer has no JSON block');
  return JSON.parse(m[1]);
};

// The scoring pack for a genre: the cached one, else researched now and cached. Returns the pack (packs.mjs shape).
export async function genrePack({ root, genre, about = '', run, runArgs = {}, config = {}, onActivity = () => {} }) {
  const slug = genreSlug(genre);
  if (!slug) throw new Error('no genre named');
  const cached = listAllPacks(root, 'scoring').find((p) => p.id === slug && p.profile);
  if (cached) return cached;
  const dir = join(root, 'packs', 'scoring', slug);
  const work = join(root, 'run', 'research', slug);
  mkdirSync(work, { recursive: true });
  let profile = null; let problems = [];
  for (let k = 0; k < MAX_TRIES; k++) {
    onActivity({ kind: 'info', text: k ? `Fixing the ${genre} profile: ${problems.join(' ').slice(0, 300)}` : `Researching ${genre} on the web (once: every later video reuses it).` });
    const user = `Genre: ${genre}\n${about ? `What the producer means by it: ${about}\n` : ''}\nResearch it and return the profile.${profile ? `\n\nYour previous profile:\n${JSON.stringify(profile)}\n\nFix these problems and return the whole corrected JSON:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`;
    const prompt = `${SYSTEM}\n\n# MELODY CRAFT (describe the genre's hooks in these terms)\n\n${existsSync(MELODY) ? readFileSync(MELODY, 'utf8') : ''}\n\n${user}`;
    const r = await runAs(run, 'research', { ...runArgs, workdir: work, prompt, config: { ...config, claudeArgs: ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch WebFetch'] } });
    if (!r.ok) throw new Error(`the ${genre} research failed: ${String(r.error).slice(0, 300)}`);
    try { profile = jsonFrom(r.summary); } catch (e) { problems = [e.message]; continue; }
    problems = profileProblems(profile);
    if (!problems.length) break;
  }
  if (problems.length) throw new Error(`the ${genre} profile still has problems: ${problems.slice(0, 3).join(' ')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(join(dir, 'profile.md'), profileMarkdown(profile));
  writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
    format: 'mortiflix.pack', version: 1, kind: 'scoring', name: profile.name, description: String(profile.summary || '').slice(0, 600),
    author: 'Mortiflix studio (genre research, web sources in profile.json)', license: 'AGPL-3.0', source: 'local', tags: [slug, 'genre'],
    tempo: { bpm_min: profile.tempo.min, bpm_max: profile.tempo.max }, meters: profile.meters.filter((m) => ['4/4', '3/4'].includes(m)),
  }, null, 2)}\n`);
  onActivity({ kind: 'info', text: `The ${genre} profile is saved: no video researches it again.` });
  return listAllPacks(root, 'scoring').find((p) => p.id === slug);
}
