<!-- Fills the player while there is no video to play: waiting, making it (with progress) or not made yet. -->
<script lang="ts">
  import { queueWords } from './finish';
  import type { FinalStatus } from './types';

  interface Props {
    status: FinalStatus;
  }

  let { status }: Props = $props();

  const progress = $derived(
    status.progress && status.progress.total ? status.progress.done / status.progress.total : null,
  );
</script>

{#if status.state === 'rendering'}
  <div class="cover">
    <div class="words">
    <b>{status.queued ? 'Waiting in the queue' : 'Making the video'}</b>
    <span
      >{status.queued
        ? queueWords(status.renders_ahead)
        : status.progress?.phase || 'Putting the shots, voice and sound together.'}</span
    >
    </div>
  </div>
  <div
    class="track"
    role="progressbar"
    aria-label={status.queued ? 'Waiting in the queue' : 'Making the video'}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
  >
    <i class:indeterminate={progress === null} style:--p={progress ?? 0}></i>
  </div>
{:else}
  <div class="cover">
    <div class="words">
      <b>Not made yet</b>
      <span>The video appears here when it is made.</span>
    </div>
  </div>
{/if}

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
    background: color-mix(in srgb, var(--ink) 72%, transparent);
  }
  /* The words sit on their own dark plate, so nothing in the poster can run through them. */
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
  .track {
    position: absolute;
    inset: auto 0 0;
    height: var(--s-4);
    overflow: hidden;
    background: var(--line);
  }
  i {
    display: block;
    width: calc(var(--p, 0) * 100%);
    height: 100%;
    background: var(--busy);
    transition: width 0.4s linear;
  }
  .indeterminate {
    width: 30%;
    animation: slide 1.4s var(--ease) infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .indeterminate {
      width: 100%;
      opacity: 0.5;
    }
    i {
      transition: none;
    }
  }
</style>
