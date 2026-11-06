<!-- What the music should be, in words. A change needs new music (paid). -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import { CUE_PROMPT_FIELD } from './keys';
  import type { VoiceModel } from './model.svelte';
  import type { MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
  }

  let { model, cue }: Props = $props();
</script>

<InspectorSection title="What the music should be">
  <textarea
    id={CUE_PROMPT_FIELD}
    aria-label="What the music should be"
    value={cue.prompt ?? ''}
    onchange={(event) => model.music.setCue(cue.id, { prompt: event.currentTarget.value })}></textarea>
  <Hint>Mood, instruments, texture, and what to avoid. A change needs new music (paid).</Hint>
</InspectorSection>

<style>
  textarea {
    width: 100%;
    min-height: calc(var(--s-64) + var(--s-12));
    padding: var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    font-size: var(--t12);
    line-height: 1.5;
    resize: vertical;
  }
  textarea:focus {
    border-color: var(--link);
  }
</style>
