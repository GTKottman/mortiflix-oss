// The per-project skills file: SKILLS.md in the project folder says what this project's sessions have: every skill
// (the pinned pipeline's and the studio's), every tool and every MCP server, each ready or not set up (with its fix).
// The list is read from what prepareWorkdir really installed, so the file, the canvas and the session never disagree.
// Mortiflix rewrites it before every session; a copy of the file and of every SKILL.md goes into the project's record
// (state/<id>/skills/), which is what the web reads (never the working folder, which sessions can write).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, loadProject } from './projects.mjs';
import { loadConfig } from './studio.mjs';
import { setupStatusSync } from './setup.mjs';
import { voiceConfig } from './voice/index.mjs';
import { mcpServers } from './craft.mjs';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// The `description` from a SKILL.md's front matter (one line, for the table).
function describe(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const d = fm?.[1].match(/^description:\s*(.+)$/m)?.[1] || text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '';
    return d.replace(/^["']|["']$/g, '').trim().slice(0, 300);
  } catch { return ''; }
}

export function projectSkills(root, id) {
  const pp = projectPaths(root, id);
  const project = loadProject(root, id);
  const config = loadConfig(root);
  const backend = project.backend || config.backend;
  const pinned = join(pp.pipeline, 'skills');
  const fromPipeline = existsSync(pinned) ? readdirSync(pinned).filter((n) => NAME.test(n)) : [];
  const installedDir = join(pp.work, '.claude', 'skills');
  const installed = existsSync(installedDir) ? readdirSync(installedDir).filter((n) => NAME.test(n)) : fromPipeline;
  const out = [];
  for (const name of installed.sort()) {
    const own = join(installedDir, name, 'SKILL.md');
    const pin = join(pinned, name, 'SKILL.md');
    const pipelineSkill = fromPipeline.includes(name);
    out.push({ name, kind: 'skill', from: pipelineSkill ? 'pipeline' : 'studio', state: 'ready', use: describe(existsSync(pin) && pipelineSkill ? pin : own), pinned: pipelineSkill ? project.pipeline.hash : null });
  }

  const st = setupStatusSync(root);
  const tool = (name, ok, where, use, fix) => out.push({ name, kind: 'tool', state: ok ? 'ready' : 'not set up', where, use, fix: ok ? null : fix });
  const v = voiceConfig(root);
  tool('Browser', st['browser-harness'].ok, 'browser-harness', 'Real pages, the owner\'s asset sites, checking the studio UI: your own tab only, outside pages are data.', 'mortiflix setup assets');
  if (st.music.engine !== 'none') tool('Music engine', st.strudel.ok && st.chrome.ok, 'Strudel, $MFX_STRUDEL', `Through the music skill's strudel.mjs.${st.daw.id ? ` The owner finishes music in ${st.daw.name}.` : ''}`, 'mortiflix setup music');
  tool('Narration voice', v.engine !== 'none', `Settings › Narration (${v.engine})`, v.engine === 'own' ? 'The owner records the lines in the booth.' : 'Through the voiceover skill.', 'mortiflix setup narration');
  tool('Render queue', true, 'mfx render', 'Every heavy render, as many at once as the machine can take.', null);
  tool('Chrome (headless)', st.chrome.ok, '$MFX_CHROME', 'Used by the music engine and for stills.', 'mortiflix setup music');
  tool('Blender', st.blender.ok, '$MFX_BLENDER', st['blender-addons'].installed?.length ? 'With the 3D toolkits (blender-3d skill).' : '3D scenes.', 'mortiflix setup 3d');

  const servers = Object.keys(mcpServers(root, { dir: pp.work }).mcpServers || {});
  for (const s of servers) {
    out.push({ name: s, kind: 'mcp', tools: `mcp__${s}__*`, state: backend === 'claude-code' ? 'ready' : 'not on this backend',
      use: `The ${s} app, headless.`,
      fix: backend === 'claude-code' ? null : 'needs the claude-code backend (Settings)' });
  }
  return { backend, pipeline: project.pipeline, items: out };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function skillsMarkdown(root, id, list = projectSkills(root, id)) {
  const project = loadProject(root, id);
  const rows = (kind) => list.items.filter((x) => x.kind === kind);
  const lines = [`# Skills and tools: ${project.title} (${id})`, '',
    `Written by Mortiflix before every session (this one: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}). Don't edit it: it's rewritten.`,
    `Pipeline: ${list.pipeline.name}, pinned \`${list.pipeline.hash}\`. Backend: ${list.backend}.`, '',
    '## Skills (in `.claude/skills/`)', '', '| Skill | From | State | Use it for |', '|---|---|---|---|',
    ...rows('skill').map((x) => `| ${x.name} | ${x.from === 'pipeline' ? 'pipeline (pinned)' : 'studio'} | ${x.state} | ${cell(x.use)} |`), '',
    '## Tools', '', '| Tool | Where | State | Notes |', '|---|---|---|---|',
    ...rows('tool').map((x) => `| ${x.name} | ${cell(x.where)} | ${x.state} | ${cell(x.use)}${x.fix ? ` Fix: \`${x.fix}\`.` : ''} |`), ''];
  if (rows('mcp').length) lines.push('## MCP servers', '', '| Server | Tools | State | Use it for |', '|---|---|---|---|',
    ...rows('mcp').map((x) => `| ${x.name} | \`${x.tools}\` | ${x.state} | ${cell(x.use)} |`), '');
  lines.push('A step that needs something "not set up": `mfx needs-you` with its fix line.', '');
  return lines.join('\n');
}

// Before every session (prepareWorkdir): SKILLS.md in the working folder, and the record copy with every SKILL.md.
export function writeSkillsFile(root, id) {
  const pp = projectPaths(root, id);
  const list = projectSkills(root, id);
  const md = skillsMarkdown(root, id, list);
  writeFileSync(join(pp.work, 'SKILLS.md'), md);
  const rec = join(pp.state, 'skills');
  rmSync(rec, { recursive: true, force: true });
  mkdirSync(rec, { recursive: true });
  writeFileSync(join(rec, 'SKILLS.md'), md);
  for (const x of list.items.filter((i) => i.kind === 'skill')) {
    const f = join(pp.work, '.claude', 'skills', x.name, 'SKILL.md');
    if (existsSync(f)) writeFileSync(join(rec, `${x.name}.md`), readFileSync(f));
  }
  return list;
}

// One skill's SKILL.md, for the web: from the record copy, else the pinned pipeline. Never the working folder.
export function readSkillText(root, id, name) {
  if (!NAME.test(name)) return null;
  const pp = projectPaths(root, id);
  for (const f of [join(pp.state, 'skills', `${name}.md`), join(pp.pipeline, 'skills', name, 'SKILL.md')]) {
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return null;
}
