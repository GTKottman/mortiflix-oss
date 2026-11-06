<!-- What the film is made of in one line; the track-by-track receipt (V1, A1 …) sits behind a disclosure. -->
<script lang="ts">
  import { routeHref } from '../../lib/router.svelte';
  import { plural } from '../../lib/words';
  import { productionSummary } from './finish';
  import type { Counts } from './types';

  interface Props {
    counts: Counts;
    /** Sounds the final mix left out (OK'd on Sound, dropped by Finish), each with its reason. */
    leftOut?: readonly { id: string; at_sec: number; what: string; why: string }[];
  }

  let { counts, leftOut = [] }: Props = $props();
</script>

<section aria-labelledby="prod-h">
  <h2 id="prod-h">Production summary</h2>
  <p class="summary">{productionSummary(counts)}</p>
  {#if leftOut.length}
    <div class="left-out" role="status">
      <p>{plural(leftOut.length, 'sound')} left out of the final mix:</p>
      <ul>
        {#each leftOut as sound (sound.id)}
          <li>{sound.what} ({sound.at_sec.toFixed(1)} s): {sound.why}</li>
        {/each}
      </ul>
      <a href={routeHref('/sound')}>See them on Sound ›</a>
    </div>
  {/if}
  <details>
    <summary>View production details</summary>
    <dl>
      <div>
        <dt>Shots</dt>
        <dd>{plural(counts.shots, 'shot')}<small>V1</small></dd>
      </div>
      <div>
        <dt>Voice</dt>
        <dd>{plural(counts.lines, 'voice line')}<small>A1</small></dd>
      </div>
      <div>
        <dt>Music</dt>
        <dd>
          {#if counts.music}{plural(counts.music, 'piece')}<small>A2</small>
          {:else}None yet<a href={routeHref('/voice')}>Make it in Voice &amp; music ›</a>{/if}
        </dd>
      </div>
      <div>
        <dt>Sound effects</dt>
        <dd>
          {#if counts.sfx}{plural(counts.sfx, 'sound')}<small>A3</small>
          {:else}None yet<a href={routeHref('/sound')}>Make them on Sound ›</a>{/if}
        </dd>
      </div>
      <div>
        <dt>Captions</dt>
        <dd>{counts.captions ? plural(counts.captions, 'caption') : 'None'}<small>C1</small></dd>
      </div>
      <div>
        <dt>Scene markers</dt>
        <dd>{counts.markers ? plural(counts.markers, 'marker') : 'None'}</dd>
      </div>
    </dl>
  </details>
</section>

<style>
  section {
    display: grid;
    gap: var(--s-12);
    min-width: 0;
  }
  h2 {
    color: var(--faint);
    font: 600 var(--t12) / 1.2 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .left-out {
    display: grid;
    gap: var(--s-4);
    color: var(--muted);
    font-size: var(--t13);
  }
  .left-out ul {
    margin: 0;
    padding-left: var(--s-16);
  }
  .summary {
    font-size: var(--t14);
    line-height: 1.5;
  }
  summary {
    color: var(--link);
    font-size: var(--t13);
    list-style: none;
    white-space: nowrap;
    cursor: pointer;
  }
  summary::before {
    content: '› ';
  }
  details[open] summary::before {
    content: '⌄ ';
  }
  dl {
    margin-top: var(--s-8);
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: var(--s-16);
    padding: var(--s-8) 0;
    border-top: 1px solid var(--line);
    font-size: var(--t13);
  }
  dt {
    flex-shrink: 0;
    font-weight: 600;
    white-space: nowrap;
  }
  dd {
    color: var(--muted);
    text-align: right;
  }
  small {
    margin-left: var(--s-4);
    color: var(--faint);
    font-size: inherit;
  }
  dd a {
    margin-left: var(--s-8);
    white-space: nowrap;
  }
</style>
