<!-- A one-line box: text, a number or a link. `value` is the words as typed; `oninput` hears every change. -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'oninput' | 'type'> {
    value?: string;
    type?: 'text' | 'number' | 'url';
    oninput?: (value: string) => void;
    /** For the parent to focus. */
    element?: HTMLInputElement;
  }

  let { value = $bindable(''), type = 'text', oninput, element = $bindable(), ...rest }: Props = $props();
</script>

<input
  bind:this={element}
  {type}
  {...rest}
  {value}
  oninput={(event) => {
    value = event.currentTarget.value;
    oninput?.(value);
  }}
/>

<style>
  input {
    display: flex;
    align-items: center;
    width: 100%;
    height: var(--box-h, var(--h));
    padding: 0 var(--s-12);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    color: var(--text);
    font: inherit;
  }
  input:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  input::placeholder {
    color: var(--faint);
  }
  input[readonly] {
    opacity: 0.7;
  }
</style>
