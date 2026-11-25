// Alignment geometry for Studio's canvas: snapping a moving box to other boxes and to layout-grid
// columns (smart guides), the columns themselves, and the distances shown between two boxes.
// Pure functions on plain rectangles (artboard pixels), so they are tested in node.
// The edge/centre pairing follows the approach of OpenPencil's snap.ts (MIT); written for StyleLift.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Guide {
  axis: "x" | "y"; // x = a vertical line at `at`; y = a horizontal line
  at: number;
  from: number;
  to: number;
}
export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

const right = (b: Box) => b.left + b.width;
const bottom = (b: Box) => b.top + b.height;
const cx = (b: Box) => b.left + b.width / 2;
const cy = (b: Box) => b.top + b.height / 2;

/**
 * Snap `moving` to the nearest edge or centre of `targets` (and to free-standing lines such as grid
 * columns) within `threshold` px, separately on each axis. Returns the correction and the guide lines
 * to draw — every target that lines up after the correction, not just the first.
 */
export function snapBox(moving: Box, targets: Box[], lines: { x?: number[]; y?: number[] } = {}, threshold = 6): Snap {
  const mx = [moving.left, cx(moving), right(moving)];
  const my = [moving.top, cy(moving), bottom(moving)];
  let bestX = Infinity, bestY = Infinity;
  const consider = (ms: number[], ts: number[], axis: "x" | "y") => {
    for (const m of ms) {
      for (const t of ts) {
        const d = t - m;
        if (Math.abs(d) > threshold) continue;
        if (axis === "x" && Math.abs(d) < Math.abs(bestX)) bestX = d;
        if (axis === "y" && Math.abs(d) < Math.abs(bestY)) bestY = d;
      }
    }
  };
  for (const t of targets) {
    consider(mx, [t.left, cx(t), right(t)], "x");
    consider(my, [t.top, cy(t), bottom(t)], "y");
  }
  consider(mx, lines.x || [], "x");
  consider(my, lines.y || [], "y");
  const dx = Number.isFinite(bestX) ? bestX : 0;
  const dy = Number.isFinite(bestY) ? bestY : 0;
  // the guides: everything the snapped box lines up with
  const s: Box = { left: moving.left + dx, top: moving.top + dy, width: moving.width, height: moving.height };
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  if (Number.isFinite(bestX)) {
    for (const m of [s.left, cx(s), right(s)]) {
      for (const t of targets) {
        if ([t.left, cx(t), right(t)].some((v) => near(v, m))) guides.push({ axis: "x", at: m, from: Math.min(s.top, t.top), to: Math.max(bottom(s), bottom(t)) });
      }
      if ((lines.x || []).some((v) => near(v, m))) guides.push({ axis: "x", at: m, from: -1e6, to: 1e6 });
    }
  }
  if (Number.isFinite(bestY)) {
    for (const m of [s.top, cy(s), bottom(s)]) {
      for (const t of targets) {
        if ([t.top, cy(t), bottom(t)].some((v) => near(v, m))) guides.push({ axis: "y", at: m, from: Math.min(s.left, t.left), to: Math.max(right(s), right(t)) });
      }
      if ((lines.y || []).some((v) => near(v, m))) guides.push({ axis: "y", at: m, from: -1e6, to: 1e6 });
    }
  }
  return { dx, dy, guides };
}

export interface GridSpec {
  columns: number;
  gutter: number;
  margin: number;
}
/** Column spans of a stretch layout grid across `width` (like a 12-column grid with side margins). */
export function gridColumns(width: number, g: GridSpec): { start: number; end: number }[] {
  const n = Math.max(1, Math.min(48, Math.round(g.columns)));
  const gutter = Math.max(0, g.gutter), margin = Math.max(0, g.margin);
  const col = (width - margin * 2 - gutter * (n - 1)) / n;
  if (col <= 0) return [];
  return Array.from({ length: n }, (_, i) => {
    const start = margin + i * (col + gutter);
    return { start, end: start + col };
  });
}
/** The x positions a box snaps to on a layout grid: every column's edges. */
export const gridLines = (width: number, g: GridSpec) => gridColumns(width, g).flatMap((c) => [c.start, c.end]);

export const DEFAULT_GRIDS: Record<"base" | "tablet" | "phone", GridSpec> = {
  base: { columns: 12, gutter: 24, margin: 80 },
  tablet: { columns: 8, gutter: 20, margin: 40 },
  phone: { columns: 4, gutter: 16, margin: 20 },
};

export interface Measure {
  axis: "x" | "y"; // x = a horizontal distance line, y = a vertical one
  from: number;
  to: number;
  at: number; // where the line runs across the other axis
  value: number;
}
/**
 * The distances shown between a selected box `a` and a hovered box `b` (hold ⌥, like Figma): the gap
 * between them on each axis where they don't overlap; inside an enclosing box, the distance from each
 * side of `a` to the same side of `b`.
 */
export function measureBetween(a: Box, b: Box): Measure[] {
  const out: Measure[] = [];
  const inside = a.left >= b.left && a.top >= b.top && right(a) <= right(b) && bottom(a) <= bottom(b);
  if (inside) {
    const midY = cy(a), midX = cx(a);
    if (a.left - b.left > 0.5) out.push({ axis: "x", from: b.left, to: a.left, at: midY, value: a.left - b.left });
    if (right(b) - right(a) > 0.5) out.push({ axis: "x", from: right(a), to: right(b), at: midY, value: right(b) - right(a) });
    if (a.top - b.top > 0.5) out.push({ axis: "y", from: b.top, to: a.top, at: midX, value: a.top - b.top });
    if (bottom(b) - bottom(a) > 0.5) out.push({ axis: "y", from: bottom(a), to: bottom(b), at: midX, value: bottom(b) - bottom(a) });
    return out;
  }
  // side by side: the horizontal gap, drawn through the middle of where they overlap vertically (or of a)
  const overlapTop = Math.max(a.top, b.top), overlapBottom = Math.min(bottom(a), bottom(b));
  const atY = overlapBottom > overlapTop ? (overlapTop + overlapBottom) / 2 : cy(a);
  if (right(a) <= b.left) out.push({ axis: "x", from: right(a), to: b.left, at: atY, value: b.left - right(a) });
  else if (right(b) <= a.left) out.push({ axis: "x", from: right(b), to: a.left, at: atY, value: a.left - right(b) });
  const overlapLeft = Math.max(a.left, b.left), overlapRight = Math.min(right(a), right(b));
  const atX = overlapRight > overlapLeft ? (overlapLeft + overlapRight) / 2 : cx(a);
  if (bottom(a) <= b.top) out.push({ axis: "y", from: bottom(a), to: b.top, at: atX, value: b.top - bottom(a) });
  else if (bottom(b) <= a.top) out.push({ axis: "y", from: bottom(b), to: a.top, at: atX, value: a.top - bottom(b) });
  return out;
}

/** "12px 4px" / "12px" / "none" → the x and y of a CSS translate. */
export function parseTranslate(v: string | null | undefined): { x: number; y: number } {
  if (!v || v === "none") return { x: 0, y: 0 };
  const parts = v.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
  return { x: parts[0] || 0, y: parts[1] || 0 };
}
export const formatTranslate = (x: number, y: number) => (Math.round(x) === 0 && Math.round(y) === 0 ? "" : `${Math.round(x)}px ${Math.round(y)}px`);
