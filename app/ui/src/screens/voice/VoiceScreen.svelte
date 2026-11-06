<!-- Voice & music (stage 2): hear the whole voice with the music under it, and fix what is off. A fixed time line on the
     left, a persistent inspector on the right (overview, a voice line, or a music cue), a transport above, the issues
     and the queue below. Nothing paid is made until it is queued and the cost is confirmed. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { clock } from '../../lib/time';
  import { useProblems, useProject, useService } from '../../lib/stores/context';
  import type { StageStatus } from '../../lib/service/types';
  import { untrack } from 'svelte';
  import AudioInspector from './AudioInspector.svelte';
  import IssueList from './IssueList.svelte';
  import QueueBar from './QueueBar.svelte';
  import ReviewBar from './ReviewBar.svelte';
  import { useVoiceSession } from './session.svelte';
  import { runKey } from './shortcuts';
  import Transport from './Transport.svelte';
  import VoiceTimeline from './VoiceTimeline.svelte';
  import { voiceStepState, voiceWaiting } from './waiting';
  import VoiceCostOk from './VoiceCostOk.svelte';
  import StepCostOk from '../../lib/components/StepCostOk.svelte';

  const project = useProject();
  const problems = useProblems();
  const session = useVoiceSession();
  const model = $derived(session.model);
  // No lines yet: say why, by the voice step's state, and give the one way on.
  const waiting = $derived(
    model?.view ? voiceWaiting(voiceStepState(project.statuses), model.lines.length) : null,
  );
  // While Mortiflix is making the voice, count the time since this screen first saw it making.
  let makingSince = $state<number | null>(null);
  let now = $state(Date.now());
  $effect(() => {
    if (!waiting?.making) {
      makingSince = null;
      return;
    }
    makingSince ??= Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const waitingBody = $derived(
    waiting && makingSince !== null
      ? `${waiting.body} ${clock(Math.max(0, (now - makingSince) / 1000), { truncate: true })} so far.`
      : waiting?.body,
  );
  // While there are no lines, keep the waiting words live: re-read the steps and the lines when the service says a
  // session or the project moved, and every 10 s in case a push was missed (2026-11-02: a stale "queued" for 4 min).
  const client = useService();
  const POLL_MS = 10_000;
  const isWaiting = $derived(Boolean(waiting));
  $effect(() => {
    if (!isWaiting) return;
    const current = untrack(() => model);
    const id = project.id;
    if (!current || !id) return;
    const refresh = () => {
      client
        .call<StageStatus[]>('stage.status')
        .then((statuses) => (project.statuses = statuses))
        .catch(() => undefined);
      current.reloadSoon();
    };
    const stops = [
      client.on<{ project?: string | null }>(
        'work.active',
        (work) => (!work.project || work.project === id) && refresh(),
      ),
      client.on<{ id?: string }>('project.changed', (event) => event.id === id && refresh()),
    ];
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(timer);
      stops.forEach((stop) => stop());
    };
  });
  const stripShowing = $derived(Boolean(problems.current ?? problems.done));
</script>

<svelte:window onkeydown={(event) => model && runKey(model, event)} />

{#if model?.loadError && !model.view}
  <ErrorState title="The voice could not load" detail={model.loadError} onretry={() => void model.load()} />
{:else if !project.id}
  {#if session.graceOver}
    <EmptyState title="No project open" body="Open one from Home.">
      {#snippet action()}<Button href={routeHref('/')}>Go to Home</Button>{/snippet}
    </EmptyState>
  {:else}
    <LoadingState text="Loading the lines…" />
  {/if}
{:else if model && model.view && waiting}
  <ScreenHead kicker="Stage 2 · Voice & music" title="Review your audio" />
  <EmptyState title={waiting.title} body={waitingBody}>
    {#snippet action()}
      {#if waiting.link}<Button href={routeHref(waiting.link.route)}>{waiting.link.label}</Button>{/if}
    {/snippet}
  </EmptyState>
  <VoiceCostOk />
  <StepCostOk step="music" />
{:else if model && model.view}
  <!-- a draw that throws shows what broke and Try again, never an endless "Loading the lines…" (Dir3, 2026-11-02) -->
  <svelte:boundary>
    <div class="voice" style:--strip={stripShowing ? 'var(--h-strip)' : '0px'}>
      <ScreenHead kicker="Stage 2 · Voice & music" title="Review your audio">
        {#snippet actions()}<ReviewBar {model} />{/snippet}
      </ScreenHead>
      <div class="body">
        <div class="left">
          <VoiceTimeline {model} />
          <IssueList {model} />
          <QueueBar {model} />
        </div>
        <AudioInspector {model} />
      </div>
      <!-- the play bar along the bottom of the page, like a music player (owner 2026-11-03) -->
      <Transport {model} />
    </div>
    {#snippet failed(error, reset)}
      <ErrorState
        title="The voice could not be shown"
        detail={error instanceof Error ? error.message : String(error)}
        onretry={() => void model?.load().then(reset)}
      />
    {/snippet}
  </svelte:boundary>
{:else}
  <LoadingState text="Loading the lines…" />
{/if}

<style>
  .voice {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: var(--s-12);
    height: calc(100dvh - var(--bar-h) - 2 * var(--work-pad-y) - var(--strip, 0px));
    min-height: 0;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--voice-inspector-w);
    gap: var(--s-24);
    min-height: 0;
  }
  /* tablet and phone: the inspector under the timeline, the page scrolls (owner's tablet 2026-11-03) */
  @media (max-width: 999px) {
    .voice {
      height: auto;
    }
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .left {
    display: grid;
    align-content: start;
    gap: var(--s-12);
    min-width: 0;
    min-height: 0;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ink-4) transparent;
  }
</style>
