<!-- Every scene with its state; click one to look at it. Below it, "Make remaining scenes" as a small separate
     choice: the default is one at a time, so each scene gets the lessons from the one before. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { plural } from '../../lib/words';
  import { useMotion } from './motion.svelte';
  import { sceneLength, shotsOf, statusOf } from './scenes';

  const SCENE_COLOURS = 6;

  const motion = useMotion();

  const waiting = $derived(motion.scenes.filter((scene) => scene.state === 'waiting').length);
  const length = (beat: string): number | undefined => sceneLength(shotsOf(motion.plan, beat));
</script>

{#if !motion.scenes.length}
  <EmptyState title="No scenes yet" />
{:else}
  <div class="scenes" role="group" aria-label="Scenes">
    {#each motion.scenes as scene, i (scene.beat)}
      {@const status = statusOf(scene, i, motion.why)}
      {@const seconds = length(scene.beat)}
      <button
        class="scene"
        class:sel={scene.beat === motion.beat}
        style:--edge={`var(--scene-${(i % SCENE_COLOURS) + 1})`}
        type="button"
        disabled={scene.state === 'waiting'}
        aria-current={scene.beat === motion.beat ? 'true' : undefined}
        onclick={() => motion.select(scene.beat)}
      >
        <span class="n">{i + 1}</span>
        <span class="name">
          {scene.name}
          <span class="status"
            ><StatusMark
              mark={status.mark}
              text={`${status.text}${scene.tablet?.status === 'reviewing' ? ' · on tablet' : ''}`}
            /></span
          >
        </span>
        {#if seconds}<i>{seconds.toFixed(1)} s</i>{:else}<i></i>{/if}
      </button>
    {/each}
  </div>
  <div class="batch">
    {#if motion.list?.mode === 'all'}
      <p>All remaining scenes are being made in one go.</p>
    {:else if waiting && !motion.soon}
      <h3>Batch production</h3>
      <p>
        The studio makes one scene at a time so each gets your lessons. Making the rest at once skips that.
      </p>
      <Button size="sm" onclick={() => void motion.askRest()}
        >Make remaining {plural(waiting, 'scene')}…</Button
      >
    {/if}
  </div>
{/if}

<style>
  .scenes {
    display: grid;
  }
  .scene {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    gap: var(--s-8);
    align-items: center;
    min-height: 52px;
    padding: var(--s-8) 0 var(--s-8) var(--s-12);
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    color: var(--text);
    font: 400 var(--t14) / 1.3 var(--body);
    text-align: left;
    cursor: pointer;
  }
  .scene:hover:not(:disabled) {
    background: var(--ink-2);
  }
  .scene:disabled {
    color: var(--muted);
    cursor: default;
  }
  .sel {
    box-shadow: inset 3px 0 0 var(--edge, var(--text));
    font-weight: 600;
  }
  .n {
    white-space: nowrap;
    color: var(--muted);
    font: 400 var(--t12) / 1 var(--mono);
  }
  .name {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  .status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t12);
    font-weight: 400;
  }
  i {
    white-space: nowrap;
    padding-right: var(--s-4);
    color: var(--faint);
    font: 400 var(--t12) / 1 var(--mono);
  }
  .batch {
    display: grid;
    gap: var(--s-8);
    justify-items: start;
    padding-top: var(--s-16);
  }
  .batch p {
    max-width: 60ch;
    color: var(--muted);
    font-size: var(--t13);
  }
  h3 {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
</style>
