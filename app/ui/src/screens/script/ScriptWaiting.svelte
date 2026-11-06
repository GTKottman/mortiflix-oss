<!-- The Script screen before any scene exists: says what is really going on. A step waiting for the owner's OK
     (with OK and Fix), Mortiflix writing (with how long), or nothing running and the one action that starts it
     (Start, Resume, … from lib/pause.ts, the same calls as the Fix it strip). -->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import { statusFor, stageById } from '../../lib/stages';
  import type { StageStatus } from '../../lib/service/types';
  import { pauseView, runPause } from '../../lib/pause';
  import { elapsedText } from '../../lib/time';
  import { useProject, useRouter, useScreenBar, useService } from '../../lib/stores/context';
  import BriefReview from './BriefReview.svelte';
  import { useScript } from './script.svelte';
  import { BriefStore, versionKey } from './brief.svelte';
  import { stepWords, whatIsWaiting } from './brief';

  interface Props {
    /** The script file says Mortiflix is writing, whatever the steps say. */
    writing?: boolean;
    /** A fixture: nothing is asked of the service, only `writing` is shown. */
    fixture?: boolean;
  }

  let { writing = false, fixture = false }: Props = $props();

  interface WorkActive {
    project?: string | null;
    running?: boolean;
  }

  const TICK_MS = 1000;
  const POLL_MS = 10_000;
  const RELOAD_SCENES_MS = 3000;
  const OPEN_SETTINGS_DELAY_MS = 150;
  const client = useService();
  const project = useProject();
  const router = useRouter();
  const screenBar = useScreenBar();
  const brief = new BriefStore(client);

  let running = $state(false);
  let now = $state(Date.now());
  let starting = $state(false);
  let startError = $state('');

  const steps = $derived(statusFor(stageById('script'), project.statuses)?.steps ?? []);
  const waiting = $derived(whatIsWaiting(steps, running || writing));
  const inReview = $derived(waiting.kind === 'review' ? waiting.step : null);
  /**
   * The script itself waits for review, so scenes exist: they show as the scene list (with Fix whole script above),
   * never as one summary card. No scene read yet means the read is behind: read the script again.
   */
  const scriptInReview = $derived(inReview?.key === 'script');
  const reviewing = $derived(scriptInReview ? null : inReview);
  const script = useScript();
  $effect(() => {
    if (!scriptInReview || fixture) return;
    void script.load();
    const timer = setInterval(() => void script.load(), RELOAD_SCENES_MS);
    return () => clearInterval(timer);
  });
  /** The script file saying "writing" counts even when no step says so yet. */
  const shown = $derived(waiting.kind === 'idle' && writing ? 'writing' : waiting.kind);
  const next = $derived(waiting.kind === 'idle' ? waiting.next : null);
  const writingWhat = $derived(waiting.kind === 'writing' ? stepWords(waiting.step) : 'the script');
  /** Why nothing runs (draft, paused) and the one action that starts it; null = queued, it starts by itself. */
  const stopped = $derived(pauseView(project.state, project.needsYou, 'script'));
  /** The idle view shows Start / Resume / …: it is the screen's one gradient button then. */
  const canStart = $derived(
    !fixture &&
      !reviewing &&
      shown === 'idle' &&
      steps.length > 0 &&
      next !== null &&
      Boolean(stopped?.action),
  );

  async function start() {
    const run = stopped?.action?.run;
    const id = project.id;
    if (!run || !id) return;
    starting = true;
    startError = '';
    try {
      await runPause(run, {
        call: (type, params) => client.call(type, params),
        project: id,
        openVoiceSettings: () => setTimeout(() => router.go('/settings?focus=voice'), OPEN_SETTINGS_DELAY_MS),
        openStage: (stage) => router.go(`/${stage}`),
        need: project.needsYou,
      });
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    } finally {
      starting = false;
    }
  }

  /** Reads whether a session runs and the steps' states again (a fallback for a missed push event). */
  async function refresh() {
    try {
      const [work, statuses] = await Promise.all([
        client.call<WorkActive>('work.get'),
        client.call<StageStatus[]>('stage.status'),
      ]);
      running = work.running === true;
      project.statuses = statuses;
    } catch {
      // the next event or tick reads again
    }
  }

  // Live: the service's pushes (a session starts or ends, a step moves, the project changes) and, while this view
  // waits, a read every 10 s in case a push was missed.
  $effect(() => {
    if (fixture) return;
    const id = project.id;
    const stops = [
      client.on<WorkActive>('work.active', (work) => {
        if (!work.project || work.project === id) running = work.running === true;
      }),
      client.on<{ id?: string }>('project.changed', (event) => event.id === id && void refresh()),
      client.on<{ up: boolean }>('bridge.state', (state) => state.up && void refresh()),
    ];
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(timer);
      stops.forEach((stop) => stop());
    };
  });

  // Read once per step version (the 10 s refresh hands in new step objects with the same version).
  const reviewKey = $derived(reviewing ? versionKey(reviewing) : '');
  $effect(() => {
    if (fixture) return;
    const key = reviewKey;
    const step = untrack(() => reviewing);
    if (key && step) void brief.load(step);
    else if (shown === 'writing') void brief.loadSession();
  });

  // OK on the brief (or Start when nothing runs) is the screen's one gradient button; it goes when this view does.
  $effect(() => {
    screenBar.ownPrimary = reviewing !== null || canStart;
    return () => (screenBar.ownPrimary = false);
  });

  $effect(() => {
    if (shown !== 'writing') return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), TICK_MS);
    return () => clearInterval(timer);
  });
</script>

{#snippet startButton()}
  <Button variant="primary" disabled={starting} onclick={start}
    >{starting ? 'Starting…' : (stopped?.action?.label ?? 'Start')}</Button
  >
{/snippet}

{#if scriptInReview}
  <LoadingState text="Loading the scenes…" />
{:else if reviewing}
  <!-- Keyed by version: a new version gets a fresh form (no open Fix, typed words or own answers from the old one). -->
  {#key reviewKey}<BriefReview {brief} step={reviewing} />{/key}
{:else if shown === 'writing'}
  <div role="status">
    <EmptyState
      title={`Mortiflix is writing ${writingWhat}…`}
      body={brief.sessionStart
        ? `Working for ${elapsedText(now - brief.sessionStart)}. The scenes appear here as they are written.`
        : 'The scenes appear here as they are written.'}
    />
  </div>
{:else if fixture}
  <EmptyState title="No scenes yet" body="Fixture: the script has no scenes." />
{:else if steps.length === 0}
  <LoadingState text="Checking what Mortiflix is doing…" />
{:else}
  <EmptyState
    title="Nothing is being written right now"
    body={!next
      ? 'There is no script for this video yet.'
      : stopped
        ? `${next.name} is next in line. ${stopped.text}`
        : `${next.name} is next in line. It is queued: Mortiflix starts it by itself.`}
    action={canStart ? startButton : undefined}
  />
  {#if startError}<p class="error" role="alert">Not started: {startError}</p>{/if}
{/if}

<style>
  .error {
    color: var(--warn);
  }
</style>
