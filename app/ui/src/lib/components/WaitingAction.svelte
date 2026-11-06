<!-- The one button under an honest "waiting" message: go to the stage it waits for, or (nothing blocks it and
     nothing runs) Resume / Start, with what that did or why it could not. -->
<script lang="ts">
  import type { ActiveWork } from '../review/active-work.svelte';
  import type { WaitingWords } from '../review/waiting';
  import { routeHref } from '../router.svelte';
  import Button from './Button.svelte';

  interface Props {
    words: WaitingWords;
    work: ActiveWork;
    /** The button's words instead of the pause's own ("Draw again" for a frame that failed). */
    label?: string;
  }

  let { words, work, label }: Props = $props();
</script>

{#if words.link}
  <Button size="sm" href={routeHref(words.link.route)}>{words.link.label}</Button>
{:else if words.idle && work.action}
  <span class="row">
    <Button size="sm" disabled={work.busy} onclick={() => void work.resume()}
      >{work.busy ? 'Starting…' : (label ?? work.action.label)}</Button
    >
    {#if work.second}
      <Button size="sm" variant="text" disabled={work.busy} onclick={() => void work.resume(true)}
        >{work.second.label}</Button
      >
    {/if}
    {#if work.said}<span class="said" role="status">{work.said}</span>{/if}
  </span>
{/if}

<style>
  .row {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  .said {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
