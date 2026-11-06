<!-- Pen, arrow, circle and eraser, and Undo for the last mark. -->
<script lang="ts">
  import type { Mark, MarkTool } from '../review/marks';
  import Button from './Button.svelte';

  interface Props {
    tool: MarkTool;
    marks: Mark[];
  }

  const TOOLS: { id: MarkTool; label: string }[] = [
    { id: 'pen', label: '✎ Pen' },
    { id: 'arrow', label: '↗ Arrow' },
    { id: 'circle', label: '○ Circle' },
    { id: 'eraser', label: '⌫ Eraser' },
  ];

  let { tool = $bindable(), marks = $bindable() }: Props = $props();
</script>

<div class="tools" role="group" aria-label="Pen tools">
  {#each TOOLS as entry (entry.id)}
    <Button size="sm" pressed={tool === entry.id} onclick={() => (tool = entry.id)}>{entry.label}</Button>
  {/each}
  <Button size="sm" disabled={!marks.length} onclick={() => (marks = marks.slice(0, -1))}>↶ Undo</Button>
</div>

<style>
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
