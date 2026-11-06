<!-- A row of project cards, the owner's Projects drawing (2026-11-05): up to three side by side, centered, a ‹ › on
     each side and Show all under the right end once there are more. The ‹ › slide a whole row, or Left / Right on a
     card at the row's end. The order holds still while the pointer is over the row. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ProjectCard from './ProjectCard.svelte';
  import { clampStart, GAP, lastStart, shelfFit } from './shelf-layout';
  import type { HomeProject, Still } from './types';

  interface Props {
    /** In the order they read left to right. */
    projects: readonly HomeProject[];
    stills: Record<string, Still>;
    opening: string | null;
    failure: { id: string; message: string } | null;
    onopen: (project: HomeProject) => void;
    /** What the row holds, for screen readers. */
    label: string;
    /** Which card the row starts on, given how many show at once. */
    startAt?: (count: number, shown: number) => number;
  }

  let { projects, stills, opening, failure, onopen, label, startAt }: Props = $props();

  let order = $state<string[]>([]);
  let hovering = $state(false);
  let moved = $state<number | null>(null);
  let showAll = $state(false);
  let width = $state(0);
  let track = $state<HTMLElement>();

  $effect(() => {
    const ids = projects.map((p) => p.id);
    const same = untrack(() => order.length === ids.length && ids.every((id) => order.includes(id)));
    if (!(hovering && same)) order = ids;
  });

  const byId = $derived(new Map(projects.map((p) => [p.id, p])));
  const list = $derived(order.map((id) => byId.get(id)).filter((p): p is HomeProject => p !== undefined));
  const fit = $derived(shelfFit(width || 1));
  const more = $derived(list.length > fit.shown);
  const all = $derived(showAll && more);
  const start = $derived(
    all ? 0 : clampStart(moved ?? startAt?.(list.length, fit.shown) ?? 0, list.length, fit.shown),
  );
  const inRow = $derived(Math.min(list.length, fit.shown));

  const inView = (index: number): boolean => all || (index >= start && index < start + fit.shown);

  function slide(direction: number) {
    moved = clampStart(start + direction * fit.shown, list.length, fit.shown);
  }

  /** Left / Right walk the cards on Home; past the end of the row the row slides and the walk carries on. */
  async function keydown(event: KeyboardEvent) {
    if (all || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    const slot = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.slot') : null;
    if (!slot || !track || !(event.target as HTMLElement).closest('[data-link]')) return;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = [...track.children].indexOf(slot) + direction;
    if (next < 0 || next >= list.length || inView(next)) return;
    event.preventDefault();
    slide(direction);
    await tick();
    track.children[next]?.querySelector<HTMLElement>('[data-link]')?.focus();
  }
</script>

{#snippet arrow(direction: number, name: string, path: string)}
  <div class="side">
    <Button
      square
      aria-label={name}
      disabled={direction < 0 ? start <= 0 : start >= lastStart(list.length, fit.shown)}
      onclick={() => slide(direction)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    </Button>
  </div>
{/snippet}

<div class="fit" bind:clientWidth={width}>
  <div
    class="shelf"
    class:all
    class:more
    style:--card-w="{fit.card}px"
    style:--gap="{GAP}px"
    style:--in-row={inRow}
  >
    <div class="row">
      {#if !all}{@render arrow(-1, 'Show the projects before these', 'M15 6l-6 6 6 6')}{/if}
      <div class="view">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          bind:this={track}
          class="track"
          role="list"
          aria-label={label}
          style:--start={start}
          onpointerenter={() => (hovering = true)}
          onpointerleave={() => (hovering = false)}
          onkeydown={keydown}
        >
          {#each list as project, index (project.id)}
            <div class="slot" role="listitem" inert={!inView(index)}>
              <ProjectCard
                {project}
                still={stills[project.id]}
                opening={opening === project.id}
                failure={failure?.id === project.id ? failure.message : null}
                {onopen}
              />
            </div>
          {/each}
        </div>
      </div>
      {#if !all}{@render arrow(1, 'Show the projects after these', 'M9 6l6 6-6 6')}{/if}
    </div>
    {#if more}
      <div class="foot">
        <Button size="sm" onclick={() => (showAll = !showAll)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </Button>
      </div>
    {/if}
  </div>
</div>

<style>
  .shelf {
    width: fit-content;
    max-width: 100%;
    margin: 0 auto;
  }
  .shelf.all {
    width: 100%;
  }
  .shelf:not(.more) {
    padding-bottom: calc(var(--s-48) - var(--s-12));
  }
  .row {
    display: flex;
    gap: var(--s-16);
    align-items: flex-start;
  }
  /* each ‹ › sits level with the middle of the pictures: past the card's title line, half a picture down */
  .side {
    flex: none;
    margin-top: calc(var(--card-head) + var(--card-w) * 9 / 32 - var(--h) / 2);
  }
  .side svg {
    width: var(--s-16);
    height: var(--s-16);
  }
  /* cut off sideways only: a card's ⋯ menu still opens downward past the row */
  .view {
    flex: none;
    width: calc(var(--in-row) * var(--card-w) + (var(--in-row) - 1) * var(--gap));
    overflow-x: clip;
  }
  .track {
    display: flex;
    gap: var(--gap);
    transform: translateX(calc(var(--start) * -1 * (var(--card-w) + var(--gap))));
    transition: transform var(--dur-slow) var(--ease);
  }
  /* the slide makes the row its own layer: an open ⋯ menu lifts it over the rows below */
  .track:has(:global([aria-expanded='true'])) {
    position: relative;
    z-index: var(--z-menu);
  }
  .slot {
    flex: none;
    width: var(--card-w);
    min-width: 0;
  }
  .all .view {
    flex: 1;
    width: auto;
  }
  .all .track {
    display: grid;
    grid-template-columns: repeat(auto-fill, var(--card-w));
    justify-content: center;
    gap: var(--s-32) var(--gap);
    transform: none;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--s-16);
  }
  @media (prefers-reduced-motion: reduce) {
    .track {
      transition: none;
    }
  }
</style>
