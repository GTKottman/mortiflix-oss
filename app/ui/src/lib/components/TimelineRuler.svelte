<!-- The ruler along the top of an audio timeline: a tick for every few seconds, and a label under it for each marker. -->
<script lang="ts">
  import { clock } from '../time';
  import type { TimelineMarker } from './AudioTimeline.svelte';

  interface Props {
    /** Seconds from one tick to the next. */
    step: number;
    /** Seconds the full width stands for. */
    total: number;
    markers: readonly TimelineMarker[];
  }

  let { step, total, markers }: Props = $props();

  const percent = (seconds: number) => `${(total > 0 ? (seconds / total) * 100 : 0).toFixed(3)}%`;
  // No length yet (total 0) or a bad step: no ticks, instead of NaN positions or an endless list.
  const ticks = $derived(
    total > 0 && step > 0 ? Array.from({ length: Math.ceil(total / step) }, (_, i) => i * step) : [],
  );
</script>

<div class="ruler" title="Click to listen from here">
  {#each ticks as tick (tick)}<span style:left={percent(tick)}>{clock(tick)}</span>{/each}
  <!-- keyed by place in the list: two markers may share a time and a label (each_key_duplicate throws), and
       `at + label` also collided across markers (1 + '0x' = 10 + 'x') -->
  {#each markers as marker, i (i)}
    <span class="marker" style:left={percent(marker.at)}>
      {#if marker.colour}<i style:background={marker.colour}></i>{/if}{marker.label}
    </span>
  {/each}
</div>

<style>
  .ruler {
    position: relative;
    flex: none;
    height: var(--ruler-h);
    border-bottom: 1px solid var(--line);
    color: var(--faint);
    font-size: var(--t12);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .ruler > span {
    position: absolute;
    top: 0;
    height: var(--s-16);
    padding-left: var(--s-4);
    border-left: 1px solid var(--line-2);
    line-height: var(--s-16);
    white-space: nowrap;
  }
  .ruler > .marker {
    top: var(--s-16);
    display: inline-flex;
    align-items: center;
    gap: var(--s-4);
    border-left-color: transparent;
    color: var(--muted);
  }
  i {
    width: var(--s-8);
    height: var(--s-8);
    border-radius: var(--r-xs);
  }
</style>
