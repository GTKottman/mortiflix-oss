<!-- A transport button that stays on or off (Loop, ± 1 s, Snap). Pressed is filled, so it reads at a glance. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    pressed: boolean;
    title: string;
    onclick: () => void;
    children: Snippet;
  }

  let { pressed, title, onclick, children }: Props = $props();
</script>

<button type="button" aria-pressed={pressed} {title} {onclick}>{@render children()}</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: transparent;
    color: var(--text);
    font: 600 var(--t13) / 1 var(--body);
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  button:hover {
    border-color: var(--line-hover);
  }
  button[aria-pressed='true'] {
    border-color: var(--text);
    background: var(--ink-4);
    border-color: rgba(177, 140, 255, 0.5);
    color: var(--text);
  }
  /* a finger still gets a full-size target: the button looks tight, the touch area around it does not */
  @media (pointer: coarse) {
    button {
      position: relative;
    }
    button::after {
      content: '';
      position: absolute;
      inset: calc((var(--btn-h) - var(--hit)) / 2) 0;
    }
  }
</style>
