<!-- The player's "won't play" state: the file is there but would not open. Try again, or download it. -->
<script lang="ts">
  import PlayerCover from './PlayerCover.svelte';

  interface Props {
    download?: { href: string; name: string };
    onretry: () => void;
  }

  let { download, onretry }: Props = $props();
</script>

<PlayerCover
  role="alert"
  title="The video won't play"
  detail="The file is there, but the player could not open it. You can try again or download it."
>
  <div class="row">
    <button type="button" class="pill" onclick={onretry}>Try again</button>
    {#if download}
      <a class="pill solid" href={download.href} download={download.name}>Download video</a>
    {/if}
  </div>
</PlayerCover>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-12);
    margin-top: var(--s-8);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: transparent;
    color: var(--text);
    font: 600 var(--t14) / 1 var(--body);
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
  }
  .pill:hover {
    border-color: var(--line-hover);
  }
  .solid {
    border-color: var(--text);
  }
</style>
