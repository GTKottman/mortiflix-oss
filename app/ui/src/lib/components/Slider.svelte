<!-- A slider with its value shown. Its ends can be labelled in words ("Calm" … "Busy") when the screen has
     those words; never invent them. -->
<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    startLabel?: string;
    endLabel?: string;
    /** How the value reads, e.g. (n) => `${n} s`. */
    format?: (value: number) => string;
    onchange?: (value: number) => void;
  }

  let {
    value = $bindable(),
    min,
    max,
    step = 1,
    label,
    startLabel,
    endLabel,
    format = String,
    onchange,
  }: Props = $props();
  const id = $props.id();
  const fill = $derived(max > min ? ((value - min) / (max - min)) * 100 : 0);
</script>

<div class="slider">
  <div class="top">
    <label for={id}>{label}</label>
    <output for={id}>{format(value)}</output>
  </div>
  <input
    {id}
    type="range"
    {min}
    {max}
    {step}
    bind:value
    aria-valuetext={format(value)}
    style:--fill="{fill}%"
    onchange={() => onchange?.(value)}
  />
  {#if startLabel || endLabel}
    <div class="ends" aria-hidden="true"><span>{startLabel}</span><span>{endLabel}</span></div>
  {/if}
</div>

<style>
  .slider {
    display: grid;
    gap: var(--s-4);
  }
  .top,
  .ends {
    display: flex;
    justify-content: space-between;
    gap: var(--s-16);
  }
  label {
    min-width: 0;
    font-size: var(--t14);
  }
  output {
    flex-shrink: 0;
    white-space: nowrap;
    font-size: var(--t14);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .ends {
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
  }
  input {
    width: 100%;
    height: var(--h-sm);
    background: none;
    appearance: none;
    cursor: pointer;
  }
  input::-webkit-slider-runnable-track {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: linear-gradient(to right, var(--violet) var(--fill), var(--ink-4) var(--fill));
  }
  input::-moz-range-track {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: var(--ink-4);
  }
  input::-moz-range-progress {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: var(--violet);
  }
  input::-webkit-slider-thumb {
    appearance: none;
    width: var(--knob);
    height: var(--knob);
    margin-top: calc((var(--s-4) - var(--knob)) / 2);
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
    transition:
      transform 200ms var(--ease-spring),
      box-shadow 200ms ease;
  }
  input:hover::-webkit-slider-thumb {
    transform: scale(1.22);
    box-shadow:
      0 0 0 4px rgba(177, 140, 255, 0.22),
      0 2px 6px rgba(0, 0, 0, 0.6);
  }
  input::-moz-range-thumb {
    width: var(--knob);
    height: var(--knob);
    border: 0;
    border-radius: 50%;
    background: var(--text);
  }
  @media (pointer: coarse) {
    input {
      min-height: var(--hit);
    }
  }
</style>
