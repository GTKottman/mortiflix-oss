<script lang="ts">
  import { onMount } from 'svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import HeldNote from '../../lib/components/HeldNote.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import ReviewChecks from '../../lib/components/ReviewChecks.svelte';
  import ReviewDecision from '../../lib/components/ReviewDecision.svelte';
  import ReviewNotes from '../../lib/components/ReviewNotes.svelte';
  import ReviewPicture from '../../lib/components/ReviewPicture.svelte';
  import ReviewSplit from '../../lib/components/ReviewSplit.svelte';
  import ReviewTools from '../../lib/components/ReviewTools.svelte';
  import Button from '../../lib/components/Button.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import StageMenu from '../../lib/components/StageMenu.svelte';
  import StagePanel from '../../lib/components/StagePanel.svelte';
  import { stagePanel } from '../../lib/stage-tools.svelte';
  import LookBriefForm from './LookBriefForm.svelte';
  import UseLook from './UseLook.svelte';
  import { reviewKeys } from '../../lib/review/keys';
  import { useLiveReload } from '../../lib/review/live.svelte';
  import { activeItem, currentItem } from '../../lib/review/logic';
  import { ReviewSession } from '../../lib/review/session.svelte';
  import type {
    FramesState,
    Lesson,
    PoolInfo,
    ReviewItem,
    ReviewService,
    VideoNotesStatus,
  } from '../../lib/review/types';
  import { isNotBuiltYet } from '../../lib/service/client';
  import WaitingAction from '../../lib/components/WaitingAction.svelte';
  import { pauseView } from '../../lib/pause';
  import { ActiveWork } from '../../lib/review/active-work.svelte';
  import { waitingWords } from '../../lib/review/waiting';
  import { stageById } from '../../lib/stages';
  import { useProblems, useProject, useScreenBar, useService } from '../../lib/stores/context';
  import { clock } from '../../lib/time';
  import FrameDetails from './FrameDetails.svelte';
  import FramesList from './FramesList.svelte';
  import {
    frameItems,
    failedWords,
    frameWaitWords,
    waitPlaceholder,
    frameTotal,
    lookHead,
    makingWords,
    noFramesWords,
    REREAD_WHILE_WAITING_MS,
  } from './frames';
  import PictureMenu from './PictureMenu.svelte';

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
  const work = new ActiveWork(useService(), project, stageById('look'), Boolean(fixture));

  let data = $state<FramesState | null>(null);
  let lessons = $state<Lesson[]>([]);
  let videoNotes = $state<VideoNotesStatus | null>(null);
  let pool = $state<PoolInfo | null>(null);
  let failure = $state<Error | null>(null);
  let latest = 0;
  /** When this screen first saw the studio writing, and the clock that counts from it. */
  let since = $state<number | null>(null);
  let now = $state(Date.now());

  // The wrapper renders this once per service, so the service never changes while the screen is open.
  // svelte-ignore state_referenced_locally
  const session = new ReviewSession({
    service,
    problems,
    calls: 'frames',
    param: 'frame',
    problemId: 'look-act',
    reload: load,
    afterOk: (_item, result) =>
      result?.next === 'round' ? 'Writing the next round with what you told us…' : '',
  });

  /** The project stopped on a problem: the Fix it strip's words, for a frame that is not made. */
  const failed = $derived(
    project.state === 'paused'
      ? failedWords(project.needsYou, pauseView(project.state, project.needsYou)?.text)
      : '',
  );
  /** Nothing runs here: what Look waits for (an earlier stage), or nothing. */
  const blocked = $derived(
    work.idle ? waitingWords(stageById('look'), project.statuses, 'the frames', work.queued) : null,
  );
  const items = $derived(
    data ? frameItems(data).map((entry) => withWaitWords(entry, data as FramesState)) : [],
  );

  /**
   * A frame not made says why; a frame "being made" in a project that stopped on a problem says Failed. A frame that
   * has a picture keeps it and its state (with its checks beside it): Failed is added as words, never put in its place.
   */
  function withWaitWords(entry: ReviewItem, state: FramesState): ReviewItem {
    if (entry.state !== 'waiting' && !(entry.state === 'making' && failed)) return entry;
    const words = frameWaitWords(state, entry.id, { here: work.here, failed, waiting: blocked });
    if (entry.state === 'making' && !words.startsWith('Failed: ')) return entry;
    if (entry.path) return { ...entry, waitWords: words };
    return { ...entry, state: 'waiting', waitWords: words };
  }
  const item = $derived(currentItem(items, session.view));
  const active = $derived(activeItem(items));
  const finished = $derived(data?.waiting_for === 'done');
  const head = $derived(
    data ? lookHead(data, item) : { kicker: 'Look', title: 'The first frames', help: '' },
  );
  const frame = $derived(data?.frames.find((entry) => entry.id === item?.id));
  /** The frames file says the studio writes; only true when the service really works on Look now. */
  const writing = $derived(data?.waiting_for === 'studio' && work.here);
  /** The file says the studio writes, but nothing runs: say what it waits for instead of a clock. */
  const waiting = $derived(
    data?.waiting_for === 'studio' && work.idle
      ? waitingWords(stageById('look'), project.statuses, 'the frames', work.queued)
      : null,
  );
  const working = $derived(since === null ? '' : `Working for ${clock((now - since) / 1000)}.`);

  async function load() {
    const mine = ++latest;
    try {
      const [frames, lessonList, notes, packs] = await Promise.all([
        service.call<FramesState>('frames.get'),
        service
          .call<{ lessons: Lesson[] }>('lessons.list', { scope: 'project' })
          .catch(() => ({ lessons: [] })),
        service.call<VideoNotesStatus>('videonotes.status').catch(() => null),
        service.call<PoolInfo>('pool.get').catch(() => null),
      ]);
      if (mine !== latest) return; // a newer load started: this answer is stale
      data = frames;
      lessons = lessonList.lessons;
      videoNotes = notes;
      pool = packs;
      failure = null;
      session.keepIfPresent(frames.frames.map((entry) => entry.id));
      if (!session.busy && frames.waiting_for !== 'studio') session.message = '';
      if (notes?.enabled && notes.problems?.length) {
        problems.raise({ id: 'tablet', kind: 'warn', text: notes.problems[0] ?? '' });
      } else problems.clear('tablet');
      problems.clear('look-load');
    } catch (error) {
      if (data) {
        problems.raise({
          id: 'look-load',
          kind: 'warn',
          text: `The frames did not refresh: ${error instanceof Error ? error.message : 'unknown error'}. What you see may be old.`,
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

  // svelte-ignore state_referenced_locally
  useLiveReload(
    service,
    [
      'frames.changed',
      'lessons.changed',
      'videonotes.changed',
      'pool.changed',
      'notes.changed',
      'work.active',
    ],
    load,
  );

  onMount(() => {
    void load();
    const stopWork = work.start();
    const stopKeys = reviewKeys({
      // Enter OKs a frame in review only: a held one is OK'd anyway by its button, never by a stray Enter
      ok: () => item?.state === 'review' && void session.ok(item),
      fix: () => item && void session.fix(item),
    });
    return () => {
      stopWork();
      stopKeys();
    };
  });

  $effect(() => {
    if (!writing) {
      since = null;
      return;
    }
    since = now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    // A missed push must not leave the screen waiting: read again every few seconds while the studio writes.
    const reread = setInterval(() => void load(), REREAD_WHILE_WAITING_MS);
    return () => {
      clearInterval(timer);
      clearInterval(reread);
    };
  });

  $effect(() => {
    const count = data ? frameTotal(data) : 0;
    bar.count = data && count > 0 ? `${data.ok} of ${count} frames OK` : undefined;
  });
</script>

<ScreenHead kicker={head.kicker} title={head.title} help={head.help}>
  {#snippet actions()}<StageMenu stage="look" brief />{/snippet}
</ScreenHead>
<StagePanel stage="look" {service}>
  {#snippet brief()}<LookBriefForm {service} />{/snippet}
  {#snippet other(panel, close)}
    {#if panel.kind === 'use-look' && panel.frame}
      {@const frame = items.find((entry) => entry.id === panel.frame)}
      <UseLook frame={panel.frame} name={frame?.label ?? panel.frame} onclose={close} {service} />
    {/if}
  {/snippet}
</StagePanel>

{#if failure}
  {#if isNotBuiltYet(failure)}
    <EmptyState
      title="Coming in this build"
      body="Style frames one at a time need a newer Mortiflix service."
    />
  {:else}
    <ErrorState title="Couldn't load the frames" detail={failure.message} onretry={load} />
  {/if}
{:else if !data}
  <LoadingState text="Loading the frames…" />
{:else if !item}
  {@const words = waiting ?? noFramesWords(data, working)}
  <div role="status">
    {#if waiting}
      {@const shown = waiting}
      <EmptyState title={words.title} body={words.body}>
        {#snippet action()}<WaitingAction words={shown} {work} />{/snippet}
      </EmptyState>
    {:else}
      <EmptyState title={words.title} body={words.body} />
    {/if}
  </div>
  {#if !fixture}<OptionsRow stage="look" onrun={load} />{/if}
{:else}
  {@const loaded = data}
  <ReviewSplit>
    {#snippet main()}
      <ReviewPicture
        {item}
        version={session.version}
        onversion={(version) => (session.version = version)}
        placeholder={waiting && item.state === 'making' && !session.message
          ? waiting
          : item.state === 'waiting' && item.waitWords && !session.message
            ? waitPlaceholder(item.waitWords)
            : makingWords(loaded, item.state === 'making', session.message, working)}
      />
      {#if waiting && item.state === 'making' && !session.message}<WaitingAction
          words={waiting}
          {work}
        />{/if}
      {#if (item.state === 'waiting' || item.state === 'making') && !session.message}
        {#if item.waitWords?.startsWith('Failed: ')}
          <WaitingAction words={{ title: '', body: '', idle: true }} {work} label="Draw again" />
        {:else if item.waitWords?.startsWith('Waiting: ') && blocked}
          <WaitingAction words={blocked} {work} />
        {/if}
      {/if}
      {#if finished}
        <div class="done">
          <b>✓ All {frameTotal(loaded)} frames are OK.</b>
          <span>Press Next: Motion. These frames are what every scene is built from.</span>
        </div>
        {#if !fixture}<OptionsRow stage="look" onrun={load} />{/if}
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
              {#if item.state === 'ok' && active && active.id !== item.id}
                <Button size="sm" variant="text" onclick={() => session.select(active.id)}>
                  ‹ Back to frame {loaded.frames.findIndex((entry) => entry.id === active.id) + 1}
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
            extra={[
              {
                label: 'Use this look',
                run: () => stagePanel.show({ kind: 'use-look', stage: 'look', frame: item.id }),
                why: item.path ? undefined : 'Not made yet',
              },
            ]}
          />
        </div>
        {#if !fixture}<OptionsRow stage="look" target={item.id} onrun={load} />{/if}
      {/if}
    {/snippet}
    {#snippet side()}
      {#if item.state === 'held'}<HeldNote reasons={item.held} />{/if}
      <ReviewChecks {item} />
      <ReviewNotes {item} {lessons} {service} onchange={load} />
      <FramesList
        frames={loaded}
        {items}
        current={item.id}
        activeId={active?.id}
        {service}
        onselect={(id) => session.select(id)}
        onchange={load}
      />
      <FrameDetails {frame} {pool} usage={loaded.usage ?? []} />
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
    padding-top: var(--s-16);
  }
  b {
    color: var(--good);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  span {
    color: var(--muted);
  }
</style>
