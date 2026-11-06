<!-- "‹ take 2 of 3 ›": move the take in use for a line. Free; the other takes stay. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    inUse: number;
    count: number;
    onuse: (index: number) => void;
  }

  let { inUse, count, onuse }: Props = $props();
</script>

<span class="takes">
  <Button
    size="sm"
    variant="text"
    aria-label="Earlier take"
    disabled={inUse <= 0}
    onclick={() => onuse(inUse - 1)}>‹</Button
  >
  take {inUse + 1} of {count}
  <Button
    size="sm"
    variant="text"
    aria-label="Later take"
    disabled={inUse >= count - 1}
    onclick={() => onuse(inUse + 1)}>›</Button
  >
  <span class="free">free</span>
</span>

<style>
  .takes {
    display: inline-flex;
    margin-left: auto;
    align-items: center;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t12);
    white-space: nowrap;
  }
  .free {
    color: var(--good);
  }
</style>
