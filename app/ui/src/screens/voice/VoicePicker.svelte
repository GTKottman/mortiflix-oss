<!-- Choose a voice: search by name, accent or mood, narrow by labels, hear a free sample, use it. Nothing here costs
     anything; a voice that is used re-reads its lines through the queue. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import { isNotBuiltYet } from '../../lib/service/client';
  import { routeHref } from '../../lib/router.svelte';
  import { VOICE_ACTIONS } from './review';
  import type { VoiceModel } from './model.svelte';
  import VoiceRow from './VoiceRow.svelte';
  import VoiceSearch from './VoiceSearch.svelte';
  import { failureWords, groupsOf, matchVoices, type LabelKey } from './voices';
  import type { VoiceChoice, VoicesAnswer } from './types';

  interface Props {
    /** Only its service and no-key message are read (the cost OK uses it without a whole voice model). */
    model: Pick<VoiceModel, 'service' | 'noKey'>;
    /** The voice that is in use now (marked), if any. */
    currentId?: string;
    /** What the button on a voice says. */
    useText?: string;
    onuse: (voice: VoiceChoice) => void;
  }

  const PAGE = 8;

  let { model, currentId, useText = 'Use this voice', onuse }: Props = $props();

  let answer = $state<VoicesAnswer | 'soon' | null>(null);
  let query = $state('');
  let shown = $state(PAGE);
  let picked = $state<Partial<Record<LabelKey, string>>>({});
  let sampleId = $state<string | null>(null);
  let sample: HTMLAudioElement | null = null;

  async function load() {
    answer = null;
    try {
      answer = await model.service.call<VoicesAnswer>('voices.list');
    } catch (error) {
      answer = isNotBuiltYet(error)
        ? 'soon'
        : { reason: 'unreachable', error: error instanceof Error ? error.message : String(error) };
    }
  }
  void load();

  $effect(() => () => sample?.pause());

  const voices = $derived(answer && answer !== 'soon' ? (answer.voices ?? []) : []);
  const groups = $derived(groupsOf(voices));
  // English first: the script screens write English narration (no project language is stored yet).
  const matches = $derived(matchVoices(voices, query, picked));
  const failure = $derived(
    answer && answer !== 'soon' && answer.reason ? failureWords(answer.reason, model.noKey) : null,
  );

  function pick(key: LabelKey, value: string) {
    picked = { ...picked, [key]: value };
    shown = PAGE;
  }

  function hear(voice: VoiceChoice) {
    const same = sampleId === voice.id;
    sample?.pause();
    sample = null;
    sampleId = null;
    if (same || !voice.preview_url) return;
    const audio = new Audio(voice.preview_url);
    sample = audio;
    sampleId = voice.id;
    audio.onended = () => (sampleId = null);
    audio.play().catch(() => (sampleId = null));
  }
</script>

<div class="picker">
  {#if answer === null}
    <LoadingState text="Loading the voices…" />
  {:else if answer === 'soon'}
    <EmptyState
      title="Voices can't be listed"
      body="This studio's service does not list ElevenLabs voices yet."
    />
  {:else if failure}
    <ErrorState
      inline
      title={failure.title}
      detail={failure.detail}
      onretry={answer.reason === 'unreachable' ? load : undefined}
    />
    {#if answer.reason !== 'unreachable'}
      <div><Button size="sm" href={routeHref('/settings')}>{VOICE_ACTIONS.settings}</Button></div>
    {/if}
  {:else}
    <p class="note">Samples are free. Nothing is spent until you make the queue.</p>
    <VoiceSearch bind:query {groups} {picked} onsearch={() => (shown = PAGE)} onpick={pick} />
    <ul>
      {#each matches.slice(0, shown) as voice (voice.id)}
        <VoiceRow
          {voice}
          inUse={voice.id === currentId}
          hearing={sampleId === voice.id}
          {useText}
          onhear={() => hear(voice)}
          onuse={() => onuse(voice)}
        />
      {:else}
        <li class="none">No voice matches. Clear the search or a filter.</li>
      {/each}
    </ul>
    {#if matches.length > shown}
      <div>
        <Button size="sm" variant="text" onclick={() => (shown += PAGE)}
          >Show more ({matches.length - shown})</Button
        >
      </div>
    {/if}
  {/if}
</div>

<style>
  .picker {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-8) var(--s-12) var(--s-12);
    border-radius: var(--r);
    background: var(--ink-3);
  }
  .note {
    color: var(--muted);
    font-size: var(--t12);
  }
  ul {
    display: grid;
    max-height: calc(var(--s-64) * 6);
    list-style: none;
    overflow: auto;
    scrollbar-width: thin;
  }
  .none {
    min-height: var(--h-lg);
    padding: var(--s-4) 0;
    border-top: 1px solid var(--line);
    color: var(--faint);
    font-size: var(--t12);
  }
</style>
