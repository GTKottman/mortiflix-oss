<!-- A small number with − and +, for a setting saved at once. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';

  interface Props {
    label: string;
    help: string;
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
    onchange: (value: number) => void;
  }

  let { label, help, value, min, max, disabled = false, onchange }: Props = $props();
  const id = $props.id();
</script>

<div class="step">
  <div>
    <b id="{id}-label">{label}</b>
    <span class="why">{help} {min} to {max}.</span>
  </div>
  <div class="stepper" role="group" aria-labelledby="{id}-label">
    <Button
      square
      aria-label={`Fewer: ${label}`}
      disabled={disabled || value <= min}
      onclick={() => onchange(value - 1)}><span class="glyph">−</span></Button
    >
    <output aria-live="polite">{value}</output>
    <Button
      square
      aria-label={`More: ${label}`}
      disabled={disabled || value >= max}
      onclick={() => onchange(value + 1)}><span class="glyph">+</span></Button
    >
  </div>
</div>

<style>
  .step {
    --row-max: 720px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-16);
    align-items: center;
    max-width: var(--row-max);
    padding: var(--s-12) 0;
    border-bottom: 1px solid var(--line);
  }
  /* the section's own line follows: no second line, no extra room (owner 2026-11-03: balanced padding) */
  .step:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }
  b {
    display: block;
    font-weight: 600;
  }
  .why {
    display: block;
    color: var(--muted);
    font-size: var(--t13);
  }
  .stepper {
    /* The − and + buttons are a size between Button's sm and md; Button reads its height from --h. */
    --h: calc(var(--s-32) + var(--s-4));
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
  }
  .glyph {
    font-size: var(--t17);
  }
  output {
    min-width: calc(var(--s-24) + var(--s-4));
    font: 600 var(--t16) / 1 var(--body);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
</style>
