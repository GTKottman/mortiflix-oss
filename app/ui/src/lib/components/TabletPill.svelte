<!-- The tablet (Video Notes) in one pill: the same piece on the owner's tablet, OK there = OK here.
     Shown only when Video Notes is on. "Not linked" leads to Settings. -->
<script lang="ts">
  import { routeHref } from '../router.svelte';
  import type { Tag } from '../review/logic';

  interface Props {
    tag: Tag & { link?: true };
  }

  let { tag }: Props = $props();
  const title = 'Video Notes: the same piece on your tablet. OK there does the same as OK here.';
</script>

{#if tag.link}
  <a class="pill {tag.look}" href={routeHref('/settings')} {title}>
    <span aria-hidden="true">{tag.glyph}</span><span>Tablet · {tag.text}</span>
  </a>
{:else}
  <span class="pill {tag.look}" role="status" {title}>
    <span aria-hidden="true">{tag.glyph}</span><span>Tablet · {tag.text}</span>
  </span>
{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-8);
    flex-shrink: 0;
    min-width: var(--tablet-pill-min-w);
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    color: var(--muted);
    font: 600 var(--t13) / 1 var(--body);
    white-space: nowrap;
    text-decoration: none;
  }
  a.pill:hover {
    border-color: var(--line-hover);
    color: var(--text);
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
  .bad {
    color: var(--bad);
  }
</style>
