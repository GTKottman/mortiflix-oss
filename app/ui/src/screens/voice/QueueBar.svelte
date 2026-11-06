<!-- The queue, always under the time line at a fixed height: everything paid that is waiting, what it will cost, and the
     one button that makes it (cost first, with a "test 1 first" when there is more than one). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import CostPrompt from '../../lib/components/CostPrompt.svelte';
  import { cueName, credits, VOICE_ACTIONS } from './review';
  import { roleName } from './roles';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();
  const basket = $derived(model.basket);
  let showList = $state(false);

  const lineItems = $derived([...basket.lines]);
  const cueItems = $derived([...basket.cues]);
  const unknown = $derived(lineItems.some(([, item]) => item.credits === null));
  const total = $derived(
    lineItems.reduce((sum, [, item]) => sum + (item.credits ?? 0), 0) +
      cueItems.reduce((sum, [, item]) => sum + item.credits, 0),
  );
  const estimate = $derived(cueItems.length > 0 && model.music.plan?.credits_per_sec_measured == null);
  const left = $derived(model.music.plan?.balance);
  const parts = $derived(
    [
      lineItems.length ? `${lineItems.length} line${lineItems.length === 1 ? '' : 's'}` : null,
      cueItems.length ? `${cueItems.length} music cue${cueItems.length === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' + '),
  );
  const makingName = $derived(
    basket.makingId
      ? basket.cues.has(basket.makingId)
        ? cueName(basket.makingId)
        : model.nameOf(basket.makingId)
      : '',
  );
  const first = $derived(lineItems[0]?.[1].credits ?? cueItems[0]?.[1].credits ?? 0);
  // music not made yet: its Make button lives here too, in sight whatever is selected (owner 2026-11-04:
  // "I still can't play music and voice at the same time" = the music was never made, the button was hidden)
  const music = $derived(model.music);
  const toMake = $derived(music.plan?.expected ? music.toMake.length : 0);
  const makeNow = $derived(music.makeNow);
  const making = $derived(Boolean(music.plan?.making) || music.busy === 'make');
</script>

<section class="queue" aria-label="Queue">
  {#if basket.size === 0 && toMake && making}
    <p><b>Music</b> · making the music: {toMake} left…</p>
  {:else if basket.size === 0 && toMake && makeNow.wait}
    <p><b>Music</b> · {makeNow.wait}</p>
  {:else if basket.size === 0 && toMake && makeNow.label}
    <div class="make">
      <p><b>Music</b> · not made yet, so only the voice plays.</p>
      <CostPrompt
        label={`${makeNow.label} · about ${credits(makeNow.credits)} credits`}
        variant="primary"
        cost={{
          what: 'ElevenLabs credits',
          amount: `about ${credits(makeNow.credits)}`,
          note: `${makeNow.cues.length} music cue${makeNow.cues.length === 1 ? '' : 's'}`,
        }}
        run={() => music.makeAll()}
      />
    </div>
  {:else if basket.size === 0}
    <p>
      <b>Queue</b> · nothing waiting. A re-read or new music you queue shows its cost here first.{#if left != null}
        &nbsp;· {credits(left)} left{/if}
    </p>
  {:else}
    <button
      type="button"
      class="summary"
      aria-expanded={showList}
      title="Show what is in the queue"
      onclick={() => (showList = !showList)}
    >
      Queue · <b>{parts}</b>
      {#if unknown}· {basket.error
          ? 'cost unknown: take the item out or try again'
          : 'working out the cost…'}{:else}≈ <b>{credits(total)}</b> ElevenLabs credits to make{/if}
      {#if estimate}(music is an estimate){/if}
      {#if left != null}· {credits(left)} left{/if}
    </button>
    {#if showList}
      <ul>
        {#each lineItems as [id, item] (id)}
          <li>
            <span class="what">
              {roleName(model.roleOf(id))} · {model.nameOf(id)}
              <i>{item.kind === 'take' ? item.why : 'tags, voice or stability changed'}</i>
            </span>
            <span>{item.credits === null ? '…' : `≈ ${credits(item.credits)}`}</span>
            <button
              type="button"
              aria-label="Take {model.nameOf(id)} out of the queue"
              onclick={() => basket.unstage(id)}>✕</button
            >
          </li>
        {/each}
        {#each cueItems as [id, item] (id)}
          <li>
            <span class="what"
              >{cueName(id)}<i>{Math.round(item.seconds)} s{item.estimate ? ' · estimate' : ''}</i></span
            >
            <span>≈ {credits(item.credits)}</span>
            <button
              type="button"
              aria-label="Take {cueName(id)} out of the queue"
              onclick={() => basket.removeCue(id)}>✕</button
            >
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <Button size="sm" variant="text" disabled={!!basket.making} onclick={() => basket.clear()}>Clear</Button
      >
      {#if basket.making}
        <Button variant="primary" disabled>Making {basket.making.n} of {basket.making.of}…</Button>
        <!-- Stop: nothing more is sent; the item ElevenLabs is making now cannot be called back -->
        <Button
          size="sm"
          disabled={basket.stopping}
          title="Sends nothing more. The one being made now still finishes."
          onclick={() => basket.stop()}>{basket.stopping ? 'Stopping after this one…' : 'Stop'}</Button
        >
        <span class="now">ElevenLabs is making {makingName}</span>
      {:else if unknown || model.noKey}
        <Button variant="primary" disabled title={model.noKey ?? ''}>{VOICE_ACTIONS.makeQueue}</Button>
      {:else}
        <CostPrompt
          variant="primary"
          label={VOICE_ACTIONS.makeQueue}
          size="md"
          yes="Make {basket.size} item{basket.size === 1 ? '' : 's'}"
          cost={{
            what: 'ElevenLabs credits',
            amount: credits(total),
            ...(estimate ? { note: 'music is an estimate' } : {}),
          }}
          test={basket.size > 1
            ? { label: 'Test 1 first', amount: credits(first), run: () => basket.run(true) }
            : undefined}
          run={() => basket.run(false)}
        />
      {/if}
    </div>
  {/if}
</section>

<style>
  .make {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12) var(--s-16);
  }
  .queue {
    display: grid;
    gap: var(--s-8);
    align-content: start;
    min-height: calc(var(--s-64) + var(--s-32));
    padding-top: var(--s-12);
    border-top: 1px solid var(--line-2);
    color: var(--muted);
    font-size: var(--t14);
  }
  b {
    color: var(--text);
    font-weight: 600;
  }
  .summary {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: var(--t14);
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  li > span:not(.what) {
    white-space: nowrap;
  }
  ul {
    display: grid;
    max-height: calc(var(--s-64) * 2 + var(--s-32));
    list-style: none;
    overflow: auto;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto var(--h-sm);
    gap: var(--s-8);
    align-items: center;
    min-height: calc(var(--s-32) + var(--s-4));
    border-top: 1px solid var(--line);
    font-size: var(--t12);
  }
  .what {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  i {
    margin-left: var(--s-8);
    color: var(--faint);
    font-style: normal;
  }
  li button {
    width: var(--h-sm);
    height: var(--h-sm);
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .now {
    white-space: nowrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
</style>
