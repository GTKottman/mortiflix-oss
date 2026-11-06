<!-- The lessons that fit the filters: search, what is showing, waiting lessons then decided ones, and Show more. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import SearchField from '../../lib/components/SearchField.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import type { Stage } from '../../lib/stages';
  import { plural } from '../../lib/words';
  import { activeFilters, lessonName } from './lessons';
  import LessonRow from './LessonRow.svelte';
  import type { LessonsView } from './lessons.svelte';
  import type { Lesson } from './types';
  import WaitingLesson from './WaitingLesson.svelte';

  interface Props {
    view: LessonsView;
    /** The open project's title, or "". */
    project: string;
    /** The stage screen the owner came from, when there is a way back. */
    from: Stage | null;
  }

  let { view, project, from }: Props = $props();

  let search = $state<ReturnType<typeof SearchField>>();
  let list = $state<HTMLElement>();

  const filters = $derived(activeFilters(view.filters, project));
  const searching = $derived(view.filters.query.trim());
  const backHint = $derived(from && view.decided && view.totals.waiting === 0);

  async function decide(lesson: Lesson) {
    await view.decide(lesson);
    await tick();
    const next = list?.querySelector<HTMLElement>('[data-waiting="true"] [data-decision] button');
    if (next) next.focus();
    else if (!view.pinned.size) search?.focus();
  }

  function clear() {
    view.clearFilters();
    search?.focus();
  }
</script>

<div class="results">
  <div class="search">
    <SearchField
      bind:this={search}
      bind:value={() => view.filters.query, (value) => view.setQuery(value)}
      label="Search lessons"
    />
  </div>
  <b class="total">{plural(view.totals.total, 'lesson')}</b>
  {#if filters.length}
    <p class="showing">
      Showing <b>{filters.join(' · ')}</b>
      <Button size="sm" variant="text" onclick={clear}>Clear</Button>
    </p>
  {/if}
  {#if view.notice}
    <p class="nothing" role="alert">{view.notice}</p>
  {:else if view.removed}
    <p class="nothing" role="status">
      Lesson deleted: “{lessonName(view.removed)}”
      <Button size="sm" variant="text" onclick={() => void view.undoRemove()}>Undo</Button>
    </p>
  {:else if backHint && from}
    <p class="nothing" role="status">
      Nothing waits now. <a href={routeHref(`/${from.id}`)}>‹ Back to {from.label}</a> to press OK.
    </p>
  {/if}
  <ul bind:this={list} class="list">
    {#each view.visible as lesson (lesson.id)}
      {#if !lesson.approved || view.pinned.has(lesson.id)}
        <WaitingLesson {lesson} {view} {project} decided={view.pinned.has(lesson.id)} ondecide={decide} />
      {:else}
        <LessonRow {lesson} {view} />
      {/if}
    {/each}
  </ul>
  {#if !view.rows.length}
    {#if view.lessons.length}
      <EmptyState
        title={searching ? `Nothing matches "${searching}"` : 'No lessons match'}
        body={searching
          ? 'Search looks at the lesson words, your note and the project name.'
          : 'No lesson fits these filters.'}
      >
        {#snippet action()}<Button size="sm" onclick={clear}
            >{searching ? 'Clear search' : 'Clear filters'}</Button
          >{/snippet}
      </EmptyState>
    {:else}
      <EmptyState
        title="No lessons yet"
        body="Mark a frame on Stills or Motion and say what is wrong. Each note becomes a lesson here for you to approve."
      />
    {/if}
  {/if}
  {#if view.hidden}
    <div class="more"><Button size="lg" onclick={() => view.showMore()}>Show {view.more} more</Button></div>
  {/if}
</div>

<style>
  .results {
    --list-w: 1446px;
    display: grid;
    grid-template-columns: minmax(0, var(--list-w)) minmax(max-content, 1fr);
    min-width: 0;
  }
  .results > :global(*) {
    grid-column: 1;
  }
  .search {
    --h: 41px;
    font-size: var(--t16);
  }
  /* the glass and the words sit together in the middle of the box; the box grows them as you type */
  .search :global(svg) {
    margin-left: auto;
  }
  .search :global(label) {
    --hint-room: 26px; /* the "/" and its gap, matched on the left so the middle is the box's middle */
    padding-left: calc(var(--s-16) + var(--hint-room));
  }
  .search :global(label input) {
    --words-min: 11ch;
    flex: 0 1 auto;
    min-width: var(--words-min);
    field-sizing: content;
  }
  .results > .total {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
    padding-left: var(--s-12);
    font-size: var(--t14);
    font-weight: 600;
    white-space: nowrap;
  }
  .showing {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    margin-top: var(--s-12);
    color: var(--muted);
    font-size: var(--t13);
  }
  .showing b {
    color: var(--text);
    font-weight: 600;
  }
  .nothing {
    padding: var(--s-12) 0;
    font-size: var(--t14);
  }
  .nothing a {
    white-space: nowrap;
    color: var(--link);
    text-underline-offset: var(--s-2);
  }
  @media (max-width: 1199px) {
    .results {
      grid-template-columns: minmax(0, 1fr);
    }
    .results > .total {
      grid-column: 1;
      grid-row: auto;
      padding: var(--s-8) 0 0;
    }
  }
  .list {
    margin-top: 19px;
    border-top: 1px solid var(--line);
    list-style: none;
  }
  .more {
    display: flex;
    justify-content: center;
    padding: 20px 0 0;
  }
</style>
