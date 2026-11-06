<!-- Pick any of a few (toggle pills), and optionally add your own words, separated by commas. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import TextInput from './TextInput.svelte';
  import type { Choice } from './types';

  interface Props {
    choices: readonly Choice[];
    values: readonly string[];
    label: string;
    /** Shows the "your own words" box. */
    custom?: boolean;
    onchange: (values: string[]) => void;
  }

  let { choices, values, label, custom = false, onchange }: Props = $props();

  const isKnown = (value: string) => choices.some((c) => String(c.value) === value);
  const own = $derived(values.filter((v) => !isKnown(v)).join(', '));
  let text = $state('');
  let typing = $state(false);

  $effect(() => {
    if (!typing) text = own;
  });

  function toggle(value: string) {
    onchange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  }

  function addOwn() {
    const words = text
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);
    onchange([...new Set([...values.filter(isKnown), ...words])]);
  }
</script>

<div class="chips" role="group" aria-label={label}>
  {#each choices as choice (choice.value)}
    {@const on = values.includes(String(choice.value))}
    <Chip
      aria-pressed={on}
      selected={on}
      title={choice.hint ?? ''}
      onclick={() => toggle(String(choice.value))}>{choice.label}</Chip
    >
  {/each}
</div>
{#if custom}
  <TextInput
    bind:value={text}
    placeholder="Or add your own words, separated by commas"
    aria-label="Your own words"
    autocomplete="off"
    oninput={addOwn}
    onfocus={() => (typing = true)}
    onblur={() => (typing = false)}
  />
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
