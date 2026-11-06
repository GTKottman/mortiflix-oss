import { untrack } from 'svelte';
import type { ServiceClient } from '../../lib/service/client';
import type { SetupStatus } from '../../lib/setup/status';
import type { Problems } from '../../lib/stores/problems.svelte';
import type { Router } from '../../lib/router.svelte';
import { CLAUDE_PROBLEM, setupProblems, VOICE_KEY_PROBLEM } from './setup-problems';

const OPEN_SETTINGS_DELAY_MS = 150;
const SETUP_CHECK_PROBLEM = 'setup-check';

/**
 * Keeps Home's setup answer and shows what is wrong with it in the Fix it strip. Call it while a component is
 * being set up: it starts its own effects. Asked once per visit; the service caches the answer.
 */
export function watchSetup(client: ServiceClient, router: Router, problems: Problems) {
  let status = $state<SetupStatus | null>(null);
  /** Why setup.status could not be read; empty = read (or still asking). */
  let checkError = $state('');

  const load = () =>
    void client.call<SetupStatus>('setup.status').then(
      (answer) => {
        status = answer;
        checkError = '';
      },
      (error: unknown) => {
        status = null;
        checkError = error instanceof Error ? error.message : 'unknown error';
      },
    );

  const clearProblems = () => {
    problems.clear(CLAUDE_PROBLEM);
    problems.clear(VOICE_KEY_PROBLEM);
    problems.clear(SETUP_CHECK_PROBLEM);
  };

  $effect(() => {
    const current = status;
    const failed = checkError;
    untrack(() => {
      clearProblems();
      // The probe itself failed: the connections are unknown, which is not the same as fine.
      if (failed)
        problems.raise({
          id: SETUP_CHECK_PROBLEM,
          kind: 'warn',
          text: `Couldn't check the connections (Claude Code, ElevenLabs): ${failed}`,
          fix: {
            label: 'Check again',
            run: async () => {
              status = await client.call<SetupStatus>('setup.status', { refresh: true });
              checkError = '';
              return 'Checked.';
            },
          },
        });
      for (const problem of setupProblems(current, {
        recheck: async () => (status = await client.call<SetupStatus>('setup.status', { refresh: true })),
        openVoiceSettings: () => setTimeout(() => router.go('/settings?focus=voice'), OPEN_SETTINGS_DELAY_MS),
      }))
        problems.raise(problem);
    });
    return clearProblems;
  });

  return {
    /** Asks the service again. */
    load,
    get firstRun(): boolean {
      return !!status?.first_run;
    },
  };
}
