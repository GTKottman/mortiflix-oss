<!-- One section of Settings: its name and a line of why on the left, its controls on the right, under a hairline. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    lede: string;
    children: Snippet;
    element?: HTMLElement;
  }

  let { title, lede, children, element = $bindable() }: Props = $props();
  const id = $props.id();
</script>

<section bind:this={element} class="section" aria-labelledby="{id}-title">
  <div>
    <h2 id="{id}-title">{title}</h2>
    <p class="lede">{lede}</p>
  </div>
  <div class="body">{@render children()}</div>
</section>

<style>
  .section {
    --name-w: 320px;
    display: grid;
    grid-template-columns: var(--name-w) minmax(0, 1fr);
    gap: var(--s-48);
    min-width: 0;
    padding: var(--s-24) 0;
    border-top: 1px solid var(--line);
  }
  .section:last-child {
    border-bottom: 1px solid var(--line);
  }
  h2 {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .lede {
    max-width: 42ch;
    margin-top: var(--s-8);
    color: var(--muted);
    font-size: var(--t14);
  }
  .body {
    display: grid;
    gap: var(--s-16);
    align-content: start;
    min-width: 0;
  }
  @media (max-width: 1199px) {
    .section {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-12);
    }
  }
  @media (max-height: 800px) {
    .section {
      padding: var(--s-16) 0;
    }
  }
</style>
