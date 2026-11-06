<!-- The inspector's top-right for a music cue: its state and the arrows to the next cue. -->
<script lang="ts">
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import MoreMenu, { type MenuItem } from './MoreMenu.svelte';
  import StepButtons from './StepButtons.svelte';
  import { cueName } from './review';
  import { cueStatus } from './status';
  import type { VoiceModel } from './model.svelte';
  import type { MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
  }

  let { model, cue }: Props = $props();

  const word = $derived(cueStatus(cue.state, model.basket.cues.has(cue.id)));
  const music = $derived(model.music);
  const items = $derived<MenuItem[]>([
    { label: '▶ Hear it under the voice', disabled: !cue.path, run: () => model.previewCue(cue.id) },
    { label: '▶ Hear the music alone', disabled: !cue.path, run: () => model.player.playCue(cue) },
    {
      label: cue.state === 'ok' ? 'Approved' : 'Approve this music',
      disabled: !cue.path || cue.state === 'ok' || cue.state === 'stale' || Boolean(music.busy),
      run: () => void music.approve(cue.id),
    },
    ...(model.basket.cues.has(cue.id)
      ? [{ label: 'Remove from the queue', run: () => model.basket.removeCue(cue.id) }]
      : []),
    { label: 'Next to review ›', divider: true, run: () => model.goToIssue(1) },
  ]);
</script>

<StatusPill pill small tone={word.tone} glyph={word.glyph} text={word.text} />
<StepButtons
  index={model.music.cues.indexOf(cue)}
  count={model.music.cues.length}
  name="cue"
  onstep={(direction) => model.step(direction)}
/>
<MoreMenu label={`More for ${cueName(cue.id)}`} {items} align="left" />
