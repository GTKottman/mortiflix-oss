<!-- The brand's two colours (main and accent), picked with the browser's colour picker; empty until chosen. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import type { Value } from './types';

  interface Props {
    /** Hex colours chosen so far (main, accent). */
    value: Value;
    onset: (colours: string[]) => void;
  }

  let { value, onset }: Props = $props();

  // What the pickers show before the owner has chosen: the studio's own two colours.
  const SHOWN_UNTIL_CHOSEN = ['#b18cff', '#7ce8f3'] as const;

  const chosen = $derived(
    Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [],
  );

  function pick(at: number, colour: string) {
    // A colour picked second keeps the one shown before it, so the accent never slides into the main slot.
    const next = SHOWN_UNTIL_CHOSEN.slice(0, at + 1).map((shown, i) => chosen[i] ?? shown);
    next[at] = colour;
    onset([...next, ...chosen.slice(at + 1)]);
  }
</script>

<div class="brand">
  {#each ['Main brand colour', 'Accent colour'] as label, at (label)}
    <input
      type="color"
      aria-label={label}
      value={chosen[at] ?? SHOWN_UNTIL_CHOSEN[at]}
      oninput={(event) => pick(at, event.currentTarget.value)}
    />
  {/each}
  {#if chosen.length}<Button variant="text" size="sm" onclick={() => onset([])}>Clear colours</Button>{/if}
</div>

<style>
  .brand {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
  }
  input {
    --swatch-w: 44px;
    width: var(--swatch-w);
    height: var(--h);
    padding: var(--s-2);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
  }
</style>
