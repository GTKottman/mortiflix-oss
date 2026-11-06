<!-- Hear the music, queue a new one (paid, confirmed later) or approve it; plan again or mix under the voice. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import ConfirmInline from '../../lib/components/ConfirmInline.svelte';
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import { cueName, credits, VOICE_ACTIONS } from './review';
  import type { VoiceModel } from './model.svelte';
  import type { CostAnswer, MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
    /** Something to tell the person after Queue (shown at the top of the inspector). */
    onnote: (note: string | null) => void;
  }

  let { model, cue, onnote }: Props = $props();

  const music = $derived(model.music);
  const queued = $derived(model.basket.cues.has(cue.id));
  const noKey = $derived(model.noKey);
  const made = $derived(Boolean(cue.path) && cue.state !== 'stale');
  /** Why this cue cannot join the queue now (e.g. the first cue must be made and heard before the rest), shown on the button. */
  const blocked = $derived(noKey ? null : model.whyNotQueueCue(cue.id));
  // also off while Make the music is making in the background: the same cue must never be sent twice (P027)
  const off = $derived(
    Boolean(music.busy) ||
      Boolean(music.plan?.making) ||
      !music.plan?.enabled ||
      Boolean(noKey) ||
      Boolean(blocked),
  );
  /** Made music a new plan throws away: a new plan writes fresh cues, so these are made (paid) and approved again. */
  const madeCues = $derived(music.cues.filter((c) => c.path).length);
  const cost = $derived(
    made
      ? cue.from_library
        ? 'from your library · 0 credits'
        : `about ${credits(cue.credits ?? 0)} credits`
      : `about ${credits(cue.credits ?? 0)} credits`,
  );

  /** Asks the service what one cue costs (nothing is sent) and puts it in the queue. A sound already in the library is free. */
  async function queue() {
    const why = model.whyNotQueueCue(cue.id);
    if (why) {
      onnote(why);
      return;
    }
    try {
      const answer = await model.service.call<
        CostAnswer & { from_library?: boolean; seconds?: number; credits_per_sec_measured?: number | null }
      >('music.cue.make', { cue: cue.id });
      if (answer.from_library) {
        onnote(`${cueName(cue.id)} was found in your library: 0 credits.`);
        await music.load();
        return;
      }
      if (answer.needs_confirm) {
        model.basket.addCue(cue.id, {
          credits: answer.credits_estimate ?? 0,
          seconds: answer.seconds ?? cue.to_sec - cue.from_sec,
          estimate: (answer.credits_per_sec_measured ?? music.plan?.credits_per_sec_measured) == null,
        });
        onnote(null);
        return;
      }
      onnote(`${cueName(cue.id)} needed no new music: nothing was queued or spent.`);
      await music.load();
    } catch (error) {
      // a cost question that failed is not "the music could not load" (that strip's Try again only reloads the plan)
      model.basket.error = `Could not work out the cost of ${cueName(cue.id)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
</script>

<InspectorSection title="Listen, regenerate, approve">
  <div class="actions">
    <Button
      disabled={!cue.path}
      title={cue.path ? 'The cue under the lines it covers' : 'Make it to hear it'}
      onclick={() => model.previewCue(cue.id)}
    >
      ▶ Preview with voice
    </Button>
    <Button disabled={!cue.path} onclick={() => model.player.playCue(cue)}>▶ Hear the music alone</Button>
    {#if queued}
      <Button variant="cost" onclick={() => model.basket.removeCue(cue.id)}>Queued · remove</Button>
    {:else}
      <Button
        variant="cost"
        disabled={off}
        title={noKey ??
          blocked ??
          (music.plan?.enabled
            ? 'Queues new music. Nothing is spent until you make the queue and confirm the cost.'
            : 'Eleven Music is off in Settings')}
        onclick={queue}
      >
        {made ? 'Queue regeneration' : 'Queue to make'} · {cost}
      </Button>
    {/if}
    <Button
      variant="good"
      disabled={!cue.path || cue.state === 'ok' || cue.state === 'stale' || Boolean(music.busy)}
      onclick={() => music.approve(cue.id)}
    >
      {cue.state === 'ok' ? VOICE_ACTIONS.approved : VOICE_ACTIONS.approve}
    </Button>
  </div>
  {#if blocked && !queued}
    <Hint>{blocked}</Hint>
  {:else}
    <Hint>Listening and ducking are free. New music is queued and costs credits you confirm first.</Hint>
  {/if}
  <div class="actions">
    {#if madeCues && !music.busy && !music.plan?.making}
      <ConfirmInline
        label="Plan the music again"
        question={`Replace all ${madeCues === 1 ? 'the made music cue' : `${madeCues} made music cues`}? New music has to be made (paid) and approved again.`}
        yes="Plan again"
        no="Keep"
        onyes={() => music.planAgain()}
      />
    {:else}
      <Button
        size="sm"
        variant="text"
        disabled={Boolean(music.busy) || Boolean(music.plan?.making)}
        onclick={() => music.planAgain()}
      >
        {music.busy === 'plan' ? 'Planning…' : 'Plan the music again'}
      </Button>
    {/if}
    <Button size="sm" disabled={!music.anyMade || Boolean(music.busy)} onclick={() => music.mix()}>
      {music.busy === 'mix' ? 'Mixing…' : 'Mix under the voice'}
    </Button>
  </div>
</InspectorSection>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
