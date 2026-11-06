<!-- Change the words of a note. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    text: string;
    onsave: () => void;
    oncancel: () => void;
  }

  let { text = $bindable(), onsave, oncancel }: Props = $props();

  let box = $state<HTMLTextAreaElement>();
  // Edit puts the cursor in the words; Escape cancels, Ctrl+Enter saves.
  onMount(() => box?.focus());

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onsave();
    }
  }
</script>

<textarea aria-label="Edit note" bind:this={box} bind:value={text} onkeydown={onKey}></textarea>
<div class="row">
  <Button size="sm" onclick={onsave}>Save</Button>
  <Button size="sm" variant="text" onclick={oncancel}>Cancel</Button>
</div>

<style>
  textarea {
    display: block;
    width: 100%;
    min-height: var(--motion-edit-min-h);
    padding: var(--s-4) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
    resize: vertical;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    margin-top: var(--s-4);
  }
</style>
