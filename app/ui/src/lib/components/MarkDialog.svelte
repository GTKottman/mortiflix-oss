<!-- "Mark the frame": the picture full screen, draw on it (pen, arrow, circle, eraser), say or type what is
     wrong, save. The note is kept until Fix. One of the app's full-screen layers, so it is a modal dialog:
     the page behind it cannot be reached and Esc asks before throwing a note away. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Mark, MarkTool } from '../review/marks';
  import { saveNote } from '../review/notes';
  import type { ReviewService } from '../review/types';
  import Button from './Button.svelte';
  import MarkHead from './MarkHead.svelte';
  import MarkCanvas from './MarkCanvas.svelte';
  import { markColour } from '../review/mark-colour';
  import MarkNote from './MarkNote.svelte';
  import MarkTools from './MarkTools.svelte';
  import { NoteRecorder } from '../review/note-recorder.svelte';

  interface Props {
    service: ReviewService;
    /** The piece the note is about. */
    node: string;
    path: string;
    title: string;
    /** Start recording at once (the Speak button). */
    record?: boolean;
    onsaved: () => void;
    onclose: () => void;
  }

  let { service, node, path, title, record = false, onsaved, onclose }: Props = $props();

  const REST = 'Draw on the frame, then say or type what you want.';

  let dialog = $state<HTMLDialogElement>();
  let tool = $state<MarkTool>('pen');
  let marks = $state<Mark[]>([]);
  let text = $state('');
  const recorder = new NoteRecorder();
  let saving = $state(false);
  let asking = $state(false);
  let message = $state(REST);
  let failed = $state(false);

  const dirty = $derived(
    marks.length > 0 || text.trim() !== '' || recorder.audio !== null || recorder.recording,
  );

  $effect(() => {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    if (record) untrack(() => void toggleRecording());
  });

  // The parent can drop the dialog without closing it (a route change): never leave the microphone on.
  $effect(() => () => recorder.stop());

  const toggleRecording = () =>
    recorder.toggle((next, isError) => {
      message = next;
      failed = isError;
    });

  async function save() {
    if (saving) return;
    if (!text.trim() && !marks.length && !recorder.audio) {
      failed = true;
      message = 'Mark the frame or write or speak a note first.';
      return;
    }
    saving = true;
    failed = false;
    message = 'Saving…';
    try {
      await saveNote(service, { node, path, text, marks, audio: recorder.audio }, markColour());
      onsaved();
      close();
    } catch (error) {
      saving = false;
      failed = true;
      message = `Not saved: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  function close() {
    recorder.stop();
    dialog?.close();
  }

  function cancel() {
    if (saving) return;
    if (dirty) asking = true;
    else close();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="mark-title"
  {onclose}
  oncancel={(event) => {
    event.preventDefault();
    cancel();
  }}
>
  <MarkHead
    kicker="Mark the frame"
    {title}
    titleId="mark-title"
    {asking}
    oncancel={cancel}
    onthrow={close}
    onkeep={() => (asking = false)}
  />

  <div class="stage">
    <MarkCanvas {path} {tool} bind:marks />
  </div>

  <footer>
    <div class="row">
      <MarkTools bind:tool bind:marks />
      <MarkNote bind:text {recorder} onrecord={toggleRecording} onsave={() => void save()} />
    </div>
    <div class="save">
      <span class="why">Saving keeps this note. Nothing is fixed until you press Fix.</span>
      <Button variant="primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save note'}</Button>
    </div>
    <p class="message" class:failed role="status">{message}</p>
  </footer>
</dialog>

<style>
  dialog {
    width: 100vw;
    max-width: none;
    height: 100dvh;
    max-height: none;
    margin: 0;
    padding: var(--s-16) var(--s-24);
    border: 0;
    background: var(--ink);
    color: var(--text);
  }
  dialog[open] {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: var(--s-12);
  }
  .stage {
    display: grid;
    place-items: center;
    min-height: 0;
  }
  footer {
    display: grid;
    gap: var(--s-8);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--s-16);
  }
  .save {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-16);
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
  .message {
    color: var(--muted);
    font-size: var(--t13);
  }
  .failed {
    color: var(--bad);
  }
</style>
