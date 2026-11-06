<!-- Nothing here yet: says why and offers the next step. Also used for "Coming in this build". -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    body?: string;
    action?: Snippet;
  }

  let { title, body, action }: Props = $props();
</script>

<div class="state">
  <b>{title}</b>
  {#if body}<span>{body}</span>{/if}
  {#if action}<div class="actions">{@render action()}</div>{/if}
</div>

<style>
  .state {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-16) 0;
    color: var(--muted);
    max-width: var(--reading);
    animation: mfx-fade var(--dur-fast) var(--ease);
  }
  b {
    color: var(--text);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
    margin-top: var(--s-8);
  }
</style>
