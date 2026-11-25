// React (Vite) and Next.js (App Router) project builders.
//
// Instead of one giant App.jsx, the page is split into real, named components:
//   • the "sections root" is found by descending through single-child wrappers
//     (#__next, #root, Framer's #main…);
//   • each top-level section becomes a component file, named from what the page
//     itself calls it — Framer layer names (data-framer-name), aria-label, id,
//     landmark tag (header/nav/footer), or its first heading;
//   • a section that holds most of the page is split one level further;
//   • the wrapper chain is kept in the page file so every CSS selector still matches.
// Assets go to public/assets/{images,fonts,media,js}, CSS to one global sheet.

import { MODEL_VIEWER_SRC, extractModels, hasModels } from "../shared/model-viewer";
import { prettifyCode } from "../shared/format-code";
import { convertNode, newJsxContext, JSX_RUNTIME, type JsxContext } from "./jsx";
import { absUrl, collectCss, makeCollector, missingAssets, noteMissing, rewriteElementAssets, type FileMap, type ProjectResolvers } from "./project";

const NON_CONTENT = /^(script|style|noscript|template|link|meta|title|base)$/i;

export interface ComponentPlan {
  name: string;
  el: Element;
}
interface PlanNode {
  kind: "wrapper" | "component" | "inline";
  el: Element;
  name?: string;
  children?: PlanNode[];
}

// ── naming ────────────────────────────────────────────────────────────────────
const RESERVED = new Set(["Page", "App", "Layout", "RootLayout", "React", "Fragment", "Component", "Image", "Link", "Head", "Script"]);
function pascal(s: string): string {
  const words = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  let out = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  if (!out) return "";
  if (/^\d/.test(out)) out = "S" + out;
  return out.slice(0, 40);
}
function isHashy(token: string): boolean {
  // generated class names: framer-1abc2d, css-x9y8, sc-AxjAm, _a1b2c3, hash-like tokens
  return (
    /^(framer|css|sc|jsx|emotion|svelte|astro|chakra|mui|tw|styles?)-/i.test(token) ||
    /\d/.test(token.replace(/^h[1-6]$/, "")) && token.length > 4 ||
    /^_/.test(token) ||
    token.length < 3
  );
}
// Utility-class vocabularies (Tailwind, Bootstrap, Webflow, Framer helpers) say how
// something looks, not what it is, so they never become component names.
const UTILITY_HEADS = new Set(("items justify content self place align border bg text font flex grid gap p px py pt pb pl pr ps pe m mx my mt mb ml mr ms me w h min max " +
  "rounded shadow before after isolate relative absolute fixed sticky static overflow z inset top left right bottom opacity transition duration " +
  "ease delay col row space divide ring outline cursor select pointer sr not group peer dark sm md lg xl 2xl hover focus active container block " +
  "inline hidden visible invisible table contents order leading tracking whitespace break truncate underline uppercase lowercase capitalize " +
  "italic antialiased aspect object fill stroke scroll snap touch will mask backdrop blur filter mix transform translate scale rotate skew " +
  "origin animate size columns list decoration indent line hyphens d g mb-0 shrink grow basis float clear box sm: md: lg: xl: is has js wf w " +
  "ssr wrapper section row col clearfix sr-only visually").split(/\s+/));
