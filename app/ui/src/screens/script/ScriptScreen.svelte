<!-- Stage 1, Script: read each scene's narration beside what is on screen, change a line, OK the scene.
     The owner's plan 41 without the storyboard picture: one row per scene (narration about 60% | ON SCREEN about 40%). -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import { useProblems, useProject, useRouter, useScreenBar, useService } from '../../lib/stores/context';
  import { FIXTURE_MODES, fixtureSource, isFixtureMode } from './fixtures';
  import { shortcutFor } from './keys';
  import { stageById, statusFor } from '../../lib/stages';
  import FixNote from './FixNote.svelte';
  import RewriteRow from './RewriteRow.svelte';
  import SceneRow from './SceneRow.svelte';
  import SceneStrip from './SceneStrip.svelte';
  import ScriptToolbar from './ScriptToolbar.svelte';
  import { provideScript, ScriptStore } from './script.svelte';
  import ScriptWaiting from './ScriptWaiting.svelte';
  import { serviceSource } from './source';
  import VoiceCostOk from '../voice/VoiceCostOk.svelte';

  const STRIP_FROM = 8;
  const RELOAD_DELAY_MS = 120;

  const client = useService();
  const project = useProject();
  const router = useRouter();
  const screenBar = useScreenBar();

  const fixture = import.meta.env.DEV ? router.query.get('fixture') : null; // fixtures: dev builds only
  const source = isFixtureMode(fixture) ? fixtureSource(fixture) : serviceSource(client);
  const script = provideScript(new ScriptStore(source, useProblems(), router.query.get('scene')));

  let list = $state<HTMLElement>();

  // Fixtures need no project; the real script loads once the project is open.
  $effect(() => {
    if (script.isFixture || project.id) void script.load();
  });

  $effect(() => {
    if (script.isFixture) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void script.load(), RELOAD_DELAY_MS);
    };
    const stops = [
      client.on('script.changed', reload),
      client.on('node.changed', reload),
      client.on<{ up: boolean }>('bridge.state', (state) => state.up && reload()),
    ];
    return () => {
      clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  });

  // Unsaved words wait 400 ms before they are kept: send them at once when the page is hidden (MDN: the last event a
  // page can rely on) or when this screen goes away, so the last keystrokes are never dropped.
  $effect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') script.flushDraft();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      script.flushDraft();
    };
  });

  // Save is the screen's one gradient button while an open scene has unsaved words. Before any scene exists,
  // ScriptWaiting owns this (the brief's OK).
  $effect(() => {
    if (script.beats.length > 0) screenBar.ownPrimary = script.hasUnsavedEdit;
  });

  // The top bar's count comes from the same numbers as the page's own ("2 of 7 approved"), so the two never disagree.
  // While the script is sent back (Fix whole script) and being rewritten, it says so instead.
  const scriptStepState = $derived(
    statusFor(stageById('script'), project.statuses)?.steps?.find((s) => s.key === 'script')?.state ?? null,
  );
  // Every scene is OK'd (or the script is approved): the voice is next, and it waits for the OK on its cost and voice.
  const voiceNext = $derived(
    ['approved', 'done'].includes(scriptStepState ?? '') ||
      (script.summary.scenes > 0 && script.summary.approved === script.summary.scenes),
  );
  // The script step moved (a new version submitted, sent back, approved): read the scenes again at once, so a script
  // that lands while this screen is open shows as its scene list without a reload.
  const scriptStepKey = $derived.by(() => {
    const step = statusFor(stageById('script'), project.statuses)?.steps?.find((s) => s.key === 'script');
    return step ? `${step.state}:${step.version ?? 0}` : '';
  });
  let lastStepKey = '';
  $effect(() => {
    const key = scriptStepKey;
    if (script.isFixture || !key || key === lastStepKey) return;
    const first = lastStepKey === '';
    lastStepKey = key;
    if (!first) untrack(() => void script.load());
  });

  $effect(() => {
    const { approved, scenes } = script.summary;
    if (scenes === 0) return;
    const rewriting =
      script.fixSent === 'all' || scriptStepState === 'changes' || script.data?.writing === true;
    screenBar.count = rewriting ? 'Rewriting the script…' : `${approved} of ${scenes} scenes OK`;
    return () => (screenBar.count = undefined);
  });

  // The selected scene is part of the address, so a reload or a link comes back to it.
  $effect(() => {
    const id = script.selected;
    if (!id) return;
    const query = new SvelteURLSearchParams(location.hash.split('?')[1] ?? '');
    query.set('scene', id);
    history.replaceState(null, '', `${location.pathname}${location.search}#/script?${query}`);
  });

  // A scene asked for keyboard focus (OK moved on, Cancel, Go to the next one): scroll it in and focus it.
  $effect(() => {
    const id = script.focusRequest;
    if (!id) return;
    script.focusRequest = null;
    void tick().then(() => {
      const row = list?.querySelector<HTMLElement>(`[data-beat="${id}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    });
  });

  const SWALLOW_MS = 300;
  function swallowLetter(letter: string) {
    const until = Date.now() + SWALLOW_MS;
    const drop = (input: InputEvent) => {
      if (Date.now() <= until && input.data === letter) input.preventDefault();
      removeEventListener('beforeinput', drop, true);
    };
    addEventListener('beforeinput', drop, true);
    setTimeout(() => removeEventListener('beforeinput', drop, true), SWALLOW_MS);
  }

  function onkeydown(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const shortcut = shortcutFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      defaultPrevented: event.defaultPrevented,
      tag: target?.tagName ?? '',
      editable: target?.isContentEditable ?? false,
    });
    if (!shortcut) return;
    // The focused scene, else (F and E from anywhere on the page) the selected one.
    const row = target?.closest<HTMLElement>('[data-beat]');
    const anywhere = shortcut === 'fix' || shortcut === 'edit';
    const beat =
      script.beats.find((b) => b.id === row?.dataset.beat) ?? (anywhere ? script.selectedBeat : undefined);
    if (!beat) return;
    const onRow = target === row;
    const moving = shortcut === 'next' || shortcut === 'previous';
    if (moving && !onRow) return;
    // Stop the key first, so the box it opens never gets the letter typed into it. Some input sends the letter as its
    // own event after the key press, so that one letter is dropped too, if it comes at once.
    event.preventDefault();
    if (shortcut === 'edit' || shortcut === 'fix') swallowLetter(event.key);
    if (shortcut === 'approve') script.approve(beat);
    else if (shortcut === 'edit') script.startEdit(beat);
    else if (shortcut === 'fix') script.openFix(beat.id);
    else script.step(beat.id, shortcut === 'next' ? 1 : -1);
  }
</script>

<svelte:window {onkeydown} />

<div class="screen">
  {#if fixture && !isFixtureMode(fixture)}
    <ErrorState title="No such fixture" detail={`Use one of ${FIXTURE_MODES.join(', ')}.`} />
  {/if}
  <ScreenHead
    kicker="Stage 1 · Script"
    title="Review your story"
    help="Edit each narration line, check its visual direction, and approve the scene."
  />
  {#if script.loadState === 'ready' && script.beats.length > 0}
    <ScriptToolbar />
    <RewriteRow />
    {#if script.fixOpen === 'all'}
      <FixNote
        target="all"
        what="the whole script"
        note={script.reopenStage
          ? 'The script is approved: this reopens it. The voice re-reads only the lines that change, cost shown first.'
          : undefined}
      />
    {/if}
    {#if script.fixSent === 'all'}
      <p class="sent" role="status">Fix sent · Mortiflix is rewriting the script from your note.</p>
    {/if}
    {#if script.beats.length > STRIP_FROM}<SceneStrip />{/if}
  {/if}
  <div class="doc" bind:this={list}>
    {#if script.loadState === 'loading'}
      <LoadingState text="Loading the script…" />
    {:else if script.loadState === 'too-old'}
      <EmptyState title="Coming in this build" body="The script screen needs a newer Mortiflix service." />
    {:else if script.loadState === 'failed'}
      <ErrorState title="Couldn't load the script" detail={script.loadError} onretry={() => script.retry()} />
    {:else if script.beats.length === 0}
      <ScriptWaiting writing={script.data?.writing === true} fixture={script.isFixture} />
    {:else}
      {#each script.beats as beat, index (beat.id)}
        <SceneRow {beat} {index} />
      {/each}
      {#if script.data?.writing}
        <p class="more" role="status">Mortiflix is still writing the next scenes…</p>
      {/if}
      {#if !script.isFixture}<VoiceCostOk ahead={voiceNext} />{/if}
    {/if}
  </div>
</div>

<style>
  .screen {
    display: grid;
    /* one column the screen wide: a wide row wraps or scrolls inside, never pushes the page past the window */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-12);
    align-content: start;
    min-width: 0;
  }
  .doc {
    display: grid;
    align-content: start;
    /* same room above the line as below it (owner 2026-11-03: balanced padding everywhere) */
    margin-top: var(--s-12);
    border-top: 1px solid var(--line);
  }
  .sent {
    color: var(--busy);
    font-size: var(--t14);
  }
  .more {
    padding: var(--s-16) var(--s-24);
    color: var(--busy);
    font-size: var(--t14);
  }
</style>
