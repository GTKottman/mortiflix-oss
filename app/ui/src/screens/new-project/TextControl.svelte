<!-- A written setting: one line, a few lines, a list (one per line) or a number. What you type is kept as you type;
     the box only changes under you when the setting is changed from somewhere else (Reset, a preset). -->
<script lang="ts">
  import TextArea from './TextArea.svelte';
  import TextInput from './TextInput.svelte';
  import type { Value } from './types';

  interface Props {
    kind: 'text' | 'long' | 'list' | 'number';
    label: string;
    value: Value;
    min?: number;
    max?: number;
    onset: (value: Value) => void;
  }

  let { kind, label, value, min, max, onset }: Props = $props();

  const shown = $derived(
    kind === 'list' && Array.isArray(value)
      ? value.join('\n')
      : value === null || value === undefined
        ? ''
        : String(value),
  );
  let text = $state('');
  let typing = $state(false);

  $effect(() => {
    if (!typing) text = shown;
  });

  function changed() {
    if (kind === 'list') {
      onset(
        text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } else if (kind === 'number') onset(text === '' ? null : Number(text));
    else onset(text);
  }
</script>

{#if kind === 'text' || kind === 'number'}
  <TextInput
    type={kind === 'number' ? 'number' : 'text'}
    {min}
    {max}
    bind:value={text}
    aria-label={label}
    autocomplete="off"
    oninput={changed}
    onfocus={() => (typing = true)}
    onblur={() => (typing = false)}
  />
{:else}
  <TextArea
    bind:value={text}
    placeholder={kind === 'list' ? 'One per line' : ''}
    aria-label={label}
    autocomplete="off"
    oninput={changed}
    onfocus={() => (typing = true)}
    onblur={() => (typing = false)}
  />
{/if}
