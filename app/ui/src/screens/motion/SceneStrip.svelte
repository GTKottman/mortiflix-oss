<!-- Every scene as a numbered square, with Previous and Next either side: where you are and what is ready, at a
     glance. A scene that waits cannot be opened; the next one waits for this one's approval. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useMotion } from './motion.svelte';
  import { statusOf } from './scenes';

  const motion = useMotion();

  const previous = $derived(motion.scenes[motion.index - 1]);
  const next = $derived(motion.scenes[motion.index + 1]);
</script>

<div class="strip">
  <Button
    size="sm"
    square
    aria-label="Previous scene"
    disabled={!previous}
    onclick={() => previous && motion.select(previous.beat)}>‹</Button
  >
  <div class="dots" role="group" aria-label="Scenes">
    {#each motion.scenes as scene, i (scene.beat)}
      {@const status = statusOf(scene, i, motion.why)}
      <button
        type="button"
        class="dot {scene.state === 'waiting' ? 'waits' : status.mark}"
        class:here={scene.beat === motion.beat}
        disabled={scene.state === 'waiting'}
        aria-current={scene.beat === motion.beat ? 'true' : undefined}
        title={`Scene ${i + 1} · ${scene.name} · ${status.text}`}
        onclick={() => motion.select(scene.beat)}>{i + 1}</button
      >
    {/each}
  </div>
  <Button
    size="sm"
    square
    aria-label="Next scene"
    disabled={!next || next.state === 'waiting'}
    title={next?.state === 'waiting'
      ? `Scene ${motion.index + 2} waits for scene ${motion.index + 1} approval`
      : undefined}
    onclick={() => next && motion.select(next.beat)}>›</Button
  >
</div>

<style>
  .strip {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-8);
  }
  .dots {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 5px;
  }
  .dot {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    color: var(--text);
    font: 600 var(--t12) / 1 var(--body);
    cursor: pointer;
    transition:
      transform 200ms var(--ease-out-expo),
      border-color 160ms ease,
      background 160ms ease;
  }
  .dot:hover:not(:disabled) {
    border-color: var(--line-hover);
    transform: translateY(-2px);
  }
  .dot:active:not(:disabled) {
    transform: scale(0.94);
  }
  .dot:disabled {
    color: var(--faint);
    cursor: default;
  }
  .dot.ok {
    border-color: var(--good-line);
    color: var(--good);
  }
  .dot.fix {
    border-color: var(--warn);
  }
  .dot.busy {
    border-color: color-mix(in srgb, var(--busy) 45%, transparent);
    color: var(--busy);
  }
  .dot.cut {
    border-color: var(--bad-line);
    color: var(--bad);
  }
  .dot.here {
    background: var(--ink-4);
    box-shadow: inset 0 -2px 0 var(--violet);
  }
</style>
