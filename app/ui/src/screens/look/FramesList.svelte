<!-- All the frames, by round, with how many are OK. "Stop here: these frames are enough" (once round 1 is OK'd) ends the
     Look early: it skips the frames not made yet (asks first, in place; its hover says what it does). -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import FrameCheckGrid from '../../lib/components/FrameCheckGrid.svelte';
  import ReviewSection from '../../lib/components/ReviewSection.svelte';
  import { useProblems } from '../../lib/stores/context';
  import { plural } from '../../lib/words';
  import type { FramesState, ReviewItem, ReviewService } from '../../lib/review/types';
  import { canStopEarly, frameRows, frameTotal, skipQuestion, STOP_LABEL, stopHelp } from './frames';

  interface Props {
    frames: FramesState;
    items: readonly ReviewItem[];
    current: string | null;
    activeId: string | undefined;
    service: ReviewService;
    onselect: (id: string) => void;
    onchange: () => void;
  }

  let { frames, items, current, activeId, service, onselect, onchange }: Props = $props();

  const problems = useProblems();
  let asking = $state(false);
  let keep = $state<HTMLElement>();
  let enough = $state<HTMLElement>();

  // The question takes the button's place, so focus moves with it (to the safe answer) and back.
  async function ask(on: boolean) {
    asking = on;
    await tick();
    (on ? keep : enough)?.focus();
  }

  let sending = $state(false);
  /** Sends the Fixes kept so far now, without deciding the other frames first. */
  async function sendFixes() {
    sending = true;
    try {
      await service.call('frames.send_fixes');
      problems.clear('look-send-fixes');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: 'look-send-fixes', kind: 'warn', text: `The fixes were not sent: ${reason}` });
    }
    sending = false;
    onchange();
  }

  async function stop() {
    asking = false;
    try {
      await service.call('frames.enough');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: 'look-enough', kind: 'warn', text: `Could not stop here: ${reason}` });
    }
    onchange();
  }
</script>

<ReviewSection title="Frames">
  {#snippet aside()}
    <span class="n">{frames.ok} of {frameTotal(frames)} OK</span>
    {#if frames.fixes_waiting}
      <Button size="sm" variant="primary" disabled={sending} onclick={() => void sendFixes()}
        >Send {plural(frames.fixes_waiting, 'fix', 'fixes')}</Button
      >
    {/if}
    {#if canStopEarly(frames)}
      {#if asking}
        <span class="ask" role="group" aria-label={skipQuestion(frames)}>
          {skipQuestion(frames)}
          <Button size="sm" variant="danger" onclick={stop}>Stop here</Button>
          <Button size="sm" bind:element={keep} onclick={() => void ask(false)}>Keep going</Button>
        </span>
      {:else}
        <Button
          size="sm"
          variant="text"
          title={stopHelp(frames)}
          bind:element={enough}
          onclick={() => void ask(true)}>{STOP_LABEL}</Button
        >
      {/if}
    {/if}
  {/snippet}
  <FrameCheckGrid label="Frames" rows={frameRows(frames, items, activeId)} {current} {onselect} />
</ReviewSection>

<style>
  .n {
    white-space: nowrap;
  }
  .ask {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    border: 1px solid var(--warn);
    border-radius: var(--r);
    padding: var(--s-4) var(--s-8);
    color: var(--text);
    font-size: var(--t13);
  }
</style>