function isUtilityClass(c: string): boolean {
  if (/[:[\]/.!#%@]/.test(c) || /\d/.test(c)) return true;
  const head = c.toLowerCase().split(/[-_]/)[0];
  return UTILITY_HEADS.has(head) || c.length <= 3;
}
const STOPWORDS = new Set("a an the of for by and or to in on at with your our my their its is are be this that from as it you we".split(" "));
/** "Built for the modern web" → "Built modern web" (filler words dropped, 3 kept). */
function phrase(text: string): string {
  // code-like tokens (text-4xl, h-12, v4.3) describe markup, not content
  const words = text
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => /\p{L}{2,}/u.test(w) && !/\d/.test(w) && !/-/.test(w));
  const kept = words.filter((w, i) => i === 0 || !STOPWORDS.has(w.toLowerCase()));
  return kept.slice(0, 3).join(" ");
}
function roleName(el: Element, index: number, total: number): string {
  const links = el.querySelectorAll("a[href]").length;
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (el.querySelector(":scope > nav, :scope > * > nav, [role='navigation']") || (index === 0 && links >= 4 && text.length < 400)) return index === 0 ? "Header" : "Navigation";
  if (el.querySelector("input[type='email']")) return "Newsletter";
  if (index >= total - 2 && (/©|\(c\)|copyright|all rights reserved/i.test(text) || links >= 8)) return "Footer";
  return "";
}
// Framer variant names describe a *state* of a component, not what it is.
const VARIANT_NAME = /^(Desktop|Tablet|Phone|Mobile|Default|Primary|Secondary|Light|Dark|Hover|Pressed|Active|Inactive|Open|Closed|Base|Variant\d*|Main|Container|Wrapper|Frame\d*|Stack\d*)$/;
function nameFor(el: Element, index: number, total = 99): string {
  const tag = el.localName.toLowerCase();
  const tries: string[] = [];
  const attr = (n: string) => (el.getAttribute(n) || "").trim();
  const own = attr("data-framer-name");
  if (own && VARIANT_NAME.test(pascal(own))) tries.push(roleName(el, index, total));
  tries.push(own, attr("aria-label"), attr("data-section"), attr("data-name"));
  const innerLayer = el.querySelector(":scope > [data-framer-name], :scope > * > [data-framer-name]");
  if (innerLayer) tries.push(innerLayer.getAttribute("data-framer-name") || "");
  const id = attr("id").replace(/^[_-]+/, "");
  if (id && !isHashy(id) && !/^(next|root|main|app|page)$/i.test(id)) tries.push(id);
  if (/^(header|nav|footer|aside)$/.test(tag)) tries.push(tag === "nav" ? "Navigation" : tag);
  const heading = el.querySelector("h1, h2, h3, h4");
  if (heading) tries.push(phrase(heading.textContent || ""));
  tries.push(roleName(el, index, total));
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) tries.push(phrase(el.ownerDocument.getElementById(labelled.split(/\s+/)[0])?.textContent || ""));
  const cls = Array.from(el.classList).find((c) => !isHashy(c) && !isUtilityClass(c));
  if (cls) tries.push(cls);
  const lead = phrase((el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80));
  if (lead.split(" ").length >= 2) tries.push(lead);
  const alt = el.querySelector("img[alt]:not([alt=''])")?.getAttribute("alt");
  if (alt) tries.push(phrase(alt));
  for (const t of tries) {
    const n = pascal(t);
    if (n && !RESERVED.has(n) && !VARIANT_NAME.test(n)) return n;
  }
  return `Section${String(index + 1).padStart(2, "0")}`;
}

// ── planning ──────────────────────────────────────────────────────────────────
const contentChildren = (el: Element) => Array.from(el.children).filter((c) => !NON_CONTENT.test(c.localName));
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Descend through single-child wrappers (#__next, #root, Framer #main…). */
function sectionsRoot(body: Element): { root: Element; wrappers: Element[] } {
  const wrappers: Element[] = [];
  let root = body;
  for (let i = 0; i < 10; i++) {
    const kids = contentChildren(root);
    if (kids.length !== 1) break;
    const k = kids[0];
    if (k.namespaceURI !== HTML_NS || /^(svg|img|video|canvas|picture|iframe)$/i.test(k.localName)) break;
    wrappers.push(k);
    root = k;
  }
  return { root, wrappers };
}

/** Framer renders one copy of the page per breakpoint (.ssr-variant + hidden-<hash>
 *  classes). Label each copy Desktop / Tablet / Phone from the page's breakpoints. */
function variantLabel(el: Element, breakpoints: Map<string, string>): string | null {
  if (!el.classList.contains("ssr-variant")) return null;
  // only real alternatives get a folder: ≥2 sibling copies of this part of the page
  const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.classList.contains("ssr-variant")) : [];
  if (siblings.length < 2) return null;
  const hiddenOf = (e: Element) => Array.from(e.classList).filter((c) => c.startsWith("hidden-")).map((c) => c.slice(7));
  const relevant = new Set(siblings.flatMap(hiddenOf)); // breakpoints this group switches between
  const hidden = hiddenOf(el);
  const visible = Array.from(breakpoints.entries()).filter(([h]) => relevant.has(h) && !hidden.includes(h)).map(([, mq]) => mq);
  const label = (mq: string) => {
    const min = /min-width:\s*(\d+)/.exec(mq), max = /max-width:\s*(\d+)/.exec(mq);
    if (min && !max) return Number(min[1]) >= 1100 ? "desktop" : "tablet";
    if (max && !min) return Number(max[1]) <= 820 ? "phone" : "tablet";
    if (min && max) return Number(max[1]) <= 820 ? "phone" : "tablet";
    return "";
  };
  const labels = Array.from(new Set(visible.map(label).filter(Boolean)));
  return labels.length === 1 ? labels[0] : labels.length ? labels.join("-") : null;
}
function framerBreakpoints(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  const raw = doc.querySelector("[data-framer-hydrate-v2]")?.getAttribute("data-framer-hydrate-v2");
  try {
    for (const b of (raw ? JSON.parse(raw).breakpoints : []) || []) if (b.hash && b.mediaQuery) map.set(b.hash, b.mediaQuery);
  } catch {
    /* not Framer */
  }
  return map;
}

