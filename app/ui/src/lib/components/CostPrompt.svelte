<!-- Cost first: the button for anything paid. Click = the cost in place ("This uses 3,400 ElevenLabs credits")
     with the go button, an optional small test first, and Cancel. Nothing paid runs without that second click. -->
<script lang="ts">
  import { tick } from 'svelte';
  import type { Cost } from '../service/types';
  import Button from './Button.svelte';

  interface Test {
    label: string;
    amount: string;
    run: () => Promise<void>;
  }

  interface Props {
    /** The button's words before the cost shows, e.g. "Make 12 lines". */
    label: string;
    cost: Cost;
    /** The go button's words. Default: the label. */
    yes?: string;
    no?: string;
    test?: Test;
    size?: 'sm' | 'md';
    /** The trigger's look before the cost shows: 'cost' (warn outline) or 'primary' when it is the screen's
        one gradient button. The prompt itself is always the warn outline. */
    variant?: 'cost' | 'primary';
    /** The cost is showing. */
    asking?: boolean;
    run: () => Promise<void>;
  }

  let {
    label,
    cost,
    yes,
    no = 'Cancel',
    test,
    size = 'sm',
    variant = 'cost',
    asking = $bindable(false),
    run,
  }: Props = $props();

  let running = $state(false);
  let failed = $state<string | null>(null);
  let trigger = $state<HTMLElement>();
  let go = $state<HTMLElement>();

  async function spend(work: () => Promise<void>) {
    running = true;
    failed = null;
    try {
      await work();
      asking = false;
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    } finally {
      running = false;
    }
  }

  async function ask() {
    asking = true;
    await tick();
    go?.focus();
  }

  // tick() resolves once the pending state change is applied (svelte.dev/docs/svelte/lifecycle-hooks#tick), so the
  // trigger button exists again before it gets the focus (same as ConfirmInline).
  async function cancel() {
    asking = false;
    failed = null;
    await tick();
    trigger?.focus();
  }
</script>

{#if asking}
  <span class="prompt" role="group" aria-label="Cost">
    <span>This uses <b>{cost.amount} {cost.what}</b></span>
    {#if cost.note}<span class="note">{cost.note}</span>{/if}
    <Button bind:element={go} variant="cost" {size} disabled={running} onclick={() => spend(run)}>
      {yes ?? label}
    </Button>
    {#if test}
      <Button variant="cost" {size} disabled={running} onclick={() => spend(test.run)}>
        {test.label} ({test.amount}
        {cost.what})
      </Button>
    {/if}
    <Button variant="text" {size} disabled={running} onclick={cancel}>{no}</Button>
    {#if running}<span class="note" role="status">Starting…</span>{/if}
    {#if failed}<span class="fail" role="alert">Did not start: {failed}.</span>{/if}
  </span>
{:else}
  <Button bind:element={trigger} {variant} {size} onclick={ask}>{label}</Button>
{/if}

<style>
  .prompt {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    padding: var(--s-4) var(--s-8);
    border: 1px solid var(--warn);
    border-radius: var(--r);
    font-size: var(--t14);
  }
  b {
    white-space: nowrap;
  }
  .note {
    color: var(--muted);
    font-size: var(--t13);
  }
  .fail {
    flex-basis: 100%;
    color: var(--bad);
    font-size: var(--t13);
  }
</style>
