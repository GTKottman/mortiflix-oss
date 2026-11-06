<!-- A project as a card, the owner's drawing (2026-11-05): title and ⋯ over the picture, Open on the picture, the
     date under it. Where the project stands shows when you hover the card. Clicking asks the service to open it, then
     goes to its stage. A failure shows under the card, never in a dialog. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import ProjectMenu from './ProjectMenu.svelte';
  import ProjectPicture from './ProjectPicture.svelte';
  import { cardNote, formatDate, openHref, whenOf } from './projects';
  import type { HomeProject, Still } from './types';

  interface Props {
    project: HomeProject;
    still?: Still;
    opening: boolean;
    failure: string | null;
    onopen: (project: HomeProject) => void;
  }

  let { project, still, opening, failure, onopen }: Props = $props();
  const when = $derived(whenOf(project));

  function click(event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button) return;
    event.preventDefault();
    onopen(project);
  }
</script>

<div class="card">
  <div class="body">
    <a href={openHref(project)} title={cardNote(project)} data-link onclick={click}>
      <h3>{project.title}</h3>
      <div class="frame">
        <ProjectPicture {still} />
        <span class="go">{opening ? 'Opening…' : 'Open'}</span>
      </div>
      {#if when}<span class="date">{formatDate(when)}</span>{/if}
    </a>
    <div class="menu-slot"><ProjectMenu {project} /></div>
  </div>
  {#if failure}
    <ErrorState inline title="Couldn't open this project." detail={failure} onretry={() => onopen(project)} />
  {/if}
</div>

<style>
  .card {
    min-width: 0;
  }
  .body {
    position: relative;
  }
  /* The ⋯ ends the title line, never on the picture. */
  .menu-slot {
    position: absolute;
    top: 0;
    right: 0;
  }
  a {
    display: grid;
    align-content: start;
    color: var(--text);
    text-decoration: none;
  }
  a:focus-visible {
    outline-offset: -2px;
  }
  /* one line, as tall as the ⋯ beside it: --card-head is this line and the gap under it */
  h3 {
    height: var(--h-sm);
    margin-bottom: calc(var(--card-head) - var(--h-sm));
    padding-right: calc(var(--h-sm) + var(--s-4));
    overflow: hidden;
    font: 600 var(--t16) / var(--h-sm) var(--body);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a:hover h3 {
    text-decoration: underline;
    text-underline-offset: var(--s-4);
  }
  .frame {
    position: relative;
  }
  .go {
    position: absolute;
    right: var(--s-8);
    bottom: var(--s-8);
    display: inline-flex;
    align-items: center;
    height: var(--h);
    padding: 0 var(--s-16);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink);
    color: var(--text);
    font: 600 var(--t14) / 1 var(--body);
    white-space: nowrap;
    transition:
      background var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
  }
  a:hover .go {
    border-color: var(--line-hover);
    background: var(--ink-3);
  }
  .date {
    margin-top: var(--s-8);
    color: var(--faint);
    font-size: var(--t13);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
</style>
