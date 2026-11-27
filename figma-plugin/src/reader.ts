// StyleLift for Figma — the reader: the frames you select, written as StyleLift designs (the same description of
// layers the extension writes when it brings a page INTO Figma — figma-snapshot.ts — filled the other way round).
// StyleLift opens it as a Studio project: HTML, React, Next.js, Elementor from there.
//
// Every layer where Figma has it (absolute transforms, so groups and nested frames add up), with its fills (solid,
// linear / radial / angular gradients, pictures by their scale mode), strokes per side, radii, shadows and blurs,
// opacity, blend, clipping; Auto Layout as it is; text in its styled runs; anything drawn (vectors, booleans,
// stars, lines) as the SVG Figma itself exports; pictures as the bytes Figma holds.
/// <reference types="@figma/plugin-typings" />
import type { FEffect, FFill, FLayout, FNode, FRun, FStop, FigmaSnapshot, RGBA } from "../../src/extractor/figma-snapshot";

export type DesignBundle = {
  v: 1;
  kind: "figma-design";
  file: string;
  pages: FigmaSnapshot[];
};
export type ReadResult = { design: DesignBundle; images: Record<string, Uint8Array>; skipped: number };

type M = Transform; // [[a, c, tx], [b, d, ty]]
const round = (n: number) => Math.round(n * 100) / 100;
const rgba = (c: RGB | RGBA, a = 1): RGBA => ({ r: round(c.r), g: round(c.g), b: round(c.b), a: round(("a" in c ? (c as RGBA).a : 1) * a) });
const BLEND: Partial<Record<BlendMode, string>> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion",
  HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

/** invert a 2×3 transform */
function inv(m: M): M {
  const [[a, c, tx], [b, d, ty]] = m;
  const det = a * d - b * c || 1e-9;
  return [[d / det, -c / det, (c * ty - d * tx) / det], [-b / det, a / det, (b * tx - a * ty) / det]];
}
const apply = (m: M, x: number, y: number): [number, number] => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];

/** A Figma linear gradient (its transform maps the layer's 0–1 square to the gradient's, which runs along x) as CSS:
 *  the angle of its line, and each stop moved to where it falls on CSS's line through the box's centre. */
function linearFromFigma(p: GradientPaint, w: number, h: number): FFill {
  const t = inv(p.gradientTransform);
  const [x0, y0] = apply(t, 0, 0.5), [x1, y1] = apply(t, 1, 0.5);
  const dx = (x1 - x0) * w, dy = (y1 - y0) * h;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const angle = ((Math.atan2(ux, -uy) * 180) / Math.PI + 360) % 360;
  const L = Math.abs(w * ux) + Math.abs(h * uy) || 1;
  const stops: FStop[] = p.gradientStops.map((s) => {
    const px = (x0 + (x1 - x0) * s.position) * w - w / 2, py = (y0 + (y1 - y0) * s.position) * h - h / 2;
    return { pos: round((px * ux + py * uy) / L + 0.5), color: rgba(s.color, p.opacity ?? 1) };
  });
  return { k: "linear", angle: round(angle), stops };
}
/** radial / diamond (as radial) / angular: centre and radii from the transform's handles */
function roundFromFigma(p: GradientPaint): FFill {
  const t = inv(p.gradientTransform);
  const [cx, cy] = apply(t, 0.5, 0.5), [ax, ay] = apply(t, 1, 0.5), [bx, by] = apply(t, 0.5, 1);
  const at = { cx: round(cx), cy: round(cy), rx: round(Math.hypot(ax - cx, ay - cy)), ry: round(Math.hypot(bx - cx, by - cy)) };
  const stops: FStop[] = p.gradientStops.map((s) => ({ pos: round(s.position), color: rgba(s.color, p.opacity ?? 1) }));
  if (p.type === "GRADIENT_ANGULAR") {
    // CSS starts straight up and turns clockwise; Figma's starts along its handle
    const angle = ((Math.atan2(ax - cx, -(ay - cy)) * 180) / Math.PI + 360) % 360;
    return { k: "conic", angle: round(angle), stops, at };
  }
  return { k: "radial", stops, at };
}

type Ctx = { images: Record<string, Uint8Array>; hashes: Map<string, string>; list: FigmaSnapshot["images"]; skipped: number; count: number; max: number };

async function imageId(hash: string, w: number, h: number, ctx: Ctx): Promise<string | null> {
  const known = ctx.hashes.get(hash);
  if (known) {
    // (already saved for an earlier frame: listed for this one too)
    if (!ctx.list.some((x) => x.id === known)) ctx.list.push({ id: known, url: `images/${known}`, w: Math.round(w), h: Math.round(h) });
    return known;
  }
  const img = figma.getImageByHash(hash);
  if (!img) return null;
  const bytes = await img.getBytesAsync();
  const id = `i${ctx.hashes.size + 1}`;
  ctx.hashes.set(hash, id);
  ctx.images[id] = bytes;
  ctx.list.push({ id, url: `images/${id}`, w: Math.round(w), h: Math.round(h) });
  return id;
}

