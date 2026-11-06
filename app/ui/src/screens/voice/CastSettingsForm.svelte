<!-- One character's voice settings. A change to stability, similarity, style, speed or speaker boost needs new reads
     (queued, paid); clip gain is free and applies on the next build. -->
<script lang="ts">
  import Slider from '../../lib/components/Slider.svelte';
  import Switch from '../../lib/components/Switch.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { CastMember, CastSettings } from './types';

  interface Props {
    model: VoiceModel;
    member: CastMember;
  }

  let { model, member }: Props = $props();

  // This voice model ignores style and speed, so they are not sent.
  const ignoresStyle = $derived(member.v4 ?? /^eleven_v4/.test(member.model ?? ''));
  let settings = $state<Required<CastSettings>>({
    stability: 0,
    similarity_boost: 0,
    style: 0,
    speed: 1,
    use_speaker_boost: true,
  });
  let gain = $state(0);
  $effect(() => {
    settings = {
      stability: member.settings?.stability ?? 0,
      similarity_boost: member.settings?.similarity_boost ?? 0,
      style: member.settings?.style ?? 0,
      speed: member.settings?.speed ?? 1,
      use_speaker_boost: member.settings?.use_speaker_boost !== false,
    };
    gain = member.gain_db ?? 0;
  });

  const save = (patch: Partial<CastSettings>) =>
    model.changeCastSetting(member, { settings: { ...member.settings, ...patch } });
  const two = (value: number) => value.toFixed(2);
</script>

<div class="form">
  <Slider
    label="Stability"
    bind:value={settings.stability}
    min={0}
    max={1}
    step={0.05}
    format={two}
    onchange={(value) => save({ stability: value })}
  />
  <Slider
    label="Similarity"
    bind:value={settings.similarity_boost}
    min={0}
    max={1}
    step={0.05}
    format={two}
    onchange={(value) => save({ similarity_boost: value })}
  />
  {#if !ignoresStyle}
    <Slider
      label="Style"
      bind:value={settings.style}
      min={0}
      max={1}
      step={0.05}
      format={two}
      onchange={(value) => save({ style: value })}
    />
    <Slider
      label="Speed"
      bind:value={settings.speed}
      min={0.7}
      max={1.2}
      step={0.05}
      format={two}
      onchange={(value) => save({ speed: value })}
    />
  {/if}
  <Switch
    label="Speaker boost"
    bind:checked={settings.use_speaker_boost}
    onchange={(value) => save({ use_speaker_boost: value })}
  />
  <Slider
    label="Clip gain"
    bind:value={gain}
    min={-12}
    max={12}
    step={0.5}
    format={(value) => `${value.toFixed(1)} dB`}
    onchange={(value) => model.changeGain(member, value)}
  />
  <p class="hint">
    {ignoresStyle ? 'This voice model ignores style and speed, so they are not sent. ' : ''}A change to a
    setting adds this character’s lines to the queue (paid re-read). Gain is <span class="free">free</span> and
    applies on the next build.
  </p>
</div>

<style>
  .form {
    display: grid;
    gap: var(--s-8);
    margin-bottom: var(--s-4);
    padding: var(--s-8) var(--s-12) var(--s-12);
    border-radius: var(--r);
    background: var(--ink-3);
  }
  .hint {
    color: var(--faint);
    font-size: var(--t12);
  }
  .free {
    color: var(--good);
  }
</style>
