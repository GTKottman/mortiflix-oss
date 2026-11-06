<!-- The scene's lines as text boxes. Typing keeps the words as an unsaved edit; nothing is voiced or charged. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import LineField from './LineField.svelte';
  import { useScript } from './script.svelte';
  import { wordsNow } from './timing';
  import type { Beat } from './types';

  interface Props {
    beat: Beat;
  }

  let { beat }: Props = $props();
  const script = useScript();

  // Focus the line that was clicked (when it is in this scene), else the first one that can be changed.
  const fresh = $derived(script.added[beat.id] ?? []);
  const removed = (id: string) => script.drafts[id] === '';
  let newFocus = $state<string | null>(null);

  async function add() {
    newFocus = script.addLine(beat);
    await tick();
    document.querySelector<HTMLTextAreaElement>(`[data-line="${newFocus}"]`)?.focus();
  }

  const focusId = $derived(
    beat.lines.find((l) => l.id === script.editLine && !l.read_only)?.id ??
      beat.lines.find((l) => !l.read_only)?.id ??
      null,
  );
</script>

<div class="ed">
  {#each beat.lines as line, k (line.id)}
    {#if removed(line.id)}
      <div class="gone">
        <span class="name">Line {k + 1}</span>
        <s>{line.words}</s>
        <span class="note">Removed on Save</span>
        <Button size="sm" variant="text" onclick={() => script.keepLine(line.id)}>Undo</Button>
      </div>
    {:else}
      <div class="row">
        <LineField
          label={beat.lines.length > 1 || fresh.length ? `Line ${k + 1}` : 'Narration'}
          lineId={line.id}
          words={wordsNow(line.id, line.words, script.drafts)}
          readOnly={line.read_only ?? false}
          autofocus={line.id === focusId}
          oninput={(typed) => script.setDraft(beat, line.id, typed)}
          onsave={() => void script.save(beat)}
          oncancel={() => script.cancel(beat)}
        />
        {#if !line.read_only}
          <button
            class="x"
            type="button"
            aria-label={`Remove line ${k + 1}`}
            title="Remove this line (on Save; Undo brings it back)"
            onclick={() => script.removeLine(line.id)}>✕</button
          >
        {/if}
      </div>
    {/if}
  {/each}
  {#each fresh as line, k (line.key)}
    <div class="row">
      <LineField
        label={`New line ${beat.lines.length + k + 1}`}
        lineId={line.key}
        words={line.words}
        readOnly={false}
        autofocus={line.key === newFocus}
        oninput={(typed) => script.setNewLine(beat, line.key, typed)}
        onsave={() => void script.save(beat)}
        oncancel={() => script.cancel(beat)}
      />
      <button
        class="x"
        type="button"
        aria-label={`Drop new line ${beat.lines.length + k + 1}`}
        title="Drop this new line"
        onclick={() => script.dropNewLine(beat, line.key)}>✕</button
      >
    </div>
  {/each}
  <div>
    <Button size="sm" variant="text" onclick={() => void add()}>+ Add line</Button>
    <span class="note">An emptied line is removed on Save.</span>
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-8);
    align-items: end;
  }
  .x {
    width: var(--h-sm);
    height: var(--h-sm);
    border: 1px solid transparent;
    border-radius: var(--r);
    background: none;
    color: var(--faint);
    cursor: pointer;
  }
  .x:hover {
    border-color: var(--line-2);
    color: var(--text);
  }
  .x:focus-visible {
    outline: var(--focus);
    outline-offset: 1px;
  }
  .gone {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-4) var(--s-12);
    color: var(--faint);
  }
  .gone .name {
    font-size: var(--t12);
  }
  .note {
    color: var(--faint);
    font-size: var(--t13);
  }
  .ed {
    display: grid;
    gap: var(--s-8);
    max-width: 70ch;
  }
</style>
