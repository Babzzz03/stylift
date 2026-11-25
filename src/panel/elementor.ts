// Elementor template export. Turns a captured page into a template JSON that
// Elementor's "Import Templates" accepts (Templates → Saved Templates → Import).
// Each top-level section of the page becomes a full-width Container holding an
// HTML widget with that section's markup; the page's CSS travels in a leading
// container. Assets stay absolute URLs. This is a faithful *reproduction* of the
// page inside Elementor — not a conversion into native Elementor widgets.
// (Format only; no Elementor (GPL) code is used.)

import { MODEL_VIEWER_SRC } from "../shared/model-viewer";
import { splitBlocks } from "./variants";

export interface ElementorTemplate {
  content: ElementorElement[];
  page_settings: Record<string, unknown>;
  version: string;
  title: string;
  type: string;
}
export interface ElementorElement {
  id: string;
  elType: "container" | "widget";
  isInner?: boolean;
  settings: Record<string, unknown>;
  elements: ElementorElement[];
  widgetType?: string;
}

let seq = 0;
function eid(): string {
  seq = (seq + 1) % 0xffffff;
  return ((Date.now() ^ (seq * 2654435761)) >>> 0).toString(16).padStart(7, "0").slice(-7);
}

export function htmlWidget(html: string): ElementorElement {
  return { id: eid(), elType: "widget", widgetType: "html", settings: { html }, elements: [] };
}
export function container(children: ElementorElement[], extra: Record<string, unknown> = {}): ElementorElement {
  return {
    id: eid(),
    elType: "container",
    isInner: false,
    settings: { content_width: "full", flex_direction: "column", padding: { unit: "px", top: "0", right: "0", bottom: "0", left: "0", isLinked: true }, ...extra },
    elements: children,
  };
}

/** Descend through single-child wrapper nodes (framework roots) to the element whose children are the page sections. */
export function findSectionsRoot(body: Element): Element {
  const isContent = (n: Element) => !/^(script|style|noscript|template|link|meta)$/i.test(n.tagName);
  let root = body;
  for (let i = 0; i < 8; i++) {
    const kids = Array.from(root.children).filter(isContent);
    if (kids.length !== 1) break;
    const k = kids[0];
    if (!/^(div|main|section|article|body)$/i.test(k.tagName)) break;
    root = k;
  }
  return root;
}

