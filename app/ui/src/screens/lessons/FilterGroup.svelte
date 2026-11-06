<!-- One group of the filter rail (Section, Scope or Status): a kicker and one button per choice with its count. -->
<script lang="ts" generics="Id extends string">
  import type { Choice } from './lessons';

  interface Props {
    title: string;
    /** The title over the middle of the rail (Section, in the owner's drawing). */
    centered?: boolean;
    choices: readonly Choice<Id>[];
    onpick: (id: Id) => void;
  }

  let { title, centered = false, choices, onpick }: Props = $props();
</script>

<div class="group" role="group" aria-label={title}>
  <span class="kicker" class:centered>{title}</span>
  <div class="choices">
    {#each choices as choice (choice.id)}
      <button
        type="button"
        class:selected={choice.selected}
        aria-pressed={choice.selected}
        onclick={() => onpick(choice.id)}
      >
        <span class="label" title={choice.label}>{choice.label}</span>
        <span class="count">{choice.count}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .group,
  .choices {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--row-gap);
  }
  .group {
    --kicker-h: 40px;
    --row-h: 50px;
    --row-gap: 7px;
    --row-pad: 18px;
    --row-size: var(--t20);
    --count-size: var(--t17);
    gap: 0;
  }
  .kicker {
    min-height: var(--kicker-h);
    padding: 0 var(--s-16);
    color: var(--faint);
    font-size: var(--t17);
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .centered {
    text-align: center;
  }
  button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-8);
    width: 100%;
    min-height: var(--row-h);
    padding: 0 var(--row-pad);
    border: 1px solid transparent;
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--row-size);
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--line);
    color: var(--text);
  }
  .selected {
    background: var(--ink-3);
    color: var(--text);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--count-size);
    font-variant-numeric: tabular-nums;
  }
  .selected .count {
    color: var(--muted);
  }
  @media (max-width: 1599px) {
    .group {
      --kicker-h: var(--s-24);
      --row-h: var(--h);
      --row-gap: var(--s-4);
      --row-pad: var(--s-12);
      --row-size: var(--t14);
      --count-size: var(--t12);
    }
    .kicker {
      padding: 0 var(--s-12);
      font-size: var(--t12);
    }
  }
  @media (max-width: 1199px) {
    .group,
    .choices {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      overflow-x: auto;
      padding-bottom: var(--s-4);
    }
    .choices {
      display: contents;
    }
    .kicker {
      flex: none;
      padding: 0 var(--s-8) 0 0;
    }
    button {
      flex: none;
      width: auto;
      border-color: var(--line-2);
    }
  }
</style>
