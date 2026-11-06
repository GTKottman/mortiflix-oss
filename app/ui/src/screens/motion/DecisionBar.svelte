<!-- The one stable decision bar: the scene's state, why Approve or Request fix is or is not ready, the scene's ⋯ menu,
     Request fix (F) and Approve scene (Enter). Add note lives with the note field. The gradient goes to Request fix while notes wait, to Approve otherwise. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { useMotion } from './motion.svelte';
  import SceneMenu from './SceneMenu.svelte';

  const motion = useMotion();

  const waiting = $derived(motion.unresolved.length > 0);
  const fixReady = $derived(motion.canDecide && waiting);
  const text = $derived(motion.decisionText);
  /** An older version is on screen: Approve still keeps the newest (the service approves the scene). */
  const olderOnScreen = $derived(motion.viewed !== null && motion.viewed.n !== motion.latest);
</script>

{#if motion.scene}
  <div class="foot">
    <div class="in">
      <div class="state">
        <b><StatusMark mark={motion.sceneStatus.mark} text={motion.sceneStatus.text} /></b>
        <span class="why" title={text}>{text}</span>
      </div>
      <span class="more"><SceneMenu /></span>
      <Button
        size="lg"
        variant={fixReady ? 'primary' : 'secondary'}
        disabled={!fixReady}
        onclick={() => motion.askFix()}>Request fix <kbd aria-hidden="true">F</kbd></Button
      >
      {#if motion.scene.state === 'making'}
        <Button size="lg" variant="primary" onclick={() => (motion.tab = 'scenes')}>View progress</Button>
      {:else}
        <Button
          size="lg"
          variant={motion.canDecide && !waiting ? 'primary' : 'secondary'}
          disabled={!motion.canDecide}
          onclick={() => motion.askApprove()}
          >{motion.scene.state === 'ok'
            ? '✓ Approved'
            : olderOnScreen
              ? `Approve Version ${motion.latest}`
              : 'Approve scene'}
          <kbd aria-hidden="true">Enter</kbd></Button
        >
      {/if}
    </div>
  </div>
{/if}

<style>
  .foot {
    position: sticky;
    /* the page's own padding would leave a strip under the bar */
    bottom: calc(var(--work-pad-y) * -1);
    z-index: 5;
    margin: 0 calc(var(--work-pad-x) * -1) calc(var(--work-pad-y) * -1);
    padding: var(--s-12) var(--work-pad-x);
    border-top: 1px solid var(--line);
    background: var(--ink);
    --btn-flex: none;
  }
  .in {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    max-width: var(--motion-col);
    margin: 0 auto;
  }
  .state {
    flex: 1;
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  b {
    font-size: var(--t13);
    font-weight: 600;
  }
  .why {
    color: var(--muted);
    font-size: var(--t12);
    line-height: 1.35;
  }
  kbd {
    margin-left: var(--s-4);
    padding: var(--s-2) var(--s-4);
    border: 1px solid currentColor;
    border-radius: var(--r-sm);
    font: 600 var(--t12) / 1 var(--mono);
    opacity: 0.6;
  }
  @media (pointer: coarse) {
    kbd {
      display: none;
    }
  }
  @media (min-width: 1200px) {
    .in {
      max-width: none;
    }
  }
  /* tablet and phone: what is happening on one line, the two decisions side by side under it */
  @media (max-width: 759px) {
    .in {
      flex-wrap: wrap;
      --btn-flex: 1 1 40%;
    }
    .state {
      flex: 1 1 calc(100% - 60px);
    }
    .more {
      order: 0;
    }
    .in > :global(.btn) {
      order: 1;
    }
  }
</style>
