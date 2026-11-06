<!-- What the picture's place says while there is no video to play: waiting, being made, failed, no picture yet.
     Never an unexplained blank box. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import WaitingAction from '../../lib/components/WaitingAction.svelte';
  import { plural } from '../../lib/words';
  import Elapsed from '../../lib/components/Elapsed.svelte';
  import { useMotion } from './motion.svelte';
  import { etaText, sceneWaitWords } from './scenes';

  const motion = useMotion();

  const scene = $derived(motion.scene);
  const n = $derived(motion.index + 1);
  const since = $derived(scene ? motion.makingSince[scene.beat] : undefined);
  /** Why scene 1 (or a scene whose turn it is) is not there: being made, failed or waiting for something named. */
  const wait = $derived(scene ? sceneWaitWords(scene, motion.index, motion.why) : null);
</script>

{#if scene}
  {#if wait?.startsWith('Failed: ')}
    <div class="cover centre" role="alert">
      <b>Scene {n} could not be made</b>
      <span>{wait.slice(8)}</span>
      {#if motion.work}
        <div class="actions">
          <WaitingAction
            words={{ title: '', body: '', idle: true }}
            work={motion.work}
            label="Make it again"
          />
        </div>
      {/if}
    </div>
  {:else if wait === 'Being made.'}
    <div class="cover" role="status">
      <div class="pulse"></div>
      <b class="busy">Making scene {n}…</b>
      <span>The scene appears here when it is ready.</span>
    </div>
  {:else if wait?.startsWith('Waiting: ') && motion.why?.waiting}
    <div class="cover centre" role="status">
      <b>Scene {n} waits</b>
      <span>{wait.slice(9)}</span>
      {#if motion.work}
        <div class="actions"><WaitingAction words={motion.why.waiting} work={motion.work} /></div>
      {/if}
    </div>
  {:else if scene.state === 'waiting'}
    <div class="cover centre">
      {#if n > 1}
        <b>Scene {n} waits for scene {n - 1} approval</b>
        <span
          >It is made only after scene {n - 1} is approved, so it gets every lesson from your notes on scene {n -
            1}.</span
        >
      {:else}
        <b>Scene {n} is not made yet</b>
      {/if}
    </div>
  {:else if scene.state === 'making' && motion.waiting}
    <div class="cover centre" role="status">
      <b>{motion.waiting.title}</b>
      <span>{motion.waiting.body}</span>
      {#if motion.work}
        <div class="actions"><WaitingAction words={motion.waiting} work={motion.work} /></div>
      {/if}
    </div>
  {:else if scene.state === 'making' && motion.work?.here}
    <div class="cover" role="status">
      <div class="pulse"></div>
      <b class="busy"
        >Generating scene {n} with {plural(motion.lessonsUsed, 'lesson')}{etaText(
          scene,
        )}{#if since !== undefined}
          · <Elapsed {since} /> so far{/if}</b
      >
      <span>The scene appears here when it is ready. Notes and lessons you add now are kept.</span>
    </div>
  {:else if scene.state === 'failed' || scene.error}
    <div class="cover centre" role="alert">
      <b>Scene {n} could not be made</b>
      <span>{scene.error || 'The studio reported a failure. Your notes are kept.'}</span>
      <div class="actions">
        <Button size="sm" onclick={() => (motion.tab = 'scenes')}>View progress</Button>
      </div>
    </div>
  {:else if !motion.media.path}
    <div class="cover centre">
      <b>No picture for this scene yet</b>
      <span>The look for this scene has no picture. Check the Look and Stills steps.</span>
    </div>
  {:else}
    <div class="cover">
      <b>Still from the look</b>
      <span>The video comes after this scene is made.</span>
    </div>
  {/if}
{/if}

<style>
  .cover {
    position: absolute;
    inset: 0;
    display: grid;
    align-content: end;
    gap: var(--s-4);
    padding: var(--s-24);
    background: linear-gradient(to top, color-mix(in srgb, var(--media) 78%, transparent), transparent 60%);
  }
  .centre {
    align-content: center;
    justify-items: start;
    background: color-mix(in srgb, var(--media) 55%, transparent);
  }
  b {
    font: 600 var(--t16) / 1.3 var(--body);
  }
  span {
    max-width: 60ch;
    color: var(--muted);
    font-size: var(--t13);
  }
  .busy {
    color: var(--busy);
  }
  .actions {
    display: flex;
    gap: var(--s-8);
    margin-top: var(--s-8);
  }
  .pulse {
    width: var(--motion-pulse-w);
    height: 2px;
    background: var(--busy);
    animation: mfx-pulse 1.2s var(--ease) infinite;
  }
</style>
