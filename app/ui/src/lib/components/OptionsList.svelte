<!-- Claude-made options for the piece on screen (no chat, owner 2026-11-01): one pill per option, Claude's open
     questions as one-click choices. Click an option = one line saying what it does + Do it (cost first when
     paid) + Cancel. Data comes in; OptionsRow connects it to the service. -->
<script lang="ts">
  import type { OptionRunResult, StudioOption, StudioQuestion } from '../service/types';
  import Button from './Button.svelte';
  import CostPrompt from './CostPrompt.svelte';
  import DoneNote from './DoneNote.svelte';
  import ErrorState from './ErrorState.svelte';
  import Working from './Working.svelte';

  interface Props {
    options: readonly StudioOption[];
    questions?: readonly StudioQuestion[];
    /** "scene 2": the row starts with "For scene 2:". */
    targetLabel?: string;
    run: (option: StudioOption, extra: Record<string, unknown>) => Promise<OptionRunResult>;
    answer: (question: StudioQuestion, choice: string) => Promise<void>;
    /** Called when the row becomes busy or free. Busy = the pointer or focus is on it, or a preview is open:
        fresh options wait until it is free. */
    onbusy?: (busy: boolean) => void;
    /** An option finished and its note has gone. */
    ondone?: () => void;
  }

  let { options, questions = [], targetLabel, run, answer, onbusy, ondone }: Props = $props();

  let openId = $state<string | null>(null);
  let asked = $state<string | null>(null);
  let running = $state(false);
  let failed = $state<string | null>(null);
  let done = $state<string | null>(null);
  let hovering = $state(false);
  let focused = $state(false);
  let go = $state<HTMLElement>();

  const open = $derived(options.find((o) => o.id === openId) ?? null);
  const askable = $derived(questions.filter((q) => q.choices.length > 0));

  const busy = $derived(hovering || focused || open !== null);

  $effect(() => onbusy?.(busy));
  $effect(() => {
    if (open) go?.focus();
  });

  function toggle(option: StudioOption) {
    openId = openId === option.id ? null : option.id;
    asked = null;
    failed = null;
  }

  async function start(extra: Record<string, unknown> = {}) {
    if (!open) return;
    running = true;
    failed = null;
    try {
      const result = await run(open, asked ? { ...extra, confirm: true } : extra);
      if (result.asked) {
        asked = result.text ?? '';
        return;
      }
      openId = null;
      asked = null;
      done = result.does ?? 'Done.';
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    } finally {
      running = false;
    }
  }

  async function choose(question: StudioQuestion, choice: string) {
    failed = null;
    try {
      await answer(question, choice);
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    }
  }

  function close() {
    openId = null;
    asked = null;
    failed = null;
  }
</script>

{#if options.length || askable.length || done}
  <div
    class="options"
    role="group"
    aria-label={targetLabel ? `Options for ${targetLabel}` : 'Options'}
    onpointerenter={() => (hovering = true)}
    onpointerleave={() => (hovering = false)}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    {#each askable as question (question.id)}
      <div class="question" role="group" aria-label={question.text}>
        <span>{question.text}</span>
        <!-- choices are Claude's words and may repeat: keyed by place, a repeated key throws each_key_duplicate -->
        {#each question.choices as choice, i (i)}
          <Button size="sm" onclick={() => choose(question, choice)}>{choice}</Button>
        {/each}
        {#if question.default != null}<span class="default">Default: {question.default}</span>{/if}
      </div>
    {/each}

    {#if options.length && targetLabel}<span class="for">For {targetLabel}:</span>{/if}
    {#each options as option (option.id)}
      <Button size="sm" title={option.does} pressed={openId === option.id} onclick={() => toggle(option)}>
        {option.label}
      </Button>
    {/each}

    {#if open}
      <div class="preview" role="group" aria-label="What this does">
        <span class="does">{asked ?? open.does}</span>
        {#if open.cost}
          <CostPrompt label="Do it" cost={open.cost} run={() => start({ confirm_cost: true })} />
        {:else}
          <Button bind:element={go} size="sm" disabled={running} onclick={() => start()}>
            {asked ? 'Remake it' : 'Do it'}
          </Button>
        {/if}
        <Button variant="text" size="sm" disabled={running} onclick={close}
          >{asked ? 'Keep it' : 'Cancel'}</Button
        >
        {#if running}<Working text="Mortiflix is doing it…" />{/if}
        {#if failed}<ErrorState inline title="Could not do that" detail={failed} />{/if}
      </div>
    {/if}

    {#if failed && !open}<ErrorState inline title="Could not answer that" detail={failed} />{/if}

    {#if done}
      <div class="note">
        <DoneNote
          text={done}
          ondone={() => {
            done = null;
            ondone?.();
          }}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    min-height: var(--h-sm);
  }
  .for {
    flex-shrink: 0;
    white-space: nowrap;
    margin-right: var(--s-4);
    color: var(--faint);
    font-size: var(--t13);
  }
  .question,
  .preview {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  .question {
    font-size: var(--t14);
  }
  .default {
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
  }
  .preview {
    color: var(--muted);
    font-size: var(--t13);
  }
  .does {
    max-width: var(--reading);
    color: var(--text);
  }
  .note {
    flex-basis: 100%;
  }
</style>
