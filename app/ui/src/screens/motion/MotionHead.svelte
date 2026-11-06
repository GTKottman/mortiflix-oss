<!-- The scene's name and where it stands on the left, as on the tablet, and the scene strip on the right. -->
<script lang="ts">
  import { useMotion } from './motion.svelte';
  import SceneStrip from './SceneStrip.svelte';

  const motion = useMotion();

  const all = $derived(motion.total > 0 && motion.done === motion.total);
</script>

{#if motion.scene}
  <div class="head">
    <div class="title">
      <h1>{all ? `All ${motion.total} scenes approved` : motion.scene.name}</h1>
      <p>Scene {motion.index + 1} of {motion.total} · {motion.done}/{motion.total} approved</p>
    </div>
    <SceneStrip />
  </div>
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-8) var(--s-24);
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-4) var(--s-12);
    min-width: 0;
  }
  h1 {
    font: 600 var(--t-display) / 1.1 var(--display);
    letter-spacing: -0.02em;
    text-transform: uppercase;
    overflow-wrap: break-word;
  }
  p {
    margin: 0;
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
