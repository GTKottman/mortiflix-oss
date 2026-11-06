<!-- A right-column section: a kicker over a hairline, a small note on the right, then the content. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Small words on the right of the head. */
    aside?: Snippet;
    children: Snippet;
  }

  let { title, aside, children }: Props = $props();
</script>

<section class="sec">
  <div class="head">
    <h2 class="kicker">{title}</h2>
    {#if aside}<span class="aside">{@render aside()}</span>{/if}
  </div>
  {@render children()}
</section>

<style>
  .sec {
    display: grid;
    gap: var(--s-8);
    align-content: start;
    min-width: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s-12);
    border-bottom: 1px solid var(--line);
    padding-bottom: var(--s-8);
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .aside {
    flex-shrink: 0;
    color: var(--muted);
    font-size: var(--t12);
    white-space: nowrap;
  }
</style>
