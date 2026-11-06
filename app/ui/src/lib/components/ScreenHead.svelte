<!-- Every screen's head: kicker ("MOTION · SCENE 2 OF 6"), the uppercase title, one muted help line, centered
     (owner 2026-11-03: "it should just be centered"), and the screen's main button on the right. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Words, or a snippet when the kicker needs a link or a state mark. */
    kicker?: string | Snippet;
    title: string;
    help?: string;
    actions?: Snippet;
  }

  let { kicker, title, help, actions }: Props = $props();
</script>

<div class="head">
  <div class="title">
    {#if typeof kicker === 'string'}
      <p class="kicker">{kicker}</p>
    {:else if kicker}
      <p class="kicker">{@render kicker()}</p>
    {/if}
    <h1>{title}</h1>
    {#if help}<p class="help">{help}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr);
    align-items: end;
    gap: var(--s-24);
  }
  .title {
    grid-column: 2;
    min-width: 0;
    text-align: center;
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  h1 {
    font: 600 var(--t-display) / 1.1 var(--display);
    letter-spacing: -0.02em;
    text-transform: uppercase;
    overflow-wrap: break-word;
  }
  .help {
    max-width: var(--reading);
    margin: var(--s-8) auto 0;
    color: var(--muted);
  }
  .actions {
    grid-column: 3;
    justify-self: end;
    display: flex;
    flex-shrink: 0;
    gap: var(--s-12);
  }
  /* below a wide desktop: the title on its own line, centered, the buttons centered under it
     (owner's tablet 2026-11-04: Voice & music's buttons sat on top of the title) */
  @media (max-width: 1599px) {
    .head {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-12);
    }
    .title,
    .actions {
      grid-column: 1;
    }
    .actions {
      flex-wrap: wrap;
      justify-content: center;
      justify-self: center;
    }
  }
</style>
