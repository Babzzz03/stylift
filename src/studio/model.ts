// StyleLift Studio — pure model (no DOM globals beyond what a Document provides),
// shared by the studio UI and the node tests.
//
// A project is the captured page (one canonical HTML document) plus style edits.
// Every element in <body> gets a stable data-sl-id so the same node can be found in
// the Desktop, Tablet and Phone artboards and in the canonical document.
// Style edits are scoped like Framer: Desktop is the base, Tablet and Phone override
// it below their breakpoints. They compile to one stylesheet of
// [data-sl-id="N"] { prop: value !important } rules.

import { MODEL_VIEWER_SRC } from "../shared/model-viewer";
import { POINTER_SELECTOR, WIDGET_SELECTOR, isMotionProp, motionKeyframes, motionRules, motionRuntimeSource, needsMotionRuntime, readMotion } from "./motion";

export type Scope = "base" | "tablet" | "phone";
export type StyleEdits = Record<string, Partial<Record<Scope, Record<string, string>>>>;

export const ID_ATTR = "data-sl-id";
export const SCOPES: { id: Scope; label: string; width: number; height: number; media: string | null }[] = [
  { id: "base", label: "Desktop", width: 1440, height: 900, media: null },
  { id: "tablet", label: "Tablet", width: 810, height: 1080, media: "(max-width: 1199.98px)" },
  { id: "phone", label: "Phone", width: 390, height: 844, media: "(max-width: 809.98px)" },
];

/** Give every element in <body> a stable id (keeps ids that already exist). */
export function assignIds(doc: Document): number {
  let max = 0;
  doc.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => {
    const n = Number(el.getAttribute(ID_ATTR));
    if (n > max) max = n;
  });
  const walk = (el: Element) => {
    if (!el.hasAttribute(ID_ATTR)) el.setAttribute(ID_ATTR, String(++max));
    for (const c of Array.from(el.children)) if (!/^(script|style|template|noscript)$/i.test(c.localName)) walk(c);
  };
  if (doc.body) walk(doc.body);
  return max;
}

/** Highest id in use (for ids of duplicated nodes). */
export function maxId(doc: Document): number {
  let max = 0;
  doc.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => (max = Math.max(max, Number(el.getAttribute(ID_ATTR)) || 0)));
  return max;
}

