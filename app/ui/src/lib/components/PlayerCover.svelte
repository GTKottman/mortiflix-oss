<!-- A veil over the player's picture with one message: loading, won't play, file missing, nothing to play yet.
     `light` lets the picture show through; the words sit on their own dark plate, so nothing in the picture
     (a bright dot in the middle of a frame) can run through them. Actions (buttons) go in as children. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    detail?: string;
    light?: boolean;
    /** status for a passing state, alert for something that went wrong. */
    role?: 'status' | 'alert';
    children?: Snippet;
  }

  let { title, detail, light = false, role, children }: Props = $props();
</script>

<div class="cover" class:light {role}>
  {#if title || detail}
    <div class="words">
      {#if title}<b>{title}</b>{/if}
      {#if detail}<span>{detail}</span>{/if}
    </div>
  {/if}
  {@render children?.()}
</div>

<style>
  .cover {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--s-8);
    padding: var(--s-16);
    text-align: center;
    background: var(--scrim);
  }
  .light {
    background: var(--scrim-light);
  }
  .words {
    display: grid;
    justify-items: center;
    gap: var(--s-8);
    padding: var(--s-8) var(--s-16);
    border-radius: var(--r);
    background: var(--scrim-strong);
  }
  b {
    font: 600 var(--t20) / 1.15 var(--display);
    letter-spacing: 0.01em;
    text-transform: uppercase;
  }
  span {
    max-width: 46ch;
    color: var(--muted);
    font-size: var(--t14);
  }
</style>
