<!-- One "by …" list (by stage, by model): name, a bar for its share of Claude tokens, then tokens and
     ElevenLabs credits (credits only on an ElevenLabs row). -->
<script lang="ts">
  import { compactCount, share } from '../usage/format';
  import type { UsageGroup } from '../usage/types';

  interface Props {
    title: string;
    rows: readonly UsageGroup[];
  }

  let { title, rows }: Props = $props();
  /** ElevenLabs credits; after a token count it reads "· 1.3k cr". */
  const credits = (row: UsageGroup): string =>
    `${row.claude_tokens ? '· ' : ''}${compactCount(row.elevenlabs_credits)} ${row.claude_tokens ? 'cr' : 'credits'}`;
  const largest = $derived(Math.max(0, ...rows.map((r) => r.claude_tokens)));
</script>

<section>
  <h4 class="kicker">{title}</h4>
  {#if rows.length}
    <ul>
      {#each rows as row (row.key)}
        <li>
          <span class="name">{row.label}</span>
          <span class="value">
            {#if row.claude_tokens || !row.elevenlabs_credits}{compactCount(row.claude_tokens)}{/if}
            {#if row.elevenlabs_credits}<span class="credits">{credits(row)}</span>{/if}
          </span>
          <span class="track" aria-hidden="true"
            ><span class="fill" style:--w="{share(row.claude_tokens, largest) * 100}%"></span></span
          >
        </li>
      {/each}
    </ul>
  {:else}
    <p class="none">Nothing used yet.</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--s-8);
    align-content: start;
  }
  .kicker {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  ul {
    list-style: none;
    display: grid;
    gap: var(--s-8);
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-2) var(--s-8);
    font-size: var(--t13);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .credits {
    color: var(--muted);
  }
  .track {
    grid-column: 1 / -1;
    height: var(--s-2);
    background: var(--ink-4);
  }
  .fill {
    display: block;
    width: var(--w);
    height: 100%;
    background: var(--muted);
  }
  .none {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