const cssProp = (p: string) => p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const decls = (props: Record<string, string>) =>
  Object.entries(props)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${cssProp(k)}: ${v} !important;`)
    .join(" ");

const WIDER: Record<Scope, Scope[]> = { base: ["base"], tablet: ["base", "tablet"], phone: ["base", "tablet", "phone"] };
/** An element's edits as they apply in a scope: the wider scopes' first, then the scope's own. */
export function mergedEdits(edits: StyleEdits, id: string, scope: Scope): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of WIDER[scope]) Object.assign(out, edits[id]?.[s] || {});
  return out;
}
const MOTION_BASE_PROPS = ["translate", "scale", "rotate", "opacity", "boxShadow"];

/**
 * Compile style edits into one stylesheet (Desktop base, then Tablet, then Phone). Studio motion
 * (--slm-* properties) compiles to its keyframes and rules here too. `motionGuard` wraps motion in
 * prefers-reduced-motion (exports); Studio's artboards leave it off so the editor always shows it.
 */
export function editsToCss(edits: StyleEdits, opts: { motionGuard?: boolean } = {}): string {
  const out: string[] = [];
  const keyframes = new Set<string>();
  const guard = opts.motionGuard !== false;
  for (const sc of SCOPES) {
    const rules: string[] = [];
    for (const [id, byScope] of Object.entries(edits)) {
      const props = byScope[sc.id];
      if (!props) continue;
      const sel = `[${ID_ATTR}="${id}"]`;
      const d = decls(props);
      if (d) rules.push(`${sel} { ${d} }`);
      // motion: where it's set, and where this scope moves / scales the element under an inherited hover
      const keys = Object.keys(props);
      if (keys.some(isMotionProp) || keys.some((k) => MOTION_BASE_PROPS.includes(k))) {
        const merged = mergedEdits(edits, id, sc.id);
        const m = readMotion(merged);
        if (!m || (!keys.some(isMotionProp) && m.on !== "hover")) continue;
        const wider = sc.id === "phone" ? "tablet" : sc.id === "tablet" ? "base" : null;
        const prev = wider ? readMotion(mergedEdits(edits, id, wider)) : null;
        rules.push(...motionRules(sel, m, merged, prev, keyframes, guard));
      }
    }
    if (!rules.length) continue;
    out.push(sc.media ? `@media ${sc.media} {\n${rules.map((r) => "  " + r).join("\n")}\n}` : rules.join("\n"));
  }
  if (keyframes.size) out.push(motionKeyframes(keyframes));
  return out.length ? `/* StyleLift Studio edits */\n${out.join("\n")}\n` : "";
}
/** Every element's merged edits, per scope (what the motion runtime check looks at). */
const allMerged = (edits: StyleEdits) => Object.keys(edits).flatMap((id) => SCOPES.map((sc) => mergedEdits(edits, id, sc.id)));

/** The value an element shows in a scope: the scope's own edit, else the wider scopes'. */
export function effectiveEdit(edits: StyleEdits, id: string, scope: Scope, prop: string): string | undefined {
  const order: Scope[] = scope === "phone" ? ["phone", "tablet", "base"] : scope === "tablet" ? ["tablet", "base"] : ["base"];
  for (const s of order) {
    const v = edits[id]?.[s]?.[prop];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function setEdit(edits: StyleEdits, id: string, scope: Scope, prop: string, value: string): StyleEdits {
  const next: StyleEdits = JSON.parse(JSON.stringify(edits));
  next[id] ||= {};
  next[id][scope] ||= {};
  if (value === "") delete next[id][scope]![prop];
  else next[id][scope]![prop] = value;
  if (!Object.keys(next[id][scope]!).length) delete next[id][scope];
  if (!Object.keys(next[id]).length) delete next[id];
  return next;
}

// ── layers ────────────────────────────────────────────────────────────────────
export type LayerKind = "frame" | "text" | "image" | "link" | "button" | "svg" | "video" | "input" | "section" | "component";
export function layerKind(el: Element): LayerKind {
  const tag = el.localName.toLowerCase();
  // (canonical documents come from DOMParser and have no window: compare namespaces, not classes)
  const isHtml = el.namespaceURI === "http://www.w3.org/1999/xhtml";
  if (tag === "img" || tag === "picture" || (isHtml && /url\(/.test(el.getAttribute("style") || "") && !el.children.length)) return "image";
  if (tag === "svg") return "svg";
  if (tag === "video" || tag === "iframe" || tag === "canvas") return "video";
  if (tag === "a") return "link";
  if (tag === "button" || el.getAttribute("role") === "button") return "button";
  if (/^(input|textarea|select|form)$/.test(tag)) return "input";
  if (/^(section|header|footer|nav|main|aside|article)$/.test(tag)) return "section";
  if (tag.includes("-")) return "component";
  const textOnly = Array.from(el.childNodes).every((n) => n.nodeType === 3 || (n.nodeType === 1 && /^(span|b|strong|i|em|br|u|small|sup|sub|mark|code)$/i.test((n as Element).localName)));
  if (textOnly && (el.textContent || "").trim()) return "text";
  return "frame";
}
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
export function layerName(el: Element): string {
  const a = (n: string) => tidy(el.getAttribute(n) || "");
  const named = a("data-framer-name") || a("aria-label") || a("data-name") || a("title");
  if (named) return named.slice(0, 48);
  const kind = layerKind(el);
  const tag = el.localName.toLowerCase();
  if (kind === "text" || kind === "link" || kind === "button") {
    const t = tidy(el.textContent || "");
    if (t) return t.length > 34 ? t.slice(0, 33) + "…" : t;
  }
  if (kind === "image") return a("alt") || "Image";
  const id = a("id").replace(/^[_-]+/, "");
  if (id && !/\d{3,}/.test(id)) return id;
  const landmark: Record<string, string> = { header: "Header", footer: "Footer", nav: "Navigation", main: "Main", section: "Section", aside: "Aside", article: "Article", form: "Form", ul: "List", ol: "List", li: "Item" };
  if (landmark[tag]) return landmark[tag];
  if (kind === "svg") return "Icon";
  if (kind === "video") return tag === "video" ? "Video" : tag === "canvas" ? "Canvas" : "Embed";
  if (kind === "component") return tag;
  return kind === "text" ? "Text" : "Frame";
}

// ── export ────────────────────────────────────────────────────────────────────
const EDITOR_ATTRS = ["data-sl-sel", "data-sl-hover", "contenteditable", "spellcheck"];
/** Final page HTML: the canonical document with the edit stylesheet, ids kept only where styles need them. */
export function buildExportHtml(doc: Document, edits: StyleEdits): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  const keep = new Set(Object.keys(edits));
  clone.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => {
    if (!keep.has(el.getAttribute(ID_ATTR) || "")) el.removeAttribute(ID_ATTR);
  });
  clone.querySelectorAll("*").forEach((el) => EDITOR_ATTRS.forEach((a) => el.removeAttribute(a)));
  clone.querySelectorAll("[data-sl-editor]").forEach((el) => el.remove());
  const css = editsToCss(edits);
  if (css) {
    const head = clone.querySelector("head") || clone;
    const st = doc.createElement("style");
    st.setAttribute("data-stylelift", "studio-edits");
    st.textContent = css;
    head.appendChild(st);
  }
  // "Scroll into view" / word-by-word motion: the small trigger script (everything plays on load without it)
  // (also for the site's own recorded entrances that wait to be scrolled into view)
  // your own 3D models: Google's model-viewer (Apache-2.0, pinned, from a CDN)
  if (clone.querySelector("model-viewer[data-sl-model]") && !clone.querySelector("script[data-sl-model-viewer]")) {
    const mv = clone.ownerDocument.createElement("script");
    mv.setAttribute("type", "module");
    mv.setAttribute("src", MODEL_VIEWER_SRC);
    mv.setAttribute("data-sl-model-viewer", "");
    (clone.querySelector("head") || clone).appendChild(mv);
  }
  if ((needsMotionRuntime(allMerged(edits)) || clone.querySelector(`[data-sl-in-on="enter"], ${POINTER_SELECTOR}, ${WIDGET_SELECTOR}`)) && !clone.querySelector("script[data-sl-motion-runtime]")) {
    const sc = doc.createElement("script");
    sc.setAttribute("data-sl-motion-runtime", "");
    sc.textContent = motionRuntimeSource();
    (clone.querySelector("body") || clone).appendChild(sc);
  }
  return "<!doctype html>\n" + clone.outerHTML;
}

// ── properties shown in the panel ─────────────────────────────────────────────
export interface FieldDef {
  prop: string;
  label: string;
  type: "text" | "number" | "color" | "select" | "range";
  options?: string[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}
export interface SectionDef {
  title: string;
  fields: FieldDef[];
  when?: (kind: LayerKind, cs: CSSStyleDeclaration) => boolean;
}
export const PROPERTY_SECTIONS: SectionDef[] = [
  {
    title: "Position",
    fields: [
      { prop: "position", label: "Type", type: "select", options: ["static", "relative", "absolute", "fixed", "sticky"] },
      { prop: "top", label: "Top", type: "text" },
      { prop: "left", label: "Left", type: "text" },
      { prop: "right", label: "Right", type: "text" },
      { prop: "bottom", label: "Bottom", type: "text" },
      { prop: "zIndex", label: "Z index", type: "text" },
    ],
  },
  {
    title: "Size",
    fields: [
      { prop: "width", label: "Width", type: "text" },
      { prop: "height", label: "Height", type: "text" },
      { prop: "minWidth", label: "Min W", type: "text" },
      { prop: "maxWidth", label: "Max W", type: "text" },
      { prop: "minHeight", label: "Min H", type: "text" },
      { prop: "maxHeight", label: "Max H", type: "text" },
    ],
  },
  {
    title: "Layout",
    fields: [
      { prop: "display", label: "Display", type: "select", options: ["block", "flex", "grid", "inline-block", "inline", "inline-flex", "none"] },
      { prop: "flexDirection", label: "Direction", type: "select", options: ["row", "column", "row-reverse", "column-reverse"] },
      { prop: "justifyContent", label: "Distribute", type: "select", options: ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"] },
      { prop: "alignItems", label: "Align", type: "select", options: ["stretch", "flex-start", "center", "flex-end", "baseline"] },
      { prop: "gap", label: "Gap", type: "text" },
      { prop: "flexWrap", label: "Wrap", type: "select", options: ["nowrap", "wrap"] },
    ],
    when: (_k, cs) => /flex|grid/.test(cs.display),
  },
  {
    title: "Grid",
    fields: [
      { prop: "gridTemplateColumns", label: "Columns", type: "text" },
      { prop: "gridTemplateRows", label: "Rows", type: "text" },
      { prop: "columnGap", label: "Col gap", type: "text" },
      { prop: "rowGap", label: "Row gap", type: "text" },
      { prop: "justifyItems", label: "Justify", type: "select", options: ["stretch", "start", "center", "end"] },
    ],
    when: (_k, cs) => /grid/.test(cs.display),
  },
  {
    title: "Spacing",
    fields: [
      { prop: "padding", label: "Padding", type: "text" },
      { prop: "margin", label: "Margin", type: "text" },
    ],
  },
  {
    title: "Styles",
    fields: [
      { prop: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.01 },
      { prop: "backgroundColor", label: "Fill", type: "color" },
      { prop: "borderRadius", label: "Radius", type: "text" },
      { prop: "border", label: "Border", type: "text" },
      { prop: "boxShadow", label: "Shadow", type: "text" },
      { prop: "overflow", label: "Overflow", type: "select", options: ["visible", "hidden", "clip", "auto", "scroll"] },
    ],
  },
  {
    title: "Transforms",
    fields: [
      { prop: "rotate", label: "Rotate", type: "text" },
      { prop: "scale", label: "Scale", type: "text" },
      { prop: "translate", label: "Offset", type: "text" },
    ],
  },
  {
    title: "Text",
    fields: [
      { prop: "fontFamily", label: "Font", type: "text" },
      { prop: "fontSize", label: "Size", type: "text" },
      { prop: "fontWeight", label: "Weight", type: "select", options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
      { prop: "lineHeight", label: "Line H", type: "text" },
      { prop: "letterSpacing", label: "Letter", type: "text" },
      { prop: "color", label: "Color", type: "color" },
      { prop: "textAlign", label: "Align", type: "select", options: ["left", "center", "right", "justify"] },
      { prop: "textTransform", label: "Case", type: "select", options: ["none", "uppercase", "lowercase", "capitalize"] },
    ],
    when: (k) => k === "text" || k === "link" || k === "button",
  },
];

/** rgb()/rgba() → #rrggbb for <input type=color>. */
export function toHex(c: string): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000";
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

// ── full-height artboards ─────────────────────────────────────────────────────
// An artboard shows the whole page at once, so its iframe is as tall as the page —
// which would make "100vh" mean "the whole page". Resolve viewport units against the
// breakpoint's real screen size instead (canvas copy only; exports keep the units).
const VP_UNIT = /(-?\d*\.?\d+)(dvh|svh|lvh|vh|dvmin|svmin|lvmin|vmin|dvmax|svmax|lvmax|vmax)\b/g;
export function resolveViewportUnits(css: string, width: number, height: number): string {
  return css.replace(VP_UNIT, (_m, n: string, unit: string) => {
    const base = /vh$/.test(unit) ? height : /min$/.test(unit) ? Math.min(width, height) : Math.max(width, height);
    return `${Math.round(parseFloat(n) * base * 100) / 10000}px`;
  });
}
/** Apply resolveViewportUnits to every <style> block and style="" attribute of a page. */
export function resolveViewportUnitsInHtml(html: string, width: number, height: number): string {
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a: string, b: string, c: string) => a + resolveViewportUnits(b, width, height) + c)
    .replace(/(\sstyle=")([^"]*)(")/gi, (_m, a: string, b: string, c: string) => a + resolveViewportUnits(b, width, height) + c);
}
