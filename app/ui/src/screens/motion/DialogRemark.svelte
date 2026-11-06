<!-- A sentence in a dialog: a warning in the warning colour, or a quieter aside. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    tone: 'warn' | 'quiet';
    children: Snippet;
  }

  let { tone, children }: Props = $props();
</script>

<p class={tone}>{@render children()}</p>

<style>
  .warn {
    color: var(--warn);
    font-size: var(--t13);
  }
  .quiet {
    color: var(--muted);
    font-size: var(--t12);
  }
</style>
