<!-- The one button. primary = turning gradient (once per screen), secondary = raised, text = words only,
     cost = warn outline (anything paid), good = green outline (OK this sound), danger = red outline.
     With `href` it is a link that looks the same (target / download pass through).
     A hover lifts it, a press sinks it: transforms only, the layout never moves. A row can set `--btn-flex` for how its buttons share the line. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  type Variant = 'primary' | 'secondary' | 'text' | 'cost' | 'good' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  interface Props extends HTMLAttributes<HTMLElement> {
    variant?: Variant;
    size?: Size;
    /** Renders a link that looks like a button. */
    href?: string;
    /** Link only: where it opens, e.g. "_blank". */
    target?: string;
    /** Link only: save the file instead of opening it (true, or the file name). */
    download?: boolean | string;
    /** Fills the width of its parent. */
    wide?: boolean;
    /** Takes a share of the spare room in a row. */
    grow?: boolean;
    /** As wide as it is tall, no side padding (a single glyph like − or +). */
    square?: boolean;
    /** A row in a menu: full width, words at the start, no outline, filled on hover. */
    item?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit';
    pressed?: boolean;
    element?: HTMLElement;
    children: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    href,
    target,
    download,
    wide = false,
    grow = false,
    square = false,
    item = false,
    disabled = false,
    type = 'button',
    pressed,
    element = $bindable(),
    children,
    ...rest
  }: Props = $props();
</script>

{#if href && !disabled}
  <a
    bind:this={element}
    class="btn {variant} {size}"
    class:wide
    class:grow
    class:square
    class:item
    {href}
    {target}
    rel={target === '_blank' ? 'noopener' : undefined}
    download={download === true ? '' : download || undefined}
    {...rest}>{@render children()}</a
  >
{:else}
  <button
    bind:this={element}
    class="btn {variant} {size}"
    class:wide
    class:grow
    class:square
    class:item
    {type}
    {disabled}
    aria-pressed={pressed}
    {...rest}>{@render children()}</button
  >
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-8);
    flex: var(--btn-flex, 0 0 auto);
    position: relative;
    height: var(--btn-h);
    padding: 0 var(--btn-pad);
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: #191526;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      0 1px 2px rgba(0, 0, 0, 0.35);
    color: var(--text);
    font: 500 var(--t13) / 1 var(--body);
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition:
      background 180ms var(--ease-out-quart),
      border-color 180ms var(--ease-out-quart),
      transform 220ms var(--ease-out-expo),
      box-shadow 220ms var(--ease-out-quart),
      color 150ms ease,
      filter 180ms ease;
  }
  .btn:hover {
    background: #221d33;
    border-color: var(--line-hover);
    color: var(--text);
    transform: translateY(-1.5px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.09),
      0 4px 12px rgba(0, 0, 0, 0.45);
  }
  .btn:active {
    background: #14111e;
    transform: translateY(1px) scale(0.975);
    transition-duration: 70ms;
    transition-timing-function: var(--ease-press);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.55);
  }
  .btn[aria-pressed='true'] {
    border-color: rgba(177, 140, 255, 0.5);
    background: var(--ink-4);
  }
  .sm {
    height: var(--btn-h-sm);
    border-radius: var(--r-sm);
    font-size: var(--t12);
  }
  .lg {
    font-size: var(--t14);
  }
  .wide {
    width: 100%;
  }
  .grow {
    flex: 1 1 auto;
  }
  /* icons, not words: these keep their size */
  .square {
    height: var(--h);
    aspect-ratio: 1;
    padding: 0;
  }
  .square.sm {
    height: var(--h-sm);
  }
  .square.lg {
    height: var(--h-lg);
  }
  /* a row of a menu, not a button */
  .item {
    justify-content: flex-start;
    width: 100%;
    height: var(--h);
    padding: 0 var(--s-12);
    border: 0;
    background: none;
    box-shadow: none;
  }
  .item:hover {
    background: var(--ink-4);
    box-shadow: none;
    transform: none;
  }
  .primary {
    border: 0;
    background: linear-gradient(var(--angle), var(--grad-stops));
    color: var(--on-grad);
    font-weight: 600;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.38),
      0 2px 12px rgba(177, 140, 255, 0.25);
    animation: turn-grad 7s linear infinite;
  }
  .primary:hover {
    background: linear-gradient(var(--angle), var(--grad-stops));
    color: var(--on-grad);
    filter: brightness(1.06);
    transform: translateY(-1.5px) scale(1.01);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 6px 20px rgba(177, 140, 255, 0.45);
  }
  .primary:active {
    background: linear-gradient(var(--angle), var(--grad-stops));
    filter: brightness(0.95);
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.35),
      0 2px 6px rgba(177, 140, 255, 0.2);
  }
  .text {
    border-color: transparent;
    background: none;
    box-shadow: none;
    color: var(--muted);
  }
  .text:hover {
    border-color: transparent;
    background: rgba(255, 255, 255, 0.05);
    box-shadow: none;
    transform: translateY(-1px);
  }
  .text:active {
    background: var(--ink-3);
    box-shadow: none;
    transform: translateY(0.5px) scale(0.98);
  }
  .cost {
    border-color: rgba(255, 217, 138, 0.45);
    color: var(--warn);
  }
  .cost:hover {
    border-color: var(--warn);
    color: var(--warn);
  }
  .good {
    border-color: var(--good-line);
    color: var(--good);
  }
  .good:hover {
    border-color: var(--good);
    color: var(--good);
  }
  .danger {
    border-color: rgba(255, 122, 138, 0.35);
    background: rgba(255, 122, 138, 0.04);
    color: var(--bad);
  }
  .danger:hover {
    border-color: rgba(255, 122, 138, 0.65);
    background: rgba(255, 122, 138, 0.1);
    color: var(--bad);
    box-shadow: 0 4px 14px rgba(255, 122, 138, 0.18);
    animation: danger-shake 260ms ease-in-out 1;
  }
  .btn:disabled {
    opacity: 0.38;
    cursor: default;
    border-color: var(--line);
    background: #14111e;
    box-shadow: none;
    transform: none;
    filter: none;
    animation: none;
    pointer-events: none;
  }
  .primary:disabled {
    border: 0;
    background: var(--grad);
  }
  /* a finger still gets a full-size target: the button looks tight, the touch area around it does not */
  @media (pointer: coarse) {
    .btn::after {
      content: '';
      position: absolute;
      inset: calc((var(--btn-h) - var(--hit)) / 2) 0;
    }
  }
</style>
