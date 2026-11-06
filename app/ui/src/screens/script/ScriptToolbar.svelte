<!-- Under the heading: the script's numbers on the left; the key hint and the list size on the right. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { stageById, statusFor } from '../../lib/stages';
  import { useProject } from '../../lib/stores/context';
  import ScriptSummary from './ScriptSummary.svelte';
  import { useScript, type ViewMode } from './script.svelte';
  import ToggleGroup from '../../lib/components/ToggleGroup.svelte';

  const script = useScript();
  const project = useProject();
  const SIZES: readonly { id: ViewMode; label: string }[] = [
    { id: 'compact', label: 'Compact' },
    { id: 'full', label: 'Detailed' },
  ];
  /** The whole-script Fix: sends the script back while it waits for review, or reopens it once approved. */
  const scriptStatus = $derived(statusFor(stageById('script'), project.statuses));
  const scriptStep = $derived(scriptStatus?.steps?.find((s) => s.key === 'script') ?? null);
  const approved = $derived(scriptStep?.state === 'approved' || scriptStep?.state === 'done');
  const canFixAll = $derived(script.isFixture || scriptStep?.state === 'in_review' || approved);
  $effect(() => {
    script.reopenStage = approved ? (scriptStatus?.key ?? 'script') : null;
  });
  const fixTitle = $derived(
    !canFixAll
      ? 'Mortiflix is still writing the script: Fix it once it is waiting for you'
      : approved
        ? 'Reopens the approved script with your note. The voice then re-reads only the lines that change, cost shown first'
        : 'Tell Mortiflix what to change in the whole script',
  );
</script>

<div class="tools">
  <ScriptSummary />
  <div class="right">
    <span class="keys" aria-hidden="true"><kbd>Enter</kbd> OK <kbd>E</kbd> Edit <kbd>F</kbd> Fix</span>
    <Button
      size="sm"
      variant="text"
      aria-expanded={script.fixOpen === 'all'}
      disabled={script.fixSending !== null || !canFixAll}
      title={fixTitle}
      onclick={() => (script.fixOpen === 'all' ? script.closeFix() : script.openFix('all'))}
      >Fix whole script…</Button
    >
    <ToggleGroup
      items={SIZES}
      value={script.compact ? 'compact' : 'full'}
      label="Scene list size"
      onpick={(mode) => script.setView(mode)}
    />
  </div>
</div>

<style>
  .tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-8) var(--s-24);
    min-height: var(--h-sm);
  }
  .right {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-16);
    margin-left: auto;
  }
  .keys {
    color: var(--faint);
    font-size: var(--t13);
    white-space: nowrap;
  }
  kbd {
    margin-left: var(--s-4);
    padding: var(--s-2) var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    color: var(--muted);
    font: 600 var(--t12) / 1 var(--mono);
  }
</style>
