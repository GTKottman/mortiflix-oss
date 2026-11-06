<!-- The bottom bar: the one price in plain words, then the way to pay. Pressing Make asks the service what it would
     cost (nothing is spent), shows the cost with "Test shot N first", and only a second click makes anything.
     While making it counts up, and the sounds appear in the list as they land. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import CostPrompt from '../../lib/components/CostPrompt.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import Elapsed from '../../lib/components/Elapsed.svelte';
  import type { SoundState } from './sound-state.svelte';
  import { everyShotDone, isUnmade, newSounds } from './sound';
  import type { MakeAnswer } from './types';

  interface Props {
    sound: SoundState;
  }

  let { sound }: Props = $props();

  type Quote = NonNullable<Awaited<ReturnType<SoundState['quote']>>>;
  let quote = $state<Quote | null>(null);
  let asking = $state(false);
  let bar = $state<HTMLElement>();
  let quoting = $state(false);
  /** The service priced it at no calls: what it would take from the library for free instead, if anything. */
  let free = $state<MakeAnswer | null>(null);

  let barHeight = $state(0);

  // The bar stays stuck to the bottom of the page: the page's scroll area gets a bottom padding of its height, so a
  // row reached with Tab or opened from the list scrolls clear of the bar instead of under it (1366x768).
  $effect(() => {
    const scroller = bar?.closest<HTMLElement>('main');
    if (!scroller || !barHeight) return;
    scroller.style.scrollPaddingBottom = `${barHeight}px`;
    return () => scroller.style.removeProperty('scroll-padding-bottom');
  });

  const plan = $derived(sound.plan);
  const summary = $derived(plan?.summary);
  const made = $derived(
    sound.making && plan ? Math.max(0, sound.making.start - plan.cues.filter(isUnmade).length) : 0,
  );

  // Back to the plain button when the cost is cancelled or making starts (the prompt is gone while making, so it
  // can't close itself, and an old price must not come back afterwards).
  $effect(() => {
    if (sound.making) {
      asking = false;
      free = null;
    }
  });
  $effect(() => {
    if (!asking) quote = null;
  });

  /** `useLibrary`: the free button. It asks the price again first and sends the make (with confirm) only when the
      answer still has nothing to pay; if a sound now needs making, the price question shows instead. */
  async function ask(useLibrary = false) {
    quoting = true;
    const answer = await sound.quote();
    quoting = false;
    if (!answer) return;
    if (!answer.all.calls) {
      const fromLibrary = answer.all.from_library?.length ?? 0;
      if (useLibrary && fromLibrary) {
        free = null;
        await sound.make({ all: true }, fromLibrary);
        return;
      }
      free = answer.all;
      await sound.load(true);
      return;
    }
    free = null;
    quote = answer;
    asking = true;
    // Focus goes to the question, on its last button (Cancel), so a stray Enter never spends.
    await tick();
    [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])].at(-1)?.focus();
  }

  function costNote(all: MakeAnswer): string {
    const free = all.from_library?.length
      ? ` ${all.from_library.length} come from your library for free.`
      : '';
    return `${all.calls} sounds. Each call is logged. It stops at once if billing says no.${free}`;
  }
</script>

{#if plan && summary}
  <div class="bar" bind:this={bar} bind:offsetHeight={barHeight}>
    {#if sound.making}
      <p class="making">
        <StatusMark
          mark="busy"
          text="Mortiflix is making sound {Math.min(made + 1, sound.making.total)} of {sound.making.total}"
        />
        · <Elapsed since={sound.making.since} /> · sounds appear in the list as they land
        <Button variant="secondary" disabled={sound.stopping} onclick={() => void sound.stop()}>
          {sound.stopping ? 'Stopping after this sound…' : 'Stop'}
        </Button>
      </p>
    {:else if everyShotDone(plan)}
      <p><b>Every shot has its sound.</b> <a href={routeHref('/finish')}>Next: Finish ›</a></p>
    {:else}
      <p>
        <b>
          {summary.to_make
            ? `${newSounds(summary.sounds_to_make ?? summary.to_make)}${(summary.sounds_to_make ?? summary.to_make) < summary.to_make ? ` for ${summary.to_make} moments` : ''} ≈ ${summary.credits.toLocaleString()} ElevenLabs credits`
            : 'Every sound is made'}
        </b>
        · {summary.library} from your library, free{summary.to_make
          ? ''
          : '. Waiting for you: play each shot and OK its sounds.'}
      </p>
      {#if summary.to_make}
        {#if quote}
          {@const one = quote.one}
          {@const everything = quote.all}
          <CostPrompt
            label={`Make ${newSounds(summary.to_make)}`}
            size="md"
            cost={{
              what: 'ElevenLabs credits',
              amount: quote.all.credits.toLocaleString(),
              note: costNote(quote.all),
            }}
            yes={`Make ${quote.all.calls} new sounds`}
            test={one?.answer.calls
              ? {
                  label: `Test shot ${one.shot.number} first`,
                  amount: one.answer.credits.toLocaleString(),
                  run: () => sound.make({ shot: one.shot.id }, one.answer.calls),
                }
              : undefined}
            bind:asking
            run={() => sound.make({ all: true }, everything.calls)}
          />
        {:else}
          {@const fromLibrary = free?.from_library?.length ?? 0}
          {#if free && fromLibrary}
            <p>Nothing to pay: the service takes {fromLibrary} from your library.</p>
            <Button disabled={quoting || Boolean(sound.busy)} onclick={() => ask(true)}>
              Use {fromLibrary} from your library · free
            </Button>
          {:else}
            {#if free}<p>The service has nothing to make right now. The list was refreshed.</p>{/if}
            <Button variant="cost" disabled={quoting || Boolean(sound.busy)} onclick={() => ask()}>
              {sound.busy || (quoting ? 'Asking the price…' : `Make ${newSounds(summary.to_make)}`)}
            </Button>
          {/if}
        {/if}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-24);
    /* same room above the line as below it (owner 2026-11-03: balanced padding everywhere) */
    padding: var(--s-24) 0;
    border-top: 1px solid var(--line);
    background: var(--ink);
  }
  p {
    color: var(--muted);
  }
  .making {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-4);
  }
  b {
    color: var(--text);
    font-weight: 600;
  }
  a {
    color: var(--link);
    white-space: nowrap;
    text-underline-offset: 2px;
  }
</style>
