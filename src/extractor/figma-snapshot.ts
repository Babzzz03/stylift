// Export to Figma — the page measured as Figma layers.
//
// Runs INSIDE the rendered page (injected on its own: no imports, no outside names). Walks every visible element and
// writes what Figma needs to draw it again: where it is (from the page's own layout, getBoundingClientRect), its box
// (fills, gradients, image fills with their fit, borders per side, corner radii, shadows, blurs, opacity, blend,
// clipping), its text (characters with styled runs: font, weight, size, line height, letter spacing, colour, case,
// decoration), its pictures and its vector icons. Auto Layout is written only where it reproduces the measured
// positions exactly; everything else keeps its measured place. The StyleLift plugin for Figma builds the layers.

export type RGBA = { r: number; g: number; b: number; a: number };
export type FStop = { pos: number; color: RGBA };
export type FFill =
  | { k: "solid"; color: RGBA }
  | { k: "linear"; angle: number; stops: FStop[] }
  | { k: "radial"; stops: FStop[]; at?: GradientAt } // (no `at`: CSS's default — an ellipse to the farthest corners, centred)
  | { k: "conic"; stops: FStop[]; angle: number; at?: GradientAt } // (from Figma's angular gradients)
  | { k: "image"; img: string; fit: "fill" | "fit" | "crop" | "tile"; xf?: Xf; opacity?: number };
/** where a radial / conic gradient sits in its box: centre and radii as fractions of the box's width and height */
export type GradientAt = { cx: number; cy: number; rx: number; ry: number };
/** Figma's imageTransform for a cropped picture: the layer's 0–1 square → the picture's (identity = stretched over it) */
export type Xf = [[number, number, number], [number, number, number]];
export type FEffect =
  | { k: "drop" | "inner"; x: number; y: number; blur: number; spread: number; color: RGBA }
  | { k: "blur" | "bgblur"; radius: number };
export type FRun = {
  start: number;
  end: number;
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  lh: number | null; // px, null = the font's own ("normal")
  ls: number; // px
  color: RGBA;
  fill?: FFill; // text painted by a gradient (background-clip: text)
  deco?: "underline" | "strike";
  textCase?: "upper" | "lower" | "title";
  link?: string;
};
export type FLayout = {
  mode: "row" | "col";
  gap: number;
  pad: [number, number, number, number];
  main: "start" | "center" | "end" | "between";
  cross: "start" | "center" | "end" | "stretch" | "baseline";
  wrap: boolean;
};
export type FNode = {
  t: "frame" | "text" | "image" | "svg";
  n: string; // a name for the layer: tag + first class / the text it shows
  x: number; // relative to the parent layer
  y: number;
  w: number;
  h: number;
  rot?: number; // degrees, clockwise
  op?: number;
  blend?: string;
  clip?: boolean;
  fills?: FFill[];
  stroke?: { color: RGBA; w: [number, number, number, number]; dash?: boolean };
  radius?: [number, number, number, number]; // top-left, top-right, bottom-right, bottom-left
  ellipse?: boolean; // (a Figma ellipse: rounded to an oval, whatever its size)
  effects?: FEffect[];
  layout?: FLayout;
  abs?: boolean; // placed by measurement inside an Auto Layout parent (position: absolute / fixed)
  kids?: FNode[];
  // text
  chars?: string;
  runs?: FRun[];
  align?: "left" | "center" | "right" | "justify";
  valign?: "top" | "center" | "bottom"; // (a Figma text box taller than its text)
  lines?: number; // how many lines the page laid the text out in (Figma must not wrap a one-line text)
  // image / vector
  img?: string;
  fit?: "fill" | "fit" | "crop" | "tile";
  xf?: Xf;
  svg?: string;
};
export type FigmaSnapshot = {
  v: 1;
  url: string;
  title: string;
  width: number; // the page as laid out (CSS px)
  height: number;
  root: FNode;
  images: { id: string; url: string; w: number; h: number }[]; // pictures the layers fill with (data: URLs included)
  fonts: { family: string; weight: number; italic: boolean }[];
  colors: { color: RGBA; uses: number }[]; // the page's palette, most used first (for Figma variables)
  texts: { family: string; weight: number; size: number; lh: number | null; ls: number; uses: number }[]; // type styles
  stats: { nodes: number; texts: number; images: number; svgs: number; autoLayout: number; skipped: number };
};

