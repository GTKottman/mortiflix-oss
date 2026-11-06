<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import FrameCheckGrid from '../../lib/components/FrameCheckGrid.svelte';
  import HeldNote from '../../lib/components/HeldNote.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import ReviewChecks from '../../lib/components/ReviewChecks.svelte';
  import ReviewDecision from '../../lib/components/ReviewDecision.svelte';
  import ReviewNotes from '../../lib/components/ReviewNotes.svelte';
  import ReviewPicture from '../../lib/components/ReviewPicture.svelte';
  import ReviewSection from '../../lib/components/ReviewSection.svelte';
  import ReviewSplit from '../../lib/components/ReviewSplit.svelte';
  import ReviewTools from '../../lib/components/ReviewTools.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import StageMenu from '../../lib/components/StageMenu.svelte';
  import StagePanel from '../../lib/components/StagePanel.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { reviewKeys } from '../../lib/review/keys';
  import { useLiveReload } from '../../lib/review/live.svelte';
  import { activeItem, currentItem } from '../../lib/review/logic';
  import { clock } from '../../lib/time';
  import { plural } from '../../lib/words';
  import { ReviewSession } from '../../lib/review/session.svelte';
  import type {
    Lesson,
    ReviewService,
    StillGroup,
    StillsState,
    VideoNotesStatus,
  } from '../../lib/review/types';
  import { routeHref } from '../../lib/router.svelte';
  import { isNotBuiltYet } from '../../lib/service/client';
  import WaitingAction from '../../lib/components/WaitingAction.svelte';
  import { ActiveWork } from '../../lib/review/active-work.svelte';
  import { waitingWords } from '../../lib/review/waiting';
  import { stageById } from '../../lib/stages';
  import { useProblems, useProject, useScreenBar, useService } from '../../lib/stores/context';
  import SceneList from './SceneList.svelte';
  import SpokenLine from './SpokenLine.svelte';
  import {
    drawAllState,
    drawFailed as isDrawFailed,
    stillPlaceholder,
    stillWaitWords,
    drawingFinished,
    makingWords,
    REREAD_WHILE_WAITING_MS,
    sceneGroups,
    sceneOkCount,
    sceneStillRows,
    stillViews,
    stillsHead,
    type NodeNote,
  } from './stills';
  import PictureMenu from '../look/PictureMenu.svelte';

  interface Props {
    service: ReviewService;
    /** Set when the screen runs on the screenshot fixture: no options (they ask the real service). */
    fixture: string | null;
  }

  const { service, fixture }: Props = $props();

  const problems = useProblems();
  const bar = useScreenBar();
  const project = useProject();
  // svelte-ignore state_referenced_locally
  const work = new ActiveWork(useService(), project, stageById('stills'), Boolean(fixture));

  let data = $state<StillsState | null>(null);
  let notes = $state<NodeNote[]>([]);
  let lessons = $state<Lesson[]>([]);
  let videoNotes = $state<VideoNotesStatus | null>(null);
  let failure = $state<Error | null>(null);
  /** "Draw all" was pressed (demo studio): how many were to be drawn. */
  let making = $state<{ total: number } | null>(null);
  let latest = 0;
  /** When this screen first saw drawing running, and the clock that ticks while it runs. */
  let since = $state<number | null>(null);
  let now = $state(Date.now());

  // The wrapper renders this once per service, so the service never changes while the screen is open.
  // svelte-ignore state_referenced_locally
  const session = new ReviewSession({
    service,
    problems,
    calls: 'stills',
    param: 'line',
    problemId: 'stills-act',
    reload: load,
    afterOk: (item, result) => {
      if (result?.next !== 'group') return '';
      const scene = views.find((view) => view.item.id === item.id)?.group.index;
      const done = scene === undefined ? 'This scene is OK.' : `Scene ${scene} is OK.`;
      return `${done} Drawing the next scene with what you told us…`;
    },
  });

  const views = $derived(data ? stillViews(data, notes) : []);
  const items = $derived(views.map((view) => view.item));
  const item = $derived(currentItem(items, session.view));
  const view = $derived(views.find((entry) => entry.item.id === item?.id) ?? null);
  const active = $derived(activeItem(items));
  const activeView = $derived(views.find((entry) => entry.item.id === active?.id) ?? null);
  const groups = $derived(data ? sceneGroups(data) : []);
  const finished = $derived(Boolean(data?.lines.length) && data?.lines.every((line) => line.state === 'ok'));
  const head = $derived(data ? stillsHead(data, view) : { kicker: 'Stills', title: 'The stills', help: '' });
  const drawAll = $derived(data ? drawAllState(data, making) : ({ kind: 'none' } as const));
  const drawingInFile = $derived(
    Boolean(data?.lines.some((line) => line.state === 'drawing' || line.state === 'fix')),
  );
  /** Drawing counts (and the clock runs) only while the service really works on Stills now. */
  const drawingNow = $derived(drawingInFile && work.here);
  /** The file says drawing, but nothing runs: say what it waits for instead of a clock. */
  const waiting = $derived(
    drawingInFile && work.idle
      ? waitingWords(stageById('stills'), project.statuses, 'the stills', work.queued)
      : null,
  );
  const working = $derived(since === null ? '' : `Working for ${clock((now - since) / 1000)}.`);
  /** Per still, as Look and Motion: Failed (its own error, else the project's words) / Being made / Waiting. */
  const why = $derived(work.why('the stills'));
  const waitWords = $derived(view ? stillWaitWords(view, views, why) : null);
  const ownWords = $derived(
    Boolean(waitWords && waitWords !== 'Being made.' && waitWords !== 'Not made yet.'),
  );
  /** The render failed: state "check" with an error and no picture. The way out is to draw it again. */
  const drawFailed = $derived(view ? isDrawFailed(view) : false);
  let redrawing = $state(false);

  async function drawAgain(line: string) {
    if (redrawing) return;
    redrawing = true;
    problems.clear('stills-act');
    try {
      await service.call('stills.fix', { line });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: 'stills-act', kind: 'warn', text: `The still was not drawn again: ${reason}` });
    }
    redrawing = false;
    await load();
  }

  const sceneOk = $derived(
    view ? views.filter((entry) => entry.group === view.group && entry.item.state === 'ok').length : 0,
  );

  async function load() {
    const mine = ++latest;
    try {
      const [stills, noteList, lessonList, videoStatus] = await Promise.all([
        service.call<StillsState>('stills.get'),
        service.call<{ notes: NodeNote[] }>('notes.list').catch(() => ({ notes: [] })),
        service
          .call<{ lessons: Lesson[] }>('lessons.list', { scope: 'project' })
          .catch(() => ({ lessons: [] })),
        service.call<VideoNotesStatus>('videonotes.status').catch(() => null),
      ]);
      if (mine !== latest) return; // a newer load started: this answer is stale
      data = stills;
      notes = noteList.notes;
      lessons = lessonList.lessons;
      videoNotes = videoStatus;
      failure = null;
      session.keepIfPresent(stills.lines.map((line) => line.line));
      if (!session.busy && !stills.lines.some((line) => line.state === 'drawing')) session.message = '';
      if (making && drawingFinished(stills)) making = null;
      if (videoStatus?.enabled && videoStatus.problems?.length) {
        problems.raise({ id: 'tablet', kind: 'warn', text: videoStatus.problems[0] ?? '' });
      } else problems.clear('tablet');
      problems.clear('stills-load');
    } catch (error) {
      if (mine !== latest) return; // a newer load started: its answer, not this failure, decides
      if (data) {
        problems.raise({
          id: 'stills-load',
          kind: 'warn',
          text: `The stills did not refresh: ${error instanceof Error ? error.message : 'unknown error'}. What you see may be old.`,
          fix: {
            label: 'Try again',
            run: async () => {
              await load();
              return 'Refreshed.';
            },
          },
        });
      } else failure = error instanceof Error ? error : new Error('unknown error');
    }
  }

  async function drawEveryStill(count: number) {
    making = { total: count };
    try {
      await service.call('stills.make');
    } catch (error) {
      making = null;
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: 'stills-act', kind: 'warn', text: `Drawing did not start: ${reason}` });
    }
  }

  function openScene(scene: StillGroup) {
    const mine = views.filter((entry) => entry.group.beat === scene.beat);
    const drawn = mine.filter((entry) => entry.item.path);
    // A scene still being drawn has no pictures yet: open its first still, which says it is being drawn.
    const target =
      drawn.find((entry) => entry.item.state === 'review' || entry.item.state === 'held') ??
      drawn[0] ??
      mine[0];
    if (target) session.select(target.item.id);
  }

  // svelte-ignore state_referenced_locally
  useLiveReload(
    service,
    ['stills.changed', 'lessons.changed', 'videonotes.changed', 'notes.changed', 'work.active'],
    load,
  );

  onMount(() => {
    void load();
    const stopWork = work.start();
    const stopKeys = reviewKeys({
      // Enter OKs a piece in review only: a held one is OK'd anyway by its button, never by a stray Enter
      ok: () => item?.state === 'review' && !drawFailed && void session.ok(item),
      fix: () => item && !drawFailed && void session.fix(item),
    });
    return () => {
      stopWork();
      stopKeys();
    };
  });

  $effect(() => {
    if (!drawingNow) {
      since = null;
      return;
    }
    since = now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    // A missed push must not leave the screen waiting: read again every few seconds while stills are drawn.
    const reread = setInterval(() => void load(), REREAD_WHILE_WAITING_MS);
    return () => {
      clearInterval(timer);
      clearInterval(reread);
    };
  });

  $effect(() => {
    if (!data) return;
    // counted as the list on the right: per scene
    bar.count = groups.length ? `${sceneOkCount(groups)} of ${groups.length} scenes OK` : undefined;
    bar.ownPrimary = drawAll.kind !== 'none';
  });
