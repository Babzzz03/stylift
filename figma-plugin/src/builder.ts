// StyleLift for Figma — the builder: a page's layers from a StyleLift Figma snapshot (figma.json + its pictures).
// Every layer where the page had it (measured), with its fills, strokes, radii, effects, text runs, pictures and
// vectors; Auto Layout where StyleLift found the page's own flex layout reproduces it; the palette as colour
// variables and the type as text styles. No window of its own: code.ts gives it one (and Figma's MCP runs it bare).
/// <reference types="@figma/plugin-typings" />
import type { FEffect, FFill, FNode, FRun, FigmaSnapshot } from "../../src/extractor/figma-snapshot";
import { linearTransform, radialTransform, conicTransform, rotatedTransform, styleName, blendOf, rgb, nearestStyle, GENERIC_FONTS, familyCandidates } from "./geometry";

export type BuildResult = { layers: number; missingFonts: string[]; images: number; imagesFailed: number; variables: number; styles: number; rootId: string };

// ── fonts: the page's, where Figma has them; Inter otherwise ─────────────────────
type Avail = Map<string, Set<string>>; // family (lower case) → styles
async function fontsAvailable(): Promise<{ avail: Avail; families: Map<string, string> }> {
  const avail: Avail = new Map(), families = new Map<string, string>();
  for (const f of await figma.listAvailableFontsAsync()) {
    const k = f.fontName.family.toLowerCase();
    let s = avail.get(k);
    if (!s) { avail.set(k, (s = new Set())); families.set(k, f.fontName.family); }
    s.add(f.fontName.style);
  }
  return { avail, families };
}
function pickFont(avail: Avail, family: string, weight: number, italic: boolean, families: Map<string, string>): FontName {
  const k = family.toLowerCase();
  const candidates = GENERIC_FONTS[k] ? GENERIC_FONTS[k] : [...familyCandidates(family), ...(/serif/.test(k) && !/sans/.test(k) ? GENERIC_FONTS.serif : []), "Inter"];
  for (const c of candidates) {
    const styles = avail.get(c.toLowerCase());
    if (!styles) continue;
    const st = nearestStyle(styles, weight, italic);
    if (st) return { family: families.get(c.toLowerCase()) || c, style: st };
  }
  return { family: "Inter", style: "Regular" };
}
/** a page font Figma doesn't have (generic families are Figma's to choose; a readable form of its name counts) */
const isMissing = (asked: string, got: FontName) => !GENERIC_FONTS[asked.toLowerCase()] && !familyCandidates(asked).some((c) => c.toLowerCase() === got.family.toLowerCase());

// ── paints / effects ────────────────────────────────────────────────────────────
function paints(fills: FFill[] | undefined, w: number, h: number, images: Map<string, string>): Paint[] {
  const out: Paint[] = [];
  for (const f of fills || []) {
    if (f.k === "solid") out.push({ type: "SOLID", color: rgb(f.color), opacity: f.color.a });
    else if (f.k === "linear") out.push({ type: "GRADIENT_LINEAR", gradientTransform: linearTransform(f.angle, w, h), gradientStops: f.stops.map((s) => ({ position: s.pos, color: { ...rgb(s.color), a: s.color.a } })) });
    else if (f.k === "radial") out.push({ type: "GRADIENT_RADIAL", gradientTransform: radialTransform(f.at), gradientStops: f.stops.map((s) => ({ position: s.pos, color: { ...rgb(s.color), a: s.color.a } })) });
    else if (f.k === "conic") out.push({ type: "GRADIENT_ANGULAR", gradientTransform: conicTransform(f.angle, f.at), gradientStops: f.stops.map((s) => ({ position: s.pos, color: { ...rgb(s.color), a: s.color.a } })) });
    else {
      const hash = images.get(f.img);
      if (!hash) continue;
      if (f.fit === "crop" && f.xf) out.push({ type: "IMAGE", imageHash: hash, scaleMode: "CROP", imageTransform: f.xf, ...(f.opacity !== undefined ? { opacity: f.opacity } : {}) } as ImagePaint);
      else out.push({ type: "IMAGE", imageHash: hash, scaleMode: f.fit === "fit" ? "FIT" : f.fit === "tile" ? "TILE" : "FILL", ...(f.fit === "tile" ? { scalingFactor: 1 } : {}), ...(f.opacity !== undefined ? { opacity: f.opacity } : {}) } as ImagePaint);
    }
  }
  return out;
}
function effects(fx: FEffect[] | undefined): Effect[] {
  const out: Effect[] = [];
  for (const e of fx || []) {
    if ("radius" in e) out.push({ type: e.k === "blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", radius: e.radius, visible: true } as BlurEffect);
    else out.push({ type: e.k === "drop" ? "DROP_SHADOW" : "INNER_SHADOW", color: { ...rgb(e.color), a: e.color.a }, offset: { x: e.x, y: e.y }, radius: e.blur, spread: e.spread, visible: true, blendMode: "NORMAL" } as DropShadowEffect);
  }
  return out;
}

