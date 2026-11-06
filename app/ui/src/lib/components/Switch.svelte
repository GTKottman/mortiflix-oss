<!-- The one quiet switch (Lessons, Settings): only for things that apply at once. On = light knob + "On";
     off = hollow knob + "Off". Never green. With `hideLabel` the words are for screen readers only, and the
     caller places any visible words. With `controlled` a click only asks for the new value, so a refused change
     leaves the switch where it was. -->
<script lang="ts">
  interface Props {
    checked?: boolean;
    /** What it turns on, shown left of the switch. */
    label: string;
    /** Names the switch for screen readers without showing the words. */
    hideLabel?: boolean;
    /** The caller owns `checked`: a click calls `onchange` and nothing else. */
    controlled?: boolean;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(false),
    label,
    hideLabel = false,
    controlled = false,
    disabled = false,
    onchange,
  }: Props = $props();
  const id = $props.id();

  function toggle() {
    const next = !checked;
    if (!controlled) checked = next;
    onchange?.(next);
  }
</script>

{#snippet control()}
  <button
    type="button"
    class="switch"
    role="switch"
    aria-checked={checked}
    aria-label={hideLabel ? label : undefined}
    aria-labelledby={hideLabel ? undefined : `${id}-label`}
    {disabled}
    onclick={toggle}
  >
    <span class="track" aria-hidden="true"></span>
    <span class="word">{checked ? 'On' : 'Off'}</span>
  </button>
{/snippet}

{#if hideLabel}
  {@render control()}
{:else}
  <div class="row">
    <span id="{id}-label" class="label">{label}</span>
    {@render control()}
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-16);
    min-height: var(--h);
  }
  .label {
    min-width: 0;
    font-size: var(--t14);
  }
  .switch {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
    min-height: var(--h-sm);
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: 600 var(--t13) / 1 var(--body);
    white-space: nowrap;
    cursor: pointer;
  }
  .switch[aria-checked='true'] {
    color: var(--text);
  }
  .switch:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .track {
    position: relative;
    flex: none;
    width: var(--switch-w);
    height: var(--switch-h);
    border-radius: var(--r-pill);
    background: var(--ink-4);
    border: 1px solid var(--line);
    transition:
      background 220ms var(--ease-out-quart),
      border-color 220ms var(--ease-out-quart);
  }
  .track::after {
    content: '';
    position: absolute;
    top: var(--s-2);
    left: var(--s-2);
    width: var(--knob);
    height: var(--knob);
    border-radius: 50%;
    background: var(--faint);
    transition:
      left 260ms var(--ease-spring),
      background 200ms ease;
  }
  [aria-checked='true'] .track {
    background: var(--violet);
    border-color: var(--violet);
  }
  [aria-checked='true'] .track::after {
    left: calc(var(--switch-w) - var(--knob) - var(--s-4));
    background: var(--on-grad);
  }
  .word {
    min-width: var(--s-24);
  }
  @media (pointer: coarse) {
    .switch {
      min-height: var(--hit);
    }
  }
</style>