/** The page as Figma layers. Self-contained: injected into the page by itself. */
export function figmaSnapshot(opts?: { maxNodes?: number; root?: string }): FigmaSnapshot {
  const MAX = (opts && opts.maxNodes) || 12000;
  const startEl = (opts && opts.root && document.querySelector(opts.root)) || document.body;
  const sx = window.scrollX, sy = window.scrollY;
  const stats = { nodes: 0, texts: 0, images: 0, svgs: 0, autoLayout: 0, skipped: 0 };
  const images: FigmaSnapshot["images"] = [];
  const imageIds = new Map<string, string>();
  const fontSet = new Map<string, { family: string; weight: number; italic: boolean }>();
  const colorUse = new Map<string, { color: RGBA; uses: number }>();
  const textUse = new Map<string, { family: string; weight: number; size: number; lh: number | null; ls: number; uses: number }>();
  const round = (n: number) => Math.round(n * 100) / 100;

  // ── values ─────────────────────────────────────────────────────────────────
  const probe = document.createElement("canvas").getContext("2d");
  // (keepClear: a fully see-through colour is still a colour — a gradient's stop fading to nothing)
  const parseColor = (c: string, keepClear = false): RGBA | null => {
    if (!c) return null;
    if (c === "transparent") return keepClear ? { r: 0, g: 0, b: 0, a: 0 } : null;
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(c);
    if (!m && probe) {
      // color(srgb …), oklch(…), named colours: the canvas turns them into a hex / rgba it can say
      probe.fillStyle = "#000";
      probe.fillStyle = c;
      const v = String(probe.fillStyle);
      if (/^#[0-9a-f]{6}$/i.test(v)) return { r: parseInt(v.slice(1, 3), 16) / 255, g: parseInt(v.slice(3, 5), 16) / 255, b: parseInt(v.slice(5, 7), 16) / 255, a: 1 };
      m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
    }
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a <= 0 && !keepClear) return null;
    return { r: round(+m[1] / 255), g: round(+m[2] / 255), b: round(+m[3] / 255), a: round(Math.max(0, a)) };
  };
  const useColor = (c: RGBA) => {
    const k = `${c.r},${c.g},${c.b},${c.a}`;
    const u = colorUse.get(k);
    if (u) u.uses++;
    else colorUse.set(k, { color: c, uses: 1 });
  };
  const px = (v: string) => parseFloat(v) || 0;
  // split a comma list that may hold functions with commas inside (gradients, shadows)
  const splitTop = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const imageId = (url: string, w: number, h: number): string => {
    let id = imageIds.get(url);
    if (!id) {
      id = `i${images.length + 1}`;
      imageIds.set(url, id);
      images.push({ id, url, w: Math.round(w), h: Math.round(h) });
    }
    return id;
  };
  // where a picture sits in its box, for the fits Figma's own modes don't give (FILL is a centred cover, FIT a centred
  // contain): a stretched picture, a cover anchored elsewhere — Figma crops it with an imageTransform
  const naturalOf = (url: string): { w: number; h: number } | null => {
    try {
      const i = new Image();
      i.src = url;
      return i.complete && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight } : null;
    } catch {
      return null;
    }
  };
  const posFrac = (v: string, box: number, img: number): number => {
    v = (v || "").trim();
    if (/%$/.test(v)) return parseFloat(v) / 100;
    if (v === "left" || v === "top") return 0;
    if (v === "right" || v === "bottom") return 1;
    if (v === "center" || !v) return 0.5;
    const free = box - img;
    return Math.abs(free) > 0.5 ? parseFloat(v) / free : 0.5;
  };
  const coverXf = (bw: number, bh: number, iw: number, ih: number, pos: string): Xf | null => {
    const s = Math.max(bw / iw, bh / ih);
    const dw = iw * s, dh = ih * s;
    const [px1, py1] = (pos || "50% 50%").split(/\s+/);
    const fx = posFrac(px1, bw, dw), fy = posFrac(py1 ?? "50%", bh, dh);
    if (Math.abs(fx - 0.5) < 0.01 && Math.abs(fy - 0.5) < 0.01) return null; // centred: Figma's FILL
    const ox = (bw - dw) * fx, oy = (bh - dh) * fy;
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    return [[r4(bw / dw), 0, r4(-ox / dw)], [0, r4(bh / dh), r4(-oy / dh)]];
  };
  const STRETCH: Xf = [[1, 0, 0], [0, 1, 0]];
  const gradientStops = (args: string[]): FStop[] => {
    // "red 10%", "rgba(…) 40% 60%", "blue" — positions spread evenly where missing
    const raw: { color: RGBA; pos: number | null }[] = [];
    for (const a of args) {
      const cm = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+(?:\([^)]*\))?)/i.exec(a);
      if (!cm) continue;
      const color = parseColor(cm[1], true);
      const rest = a.replace(cm[1], "").trim();
      const ps = rest.split(/\s+/).filter(Boolean).map((p) => (p.endsWith("%") ? parseFloat(p) / 100 : NaN));
      if (!color) continue;
      raw.push({ color, pos: ps.length && !isNaN(ps[0]) ? ps[0] : null });
      if (ps.length > 1 && !isNaN(ps[1])) raw.push({ color, pos: ps[1] });
    }
    if (!raw.length) return [];
    if (raw[0].pos === null) raw[0].pos = 0;
    if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].pos !== null) continue;
      let j = i;
      while (raw[j].pos === null) j++;
      const a = raw[i - 1].pos!, b = raw[j].pos!;
      for (let k = i; k < j; k++) raw[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    // a see-through stop takes its neighbour's colour: CSS fades between stops premultiplied (towards "nothing"),
    // Figma straight — black at 0 opacity would draw a grey band into a white fade
    // (between two colours: a pair at the same place, each side fading in its own colour)
    for (let i = raw.length - 1; i >= 0; i--) {
      const st = raw[i];
      if (st.color.a > 0) continue;
      const prev = raw.slice(0, i).reverse().find((x) => x.color.a > 0), next = raw.slice(i + 1).find((x) => x.color.a > 0);
      if (prev && next && (prev.color.r !== next.color.r || prev.color.g !== next.color.g || prev.color.b !== next.color.b)) {
        raw.splice(i, 1, { color: { ...prev.color, a: 0 }, pos: st.pos }, { color: { ...next.color, a: 0 }, pos: st.pos });
      } else if (prev || next) st.color = { ...(next || prev)!.color, a: 0 };
    }
    return raw.map((s) => ({ pos: round(Math.max(0, Math.min(1, s.pos!))), color: s.color }));
  };
  const parseBackgrounds = (cs: CSSStyleDeclaration, w: number, h: number): FFill[] => {
    const fills: FFill[] = [];
    const bg = parseColor(cs.backgroundColor);
    const layers = cs.backgroundImage && cs.backgroundImage !== "none" ? splitTop(cs.backgroundImage) : [];
    const sizes = splitTop(cs.backgroundSize || "auto");
    // CSS paints the first layer on top; Figma paints the last fill on top
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const lin = /^(repeating-)?linear-gradient\((.*)\)$/.exec(L);
      const rad = /^(repeating-)?radial-gradient\((.*)\)$/.exec(L);
      const url = /^url\(["']?(.*?)["']?\)$/.exec(L);
      if (lin) {
        const args = splitTop(lin[2]);
        let angle = 180; // CSS default: to bottom
        const first = args[0] || "";
        if (/deg|turn|rad/.test(first) && !/rgb|#/.test(first)) {
          angle = /turn/.test(first) ? parseFloat(first) * 360 : /rad/.test(first) ? (parseFloat(first) * 180) / Math.PI : parseFloat(first);
          args.shift();
        } else if (/^to /.test(first)) {
          const d = first.slice(3).trim();
          const dirs: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270, "top right": 45, "right top": 45, "bottom right": 135, "right bottom": 135, "bottom left": 225, "left bottom": 225, "top left": 315, "left top": 315 };
          angle = dirs[d] ?? 180;
          args.shift();
        }
        const stops = gradientStops(args);
        if (stops.length >= 2) fills.push({ k: "linear", angle: round(angle), stops });
      } else if (rad) {
        const args = splitTop(rad[2]);
        if (args.length && !/(rgb|#|transparent)/i.test(args[0])) args.shift(); // shape / position
        const stops = gradientStops(args);
        if (stops.length >= 2) fills.push({ k: "radial", stops });
      } else if (url && url[1]) {
        const size = sizes[Math.min(i, sizes.length - 1)] || "auto";
        const href = new URL(url[1], location.href).href;
        const fit = /cover/.test(size) ? "fill" : /contain/.test(size) ? "fit" : /repeat/.test(cs.backgroundRepeat) && !/no-repeat/.test(cs.backgroundRepeat) && size === "auto" ? "tile" : "fill";
        const fill: FFill = { k: "image", img: imageId(href, w, h), fit };
        if (/^100% 100%$/.test(size.trim())) fills.push({ ...fill, fit: "crop", xf: STRETCH });
        else if (fit === "fill" && /cover/.test(size)) {
          const nat = naturalOf(href);
          const poss = splitTop(cs.backgroundPosition || "50% 50%");
          const xf = nat ? coverXf(w, h, nat.w, nat.h, poss[Math.min(i, poss.length - 1)]) : null;
          fills.push(xf ? { ...fill, fit: "crop", xf } : fill);
        } else fills.push(fill);
      }
    }
    if (bg) { fills.unshift({ k: "solid", color: bg }); useColor(bg); }
    return fills;
  };
  const parseShadows = (v: string, inset: boolean | null): FEffect[] => {
    if (!v || v === "none") return [];
    const out: FEffect[] = [];
    for (const s of splitTop(v)) {
      const isInset = /\binset\b/.test(s);
      if (inset !== null && isInset !== inset) continue;
      const cm = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(s);
      const color = cm ? parseColor(cm[1]) : { r: 0, g: 0, b: 0, a: 1 };
      if (!color) continue;
      const nums = s.replace(cm ? cm[1] : "", "").replace("inset", "").trim().split(/\s+/).map(px);
      out.push({ k: isInset ? "inner" : "drop", x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color });
    }
    return out;
  };
  const fontWeight = (w: string) => (w === "bold" ? 700 : w === "normal" ? 400 : parseInt(w) || 400);
  // The family the page really drew with: the first of the stack it has — a web font it loaded, or one installed on
  // this computer (it measures differently from the fallbacks) — else the generic it fell to (system-ui, serif…:
  // the plugin finds Figma's nearest)
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|emoji|math)$/i;
  const loadedFaces = new Set<string>();
  try { document.fonts.forEach((f) => { if (f.status === "loaded") loadedFaces.add(f.family.replace(/^["']|["']$/g, "").toLowerCase()); }); } catch { /* no font set */ }
  const installed = new Map<string, boolean>();
  const meter = document.createElement("canvas").getContext("2d");
  const hasLocal = (fam: string): boolean => {
    const k = fam.toLowerCase();
    if (installed.has(k)) return installed.get(k)!;
    let yes = false;
    if (meter) {
      const probe = "mmmmmmmmmmlli1WQ@#";
      for (const base of ["monospace", "serif", "sans-serif"]) {
        meter.font = `72px ${base}`;
        const a = meter.measureText(probe).width;
        meter.font = `72px "${fam}", ${base}`;
        if (Math.abs(meter.measureText(probe).width - a) > 0.5) { yes = true; break; }
      }
    }
    installed.set(k, yes);
    return yes;
  };
  const familyCache = new Map<string, string>();
  const firstFamily = (f: string): string => {
    const hit = familyCache.get(f);
    if (hit) return hit;
    const stack = splitTop(f).map((x) => x.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
    let out = stack[0] || "Inter";
    for (const fam of stack) {
      if (GENERIC.test(fam)) { out = fam.toLowerCase() === "blinkmacsystemfont" || fam === "-apple-system" ? "system-ui" : fam.toLowerCase(); break; }
      if (loadedFaces.has(fam.toLowerCase()) || hasLocal(fam)) { out = fam; break; }
    }
    familyCache.set(f, out);
    return out;
  };

  // ── visibility / geometry ──────────────────────────────────────────────────
  const shown = (_el: Element, cs: CSSStyleDeclaration) => cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && parseFloat(cs.opacity) > 0.01;
  // rotation from a 2D matrix (the box itself is measured without it: offset sizes)
  const rotationOf = (tf: string): number => {
    const m = /^matrix\(([^)]+)\)$/.exec(tf);
    if (!m) return 0;
    const [a, b] = m[1].split(",").map(Number);
    const deg = (Math.atan2(b, a) * 180) / Math.PI;
    return Math.abs(deg) < 0.05 ? 0 : round(deg);
  };
  const nameOf = (el: Element) => {
    if (el.tagName === "SL-PSEUDO" || el.hasAttribute("data-sl-fig-moved") || (el.tagName === "IMG" && el.getAttribute("aria-hidden") === "true" && el.parentElement?.hasAttribute("data-sl-fig-pseudo-off"))) {
      const host = el.parentElement;
      return `${host ? host.tagName.toLowerCase() + (typeof host.className === "string" && host.className.trim() ? "." + host.className.trim().split(/\s+/)[0] : "") : ""}::${el === host?.firstChild || el.hasAttribute("data-sl-fig-moved") ? "before" : "after"}`;
    }
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : cls ? "." + cls : "");
  };

  // ── text ───────────────────────────────────────────────────────────────────
  const isInlineText = (el: Element, cs: CSSStyleDeclaration): boolean => {
    if (cs.display !== "inline") return false;
    // an inline element counts as text when it holds only text / inline text (no pictures, no boxes of its own)
    if (el.querySelector("img,svg,video,canvas,iframe,input,button,select,textarea")) return false;
    if (parseColor(cs.backgroundColor) || cs.backgroundImage !== "none" || px(cs.borderTopWidth) || px(cs.borderBottomWidth)) return false;
    return true;
  };
  const runOf = (cs: CSSStyleDeclaration, link: string | null): Omit<FRun, "start" | "end"> => {
    const color = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const size = px(cs.fontSize);
    const lh = cs.lineHeight === "normal" ? null : px(cs.lineHeight);
    const ls = cs.letterSpacing === "normal" ? 0 : px(cs.letterSpacing);
    const run: Omit<FRun, "start" | "end"> = { family: firstFamily(cs.fontFamily), weight: fontWeight(cs.fontWeight), italic: /italic|oblique/.test(cs.fontStyle), size, lh, ls, color };
    // text painted by its background (gradient headings): that paint, not the transparent colour
    const clipText = /\btext\b/.test(cs.backgroundClip || "") || /\btext\b/.test(cs.getPropertyValue("-webkit-background-clip"));
    if (clipText) {
      const f = parseBackgrounds(cs, 100, 100).filter((x) => x.k !== "image");
      const top = f[f.length - 1];
      if (top) {
        if (top.k === "solid") run.color = top.color;
        else run.fill = top;
      }
    }
    const tfc = cs.getPropertyValue("-webkit-text-fill-color");
    if (!run.fill && tfc && !/transparent|rgba\(0, 0, 0, 0\)/.test(tfc)) { const c = parseColor(tfc); if (c) run.color = c; }
    const deco = cs.textDecorationLine || "";
    if (/underline/.test(deco)) run.deco = "underline";
    else if (/line-through/.test(deco)) run.deco = "strike";
    if (cs.textTransform === "uppercase") run.textCase = "upper";
    else if (cs.textTransform === "lowercase") run.textCase = "lower";
    else if (cs.textTransform === "capitalize") run.textCase = "title";
    if (link) run.link = link;
    fontSet.set(`${run.family}|${run.weight}|${run.italic}`, { family: run.family, weight: run.weight, italic: run.italic });
    useColor(run.color);
    const tk = `${run.family}|${run.weight}|${size}|${lh}|${ls}`;
    const tu = textUse.get(tk);
    if (tu) tu.uses++;
    else textUse.set(tk, { family: run.family, weight: run.weight, size, lh, ls, uses: 1 });
    return run;
  };
  // the height of a line of this font at line-height: normal (its ascent, descent and line gap)
  const normalCache = new Map<string, number>();
  const normalLine = (cs: CSSStyleDeclaration): number => {
    const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${cs.fontFamily}`;
    let v = normalCache.get(key);
    if (v === undefined) {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;left:-9999px;top:0;white-space:nowrap;line-height:normal;font-style:${cs.fontStyle};font-weight:${cs.fontWeight};font-size:${cs.fontSize};font-family:${cs.fontFamily}`;
      d.textContent = "Hxg";
      document.body.appendChild(d);
      v = d.getBoundingClientRect().height;
      d.remove();
      normalCache.set(key, v);
    }
    return v;
  };
  // the text an inline stretch shows, as the page lays it out: white space collapsed (unless pre), <br> as a line break
  const collectText = (nodes: Node[], base: Element): { chars: string; runs: FRun[] } => {
    let chars = "";
    const runs: FRun[] = [];
    let lastSpace = true;
    const walk = (n: Node, link: string | null) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const parent = (n.parentElement || base) as Element;
        const cs = getComputedStyle(parent);
        let t = n.textContent || "";
        if (!/^pre/.test(cs.whiteSpace) && cs.whiteSpace !== "break-spaces") {
          t = t.replace(/[\t\n\r ]+/g, " ");
          if (lastSpace) t = t.replace(/^ /, "");
        }
        if (!t) return;
        const start = chars.length;
        chars += t;
        lastSpace = /\s$/.test(t);
        runs.push({ start, end: chars.length, ...runOf(cs, link) });
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n as Element;
      if (el.tagName === "BR") { chars += "\n"; lastSpace = true; return; }
      const cs = getComputedStyle(el);
      if (!shown(el, cs) || el.hasAttribute("data-sl-fig-apart")) return; // (a pseudo set apart is a layer of its own)
      const href = el.tagName === "A" ? (el as HTMLAnchorElement).href : link;
      for (const c of Array.from(el.childNodes)) walk(c, href);
    };
    for (const n of nodes) walk(n, null);
    // trailing space at the end of the block
    while (chars.endsWith(" ")) {
      chars = chars.slice(0, -1);
      const last = runs[runs.length - 1];
      if (last) { last.end = Math.min(last.end, chars.length); if (last.end <= last.start) runs.pop(); }
    }
    // neighbouring runs with the same look become one
    const merged: FRun[] = [];
    for (const r of runs) {
      const p = merged[merged.length - 1];
      const same = p && p.end === r.start && JSON.stringify({ ...p, start: 0, end: 0 }) === JSON.stringify({ ...r, start: 0, end: 0 });
      if (same) p.end = r.end;
      else merged.push({ ...r });
    }
    return { chars, runs: merged };
  };
  const textNode = (nodes: Node[], base: Element, parentX: number, parentY: number): FNode | null => {
    const range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const { chars, runs } = collectText(nodes, base);
    if (!chars.trim()) return null;
    let left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
    let right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
    const bcs = getComputedStyle(base);
    const ta = bcs.textAlign;
    const align = /center/.test(ta) ? "center" : /right|end/.test(ta) ? "right" : /justify/.test(ta) ? "justify" : "left";
    const br = base.getBoundingClientRect();
    const bl = px(bcs.borderLeftWidth), brr = px(bcs.borderRightWidth), bt = px(bcs.borderTopWidth), bb = px(bcs.borderBottomWidth);
    const content = { l: br.left + bl + px(bcs.paddingLeft), r: br.right - brr - px(bcs.paddingRight), t: br.top + bt + px(bcs.paddingTop), b: br.bottom - bb - px(bcs.paddingBottom) };
    // The block holds nothing but this text: its content box IS the text's box — the same width (so Figma wraps the
    // lines where the page does) and the same top (lines laid out from their line height, not from the glyphs)
    const flowKids = Array.from(base.childNodes).filter((c) => c.nodeType === Node.ELEMENT_NODE ? getComputedStyle(c as Element).display !== "none" && !/^(absolute|fixed)$/.test(getComputedStyle(c as Element).position) : c.nodeType === Node.TEXT_NODE ? !!(c.textContent || "").trim() : false);
    // (a flex / grid container lays its text out as an item — centred, aligned: its glyphs say where; blocks lay it
    // out in their own content box)
    const whole = flowKids.every((c) => nodes.includes(c)) && content.r > content.l && !/flex|grid/.test(bcs.display);
    // text painted by a gradient: the gradient spans the block (its background) — so must the layer
    const painted = runs.some((r) => r.fill);
    if (whole || painted || align !== "left") { left = whole || painted ? content.l : content.l; right = content.r; }
    if (whole) { top = content.t; bottom = Math.max(content.b, top + 1); }
    else {
      // lines laid out from their line height: half the leading above the first line's glyphs ("normal" too: the
      // font's own line gap, measured on a line of the same font)
      const lh = bcs.lineHeight === "normal" ? normalLine(bcs) : px(bcs.lineHeight);
      if (lh) { const first = rects[0]; top = first.top - (lh - first.height) / 2; }
    }
    if (painted && runs.length) {
      // (the gradient measured across the block's padding box, as the page paints it)
      left = br.left + bl;
      right = br.right - brr;
      for (const r of runs) if (r.fill) { /* spans the layer */ }
    }
    stats.texts++;
    return {
      t: "text",
      n: chars.slice(0, 40),
      x: round(left + sx - parentX),
      y: round(top + sy - parentY),
      w: round(Math.max(1, right - left) + (whole || align !== "left" ? 0 : 1)), // (a hair of room: other metrics must not wrap the last word)
      h: round(bottom - top),
      chars,
      runs,
      align,
      lines: lineCount(rects),
    };
  };
  // the line boxes the text sits in: a fragment whose middle is inside the line so far is on it (tight line
  // heights overlap the glyph boxes of neighbouring lines — their middles don't)
  const lineCount = (rects: DOMRect[]): number => {
    const sorted = rects.slice().sort((a, b) => a.top + a.bottom - b.top - b.bottom);
    let n = 0, top = Infinity, bottom = -Infinity;
    for (const r of sorted) {
      const mid = (r.top + r.bottom) / 2;
      if (mid >= top && mid <= bottom) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); continue; }
      n++; top = r.top; bottom = r.bottom;
    }
    return n;
  };

  // ── vectors ────────────────────────────────────────────────────────────────
  const svgText = (svg: SVGSVGElement): string => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const src = [svg, ...Array.from(svg.querySelectorAll("*"))];
    const dst = [clone, ...Array.from(clone.querySelectorAll("*"))];
    src.forEach((s, i) => {
      const d = dst[i] as Element;
      if (!(s instanceof SVGElement)) return;
      const cs = getComputedStyle(s);
      // the colours the page gave it (currentColor, CSS rules) written on each shape — Figma reads attributes
      for (const p of ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin"]) {
        const v = cs.getPropertyValue(p);
        if (v && !(p === "fill" && /^url/.test(v))) d.setAttribute(p, v.replace(/^rgba?\(/, (m) => m));
      }
    });
    const r = svg.getBoundingClientRect();
    clone.setAttribute("width", String(Math.round(r.width)));
    clone.setAttribute("height", String(Math.round(r.height)));
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return clone.outerHTML;
  };

  // an <img> showing an SVG, as markup Figma turns into vectors: same-origin or data: sources (another site's needs its
  // permission — it stays a picture), sized to the box it's shown in, nothing that runs
  const svgOfImage = (src: string, w: number, h: number): string | null => {
    let text = "";
    try {
      if (/^data:image\/svg\+xml/i.test(src)) {
        const comma = src.indexOf(",");
        const body = src.slice(comma + 1);
        text = /;base64,/i.test(src.slice(0, comma + 1)) ? atob(body) : decodeURIComponent(body);
      } else {
        const u = new URL(src, location.href);
        if (u.origin !== location.origin || !/\.svg$/i.test(u.pathname)) return null;
        const x = new XMLHttpRequest();
        x.open("GET", u.href, false); // (in the page, once per picture: the copy's own file, already in its cache)
        x.send();
        if (x.status !== 200 && x.status !== 0) return null;
        text = x.responseText;
      }
    } catch {
      return null;
    }
    if (!text || text.length > 400000) return null;
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
    doc.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
    for (const n of Array.from(doc.querySelectorAll("*"))) for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    svg.setAttribute("width", String(Math.round(w)));
    svg.setAttribute("height", String(Math.round(h)));
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(svg);
  };

  // ── Auto Layout (only where it gives back the measured places) ─────────────
  const tryLayout = (cs: CSSStyleDeclaration, node: FNode): void => {
    if (!/flex/.test(cs.display) || !node.kids || node.kids.length < 2) return;
    const row = /row/.test(cs.flexDirection);
    if (/reverse/.test(cs.flexDirection)) return;
    const pad: [number, number, number, number] = [px(cs.paddingTop) + px(cs.borderTopWidth), px(cs.paddingRight) + px(cs.borderRightWidth), px(cs.paddingBottom) + px(cs.borderBottomWidth), px(cs.paddingLeft) + px(cs.borderLeftWidth)];
    const flow = node.kids.filter((k) => !k.abs);
    if (flow.length < 2 || cs.flexWrap === "wrap") return;
    // the gaps between neighbours must all be the same (justify start / center / end) — or any for space-between
    const gaps: number[] = [];
    for (let i = 1; i < flow.length; i++) gaps.push(row ? flow[i].x - (flow[i - 1].x + flow[i - 1].w) : flow[i].y - (flow[i - 1].y + flow[i - 1].h));
    if (gaps.some((g) => g < -0.5)) return; // overlapping / out of order (order, negative margins)
    const jc = cs.justifyContent;
    const between = /space-between/.test(jc);
    const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    if (!between && gaps.some((g) => Math.abs(g - gap) > 0.75)) return;
    if (/space-(around|evenly)/.test(jc)) return;
    const main = between ? "between" : /center/.test(jc) ? "center" : /end|right/.test(jc) ? "end" : "start";
    const ai = cs.alignItems;
    const cross = /center/.test(ai) ? "center" : /end/.test(ai) ? "end" : /baseline/.test(ai) ? "baseline" : /stretch|normal/.test(ai) ? "stretch" : "start";
    // where Auto Layout would put each child on the cross axis must be where it is
    const inner = row ? node.h - pad[0] - pad[2] : node.w - pad[1] - pad[3];
    for (const k of flow) {
      const off = row ? k.y - pad[0] : k.x - pad[3];
      const size = row ? k.h : k.w;
      const want = cross === "center" ? (inner - size) / 2 : cross === "end" ? inner - size : 0;
      if (cross !== "baseline" && Math.abs(off - want) > 0.75) return;
    }
    // …and on the main axis: the first child where the padding / centring puts it
    const total = flow.reduce((a, k) => a + (row ? k.w : k.h), 0) + (between ? 0 : gap * (flow.length - 1));
    const space = (row ? node.w - pad[1] - pad[3] : node.h - pad[0] - pad[2]) - total;
    const firstAt = row ? flow[0].x - pad[3] : flow[0].y - pad[0];
    const wantFirst = main === "center" ? space / 2 : main === "end" ? space : 0;
    if (Math.abs(firstAt - wantFirst) > 0.75) return;
    node.layout = { mode: row ? "row" : "col", gap: round(between ? 0 : gap), pad, main, cross: cross as FLayout["cross"], wrap: false };
    stats.autoLayout++;
  };

  // ── pseudo-elements ───────────────────────────────────────────────────────
  const PSEUDO_OFF = "data-sl-fig-pseudo-off";
  let pseudoSheet: HTMLStyleElement | null = null;
  const cssText = (content: string): string => {
    let out = "";
    for (const m of content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
      out += (m[1] ?? m[2] ?? "").replace(/\\([0-9a-f]{1,6})\s?/gi, (_x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
    }
    return out;
  };
  const pseudoStandIn = (el: Element, which: "before" | "after"): HTMLElement | null => {
    if (!(el instanceof HTMLElement) || /^(IMG|INPUT|TEXTAREA|SELECT|CANVAS|VIDEO|IFRAME|BR|HR|OPTION)$/.test(el.tagName)) return null;
    const ps = getComputedStyle(el, `::${which}`);
    const content = ps.content;
    if (!content || content === "none" || content === "normal" || ps.display === "none") return null;
    const pic = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(content)?.[1];
    const text = pic ? "" : cssText(content);
    const t = document.createElement(pic ? "img" : "sl-pseudo") as HTMLElement;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      // (its look as it is now: not its animations / transitions, which would start over from their first frame)
      if (/^(animation|transition)/.test(p)) continue;
      t.style.setProperty(p, ps.getPropertyValue(p));
    }
    t.style.setProperty("content", "normal");
    if (pic) (t as HTMLImageElement).src = new URL(pic, location.href).href;
    else if (text) t.textContent = text;
    if (!pseudoSheet) {
      pseudoSheet = document.createElement("style");
      pseudoSheet.textContent = `[${PSEUDO_OFF}~="before"]::before,[${PSEUDO_OFF}~="after"]::after{content:none!important;display:none!important}`;
      (document.head || document.documentElement).appendChild(pseudoSheet);
    }
    el.setAttribute(PSEUDO_OFF, `${el.getAttribute(PSEUDO_OFF) || ""} ${which}`.trim());
    // in the flow: in its place (the text it shows reads in order); set apart (absolute / fixed): last, so the
    // children keep their places in the page's own child order (:first-child rules)
    const apart = /^(absolute|fixed)$/.test(ps.position);
    if (which === "before" && !apart) el.insertBefore(t, el.firstChild);
    else el.appendChild(t);
    if (which === "before" && apart) t.setAttribute("data-sl-fig-moved", "");
    t.setAttribute("aria-hidden", "true");
    return t;
  };

  // ── the walk ───────────────────────────────────────────────────────────────
  const elOf = new Map<FNode, Element>(); // each layer's element (stacking order)
  const visit = (el: Element, parentX: number, parentY: number): FNode | null => {
    const out = visitBox(el, parentX, parentY);
    if (out && !elOf.has(out)) elOf.set(out, el);
    return out;
  };
  const visitBox = (el: Element, parentX: number, parentY: number): FNode | null => {
    if (stats.nodes >= MAX) { stats.skipped++; return null; }
    const cs = getComputedStyle(el);
    if (!shown(el, cs) || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|HEAD|TITLE)$/.test(el.tagName)) return null;
    if (cs.display === "contents") {
      // no box of its own: its children belong to the parent
      return null;
    }
    const r = el.getBoundingClientRect();
    const rot = rotationOf(cs.transform);
    // the box before any rotation (its layout size), placed by its centre
    const w = rot ? (el as HTMLElement).offsetWidth || r.width : r.width;
    const h = rot ? (el as HTMLElement).offsetHeight || r.height : r.height;
    const cx = r.left + r.width / 2 + sx, cy = r.top + r.height / 2 + sy;
    const X = cx - w / 2, Y = cy - h / 2;
    const clips = /(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY);
    if ((w < 0.5 || h < 0.5) && !(el.childElementCount && !clips)) return null;
    stats.nodes++;
    const base: FNode = { t: "frame", n: nameOf(el), x: round(X - parentX), y: round(Y - parentY), w: round(w), h: round(h) };
    if (rot) base.rot = rot;
    const op = parseFloat(cs.opacity);
    if (op < 0.999) base.op = round(op);
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") base.blend = cs.mixBlendMode;
    if (cs.position === "absolute" || cs.position === "fixed") base.abs = true;

    // pictures and vectors
    const tag = el.tagName;
    if (tag === "IMG") {
      const img = el as HTMLImageElement;
      const src = img.currentSrc || img.src;
      if (!src) return null;
      // a vector picture (a logo, an icon): a vector in Figma, where its source can be read
      const vec = svgOfImage(src, w, h);
      if (vec) {
        stats.svgs++;
        return { ...base, t: "svg", svg: vec };
      }
      const fit = cs.objectFit === "contain" || cs.objectFit === "scale-down" ? "fit" : "fill";
      stats.images++;
      const node: FNode = { ...base, t: "image", img: imageId(src, img.naturalWidth || w, img.naturalHeight || h), fit, radius: radiiOf(cs), clip: true };
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (nw && nh && w > 0 && h > 0) {
        // object-fit: fill (the default) stretches a picture whose shape isn't its box's; a cover can be anchored
        if (cs.objectFit === "fill" && Math.abs(nw / nh - w / h) > 0.01 * (w / h)) { node.fit = "crop"; node.xf = STRETCH; }
        else if (cs.objectFit === "cover") { const xf = coverXf(w, h, nw, nh, cs.objectPosition); if (xf) { node.fit = "crop"; node.xf = xf; } }
      }
      return node;
    }
    if (tag === "svg" || el instanceof SVGSVGElement) {
      stats.svgs++;
      return { ...base, t: "svg", svg: svgText(el as SVGSVGElement) };
    }
    if (tag === "CANVAS" || tag === "VIDEO") {
      let data = "";
      try {
        if (tag === "CANVAS") data = (el as HTMLCanvasElement).toDataURL("image/png");
        else {
          const v = el as HTMLVideoElement;
          if (v.videoWidth) {
            const c = document.createElement("canvas");
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext("2d")!.drawImage(v, 0, 0);
            data = c.toDataURL("image/jpeg", 0.85);
          } else if (v.poster) data = v.poster;
        }
      } catch {
        /* tainted: drawn from another site */
      }
      if (!data) return { ...base, fills: [{ k: "solid", color: { r: 0, g: 0, b: 0, a: 1 } }] };
      stats.images++;
      return { ...base, t: "image", img: imageId(data, w, h), fit: cs.objectFit === "contain" ? "fit" : "fill" };
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      // a field: its box, and the value / placeholder it shows as text
      const f = el as HTMLInputElement;
      const node: FNode = { ...base, fills: parseBackgrounds(cs, w, h), radius: radiiOf(cs) };
      const st = strokeOf(cs);
      if (st) node.stroke = st;
      const shownText = f.value || f.placeholder || "";
      if (shownText && f.type !== "checkbox" && f.type !== "radio" && f.type !== "hidden") {
        const run = runOf(cs, null);
        if (!f.value) run.color = { ...run.color, a: round(run.color.a * 0.55) };
        node.kids = [{ t: "text", n: shownText.slice(0, 40), x: round(px(cs.paddingLeft) + px(cs.borderLeftWidth)), y: round((h - (run.lh || run.size * 1.2)) / 2), w: round(Math.max(1, w - px(cs.paddingLeft) - px(cs.paddingRight))), h: round(run.lh || run.size * 1.2), chars: shownText, runs: [{ start: 0, end: shownText.length, ...run }], align: "left" }];
      }
      return node;
    }

    const node: FNode = base;
    const fills = parseBackgrounds(cs, w, h);
    // a background that only paints the text (gradient headings) belongs to the text, not the box
    if (!/\btext\b/.test(cs.backgroundClip || "") && !/\btext\b/.test(cs.getPropertyValue("-webkit-background-clip")) && fills.length) node.fills = fills;
    const st = strokeOf(cs);
    if (st) node.stroke = st;
    const rad = radiiOf(cs);
    if (rad) node.radius = rad;
    const fx = [...parseShadows(cs.boxShadow, null)];
    const blur = /blur\(([\d.]+)px\)/.exec(cs.filter || "");
    if (blur && +blur[1] > 0) fx.push({ k: "blur", radius: +blur[1] });
    const bblur = /blur\(([\d.]+)px\)/.exec(cs.getPropertyValue("backdrop-filter") || cs.getPropertyValue("-webkit-backdrop-filter") || "");
    if (bblur && +bblur[1] > 0) fx.push({ k: "bgblur", radius: +bblur[1] });
    if (fx.length) node.effects = fx;
    if (clips) node.clip = true;

    // children: boxes as layers, runs of inline text as text layers (in the order the page has them)
    const kids: FNode[] = [];
    let inline: Node[] = [];
    const flush = () => {
      if (!inline.length) return;
      const t = textNode(inline, el, X, Y);
      if (t) kids.push(t);
      inline = [];
    };
    const take = (c: Node) => {
      if (c.nodeType === Node.TEXT_NODE) { if ((c.textContent || "").length) inline.push(c); return; }
      if (c.nodeType !== Node.ELEMENT_NODE) return;
      const ce = c as Element;
      if (ce.tagName === "BR") { inline.push(ce); return; }
      const ccs = getComputedStyle(ce);
      if (ccs.display === "contents") { for (const g of Array.from(ce.childNodes)) take(g); return; }
      if (ce instanceof HTMLElement && isInlineText(ce, ccs) && !(ce instanceof SVGElement)) {
        if (!shown(ce, ccs)) return;
        // its ::before / ::after: in the flow, part of the text; set apart (an underline bar), a layer of its own
        for (const which of ["before", "after"] as const) {
          const t = pseudoStandIn(ce, which);
          if (!t) continue;
          inlineStandIns.push([ce, t]);
          if (/^(absolute|fixed)$/.test(getComputedStyle(t).position)) { t.setAttribute("data-sl-fig-apart", ""); apartStandIns.push(t); }
        }
        inline.push(ce);
        return;
      }
      flush();
      const k = visit(ce, X, Y);
      if (k) kids.push(k);
    };
    // ::before / ::after (underlines, overlays, icons, quotes, bullets): stood in for by real elements with their
    // computed look, in their place, while this box is measured
    const before = pseudoStandIn(el, "before"), after = pseudoStandIn(el, "after");
    const inlineStandIns: [Element, HTMLElement][] = [], apartStandIns: HTMLElement[] = [];
    try {
      for (const c of Array.from(el.childNodes)) take(c);
      flush();
      for (const t of apartStandIns) {
        const k = visit(t, X, Y);
        if (k) kids.push(k);
      }
      // (a ::before set apart from the flow was put last to keep the children's order: it comes first)
      if (before && before.hasAttribute("data-sl-fig-moved")) {
        const i = kids.findIndex((k) => elOf.get(k) === before);
        if (i > 0) kids.unshift(...kids.splice(i, 1));
      }
      // what is painted above comes last (Figma: last on top) — CSS's painting order among siblings: negative
      // z-index; the flow (blocks, then inline text); positioned ones with z-index auto / 0 — and those made a layer
      // of their own by opacity, a transform or a filter — in page order; then positive z-index. (Read while the
      // pseudo-elements' stand-ins are still in the page.)
      if (kids.length > 1) {
        const order = kids.map((k, i) => ({ k, i, z: 0 }));
        for (const o of order) {
          const src = elOf.get(o.k);
          if (!src) continue;
          const zc = getComputedStyle(src);
          const z = parseInt(zc.zIndex);
          const positioned = zc.position !== "static";
          const layered = positioned || parseFloat(zc.opacity) < 1 || (zc.transform && zc.transform !== "none") || (zc.filter && zc.filter !== "none");
          o.z = positioned && !isNaN(z) && z !== 0 ? z : layered ? 0.5 : 0;
        }
        order.sort((a, b) => a.z - b.z || a.i - b.i);
        node.kids = order.map((o) => o.k);
      } else if (kids.length) node.kids = kids;
    } finally {
      for (const t of [before, after]) if (t) t.remove();
      if (before || after) el.removeAttribute(PSEUDO_OFF);
      for (const [host, t] of inlineStandIns) { t.remove(); host.removeAttribute(PSEUDO_OFF); }
    }
    tryLayout(cs, node);
    // a plain wrapper with nothing of its own around one child: the child is enough
    if (!node.fills && !node.stroke && !node.effects && !node.clip && node.op === undefined && !node.rot && !node.blend && node.kids && node.kids.length === 1 && !node.layout && el !== startEl) {
      const only = node.kids[0];
      only.x = round(only.x + node.x);
      only.y = round(only.y + node.y);
      return only;
    }
    if (!node.kids && !node.fills && !node.stroke && !node.effects) { stats.nodes--; return null; }
    return node;

    function radiiOf(c: CSSStyleDeclaration): [number, number, number, number] | undefined {
      const v: [number, number, number, number] = [px(c.borderTopLeftRadius), px(c.borderTopRightRadius), px(c.borderBottomRightRadius), px(c.borderBottomLeftRadius)];
      // percentages (a round avatar): of the box
      const pct = [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius].map((x) => /%/.test(x));
      pct.forEach((p, i) => { if (p) v[i] = (parseFloat([c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius][i]) / 100) * Math.min(w, h); });
      const cap = Math.min(w, h) / 2;
      const out = v.map((x) => round(Math.min(x, cap))) as [number, number, number, number];
      return out.some((x) => x > 0) ? out : undefined;
    }
    function strokeOf(c: CSSStyleDeclaration): FNode["stroke"] | undefined {
      const sides = ["Top", "Right", "Bottom", "Left"] as const;
      const ws = sides.map((s) => (c.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" ? 0 : px(c.getPropertyValue(`border-${s.toLowerCase()}-width`)))) as [number, number, number, number];
      if (!ws.some((x) => x > 0)) return undefined;
      const i = ws.findIndex((x) => x > 0);
      const color = parseColor(c.getPropertyValue(`border-${sides[i].toLowerCase()}-color`));
      if (!color) return undefined;
      useColor(color);
      return { color, w: ws, dash: /dash|dot/.test(c.getPropertyValue(`border-${sides[i].toLowerCase()}-style`)) };
    }
  };

  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight);
  const pageBg = parseColor(getComputedStyle(document.body).backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };
  const kids: FNode[] = [];
  for (const c of Array.from(startEl.children)) {
    const k = visit(c, 0, 0);
    if (k) kids.push(k);
  }
  // text directly in the body
  const root: FNode = { t: "frame", n: document.title || location.hostname, x: 0, y: 0, w: docW, h: docH, fills: [{ k: "solid", color: pageBg }], clip: true, kids };
  // the layers as written (wrappers folded into their one child are not layers)
  const count = (n: FNode): number => (n.kids || []).reduce((a, k) => a + count(k), 1);
  stats.nodes = kids.reduce((a, k) => a + count(k), 0);
  return {
    v: 1,
    url: location.href,
    title: document.title,
    width: docW,
    height: docH,
    root,
    images,
    fonts: Array.from(fontSet.values()),
    colors: Array.from(colorUse.values()).sort((a, b) => b.uses - a.uses).slice(0, 64),
    texts: Array.from(textUse.values()).sort((a, b) => b.uses - a.uses).slice(0, 48),
    stats,
  };
}
