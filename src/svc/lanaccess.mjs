// Home-network access (owner, 2026-11-03: "If it's a person setting it up on their own network, then [LAN access] should
// be a toggleable thing in the options. Of course, because it has access to Claude Code."). config.json `lan.enabled`,
// off by default. The bridge (mortiflix-app/bridge.mjs) reads it at start and again on every `settings.changed` event,
// then listens on 0.0.0.0 (home-network clients allowed, same checks as MFX_BRIDGE_LAN=1) or on 127.0.0.1 only.
// MFX_BRIDGE_LAN=1 in the environment (tools/serve-lan.sh) forces it on. Only the bridge decides who may change it:
// a `settings.set` carrying `lan` from a home-network client is refused there.
import { networkInterfaces } from 'node:os';
import { loadConfig, saveConfig, UserError } from '../studio.mjs';

// the addresses the bridge lets in (bridge.mjs LAN_ADDR): 192.168.x.x and 10.x.x.x
const HOME = /^(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/;

export const lanForced = () => process.env.MFX_BRIDGE_LAN === '1';

export function lanSettings(root, { interfaces = networkInterfaces } = {}) {
  let saved = false;
  try { saved = loadConfig(root).lan?.enabled === true; } catch { /* unreadable config: off */ }
  const enabled = saved || lanForced();
  // the bridge's own port (it starts this service with MFX_BRIDGE_PORT), else the studio's port setting
  let port = Number(process.env.MFX_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1) { try { port = loadConfig(root).port || 4646; } catch { port = 4646; } }
  const addresses = [];
  if (enabled) {
    for (const list of Object.values(interfaces() || {})) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal && HOME.test(a.address)) addresses.push({ kind: 'local', url: `http://${a.address}:${port}/app/` });
    }
  }
  return { enabled, saved, forced: lanForced(), addresses };
}

export function saveLan(root, enabled) {
  if (typeof enabled !== 'boolean') throw new UserError('lan.enabled is true or false');
  saveConfig(root, { lan: { enabled } });
  return lanSettings(root);
}
