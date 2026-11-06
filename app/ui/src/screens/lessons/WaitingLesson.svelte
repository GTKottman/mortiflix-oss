<!-- A lesson that needs a decision (or was decided a moment ago and still shows its Undo): highlighted card with
     the lesson, where it came from and the decision. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import LessonActions from '../../lib/components/LessonActions.svelte';
  import { thumbUrl } from '../../lib/files';
  import { useService } from '../../lib/stores/context';
  import LessonEditor from './LessonEditor.svelte';
  import LessonNote from './LessonNote.svelte';
  import { hasNote, lessonName, sourceLine } from './lessons';
  import type { LessonsView } from './lessons.svelte';
  import type { Lesson } from './types';

  interface Props {
    lesson: Lesson;
    view: LessonsView;
    /** The open project's title: "Only in …" when the note does not say which project it came from. */
    project: string;
    /** Decided this visit: no longer waiting, kept in place for its Undo. */
    decided: boolean;
    ondecide: (lesson: Lesson) => void;
  }

  let { lesson, view, project, decided, ondecide }: Props = $props();
  const client = useService();
  const editing = $derived(view.editing === lesson.id);
  const noted = $derived(view.noteOpen === lesson.id);
  const noteShown = $derived(hasNote(lesson));
  const image = $derived(lesson.source?.image);

  const THUMB_PX = 160;
</script>

<li class="lesson" class:has-image={!!image} data-waiting={!decided}>
  {#if image}
    <div class="thumb"><img src={thumbUrl(image, THUMB_PX)} alt="" loading="lazy" decoding="async" /></div>
  {/if}
  <div class="body">
    {#if !lesson.approved}<p class="flag">Needs your decision</p>{/if}
    {#if editing}
      <LessonEditor
        {lesson}
        onsave={(text, section, name) => view.save(lesson, text, section, name)}
        onremove={() => view.remove(lesson)}
        oncancel={() => view.stopEditing()}
      />
    {:else}
      <p class="name">{lessonName(lesson)}</p>
      <p class="text">{lesson.text}</p>
    {/if}
    <p class="source">{sourceLine(lesson)}</p>
    {#if !editing}
      {#if noted}<LessonNote {lesson} />{/if}
      <div class="decision" data-decision>
        <LessonActions
          service={view.decisions ?? client}
          lessonId={lesson.id}
          projectTitle={lesson.source?.project_title ?? project}
          onchange={() => ondecide(lesson)}
          onedit={() => (view.editing = lesson.id)}
        />
        {#if noteShown && !decided}
          <Button size="sm" variant="text" aria-expanded={noted} onclick={() => view.toggleNote(lesson.id)}>
            {noted ? 'Hide note' : 'Note'}
          </Button>
        {/if}
      </div>
    {/if}
  </div>
</li>

<style>
  .lesson {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-16);
    align-items: start;
    margin-top: var(--s-12);
    padding: var(--s-16) var(--s-16) var(--s-16) var(--s-24);
    border-radius: var(--r);
    background: var(--ink-2);
    box-shadow: inset var(--s-4) 0 0 var(--busy);
    list-style: none;
  }
  .has-image {
    grid-template-columns: calc(var(--s-48) * 2 + var(--s-16)) minmax(0, 1fr);
  }
  .flag {
    margin-bottom: var(--s-4);
    color: var(--busy);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .name {
    overflow-wrap: anywhere;
    font-size: var(--t16);
    font-weight: 600;
    line-height: 1.4;
  }
  .text {
    overflow: hidden;
    font-size: var(--t14);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source {
    display: -webkit-box;
    margin-top: var(--s-4);
    overflow: hidden;
    color: var(--muted);
    font-size: var(--t13);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .thumb {
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--r);
    background: var(--ink-4);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .decision {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--s-8);
    margin-top: var(--s-12);
  }
  @media (max-width: 1199px) {
    .has-image {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
