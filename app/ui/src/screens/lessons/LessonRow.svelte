<!-- A lesson the owner has decided: the switch (On / Off) with Edit and ⋯ under it, then its name and its words
     on one line. Off lessons are quieter. A lesson just switched off offers Undo. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import Switch from '../../lib/components/Switch.svelte';
  import LessonEditor from './LessonEditor.svelte';
  import LessonMenu from './LessonMenu.svelte';
  import LessonNote from './LessonNote.svelte';
  import { isOn, lessonName } from './lessons';
  import type { LessonsView } from './lessons.svelte';
  import type { Lesson } from './types';

  interface Props {
    lesson: Lesson;
    view: LessonsView;
  }

  let { lesson, view }: Props = $props();
  const on = $derived(isOn(lesson));
  const editing = $derived(view.editing === lesson.id);
  const noted = $derived(view.noteOpen === lesson.id);
</script>

<li class="lesson" class:off={!on}>
  <div class="controls">
    <Switch
      controlled
      hideLabel
      checked={on}
      label={`Use: ${lessonName(lesson)}`}
      onchange={(next) => view.toggle(lesson, next)}
    />
    <span class="actions">
      {#if view.offId === lesson.id && !lesson.on}
        <Button size="sm" variant="text" onclick={() => view.toggle(lesson, true)}>Undo</Button>
      {/if}
      {#if !editing}
        <Button size="sm" variant="text" onclick={() => (view.editing = lesson.id)}>Edit</Button>
      {/if}
      {#if !editing}<LessonMenu {lesson} {view} />{/if}
    </span>
  </div>
  <div class="body">
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
    {#if noted && !editing}<LessonNote {lesson} />{/if}
  </div>
</li>

<style>
  .lesson {
    --controls-col: 113px;
    --row-pad: var(--s-24);
    --name-size: 18.5px;
    --words-size: var(--t16);
    --action-size: var(--t14);
    --switch-w: 41px;
    --switch-h: 23px;
    --knob: 17px;
    display: grid;
    grid-template-columns: var(--controls-col) minmax(0, 1fr);
    gap: var(--s-16);
    align-items: center;
    padding: var(--row-pad) 0;
    border-bottom: 1px solid var(--line);
    list-style: none;
  }
  .controls {
    display: grid;
    gap: var(--s-4);
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-4);
    margin-left: calc(-1 * var(--s-8));
  }
  .actions :global(button) {
    font-size: var(--action-size);
  }
  .body {
    min-width: 0;
  }
  .name {
    overflow-wrap: anywhere;
    font-size: var(--name-size);
    font-weight: 600;
    line-height: 1.3;
  }
  .text {
    overflow: hidden;
    font-size: var(--words-size);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .off .name,
  .off .text {
    color: var(--muted);
    font-weight: 400;
  }
  @media (max-width: 1599px) {
    .lesson {
      --row-pad: var(--s-16);
      --name-size: var(--t16);
      --words-size: var(--t14);
      --action-size: var(--t12);
      --switch-w: 36px;
      --switch-h: 20px;
      --knob: 14px;
    }
  }
  @media (max-width: 699px) {
    .lesson {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
