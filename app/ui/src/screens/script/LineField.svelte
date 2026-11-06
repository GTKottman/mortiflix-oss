<!-- One line of narration in the editor. Enter saves the scene, Escape cancels; a line has no line breaks, so
     Shift+Enter does nothing. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { autosize } from './autosize';

  interface Props {
    label: string;
    lineId: string;
    words: string;
    readOnly: boolean;
    autofocus: boolean;
    oninput: (typed: string) => void;
    onsave: () => void;
    oncancel: () => void;
  }

  let { label, lineId, words, readOnly, autofocus, oninput, onsave, oncancel }: Props = $props();

  // The box keeps what was typed (spaces and all); only the first words are the starting value.
  const start = untrack(() => words);
  let text = $state(start);
  let field = $state<HTMLTextAreaElement>();

  // Focus once, when the box appears: a later change of which line is focused must not pull focus back here.
  $effect(() => {
    if (!field || !untrack(() => autofocus)) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
</script>

<label>
  <span class="name">{label}</span>
  <textarea
    bind:this={field}
    bind:value={text}
    use:autosize={text}
    rows="1"
    data-line={lineId}
    spellcheck="true"
    readonly={readOnly}
    title={readOnly ? 'Still being written' : undefined}
    oninput={() => oninput(text)}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        oncancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.shiftKey) onsave();
      }
    }}></textarea>
</label>

<style>
  label {
    display: grid;
    gap: var(--s-4);
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .name {
    white-space: nowrap;
  }
  textarea {
    width: 100%;
    padding: var(--s-8) var(--s-12);
    overflow: hidden;
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink);
    caret-color: var(--text);
    color: var(--text);
    font: 400 var(--t16) / 1.6 var(--body);
    letter-spacing: 0;
    text-transform: none;
    resize: none;
  }
  textarea:focus {
    border-color: var(--text);
    outline: var(--focus);
    outline-offset: 0;
  }
  textarea[readonly] {
    border-style: dashed;
    color: var(--muted);
  }
</style>
