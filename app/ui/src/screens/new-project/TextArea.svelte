<!-- A few-line box. `value` is the words as typed; `oninput` hears every change. -->
<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLTextareaAttributes, 'value' | 'oninput'> {
    value?: string;
    oninput?: (value: string) => void;
  }

  let { value = $bindable(''), oninput, ...rest }: Props = $props();
</script>

<textarea
  {...rest}
  {value}
  oninput={(event) => {
    value = event.currentTarget.value;
    oninput?.(value);
  }}></textarea>

<style>
  textarea {
    --long-min: 64px;
    display: block;
    width: 100%;
    min-height: var(--long-min);
    padding: var(--s-12) var(--s-16);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    color: var(--text);
    font: inherit;
    font-size: var(--t14);
    line-height: 1.5;
    resize: vertical;
  }
  textarea:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  textarea::placeholder {
    color: var(--faint);
  }
  textarea[readonly] {
    opacity: 0.7;
  }
</style>
