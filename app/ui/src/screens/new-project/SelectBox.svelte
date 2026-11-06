<!-- A drop-down box. The options go inside; `onchange` hears the picked value. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLSelectAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLSelectAttributes, 'value' | 'onchange'> {
    value?: string;
    onchange?: (value: string) => void;
    /** For the parent to focus. */
    element?: HTMLSelectElement;
    children: Snippet;
  }

  let { value = $bindable(''), onchange, element = $bindable(), children, ...rest }: Props = $props();
</script>

<select
  bind:this={element}
  {...rest}
  {value}
  onchange={(event) => {
    value = event.currentTarget.value;
    onchange?.(value);
  }}
>
  {@render children()}
</select>

<style>
  select {
    display: flex;
    align-items: center;
    width: 100%;
    height: var(--h);
    padding: 0 var(--s-12);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    color: var(--text);
    font: inherit;
  }
  select:focus-visible {
    outline: none;
    border-color: var(--link);
  }
</style>
