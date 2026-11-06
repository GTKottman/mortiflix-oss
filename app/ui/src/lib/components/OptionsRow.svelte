<!-- The options row, live: asks the service for Claude's options for this stage and piece (as many as Settings
     says), and swaps fresh ones in only while the pointer and focus are off the row (owner, approved).
     Shows nothing while the service has no options; says so when they could not be loaded. -->
<script lang="ts">
  import type { OptionRunResult, OptionsResult, StudioOption, StudioQuestion } from '../service/types';
  import type { StageId } from '../stages';
  import { useProject, useService, useSettings } from '../stores/context';
  import ErrorState from './ErrorState.svelte';
  import OptionsList from './OptionsList.svelte';

  interface Props {
    stage: Exclude<StageId, 'finish'>;
    /** The piece on screen: b01 beat, sf01 frame, s02 scene, a line or cue id. Leave out for the whole stage. */
    target?: string;
    targetLabel?: string;
    /** An option ran: reload the piece it changed. */
    onrun?: (option: StudioOption, result: OptionRunResult) => void;
  }

  let { stage, target, targetLabel, onrun }: Props = $props();

  const client = useService();
  const project = useProject();
  const settings = useSettings();

  let result = $state<OptionsResult | null>(null);
  let failed = $state<string | null>(null);
  let busy = $state(false);
  let stale = $state(false);
  let request = 0;

  const params = $derived({
    stage,
    ...(project.id ? { project: project.id } : {}),
    ...(target ? { target } : {}),
  });

  async function load() {
    const mine = ++request;
    stale = false;
    try {
      const answer = await client.call<OptionsResult>('options.get', params);
      if (mine !== request) return;
      result = answer;
      failed = null;
    } catch (error) {
      if (mine !== request) return;
      result = null;
      failed = error instanceof Error ? error.message : 'unknown error';
    }
  }

  $effect(() => {
    void params;
    // Another stage, piece or project: the old options belong to the old one and must not stay clickable while the
    // new ones load (options.run sends only the option's id).
    result = null;
    failed = null;
    void load();
  });

  $effect(() =>
    client.on<{ stage: string; target?: string | null }>('options.ready', (event) => {
      if (event.stage !== stage || (event.target ?? null) !== (target ?? null)) return;
      if (busy) stale = true;
      else void load();
    }),
  );

  $effect(() => {
    if (stale && !busy) void load();
  });

  async function run(option: StudioOption, extra: Record<string, unknown>) {
    const answer = await client.call<OptionRunResult>('options.run', {
      id: option.id,
      ...(project.id ? { project: project.id } : {}),
      ...extra,
    });
    if (!answer.asked) onrun?.(option, answer);
    return answer;
  }

  async function answer(question: StudioQuestion, choice: string) {
    await client.call('chat.answer', { question: question.id, value: choice });
    await load();
  }
</script>

{#if result}
  <OptionsList
    options={result.options.slice(0, settings.optionsCount)}
    questions={result.questions ?? []}
    targetLabel={targetLabel ?? target}
    {run}
    {answer}
    onbusy={(value) => (busy = value)}
    ondone={load}
  />
{:else if failed}
  <ErrorState inline title="The options did not load" detail={failed} onretry={load} />
{/if}
