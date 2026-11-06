<!-- Pick one of many (more than seven): a drop-down. -->
<script lang="ts">
  import SelectBox from './SelectBox.svelte';
  import type { Choice, Value } from './types';

  interface Props {
    choices: readonly Choice[];
    value: Value;
    label: string;
    onpick: (value: string | number) => void;
  }

  let { choices, value, label, onpick }: Props = $props();

  // A value the list does not hold must not show as its first entry.
  const known = $derived(choices.some((c) => String(c.value) === String(value)));
</script>

<SelectBox
  aria-label={label}
  value={known ? String(value) : ''}
  onchange={(chosen) => {
    const picked = choices.find((c) => String(c.value) === chosen);
    if (picked) onpick(picked.value);
  }}
>
  {#if !known}<option value="" disabled>Choose one</option>{/if}
  {#each choices as choice (choice.value)}
    <option value={String(choice.value)}>{choice.label}</option>
  {/each}
</SelectBox>
