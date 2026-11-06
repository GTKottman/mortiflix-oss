<!-- One block of the kit: a hairline, a kicker title, the specimens. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    children: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<section>
  <h2>{title}</h2>
  {@render children()}
</section>

<style>
  section {
    display: grid;
    gap: var(--s-16);
    align-content: start;
    padding-top: var(--s-16);
    border-top: 1px solid var(--line);
  }
  h2 {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
</style>
