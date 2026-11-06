<!-- The big play button over a paused picture. -->
<script lang="ts">
  interface Props {
    /** What the video is, e.g. "The final video". */
    label: string;
    onplay: () => void;
  }

  let { label, onplay }: Props = $props();
</script>

<button type="button" aria-label="Play {label}" onclick={onplay}>▶</button>

<style>
  button {
    display: grid;
    place-items: center;
    width: var(--play-size);
    height: var(--play-size);
    padding-left: var(--s-4);
    border: 2px solid var(--text);
    border-radius: 50%;
    background: var(--scrim);
    color: var(--text);
    font-size: var(--t20);
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease);
  }
  button:hover {
    background: var(--scrim-strong);
  }
</style>
