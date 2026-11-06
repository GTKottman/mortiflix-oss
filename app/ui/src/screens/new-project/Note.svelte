<!-- A quiet line of help under a setting. A paragraph by default; a span when it sits beside something. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    as?: 'p' | 'span';
    id?: string;
    /** Announce the words when they change (a message after Apply or Save). */
    live?: boolean;
    children: Snippet;
  }

  let { as = 'p', id, live = false, children }: Props = $props();
</script>

<svelte:element this={as} {id} class="note" aria-live={live ? 'polite' : undefined}>
  {@render children()}
</svelte:element>

<style>
  .note {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
