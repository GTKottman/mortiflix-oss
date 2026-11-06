<!-- The inspector's top-right for a voice line: its state and the arrows to the next clip. -->
<script lang="ts">
  import { routeHref } from '../../lib/router.svelte';
  import LineStatus from './LineStatus.svelte';
  import MoreMenu, { type MenuItem } from './MoreMenu.svelte';
  import StepButtons from './StepButtons.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  let { model, line }: Props = $props();

  const id = $derived(line.node);
  const queued = $derived(model.basket.lines.has(id));
  const failed = $derived(line.state === 'needs you' && !line.path);
  const items = $derived<MenuItem[]>([
    { label: '▶ Preview current', disabled: !line.path, run: () => model.player.playLine(line) },
    { label: '▶ Preview in context', disabled: !line.path, run: () => model.previewInContext(line) },
    queued
      ? { label: 'Remove from the queue', run: () => model.basket.unstage(id) }
      : {
          label: failed
            ? 'Queue a new try (paid, confirmed first)'
            : 'Queue a re-read (paid, confirmed first)',
          disabled: !model.cast.ready || model.isSent(id) || (!line.path && !failed) || Boolean(model.noKey),
          title: model.noKey ?? undefined,
          run: () => model.queueReread(id),
        },
    {
      label: line.state === 'approved' ? 'Approved' : 'Approve this line',
      disabled: line.state === 'approved' || !line.path,
      run: () => void model.approve(line),
    },
    {
      label: 'Change the voice…',
      divider: true,
      run: () => (model.castOpen = true),
    },
    {
      label: 'Edit the words on Script ›',
      href: routeHref(`/script?scene=${encodeURIComponent(line.beat)}`),
    },
    {
      label: 'Copy the words',
      run: () => void navigator.clipboard.writeText(line.words).catch(() => undefined),
    },
    { label: 'Next to review ›', divider: true, run: () => model.goToIssue(1) },
  ]);
</script>

<LineStatus {model} {line} />
<StepButtons
  index={model.lines.indexOf(line)}
  count={model.lines.length}
  name="clip"
  onstep={(direction) => model.step(direction)}
/>
<MoreMenu label={`More for ${model.nameOf(line.node)}`} {items} />
