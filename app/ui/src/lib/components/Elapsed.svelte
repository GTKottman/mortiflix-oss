<!-- How long something has been running, counted up each second while it is on screen: "42 s", "3 min 05 s". -->
<script lang="ts">
  import { elapsedText } from '../time';

  interface Props {
    /** When it started (Date.now()). */
    since: number;
  }

  let { since }: Props = $props();
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
</script>

<span>{elapsedText(now - since)}</span>

<style>
  span {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
