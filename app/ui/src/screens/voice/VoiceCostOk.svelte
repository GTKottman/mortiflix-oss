<!-- Cost first for the voice: "Ready to record the voice: Voice: Tracy K [change] · about 493 credits · [Make the
     voice]". Change opens the voice picker (free samples); a pick is saved as this project's narrator (cast.set) and the
     cost is read again. Nothing is recorded until Make the voice and its cost are confirmed (step.confirm_cost). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import StepCostOk from '../../lib/components/StepCostOk.svelte';
  import { useService } from '../../lib/stores/context';
  import type { CastAnswer, CastMember, VoiceChoice } from './types';
  import VoicePicker from './VoicePicker.svelte';

  interface Props {
    /** Show it before the service waits (the Script screen once the script is OK'd). */
    ahead?: boolean;
  }

  let { ahead = false }: Props = $props();

  const client = useService();
  let picking = $state(false);
  let version = $state(0);
  let failed = $state<string | null>(null);

  async function use(voice: VoiceChoice) {
    failed = null;
    try {
      const now = await client.call<CastAnswer>('cast.get');
      const base: CastMember = now.cast.find((m) => m.role === 'narrator') ?? {
        ...now.fallback,
        role: 'narrator',
      };
      const narrator: CastMember = { ...base, role: 'narrator', voice_id: voice.id, name: voice.name };
      delete narrator.engine;
      const others = now.cast.filter((m) => m.role !== 'narrator').map((m) => ({ ...m, engine: undefined }));
      await client.call('cast.set', { cast: [narrator, ...others] });
      picking = false;
      version += 1;
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<StepCostOk step="voice" {ahead} {version}>
  {#snippet who(cost)}
    <span>Voice: <b>{cost.voice?.name ?? 'not picked'}</b></span>
    <Button size="sm" variant="text" onclick={() => (picking = !picking)}
      >{picking ? 'Close' : 'change'}</Button
    >
  {/snippet}
</StepCostOk>
{#if picking}
  <VoicePicker
    model={{ service: client, noKey: null }}
    useText="Use this voice"
    onuse={(voice) => void use(voice)}
  />
{/if}
{#if failed}<p class="fail" role="alert">The voice was not changed: {failed}.</p>{/if}

<style>
  .fail {
    color: var(--bad);
    font-size: var(--t13);
  }
</style>
