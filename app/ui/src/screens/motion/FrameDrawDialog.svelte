<!-- The Mark screen, the same as on the tablet: back, New note and the moment, Save note; the pen tools and colours over
     the frame; the note's words and the mic on the right. Saving keeps the note with the marks on the frame; nothing
     is fixed until Request fix. It opens on the draft that Mark this frame, Mark range or Scene note pinned. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import MarkCanvas from '../../lib/components/MarkCanvas.svelte';
  import { NoteRecorder } from '../../lib/review/note-recorder.svelte';
  import { MARK_COLOURS, paintMarks, type Mark, type MarkTool } from '../../lib/review/marks';
  import type { MarkIconName } from './mark-icons';
  import MarkIcon from './MarkIcon.svelte';
  import { clipUrl } from './media';
  import { useMotion } from './motion.svelte';
  import { draftWhere, NOTE_TYPES } from './scenes';

  const TOOLS: { id: MarkTool; label: string; icon: MarkIconName }[] = [
    { id: 'pen', label: 'Pen', icon: 'pen' },
    { id: 'highlighter', label: 'Highlighter', icon: 'highlighter' },
    { id: 'arrow', label: 'Arrow', icon: 'arrow' },
    { id: 'circle', label: 'Circle', icon: 'circle' },
    { id: 'marker', label: 'Numbered marker', icon: 'marker' },
    { id: 'eraser', label: 'Eraser', icon: 'eraser' },
  ];
  const COLOUR_NAMES = ['Red', 'Yellow', 'Green', 'Blue', 'White', 'Black'];
  const REST = 'Press the mic and speak; your words are written out after you save.';
  /** notes.save asks Claude for one suggested lesson per note with words (up to 300 tokens): said before saving. */
  const LESSON_CALL =
    'Each note with words also asks Claude for a suggested lesson: a short call on your Claude plan.';

  const motion = useMotion();
  const recorder = new NoteRecorder();
  const draft = motion.draft;
  const start = draft.mode === 'scene' ? 0 : draft.time;

  let dialog = $state<HTMLDialogElement>();
  let media = $state<HTMLVideoElement | HTMLImageElement>();
  let size = $state({ width: 16, height: 9 });
  let tool = $state<MarkTool>('pen');
  let colour = $state<string>(MARK_COLOURS[0]);
  let marks = $state<Mark[]>([]);
  let undone = $state<Mark[]>([]);
  let saving = $state(false);
  let asking = $state(false);
  let note = $state({ words: '', failed: false });

  const path = $derived(motion.media.path);
  const isVideo = $derived(motion.media.video);
  const dirty = $derived(
    marks.length > 0 || motion.draft.text.trim() !== '' || recorder.audio !== null || recorder.recording,
  );
  const message = $derived(
    recorder.recording
      ? '● Recording… press the mic again when you are done.'
      : note.words || (recorder.audio ? 'Voice note kept. It is written out after you save.' : REST),
  );

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  const say = (words: string, failed = false) => (note = { words, failed });

  function loaded() {
    if (media instanceof HTMLVideoElement) {
      size = { width: media.videoWidth, height: media.videoHeight };
      media.currentTime = Math.min(start, media.duration);
    } else if (media) {
      size = { width: media.naturalWidth, height: media.naturalHeight };
    }
  }

  function undo() {
    const last = marks[marks.length - 1];
    if (!last) return;
    marks = marks.slice(0, -1);
    undone = [...undone, last];
  }

  function redo() {
    const last = undone[undone.length - 1];
    if (!last) return;
    undone = undone.slice(0, -1);
    marks = [...marks, last];
  }

  /** The frame with the marks painted on at its full size. */
  function markedFrame(shown: CanvasImageSource): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = size.width;
    out.height = size.height;
    const context = out.getContext('2d');
    context?.drawImage(shown, 0, 0, size.width, size.height);
    if (context) paintMarks(context, { x: 0, y: 0, w: out.width, h: out.height }, marks, colour);
    return out;
  }

  async function save() {
    if (saving || !media) return;
    const { text } = motion.draft;
    if (!text.trim() && !marks.length && !recorder.audio) {
      say('Mark the frame or write or speak a note first.', true);
      return;
    }
    recorder.stop();
    saving = true;
    say('');
    try {
      // A seek still in flight would paint the old frame under the marks.
      if (media instanceof HTMLVideoElement && media.seeking) {
        const shown = media;
        await new Promise<void>((resolve) =>
          shown.addEventListener('seeked', () => resolve(), { once: true }),
        );
      }
      await motion.saveDrawing({ canvas: markedFrame(media), time: start, text, audio: recorder.audio });
    } catch (error) {
      saving = false;
      say(`Not saved: ${error instanceof Error ? error.message : 'unknown error'}`, true);
    }
  }

  function close() {
    recorder.stop();
    motion.cancelDraft();
  }

  function back() {
    if (saving) return;
    if (dirty) asking = true;
    else close();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="mark-title"
  oncancel={(event) => {
    event.preventDefault();
    back();
  }}
>
  <header>
    <button type="button" class="tool" aria-label="Back" onclick={back}
      ><MarkIcon name="back" size={24} /></button
    >
    <h2 id="mark-title">New note</h2>
    <p>Scene {motion.index + 1} · {draftWhere(draft, motion.fps)}</p>
    {#if asking}
      <span class="ask" role="group" aria-label="Throw away this note?">
        Throw away this note?
        <Button size="sm" variant="danger" onclick={close}>Throw away</Button>
        <Button size="sm" onclick={() => (asking = false)}>Keep editing</Button>
      </span>
    {/if}
    <Button variant="primary" disabled={saving || !media} onclick={save}
      ><MarkIcon name="check" /> {saving ? 'Saving…' : 'Save note'}</Button
    >
  </header>

  <div class="tools" role="toolbar" aria-label="Pen tools">
    {#each TOOLS as entry (entry.id)}
      <button
        type="button"
        class="tool"
        class:on={tool === entry.id}
        aria-label={entry.label}
        aria-pressed={tool === entry.id}
        title={entry.label}
        onclick={() => (tool = entry.id)}><MarkIcon name={entry.icon} size={22} /></button
      >
    {/each}
    <i></i>
    {#each MARK_COLOURS as entry, index (entry)}
      <button
        type="button"
        class="colour"
        class:on={colour === entry}
        style:--swatch={entry}
        aria-label={COLOUR_NAMES[index]}
        aria-pressed={colour === entry}
        title={COLOUR_NAMES[index]}
        onclick={() => (colour = entry)}
      ></button>
    {/each}
    <i></i>
    <button type="button" class="tool" aria-label="Undo" title="Undo" disabled={!marks.length} onclick={undo}
      ><MarkIcon name="undo" size={22} /></button
    >
    <button type="button" class="tool" aria-label="Redo" title="Redo" disabled={!undone.length} onclick={redo}
      ><MarkIcon name="redo" size={22} /></button
    >
    <button
      type="button"
      class="tool"
      aria-label="Clear the marks"
      title="Clear the marks"
      disabled={!marks.length}
      onclick={() => {
        undone = [];
        marks = [];
      }}><MarkIcon name="trash" size={22} /></button
    >
  </div>

  <div class="stage" style:--mark-aspect={size.width / size.height}>
    <MarkCanvas {size} {tool} {colour} bind:marks ondraw={() => (undone = [])}>
      {#if path && isVideo}
        <video
          bind:this={media}
          src={clipUrl(path)}
          crossorigin="anonymous"
          muted
          playsinline
          preload="auto"
          aria-label="The scene"
          onloadeddata={loaded}
          onerror={() => say('The clip could not be loaded.', true)}
        ></video>
      {:else if path}
        <img
          bind:this={media}
          src={clipUrl(path)}
          crossorigin="anonymous"
          alt="The frame to mark"
          onload={loaded}
        />
      {/if}
    </MarkCanvas>
  </div>

  <div class="side">
    <label for="mark-note">Note</label>
    <textarea
      id="mark-note"
      placeholder="Describe the issue and what you want instead"
      bind:value={motion.draft.text}
      onkeydown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void save();
        }
      }}></textarea>
    <select aria-label="Type of issue (optional)" bind:value={motion.draft.type}>
      {#each NOTE_TYPES as type (type.id)}<option value={type.id}>{type.label}</option>{/each}
    </select>
    <div class="say">
      <button
        type="button"
        class="mic"
        class:rec={recorder.recording}
        aria-label={recorder.recording ? 'Stop recording' : 'Speak the note'}
        aria-pressed={recorder.recording}
        onclick={() => void recorder.toggle(say)}
        ><MarkIcon name={recorder.recording ? 'stop' : 'mic'} size={24} /></button
      >
      <p class:failed={note.failed} role="status">{message}</p>
    </div>
    <p class="cost">{LESSON_CALL}</p>
  </div>
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
    grid-template-columns: minmax(0, 1fr) var(--motion-mark-side-w);
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: var(--s-12) var(--s-24);
  }
  header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--s-12);
    --btn-flex: none;
  }
  h2 {
    font: 600 var(--t-display) / 1.1 var(--display);
  }
  header p {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--muted);
    font: 400 var(--t13) / 1.3 var(--mono);
  }
  .ask {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    font-size: var(--t13);
    --btn-flex: none;
  }
  .tools {
    grid-column: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-4);
  }
  .tools i {
    width: 1px;
    height: var(--s-24);
    margin: 0 var(--s-8);
    background: var(--line-2);
  }
  .tool {
    display: grid;
    place-items: center;
    width: var(--h-lg);
    height: var(--h-lg);
    padding: 0;
    border: 0;
    border-radius: var(--r);
    background: none;
    color: var(--text);
    cursor: pointer;
  }
  .tool:hover:not(:disabled),
  .tool.on {
    background: var(--ink-3);
  }
  .tool:disabled {
    color: var(--faint);
    cursor: default;
  }
  .colour {
    width: var(--s-32);
    height: var(--s-32);
    margin: 0 var(--s-2);
    padding: 0;
    border: 2px solid var(--line-2);
    border-radius: 50%;
    background: var(--swatch);
    cursor: pointer;
  }
  .colour.on {
    border-color: var(--ink);
    box-shadow: 0 0 0 2px var(--text);
  }
  .stage {
    grid-column: 1;
    display: grid;
    place-items: center;
    min-height: 0;
    min-width: 0;
  }
  .stage :global(.frame) {
    max-height: 100%;
    aspect-ratio: var(--mark-aspect, auto);
  }
  img,
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .side {
    grid-column: 2;
    grid-row: 2 / 4;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto auto;
    gap: var(--s-8);
    min-height: 0;
  }
  label {
    color: var(--muted);
    font: 600 var(--t13) / 1.2 var(--display);
  }
  textarea {
    width: 100%;
    padding: var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
    line-height: 1.45;
    resize: none;
  }
  select {
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    color: var(--text);
    font: 400 var(--t13) / 1 var(--body);
  }
  .say {
    display: flex;
    align-items: center;
    gap: var(--s-12);
  }
  .mic {
    display: grid;
    flex: none;
    place-items: center;
    width: var(--motion-play);
    height: var(--motion-play);
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: 50%;
    background: none;
    color: var(--text);
    cursor: pointer;
  }
  .mic:hover {
    background: var(--ink-3);
  }
  .mic.rec {
    border-color: var(--bad);
    color: var(--bad);
  }
  .say p,
  .cost {
    margin: 0;
    color: var(--muted);
    font-size: var(--t13);
    line-height: 1.35;
  }
  .cost {
    color: var(--faint);
    font-size: var(--t12);
  }
  .say p.failed {
    color: var(--bad);
  }
  /* the tablet standing up: the note goes under the frame */
  @media (max-width: 899px) {
    dialog[open] {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr) auto;
    }
    .side {
      grid-column: 1;
      grid-row: 4;
      grid-template-rows: auto var(--s-64) auto auto auto;
    }
  }
</style>
