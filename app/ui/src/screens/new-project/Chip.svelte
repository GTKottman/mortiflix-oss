<!-- One pill choice. The group around it says whether it is a radio or a toggle (pass role / aria-checked / aria-pressed). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    selected?: boolean;
    children: Snippet;
  }

  let { selected = false, children, ...rest }: Props = $props();
</script>

<button type="button" class="chip" class:selected {...rest}>{@render children()}</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: transparent;
    color: var(--muted);
    font: 500 var(--t14) / 1 var(--body);
    white-space: nowrap;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--line-hover);
    color: var(--text);
  }
  .selected {
    border-color: var(--text);
    background: var(--text);
    color: var(--ink);
  }
</style>
