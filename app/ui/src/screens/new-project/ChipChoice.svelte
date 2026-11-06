<!-- Pick one of a few: a row of pills (a radio group). Arrow keys move and choose; the chosen one's hint shows under. -->
<script lang="ts">
  import { sentenceCase } from './brief';
  import Chip from './Chip.svelte';
  import Note from './Note.svelte';
  import type { Choice, Value } from './types';

  interface Props {
    choices: readonly Choice[];
    value: Value;
    label: string;
    onpick: (value: string | number) => void;
  }

  let { choices, value, label, onpick }: Props = $props();

  let box = $state<HTMLElement>();
  const chosen = $derived(choices.find((c) => String(c.value) === String(value)));

  const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

  function onkeydown(event: KeyboardEvent) {
    const step = STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const at = choices.findIndex((c) => c === chosen);
    const next = (at + step + choices.length) % choices.length;
    const choice = choices[next];
    if (!choice) return;
    onpick(choice.value);
    box?.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
  }
</script>

<div bind:this={box} class="chips" role="radiogroup" aria-label={label} tabindex="-1" {onkeydown}>
  {#each choices as choice, at (choice.value)}
    {@const on = choice === chosen}
    <Chip
      role="radio"
      aria-checked={on}
      tabindex={on || (!chosen && at === 0) ? 0 : -1}
      selected={on}
      title={choice.hint ?? ''}
      onclick={() => onpick(choice.value)}>{choice.label}</Chip
    >
  {/each}
</div>
{#if chosen?.hint}<Note>{sentenceCase(chosen.hint)}.</Note>{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
