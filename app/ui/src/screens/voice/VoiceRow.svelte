<!-- One voice in the picker: a free sample to hear, its name and labels, and the button to use it. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { describeVoice } from './voices';
  import type { VoiceChoice } from './types';

  interface Props {
    voice: VoiceChoice;
    /** The voice that is in use now. */
    inUse: boolean;
    /** Its sample is playing. */
    hearing: boolean;
    useText: string;
    onhear: () => void;
    onuse: () => void;
  }

  let { voice, inUse, hearing, useText, onhear, onuse }: Props = $props();
</script>

<li>
  <button
    type="button"
    class="play"
    aria-label="Hear a free sample of {voice.name}"
    title="Free sample"
    disabled={!voice.preview_url}
    onclick={onhear}
  >
    {hearing ? '■' : '▶'}
  </button>
  <div class="name">
    <b>{voice.name}</b>
    <span>{describeVoice(voice)}</span>
  </div>
  {#if inUse}
    <span class="inuse">✓ In use</span>
  {:else}
    <Button size="sm" onclick={onuse}>{useText}</Button>
  {/if}
</li>

<style>
  li {
    display: grid;
    grid-template-columns: var(--h-sm) minmax(0, 1fr) auto;
    gap: var(--s-12);
    align-items: center;
    min-height: var(--h-lg);
    padding: var(--s-4) 0;
    border-top: 1px solid var(--line);
  }
  .play {
    width: var(--h-sm);
    height: var(--h-sm);
    padding-left: var(--s-2);
    border: 1px solid var(--line-2);
    border-radius: 50%;
    background: transparent;
    font-size: var(--t12);
    cursor: pointer;
  }
  .play:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .name {
    display: grid;
    min-width: 0;
  }
  .name b,
  .name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name b {
    font-size: var(--t14);
    font-weight: 500;
  }
  .name span {
    color: var(--faint);
    font-size: var(--t12);
  }
  .inuse {
    color: var(--good);
    font-size: var(--t12);
    white-space: nowrap;
  }
</style>
