<!-- What a note says, cut to three lines with More / Less, its voice recording, and the state of writing the
     voice out as words. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { clipUrl } from './media';
  import type { Transcript } from './motion.svelte';

  interface Props {
    words: string;
    resolved: boolean;
    audio: string | null | undefined;
    transcript: Transcript | undefined;
  }

  let { words, resolved, audio, transcript }: Props = $props();

  let said = $state<HTMLElement>();
  let open = $state(false);
  let clamped = $state(false);

  $effect(() => {
    void words;
    if (said && !open) clamped = said.scrollHeight > said.clientHeight + 1;
  });
</script>

<span class="said" class:open class:resolved bind:this={said}>{words}</span>
{#if clamped || open}
  <Button
    size="sm"
    variant="text"
    onclick={(event) => {
      event.stopPropagation();
      open = !open;
    }}>{open ? 'Less' : 'More'}</Button
  >
{/if}
{#if audio}
  <!-- A spoken note: its words are written out above once transcribed. -->
  <audio src={clipUrl(audio)} controls preload="none" onclick={(event) => event.stopPropagation()}></audio>
{/if}
{#if transcript?.state === 'working'}
  <span class="why" role="status">Writing down what you said…</span>
{:else if transcript?.state === 'error'}
  <span class="why warn" role="status"
    >Could not write out the voice note: {transcript.error}. Your voice is kept with the note.</span
  >
{/if}

<style>
  .said {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    font-size: var(--t14);
  }
  .said.open {
    display: block;
  }
  .resolved {
    color: var(--muted);
    text-decoration: line-through;
  }
  audio {
    width: 100%;
    height: var(--h-sm);
  }
  .why {
    color: var(--muted);
    font-size: var(--t12);
  }
  .warn {
    color: var(--warn);
  }
</style>