async function fillsOf(paints: ReadonlyArray<Paint> | PluginAPI["mixed"], w: number, h: number, ctx: Ctx): Promise<FFill[]> {
  if (!Array.isArray(paints)) return [];
  const out: FFill[] = [];
  for (const p of paints as Paint[]) {
    if (p.visible === false || (p.opacity ?? 1) <= 0) continue;
    if (p.type === "SOLID") out.push({ k: "solid", color: rgba(p.color, p.opacity ?? 1) });
    else if (p.type === "GRADIENT_LINEAR") out.push(linearFromFigma(p, w, h));
    else if (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND" || p.type === "GRADIENT_ANGULAR") out.push(roundFromFigma(p));
    else if (p.type === "IMAGE" && p.imageHash) {
      const id = await imageId(p.imageHash, w, h, ctx);
      if (!id) continue;
      const fit = p.scaleMode === "FIT" ? "fit" : p.scaleMode === "TILE" ? "tile" : p.scaleMode === "CROP" ? "crop" : "fill";
      out.push({ k: "image", img: id, fit, ...(p.scaleMode === "CROP" && p.imageTransform ? { xf: p.imageTransform as [[number, number, number], [number, number, number]] } : {}), ...((p.opacity ?? 1) < 1 ? { opacity: round(p.opacity ?? 1) } : {}) });
    }
  }
  return out;
}

function effectsOf(n: SceneNode): FEffect[] | undefined {
  if (!("effects" in n)) return undefined;
  const out: FEffect[] = [];
  for (const e of n.effects) {
    if (!e.visible) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") out.push({ k: e.type === "DROP_SHADOW" ? "drop" : "inner", x: round(e.offset.x), y: round(e.offset.y), blur: round(e.radius), spread: round(e.spread || 0), color: rgba(e.color) });
    else if (e.type === "LAYER_BLUR") out.push({ k: "blur", radius: round(e.radius) });
    else if (e.type === "BACKGROUND_BLUR") out.push({ k: "bgblur", radius: round(e.radius) });
  }
  return out.length ? out : undefined;
}

function strokeOf(n: SceneNode): FNode["stroke"] | undefined {
  if (!("strokes" in n) || !Array.isArray(n.strokes)) return undefined;
  const p = (n.strokes as Paint[]).find((s) => s.visible !== false && s.type === "SOLID") as SolidPaint | undefined;
  if (!p) return undefined;
  const g = n as SceneNode & { strokeWeight: number | PluginAPI["mixed"]; strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number; dashPattern?: ReadonlyArray<number> };
  const all = typeof g.strokeWeight === "number" ? g.strokeWeight : 0;
  const w: [number, number, number, number] = [g.strokeTopWeight ?? all, g.strokeRightWeight ?? all, g.strokeBottomWeight ?? all, g.strokeLeftWeight ?? all].map(round) as [number, number, number, number];
  if (!w.some((x) => x > 0)) return undefined;
  return { color: rgba(p.color, p.opacity ?? 1), w, ...(g.dashPattern && g.dashPattern.length ? { dash: true } : {}) };
}

function radiiOf(n: SceneNode): [number, number, number, number] | undefined {
  const g = n as SceneNode & { cornerRadius?: number | PluginAPI["mixed"]; topLeftRadius?: number; topRightRadius?: number; bottomRightRadius?: number; bottomLeftRadius?: number };
  if (g.topLeftRadius === undefined && typeof g.cornerRadius !== "number") return undefined;
  const r: [number, number, number, number] = [g.topLeftRadius ?? (g.cornerRadius as number), g.topRightRadius ?? (g.cornerRadius as number), g.bottomRightRadius ?? (g.cornerRadius as number), g.bottomLeftRadius ?? (g.cornerRadius as number)].map((x) => round(x || 0)) as [number, number, number, number];
  return r.some((x) => x > 0) ? r : undefined;
}

function layoutOf(n: FrameNode | ComponentNode | InstanceNode): FLayout | undefined {
  if (n.layoutMode === "NONE" || (n.layoutMode as string) === "GRID") return undefined;
  return {
    mode: n.layoutMode === "HORIZONTAL" ? "row" : "col",
    gap: n.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : round(n.itemSpacing),
    pad: [round(n.paddingTop), round(n.paddingRight), round(n.paddingBottom), round(n.paddingLeft)],
    main: n.primaryAxisAlignItems === "SPACE_BETWEEN" ? "between" : n.primaryAxisAlignItems === "CENTER" ? "center" : n.primaryAxisAlignItems === "MAX" ? "end" : "start",
    cross: n.counterAxisAlignItems === "CENTER" ? "center" : n.counterAxisAlignItems === "MAX" ? "end" : n.counterAxisAlignItems === "BASELINE" ? "baseline" : "start",
    wrap: n.layoutWrap === "WRAP",
  };
}

async function textOf(n: TextNode, base: FNode, ctx: Ctx): Promise<FNode> {
  const segs = n.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fills", "textDecoration", "textCase", "hyperlink"]);
  const runs: FRun[] = [];
  for (const s of segs) {
    const size = s.fontSize;
    const lh = s.lineHeight.unit === "PIXELS" ? round(s.lineHeight.value) : s.lineHeight.unit === "PERCENT" ? round((size * s.lineHeight.value) / 100) : null;
    const ls = s.letterSpacing.unit === "PIXELS" ? round(s.letterSpacing.value) : round((size * s.letterSpacing.value) / 100);
    const fills = await fillsOf(s.fills, n.width, n.height, ctx);
    const solid = fills.find((f) => f.k === "solid") as Extract<FFill, { k: "solid" }> | undefined;
    const grad = fills.find((f) => f.k !== "solid" && f.k !== "image");
    const run: FRun = {
      start: s.start, end: s.end, family: s.fontName.family, weight: s.fontWeight, italic: /italic|oblique/i.test(s.fontName.style),
      size: round(size), lh, ls, color: solid ? solid.color : { r: 0, g: 0, b: 0, a: 1 },
    };
    if (grad) run.fill = grad;
    if (s.textDecoration === "UNDERLINE") run.deco = "underline";
    else if (s.textDecoration === "STRIKETHROUGH") run.deco = "strike";
    if (s.textCase === "UPPER") run.textCase = "upper";
    else if (s.textCase === "LOWER") run.textCase = "lower";
    else if (s.textCase === "TITLE") run.textCase = "title";
    if (s.hyperlink && s.hyperlink.type === "URL") run.link = s.hyperlink.value;
    runs.push(run);
  }
  const align = n.textAlignHorizontal === "CENTER" ? "center" : n.textAlignHorizontal === "RIGHT" ? "right" : n.textAlignHorizontal === "JUSTIFIED" ? "justify" : "left";
  const valign = n.textAlignVertical === "CENTER" ? "center" : n.textAlignVertical === "BOTTOM" ? "bottom" : undefined;
  return { ...base, t: "text", chars: n.characters, runs, align, ...(valign ? { valign } : {}) };
}

/** a node, placed relative to its parent layer's corner (`parentAbs`: the parent's absolute transform) */
async function nodeOf(n: SceneNode, parentAbs: M, parentLayout: boolean, ctx: Ctx): Promise<FNode | null> {
  if (!n.visible) return null;
  if (ctx.count >= ctx.max) { ctx.skipped++; return null; }
  ctx.count++;
  const w = "width" in n ? n.width : 0, h = "height" in n ? n.height : 0;
  // where it is in its parent: its own transform against the parent's, its box unrotated and placed by its centre
  const abs = n.absoluteTransform;
  const rel = (() => {
    const pi = inv(parentAbs);
    // its turn against its parent's (a child of a rotated frame turns with it: no turn of its own)
    const a = pi[0][0] * abs[0][0] + pi[0][1] * abs[1][0], b = pi[1][0] * abs[0][0] + pi[1][1] * abs[1][0];
    const [cxAbs, cyAbs] = apply(abs, w / 2, h / 2);
    const [cx, cy] = apply(pi, cxAbs, cyAbs);
    return { x: cx - w / 2, y: cy - h / 2, rot: (Math.atan2(b, a) * 180) / Math.PI };
  })();
  const base: FNode = { t: "frame", n: n.name.slice(0, 60), x: round(rel.x), y: round(rel.y), w: round(w), h: round(h) };
  if (Math.abs(rel.rot) > 0.05 && Math.abs(Math.abs(rel.rot) - 360) > 0.05) base.rot = round(rel.rot);
  if ("opacity" in n && n.opacity < 1) base.op = round(n.opacity);
  if ("blendMode" in n && BLEND[n.blendMode]) base.blend = BLEND[n.blendMode];
  if (parentLayout && "layoutPositioning" in n && n.layoutPositioning === "ABSOLUTE") base.abs = true;
  const fx = effectsOf(n);
  if (fx) base.effects = fx;

  if (n.type === "TEXT") return textOf(n, base, ctx);

  // drawn shapes: the SVG Figma exports for them (a rectangle or an oval stays a box: editable as one)
  const box = n.type === "RECTANGLE" || (n.type === "ELLIPSE" && !(n.arcData && (n.arcData.endingAngle - n.arcData.startingAngle < 6.28 || n.arcData.innerRadius > 0)));
  if (!box && (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION" || n.type === "STAR" || n.type === "POLYGON" || n.type === "LINE" || n.type === "ELLIPSE")) {
    try {
      const svg = await n.exportAsync({ format: "SVG_STRING" });
      // (the SVG covers what the shape paints, strokes outside its box included)
      const rb = n.absoluteRenderBounds;
      if (rb) {
        const [px, py] = apply(inv(parentAbs), rb.x, rb.y);
        return { ...base, t: "svg", x: round(px), y: round(py), w: round(rb.width), h: round(rb.height), svg, rot: undefined };
      }
      return { ...base, t: "svg", svg };
    } catch {
      return null;
    }
  }

  const node: FNode = { ...base };
  if ("fills" in n) {
    const fills = await fillsOf(n.fills, w, h, ctx);
    if (fills.length) node.fills = fills;
  }
  const st = strokeOf(n);
  if (st) node.stroke = st;
  if (n.type === "ELLIPSE") node.ellipse = true;
  else {
    const r = radiiOf(n);
    if (r) node.radius = r;
  }
  if ("clipsContent" in n && n.clipsContent) node.clip = true;
  let layout: FLayout | undefined;
  if (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE") {
    layout = layoutOf(n);
    if (layout) node.layout = layout;
  }
  if ("children" in n) {
    // a group has no box of its own in Figma's coordinates: its children are placed against the same parent,
    // so they are measured against the group's own (unrotated) box here
    const kids: FNode[] = [];
    for (const k of n.children) {
      const c = await nodeOf(k, abs, !!layout, ctx);
      if (c) kids.push(c);
    }
    if (kids.length) node.kids = kids;
  }
  return node;
}

/** The selected frames (or the page's top frames when nothing is selected), each a page of the design. */
export async function readSelection(max = 6000, only?: readonly SceneNode[]): Promise<ReadResult> {
  const sel = (only || figma.currentPage.selection).filter((n) => "absoluteTransform" in n);
  const frames = sel.length ? sel : figma.currentPage.children.filter((n) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "SECTION");
  const ctx: Ctx = { images: {}, hashes: new Map(), list: [], skipped: 0, count: 0, max };
  const pages: FigmaSnapshot[] = [];
  for (const f of frames) {
    ctx.list = [];
    const fw = "width" in f ? f.width : 0, fh = "height" in f ? f.height : 0;
    const root = await nodeOf(f, f.absoluteTransform, false, ctx);
    if (!root) continue;
    const pageRoot: FNode = { ...root, x: 0, y: 0, rot: undefined };
    const fonts = new Map<string, { family: string; weight: number; italic: boolean }>();
    const colors = new Map<string, { color: RGBA; uses: number }>();
    const texts = new Map<string, { family: string; weight: number; size: number; lh: number | null; ls: number; uses: number }>();
    const walk = (x: FNode) => {
      for (const fl of x.fills || []) if (fl.k === "solid") { const k = JSON.stringify(fl.color); const u = colors.get(k); if (u) u.uses++; else colors.set(k, { color: fl.color, uses: 1 }); }
      for (const r of x.runs || []) {
        fonts.set(`${r.family}|${r.weight}|${r.italic}`, { family: r.family, weight: r.weight, italic: r.italic });
        const k = JSON.stringify(r.color); const u = colors.get(k); if (u) u.uses++; else colors.set(k, { color: r.color, uses: 1 });
        const tk = `${r.family}|${r.weight}|${r.size}|${r.lh}|${r.ls}`; const t = texts.get(tk); if (t) t.uses++; else texts.set(tk, { family: r.family, weight: r.weight, size: r.size, lh: r.lh, ls: r.ls, uses: 1 });
      }
      for (const k of x.kids || []) walk(k);
    };
    walk(pageRoot);
    let nodes = 0, txt = 0, img = 0, svg = 0, al = 0;
    const count = (x: FNode) => { nodes++; if (x.t === "text") txt++; if (x.t === "svg") svg++; if ((x.fills || []).some((f) => f.k === "image")) img++; if (x.layout) al++; (x.kids || []).forEach(count); };
    count(pageRoot);
    pages.push({
      v: 1,
      url: `figma://${encodeURIComponent(figma.root.name)}/${encodeURIComponent(f.name)}`,
      title: f.name,
      width: Math.round(fw),
      height: Math.round(fh),
      root: pageRoot,
      images: ctx.list,
      fonts: [...fonts.values()],
      colors: [...colors.values()].sort((a, b) => b.uses - a.uses).slice(0, 64),
      texts: [...texts.values()].sort((a, b) => b.uses - a.uses).slice(0, 48),
      stats: { nodes, texts: txt, images: img, svgs: svg, autoLayout: al, skipped: ctx.skipped },
    });
  }
  return { design: { v: 1, kind: "figma-design", file: figma.root.name, pages }, images: ctx.images, skipped: ctx.skipped };
}
