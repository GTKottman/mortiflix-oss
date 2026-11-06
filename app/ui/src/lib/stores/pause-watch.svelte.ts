import { untrack } from 'svelte';
import { pauseView, runPause, runnerTakenText, RUNNER_TAKEN_ID, type PauseDeps } from '../pause';
import { DEMO_NEED, stageDemo } from '../stage-demo';
import type { Router } from '../router.svelte';
import { routeFor } from '../../routes/routes';
import type { BridgeState, ServiceClient } from '../service/client';
import type { Problems } from './problems.svelte';
import type { Project } from './project.svelte';

// Puts a paused project (and a studio another runner owns) in the Fix it strip. Same id as the old app: 'needs-you'.
export const NEEDS_YOU_ID = 'needs-you';
const OPEN_SETTINGS_DELAY_MS = 150;

interface Hello {
  runner?: boolean;
  runner_note?: string | null;
}

/** Call while a component is being set up: it starts its own effects. */
export function watchPause(
  client: ServiceClient,
  router: Router,
  problems: Problems,
  project: Project,
): void {
  let runnerNote = $state<string | null>(null);

  $effect(() =>
    client.on<BridgeState>('bridge.state', (state) => {
      const hello = state.hello as Hello | undefined;
      runnerNote = state.up && hello?.runner === false ? runnerTakenText(hello.runner_note) : null;
    }),
  );

  $effect(() => {
    const text = runnerNote;
    untrack(() =>
      text ? problems.raise({ id: RUNNER_TAKEN_ID, text, kind: 'warn' }) : problems.clear(RUNNER_TAKEN_ID),
    );
  });

  $effect(() => {
    const route = routeFor(router.path);
    const here = route.kind === 'stage' ? route.stage : null;
    const id = project.id;
    const demo = stageDemo() === 'cost';
    const need = demo ? DEMO_NEED : project.needsYou;
    const view = here ? pauseView(demo ? 'paused' : project.state, need, here) : null;
    untrack(() => {
      if (!view || !id) {
        problems.clear(NEEDS_YOU_ID);
        return;
      }
      const action = view.action;
      const second = view.second;
      const deps: PauseDeps = {
        call: (type, params) => client.call(type, params),
        project: id,
        openVoiceSettings: () => setTimeout(() => router.go('/settings?focus=voice'), OPEN_SETTINGS_DELAY_MS),
        openStage: (stage) => router.go(`/${stage}`),
        need,
      };
      problems.raise({
        id: NEEDS_YOU_ID,
        text: view.text,
        kind: view.kind,
        fix: action && { label: action.label, run: () => runPause(action.run, deps) },
        also: second && { label: second.label, run: () => runPause(second.run, deps) },
      });
    });
  });

  // Cleared only when the app goes away. A teardown on the effects above would also run before every re-run
  // (svelte.dev/docs/svelte/$effect), clearing and re-raising the entry: its place in the order and a failed Fix it's
  // message were lost each time. Those effects clear the entry themselves when it no longer applies.
  $effect(() => () => {
    problems.clear(RUNNER_TAKEN_ID);
    problems.clear(NEEDS_YOU_ID);
  });
}
