<!-- A destructive button that asks first, in place: "Delete for good? [Delete] [Keep]". Keep is focused,
     so Enter never deletes by accident. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from './Button.svelte';

  interface Props {
    /** The button's words before asking, e.g. "Delete this lesson". */
    label: string;
    /** The question, e.g. "Delete for good?" */
    question: string;
    yes: string;
    no: string;
    variant?: 'text' | 'danger';
    /** Does the thing. The button comes back when it is done. */
    onyes: () => Promise<void>;
  }

  let { label, question, yes, no, variant = 'text', onyes }: Props = $props();

  let asking = $state(false);
  let working = $state(false);
  let failed = $state<string | null>(null);
  let trigger = $state<HTMLElement>();
  let keep = $state<HTMLElement>();

  async function ask() {
    asking = true;
    await tick();
    keep?.focus();
  }

  async function close() {
    asking = false;
    failed = null;
    await tick();
    trigger?.focus();
  }

  async function confirm() {
    working = true;
    failed = null;
    try {
      await onyes();
      asking = false;
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    } finally {
      working = false;
    }
  }
</script>

{#if asking}
  <span class="ask" role="group" aria-label={question}>
    {question}
    <Button size="sm" variant="danger" disabled={working} onclick={confirm}>{yes}</Button>
    <Button size="sm" bind:element={keep} disabled={working} onclick={close}>{no}</Button>
    {#if failed}<span class="fail" role="alert">Did not work: {failed}.</span>{/if}
  </span>
{:else}
  <Button size="sm" {variant} bind:element={trigger} onclick={ask}>{label}</Button>
{/if}

<style>
  .ask {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    color: var(--text);
    font-size: var(--t14);
  }
  .fail {
    flex-basis: 100%;
    color: var(--bad);
    font-size: var(--t13);
  }
</style>
