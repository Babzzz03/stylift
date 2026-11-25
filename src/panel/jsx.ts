// HTML → JSX (React) converter used by the React (Vite) and Next.js exports.
// Runs in the panel (DOMParser available) and in node tests (jsdom).
//
// Goals, each driven by a real site that broke an earlier version:
//  • output always compiles: attribute values with quotes/backslashes/newlines
//    become {"…"} expressions (JSON in data-* attrs on GitHub/Framer/Wikipedia),
//    invalid attribute names (Vue/Alpine @click, :class, [x]) are dropped;
//  • SVG keeps its case (clipPath, linearGradient, viewBox) and its React prop
//    names (strokeWidth, xlinkHref);
//  • unknown hyphenated attributes (Angular _ngcontent-*, custom elements) are
//    kept verbatim so attribute selectors in the CSS still match;
//  • form state uses defaultValue/defaultChecked (no read-only warnings);
//  • inline styles are parsed respecting quotes/parens (data: URIs contain ';'),
//    vendor prefixes map to React's names, !important moves to a CSS rule;
//  • whitespace between inline elements is preserved, <pre> is verbatim;
//  • shadow roots (<template shadowrootmode>) are re-attached by a tiny runtime.

const HTML_ATTR: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly",
  maxlength: "maxLength", minlength: "minLength", colspan: "colSpan", rowspan: "rowSpan",
  contenteditable: "contentEditable", crossorigin: "crossOrigin", autocomplete: "autoComplete",
  autofocus: "autoFocus", autoplay: "autoPlay", playsinline: "playsInline", enctype: "encType",
  novalidate: "noValidate", srcset: "srcSet", srcdoc: "srcDoc", "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv", allowfullscreen: "allowFullScreen", frameborder: "frameBorder",
  referrerpolicy: "referrerPolicy", fetchpriority: "fetchPriority", datetime: "dateTime",
  spellcheck: "spellCheck", enterkeyhint: "enterKeyHint", inputmode: "inputMode", itemprop: "itemProp",
  itemscope: "itemScope", itemtype: "itemType", itemid: "itemID", itemref: "itemRef",
  cellpadding: "cellPadding", cellspacing: "cellSpacing", usemap: "useMap", formaction: "formAction",
  formenctype: "formEncType", formmethod: "formMethod", formnovalidate: "formNoValidate",
  formtarget: "formTarget", hreflang: "hrefLang", marginheight: "marginHeight", marginwidth: "marginWidth",
  nomodule: "noModule", charset: "charSet", accesskey: "accessKey", controlslist: "controlsList",
  disablepictureinpicture: "disablePictureInPicture", disableremoteplayback: "disableRemotePlayback",
  imagesizes: "imageSizes", imagesrcset: "imageSrcSet", popovertarget: "popoverTarget",
  popovertargetaction: "popoverTargetAction", srclang: "srcLang", mediagroup: "mediaGroup",
  radiogroup: "radioGroup", allowtransparency: "allowTransparency", classid: "classID",
  contextmenu: "contextMenu", dirname: "dirName", autocapitalize: "autoCapitalize",
  autocorrect: "autoCorrect", autosave: "autoSave",
};
// lowercased camel-only props a site authored by mistake (e.g. clipPath on an
// HTML element). The browser ignores them, so dropping keeps the rendering
// identical and avoids React's "Invalid DOM property" warning.
const IGNORED_ATTR = new Set(["clippath", "classname", "htmlfor", "viewbox_", "strokewidth", "fillrule", "cliprule", "stopcolor"]);
const BOOLEAN = new Set([
  "allowFullScreen", "async", "autoFocus", "autoPlay", "checked", "controls", "default", "defer",
  "disabled", "disablePictureInPicture", "disableRemotePlayback", "formNoValidate", "hidden", "inert",
  "itemScope", "loop", "multiple", "muted", "noModule", "noValidate", "open", "playsInline", "readOnly",
  "required", "reversed", "selected", "defaultChecked", "seamless", "allowTransparency",
]);
// SVG presentation / XML attributes React wants in camelCase
const SVG_ATTR: Record<string, string> = {
  "xlink:href": "xlinkHref", "xlink:title": "xlinkTitle", "xlink:show": "xlinkShow",
  "xlink:role": "xlinkRole", "xlink:arcrole": "xlinkArcrole", "xlink:actuate": "xlinkActuate",
  "xlink:type": "xlinkType", "xml:lang": "xmlLang", "xml:space": "xmlSpace", "xml:base": "xmlBase",
  "xmlns:xlink": "xmlnsXlink",
};
const SVG_HYPHENATED = new Set([
  "accent-height", "alignment-baseline", "arabic-form", "baseline-shift", "cap-height", "clip-path",
  "clip-rule", "color-interpolation", "color-interpolation-filters", "color-profile", "color-rendering",
  "dominant-baseline", "enable-background", "fill-opacity", "fill-rule", "flood-color", "flood-opacity",
  "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant",
  "font-weight", "glyph-name", "glyph-orientation-horizontal", "glyph-orientation-vertical",
  "horiz-adv-x", "horiz-origin-x", "image-rendering", "letter-spacing", "lighting-color",
  "marker-end", "marker-mid", "marker-start", "overline-position", "overline-thickness", "paint-order",
  "panose-1", "pointer-events", "rendering-intent", "shape-rendering", "stop-color", "stop-opacity",
  "strikethrough-position", "strikethrough-thickness", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width",
  "text-anchor", "text-decoration", "text-rendering", "transform-origin", "underline-position",
  "underline-thickness", "unicode-bidi", "unicode-range", "units-per-em", "v-alphabetic", "v-hanging",
  "v-ideographic", "v-mathematical", "vector-effect", "vert-adv-y", "vert-origin-x", "vert-origin-y",
  "word-spacing", "writing-mode", "x-height",
]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["script", "noscript", "style", "link", "meta", "base", "title"]);
const PRE_TAGS = new Set(["pre", "textarea", "listing", "xmp", "plaintext"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const VALID_JSX_ATTR = /^[A-Za-z_][\w-]*$/;

const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

export interface JsxContext {
  needsRuntime: boolean; // shadow-root helper used
  importantCss: string[]; // rules for inline !important declarations
  importantSeq: number;
}
export const newJsxContext = (): JsxContext => ({ needsRuntime: false, importantCss: [], importantSeq: 0 });

// ── attribute helpers ─────────────────────────────────────────────────────────
function attrValue(v: string): string {
  return /["\\\n\r]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`;
}
function reactAttrName(name: string, isSvg: boolean): string | null {
  const lower = name.toLowerCase();
  if (/^on/.test(lower)) return null; // inline handlers are never carried over
  if (lower.startsWith("data-") || lower.startsWith("aria-")) return VALID_JSX_ATTR.test(name) ? name : null;
  if (IGNORED_ATTR.has(lower) && !(isSvg && name !== lower)) return null;
  if (SVG_ATTR[lower]) return SVG_ATTR[lower];
  if (HTML_ATTR[lower]) return HTML_ATTR[lower];
  if (isSvg && SVG_HYPHENATED.has(lower)) return camel(lower);
  if (lower === "style") return "style";
  // keep anything else verbatim when JSX can express it (custom-element attrs,
  // Angular _ngcontent-*, Vue data-v-* already handled) — CSS selectors match it
  return VALID_JSX_ATTR.test(name) ? name : null;
}

// ── inline style → React style object ─────────────────────────────────────────
function splitDecls(style: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function styleKey(prop: string): string {
  if (prop.startsWith("--")) return JSON.stringify(prop);
  if (prop.startsWith("-ms-")) return camel(prop.slice(1));
  const k = camel(prop);
  // React expects Webkit*/Moz*/O* capitalised; some sites write "webkit-…" without the dash
  return /^(webkit|moz)[A-Z]/.test(k) ? k[0].toUpperCase() + k.slice(1) : k;
}
function styleToJsx(style: string, ctx: JsxContext): { jsx: string; importantAttr?: string } {
  const entries: string[] = [];
  const important: string[] = [];
  for (const decl of splitDecls(style)) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    let val = decl.slice(i + 1).trim();
    if (!prop || !val) continue;
    const isImportant = /!\s*important\s*$/i.test(val);
    if (isImportant) {
      important.push(`${prop.toLowerCase()}: ${val}`);
      continue;
    }
    val = val.replace(/\s+/g, " ");
    entries.push(`${styleKey(prop.startsWith("--") ? prop : prop.toLowerCase())}: ${JSON.stringify(val)}`);
  }
  let importantAttr: string | undefined;
  if (important.length) {
    importantAttr = `s${++ctx.importantSeq}`;
    ctx.importantCss.push(`[data-sl-important="${importantAttr}"] { ${important.join("; ")}; }`);
  }
  return { jsx: entries.length ? `{{ ${entries.join(", ")} }}` : "", importantAttr };
}

// ── text ──────────────────────────────────────────────────────────────────────
function jsxText(t: string): string {
  // JSX text can't contain { } < > and interprets &entities; use a string literal then
  return /[{}<>&]/.test(t) ? `{${JSON.stringify(t)}}` : t;
}

// ── conversion ────────────────────────────────────────────────────────────────
function tagOf(el: Element): string {
  return el.namespaceURI === SVG_NS || el.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? el.localName : el.localName.toLowerCase();
}

export function convertNode(node: Node, indent: string, ctx: JsxContext, inPre = false): string {
  if (node.nodeType === 3) {
    const raw = node.textContent || "";
    if (inPre) return raw ? `${indent}{${JSON.stringify(raw)}}\n` : "";
    const collapsed = raw.replace(/\s+/g, " ");
    if (collapsed === " ") {
      // whitespace-only node: keep one space if it separates two pieces of content
      return node.previousSibling && node.nextSibling ? `${indent}{" "}\n` : "";
    }
    const lead = collapsed.startsWith(" ") && node.previousSibling ? `{" "}` : "";
    const trail = collapsed.endsWith(" ") && node.nextSibling ? `{" "}` : "";
    const body = collapsed.trim();
    return body ? `${indent}${lead}${jsxText(body)}${trail}\n` : "";
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return "";
  if (tag === "template" && el.hasAttribute("shadowrootmode")) return ""; // consumed by its host
  const isSvg = el.namespaceURI === SVG_NS;

  const attrs: string[] = [];
  let styleAttr = "";
  for (const a of Array.from(el.attributes)) {
    if (a.name === "style") {
      styleAttr = a.value;
      continue;
    }
    let name = reactAttrName(a.name, isSvg);
    if (!name) continue;
    let value = a.value;
    // form state → uncontrolled defaults
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (name === "value" && !/^(hidden|submit|button|reset|image)$/.test(type)) name = "defaultValue";
      if (name === "checked") name = "defaultChecked";
    }
    if (tag === "option" && name === "selected") continue; // moved to <select defaultValue>
    if (BOOLEAN.has(name) && (value === "" || value.toLowerCase() === name.toLowerCase() || value === "true")) {
      attrs.push(name);
      continue;
    }
    attrs.push(`${name}=${attrValue(value)}`);
  }
  if (styleAttr) {
    const { jsx, importantAttr } = styleToJsx(styleAttr, ctx);
    if (jsx) attrs.push(`style=${jsx}`);
    if (importantAttr) attrs.push(`data-sl-important="${importantAttr}"`);
  }
  if (tag === "select") {
    const opts = Array.from(el.querySelectorAll("option"));
    const sel = opts.filter((o) => o.hasAttribute("selected"));
    const val = (o: Element) => o.getAttribute("value") ?? (o.textContent || "").trim();
    if (el.hasAttribute("multiple") && sel.length) attrs.push(`defaultValue={${JSON.stringify(sel.map(val))}}`);
    else if (sel.length) attrs.push(`defaultValue=${attrValue(val(sel[0]))}`);
  }
  if (tag === "textarea") {
    const v = el.textContent || "";
    if (v) attrs.push(`defaultValue=${attrValue(v)}`);
  }
  // declarative shadow DOM → runtime ref
  const shadowTpl = Array.from(el.children).find((c) => c.localName === "template" && c.hasAttribute("shadowrootmode")) as HTMLTemplateElement | undefined;
  if (shadowTpl) {
    ctx.needsRuntime = true;
    const mode = shadowTpl.getAttribute("shadowrootmode") === "closed" ? "closed" : "open";
    attrs.push(`ref={shadow(${JSON.stringify(shadowTpl.innerHTML)}, ${JSON.stringify(mode)})}`);
  }
  const attrStr = attrs.length ? " " + attrs.join(" ") : "";

  if (VOID.has(tag) && !isSvg) return `${indent}<${tag}${attrStr} />\n`;
  if (tag === "textarea") return `${indent}<textarea${attrStr} />\n`;

  const pre = inPre || PRE_TAGS.has(tag);
  const childIndent = indent + "  ";
  let children = "";
  for (const child of Array.from(el.childNodes)) children += convertNode(child, childIndent, ctx, pre);
  if (!children.trim()) return `${indent}<${tag}${attrStr} />\n`;
  return `${indent}<${tag}${attrStr}>\n${children}${indent}</${tag}>\n`;
}

/** Convert a fragment of HTML into a JSX fragment body (no component wrapper). */
export function htmlFragmentToJsx(html: string, indent: string, ctx: JsxContext): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  let out = "";
  for (const child of Array.from(doc.body.childNodes)) out += convertNode(child, indent, ctx);
  return out;
}

/** Small runtime the generated code imports when it needs shadow roots. */
export const JSX_RUNTIME = `// StyleLift runtime: re-attaches shadow roots that React can't render as markup.
export function shadow(html, mode = "open") {
  return (el) => {
    if (!el || el.shadowRoot) return;
    try {
      const root = el.attachShadow({ mode });
      if (typeof root.setHTMLUnsafe === "function") root.setHTMLUnsafe(html);
      else root.innerHTML = html;
    } catch {
      /* element can't host a shadow root */
    }
  };
}
`;

/** Single-component conversion (the panel's ".jsx" export and older callers). */
export function htmlToJsx(html: string, componentName = "ExportedPage"): string {
  const ctx = newJsxContext();
  const body = htmlFragmentToJsx(html, "      ", ctx) || "      <div />\n";
  const imports = ctx.needsRuntime ? `import { shadow } from "./sl-runtime";\n\n` : "";
  const important = ctx.importantCss.length
    ? `\n/* inline !important declarations (React style objects can't express them):\n${ctx.importantCss.join("\n")}\n*/\n`
    : "";
  return `${imports}export default function ${componentName}() {
  return (
    <>
${body}    </>
  );
}
${important}`;
}
