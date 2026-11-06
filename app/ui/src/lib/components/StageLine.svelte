<!-- The stage line: the site's flow line. Done = check, current = white underline. Finish is not a link here.
     A stage after the first unfinished one is grey and not a link (owner: "make the scenes gray so we can't move forward"). -->
<script lang="ts">
  import { routeHref } from '../router.svelte';
  import { isStageDone, STAGE_LINE, statusFor, type StageId } from '../stages';
  import { useProject } from '../stores/context';

  interface Props {
    current: StageId;
  }

  let { current }: Props = $props();
  const project = useProject();

  // The first stage that isn't done yet; every stage after it is locked.
  const firstOpen = $derived(
    STAGE_LINE.findIndex((stage) => !isStageDone(statusFor(stage, project.statuses))),
  );
  const locked = (i: number): boolean => firstOpen >= 0 && i > firstOpen;
</script>

<nav class="stages" aria-label="Stages">
  {#each STAGE_LINE as stage, i (stage.id)}
    {#if i > 0}<span class="sep" aria-hidden="true">›</span>{/if}
    {#if locked(i)}
      <span class="stage locked" aria-disabled="true" title="Opens when the step before it is OK"
        >{stage.label}</span
      >
    {:else}
      <a
        class="stage"
        class:on={stage.id === current}
        class:done={stage.id !== current && isStageDone(statusFor(stage, project.statuses))}
        href={routeHref(`/${stage.id}`)}
        aria-current={stage.id === current ? 'step' : undefined}>{stage.label}</a
      >
    {/if}
  {/each}
</nav>

<style>
  .stages {
    display: flex;
    align-items: stretch;
    align-self: stretch;
    margin: 0 auto;
    /* on a narrow screen the stages scroll sideways inside the bar, never widen the page (owner's tablet 2026-11-03) */
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .stages > :global(*) {
    flex-shrink: 0;
  }
  .stage {
    display: inline-flex;
    align-items: center;
    gap: var(--s-4);
    border-bottom: 2px solid transparent;
    color: var(--faint);
    font: 600 var(--t11) / 1 var(--body);
    letter-spacing: var(--track-stage);
    text-transform: uppercase;
    text-decoration: none;
    white-space: nowrap;
    transition: color var(--dur-fast) var(--ease);
  }
  .stage:hover {
    color: var(--text);
  }
  .locked,
  .locked:hover {
    color: var(--faint);
    opacity: 0.4;
    cursor: not-allowed;
  }
  .done {
    color: var(--muted);
  }
  .done::before {
    content: '\2713';
    color: var(--good);
    letter-spacing: 0;
  }
  .on {
    color: var(--text);
    border-bottom-color: var(--text);
  }
  .sep {
    align-self: center;
    margin: 0 var(--s-12);
    color: var(--faint);
    font-size: var(--t13);
  }
  @media (max-width: 1599px) {
    .sep {
      margin: 0 var(--s-8);
    }
  }
</style>
