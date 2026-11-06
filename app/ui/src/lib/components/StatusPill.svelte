<!-- A state in words plus a glyph (colour is never the only signal): Approved, Needs review, Edited, Making. -->
<script lang="ts" module>
  export type Tone = 'ok' | 'busy' | 'fix' | 'wait';
</script>

<script lang="ts">
  interface Props {
    tone: Tone;
    /** Shown with the word, so colour is never the only signal. */
    glyph: string;
    text: string;
    title?: string;
    /** Draw it as a tinted pill (inside a row). */
    pill?: boolean;
    /** 12px medium, for pills beside small controls (Voice & music). */
    small?: boolean;
  }

  let { tone, glyph, text, title, pill = false, small = false }: Props = $props();
</script>

<span class="st {tone}" class:pill class:small {title}><span aria-hidden="true">{glyph}</span>{text}</span>

<style>
  .st {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: var(--s-4);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .pill {
    height: 24px;
    padding: 0 var(--s-8);
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: var(--r-sm);
    font-size: 11.5px;
    font-weight: 500;
  }
  .small {
    font-size: var(--t12);
    font-weight: 500;
  }
  .ok {
    color: var(--good);
  }
  .busy {
    color: var(--busy);
  }
  .fix {
    color: var(--warn);
  }
  .wait {
    color: var(--faint);
  }
</style>
