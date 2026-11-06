<!-- Say or type what is wrong: the Speak button and the text box (Ctrl+Enter saves). -->
<script lang="ts">
  import Button from './Button.svelte';
  import type { NoteRecorder } from '../review/note-recorder.svelte';

  interface Props {
    text: string;
    recorder: NoteRecorder;
    onrecord: () => void;
    onsave: () => void;
  }

  let { text = $bindable(), recorder, onrecord, onsave }: Props = $props();
</script>

<div class="say">
  <Button size="sm" onclick={onrecord}>
    {recorder.recording ? '■ Stop recording' : recorder.audio ? '● Record again' : '● Speak a note'}
  </Button>
  <textarea
    bind:value={text}
    rows="2"
    placeholder="Type or speak your note · Ctrl+Enter saves"
    aria-label="Note"
    onkeydown={(event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onsave();
      }
    }}></textarea>
</div>

<style>
  .say {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: var(--mark-note-min-w);
    gap: var(--s-8);
  }
  textarea {
    flex: 1;
    padding: var(--s-8) var(--s-12);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--ink-2);
    resize: none;
  }
  textarea:focus-visible {
    outline: none;
    border-color: var(--link);
  }
</style>
