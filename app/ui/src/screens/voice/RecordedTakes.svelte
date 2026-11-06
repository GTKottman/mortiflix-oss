<!-- The takes the service keeps for a line: Ready, Kept, or Superseded when another take replaced it. -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import type { RecordedTake } from './types';

  interface Props {
    takes: readonly RecordedTake[];
  }

  let { takes }: Props = $props();
</script>

<InspectorSection title="Recorded takes">
  <ul>
    {#each takes as take (take.take)}
      <li class:on={take.kept}>
        <span class="name">Take {take.take}{take.seconds ? ` · ${take.seconds.toFixed(1)} s` : ''}</span>
        {#if take.status === 'superseded'}
          <StatusPill pill small tone="fix" glyph="↷" text="Superseded" />
        {:else}
          <StatusPill pill small tone="ok" glyph="✓" text={take.kept ? 'Kept' : 'Ready'} />
        {/if}
      </li>
    {/each}
  </ul>
  <p class="hint">A superseded take was replaced by the take you kept. It stays on file.</p>
</InspectorSection>

<style>
  ul {
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    min-height: var(--hit);
    border-top: 1px solid var(--line);
  }
  .name {
    margin-right: auto;
    white-space: nowrap;
    font-size: var(--t14);
  }
  .on .name {
    font-weight: 500;
  }
  .hint {
    color: var(--muted);
    font-size: var(--t14);
    line-height: 1.55;
  }
</style>
