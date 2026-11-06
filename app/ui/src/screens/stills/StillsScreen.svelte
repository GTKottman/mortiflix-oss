<!-- Stills (stage 4): one scene at a time, one still in review, big. Enter = OK, F = Fix, same decision row as Look.
     Nothing is made ahead: the next scene is drawn only when every still of this one is OK. This part finds the
     service (the real one, or the screenshot fixture when the address has ?fixture=review) and hands it on. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import { reviewService } from '../../lib/review/fixture';
  import { useRouter, useService } from '../../lib/stores/context';
  import StillsReview from './StillsReview.svelte';

  const router = useRouter();
  const fixture = import.meta.env.DEV ? router.query.get('fixture') : null; // fixtures: dev builds only
  const ready = reviewService('stills', fixture, useService());
</script>

{#await ready}
  <LoadingState text="Loading the stills…" />
{:then service}
  <StillsReview {service} {fixture} />
{:catch error}
  <ErrorState
    title="Couldn't open the screenshot fixture"
    detail={error instanceof Error ? error.message : ''}
  />
{/await}
