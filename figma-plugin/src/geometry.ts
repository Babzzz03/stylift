// The arithmetic between CSS and Figma: gradient directions, rotation about the centre, font style names, blend
// modes. Pure functions — tested on their own (scripts/verify-figma-plugin.mjs).
import type { RGBA } from "../../src/extractor/figma-snapshot";

export type Transform2 = [[number, number, number], [number, number, number]];
export const rgb = (c: RGBA) => ({ r: c.r, g: c.g, b: c.b });

/** A CSS linear-gradient angle (0deg = to top, clockwise) as Figma's gradientTransform for a w × h layer: the map from
 *  the layer's own 0–1 square to the gradient's, whose x runs along the gradient (0 → 1), as CSS lays it out — the
 *  gradient line through the centre, long enough that the corners get the end colours. */
export function linearTransform(angleDeg: number, w: number, h: number): Transform2 {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
  const r0: [number, number, number] = [(w * dx) / L, (h * dy) / L, 0];
  r0[2] = 0.5 - (r0[0] + r0[1]) / 2;
  const r1: [number, number, number] = [(-w * dy) / L, (h * dx) / L, 0];
  r1[2] = 0.5 - (r1[0] + r1[1]) / 2;
  return [r0, r1];
}

/** CSS's default radial gradient (an ellipse reaching the farthest corners, centred): Figma's radial is a circle of
 *  radius 0.5 about the middle of its square — stretched so the corners sit on its edge. */
export function radialTransform(at?: { cx: number; cy: number; rx: number; ry: number }): Transform2 {
  if (at && at.rx > 0 && at.ry > 0) {
    // an ellipse of radii rx × ry (fractions of the box) about (cx, cy): its edge lands at radius 0.5
    const sx = 0.5 / at.rx, sy = 0.5 / at.ry;
    return [[sx, 0, 0.5 - at.cx * sx], [0, sy, 0.5 - at.cy * sy]];
  }
  const s = 1 / Math.SQRT2; // the corner (0.5, 0.5) away from the centre lands at radius 0.5
  return [[s, 0, 0.5 - s / 2], [0, s, 0.5 - s / 2]];
}

/** A conic gradient (CSS: starting `angle` degrees clockwise from straight up, about (cx, cy)) as Figma's angular one,
 *  which starts along its own x axis: turned so that axis points where CSS starts. */
export function conicTransform(angleDeg: number, at?: { cx: number; cy: number }): Transform2 {
  const phi = ((angleDeg - 90) * Math.PI) / 180;
  const c = Math.cos(-phi), s = Math.sin(-phi);
  const cx = at?.cx ?? 0.5, cy = at?.cy ?? 0.5;
  return [[c, -s, 0.5 - (c * cx - s * cy)], [s, c, 0.5 - (s * cx + c * cy)]];
}

/** A layer w × h whose unrotated box sits at (x, y), turned by deg (CSS: clockwise) about its centre — Figma turns
 *  a layer about its top-left corner, so the corner moves. */
export function rotatedTransform(x: number, y: number, w: number, h: number, deg: number): Transform2 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const cx = x + w / 2, cy = y + h / 2;
  const tx = cx - (c * w) / 2 + (s * h) / 2;
  const ty = cy - (s * w) / 2 - (c * h) / 2;
  return [[c, -s, tx], [s, c, ty]];
}

const WEIGHTS: [number, string][] = [[100, "Thin"], [200, "ExtraLight"], [300, "Light"], [400, "Regular"], [500, "Medium"], [600, "SemiBold"], [700, "Bold"], [800, "ExtraBold"], [900, "Black"]];
/** Figma's style name for a CSS weight (the nearest of the nine) and italic. */
export function styleName(weight: number, italic: boolean): string {
  let best = WEIGHTS[3];
  for (const w of WEIGHTS) if (Math.abs(w[0] - weight) < Math.abs(best[0] - weight)) best = w;
  if (!italic) return best[1];
  return best[1] === "Regular" ? "Italic" : `${best[1]} Italic`;
}

const BLENDS: Record<string, BlendMode> = {
  multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN", "color-dodge": "COLOR_DODGE",
  "color-burn": "COLOR_BURN", "hard-light": "HARD_LIGHT", "soft-light": "SOFT_LIGHT", difference: "DIFFERENCE", exclusion: "EXCLUSION",
  hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};
export const blendOf = (css: string): BlendMode | null => BLENDS[css] || null;

/** The weight and slant a font style's name stands for ("Semi Bold Italic" → 600, italic). */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]+/g, "");
  const italic = /italic|oblique|kursiv/.test(s);
  const w =
    /hairline|thin/.test(s) ? 100
    : /(extra|ultra)light/.test(s) ? 200
    : /light/.test(s) ? 300
    : /(semi|demi)bold/.test(s) ? 600
    : /(extra|ultra)bold/.test(s) ? 800
    : /black|heavy/.test(s) ? 900
    : /bold/.test(s) ? 700
    : /medium/.test(s) ? 500
    : 400;
  return { weight: w, italic };
}

/** Of a family's styles, the one nearest a CSS weight and slant (the slant first, then the weight; at the same
 *  distance the heavier, as browsers pick for weights above 500). */
export function nearestStyle(styles: Iterable<string>, weight: number, italic: boolean): string | null {
  let best: string | null = null, score = Infinity;
  for (const st of styles) {
    const f = styleWeight(st);
    const d = (f.italic !== italic ? 10000 : 0) + Math.abs(f.weight - weight) * 2 + (f.weight < weight ? 1 : 0) + (/^(regular|italic)$/i.test(st) ? 0 : 0.5);
    if (d < score) { score = d; best = st; }
  }
  return best;
}

/** CSS's generic families, as fonts Figma may have (the first it has wins). */
export const GENERIC_FONTS: Record<string, string[]> = {
  "system-ui": ["SF Pro Text", "SF Pro", "Segoe UI", "Roboto", "Inter"],
  "ui-sans-serif": ["SF Pro Text", "SF Pro", "Segoe UI", "Roboto", "Inter"],
  "ui-rounded": ["SF Pro Rounded", "Nunito", "Inter"],
  "sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "Inter"],
  serif: ["Times New Roman", "Times", "Georgia", "Noto Serif"],
  "ui-serif": ["New York", "Times New Roman", "Georgia", "Noto Serif"],
  monospace: ["SF Mono", "Menlo", "Roboto Mono", "Courier New"],
  "ui-monospace": ["SF Mono", "Menlo", "Roboto Mono", "Courier New"],
  cursive: ["Comic Sans MS", "Inter"],
  fantasy: ["Impact", "Inter"],
};

/** The names a page's font may go by in Figma: as written; a framework's generated name made readable
 *  ("__GeistSans_3a0388" → "Geist Sans", "Geist"; "__Inter_Fallback_aaf875" is a fallback: skipped); words of a
 *  run-together name split ("PlusJakartaSans" → "Plus Jakarta Sans"). */
export function familyCandidates(family: string): string[] {
  const out = [family];
  let f = family.replace(/^_+/, "").replace(/_Fallback(_[0-9a-zA-Z]+)?$/i, "").replace(/_[0-9a-f]{5,8}$/i, "").replace(/_/g, " ").trim();
  if (!f) return out;
  const spaced = f.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const c of [f, spaced, spaced.replace(/ (Sans|Variable|VF|Var)$/i, ""), spaced.replace(/ (Display|Text)$/i, "")]) if (c && !out.includes(c)) out.push(c);
  return out;
}
