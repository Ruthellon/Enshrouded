/** Pure view maths for the graph canvas (no Angular, no DOM). */

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
  /** When true, world +y points up on screen instead of down. */
  flipY: boolean;
}
export interface Pt {
  x: number;
  y: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;

export function toScreen(v: Viewport, x: number, y: number): Pt {
  return { x: x * v.scale + v.tx, y: (v.flipY ? -y : y) * v.scale + v.ty };
}

export function toWorld(v: Viewport, sx: number, sy: number): Pt {
  const y = (sy - v.ty) / v.scale;
  return { x: (sx - v.tx) / v.scale, y: v.flipY ? -y : y };
}

export function fitViewport(points: Pt[], width: number, height: number, flipY: boolean, padding = 60): Viewport {
  if (points.length === 0 || width <= 0 || height <= 0) return { scale: 1, tx: width / 2, ty: height / 2, flipY };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const y = flipY ? -p.y : p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min((width - 2 * padding) / w, (height - 2 * padding) / h)),
  );
  return { scale, flipY, tx: (width - (minX + maxX) * scale) / 2, ty: (height - (minY + maxY) * scale) / 2 };
}

/** Zoom by `factor`, keeping the world point under screen position (sx, sy) fixed. */
export function zoomAt(v: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return { ...v, scale, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
}

/** Switch the y direction while keeping the picture centred on the same screen point. */
export function setFlipY(v: Viewport, flipY: boolean, centerY: number): Viewport {
  if (v.flipY === flipY) return v;
  return { ...v, flipY, ty: 2 * centerY - v.ty };
}

export function nodeAt(points: { id: string; x: number; y: number }[], sx: number, sy: number, radius: number): string | null {
  let best: string | null = null;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

/** A rectangle-shaped node for hit testing: centre and half sizes in screen pixels. */
export interface HitBox {
  id: string;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

/** The box containing (sx, sy) (grown by `margin` pixels); the one whose centre is nearest wins. */
export function boxAt(boxes: HitBox[], sx: number, sy: number, margin = 0): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of boxes) {
    const dx = Math.abs(sx - b.x);
    const dy = Math.abs(sy - b.y);
    if (dx <= b.halfW + margin && dy <= b.halfH + margin) {
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
  }
  return best;
}

export interface LinkShape {
  d: string;
  mx: number;
  my: number;
}

/**
 * A link from an output slot at (ax, ay) to an input slot at (bx, by): a smooth curve that leaves
 * the output to the right and enters the input from the left, like a node editor.
 */
export function linkPath(ax: number, ay: number, bx: number, by: number): LinkShape {
  const dx = Math.max(50, Math.min(220, Math.abs(bx - ax) * 0.5));
  const c1x = ax + dx;
  const c2x = bx - dx;
  const r = (n: number): string => (Math.round(n * 10) / 10).toString();
  return {
    d: `M${r(ax)} ${r(ay)}C${r(c1x)} ${r(ay)} ${r(c2x)} ${r(by)} ${r(bx)} ${r(by)}`,
    mx: (ax + 3 * c1x + 3 * c2x + bx) / 8,
    my: (ay + 3 * ay + 3 * by + by) / 8,
  };
}
