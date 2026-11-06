<!-- The picture with a transparent canvas over it: draw with the chosen tool, erase the mark nearest the pointer.
     The picture is the image at `path`, or whatever the caller puts inside (a video, filling this box) together
     with its `size`. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fileUrl } from '../files';
  import {
    fitBox,
    nearestMark,
    paintMarks,
    toPicturePoint,
    type Box,
    type Mark,
    type MarkTool,
  } from '../review/marks';
  import { markColour } from '../review/mark-colour';

  interface Props {
    path?: string;
    /** Pixel size of the picture put inside; the image at `path` reports its own. */
    size?: { width: number; height: number };
    tool: MarkTool;
    marks: Mark[];
    /** The colour of new marks; without one they take the app's mark colour. */
    colour?: string;
    /** A mark was added. */
    ondraw?: () => void;
    children?: Snippet;
  }

  let { path, size, tool, marks = $bindable(), colour, ondraw, children }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();
  let picture = $state<HTMLImageElement>();
  let drawing = $state<Mark | null>(null);
  let penSeen = false;

  function box(): Box {
    const element = canvas;
    const shown = picture;
    if (!element || (!shown && !size)) return { x: 0, y: 0, w: 1, h: 1 };
    return fitBox(
      element.clientWidth,
      element.clientHeight,
      size?.width ?? (shown?.naturalWidth || 16),
      size?.height ?? (shown?.naturalHeight || 9),
    );
  }

  function repaint() {
    const element = canvas;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = devicePixelRatio || 1;
    // Width and height each checked: a height-only change must resize the bitmap too, or the marks stretch.
    const width = Math.round(element.clientWidth * ratio);
    const height = Math.round(element.clientHeight * ratio);
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, element.clientWidth, element.clientHeight);
    paintMarks(context, box(), drawing ? [...marks, drawing] : marks, markColour());
  }

  $effect(() => {
    const element = canvas;
    if (!element) return;
    const watch = new ResizeObserver(repaint);
    watch.observe(element);
    return () => watch.disconnect();
  });

  $effect(() => {
    void marks;
    void drawing;
    void size;
    repaint();
  });

  function pointOf(event: PointerEvent) {
    const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    return toPicturePoint(box(), event.clientX - rect.left, event.clientY - rect.top);
  }

  function down(event: PointerEvent) {
    // A pen was used: fingers resting on the screen must not draw.
    if (event.pointerType === 'touch' && penSeen) return;
    if (event.pointerType === 'pen') penSeen = true;
    (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
    const at = pointOf(event);
    if (tool === 'eraser') {
      const hit = nearestMark(marks, at);
      if (hit >= 0) marks = marks.filter((_, index) => index !== hit);
      return;
    }
    if (tool === 'marker') {
      marks = [...marks, { tool, points: [at], ...(colour ? { colour } : {}) }];
      ondraw?.();
      return;
    }
    drawing = { tool, points: [at], ...(colour ? { colour } : {}) };
  }

  function move(event: PointerEvent) {
    if (!drawing) return;
    const at = pointOf(event);
    drawing =
      drawing.tool === 'pen' || drawing.tool === 'highlighter'
        ? { ...drawing, points: [...drawing.points, at] }
        : { ...drawing, points: [drawing.points[0] ?? at, at] };
  }

  function up() {
    if (drawing && drawing.points.length > 1) {
      marks = [...marks, drawing];
      ondraw?.();
    }
    drawing = null;
  }
</script>

<div class="frame">
  {#if children}
    {@render children()}
  {:else if path}
    <img bind:this={picture} src={fileUrl(path)} alt="Your frame, ready to mark" onload={repaint} />
  {/if}
  <canvas
    bind:this={canvas}
    aria-label="Draw on the picture"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
  ></canvas>
</div>

<style>
  .frame {
    position: relative;
    height: 100%;
    aspect-ratio: 16 / 9;
    max-width: 100%;
    background: var(--media);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    overflow: hidden;
  }
  img,
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  img {
    object-fit: contain;
  }
  canvas {
    touch-action: none;
    cursor: crosshair;
  }
</style>
