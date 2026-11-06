// SKILLS.md: what a project's sessions have, written from exactly what was installed; the web reads only the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { prepareWorkdir, writeTorch } from '../src/torch.mjs';
import { projectSkills, readSkillText } from '../src/skills.mjs';

test('skills file: written before a session from what was installed; listed in CLAUDE.md; read from the record only', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Skills', answers: { topic: 'x' } });
  startProject(root, p.id);
  prepareWorkdir(root, p.id);
  writeTorch(root, p.id, { backend: 'demo', reason: 'test' });
  const pp = projectPaths(root, p.id);
  const md = readFileSync(join(pp.work, 'SKILLS.md'), 'utf8');
  const installed = readdirSync(join(pp.work, '.claude', 'skills')).sort();
  const list = projectSkills(root, p.id);
  assert.deepEqual(list.items.filter((x) => x.kind === 'skill').map((x) => x.name), installed, 'the list is what was installed');
  for (const s of ['motion-design', 'remotion-motion', 'transition-board', 'voiceover', 'music', 'final-pass']) {
    assert.ok(installed.includes(s), s);
    assert.match(md, new RegExp(`\\| ${s} \\| pipeline \\(pinned\\) \\| ready \\|`));
  }
  assert.match(md, /## Tools[\s\S]*\| Render queue \| mfx render \| ready \|/);
  // A tool that isn't set up says so, with its fix (Blender may or may not be on the test machine).
  assert.match(md, /\| Blender \| \$MFX_BLENDER \| (ready \||not set up \|[^\n]*Fix: `mortiflix setup 3d`)/);
  assert.match(readFileSync(join(pp.work, 'CLAUDE.md'), 'utf8'), /\*\*Skills and tools:\*\* `SKILLS.md`/);
  assert.ok(existsSync(join(pp.state, 'skills', 'SKILLS.md')));
  // The web never reads the working folder: a session rewriting its SKILL.md doesn't change what the owner reads.
  writeFileSync(join(pp.work, '.claude', 'skills', 'music', 'SKILL.md'), 'tampered');
  assert.doesNotMatch(readSkillText(root, p.id, 'music'), /^tampered$/);
  assert.equal(readSkillText(root, p.id, '../secret'), null);
});

test('browser: the studio browser is on this computer only; sessions get its address; the start command is terminal-only', async (t) => {
  const setup = await import('../src/setup.mjs');
  const root = tempStudio(t);
  assert.deepEqual(setup.browserConfig({}), { cdpUrl: null, start: null });
  assert.throws(() => setup.saveBrowser(root, { cdpUrl: 'http://example.com:9333' }), /on this computer/);
  assert.deepEqual(setup.saveBrowser(root, { cdpUrl: 'http://127.0.0.1:9333/', start: 'studio-browser' }), { cdpUrl: 'http://127.0.0.1:9333', start: 'studio-browser' });
  assert.equal(setup.sessionToolsEnv(root).BU_CDP_URL, 'http://127.0.0.1:9333');
  const r = await setup.browserCheck(root, { timeoutMs: 300 });
  assert.equal(r.configured, true);
});