// ── layers ──────────────────────────────────────────────────────────────────────
type Ctx = { images: Map<string, string>; avail: Avail; families: Map<string, string>; missing: Set<string>; count: number; told: number; progress?: (layers: number) => void };
/** one more layer built — the window hears how far it got every 200 */
function built(ctx: Ctx): void {
  ctx.count++;
  if (ctx.count - ctx.told >= 200) { ctx.told = ctx.count; ctx.progress?.(ctx.count); }
}
function boxProps(node: FrameNode | RectangleNode, n: FNode, ctx: Ctx) {
  node.fills = paints(n.fills, n.w, n.h, ctx.images);
  if (n.stroke) {
    node.strokes = [{ type: "SOLID", color: rgb(n.stroke.color), opacity: n.stroke.color.a }];
    node.strokeAlign = "INSIDE";
    const [t, r, b, l] = n.stroke.w;
    if (t === r && r === b && b === l) node.strokeWeight = t;
    else { node.strokeTopWeight = t; node.strokeRightWeight = r; node.strokeBottomWeight = b; node.strokeLeftWeight = l; }
    if (n.stroke.dash) node.dashPattern = [Math.max(2, t * 3), Math.max(2, t * 2)];
  }
  if (n.ellipse) { const r = Math.min(n.w, n.h) / 2; node.topLeftRadius = node.topRightRadius = node.bottomRightRadius = node.bottomLeftRadius = r; }
  else if (n.radius) { node.topLeftRadius = n.radius[0]; node.topRightRadius = n.radius[1]; node.bottomRightRadius = n.radius[2]; node.bottomLeftRadius = n.radius[3]; }
  if (n.effects) node.effects = effects(n.effects);
  if (n.op !== undefined) node.opacity = n.op;
  if (n.blend) { const b = blendOf(n.blend); if (b) node.blendMode = b; }
}
function place(node: SceneNode & LayoutMixin, n: FNode, parent: FNode | null) {
  if (n.rot) node.relativeTransform = rotatedTransform(n.x, n.y, n.w, n.h, n.rot);
  else { node.x = n.x; node.y = n.y; }
  if (parent?.layout) {
    if (n.abs) (node as FrameNode).layoutPositioning = "ABSOLUTE";
    else if (parent.layout.cross === "stretch" && fillsCross(n, parent)) node.layoutAlign = "STRETCH";
  }
}
/** A child the page stretched across its flex parent (one that kept its own size — align-self, a set width — is
 *  not: Figma's STRETCH would override that size) */
function fillsCross(n: FNode, parent: FNode): boolean {
  const L = parent.layout!;
  const inner = L.mode === "col" ? parent.w - L.pad[1] - L.pad[3] : parent.h - L.pad[0] - L.pad[2];
  return Math.abs((L.mode === "col" ? n.w : n.h) - inner) <= 0.75;
}

async function text(n: FNode, parentNode: FrameNode, parent: FNode, ctx: Ctx): Promise<TextNode> {
  const t = figma.createText();
  parentNode.appendChild(t);
  t.name = n.n;
  const runs = (n.runs || []) as FRun[];
  const fonts = runs.map((r) => {
    const f = pickFont(ctx.avail, r.family, r.weight, r.italic, ctx.families);
    if (isMissing(r.family, f)) ctx.missing.add(r.family);
    return f;
  });
  for (const f of new Map(fonts.map((f) => [`${f.family}|${f.style}`, f])).values()) await figma.loadFontAsync(f);
  t.fontName = fonts[0] || { family: "Inter", style: "Regular" };
  t.characters = n.chars || "";
  runs.forEach((r, i) => {
    const a = r.start, b = Math.min(r.end, t.characters.length);
    if (b <= a) return;
    t.setRangeFontName(a, b, fonts[i]);
    t.setRangeFontSize(a, b, Math.max(1, r.size));
    t.setRangeLineHeight(a, b, r.lh === null ? { unit: "AUTO" } : { unit: "PIXELS", value: r.lh });
    t.setRangeLetterSpacing(a, b, { unit: "PIXELS", value: r.ls });
    t.setRangeFills(a, b, r.fill ? paints([r.fill], n.w, n.h, ctx.images) : [{ type: "SOLID", color: rgb(r.color), opacity: r.color.a }]);
    if (r.deco) t.setRangeTextDecoration(a, b, r.deco === "underline" ? "UNDERLINE" : "STRIKETHROUGH");
    if (r.textCase) t.setRangeTextCase(a, b, r.textCase === "upper" ? "UPPER" : r.textCase === "lower" ? "LOWER" : "TITLE");
    if (r.link) { try { t.setRangeHyperlink(a, b, { type: "URL", value: r.link }); } catch { /* not a link Figma takes */ } }
  });
  t.textAlignHorizontal = n.align === "center" ? "CENTER" : n.align === "right" ? "RIGHT" : n.align === "justify" ? "JUSTIFIED" : "LEFT";
  if (n.op !== undefined) t.opacity = n.op;
  place(t, n, parent);
  fitText(t, n);
  built(ctx);
  return t;
}

