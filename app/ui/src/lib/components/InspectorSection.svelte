<!-- One section of an Inspector body: a small caps title, then what belongs to it. A hairline above every one
     but the first. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Leave out for a section with no title (the first, usually). */
    title?: string;
    children: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<section>
  {#if title}<h3>{title}</h3>{/if}
  {@render children()}
</section>

<style>
  section {
    display: grid;
    gap: var(--s-8);
    padding-top: var(--s-12);
    border-top: 1px solid var(--line);
  }
  section:first-child {
    padding-top: 0;
    border-top: 0;
  }
  h3 {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
</style>
