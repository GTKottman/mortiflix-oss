import type { Problem } from '../../lib/stores/problems.svelte';
import { claudeConnected, loginCommand, type SetupStatus } from '../../lib/setup/status';

// Connections show only when something is wrong, as one problem in the Fix it strip.

export const CLAUDE_PROBLEM = 'claude';
export const VOICE_KEY_PROBLEM = 'eleven-key';

export interface SetupActions {
  /** Asks again, bypassing the service's cache. */
  recheck: () => Promise<SetupStatus>;
  openVoiceSettings: () => void;
}

export function setupProblems(status: SetupStatus | null, actions: SetupActions): Problem[] {
  if (!status) return [];
  const problems: Problem[] = [];
  const claude = status.claude ?? {};
  if (!claudeConnected(claude)) {
    problems.push({
      id: CLAUDE_PROBLEM,
      kind: 'bad',
      text: claude.found
        ? `Claude Code is not signed in, so Mortiflix can't write. Run ${loginCommand(claude)} in a terminal.`
        : "Claude Code was not found, so Mortiflix can't write. Install it, then check again.",
      fix: {
        label: 'Check again',
        run: async () => {
          const again = await actions.recheck();
          if (!claudeConnected(again.claude)) throw new Error('it is still not signed in');
          return 'Claude Code is connected.';
        },
      },
    });
  }
  const voice = status.keys?.find((key) => key.id === 'elevenlabs');
  if (voice && !voice.set) {
    problems.push({
      id: VOICE_KEY_PROBLEM,
      kind: 'warn',
      text: 'ElevenLabs has no key yet. Scripts, looks and stills still work. Voice waits for the key.',
      fix: {
        label: 'Add key',
        run: async () => {
          actions.openVoiceSettings();
          return 'Opening Settings…';
        },
      },
    });
  }
  return problems;
}
