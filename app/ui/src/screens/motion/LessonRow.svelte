<!-- One lesson: its name, its words, where it came from, and what can be done. A suggestion waits for the owner's decision
     (every project, only this one, not a lesson); the owner's own rules can be edited and switched off. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import LessonActions from '../../lib/components/LessonActions.svelte';
  import { useProject } from '../../lib/stores/context';
  import { useMotion } from './motion.svelte';
  import { clock, shotsOf } from './scenes';
  import type { SceneLesson } from './types';

  interface Props {
    lesson: SceneLesson;
    /** One of the owner's approved rules (not a suggestion). */
    mine: boolean;
  }

  const SNIPPET = 60;

  let { lesson, mine }: Props = $props();

  const motion = useMotion();
  const project = useProject();

  let editing = $state(false);
  let edited = $state('');

  const source = $derived(motion.notes.find((note) => note.lesson === lesson.id));
  const sceneOf = $derived(
    source
      ? motion.scenes.findIndex((scene) =>
          shotsOf(motion.plan, scene.beat).some((shot) => shot.node === source.node),
        ) + 1
      : 0,
  );
  const origin = $derived(
    source
      ? `From your note on scene ${sceneOf || '?'}${source.kind === 'scene' ? '' : ` at ${clock(source.time ?? 0)}`}: “${(source.text || 'spoken note').slice(0, SNIPPET)}”`
      : lesson.scope === 'all'
        ? 'Project-wide rule from an earlier project'
        : 'Added to this project',
  );
  const on = $derived(lesson.on !== false);

  function startEdit() {
    edited = lesson.text;
    editing = true;
  }

  async function save() {
    if (await motion.editLesson(lesson.id, edited)) editing = false;
  }
</script>

<article class="les" class:sug={!mine} class:off={mine && !on} data-lesson={lesson.id}>
  {#if editing}
    <textarea aria-label="Lesson" bind:value={edited}></textarea>
    <div class="row">
      <Button size="sm" disabled={!edited.trim()} onclick={save}>Save</Button>
      <Button size="sm" variant="text" onclick={() => (editing = false)}>Cancel</Button>
    </div>
  {:else}
    <span class="n">{lesson.name || lesson.text.slice(0, SNIPPET)}</span>
    <span class="t">{lesson.text}</span>
    <span class="why">{origin}</span>
    <span class="why"
      >{mine
        ? `${lesson.scope === 'all' ? 'Every project' : 'This project'} · ${on ? 'on: used for scenes made after this one' : 'off: not used'}`
        : 'Not used until you approve it.'}</span
    >
    {#if mine}
      <div class="row">
        <Button size="sm" variant="text" onclick={startEdit}>Edit</Button>
        <Button size="sm" variant="text" onclick={() => void motion.switchLesson(lesson)}
          >{on ? 'Turn off' : 'Turn on'}</Button
        >
      </div>
    {:else}
      <LessonActions
        service={motion.service}
        lessonId={lesson.id}
        projectTitle={project.title}
        onchange={() => void motion.load()}
        onedit={startEdit}
      />
    {/if}
  {/if}
</article>

<style>
  .les {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-12) 0 var(--s-12) var(--s-12);
    border-bottom: 1px solid var(--line);
  }
  .off {
    opacity: 0.55;
  }
  .sug {
    box-shadow: inset var(--motion-edge-w) 0 0 var(--warn);
  }
  .n {
    font-size: var(--t14);
    font-weight: 600;
  }
  .t {
    display: -webkit-box;
    overflow: hidden;
    font-size: var(--t13);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .why {
    color: var(--muted);
    font-size: var(--t12);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  textarea {
    display: block;
    width: 100%;
    min-height: var(--motion-edit-min-h);
    padding: var(--s-4) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
  }
</style>
