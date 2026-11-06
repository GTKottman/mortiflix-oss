<!-- One note on this scene: the marked frame, where it points, its words, its state, and what can be done with
     it. Clicking the row links it with its marker on the timeline. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import NoteActions from './NoteActions.svelte';
  import NoteEditor from './NoteEditor.svelte';
  import NoteMeta from './NoteMeta.svelte';
  import NoteThumb from './NoteThumb.svelte';
  import NoteWords from './NoteWords.svelte';
  import { useMotion } from './motion.svelte';
  import { noteVersion } from './scenes';
  import type { SceneNote } from './types';

  interface Props {
    note: SceneNote;
  }

  let { note }: Props = $props();

  const motion = useMotion();

  let editing = $state(false);
  let edited = $state('');

  const transcript = $derived(motion.transcripts[note.id]);
  const lesson = $derived(motion.lessons.find((entry) => entry.id === note.lesson));
  const undecided = $derived(lesson !== undefined && !lesson.approved);
  const version = $derived(noteVersion(note, motion.latest));
  const older = $derived(version !== (motion.viewed?.n ?? motion.latest));
  const words = $derived(
    note.text
      ? `“${note.text}”`
      : transcript?.state === 'done' && transcript.text
        ? `“${transcript.text}”`
        : note.audio
          ? 'Spoken note'
          : 'Marks on the frame',
  );

  function startEdit() {
    edited = note.text ?? '';
    editing = true;
  }

  async function saveEdit() {
    if (await motion.editNote(note.id, edited)) editing = false;
  }
</script>

<!-- The row is also reachable by its time link and the timeline marker, so it needs no key of its own. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  id={`note-${note.id}`}
  class="item"
  class:wait={undecided}
  class:sel={motion.selected === note.id}
  class:hl={motion.highlighted === note.id}
  class:old={older}
  onclick={() => {
    if (!editing) motion.pickNote(note);
  }}
>
  <NoteThumb {note} />
  <div class="body">
    <NoteMeta {note} version={older ? version : null} />
    {#if editing}
      <NoteEditor bind:text={edited} onsave={saveEdit} oncancel={() => (editing = false)} />
    {:else}
      <NoteWords {words} resolved={note.resolved === true} audio={note.audio} {transcript} />
      {#if undecided}
        <span class="rule">
          <b>! A lesson is suggested.</b>
          <Button
            size="sm"
            variant="text"
            onclick={(event) => {
              event.stopPropagation();
              motion.tab = 'lessons';
            }}>Decide in Lessons ›</Button
          >
        </span>
      {/if}
      <NoteActions {note} onedit={startEdit} />
    {/if}
  </div>
</article>

<style>
  .item {
    --remove-opacity: 0;
    display: grid;
    grid-template-columns: var(--motion-thumb-w) 1fr;
    gap: var(--s-12);
    min-width: 0;
    padding: var(--s-12) 0 var(--s-12) var(--s-12);
    border-bottom: 1px solid var(--line);
    cursor: pointer;
  }
  .item:hover,
  .item:focus-within {
    --remove-opacity: 1;
  }
  .wait {
    box-shadow: inset var(--motion-edge-w) 0 0 var(--warn);
  }
  .sel {
    background: var(--ink-2);
    box-shadow: inset var(--motion-edge-w) 0 0 var(--text);
  }
  .old {
    opacity: 0.6;
  }
  .hl {
    animation: highlight 2s var(--ease);
  }
  @keyframes highlight {
    from {
      background: var(--ink-3);
    }
    to {
      background: transparent;
    }
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--s-4);
    min-width: 0;
  }
  .rule {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t13);
  }
  .rule b {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--warn);
    font-weight: 600;
  }
  @media (pointer: coarse) {
    .item {
      --remove-opacity: 1;
    }
  }
  @media (max-width: 1599px) {
    .item {
      --motion-thumb-w: 80px;
      grid-template-columns: var(--motion-thumb-w) 1fr;
    }
  }
  @media (max-width: 559px) {
    .item {
      grid-template-columns: 1fr;
    }
  }
</style>
