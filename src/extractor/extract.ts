import type { DesignTokens, FontFamilyToken } from "../shared/types";

/**
 * Deterministic design-token extractor.
 *
 * IMPORTANT: this function is serialized via `Function.prototype.toString` and
 * injected into the page with `chrome.scripting.executeScript({ func })`. It must
 * therefore be FULLY SELF-CONTAINED — every helper is nested inside, and the body
 * references only page globals (document, window, getComputedStyle, performance).
 * Do NOT reference any module-scope import at runtime. The `DesignTokens` import is
 * a type-only annotation and is erased at build time.
 *
 * It measures; it never invents. Every value returned is read from the rendered page.
 */
export function extractDesignTokens(): DesignTokens {
  const ELEMENT_CAP = 20000;

  // ── color helpers ───────────────────────────────────────────────────────────
  function clamp255(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)));
  }
  function hex2(n: number): string {
    return clamp255(n).toString(16).padStart(2, "0");
  }
  /** Parse any rgb()/rgba()/hex color string into normalized lowercase hex, or null. */
  function toHex(input: string | null | undefined): string | null {
    if (!input) return null;
    let s = input.trim().toLowerCase();
    if (!s || s === "none" || s === "transparent" || s === "currentcolor") return null;
    if (s === "inherit" || s === "initial" || s === "unset") return null;
    // already hex
    if (s[0] === "#") {
      if (s.length === 4) {
        return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      }
      if (s.length === 5) {
        return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] + s[4] + s[4];
      }
      if (s.length === 7 || s.length === 9) return s;
      return null;
    }
    // rgb()/rgba(): tolerate comma OR space + slash-alpha + percentage alpha
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const parseChan = (p: string): number =>
      p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p);
    const r = parseChan(parts[0]);
    const g = parseChan(parts[1]);
    const b = parseChan(parts[2]);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    let a = 1;
    if (parts.length >= 4) {
      a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (Number.isNaN(a)) a = 1;
    }
    if (a <= 0) return null; // fully transparent carries no design signal
    const base = "#" + hex2(r) + hex2(g) + hex2(b);
    return a >= 1 ? base : base + hex2(a * 255);
  }
  function alphaOf(rgb: string): number {
    const m = rgb.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return Number.isNaN(a) ? 1 : a;
  }

  // ── selector helper ───────────────────────────────────────────────────────────
  function selectorFor(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (el.id) return tag + "#" + el.id;
    const cls = (el.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0];
    return cls ? tag + "." + cls : tag;
  }

  // ── top-level comma split that ignores commas inside parentheses ──────────────
  function splitTopLevel(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of value) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // ── accumulators ──────────────────────────────────────────────────────────────
  interface ColorAcc {
    count: number;
    usedOn: Record<string, number>;
    selectors: Set<string>;
  }
  const colorMap = new Map<string, ColorAcc>();
  function recordColor(hex: string | null, prop: string, el: Element): void {
    if (!hex) return;
    let acc = colorMap.get(hex);
    if (!acc) {
      acc = { count: 0, usedOn: {}, selectors: new Set() };
      colorMap.set(hex, acc);
    }
    acc.count++;
    acc.usedOn[prop] = (acc.usedOn[prop] || 0) + 1;
    if (acc.selectors.size < 3) acc.selectors.add(selectorFor(el));
  }

  const radiusCounts = new Map<string, number>();
  const spacingCounts = new Map<string, number>();
  const shadowCounts = new Map<string, number>();

  interface TypeAcc {
    size: string;
    weight: number;
    lineHeight: string;
    letterSpacing: string;
    family: string;
    count: number;
  }
  const typeMap = new Map<string, TypeAcc>();
  interface FamilyAcc {
    count: number;
    weights: Set<number>;
    sizes: Set<string>;
  }
  const familyMap = new Map<string, FamilyAcc>();

  function normWeight(w: string): number {
    if (w === "normal") return 400;
    if (w === "bold") return 700;
    const n = parseInt(w, 10);
    return Number.isNaN(n) ? 400 : n;
  }
  function primaryFamily(stack: string): string {
    const first = splitTopLevel(stack)[0] || stack;
    return first.replace(/['"]/g, "").trim();
  }
  function sizePx(size: string): number {
    const n = parseFloat(size);
    return Number.isNaN(n) ? 0 : n;
  }

  // ── walk the DOM ────────────────────────────────────────────────────────────
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Deep element walk that pierces OPEN shadow roots (web components) — emoji/icon
  // sprites in component shadow DOM are invisible to a plain querySelectorAll.
  const all: Element[] = [];
  (function walk(root: ParentNode): void {
    if (all.length >= ELEMENT_CAP) return;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (all.length >= ELEMENT_CAP) break;
      all.push(el);
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) walk(sr);
    }
  })(document);
  // url() references found in CSS (background-image, mask-image, content) — these
  // catch icon/emoji sprites and data: images that resource timing never reports.
  const cssImageUrls = new Set<string>();
  const collectCssUrls = (value: string): void => {
    if (!value || value === "none") return;
    for (const m of value.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) cssImageUrls.add(m[2]);
  };
  const collectBackgrounds = (s: CSSStyleDeclaration): void => {
    collectCssUrls(s.backgroundImage);
    collectCssUrls(s.maskImage || s.getPropertyValue("-webkit-mask-image"));
  };
  for (const el of all) {
    const cs = getComputedStyle(el);

    // colors: text + background
    recordColor(toHex(cs.color), "color", el);
    recordColor(toHex(cs.backgroundColor), "background-color", el);

    // colors: borders (only when an actual border is drawn)
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    for (const side of sides) {
      const style = cs.getPropertyValue("border-" + side.toLowerCase() + "-style");
      const width = parseFloat(
        cs.getPropertyValue("border-" + side.toLowerCase() + "-width"),
      );
      if (style && style !== "none" && width > 0) {
        recordColor(
          toHex(cs.getPropertyValue("border-" + side.toLowerCase() + "-color")),
          "border-color",
          el,
        );
      }
    }

    // colors: SVG fill / stroke (only inside the SVG namespace)
    if (el.namespaceURI === SVG_NS) {
      recordColor(toHex(cs.fill), "fill", el);
      recordColor(toHex(cs.stroke), "stroke", el);
    }

    // box-shadow: distinct values + shadow color
    const shadow = cs.boxShadow;
    if (shadow && shadow !== "none") {
      shadowCounts.set(shadow, (shadowCounts.get(shadow) || 0) + 1);
      for (const seg of splitTopLevel(shadow)) {
        const cm = seg.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
        if (cm) recordColor(toHex(cm[0]), "box-shadow", el);
      }
    }

    // border-radius: each non-zero corner
    for (const corner of [
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-right-radius",
      "border-bottom-left-radius",
    ]) {
      const v = cs.getPropertyValue(corner).trim();
      if (v && v !== "0px" && v !== "0") {
        radiusCounts.set(v, (radiusCounts.get(v) || 0) + 1);
      }
    }

    // spacing: margins, paddings, gaps
    const spacingProps = [
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "row-gap",
      "column-gap",
    ];
    for (const p of spacingProps) {
      const v = cs.getPropertyValue(p).trim();
      // negative margins are layout hacks, not spacing-scale tokens — skip them
      if (v && v !== "0px" && v !== "0" && v !== "auto" && v !== "normal" && v[0] !== "-") {
        spacingCounts.set(v, (spacingCounts.get(v) || 0) + 1);
      }
    }

    // typography
    const hasText = !!(el.textContent && el.textContent.trim().length);
    const family = primaryFamily(cs.fontFamily);
    const weight = normWeight(cs.fontWeight);
    const size = cs.fontSize;
    if (family) {
      let fam = familyMap.get(family);
      if (!fam) {
        fam = { count: 0, weights: new Set(), sizes: new Set() };
        familyMap.set(family, fam);
      }
      // only count toward family usage where the element actually renders text
      if (hasText) {
        fam.count++;
        fam.weights.add(weight);
        fam.sizes.add(size);
      }
    }
    if (hasText && family) {
      const lh = cs.lineHeight;
      const ls = cs.letterSpacing === "normal" ? "0" : cs.letterSpacing;
      const key = [size, weight, lh, ls, family].join("|");
      let t = typeMap.get(key);
      if (!t) {
        t = { size, weight, lineHeight: lh, letterSpacing: ls, family, count: 0 };
        typeMap.set(key, t);
      }
      t.count++;
    }

    // CSS background / mask images, including on ::before / ::after pseudo-elements
    collectBackgrounds(cs);
    for (const pe of ["::before", "::after"]) {
      const pcs = getComputedStyle(el, pe);
      collectBackgrounds(pcs);
      const content = pcs.content;
      if (content && content.includes("url(")) collectCssUrls(content);
    }
  }

  // ── :root custom properties ───────────────────────────────────────────────────
  const cssVariables: Record<string, string> = {};
  const varNames = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — not readable
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      const sr = (rule as CSSStyleRule).selectorText;
      if (sr === ":root" || sr === "html" || sr === ":where(:root)") {
        const style = (rule as CSSStyleRule).style;
        for (let i = 0; i < style.length; i++) {
          const prop = style[i];
          if (prop.startsWith("--")) varNames.add(prop);
        }
      }
    }
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const colorToVar: Record<string, string> = {};
  for (const name of varNames) {
    const resolved = rootStyle.getPropertyValue(name).trim();
    if (!resolved) continue;
    cssVariables[name] = resolved;
    const asHex = toHex(resolved);
    if (asHex && !(asHex in colorToVar)) colorToVar[asHex] = name;
  }

  // ── @font-face rules ──────────────────────────────────────────────────────────
  const fontFaces: DesignTokens["typography"]["fontFaces"] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (rule.constructor && rule.constructor.name === "CSSFontFaceRule") {
        const style = (rule as CSSFontFaceRule).style;
        const fam = style.getPropertyValue("font-family").replace(/['"]/g, "").trim();
        const weightRaw = style.getPropertyValue("font-weight").trim() || "400";
        const weight = /^\d+$/.test(weightRaw) ? parseInt(weightRaw, 10) : weightRaw;
        const fstyle = style.getPropertyValue("font-style").trim() || "normal";
        const src = style.getPropertyValue("src");
        const urlMatch = src.match(/url\(([^)]+)\)/);
        const url = urlMatch ? urlMatch[1].replace(/['"]/g, "").trim() : "";
        const fmtMatch = src.match(/format\(([^)]+)\)/);
        let format = fmtMatch ? fmtMatch[1].replace(/['"]/g, "").trim() : "";
        if (!format && url) {
          const ext = url.split("?")[0].split(".").pop() || "";
          format = ext;
        }
        if (fam) fontFaces.push({ family: fam, weight, style: fstyle, format, src: url });
      }
    }
  }

  // ── assets (resource timing + DOM) ────────────────────────────────────────────
  const fontExt = /\.(woff2?|ttf|otf|eot)(\?|$)/i;
  const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i;
  const videoExt = /\.(mp4|webm|mov|m4v|ogv|avi|mkv|m3u8|mpd)(\?|$)/i;
  const modelExt = /\.(glb|gltf|fbx|obj|usdz?|stl|ply|3ds|dae)(\?|$)/i;
  const fontUrls = new Set<string>();
  const imageUrls = new Set<string>();
  const videoUrls = new Set<string>();
  const modelUrls = new Set<string>();
  const inlineImages: { url: string; type: string; inline: true; bytes: number }[] = [];
  const seenInline = new Set<string>();
  const INLINE_CAP = 80;

  // Embedded base64 images (emoji, sprites, icons) — captured, but trackers and
  // 1×1 spacers are dropped, and we store the mime type + decoded size instead of
  // the giant data string.
  function addInline(src: string): void {
    if (inlineImages.length >= INLINE_CAP || seenInline.has(src)) return;
    const m = src.match(/^data:image\/([\w+.-]+)[;,]/i);
    if (!m) return; // only image data URIs
    const b64 = src.includes(";base64,") ? src.split(",")[1] || "" : "";
    const bytes = b64 ? Math.floor(b64.length * 0.75) : src.length;
    if (bytes < 80) return; // ~1×1 spacer / tracking pixel
    seenInline.add(src);
    inlineImages.push({ url: src, type: m[1].split("+")[0].toLowerCase(), inline: true, bytes });
  }

  // explicit hint wins over extension guessing (e.g. blob: video sources, extension-less CDN URLs)
  function classify(url: string, hint?: "video" | "image"): void {
    if (!url) return;
    if (url.startsWith("data:")) {
      if (hint !== "video") addInline(url);
      return;
    }
    if (url.startsWith("blob:")) {
      if (hint === "video") videoUrls.add(url);
      return;
    }
    if (fontExt.test(url)) fontUrls.add(url);
    else if (modelExt.test(url)) modelUrls.add(url);
    else if (videoExt.test(url)) videoUrls.add(url);
    else if (imageExt.test(url)) imageUrls.add(url);
    else if (hint === "video") videoUrls.add(url);
    else if (hint === "image") imageUrls.add(url);
  }
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      classify((entry as PerformanceResourceTiming).name);
    }
  } catch {
    /* performance API unavailable */
  }
  const addImgEl = (el: HTMLImageElement): void => {
    if (el.naturalWidth && el.naturalWidth <= 2 && el.naturalHeight <= 2) return; // tracker/spacer
    const src = el.currentSrc || el.src;
    if (!src) return;
    if (src.startsWith("data:")) addInline(src);
    else if (imageExt.test(src)) imageUrls.add(src);
    else if (/^https?:/.test(src)) imageUrls.add(src); // an <img> is an image even without an extension
  };
  // images/videos from the deep walk (includes shadow-DOM media)
  for (const el of all) {
    const tag = el.tagName;
    if (tag === "IMG") addImgEl(el as HTMLImageElement);
    else if (tag === "VIDEO") {
      const vid = el as HTMLVideoElement;
      classify(vid.currentSrc || vid.src, "video");
      if (vid.poster) classify(vid.poster, "image");
    } else if (tag === "SOURCE") {
      const s = el.getAttribute("src") || el.getAttribute("srcset") || "";
      const url = s.split(/\s+/)[0];
      const parent = el.parentElement?.tagName.toLowerCase();
      classify(url, parent === "video" ? "video" : parent === "picture" ? "image" : undefined);
    }
  }
  // same-origin iframes: harvest their images + CSS background images (best effort)
  for (const el of all) {
    if (el.tagName !== "IFRAME") continue;
    let idoc: Document | null = null;
    try {
      idoc = (el as HTMLIFrameElement).contentDocument;
    } catch {
      continue; // cross-origin — not readable
    }
    if (!idoc) continue;
    const iwin = (el as HTMLIFrameElement).contentWindow;
    for (const im of Array.from(idoc.images)) addImgEl(im as HTMLImageElement);
    if (iwin) {
      for (const ie of Array.from(idoc.querySelectorAll("*")).slice(0, 5000)) {
        const ics = iwin.getComputedStyle(ie);
        collectCssUrls(ics.backgroundImage);
      }
    }
  }
  // CSS background / mask / content url() refs gathered during the element walk
  for (const url of cssImageUrls) classify(url, "image");
  function extOf(url: string): string {
    const clean = url.split("?")[0].split("#")[0];
    return (clean.split(".").pop() || "").toLowerCase();
  }
  const toEntries = (set: Set<string>) =>
    Array.from(set).map((url) => ({ url, type: extOf(url) }));

  // ── assemble colors ───────────────────────────────────────────────────────────
  const colors = Array.from(colorMap.entries())
    .map(([value, acc]) => ({
      value,
      cssVar: colorToVar[value] || null,
      count: acc.count,
      usedOn: acc.usedOn,
      sampleSelectors: Array.from(acc.selectors),
    }))
    .sort((a, b) => b.count - a.count);

  // ── assemble typography ────────────────────────────────────────────────────────
  const families: FontFamilyToken[] = Array.from(familyMap.entries())
    .filter(([, acc]) => acc.count > 0)
    .map(([family, acc]): FontFamilyToken => {
      const sizes = Array.from(acc.sizes).sort((a, b) => sizePx(a) - sizePx(b));
      const weights = Array.from(acc.weights).sort((a, b) => a - b);
      const maxSize = sizes.length ? sizePx(sizes[sizes.length - 1]) : 0;
      const lc = family.toLowerCase();
      let likelyRole: "display" | "body" | "mono" | "ui";
      if (/mono|code|consol|menlo|courier/.test(lc)) likelyRole = "mono";
      else if (maxSize >= 28 && acc.count < 60) likelyRole = "display";
      else likelyRole = "body";
      return { family, count: acc.count, weights, sizes, likelyRole };
    })
    .sort((a, b) => b.count - a.count);
  // promote the single highest-count non-mono family to body, others to ui
  let bodyAssigned = false;
  for (const f of families) {
    if (f.likelyRole === "mono") continue;
    if (!bodyAssigned) {
      f.likelyRole = "body";
      bodyAssigned = true;
    } else if (f.likelyRole === "body") {
      f.likelyRole = "ui";
    }
  }

  const scale = Array.from(typeMap.values())
    .sort((a, b) => sizePx(b.size) - sizePx(a.size) || b.count - a.count)
    .slice(0, 24);

  // ── assemble shadows ───────────────────────────────────────────────────────────
  const shadows = Array.from(shadowCounts.entries())
    .map(([value, count]) => {
      const first = splitTopLevel(value)[0] || value;
      const cm = first.match(/rgba?\([^)]+\)/);
      const opacity = cm ? alphaOf(cm[0]) : 1;
      const noColor = first.replace(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|inset/g, "").trim();
      const nums = (noColor.match(/-?[\d.]+px/g) || []).map((n) => parseFloat(n));
      // offsetX offsetY blur spread
      const blur = nums.length >= 3 ? nums[2] : 0;
      const spread = nums.length >= 4 ? nums[3] : 0;
      return { value, blur, spread, opacity: Math.round(opacity * 1000) / 1000, count };
    })
    .sort((a, b) => b.count - a.count);

  const radii = Array.from(radiusCounts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  const spacing = Array.from(spacingCounts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    meta: {
      url: location.href,
      title: document.title,
      extractedAt: new Date().toISOString(),
    },
    colors,
    cssVariables,
    typography: { families, scale, fontFaces },
    radii,
    shadows,
    spacing,
    assets: {
      fonts: toEntries(fontUrls),
      // external URLs first, then inline (data:) images
      images: [...toEntries(imageUrls), ...inlineImages],
      videos: toEntries(videoUrls),
      models: toEntries(modelUrls),
    },
  };
}
