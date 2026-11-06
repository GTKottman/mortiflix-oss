<!-- The kept reads of a line, side by side: hear each, hear two in a row (A then B), switch the one in use. Switching is
     free and can be switched back; the other takes stay. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { TakeVersion, VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
    versions: readonly TakeVersion[];
    inUse: number;
  }

  let { model, line, versions, inUse }: Props = $props();
  const before = $derived(inUse > 0 ? inUse - 1 : 1);

  function hearBoth() {
    const a = versions[before]?.path;
    const b = versions[inUse]?.path;
    if (a && b) model.player.playTakes(a, b);
  }

  function note(n: number): string {
    return `Take ${n + 1}${n === before ? ' · A' : n === inUse ? ' · B' : ''}`;
  }
</script>

<InspectorSection title="Takes · A/B compare">
  <ul>
    {#each versions as take, n (n)}
      <li class:on={n === inUse}>
        <span class="name">{note(n)}</span>
        <Button size="sm" disabled={!take.path} onclick={() => take.path && model.player.playTakes(take.path)}
          >▶ Hear</Button
        >
        {#if n === inUse}
          <StatusPill pill small tone="ok" glyph="✓" text="In use" />
        {:else}
          <Button size="sm" onclick={() => model.useTake(line.node, versions, n)}>Use this take</Button>
        {/if}
      </li>
    {/each}
  </ul>
  <div><Button onclick={hearBoth}>▶ A/B: Take {before + 1} then Take {inUse + 1}</Button></div>
  <p class="hint">Switching takes is free and can be switched back. Your other takes are kept.</p>
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