// ── scoping: a section dropped into an existing WordPress page must not restyle the
// theme around it. Page-level selectors (html, body, :root) map onto a wrapper class
// and every other rule is prefixed with it; keyframes / font faces stay global.
const KEEP_AT = /^@(keyframes|-webkit-keyframes|font-face|property|counter-style|page|import|charset|font-feature-values|namespace)\b/i;
const NEST_AT = /^@(media|supports|container|layer|document|scope)\b/i;
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) { cur += ch; if (ch === "\\") { cur += list[++i] ?? ""; } else if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function scopeSelector(sel: string, scope: string): string {
  let rest = sel, quals = "", page = false;
  for (;;) {
    const m = /^(?::root|html|body)((?:[.#:[][^\s>+~]*)?)(\s*>\s*|\s+|$)/i.exec(rest);
    if (!m) break;
    page = true;
    quals += m[1];
    rest = rest.slice(m[0].length);
  }
  if (page) return rest ? `.${scope}${quals} ${rest}` : `.${scope}${quals}`;
  return `.${scope} ${sel}`;
}
export function scopeCss(css: string, scope: string): string {
  const out: string[] = [];
  for (const b of splitBlocks(css)) {
    if (b.prelude.startsWith("@")) {
      if (!b.body && !NEST_AT.test(b.prelude)) out.push(`${b.prelude};`);
      else if (KEEP_AT.test(b.prelude) || !NEST_AT.test(b.prelude)) out.push(`${b.prelude}{${b.body}}`);
      else if (/^@layer\b/i.test(b.prelude) && !b.body.trim()) out.push(`${b.prelude};`);
      else out.push(`${b.prelude}{${scopeCss(b.body, scope)}}`);
      continue;
    }
    const sels = splitSelectors(b.prelude).map((s) => scopeSelector(s, scope));
    if (sels.length) out.push(`${sels.join(", ")}{${b.body}}`);
  }
  return out.join("\n");
}

export interface SectionInfo {
  index: number;
  label: string;
}
function sectionsOf(doc: Document): Element[] {
  const root = findSectionsRoot(doc.body);
  return Array.from(root.children).filter((n) => !/^(script|style|noscript|template|link|meta)$/i.test(n.tagName));
}
/** The page's top-level sections, named the way a person would recognise them. */
export function listSections(html: string): SectionInfo[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sectionsOf(doc).map((s, index) => {
    const named = s.getAttribute("data-framer-name") || s.getAttribute("aria-label") || s.id || "";
    const heading = s.querySelector("h1, h2, h3, h4");
    const text = (heading?.textContent || s.textContent || "").replace(/\s+/g, " ").trim();
    const role = /^(header|nav|footer)$/i.test(s.tagName) ? s.tagName.toLowerCase() : "";
    const label = [named, text.slice(0, 48)].filter(Boolean).join(" · ") || role || `Section ${index + 1}`;
    return { index, label: (role && !named ? `${role} · ` : "") + label };
  });
}

export interface ElementorBuildOptions {
  /** indexes from listSections(); all sections when omitted */
  only?: number[];
  /** scope the page CSS to the imported sections (for dropping them into an existing page) */
  scoped?: boolean;
}

export function buildElementorTemplate(html: string, title: string, opts: ElementorBuildOptions = {}): ElementorTemplate {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // page CSS: every <style> + remaining <link rel=stylesheet>
  let css = "";
  for (const st of Array.from(doc.querySelectorAll("style"))) css += (st.textContent || "") + "\n";
  const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))
    .map((l) => `<link rel="stylesheet" href="${l.getAttribute("href")}">`)
    .join("\n");
  const fonts = Array.from(doc.querySelectorAll('link[rel="preconnect"], link[rel="icon"]'))
    .map((l) => l.outerHTML)
    .join("\n");
  const body = doc.body;
  const all = sectionsOf(doc);
  const sections = opts.only ? all.filter((_, i) => opts.only!.includes(i)) : all;
  // scoped: a wrapper carries the page's own html/body classes and custom properties
  let wrapOpen = "", wrapClose = "";
  if (opts.scoped) {
    const scope = `sl-scope-${(Date.now() ^ (Math.random() * 1e9)).toString(36).replace(/[^a-z0-9]/g, "").slice(-6)}`;
    css = scopeCss(css, scope);
    const cls = [scope, doc.documentElement.getAttribute("class") || "", body.getAttribute("class") || ""].join(" ").replace(/\s+/g, " ").trim();
    const vars = [doc.documentElement.getAttribute("style") || "", body.getAttribute("style") || ""]
      .join(";").split(";").map((d) => d.trim()).filter((d) => d.startsWith("--")).join("; ");
    wrapOpen = `<div class="${cls.replace(/"/g, "&quot;")}"${vars ? ` style="${vars.replace(/"/g, "&quot;")}"` : ""}>`;
    wrapClose = "</div>";
  }
  const content: ElementorElement[] = [];
  const head = `${fonts}\n${links}\n<style>\n${css.trim()}\n</style>`.trim();
  if (head) content.push(container([htmlWidget(head)], { _title: "Page styles (StyleLift)" }));
  if (sections.length) {
    for (const s of sections) content.push(container([htmlWidget(wrapOpen + s.outerHTML + wrapClose)]));
  } else {
    content.push(container([htmlWidget(wrapOpen + body.innerHTML + wrapClose)]));
  }
  // StyleLift's own small scripts: the trigger that plays entrances as they scroll into view (the site's
  // recorded ones and those added in Studio) and the Lottie / Rive loader. Elementor's HTML widget runs
  // scripts; they go last, after the content they look for. Without them the animations play on load.
  const runtimes = Array.from(doc.querySelectorAll("script[data-sl-motion-runtime], script[data-sl-anim-runtime]"))
    .filter((sc) => (sc.textContent || "").trim())
    .map((sc) => `<script ${sc.hasAttribute("data-sl-motion-runtime") ? "data-sl-motion-runtime" : "data-sl-anim-runtime"}>${sc.textContent}</script>`)
    .join("\n");
  // your own 3D models (Studio): Google's model-viewer (Apache-2.0), from its CDN
  const viewer = doc.querySelector("model-viewer[data-sl-model]") ? `<script type="module" src="${MODEL_VIEWER_SRC}"></script>` : "";
  if (runtimes || viewer) content.push(container([htmlWidget([viewer, runtimes].filter(Boolean).join("\n"))], { _title: "Animations (StyleLift)" }));
  return { content, page_settings: {}, version: "0.4", title: title || "StyleLift capture", type: opts.only ? "section" : "page" };
}
