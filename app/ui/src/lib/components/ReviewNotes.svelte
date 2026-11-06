<!-- The notes on this piece, newest last, with the lesson decision under each note that proposed one.
     A note not sent yet can be removed. A lesson waiting for a decision gets a warn edge. Once decided, its buttons
     go away: the focus moves to the note, not to the page. Edit opens the Lessons screen and says so. -->
<script lang="ts">
  import { tick } from 'svelte';
  import { thumbUrl } from '../files';
  import { routeHref } from '../router.svelte';
  import { useProblems, useRouter } from '../stores/context';
  import type { Lesson, ReviewItem, ReviewService } from '../review/types';
  import Button from './Button.svelte';
  import LessonActions from './LessonActions.svelte';
  import ReviewSection from './ReviewSection.svelte';
  import StatusMark from './StatusMark.svelte';

  interface Props {
    item: ReviewItem;
    lessons: readonly Lesson[];
    service: ReviewService;
    projectTitle?: string;
    onchange: () => void;
  }

  let { item, lessons, service, projectTitle = '', onchange }: Props = $props();

  const problems = useProblems();
  const router = useRouter();
  const waiting = $derived(item.notes.filter((note) => note.pending).length);

  /** The notes by id, to put the focus back on one whose lesson buttons went away. */
  const noteBoxes: Record<string, HTMLElement> = {};
  /** The note whose lesson was just decided; its buttons go when the lessons come back. */
  let decided = $state<string | null>(null);

  $effect(() => {
    void lessons;
    const id = decided;
    if (!id) return;
    void tick().then(() => {
      if (!document.activeElement || document.activeElement === document.body) noteBoxes[id]?.focus();
    });
  });

  function lessonDecided(id: string) {
    decided = id;
    onchange();
  }

  /** The note being removed: a second press while it goes does not send a second delete. */
  let removing = $state<string | null>(null);

  async function remove(id: string) {
    if (removing) return;
    removing = id;
    try {
      await service.call('notes.delete', { note: id });
      problems.clear('note-remove');
      onchange();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: 'note-remove', kind: 'warn', text: `The note was not removed: ${reason}` });
    } finally {
      removing = null;
    }
  }
</script>

<ReviewSection title={waiting ? `Notes · ${waiting} not sent` : 'Notes'}>
  {#snippet aside()}<a href={routeHref('/lessons')}>All lessons ›</a>{/snippet}
  {#each item.notes as note (note.id)}
    {@const lesson = lessons.find((entry) => entry.id === note.lesson)}
    {@const undecided = lesson !== undefined && !lesson.approved}
    <div
      class="note"
      class:lessonwait={undecided}
      class:withpicture={note.image}
      tabindex="-1"
      bind:this={noteBoxes[note.id]}
    >
      {#if note.image}
        <div class="th">
          <img src={thumbUrl(note.image, 192)} alt="Your marks on the frame" loading="lazy" />
        </div>
      {/if}
      <div class="body">
        <div class="tx" title={note.text ?? ''}>{note.text || 'A marked picture'}</div>
        <div class="meta">
          {#if note.pending}
            <span>Not sent</span>
            <span class="rm"
              ><Button size="sm" variant="text" onclick={() => remove(note.id)}>Remove</Button></span
            >
          {:else}
            <StatusMark mark="ok" glyph="✓" text="Sent" />
          {/if}
        </div>
        {#if lesson && undecided}
          <LessonActions
            {service}
            lessonId={lesson.id}
            {projectTitle}
            onchange={() => lessonDecided(note.id)}
            editLabel="Edit in Lessons ›"
            onedit={() => router.go('/lessons')}
          />
        {/if}
      </div>
    </div>
  {:else}
    <p class="empty">No notes. If it's right, press OK.</p>
  {/each}
</ReviewSection>

<style>
  .note:focus {
    outline: none;
  }
  .note:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 2px;
  }
  .note {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-12);
    padding: var(--s-12) 0;
    border-bottom: 1px solid var(--line);
  }
  .note.withpicture {
    grid-template-columns: 96px 1fr;
  }
  .lessonwait {
    box-shadow: inset 3px 0 0 var(--warn);
    padding-left: var(--s-12);
  }
  .th {
    position: relative;
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    background: var(--ink-3);
    overflow: hidden;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--s-4);
    min-width: 0;
  }
  .tx {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: var(--t14);
  }
  .meta {
    display: flex;
    white-space: nowrap;
    align-items: center;
    gap: var(--s-12);
    min-height: 22px;
    margin-top: var(--s-4);
    color: var(--muted);
    font-size: var(--t12);
  }
  .rm {
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .note:hover .rm,
  .note:focus-within .rm {
    opacity: 1;
  }
  @media (pointer: coarse) {
    .rm {
      opacity: 1;
    }
  }
  .empty {
    color: var(--muted);
    font-size: var(--t14);
    padding: var(--s-4) 0;
  }
</style>
