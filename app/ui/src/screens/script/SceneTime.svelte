<!-- "0:09–0:23 · 14 s", with "est." when it is counted from the words and no voice is recorded yet. -->
<script lang="ts">
  import { clock } from '../../lib/time';
  import { secondsLabel, type BeatTiming } from './timing';

  interface Props {
    timing: BeatTiming | undefined;
  }

  let { timing }: Props = $props();
  const title = $derived(
    timing?.est
      ? 'Estimated from the words (the scene has no voice yet, or its words changed)'
      : 'From the recorded voice',
  );
</script>

{#if timing}
  <span class="time" {title}
    >{clock(timing.start)}–{clock(timing.start + timing.dur)} · {secondsLabel(timing.dur)}{#if timing.est}<i
        >&nbsp;est.</i
      >{/if}</span
  >
{/if}

<style>
  .time {
    color: var(--muted);
    font-size: var(--t13);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  i {
    color: var(--faint);
    font-style: normal;
  }
</style>
