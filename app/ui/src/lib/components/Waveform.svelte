<!-- The shape of an audio clip: real peaks when there are some, else a steady stand-in shape for this seed.
     Draws in the colour of its parent (currentColor) and stretches to fill it. -->
<script lang="ts">
  import { placeholderPeaks, wavePath, type Peaks } from '../audio/waveform';

  interface Props {
    /** From `audio.peaks`. Leave out (or empty) to draw the stand-in. */
    peaks?: Peaks | null;
    /** Names the stand-in: the same seed always draws the same shape. */
    seed: string;
    /** How many strokes the stand-in has. */
    count: number;
    /** Music swells; speech comes in bursts. Only changes the stand-in. */
    music?: boolean;
  }

  let { peaks = null, seed, count, music = false }: Props = $props();
  const path = $derived(wavePath(peaks?.length ? peaks : placeholderPeaks(seed, count, music)));
</script>

<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    vector-effect: non-scaling-stroke;
  }
</style>