/** The page's width, so Figma wraps the lines where the page did; the height follows. Figma's shaping can come out a
 *  hair wider than the browser's: a text the page shows on one line must not wrap — it gets the room it needs,
 *  growing the way its alignment grows (left: to the right; centred: both ways; right: to the left). */
export function fitText(t: TextNode, n: FNode): void {
  const w = Math.max(1, n.w);
  t.textAutoResize = "WIDTH_AND_HEIGHT";
  const natural = t.width;
  const oneLine = (n.lines || 0) <= 1 && !(n.chars || "").includes("\n");
  if (oneLine && natural > w) {
    const grow = natural - w;
    if (!n.abs && t.parent && "layoutMode" in t.parent && t.parent.layoutMode !== "NONE") return; // Auto Layout places it
    if (n.align === "center") t.x -= grow / 2;
    else if (n.align === "right") t.x -= grow;
    return;
  }
  setWidth(t, w, n.h);
  // more lines than the page's: a little more room (up to 3%), as above
  const lineH = n.lines ? n.h / n.lines : n.h;
  if (n.lines && t.height > n.h + lineH * 0.5) {
    const wider = w * 1.03;
    setWidth(t, wider, n.h);
    if (t.height <= n.h + lineH * 0.5) {
      if (n.align === "center") t.x -= (wider - w) / 2;
      else if (n.align === "right") t.x -= wider - w;
    } else setWidth(t, w, n.h);
  }
}
/** a fixed width, the height following the text */
function setWidth(t: TextNode, w: number, h: number): void {
  t.textAutoResize = "NONE";
  t.resize(w, Math.max(1, h));
  t.textAutoResize = "HEIGHT";
}

