<!-- The top bar on every screen. On a stage: logo · project · stage line · count + Next · token coin.
     Elsewhere: Projects | Lessons | Settings · logo in the middle · the screen's own buttons · token coin. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { routeHref } from '../router.svelte';
  import { nextStage, stageById, stageCount, statusFor, type Stage, type StageId } from '../stages';
  import { useProblems, useProject, useRouter, useService } from '../stores/context';
  import Button from './Button.svelte';
  import SectionTabs, { type Section } from './SectionTabs.svelte';
  import StageLine from './StageLine.svelte';
  import TokenButton from './TokenButton.svelte';

  interface Props {
    /** The stage on screen. Leave out on Projects / Lessons / Settings. */
    stage?: StageId;
    section?: Section;
    /** Overrides the automatic count, e.g. "Look picked: Look A". */
    count?: string;
    /** Why Next cannot be used yet; shown in the count's place while it is disabled. */
    why?: string;
    /** The screen has its own gradient button: Next becomes an outline button. */
    ownPrimary?: boolean;
    /** The token dropdown is open. */
    usageOpen?: boolean;
    /** The screen's own buttons, right side (sections only). */
    actions?: Snippet;
  }

  let {
    stage,
    section = 'projects',
    count,
    why,
    ownPrimary = false,
    usageOpen = $bindable(false),
    actions,
  }: Props = $props();

  const project = useProject();
  const client = useService();
  const router = useRouter();
  const problems = useProblems();

  const here = $derived(stage ? stageById(stage) : null);
  const next = $derived(stage ? nextStage(stage) : null);
  const auto = $derived(
    here ? stageCount(here, statusFor(here, project.statuses), project.statuses.length > 0) : null,
  );
  const countText = $derived(count ?? (why && !auto?.ready ? why : (auto?.text ?? '')));
  let moving = $state(false);
  const NEXT_FAILED = 'stage-next';

  async function moveOn(from: Stage, to: Stage): Promise<string> {
    await client.call('stage.set', { stage: to.index, from: from.index, done: true });
    router.go(`/${to.id}`);
    return `${from.label} is done. On to ${to.label}.`;
  }

  async function goNext() {
    if (!here || !next) return;
    const [from, to] = [here, next];
    moving = true;
    try {
      await moveOn(from, to);
      problems.clear(NEXT_FAILED);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({
        id: NEXT_FAILED,
        kind: 'bad',
        text: `Could not move on to ${to.label}: ${reason}.`,
        fix: { label: 'Try again', run: () => moveOn(from, to) },
      });
    } finally {
      moving = false;
    }
  }
</script>

<header class="bar" class:section={!here}>
  <a class="logo" href={routeHref('/')}>Mortiflix</a>
  {#if here}
    <span class="project" title={project.title}>{project.title}</span>
    <Button variant="text" size="sm" href={routeHref('/assets')}>Assets</Button>
    <StageLine current={here.id} />
    <div class="next">
      <span class="count" class:finish={here.id === 'finish'} id="next-count">{countText}</span>
      {#if here.id === 'finish'}
        <Button variant="text" href={routeHref('/sound')}>‹ Sound</Button>
      {:else if next}
        <Button
          variant={ownPrimary ? 'secondary' : 'primary'}
          disabled={!auto?.ready || moving}
          title={auto?.ready ? undefined : (why ?? auto?.why)}
          aria-describedby="next-count"
          onclick={goNext}>{moving ? 'Moving on…' : `Next: ${next.label} ›`}</Button
        >
      {/if}
    </div>
  {:else}
    <SectionTabs current={section} />
    <div class="slot">{@render actions?.()}</div>
  {/if}
  <TokenButton bind:open={usageOpen} />
</header>

<style>
  .bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s-24);
    min-height: var(--bar-h);
    padding: 0 var(--bar-pad-x);
    border-bottom: 1px solid var(--line);
    background: var(--ink);
  }
  .logo {
    flex-shrink: 0;
    color: var(--text);
    font: 600 var(--t17) / 1 var(--display);
    letter-spacing: var(--track-logo);
    text-transform: uppercase;
    text-decoration: none;
    white-space: nowrap;
  }
  /* Projects, Lessons, Settings: the name in the middle of the bar, the tabs at the start (owner's drawing 2026-11-05) */
  .section .logo {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }
  .project {
    min-width: 0;
    max-width: var(--project-max);
    padding-left: var(--s-24);
    border-left: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--t14);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .project:empty {
    display: none;
  }
  .next {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--s-16);
  }
  .count {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .finish {
    color: var(--text);
  }
  .slot {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--s-12);
    margin-left: auto;
  }
  @media (max-width: 1199px) {
    .count {
      display: none;
    }
  }
  @media (max-width: 1599px) {
    .bar {
      gap: var(--s-16);
    }
    .project {
      padding-left: var(--s-16);
    }
  }
</style>
