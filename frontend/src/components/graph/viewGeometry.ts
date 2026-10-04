/** A screen rectangle, in pixels relative to the canvas. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Smallest free area (px each way) worth centring in; below it the whole canvas is used. */
export const MIN_FREE_SIZE = 160;

function areaOf(rect: Rect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

/**
 * The largest part of the canvas that the overlays (the selected-paper
 * card, a sheet) leave uncovered: for each overlay, the biggest of the
 * strips to its left, right, top and bottom. Falls back to the whole
 * canvas when what is left is too small to centre a paper in.
 */
export function freeArea(canvas: Rect, overlays: readonly Rect[]): Rect {
  let free = canvas;
  for (const overlay of overlays) {
    const clip = {
      left: Math.max(free.left, overlay.left),
      top: Math.max(free.top, overlay.top),
      right: Math.min(free.right, overlay.right),
      bottom: Math.min(free.bottom, overlay.bottom),
    };
    if (clip.right <= clip.left || clip.bottom <= clip.top) continue;
    const strips: Rect[] = [
      { ...free, right: clip.left },
      { ...free, left: clip.right },
      { ...free, bottom: clip.top },
      { ...free, top: clip.bottom },
    ];
    free = strips.reduce((best, strip) => (areaOf(strip) > areaOf(best) ? strip : best));
  }
  const tooSmall = free.right - free.left < MIN_FREE_SIZE || free.bottom - free.top < MIN_FREE_SIZE;
  return tooSmall ? canvas : free;
}

/**
 * The graph point to centre the canvas on, at zoom `k`, so the point
 * (x, y) lands in the middle of `free` instead of the canvas's middle.
 */
export function centreFor(
  point: { x: number; y: number },
  k: number,
  canvas: { width: number; height: number },
  free: Rect,
): { x: number; y: number } {
  const dx = (free.left + free.right) / 2 - canvas.width / 2;
  const dy = (free.top + free.bottom) / 2 - canvas.height / 2;
  return { x: point.x - dx / k, y: point.y - dy / k };
}
