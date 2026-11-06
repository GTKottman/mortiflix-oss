<!-- Lessons, laid out from the owner's drawing (Mortiflix Lessons - original.svg, 2026-11-05): what Mortiflix has
     learned from the owner's notes. Waiting lessons come first and each needs a decision; approved ones can be
     switched off, edited or removed. -->
<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { isStageId, stageById } from '../../lib/stages';
  import { useApp } from '../../lib/stores/context';
  import FilterRail from './FilterRail.svelte';
  import LessonResults from './LessonResults.svelte';
  import { lessonsFixture } from './fixture';
  import { LessonsView } from './lessons.svelte';

  const { client, connection, project, router } = useApp();
  const fixture = import.meta.env.DEV && router.query.get('fixture') === 'lessons' ? lessonsFixture() : null;
  const view = new LessonsView(fixture ?? client, async () => {
    if (!project.id) await project.load().catch(() => undefined);
  });
  view.decisions = fixture;

  const LOAD_DELAY_MS = 200;

  let reloading: ReturnType<typeof setTimeout> | undefined;

  const title = $derived(project.title);

  // Came from a stage screen (?from=look): the way back is one link.
  const fromId = $derived((router.query.get('from') ?? '').replace(/-.*$/, ''));
  const from = $derived(project.id && isStageId(fromId) ? stageById(fromId) : null);

  $effect(() => {
    if (client.up || fixture) void view.load();
    return client.on<{ up: boolean }>('bridge.state', (state) => {
      if (state.up && view.phase !== 'ok') void view.load();
    });
  });

  $effect(() =>
    client.on('lessons.changed', () => {
      clearTimeout(reloading);
      reloading = setTimeout(() => view.changed(), LOAD_DELAY_MS);
    }),
  );
</script>

<div class="lessons">
  {#if from}
    <a class="back" href={routeHref(`/${from.id}`)}>‹ Back to {title || 'your project'} · {from.label}</a>
  {/if}

  <header class="head">
    <h1 aria-label="Lessons">L E S S O N S</h1>
    <p class="sub">What mortiflix has learned</p>
    <p class="help">Teach Mortiflix your taste to stand out from the next guy.</p>
  </header>

  {#if view.phase === 'loading'}
    <LoadingState text={connection.up ? 'Loading lessons…' : 'Waiting for the studio to connect…'} />
  {:else if view.phase === 'soon'}
    <EmptyState
      title="Coming in this build"
      body="Lessons arrive when the studio is updated. Your notes will turn into lessons here, and each one waits for your approval."
    />
  {:else if view.phase === 'error'}
    <ErrorState title="Could not load lessons" detail={view.error} onretry={() => void view.load()} />
  {:else}
    <div class="columns">
      <FilterRail {view} project={title} />
      <LessonResults {view} project={title} {from} />
    </div>
  {/if}
</div>

<style>
  /* the filters sit against the window's left edge, as the Projects tab does above them */
  :global(.work:has(> .lessons)) {
    padding-inline: var(--s-24);
  }
  .lessons {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 13px;
    min-width: 0;
  }
  .back {
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t14);
    text-decoration: none;
  }
  .back:hover {
    color: var(--text);
  }
  .head {
    --title-size: 53px;
    --sub-size: 27px;
    margin-top: calc(-1 * var(--s-4));
    text-align: center;
  }
  h1 {
    font: 600 var(--title-size) / 1 var(--display);
    letter-spacing: -0.02em;
    word-spacing: 0;
  }
  .sub {
    color: var(--faint);
    font: 600 var(--sub-size) / 1.3 var(--display);
    letter-spacing: 0.14em;
  }
  .help {
    color: var(--muted);
    font-size: var(--t14);
  }
  .columns {
    --rail-w: 341px;
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    gap: clamp(var(--s-32), 8.05vw, 206px);
    align-items: start;
  }
  @media (max-width: 1599px) {
    .head {
      --title-size: 36px;
      --sub-size: var(--t20);
    }
    .columns {
      --rail-w: 200px;
    }
  }
  @media (max-width: 1199px) {
    .columns {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-16);
    }
  }
</style>