async function layer(n: FNode, parentNode: FrameNode, parent: FNode | null, ctx: Ctx): Promise<void> {
  if (n.t === "text") { await text(n, parentNode, parent!, ctx); return; }
  if (n.t === "svg" && n.svg) {
    let v: FrameNode;
    try {
      v = figma.createNodeFromSvg(n.svg);
    } catch {
      v = figma.createFrame(); // an SVG Figma can't read: its box
      v.fills = [];
    }
    parentNode.appendChild(v);
    v.name = n.n;
    v.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    if (n.op !== undefined) v.opacity = n.op;
    place(v, n, parent);
    built(ctx);
    return;
  }
  const f = figma.createFrame();
  parentNode.appendChild(f);
  f.name = n.n;
  f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  f.clipsContent = !!n.clip || n.t === "image";
  if (n.t === "image" && n.img) {
    n = { ...n, fills: [...(n.fills || []), { k: "image", img: n.img, fit: n.fit || "fill", ...(n.xf ? { xf: n.xf } : {}) }] };
  }
  n = ringAsStroke(n);
  // Figma takes a shadow's spread only on a frame that clips and has a fill showing: one whose children stay inside
  // it loses nothing by clipping
  if (!f.clipsContent && (n.effects || []).some((e) => "spread" in e && e.spread) && (n.fills || []).length && (n.kids || []).every((k) => k.abs || (k.x >= -0.5 && k.y >= -0.5 && k.x + k.w <= n.w + 0.5 && k.y + k.h <= n.h + 0.5))) f.clipsContent = true;
  boxProps(f, n, ctx);
  if (n.layout) {
    const L = n.layout;
    f.layoutMode = L.mode === "row" ? "HORIZONTAL" : "VERTICAL";
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "FIXED";
    f.itemSpacing = L.gap;
    [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = L.pad;
    f.primaryAxisAlignItems = L.main === "between" ? "SPACE_BETWEEN" : L.main === "center" ? "CENTER" : L.main === "end" ? "MAX" : "MIN";
    f.counterAxisAlignItems = L.cross === "center" ? "CENTER" : L.cross === "end" ? "MAX" : L.cross === "baseline" ? "BASELINE" : "MIN";
  }
  place(f, n, parent);
  built(ctx);
  for (const k of n.kids || []) await layer(k, f, n, ctx);
  // (Auto Layout placed its children; its own size stays the page's)
  if (n.layout) f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
}

/** box-shadow: inset 0 0 0 Npx (a border drawn with a shadow) is an inside stroke in Figma — editable as one, and
 *  drawn without the spread Figma only takes on clipping frames */
function ringAsStroke(n: FNode): FNode {
  if (n.stroke || !n.effects) return n;
  const i = n.effects.findIndex((e) => e.k === "inner" && !e.x && !e.y && !e.blur && e.spread > 0);
  if (i < 0) return n;
  const e = n.effects[i] as Extract<FEffect, { k: "drop" | "inner" }>;
  const effects = n.effects.filter((_, j) => j !== i);
  return { ...n, stroke: { color: e.color, w: [e.spread, e.spread, e.spread, e.spread] }, effects: effects.length ? effects : undefined };
}

// ── variables and styles: the page's palette and type ───────────────────────────
async function designSystem(snap: FigmaSnapshot, ctx: Ctx): Promise<{ variables: number; styles: number }> {
  let variables = 0, styles = 0;
  try {
    const col = figma.variables.createVariableCollection(`${snap.title || "Page"} · colours`);
    const mode = col.modes[0].modeId;
    snap.colors.slice(0, 40).forEach((c, i) => {
      const hex = "#" + [c.color.r, c.color.g, c.color.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("") + (c.color.a < 1 ? Math.round(c.color.a * 255).toString(16).padStart(2, "0") : "");
      const v = figma.variables.createVariable(`colour/${String(i + 1).padStart(2, "0")} ${hex}`, col, "COLOR");
      v.setValueForMode(mode, { ...rgb(c.color), a: c.color.a });
      variables++;
    });
  } catch { /* variables need a paid plan for some files: the layers stand without them */ }
  for (const t of snap.texts.slice(0, 24)) {
    try {
      const f = pickFont(ctx.avail, t.family, t.weight, false, ctx.families);
      await figma.loadFontAsync(f);
      const s = figma.createTextStyle();
      s.name = `${t.family}/${t.size}${t.lh ? "·" + t.lh : ""} ${styleName(t.weight, false)}`;
      s.fontName = f;
      s.fontSize = t.size;
      s.lineHeight = t.lh === null ? { unit: "AUTO" } : { unit: "PIXELS", value: t.lh };
      s.letterSpacing = { unit: "PIXELS", value: t.ls };
      styles++;
    } catch { /* a style Figma refuses: skipped */ }
  }
  return { variables, styles };
}

export async function build(snap: FigmaSnapshot, bytes: Record<string, Uint8Array>, withSystem: boolean, progress?: (layers: number) => void): Promise<BuildResult> {
  const images = new Map<string, string>();
  let imagesFailed = 0;
  for (const [id, b] of Object.entries(bytes)) {
    try { images.set(id, figma.createImage(b).hash); } catch { imagesFailed++; /* a format Figma can't read */ }
  }
  await figma.loadFontAsync({ family: "Inter", style: "Regular" }); // a new text layer starts in it
  const { avail, families } = await fontsAvailable();
  const ctx: Ctx = { images, avail, families, missing: new Set(), count: 0, told: 0, progress };
  // beside what is on the page already
  const right = figma.currentPage.children.reduce((m, c) => Math.max(m, c.x + c.width), -Infinity);
  const root = figma.createFrame();
  root.name = snap.title || (/^[a-z]+:\/\/([^/?#]+)/i.exec(snap.url)?.[1] ?? "Page"); // (no URL class in Figma's sandbox)
  root.resize(snap.width, snap.height);
  root.clipsContent = true;
  root.fills = paints(snap.root.fills, snap.width, snap.height, images);
  root.x = isFinite(right) ? right + 200 : 0;
  root.y = 0;
  for (const k of snap.root.kids || []) {
    await layer(k, root, snap.root, ctx);
  }
  const sys = withSystem ? await designSystem(snap, ctx) : { variables: 0, styles: 0 };
  try { figma.viewport.scrollAndZoomIntoView([root]); } catch { /* no viewport (run without the editor open) */ }
  return { layers: ctx.count, missingFonts: Array.from(ctx.missing), images: images.size, imagesFailed, ...sys, rootId: root.id };
}