export interface PlanComponent extends ComponentPlan {
  folder: string; // "" or "desktop" / "tablet" / "phone"
  ident: string; // import identifier, unique within the page
}
export function planComponents(body: Element): { tree: PlanNode[]; wrappers: Element[]; components: PlanComponent[] } {
  const { root, wrappers } = sectionsRoot(body);
  const total = Math.max(1, root.innerHTML.length);
  const BIG = Math.max(40_000, total * 0.25);
  const breakpoints = framerBreakpoints(body.ownerDocument);
  const totalTop = contentChildren(root).length;
  const components: PlanComponent[] = [];
  const usedIdent = new Set<string>();
  const usedFile = new Map<string, Set<string>>();
  let idx = 0;
  const tinyOrEmpty = (el: Element) =>
    el.outerHTML.length < 600 && !el.querySelector("img, svg, video, picture, canvas, iframe, template") && !(el.textContent || "").trim();
  const leaf = (el: Element, folder: string): PlanNode => {
    if (tinyOrEmpty(el)) return { kind: "inline", el };
    let name = nameFor(el, idx++, totalTop);
    const files = usedFile.get(folder) || new Set<string>();
    usedFile.set(folder, files);
    let n = name, i = 2;
    while (files.has(n)) n = `${name}${i++}`;
    files.add(n);
    let ident = folder ? pascal(folder) + n : n;
    let j = 2;
    while (usedIdent.has(ident)) ident = `${folder ? pascal(folder) : ""}${n}${j++}`;
    usedIdent.add(ident);
    components.push({ name: n, el, folder, ident });
    return { kind: "component", el, name: ident };
  };
  const build = (el: Element, depth: number, folder: string): PlanNode => {
    const variant = variantLabel(el, breakpoints);
    const f = variant || folder;
    const big = el.outerHTML.length > BIG || !!variant;
    if (!big || depth > 5 || el.namespaceURI !== HTML_NS) return leaf(el, f);
    // descend through a single-child chain, then split at the first fan-out
    const kids = contentChildren(el);
    if (kids.length === 0) return leaf(el, f);
    return { kind: "wrapper", el, children: kids.map((k) => build(k, depth + 1, f)) };
  };
  const top = contentChildren(root);
  const tree = top.map((el) => build(el, 0, ""));
  return { tree, wrappers: [...wrappers], components };
}

// ── JSX emission ──────────────────────────────────────────────────────────────
/** Opening/closing JSX for an element WITHOUT its children (wrapper chain). */
function openClose(el: Element, ctx: JsxContext): { open: string; close: string } {
  const clone = el.cloneNode(false) as Element;
  const jsx = convertNode(clone, "", ctx).trim(); // "<div …/>" (self-closed: no children)
  const open = jsx.replace(/\s*\/>$/, ">");
  return { open, close: `</${el.namespaceURI === "http://www.w3.org/2000/svg" ? el.localName : el.localName.toLowerCase()}>` };
}
function emitTree(nodes: PlanNode[], indent: string, ctx: JsxContext): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "component") out += `${indent}<${n.name} />\n`;
    else if (n.kind === "inline") out += convertNode(n.el, indent, ctx);
    else {
      const { open, close } = openClose(n.el, ctx);
      out += `${indent}${open}\n${emitTree(n.children || [], indent + "  ", ctx)}${indent}${close}\n`;
    }
  }
  return out;
}
function wrapChain(wrappers: Element[], inner: string, indent: string, ctx: JsxContext): string {
  // wrappers[0] is outermost
  let out = inner;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const pad = indent + "  ".repeat(i);
    const { open, close } = openClose(wrappers[i], ctx);
    out = `${pad}${open}\n${out}${pad}${close}\n`;
  }
  return out;
}

