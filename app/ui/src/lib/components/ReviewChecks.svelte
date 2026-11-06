<!-- What the studio checked before the owner saw it: measured first (exact), then the AI's read in plain words. -->
<script lang="ts">
  import { plural } from '../words';
  import type { ReviewItem } from '../review/types';
  import ReviewSection from './ReviewSection.svelte';

  interface Props {
    item: ReviewItem;
  }

  interface Row {
    pass: 'pass' | 'fail' | 'skip';
    name: string;
    note?: string;
  }

  const SECTIONS: Record<string, string> = {
    visual_design: 'Visual design',
    typography: 'Type',
    technical_quality: 'Technical quality',
    narrative_quality: 'Matches the story',
    transition_compatibility: 'Fits the one before it',
  };
  const GLYPH = { pass: '✓', fail: '!', skip: '○' } as const;

  let { item }: Props = $props();

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    if (item.problems.length) {
      for (const problem of item.problems)
        out.push({ pass: 'fail', name: 'Measured by the studio', note: problem });
    } else {
      out.push({
        pass: 'pass',
        name: 'Measured by the studio',
        note: 'Inside the edges, nothing overlapping, every picture and font found, readable on what is behind it.',
      });
    }
    if (item.keyVisible === false)
      out.push({ pass: 'fail', name: 'Key word', note: `"${item.keyWord}" is not on the still.` });
    else if (item.keyVisible === true)
      out.push({ pass: 'pass', name: 'Key word', note: `"${item.keyWord}" is on the still.` });
    const sections = Object.entries(item.inspection?.sections ?? {});
    if (!sections.length) out.push({ pass: 'skip', name: 'AI check', note: 'Not run on this version.' });
    for (const [key, check] of sections) {
      out.push({
        pass: check.pass ? 'pass' : 'fail',
        name: SECTIONS[key] ?? key.replace(/_/g, ' '),
        note: check.note || (check.pass ? '' : check.correction),
      });
    }
    return out;
  });
</script>

<ReviewSection title="Checked before you saw it">
  {#snippet aside()}{#if item.inspection?.rounds}AI check: {plural(
        item.inspection.rounds,
        'round',
      )}{/if}{/snippet}
  {#if !item.path}
    <p class="empty">Nothing to check until it is drawn.</p>
  {:else}
    {#each rows as row, i (i)}
      <div class="ck {row.pass}">
        <span class="g" aria-hidden="true">{GLYPH[row.pass]}</span>
        <div>
          <b>{row.name}</b>
          {#if row.note}<span class="n">{row.note}</span>{/if}
        </div>
      </div>
    {/each}
    {#if item.inspection?.sent_anyway}
      <p class="empty">You chose to see it although the check was not satisfied.</p>
    {/if}
  {/if}
</ReviewSection>

<style>
  .ck {
    display: grid;
    grid-template-columns: var(--s-16) 1fr;
    gap: var(--s-8);
    align-items: start;
    padding: var(--s-4) 0;
    font-size: var(--t13);
  }
  .g {
    font-weight: 700;
  }
  .pass .g {
    color: var(--good);
  }
  .fail .g {
    color: var(--warn);
  }
  .skip .g {
    color: var(--faint);
  }
  b {
    font-weight: 600;
  }
  .n {
    display: block;
    color: var(--muted);
  }
  .fail .n {
    color: var(--text);
  }
  .empty {
    color: var(--muted);
    font-size: var(--t14);
    padding: var(--s-4) 0;
  }
</style>
