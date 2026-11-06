<!-- The component kit (/app/#/kit): every shared piece in its states, for screenshots and review.
     Sample words only; nothing here talks to a paid service. -->
<script lang="ts">
  import Accordion from '../lib/components/Accordion.svelte';
  import Button from '../lib/components/Button.svelte';
  import CostPrompt from '../lib/components/CostPrompt.svelte';
  import DoneNote from '../lib/components/DoneNote.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import ErrorState from '../lib/components/ErrorState.svelte';
  import FixItStrip from '../lib/components/FixItStrip.svelte';
  import LoadingState from '../lib/components/LoadingState.svelte';
  import OptionsList from '../lib/components/OptionsList.svelte';
  import ScreenHead from '../lib/components/ScreenHead.svelte';
  import Slider from '../lib/components/Slider.svelte';
  import Switch from '../lib/components/Switch.svelte';
  import Tabs, { tabId } from '../lib/components/Tabs.svelte';
  import UsagePanel from '../lib/components/UsagePanel.svelte';
  import VideoPlayer from '../lib/components/VideoPlayer.svelte';
  import { fileUrl } from '../lib/files';
  import type { Cost, StudioOption, StudioQuestion } from '../lib/service/types';
  import { Problems } from '../lib/stores/problems.svelte';
  import { sampleUsage } from '../lib/usage/sample';
  import type { UsageRange } from '../lib/usage/types';
  import KitSection from './KitSection.svelte';

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const fixed = async () => 'Reconnected and redrew the screen.';
  const KEY_TEXT =
    'ElevenLabs has no key yet. Scripts, looks and stills still work. Voice waits for the key.';

  function strip(setup: (problems: Problems) => void): Problems {
    const problems = new Problems({ doneMs: 60 * 60 * 1000 });
    setup(problems);
    return problems;
  }
  const oneProblem = strip((p) =>
    p.raise({ id: 'key', text: KEY_TEXT, fix: { label: 'Add key', run: fixed } }),
  );
  const threeProblems = strip((p) => {
    p.raise({ id: 'key', text: KEY_TEXT, fix: { run: fixed } });
    p.raise({
      id: 'link',
      kind: 'bad',
      text: 'The app and the service lost each other.',
      fix: { run: fixed },
    });
    p.raise({ id: 'tools', text: 'Tool status is 12 minutes old.', fix: { run: fixed } });
  });
  const failedFix = strip((p) => {
    p.raise({
      id: 'tablet',
      text: 'The tablet has older notes than the app.',
      fix: { run: () => Promise.reject(new Error('the service said no')) },
    });
    void p.fix();
  });
  const plainReason = strip((p) =>
    p.raise({ id: 'credits', kind: 'bad', text: 'ElevenLabs is out of credits. They come back on 18 Nov.' }),
  );
  const fixDone = strip((p) => {
    p.raise({
      id: 'paused',
      text: 'The AI stopped before it finished.',
      fix: { run: async () => 'The AI took over. It goes on by itself.' },
    });
    void p.fix();
  });

  const voiceCost: Cost = {
    what: 'ElevenLabs credits',
    amount: '3,400',
    note: '12 lines, about 2 minutes of voice',
  };
  const options: StudioOption[] = [
    { id: 'shorter', label: 'Shorter', does: 'Cuts scene 2 to about 6 seconds and keeps the last line.' },
    { id: 'hook', label: 'Stronger hook', does: 'Rewrites the first line so it opens on the threat.' },
    { id: 'plain', label: 'Plainer words', does: 'Swaps the jargon in scene 2 for everyday words.' },
    {
      id: 'voice',
      label: 'Remake the voice',
      does: 'Records scene 2 again with the calmer take.',
      cost: voiceCost,
    },
  ];
  const questions: StudioQuestion[] = [
    { id: 'q1', text: 'Should the outro name the patch dates?', choices: ['Yes', 'No'], default: 'No' },
  ];
  const runOption = async (option: StudioOption) => {
    await pause(500);
    return { does: `${option.label}: done. Scene 2 is being remade.` };
  };

  let rangeTab = $state<'today' | 'week' | 'month'>('week');
  let usageRange = $state<UsageRange>('week');
  const usage = $derived(sampleUsage(usageRange, 'black-october'));
  let lessonsOn = $state(true);
  let tabletOn = $state(false);
  let optionsCount = $state(4);
  let pace = $state(60);
</script>

<ScreenHead
  kicker="Mortiflix · component kit"
  title="Shared pieces"
  help="Every shared component in its states. Screens are built from these, so a change here shows everywhere."
/>

<KitSection title="Video player, with markers">
  <div class="player-sample">
    <VideoPlayer
      src={fileUrl('/tmp/mfx-test-studio/fixtures/finish-clip.mp4')}
      label="Sample clip"
      markers={[
        { id: 's1', time: 1.5, label: 'Scene 1' },
        { id: 's2', time: 3, label: 'Scene 2' },
        { id: 's3', time: 4.5, label: 'Scene 3' },
      ]}
    />
  </div>
</KitSection>

<KitSection title="Buttons">
  <div class="row">
    <Button variant="primary">Make the stills</Button>
    <Button>Open Look</Button>
    <Button variant="text">Cancel</Button>
    <Button variant="cost">Make 12 lines</Button>
    <Button variant="danger">Delete project</Button>
    <Button variant="primary" disabled>Next: Sound ›</Button>
    <Button disabled>Waiting</Button>
  </div>
  <div class="row">
    <Button size="sm">Small</Button>
    <Button>Normal</Button>
    <Button size="lg" variant="primary">Large primary</Button>
    <Button pressed>Pressed</Button>
  </div>
</KitSection>

<KitSection title="Fix it strip">
  <div class="stack">
    <FixItStrip problems={oneProblem} />
    <FixItStrip problems={threeProblems} />
    <FixItStrip problems={failedFix} />
    <FixItStrip problems={plainReason} />
    <FixItStrip problems={fixDone} />
  </div>
</KitSection>

<KitSection title="Options row">
  <OptionsList {options} {questions} targetLabel="scene 2" run={runOption} answer={() => pause(300)} />
</KitSection>

<KitSection title="Cost first">
  <div class="row">
    <CostPrompt label="Make 12 lines" cost={voiceCost} run={() => pause(500)} />
    <CostPrompt
      label="Make 12 lines"
      cost={voiceCost}
      asking
      test={{ label: 'Test 1 line first', amount: '280', run: () => pause(500) }}
      run={() => pause(500)}
    />
  </div>
</KitSection>

<div class="pair">
  <KitSection title="Loading, empty, error">
    <LoadingState text="Loading the stills…" delay={0} />
    <EmptyState title="No stills yet" body="Stills are drawn after the look is picked.">
      {#snippet action()}<Button>Open Look</Button>{/snippet}
    </EmptyState>
    <ErrorState
      title="Could not load the stills"
      detail="The service did not answer in time."
      onretry={() => {}}
    />
    <ErrorState inline title="Could not save that" detail="The file is open elsewhere." />
    <DoneNote text="Saved. Scene 2 is being remade." ms={0} />
  </KitSection>

  <KitSection title="Accordion, tabs, switch, slider">
    <Accordion title="File details" summary="3 files · 48 MB">
      <p class="muted">voice.wav, music.wav, final.mp4</p>
    </Accordion>
    <Accordion title="Advanced" summary="2 changed" open>
      <p class="muted">Frames per round and scenes per group of stills.</p>
    </Accordion>
    <Tabs
      items={[
        { id: 'today', label: 'Today' },
        { id: 'week', label: 'Week' },
        { id: 'month', label: 'Month' },
      ]}
      bind:value={rangeTab}
      label="Kit range"
      group="kit-range"
    />
    <div class="muted" role="tabpanel" id="kit-range-panel" aria-labelledby={tabId('kit-range', rangeTab)}>
      Showing: {rangeTab}
    </div>
    <Switch label="Use lessons in every project" bind:checked={lessonsOn} />
    <Switch label="Send scenes to the tablet" bind:checked={tabletOn} />
    <Switch label="Video Notes (needs the tablet)" disabled />
    <Slider
      label="How many options to see"
      bind:value={optionsCount}
      min={1}
      max={8}
      startLabel="1"
      endLabel="8"
    />
    <Slider
      label="Pace"
      bind:value={pace}
      min={0}
      max={100}
      startLabel="Calm"
      endLabel="Busy"
      format={(n) => `${n}%`}
    />
  </KitSection>
</div>

<KitSection title="Token dropdown (sample numbers)">
  <div class="menu-sample">
    <UsagePanel
      {usage}
      source="sample"
      range={usageRange}
      hasProject
      onrange={(range) => (usageRange = range)}
      onretry={() => {}}
    />
  </div>
</KitSection>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
  }
  .stack {
    display: grid;
    border-top: 1px solid var(--line);
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-48);
  }
  .player-sample {
    width: min(100%, 880px);
  }
  .muted {
    color: var(--muted);
    font-size: var(--t14);
  }
  .menu-sample {
    width: var(--menu-w);
    border: 1px solid var(--line-2);
    border-radius: var(--r-lg);
    background: var(--ink-2);
  }
</style>
