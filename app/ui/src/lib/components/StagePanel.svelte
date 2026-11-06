<!-- The one panel the stage's ⋯ opens, under the screen head, in the page (nothing on top of anything): the brief
     (the screen's own form, `brief`), going back on the step (ReopenStep), or the screen's own `other` panel. Closes
     with Close, Esc, or when the screen goes away. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { stagePanel, type Caller, type OpenPanel } from '../stage-tools.svelte';
  import { stageById, type StageId } from '../stages';
  import Button from './Button.svelte';
  import ReopenStep from './ReopenStep.svelte';

  interface Props {
    stage: StageId;
    /** The stage's brief form (the panel's own Close closes it). */
    brief?: Snippet;
    /** Any other panel the screen opens (e.g. Look's "Use this look"). */
    other?: Snippet<[panel: OpenPanel, close: () => void]>;
    /** Default: the service. A screen on its fixture passes the fixture. */
    service?: Caller;
  }

  let { stage, brief, other, service }: Props = $props();

  const open = $derived(stagePanel.on(stage));
  const close = () => stagePanel.close();
  const label = $derived(stageById(stage).label);
  const TITLE = {
    brief: 'The brief',
    reopen: 'Reopen this step',
    remake: 'Make it again',
    'use-look': 'Use this look',
  };

  $effect(() => close);

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <section class="panel" aria-label={`${label}: ${TITLE[open.kind]}`}>
    <header>
      <h2>{label} · {TITLE[open.kind]}</h2>
      <Button size="sm" variant="text" onclick={close}>Close</Button>
    </header>
    {#if open.kind === 'brief' && brief}
      {@render brief()}
    {:else if open.kind === 'reopen' || open.kind === 'remake'}
      <ReopenStep {stage} onclose={close} {service} />
    {:else if other}
      {@render other(open, close)}
    {/if}
  </section>
{/if}

<style>
  .panel {
    display: grid;
    gap: var(--s-12);
    padding: var(--s-16) 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-12);
  }
  h2 {
    font: 600 var(--t16) / 1.3 var(--body);
    white-space: nowrap;
  }
</style>
