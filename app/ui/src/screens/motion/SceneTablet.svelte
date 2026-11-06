<!-- The tablet (Video Notes) for this scene in one pill: which device is reviewing and where its notes are
     entered. When it can, the pill opens a small menu: send the scene again, stop sending. Hidden when Video Notes
     is off. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmInline from '../../lib/components/ConfirmInline.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();

  const line = $derived(motion.tabletLine);
  let open = $state(false);
  let resending = $state(false);

  async function resend() {
    resending = true;
    await motion.sendSceneToTablet();
    resending = false;
  }
  let root = $state<HTMLElement>();
  let pill = $state<HTMLElement>();
  let menu = $state<HTMLElement>();

  async function toggle() {
    open = !open;
    if (!open) return;
    await tick();
    menu?.querySelector('button')?.focus();
  }

  function closeOn(event: Event) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false;
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    open = false;
    pill?.focus();
  }
</script>

<svelte:window onclick={closeOn} onkeydown={onKey} />

{#if line}
  <div class="tablet" bind:this={root}>
    {#snippet inside()}
      <span class="icon" aria-hidden="true"></span>
      <b>Tablet</b>
      <span class="says {line.look}" title={line.text}>{line.glyph} {line.text}</span>
      {#if line.link}<a class="link" href={routeHref('/settings')}>Link in Settings</a>{/if}
      {#if line.menu}<span class="caret" aria-hidden="true">▾</span>{/if}
    {/snippet}
    {#if line.menu}
      <button
        bind:this={pill}
        class="pill"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Tablet: ${line.text}`}
        onclick={toggle}>{@render inside()}</button
      >
    {:else}
      <div class="pill" role="status" aria-label={`Tablet: ${line.text}`}>{@render inside()}</div>
    {/if}
    {#if line.resend}
      <Button size="sm" disabled={resending} onclick={resend}>{resending ? 'Sending…' : 'Resend'}</Button>
    {/if}
    {#if open}
      <div class="menu" role="menu" bind:this={menu}>
        <Button
          size="sm"
          variant="text"
          item
          role="menuitem"
          onclick={() => {
            open = false;
            void motion.sendSceneToTablet();
          }}>Send scene {motion.index + 1} again</Button
        >
        <ConfirmInline
          label="Stop sending to the tablet"
          question="Stop for every project?"
          yes="Stop sending"
          no="Keep sending"
          onyes={async () => {
            await motion.stopTablet();
            open = false;
          }}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .tablet {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s-8);
    flex: none;
    max-width: 100%;
    min-width: var(--motion-pill-min-w);
  }
  .pill {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--s-8);
    min-width: 0;
    min-height: var(--btn-h);
    padding: var(--s-4) var(--btn-pad);
    border: 1px solid var(--line-2);
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--text);
    font: 400 var(--t12) / 1.3 var(--body);
    text-align: left;
  }
  button.pill {
    cursor: pointer;
  }
  button.pill:hover {
    border-color: var(--line-hover);
  }
  .icon {
    flex: none;
    width: 10px;
    height: 14px;
    border: 1.5px solid currentColor;
    border-radius: 3px;
  }
  b {
    flex: none;
    font-weight: 600;
    white-space: nowrap;
  }
  .says {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    flex: none;
    color: var(--link);
    white-space: nowrap;
  }
  .caret {
    flex: none;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t11);
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
  .wait {
    color: var(--muted);
  }
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + var(--s-4));
    z-index: var(--z-menu);
    display: grid;
    min-width: var(--motion-menu-min-w);
    gap: var(--s-2);
    padding: var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-3);
  }
  @media (max-width: 559px) {
    .tablet {
      width: 100%;
      min-width: 0;
    }
  }
</style>
