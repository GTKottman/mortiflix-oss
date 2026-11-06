<!-- The inspector when nothing is selected: the whole audio in numbers, and the way to the next issue. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import CostPrompt from '../../lib/components/CostPrompt.svelte';
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import Hint from './Hint.svelte';
  import { ALL_APPROVED, credits, voiceClock } from './review';
  import { roleName } from './roles';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();

  const approvedLines = $derived(model.lines.filter((l) => !model.needsYou(l)).length);
  const cues = $derived(model.music.cues);
  const approvedCues = $derived(cues.filter((c) => c.state === 'ok').length);
  const narrators = $derived(
    [...new Set(model.cast.members.map((c) => c.name || roleName(c.role)))].join(', ') || '—',
  );
  const queued = $derived(model.basket.size);
  const changed = $derived(model.changedLines);
  // the characters at the rate ElevenLabs billed (the service measures it); the queue shows the service's own figure
  const changedCredits = $derived(
    Math.ceil(changed.reduce((sum, l) => sum + l.words.length, 0) * (model.view?.credit_rate ?? 1)),
  );
  const issues = $derived(model.issues.length);
  // The voice step makes the music too: none planned, or planned and not made, is never "every cue approved"
  const music = $derived(model.music);
  const toMake = $derived(music.toMake.length);
  const makeNow = $derived(music.makeNow);
  const making = $derived(Boolean(music.plan?.making) || music.busy === 'make');

  const pace = $derived(model.pace);
  const over = $derived(pace?.over_sec != null && pace.chosen_sec && pace.over_sec >= 1 ? pace.over_sec : 0);
  const speeds = $derived(pace?.speeds ?? []);
  const speedAt = $derived(speeds.indexOf(pace?.speed ?? 1));

  const facts = $derived([
    [
      'Length',
      (over && pace?.chosen_sec
        ? `${voiceClock(model.length)} · ${Math.round(over)} s over the ${voiceClock(pace.chosen_sec)} asked`
        : voiceClock(model.length)) + (model.pauseWait ? ` · ${model.pauseWait}` : ''),
    ],
    ['Voice lines', `${model.lines.length} · ${approvedLines} approved`],
    ['Music segments', cues.length ? `${cues.length} · ${approvedCues} approved` : 'none planned yet'],
    ['Narrators', narrators],
    ['Queued to make', queued ? `${queued} item${queued === 1 ? '' : 's'}` : 'nothing'],
  ]);
</script>

<InspectorSection title="Audio overview">
  <dl>
    {#each facts as [name, value] (name)}
      <div>
        <dt>{name}</dt>
        <dd>{value}</dd>
      </div>
    {/each}
  </dl>
  {#if pace}
    <div class="speed">
      <dt>Speed</dt>
      <dd>
        <Button
          size="sm"
          aria-label="Slower"
          disabled={speedAt <= 0}
          onclick={() => void model.setSpeed(speeds[speedAt - 1] ?? 1)}>−</Button
        >
        <span>{pace.speed.toFixed(2)}×</span>
        <Button
          size="sm"
          aria-label="Faster"
          disabled={speedAt < 0 || speedAt >= speeds.length - 1}
          onclick={() => void model.setSpeed(speeds[speedAt + 1] ?? 1)}>+</Button
        >
      </dd>
    </div>
    {#if over}
      <Hint>Too long: tighten the pauses after lines first, then cut the script.</Hint>
    {:else}
      <Hint free>the whole voice, pitch kept; nothing is read again.</Hint>
    {/if}
  {/if}
  {#if changed.length}
    <Button style="justify-self: start" onclick={() => model.queueChanged()}
      >Re-read {changed.length} changed line{changed.length === 1 ? '' : 's'} · about {credits(
        changedCredits,
      )} credits</Button
    >
  {/if}
  {#if music.plan?.expected && !cues.length}
    <Button
      variant={issues ? undefined : 'primary'}
      style="justify-self: start"
      disabled={Boolean(music.busy)}
      onclick={() => void music.planAgain()}
      >{music.busy === 'plan' ? 'Planning the music…' : 'Plan the music'}</Button
    >
    <Hint free>one AI pass cuts the music at the scene changes; nothing is made yet.</Hint>
  {:else if music.plan?.expected && toMake && making}
    <p class="how">Making the music: {toMake} cue{toMake === 1 ? '' : 's'} left…</p>
  {:else if music.plan?.expected && toMake && makeNow.wait}
    <p class="how">{makeNow.wait}</p>
  {:else if music.plan?.expected && toMake && makeNow.label}
    <CostPrompt
      label={`${makeNow.label} · about ${credits(makeNow.credits)} credits`}
      variant={issues ? 'cost' : 'primary'}
      cost={{
        what: 'ElevenLabs credits',
        amount: `about ${credits(makeNow.credits)}`,
        note: `${makeNow.cues.length} music cue${makeNow.cues.length === 1 ? '' : 's'}`,
      }}
      run={() => music.makeAll()}
    />
  {/if}
  {#if music.error}<p class="error">{music.error}</p>{/if}
  {#if issues}
    <Button variant="primary" style="justify-self: start" onclick={() => model.goToIssue(1)}
      >Review next issue ({issues})</Button
    >
  {:else if music.missingMusic}
    <p class="how">
      {cues.length && !toMake
        ? `Approve each music segment (${cues.length - approvedCues} left), then you can go on to Look.`
        : 'Every line is approved. The music comes next, then you can go on to Look.'}
    </p>
  {:else}
    <p class="done">{ALL_APPROVED}</p>
  {/if}
</InspectorSection>
<OptionsRow stage="voice" onrun={() => void model.load()} />
<InspectorSection title="How to use this">
  <p class="how">
    Click a voice clip or a music segment on the timeline to hear it and fix it here. Lines and music to check
    carry a !; approved ones carry a ✓. Nothing paid is made until you queue it and confirm the cost.
  </p>
</InspectorSection>

<style>
  div {
    display: flex;
    justify-content: space-between;
    gap: var(--s-12);
    padding: var(--s-8) 0;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--t14);
  }
  dt {
    white-space: nowrap;
  }
  .speed dd {
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
  }
  dd {
    color: var(--text);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .done {
    color: var(--good);
  }
  .error {
    color: var(--bad);
  }
  .how {
    color: var(--muted);
    line-height: 1.6;
  }
</style>
