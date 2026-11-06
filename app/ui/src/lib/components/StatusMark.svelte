<!-- A state in a glyph and a word, never colour alone: ✓ OK, ! Needs a fix, ○ Not made yet, ◌ Making, ✕ Cut,
     ✕ Bad (can't reach it, failed). `made` is a check with no colour: done, not signed off yet. `glyph` replaces
     the state's own glyph when the screen's words need another (e.g. → Checking). -->
<script lang="ts" module>
  export type Mark = 'ok' | 'fix' | 'busy' | 'wait' | 'cut' | 'bad' | 'made';
</script>

<script lang="ts">
  interface Props {
    mark: Mark;
    text: string;
    /** Replaces the state's own glyph. */
    glyph?: string;
    /** sm: inside a row. md: a line of its own (15px regular). lg: the one state a panel is about. */
    size?: 'sm' | 'md' | 'lg';
    /** Drops the state colour (glyph and word stay), for a value shown in plain text. */
    plain?: boolean;
  }

  const GLYPH: Record<Mark, string> = {
    ok: '✓',
    fix: '!',
    busy: '◌',
    wait: '○',
    cut: '✕',
    bad: '✕',
    made: '✓',
  };

  let { mark, text, glyph, size = 'sm', plain = false }: Props = $props();
</script>

<span class="mark {mark} {size}" class:plain
  ><span aria-hidden="true">{glyph ?? GLYPH[mark]}</span> {text}</span
>

<style>
  .mark {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: var(--s-4);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .md {
    font-size: var(--t15);
  }
  .lg {
    font-size: var(--t16);
    font-weight: 600;
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
  .cut,
  .bad {
    color: var(--bad);
  }
  .plain {
    color: var(--text);
  }
</style>
