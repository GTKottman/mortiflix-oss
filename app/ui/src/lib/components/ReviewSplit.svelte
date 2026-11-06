<!-- The review layout: the picture and its buttons on the left (the largest thing on the page), hairline
     sections on the right. One column under 1200px. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    main: Snippet;
    side: Snippet;
  }

  let { main, side }: Props = $props();
</script>

<div class="split">
  <div class="main">{@render main()}</div>
  <div class="side">{@render side()}</div>
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--review-side-w);
    gap: var(--s-32);
  }
  .main {
    display: grid;
    gap: var(--s-12);
    align-content: start;
    min-width: 0;
  }
  .side {
    display: grid;
    gap: var(--s-24);
    align-content: start;
    min-width: 0;
  }
  @media (max-width: 1599px) {
    .split {
      gap: var(--s-24);
    }
  }
  @media (max-width: 1199px) {
    .split {
      grid-template-columns: 1fr;
    }
  }
</style>
