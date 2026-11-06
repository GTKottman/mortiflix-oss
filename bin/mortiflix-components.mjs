#!/usr/bin/env node
// The installers' components step (Mortiflix Studio packaging): the tools Mortiflix uses, each with what it's for
// and its size, installed with setup.mjs's own installers into the studio (MORTIFLIX_STUDIO, else ~/Mortiflix).
//
//   mortiflix-components.mjs list [--json]          what can be installed, the defaults, what's here
//   mortiflix-components.mjs install <which>        default | all | none | blender,chrome,... (progress on stdout)
//   mortiflix-components.mjs choose                 ask for each one (a terminal), then install the chosen ones
//
// A component that fails or is skipped never fails the install: it exits 0 and setup can install it later.
// Exit 2 only for a wrong command line.
import { createInterface } from 'node:readline/promises';
import { studioRoot, ensureStudio } from '../src/studio.mjs';
import { COMPONENTS, componentsStatus, installComponents, parseComponents } from '../src/components.mjs';

const [cmd = 'list', ...rest] = process.argv.slice(2);
const json = rest.includes('--json');
const root = studioRoot();
const usage = () => { process.stderr.write('usage: mortiflix-components.mjs list [--json] | install <default|all|none|id,id,...> | choose\n'); process.exit(2); };

function show(list) {
  for (const c of list) {
    const mark = c.installed ? 'installed' : c.default ? 'on' : 'off';
    console.log(`  [${mark}] ${c.id.padEnd(15)} ${c.name} (${c.size}): ${c.for}${c.needs ? `. Needs: ${c.needs}` : ''}`);
  }
}

async function install(ids) {
  if (!ids.length) { console.log('No components chosen. Mortiflix setup can install them later.'); return; }
  ensureStudio(root);
  console.log(`Installing into ${root}: ${ids.join(', ')}`);
  const results = await installComponents(root, ids, {
    onEvent: (e) => {
      if (e.phase === 'start') console.log(`\n==> ${e.name} (${e.size})`);
      else if (e.phase === 'line') console.log(`    ${e.line}`);
      else if (e.phase === 'done') console.log(`  ok ${e.id}: ${e.detail} (${e.seconds} s)`);
      else console.log(`  !! ${e.id}: ${e.error || e.problems || e.detail} (setup can try again later)`);
    },
  });
  console.log('\nComponents:');
  for (const r of results) console.log(`  ${r.ok ? 'ok' : '!!'} ${r.id}: ${r.ok ? r.detail : r.error || r.problems || r.detail}`);
}

try {
  if (cmd === 'list') {
    const list = await componentsStatus(root);
    if (json) console.log(JSON.stringify({ studio: root, components: list }));
    else { console.log(`Mortiflix components (studio: ${root}):`); show(list); }
  } else if (cmd === 'install') {
    let ids;
    try { ids = parseComponents(rest.filter((a) => !a.startsWith('--')).join(',') || 'default'); } catch (e) { process.stderr.write(`${e.message}\n`); usage(); }
    await install(ids);
  } else if (cmd === 'choose') {
    const list = await componentsStatus(root);
    console.log('Mortiflix uses these tools. Each downloads now; skip any and install it later in Mortiflix setup.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ids = [];
    for (const c of list) {
      if (c.installed) { console.log(`  ${c.name}: already here (${c.detail})`); continue; }
      const q = `  ${c.name} (${c.size}): ${c.for}${c.needs ? `. Needs: ${c.needs}` : ''}. Install? ${c.default ? '[Y/n]' : '[y/N]'} `;
      const a = (await rl.question(q)).trim().toLowerCase();
      if (a ? a.startsWith('y') : c.default) ids.push(c.id);
    }
    rl.close();
    await install(COMPONENTS.map((c) => c.id).filter((id) => ids.includes(id)));
  } else usage();
} catch (e) {
  // Never fail the install over a component.
  console.log(`Components: ${e.message} (Mortiflix setup can install them later)`);
}
