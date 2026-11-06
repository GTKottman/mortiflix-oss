<!-- The visual style as small pictures to pick from (a radio group). -->
<script lang="ts">
  import type { Choice, Value } from './types';

  interface Props {
    choices: readonly Choice[];
    value: Value;
    label: string;
    onpick: (value: string) => void;
  }

  let { choices, value, label, onpick }: Props = $props();
</script>

{#snippet frame(art: string)}
  <svg viewBox="0 0 120 72" aria-hidden="true" class={art}>
    {#if art === 'auto'}
      <text x="60" y="42" text-anchor="middle" font-size="22" class="faint">Auto</text>
    {:else if art === 'custom'}
      <path d="M30 50 L60 20 L90 50" fill="none" stroke-width="3" stroke-dasharray="5 4" class="dashed" />
    {:else if art === 'editorial'}
      <rect x="10" y="10" width="60" height="8" class="dark" />
      <rect x="10" y="24" width="100" height="2" class="dark" />
      <rect x="10" y="32" width="46" height="3" class="grey" />
      <rect x="10" y="40" width="46" height="3" class="grey" />
      <rect x="10" y="48" width="38" height="3" class="grey" />
      <rect x="66" y="32" width="44" height="30" class="violet" />
    {:else if art === 'kinetic_typography'}
      <text x="8" y="34" font-size="30" font-weight="800" class="light">MOVE</text>
      <text x="30" y="62" font-size="26" font-weight="800" transform="rotate(-4 30 62)" class="cyan"
        >FAST</text
      >
    {:else if art === '3d'}
      <polygon points="60,12 90,28 60,44 30,28" class="violet" />
      <polygon points="30,28 60,44 60,64 30,48" class="deep" />
      <polygon points="90,28 60,44 60,64 90,48" class="pink" />
    {:else if art === 'minimalist'}
      <circle cx="60" cy="36" r="12" class="dark" />
    {/if}
  </svg>
{/snippet}

<div class="styles" role="radiogroup" aria-label={label}>
  {#each choices as choice (choice.value)}
    {@const on = String(choice.value) === String(value)}
    <button
      type="button"
      class="style"
      class:selected={on}
      role="radio"
      aria-checked={on}
      onclick={() => onpick(String(choice.value))}
    >
      {@render frame(String(choice.value))}
      <span title={choice.label}>{choice.label}</span>
    </button>
  {/each}
</div>

<style>
  /* The small pictures are drawn with the brand's own colours; the grounds and text come from the tokens. */
  .styles {
    --thumb-min: 150px;
    --picture-h: 72px;
    --art-violet: var(--violet);
    --art-deep: var(--violet-deep);
    --art-pink: var(--pink);
    --art-cyan: var(--cyan);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--thumb-min), 1fr));
    gap: var(--s-12);
  }
  .style {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    font-size: var(--t13);
    text-align: center;
    cursor: pointer;
  }
  .style span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .style:hover {
    border-color: var(--line-hover);
  }
  .selected {
    border-color: var(--text);
    color: var(--text);
  }
  svg {
    display: block;
    width: 100%;
    height: var(--picture-h);
    border-radius: var(--r-sm);
    background: var(--ink-3);
    font-family: var(--body);
  }
  .editorial,
  .minimalist {
    background: var(--text);
  }
  .kinetic_typography {
    background: var(--ink);
  }
  .faint {
    fill: var(--muted);
  }
  .dashed {
    stroke: var(--muted);
  }
  .dark {
    fill: var(--ink);
  }
  .grey {
    fill: var(--faint);
  }
  .light {
    fill: var(--text);
  }
  .violet {
    fill: var(--art-violet);
  }
  .deep {
    fill: var(--art-deep);
  }
  .pink {
    fill: var(--art-pink);
  }
  .cyan {
    fill: var(--art-cyan);
  }
</style>
