import { toolReady, type SetupStatus } from '../../lib/setup/status';
import type { ComponentStatus } from './types';

// The read-only list of "Other connections": what else Mortiflix found on this computer.

const PLAIN: Record<string, string> = {
  kinetograph: 'Motion renderer',
  blender: '3D shots (Blender)',
  'blender-addons': '3D toolkits',
  chrome: 'Music rendering',
  strudel: 'Music writing',
  transitions: 'Transitions',
  uv: 'Helper tools',
};

// Local generation is removed from the product: never listed.
const REMOVED = /qwen|comfy|moss|tts/i;

const TOOL_NAMES: readonly (readonly [string, string])[] = [
  ['ffmpeg', 'Video tools'],
  ['node', 'Node'],
];

export interface OtherRow {
  name: string;
  ready: boolean;
  /** Not ready, and Mortiflix needs it. */
  needsFix: boolean;
}

export function otherRows(
  components: readonly ComponentStatus[] | null,
  status: SetupStatus | null,
): OtherRow[] {
  const rows: OtherRow[] = (components ?? [])
    .filter((c) => !REMOVED.test(`${c.id} ${c.name}`))
    .map((c) => ({
      name: PLAIN[c.id] ?? c.name,
      ready: !!c.installed,
      needsFix: !c.installed && c.default !== false,
    }));
  for (const [id, name] of TOOL_NAMES) {
    const tool = status?.tools?.[id];
    if (tool == null || rows.some((row) => row.name === name)) continue;
    const ready = toolReady(tool);
    rows.push({ name, ready, needsFix: !ready });
  }
  return rows;
}

/** The words a row shows for its state (OtherSection.svelte renders these). */
export const ROW_WORDS = { ready: 'ready', needsFix: 'needs a fix', notInstalled: 'not installed' } as const;
export const rowWords = (row: OtherRow): string =>
  row.ready ? ROW_WORDS.ready : row.needsFix ? ROW_WORDS.needsFix : ROW_WORDS.notInstalled;