</script>

<ScreenHead kicker={head.kicker} title={head.title} help={head.help}>
  {#snippet actions()}
    {#if drawAll.kind === 'busy'}
      <StatusMark mark="busy" glyph="◌" text={drawAll.text} />
    {:else if drawAll.kind === 'ready'}
      <Button variant="primary" onclick={() => drawEveryStill(drawAll.count)}
        >Draw all {drawAll.count} stills</Button
      >
    {/if}
    <StageMenu stage="stills" />
  {/snippet}
</ScreenHead>
<StagePanel stage="stills" {service} />

{#if failure}
  {#if isNotBuiltYet(failure)}
    <EmptyState
      title="Coming in this build"
      body="One still per spoken line needs a newer Mortiflix service."
    />
  {:else}
    <ErrorState title="Couldn't load the stills" detail={failure.message} onretry={load} />
  {/if}
{:else if !data}
  <LoadingState text="Loading the stills…" />
{:else if !item || !view}
  <EmptyState
    title="No lines to show yet"
    body="The stills come from the spoken lines. Finish the Script and Voice & music first."
  >
    {#snippet action()}<Button href={routeHref('/voice')}>Go to Voice & music</Button>{/snippet}
  </EmptyState>
  {#if !fixture}<OptionsRow stage="stills" onrun={load} />{/if}
{:else}
  {@const loaded = data}
  {#if !finished}<SpokenLine words={view.words} keyWord={item.keyWord} />{/if}
  <ReviewSplit>
    {#snippet main()}
      <ReviewPicture
        {item}
        version={session.version}
        onversion={(version) => (session.version = version)}
        placeholder={!session.message && waitWords && ownWords
          ? stillPlaceholder(waitWords)
          : waiting && !session.message && (view.lineState === 'drawing' || view.lineState === 'fix')
            ? waiting
            : makingWords(view, session.message, working)}
      />
      {#if !session.message && waitWords?.startsWith('Failed: ') && !drawFailed}
        <WaitingAction words={{ title: '', body: '', idle: true }} {work} label="Draw again" />
      {:else if !session.message && waitWords?.startsWith('Waiting: ') && why.waiting}
        <WaitingAction words={why.waiting} {work} />
      {:else if !waitWords && waiting && !session.message && (view.lineState === 'drawing' || view.lineState === 'fix')}
        <WaitingAction words={waiting} {work} />
      {/if}
      {#if finished}
        <div class="done">
          <b>✓ All {loaded.lines.length} stills are OK.</b>
          <span>Press Next: Motion. It makes scene 1 first.</span>
        </div>
        {#if !fixture}<OptionsRow stage="stills" onrun={load} />{/if}
      {:else if drawFailed}
        <div class="failed" role="alert">
          <StatusMark
            size="md"
            mark="bad"
            text="Nothing to check: the drawing failed (the reason is above)."
          />
          <Button variant="primary" disabled={redrawing} onclick={() => drawAgain(item.id)}
            >{redrawing ? 'Asking to draw it again…' : 'Draw again'}</Button
          >
        </div>
      {:else}
        <ReviewTools
          {item}
          {session}
          {service}
          {videoNotes}
          disabledWhy={item.state === 'waiting' ? 'Nothing to mark yet' : ''}
          onsaved={load}
        />
        <div class="decision">
          <ReviewDecision
            {item}
            waiting={session.waiting(item)}
            busy={session.busy}
            onok={() => session.ok(item)}
            onfix={() => session.fix(item)}
          >
            {#snippet after()}
              {#if item.state === 'ok' && active && activeView && active.id !== item.id}
                <Button size="sm" variant="text" onclick={() => session.select(active.id)}>
                  ‹ Back to scene {activeView.group.index}, still {activeView.position + 1}
                </Button>
              {/if}
            {/snippet}
          </ReviewDecision>
          <PictureMenu
            {item}
            version={session.version}
            waiting={session.waiting(item)}
            busy={session.busy}
            onok={() => session.ok(item)}
            onfix={() => session.fix(item)}
          />
        </div>
        {#if !fixture}<OptionsRow stage="stills" target={item.id} onrun={load} />{/if}
      {/if}
    {/snippet}
    {#snippet side()}
      {#if item.state === 'held'}<HeldNote reasons={item.held} />{/if}
      <ReviewChecks {item} />
      <ReviewNotes {item} {lessons} {service} onchange={load} />
      <ReviewSection title={`Scene ${view.group.index} · ${plural(view.group.lines.length, 'still')}`}>
        {#snippet aside()}<span class="nowrap">{sceneOk} of {view.group.lines.length} OK</span>{/snippet}
        <FrameCheckGrid
          label="Stills in this scene"
          rows={sceneStillRows(views, view.group, active?.id, why)}
          current={item.id}
          onselect={(id) => session.select(id)}
        />
      </ReviewSection>
      <SceneList {groups} current={view.group.beat} onselect={openScene} />
    {/snippet}
  </ReviewSplit>
{/if}

<style>
  .decision {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-12);
    align-items: end;
  }
  .done {
    display: grid;
    gap: var(--s-8);
    border-top: 1px solid var(--line);
    /* same room above the line as below it (owner 2026-11-03: balanced padding everywhere) */
    padding-top: var(--s-32);
  }
  .done b {
    color: var(--good);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  .done span {
    color: var(--muted);
  }
  .nowrap {
    white-space: nowrap;
  }
  .failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
    border-top: 1px solid var(--line);
    padding-top: var(--s-16);
  }
  .failed :global(button) {
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
