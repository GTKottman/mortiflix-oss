<!-- Previous / next arrows for the clip or music cue being looked at. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    index: number;
    count: number;
    /** What is stepped through, for screen readers: "clip" or "cue". */
    name: string;
    onstep: (direction: 1 | -1) => void;
  }

  let { index, count, name, onstep }: Props = $props();
</script>

<Button size="sm" variant="text" aria-label="Previous {name}" disabled={index <= 0} onclick={() => onstep(-1)}
  >‹</Button
>
<Button
  size="sm"
  variant="text"
  aria-label="Next {name}"
  disabled={index >= count - 1}
  onclick={() => onstep(1)}>›</Button
>
