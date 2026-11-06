// Child process for svc/setup-cache.mjs: runs the slow tool probes (spawnSync is fine here, nothing else waits on this
// process) and prints one JSON line. argv: <studio root> <heavy|components>.
import { setupStatusHeavy } from './setup.mjs';
import { componentsStatus } from '../components.mjs';

const [root, kind] = process.argv.slice(2);
const value = kind === 'components' ? await componentsStatus(root) : setupStatusHeavy(root);
process.stdout.write(`${JSON.stringify(value)}\n`);
process.exit(0);
