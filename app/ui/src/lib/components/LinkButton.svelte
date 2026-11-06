<!-- An action that reads as a link (blue, underlined) for small side actions: Copy path, Open in ArtCraft. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    children: Snippet;
  }

  let { children, ...rest }: Props = $props();
</script>

<button type="button" {...rest}>{@render children()}</button>

<style>
  button {
    flex-shrink: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font-size: var(--t13);
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dur-fast) ease;
  }
  button:hover {
    color: var(--muted);
  }
</style>
