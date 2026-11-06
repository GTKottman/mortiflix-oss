<!-- What is on screen while this scene is spoken. The Script stage has no pictures yet, so it is words. -->
<script lang="ts">
  interface Props {
    sceneNo: number;
    visual: string | undefined;
    /** Collapsed row: no label, two lines. */
    compact?: boolean;
  }

  let { sceneNo, visual, compact = false }: Props = $props();
</script>

<div class="dir" class:compact role="group" aria-label={`On screen, scene ${sceneNo}`}>
  <span class="kicker">On screen</span>
  {#if visual}
    <p>{visual}</p>
  {:else}
    <p class="none">No visual direction was written for this scene.</p>
  {/if}
</div>

<style>
  .dir {
    display: grid;
    gap: var(--s-4);
    align-content: start;
    min-width: 0;
    padding-top: var(--s-8);
  }
  .kicker {
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  p {
    max-width: 62ch;
    color: var(--text);
    font-size: var(--t15);
    line-height: 1.6;
  }
  .none {
    color: var(--muted);
  }
  .compact {
    gap: 0;
    padding-top: var(--s-4);
  }
  .compact .kicker {
    display: none;
  }
  .compact p {
    display: -webkit-box;
    overflow: hidden;
    color: var(--muted);
    font-size: var(--t14);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>