interface ComponentFile {
  name: string;
  ident: string;
  folder: string;
  code: string;
  client: boolean;
}
function componentFiles(components: PlanComponent[], runtimeImport: string, clientDirective: boolean, importantCss: string[]): ComponentFile[] {
  return components.map(({ name, el, folder, ident }) => {
    const ctx = newJsxContext();
    ctx.importantSeq = importantCss.length; // keep data-sl-important ids unique across files
    const body = convertNode(el, "    ", ctx);
    importantCss.push(...ctx.importantCss);
    const client = ctx.needsRuntime;
    const head = (client && clientDirective ? `"use client";\n\n` : "") + (client ? `import { shadow } from "${runtimeImport}";\n\n` : "");
    return { name, ident, folder, client, code: `${head}export default function ${ident}() {\n  return (\n${body}  );\n}\n` };
  });
}
const compPath = (c: ComponentFile) => (c.folder ? `${c.folder}/${c.name}` : c.name);

// ── shared page analysis ──────────────────────────────────────────────────────
export interface AnalyzedPage {
  title: string;
  description: string;
  lang: string;
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  css: string;
  icons: { rel: string; href: string; type?: string; sizes?: string }[];
  plan: ReturnType<typeof planComponents>;
  doc: Document;
  /** the capture's Rive / Lottie loader (plain JS); empty when the page has none */
  animLoader: string;
  /** the page shows 3D models of the user's own (Studio): the viewer's script goes in the page head */
  models: boolean;
}
const attrMap = (el: Element | null) => {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const a of Array.from(el.attributes)) if (!/^on/i.test(a.name)) out[a.name] = a.value;
  return out;
};

