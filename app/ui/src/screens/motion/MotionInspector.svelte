<!-- Beside the video: this scene's notes, then every scene and the lessons as two rows that fold away. One is
     open at a time, and motion.tab says which, so "View progress" and a note's lesson link still open the right one. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Accordion from '../../lib/components/Accordion.svelte';
  import LessonsPanel from './LessonsPanel.svelte';
  import { plural } from '../../lib/words';
  import { useMotion } from './motion.svelte';
  import NotesPanel from './NotesPanel.svelte';
  import ScenesPanel from './ScenesPanel.svelte';

  const motion = useMotion();

  let scenes = $state<HTMLDivElement>();
  let lessons = $state<HTMLDivElement>();

  // Opened from anywhere, the row comes into view: it can sit below the bottom bar.
  $effect(() => {
    const row = motion.tab === 'scenes' ? scenes : motion.tab === 'lessons' ? lessons : undefined;
    if (row) void tick().then(() => row.scrollIntoView({ block: 'nearest' }));
  });

  const opener = (tab: string) => (open: boolean) => {
    motion.tab = open ? tab : 'notes';
  };
</script>

<section class="notes" aria-label="Notes on this scene">
  <div class="title">
    <h2>Notes · {motion.sceneNotes.length}</h2>
    {#if motion.unresolved.length}<span>{plural(motion.unresolved.length, 'note')} to fix</span>{/if}
  </div>
  <NotesPanel />
</section>
<div class="folds">
  <div class="fold" bind:this={scenes}>
    <Accordion
      title="Scenes"
      summary={`${motion.done}/${motion.total} approved`}
      bind:open={() => motion.tab === 'scenes', opener('scenes')}
    >
      <p class="legend">
        <span><i class="fix"></i>Ready for review</span>
        <span><i class="ok"></i>Approved</span>
        <span><i class="busy"></i>Being made</span>
        <span><i class="waits"></i>Waiting</span>
      </p>
      <ScenesPanel />
    </Accordion>
  </div>
  <div class="fold" bind:this={lessons}>
    <Accordion
      title="Lessons"
      summary={String(motion.lessons.length)}
      bind:open={() => motion.tab === 'lessons', opener('lessons')}><LessonsPanel /></Accordion
    >
  </div>
</div>

<style>
  .notes {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-8);
  }
  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-12);
  }
  h2 {
    font: 600 var(--t16) / 1.2 var(--display);
  }
  .title span {
    color: var(--muted);
    font-size: var(--t13);
  }
  .folds {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-8);
  }
  .fold {
    min-width: 0;
    /* clear of the bottom bar when it scrolls into view */
    scroll-margin-bottom: 140px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-4) var(--s-16);
    margin: 0;
    color: var(--faint);
    font-size: var(--t12);
  }
  .legend i {
    display: inline-block;
    width: var(--s-8);
    height: var(--s-8);
    margin-right: var(--s-8);
    border-radius: 2px;
  }
  i.fix {
    background: var(--warn);
  }
  i.ok {
    background: var(--good);
  }
  i.busy {
    background: var(--busy);
  }
  i.waits {
    background: var(--ink-4);
  }
</style>
