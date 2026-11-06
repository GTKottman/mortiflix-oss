<!-- One of Claude's suggestions: accept it (a setting) or dismiss it; a question is just read. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useNewProject } from './context';
  import type { Suggestion } from './types';

  interface Props {
    suggestion: Suggestion;
  }

  let { suggestion }: Props = $props();
  const { form, live } = useNewProject();

  const canAccept = $derived(
    suggestion.kind === 'set' && suggestion.path !== undefined && suggestion.path in form.fields,
  );
</script>

<div class="item">
  <span>{suggestion.label}{suggestion.why ? ` ${suggestion.why}` : ''}<span class="tag">suggested</span></span
  >
  <div class="fx">
    {#if canAccept}<Button size="sm" onclick={() => live.accept(suggestion)}>Accept</Button>{/if}
    <Button size="sm" variant="text" onclick={() => live.dismiss(suggestion)}
      >{suggestion.kind === 'set' ? 'Dismiss' : 'Got it'}</Button
    >
  </div>
</div>

<style>
  .item {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-8) 0;
    border-top: 1px solid var(--line);
    font-size: var(--t14);
  }
  .fx {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  .tag {
    display: inline-block;
    margin-left: var(--s-8);
    padding: 1px var(--s-8);
    border: 1px solid var(--busy);
    border-radius: var(--r-sm);
    color: var(--busy);
    font-size: var(--t12);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    vertical-align: 1px;
    white-space: nowrap;
  }
</style>