/** Parse a captured page, localize every asset into `files`, plan its components. */
async function analyze(
  html: string,
  baseUrl: string,
  r: ProjectResolvers,
  collect: (url: string, base: string) => Promise<string | null>,
  cssRefPrefix: string,
  linkMapper: (href: string, base: string) => string,
  modelFiles?: FileMap,
): Promise<AnalyzedPage> {
  // your own 3D models (Studio): real files under public/, served from the root
  const models = hasModels(html);
  if (models) {
    const ex = extractModels(html, "public/", "/");
    html = ex.html;
    if (modelFiles) Object.assign(modelFiles, ex.files);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseEl = doc.querySelector("base[href]");
  const base = baseEl ? absUrl(baseEl.getAttribute("href") || "", baseUrl) : baseUrl;
  const icons: AnalyzedPage["icons"] = [];
  for (const l of Array.from(doc.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]'))) {
    const p = await collect(l.getAttribute("href") || "", base);
    if (p) icons.push({ rel: l.getAttribute("rel") || "icon", href: "/" + p.replace(/^public\//, ""), type: l.getAttribute("type") || undefined, sizes: l.getAttribute("sizes") || undefined });
  }
  const title = (doc.querySelector("title")?.textContent || "").trim();
  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content") || "";
  const css = await collectCss(doc, base, r, collect, cssRefPrefix);
  await rewriteElementAssets(doc, base, collect, "/");
  // asset paths come back as "public/assets/…": the web path drops "public"
  for (const el of Array.from(doc.querySelectorAll("[src], [srcset], [poster], [href], [style]"))) {
    for (const a of ["src", "poster", "href"]) {
      const v = el.getAttribute(a);
      if (v && v.startsWith("/public/")) el.setAttribute(a, v.slice("/public".length));
    }
    // a srcset kept with its image (same file, same descriptor) moves with it
    const set = el.getAttribute("srcset");
    if (set && set.includes("/public/assets/")) el.setAttribute("srcset", set.split("/public/assets/").join("/assets/"));
    const st = el.getAttribute("style");
    if (st && st.includes("/public/assets/")) el.setAttribute("style", st.split("/public/assets/").join("/assets/"));
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) a.setAttribute("href", linkMapper(a.getAttribute("href") || "", base));
  // hydration / build metadata that only the original runtime reads
  const breakpointsHolder = doc.querySelector("[data-framer-hydrate-v2]");
  const savedBreakpoints = breakpointsHolder?.getAttribute("data-framer-hydrate-v2") || null;
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const name of RUNTIME_ATTRS) if (el.hasAttribute(name)) el.removeAttribute(name);
  }
  const htmlEl = doc.documentElement;
  return {
    models,
    // StyleLift's own scripts: the Rive / Lottie loader and Studio's motion trigger
    animLoader: Array.from(doc.querySelectorAll("script[data-sl-anim-runtime], script[data-sl-motion-runtime]")).map((sc) => sc.textContent || "").filter(Boolean).join("\n"),
    title,
    description,
    lang: htmlEl.getAttribute("lang") || "en",
    htmlAttrs: attrMap(htmlEl),
    bodyAttrs: attrMap(doc.body),
    css: css.split("public/assets/").join("assets/"),
    icons,
    plan: (() => {
      // planning needs Framer's breakpoint map, which lives in the stripped attribute
      if (breakpointsHolder && savedBreakpoints) breakpointsHolder.setAttribute("data-framer-hydrate-v2", savedBreakpoints);
      const plan = planComponents(doc.body);
      breakpointsHolder?.removeAttribute("data-framer-hydrate-v2");
      return plan;
    })(),
    doc,
  };
}
const RUNTIME_ATTRS = [
  "data-framer-hydrate-v2", "data-framer-ssr-released-at", "data-framer-page-optimized-at", "data-framer-generated-page",
  "data-reactroot", "data-react-helmet", "data-n-head", "data-server-rendered", "data-hk", "data-sveltekit-hydrate",
];
const absoluteLinks = (href: string, base: string) => (/^(#|mailto:|tel:|javascript:)/i.test(href) ? href : absUrl(href, base));
const safeName = (host: string) => (host || "site").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "site";
const VERSIONS = { react: "^19.2.0", reactDom: "^19.2.0", next: "^16.0.0", vite: "^8.0.0", pluginReact: "^6.0.0" };
const GITIGNORE = "node_modules\n.next\nout\ndist\n.DS_Store\n";
const importantBlock = (rules: string[]) =>
  rules.length ? `\n/* StyleLift: inline !important declarations moved out of React style objects */\n${rules.join("\n")}\n` : "";

function htmlAttrString(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`))
    .join("");
}
function jsxAttrString(attrs: Record<string, string>, tag: string): string {
  const doc = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
  const el = doc.createElement(tag === "html" ? "div" : "span");
  for (const [k, v] of Object.entries(attrs)) {
    try {
      el.setAttribute(k, v);
    } catch {
      /* invalid name */
    }
  }
  const jsx = convertNode(el, "", newJsxContext()).trim();
  const m = jsx.match(/^<\w+([\s\S]*?)\s*\/>$/);
  return m ? m[1] : "";
}

// ── React (Vite) ──────────────────────────────────────────────────────────────
export async function buildReactViteProject(html: string, baseUrl: string, r: ProjectResolvers, host: string): Promise<FileMap> {
  const files: FileMap = {};
  const collect = makeCollector(files, r, "public/assets");
  const a = await analyze(html, baseUrl, r, collect, "/", absoluteLinks, files);
  const important: string[] = [];
  const comps = componentFiles(a.plan.components, "@@RUNTIME@@", false, important).map((c) => ({
    ...c,
    code: c.code.replace("@@RUNTIME@@", c.folder ? "../../sl-runtime" : "../sl-runtime"),
  }));
  const pageCtx = newJsxContext();
  const tree = emitTree(a.plan.tree, "      " + "  ".repeat(a.plan.wrappers.length), pageCtx);
  const body = wrapChain(a.plan.wrappers, tree, "      ", pageCtx);
  for (const c of comps) files[`src/components/${compPath(c)}.jsx`] = c.code;
  if (comps.some((c) => c.client)) files["src/sl-runtime.js"] = JSX_RUNTIME;
  files["src/App.jsx"] =
    comps.map((c) => `import ${c.ident} from "./components/${compPath(c)}";`).join("\n") +
    `\n\nexport default function App() {\n  return (\n    <>\n${body || "      <div />\n"}    </>\n  );\n}\n`;
  files["src/styles/global.css"] = a.css + importantBlock(important);
  if (a.animLoader) files["src/sl-animations.js"] = animModule(a.animLoader);
  files["src/main.jsx"] =
    `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./styles/global.css";\n` +
    (a.animLoader ? `import playAnimations from "./sl-animations";\n` : "") + `\n` +
    `// Rendered straight into <body> so the page keeps its original DOM shape\n// (body > header … selectors in the captured CSS keep matching).\n` +
    `createRoot(document.body).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n` +
    (a.animLoader ? `// the page's animations (Rive / Lottie from their files, Studio motion)\nrequestAnimationFrame(() => playAnimations());\n` : "");
  const iconTags = a.icons.map((i) => `    <link rel="${i.rel}" href="${i.href}"${i.type ? ` type="${i.type}"` : ""}${i.sizes ? ` sizes="${i.sizes}"` : ""} />\n`).join("");
  files["index.html"] =
    `<!doctype html>\n<html${htmlAttrString(a.htmlAttrs)}>\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
    `    <title>${escapeHtml(a.title || host)}</title>\n` +
    (a.description ? `    <meta name="description" content="${escapeAttr(a.description)}" />\n` : "") +
    iconTags +
    (a.models ? `    <!-- your 3D models: Google's model-viewer (Apache-2.0) -->\n    <script type="module" src="${MODEL_VIEWER_SRC}"></script>\n` : "") +
    `    <script type="module" src="/src/main.jsx"></script>\n  </head>\n  <body${htmlAttrString(a.bodyAttrs)}></body>\n</html>\n`;
  const name = safeName(host);
  files["package.json"] = JSON.stringify(
    {
      name: `${name}-react`,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: VERSIONS.react, "react-dom": VERSIONS.reactDom },
      devDependencies: { "@vitejs/plugin-react": VERSIONS.pluginReact, vite: VERSIONS.vite },
    },
    null,
    2,
  ) + "\n";
  files["vite.config.js"] = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`;
  files[".gitignore"] = GITIGNORE;
  files["README.md"] = readme(host, "React (Vite)", comps, [
    "index.html                 html/body attributes, title, favicon",
    "src/main.jsx               mounts <App /> into <body>",
    "src/App.jsx                page layout: wrapper elements + section components",
    "src/components/*.jsx       one file per page section",
    "src/styles/global.css      every style from the page (+ your StyleLift edits)",
    "public/assets/             images, fonts, media",
  ], "npm install\nnpm run dev      # http://localhost:5173\nnpm run build    # static build in dist/");
  noteMissingAssets(files);
  await prettifyCode(files); // laid out to be read (Prettier)
  return noteMissing(files);
}

// ── Next.js (App Router) ──────────────────────────────────────────────────────
function nextConfig(): string {
  return (
    `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n` +
    `  // Captured images are already optimised files; serve them as-is.\n  images: { unoptimized: true },\n` +
    `  // NEXT_OUTPUT=export npm run build  →  fully static site in out/\n  output: process.env.NEXT_OUTPUT === "export" ? "export" : undefined,\n};\n\nexport default nextConfig;\n`
  );
}
function nextPackage(name: string): string {
  return (
    JSON.stringify(
      {
        name: `${name}-next`,
        private: true,
        version: "0.1.0",
        scripts: { dev: "next dev", build: "next build", start: "next start", export: "NEXT_OUTPUT=export next build" },
        dependencies: { next: VERSIONS.next, react: VERSIONS.react, "react-dom": VERSIONS.reactDom },
      },
      null,
      2,
    ) + "\n"
  );
}
// The capture's animation loader as a module / client component for the projects.
function animModule(loader: string): string {
  return `// Plays the page's animations: Rive / Lottie from their original files (runtimes from a CDN,\n// MIT licensed; without a connection the captured still frame stays) and the motion added in\n// StyleLift Studio (scroll-into-view triggers, word-by-word text).\nexport default function playAnimations() {\n${loader}\n}\n`;
}
function animComponent(loader: string): string {
  return `"use client";\nimport { useEffect } from "react";\n\n// Plays the page's animations once it is on screen: Rive / Lottie from their original files and\n// the motion added in StyleLift Studio (scroll-into-view triggers, word-by-word text).\nexport default function SlAnimations() {\n  useEffect(() => {\n${loader}\n  }, []);\n  return null;\n}\n`;
}
function nextLayout(a: AnalyzedPage, cssImport: string | null): string {
  const meta: string[] = [];
  if (a.title) meta.push(`  title: ${JSON.stringify(a.title)},`);
  if (a.description) meta.push(`  description: ${JSON.stringify(a.description)},`);
  if (a.icons.length) meta.push(`  icons: ${JSON.stringify(a.icons.map((i) => ({ rel: i.rel, url: i.href, ...(i.type ? { type: i.type } : {}), ...(i.sizes ? { sizes: i.sizes } : {}) })))},`);
  return (
    (cssImport ? `import "${cssImport}";\n` : "") +
    (a.animLoader ? `import SlAnimations from "@/components/SlAnimations";\n` : "") + `\n` +
    `export const metadata = {\n${meta.join("\n")}\n};\n\n` +
    `export default function RootLayout({ children }) {\n  return (\n` +
    `    <html${jsxAttrString(a.htmlAttrs, "html")} suppressHydrationWarning>\n` +
    (a.models ? `      <head>\n        {/* your 3D models: Google's model-viewer (Apache-2.0) */}\n        <script type="module" src="${MODEL_VIEWER_SRC}" async />\n      </head>\n` : "") +
    `      <body${jsxAttrString(a.bodyAttrs, "body")} suppressHydrationWarning>{children}${a.animLoader ? "<SlAnimations />" : ""}</body>\n` +
    `    </html>\n  );\n}\n`
  );
}
function nextPage(a: AnalyzedPage, comps: ComponentFile[], compDir: string, metaOverride: boolean, cssImport?: string): string {
  const pageCtx = newJsxContext();
  const tree = emitTree(a.plan.tree, "      " + "  ".repeat(a.plan.wrappers.length), pageCtx);
  const body = wrapChain(a.plan.wrappers, tree, "      ", pageCtx);
  const meta = metaOverride && (a.title || a.description)
    ? `export const metadata = {\n${a.title ? `  title: ${JSON.stringify(a.title)},\n` : ""}${a.description ? `  description: ${JSON.stringify(a.description)},\n` : ""}};\n\n`
    : "";
  return (
    (cssImport ? `import "${cssImport}";\n` : "") +
    comps.map((c) => `import ${c.ident} from "${compDir}/${compPath(c)}";`).join("\n") +
    `\n\n${meta}export default function Page() {\n  return (\n    <>\n${body || "      <div />\n"}    </>\n  );\n}\n`
  );
}

export async function buildNextProject(html: string, baseUrl: string, r: ProjectResolvers, host: string): Promise<FileMap> {
  const files: FileMap = {};
  const collect = makeCollector(files, r, "public/assets");
  const a = await analyze(html, baseUrl, r, collect, "/", absoluteLinks, files);
  const important: string[] = [];
  const comps = componentFiles(a.plan.components, "@/components/sl-runtime", true, important);
  for (const c of comps) files[`components/${compPath(c)}.jsx`] = c.code;
  if (comps.some((c) => c.client)) files["components/sl-runtime.js"] = JSX_RUNTIME;
  files["app/globals.css"] = a.css + importantBlock(important);
  files["app/layout.jsx"] = nextLayout(a, "./globals.css");
  if (a.animLoader) files["components/SlAnimations.jsx"] = animComponent(a.animLoader);
  files["app/page.jsx"] = nextPage(a, comps, "@/components", false);
  writeNextScaffold(files, host, comps, false);
  noteMissingAssets(files);
  await prettifyCode(files); // laid out to be read (Prettier)
  return noteMissing(files);
}

export interface NextSitePage {
  url: string;
  title: string;
  html: string;
}
/** Route for a captured URL: "/" → "", "/about/team" → "about/team". */
export function routeOf(url: string): string {
  const p = decodeURIComponent(new URL(url).pathname)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.html?$/i, "");
  return p
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[^\w-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase() || "page")
    .map((s) => (/^(app|api|_next)$/.test(s) ? s + "-page" : s))
    .join("/");
}
export async function buildNextSiteProject(pages: NextSitePage[], r: ProjectResolvers, host: string): Promise<FileMap> {
  const files: FileMap = {};
  const collect = makeCollector(files, r, "public/assets");
  const routes = new Map<string, string>(); // normalized url → route path
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      return x.host + x.pathname.replace(/\/+$/, "").replace(/\.html?$/, "");
    } catch {
      return u;
    }
  };
  const usedRoutes = new Set<string>();
  for (const p of pages) {
    let route = routeOf(p.url);
    let i = 2;
    while (usedRoutes.has(route)) route = `${routeOf(p.url)}-${i++}`;
    usedRoutes.add(route);
    routes.set(norm(p.url), route);
  }
  const linkMapper = (href: string, base: string) => {
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return href;
    const abs = absUrl(href, base);
    let hash = "";
    try {
      hash = new URL(abs).hash;
    } catch {
      /* ignore */
    }
    const route = routes.get(norm(abs));
    return route === undefined ? abs : `/${route}${route ? "/" : ""}${hash}`;
  };
  let first: AnalyzedPage | null = null;
  let siteLoader = "";
  const allComps: ComponentFile[] = [];
  const important: string[] = [];
  for (const p of pages) {
    const a = await analyze(p.html, p.url, r, collect, "/", linkMapper, files);
    first ||= a;
    siteLoader ||= a.animLoader;
    const route = routes.get(norm(p.url)) || "";
    const folder = route ? route.split("/").map(pascal).join("") || "Page" : "Home";
    const comps = componentFiles(a.plan.components, "@/components/sl-runtime", true, important);
    for (const c of comps) files[`components/${folder}/${compPath(c)}.jsx`] = c.code;
    allComps.push(...comps);
    const dir = route ? `app/${route}` : "app";
    files[`${dir}/page.css`] = a.css;
    files[`${dir}/page.jsx`] = nextPage(a, comps, `@/components/${folder}`, true, "./page.css");
  }
  if (allComps.some((c) => c.client)) files["components/sl-runtime.js"] = JSX_RUNTIME;
  files["app/globals.css"] = importantBlock(important) || "/* shared styles: each route imports its own page.css */\n";
  // one loader serves every page (it finds the animations in whatever is rendered)
  files["app/layout.jsx"] = nextLayout({ ...first!, animLoader: siteLoader }, "./globals.css");
  if (siteLoader) files["components/SlAnimations.jsx"] = animComponent(siteLoader);
  writeNextScaffold(files, host, allComps, true, pages.length);
  noteMissingAssets(files);
  await prettifyCode(files); // laid out to be read (Prettier)
  return noteMissing(files);
}
function writeNextScaffold(files: FileMap, host: string, comps: ComponentFile[], site: boolean, pageCount = 1): void {
  const name = safeName(host);
  files["package.json"] = nextPackage(name);
  files["next.config.mjs"] = nextConfig();
  files["jsconfig.json"] = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }, null, 2) + "\n";
  files[".gitignore"] = GITIGNORE;
  files["README.md"] = readme(
    host,
    site ? `Next.js (App Router) — ${pageCount} page(s)` : "Next.js (App Router)",
    comps,
    site
      ? [
          "app/layout.jsx                 <html>/<body> attributes + site metadata",
          "app/page.jsx, app/page.css     home page and its styles",
          "app/<route>/page.jsx (+ .css)  one route per captured page",
          "components/<Page>/*.jsx        one file per section, grouped by page",
          "public/assets/                 images, fonts, media (shared)",
        ]
      : [
          "app/layout.jsx           <html>/<body> attributes + metadata (title, description, icons)",
          "app/page.jsx             page layout: wrapper elements + section components",
          "app/globals.css          every style from the page (+ your StyleLift edits)",
          "components/*.jsx         one file per page section (Server Components by default)",
          "public/assets/           images, fonts, media",
        ],
    "npm install\nnpm run dev       # http://localhost:3000\nnpm run build     # production build\nnpm run export    # fully static site in out/",
  );
}
function readme(host: string, kind: string, comps: ComponentFile[], tree: string[], run: string): string {
  return (
    `# ${host} — ${kind}\n\nExported by StyleLift from the live page, with your edits baked in.\n\n` +
    "## Run\n\n```bash\n" + run + "\n```\n\n## Structure\n\n```\n" + tree.join("\n") + "\n```\n\n" +
    `## Components (${comps.length})\n\n` +
    comps.map((c) => `- \`${compPath(c)}\`${c.client ? " — client component (re-attaches shadow DOM)" : ""}`).join("\n") +
    "\n\nComponent names come from the page itself (Framer layer names, aria-labels, ids, landmarks,\n" +
    "headings). Rename freely — they are plain React components with no props.\n"
  );
}
/** Append a "missing assets" note to README.md when some downloads failed. */
export function noteMissingAssets(files: FileMap): void {
  const missing = missingAssets.get(files);
  if (!missing || !missing.size || typeof files["README.md"] !== "string") return;
  const list = Array.from(missing).slice(0, 50).map((u) => `- ${u}`).join("\n");
  files["README.md"] +=
    `\n## Assets still loaded from the original site (${missing.size})\n\n` +
    "These could not be downloaded (missing on the site itself, blocked, or rate-limited), so the code\n" +
    "keeps their original URLs. Re-export later or add the files to public/assets/ manually.\n\n" +
    list + (missing.size > 50 ? `\n- …and ${missing.size - 50} more` : "") + "\n";
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");
