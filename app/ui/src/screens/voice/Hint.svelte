<!-- A line of small explaining words under a control. `free` marks a change that costs nothing and happens at once. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    free?: boolean;
    children: Snippet;
  }

  let { free = false, children }: Props = $props();
</script>

<p>
  {#if free}<span class="free">Free ·</span>&nbsp;{/if}{@render children()}
</p>

<style>
  p {
    color: var(--muted);
    font-size: var(--t14);
    line-height: 1.55;
  }
  .free {
    color: var(--good);
    font-size: var(--t12);
  }
</style>
