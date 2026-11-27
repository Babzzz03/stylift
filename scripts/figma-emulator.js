// A stand-in for Figma's plugin API, in a test browser page: the StyleLift plugin (figma-plugin/dist/code.js, as
// shipped) runs against it, and the layers it builds are drawn the way Figma draws them — frames placed from their
// outer corner, strokes inside and over the content, fills stacked last-on-top, gradients from their
// gradientTransform, Auto Layout by its own rules, text laid out from its own properties (fixed width or hugging).
// It fails the way Figma fails where it matters: text in a font that wasn't loaded, sizes under 0.01, layout
// properties on a child of a frame without Auto Layout.
//   window.runPlugin(snapshot, { fonts }) → { layers, missingFonts, variables, styles, images }
(() => {
  const loaded = new Set();
  const fontKey = (f) => `${f.family}|${f.style}`;
  const styleWeight = (style) => {
    const s = style.toLowerCase().replace(/[\s_-]+/g, "");
    const italic = /italic|oblique/.test(s);
    const weight = /hairline|thin/.test(s) ? 100 : /(extra|ultra)light/.test(s) ? 200 : /light/.test(s) ? 300 : /(semi|demi)bold/.test(s) ? 600 : /(extra|ultra)bold/.test(s) ? 800 : /black|heavy/.test(s) ? 900 : /bold/.test(s) ? 700 : /medium/.test(s) ? 500 : 400;
    return { weight, italic };
  };
  const fail = (m) => { throw new Error(m); };
  const images = new Map(); // hash → object URL
  let nextId = 1;

  class Base {
    constructor(type) { this.type = type; this.id = `${nextId++}:1`; this.name = type; this.parent = null; this.x = 0; this.y = 0; this.width = 100; this.height = 100; this.opacity = 1; this.blendMode = "PASS_THROUGH"; this.rot = null; this._layoutAlign = "INHERIT"; this._layoutPositioning = "AUTO"; }
    resize(w, h) { if (!(w >= 0.01 && h >= 0.01)) fail(`resize(${w}, ${h}): sizes must be at least 0.01`); this.width = w; this.height = h; }
    set relativeTransform(m) { this.rot = m; this.x = m[0][2]; this.y = m[1][2]; }
    get relativeTransform() { return this.rot || [[1, 0, this.x], [0, 1, this.y]]; }
    _inLayout() { return this.parent && this.parent.layoutMode && this.parent.layoutMode !== "NONE"; }
    set layoutAlign(v) { if (!this._inLayout() && v !== "INHERIT") fail("layoutAlign set on a layer whose parent has no Auto Layout"); this._layoutAlign = v; }
    get layoutAlign() { return this._layoutAlign; }
    set layoutPositioning(v) { if (!this._inLayout()) fail("layoutPositioning set on a layer whose parent has no Auto Layout"); this._layoutPositioning = v; }
    get layoutPositioning() { return this._layoutPositioning; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  }
  class Frame extends Base {
    constructor() {
      super("FRAME"); this.children = []; this.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }]; this.strokes = []; this.strokeWeight = 1; this.strokeAlign = "INSIDE"; this.dashPattern = [];
      this.topLeftRadius = this.topRightRadius = this.bottomRightRadius = this.bottomLeftRadius = 0; this.effects = []; this.clipsContent = true;
      this.layoutMode = "NONE"; this.itemSpacing = 0; this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0; this.primaryAxisAlignItems = "MIN"; this.counterAxisAlignItems = "MIN"; this.primaryAxisSizingMode = "AUTO"; this.counterAxisSizingMode = "AUTO";
    }
    set strokeTopWeight(v) { this._sides = { ...(this._sides || this._uniform()), t: v }; }
    set strokeRightWeight(v) { this._sides = { ...(this._sides || this._uniform()), r: v }; }
    set strokeBottomWeight(v) { this._sides = { ...(this._sides || this._uniform()), b: v }; }
    set strokeLeftWeight(v) { this._sides = { ...(this._sides || this._uniform()), l: v }; }
    _uniform() { return { t: this.strokeWeight, r: this.strokeWeight, b: this.strokeWeight, l: this.strokeWeight }; }
    appendChild(n) { n.remove(); this.children.push(n); n.parent = this; }
  }
  class Text extends Base {
    constructor() { super("TEXT"); this._chars = ""; this._ranges = []; this._font = { family: "Inter", style: "Regular" }; this.textAlignHorizontal = "LEFT"; this.textAutoResize = "NONE"; this.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }]; }
    set fontName(f) { if (!loaded.has(fontKey(f))) fail(`fontName: “${fontKey(f)}” wasn't loaded`); this._font = f; }
    get fontName() { return this._font; }
    set characters(s) { if (!loaded.has(fontKey(this._font))) fail(`characters: the font “${fontKey(this._font)}” wasn't loaded`); this._chars = s; this._ranges = []; }
    get characters() { return this._chars; }
    _set(a, b, k, v) { if (a < 0 || b > this._chars.length || b <= a) fail(`setRange ${k}(${a}, ${b}) outside the text (${this._chars.length})`); this._ranges.push({ a, b, k, v }); }
    setRangeFontName(a, b, f) { if (!loaded.has(fontKey(f))) fail(`setRangeFontName: “${fontKey(f)}” wasn't loaded`); this._set(a, b, "font", f); }
    setRangeFontSize(a, b, v) { this._set(a, b, "size", v); }
    setRangeLineHeight(a, b, v) { this._set(a, b, "lh", v); }
    setRangeLetterSpacing(a, b, v) { this._set(a, b, "ls", v); }
    setRangeFills(a, b, v) { this._set(a, b, "fills", v); }
    setRangeTextDecoration(a, b, v) { this._set(a, b, "deco", v); }
    setRangeTextCase(a, b, v) { this._set(a, b, "case", v); }
    setRangeHyperlink(a, b, v) { this._set(a, b, "link", v); }
    // Figma lays the text out to know its size: so does this, from the same properties
    get width() { return this.textAutoResize === "WIDTH_AND_HEIGHT" ? measure(this).w : this._w; }
    set width(v) { this._w = v; }
    get height() { return this.textAutoResize === "NONE" ? this._h : measure(this).h; }
    set height(v) { this._h = v; }
    resize(w, h) { if (!(w >= 0.01 && h >= 0.01)) fail(`resize(${w}, ${h})`); if (this.textAutoResize === "WIDTH_AND_HEIGHT") this.textAutoResize = "NONE"; this._w = w; this._h = h; }
  }

  // ── drawing ───────────────────────────────────────────────────────────────────
  const rgba = (c, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${(c.a ?? 1) * a})`;
  const inv = (m) => {
    const [[a, b, c], [d, e, f]] = m;
    const det = a * e - b * d || 1e-9;
    return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
  };
  let gid = 0;
  // a paint as an SVG layer of the box: gradients in the layer's own 0–1 space through the inverse of their
  // gradientTransform (Figma's handles), pictures by their scale mode
  function paintLayer(p, w, h) {
    if (p.visible === false) return "";
    const op = p.opacity ?? 1;
    if (p.type === "SOLID") return `<rect width="${w}" height="${h}" fill="${rgba(p.color, op)}"/>`;
    if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
      const id = `g${++gid}`;
      const t = inv(p.gradientTransform);
      const tf = `matrix(${t[0][0]} ${t[1][0]} ${t[0][1]} ${t[1][1]} ${t[0][2]} ${t[1][2]})`;
      const stops = p.gradientStops.map((s) => `<stop offset="${s.position}" stop-color="${rgba({ ...s.color, a: 1 })}" stop-opacity="${s.color.a * op}"/>`).join("");
      const def = p.type === "GRADIENT_LINEAR"
        ? `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="${tf}">${stops}</linearGradient>`
        : `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" r="0.5" gradientTransform="${tf}">${stops}</radialGradient>`;
      return `<defs>${def}</defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`;
    }
    if (p.type === "IMAGE") {
      const url = images.get(p.imageHash);
      if (!url) return "";
      if (p.scaleMode === "TILE") {
        const id = `p${++gid}`;
        const im = imageSize.get(p.imageHash) || { w: 16, h: 16 };
        const s = p.scalingFactor || 1;
        return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${im.w * s}" height="${im.h * s}"><image href="${url}" width="${im.w * s}" height="${im.h * s}"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#${id})" opacity="${op}"/>`;
      }
      if (p.scaleMode === "CROP") {
        // the picture's 0–1 square, through the inverse of imageTransform, in the layer's pixels
        const t = inv(p.imageTransform || [[1, 0, 0], [0, 1, 0]]);
        return `<image href="${url}" x="${t[0][2] * w}" y="${t[1][2] * h}" width="${t[0][0] * w}" height="${t[1][1] * h}" preserveAspectRatio="none" opacity="${op}"/>`;
      }
      const ar = p.scaleMode === "FIT" ? "xMidYMid meet" : "xMidYMid slice";
      return `<image href="${url}" width="${w}" height="${h}" preserveAspectRatio="${ar}" opacity="${op}"/>`;
    }
    return "";
  }
  const radiusCss = (n) => `${n.topLeftRadius}px ${n.topRightRadius}px ${n.bottomRightRadius}px ${n.bottomLeftRadius}px`;
  function placeCss(n, flowChild) {
    const st = [];
    if (flowChild) st.push("position:relative", "flex:none");
    else if (n.rot) {
      const m = n.rot;
      st.push("position:absolute", "left:0", "top:0", "transform-origin:0 0", `transform:matrix(${m[0][0]},${m[1][0]},${m[0][1]},${m[1][1]},${m[0][2]},${m[1][2]})`);
    } else st.push("position:absolute", `left:${n.x}px`, `top:${n.y}px`);
    if (flowChild && n.layoutAlign === "STRETCH") st.push("align-self:stretch");
    if (n.opacity !== 1) st.push(`opacity:${n.opacity}`);
    const bm = { MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity" }[n.blendMode];
    if (bm) st.push(`mix-blend-mode:${bm}`);
    return st;
  }
  function textInner(t) {
    const N = t._chars.length;
    const at = Array.from({ length: N }, () => ({}));
    for (const r of t._ranges) for (let i = r.a; i < r.b; i++) at[i][r.k] = r.v;
    let out = "";
    let i = 0;
    while (i < N) {
      let j = i + 1;
      while (j < N && JSON.stringify(at[j]) === JSON.stringify(at[i])) j++;
      const s = at[i];
      const f = s.font || t._font;
      const fw = styleWeight(f.style);
      const fills = s.fills || t.fills;
      const st = [`font-family:'${f.family}'`, `font-weight:${fw.weight}`, `font-style:${fw.italic ? "italic" : "normal"}`, `font-size:${s.size || 12}px`];
      st.push(`line-height:${s.lh && s.lh.unit === "PIXELS" ? s.lh.value + "px" : "normal"}`, `letter-spacing:${s.ls ? s.ls.value : 0}px`);
      const solid = fills.find((p) => p.type === "SOLID");
      if (fills.some((p) => p.type !== "SOLID")) st.push("color:transparent");
      else if (solid) st.push(`color:${rgba(solid.color, solid.opacity ?? 1)}`);
      if (s.deco && s.deco !== "NONE") st.push(`text-decoration:${s.deco === "UNDERLINE" ? "underline" : "line-through"}`);
      if (s.case && s.case !== "ORIGINAL") st.push(`text-transform:${s.case === "UPPER" ? "uppercase" : s.case === "LOWER" ? "lowercase" : "capitalize"}`);
      out += `<span style="${st.join(";")}">${t._chars.slice(i, j).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
      i = j;
    }
    return out;
  }
  function textCss(t) {
    const st = ["white-space:pre-wrap", "overflow-wrap:break-word", `text-align:${{ LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" }[t.textAlignHorizontal]}`];
    if (t.textAutoResize === "WIDTH_AND_HEIGHT") st.push("white-space:pre", "width:max-content");
    else st.push(`width:${t._w}px`);
    if (t.textAutoResize === "NONE") st.push(`height:${t._h}px`);
    // a gradient across the text layer, seen through the glyphs
    const g = t._ranges.filter((r) => r.k === "fills").map((r) => r.v.find((p) => p.type !== "SOLID")).find(Boolean);
    return { st, g };
  }
  let meter = null;
  function measure(t) {
    if (!meter) { meter = document.createElement("div"); meter.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden"; document.body.appendChild(meter); }
    const { st } = textCss(t);
    meter.innerHTML = `<div style="${st.join(";")}">${textInner(t)}</div>`;
    const r = meter.firstChild.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function draw(n, parent) {
    const flow = !!parent && parent.layoutMode !== "NONE" && n.layoutPositioning !== "ABSOLUTE";
    const st = placeCss(n, flow);
    // STRETCH (Figma): the child takes its Auto Layout parent's inner size across — over its own
    let W = n.width, H = n.height;
    if (flow && n.layoutAlign === "STRETCH") {
      if (parent.layoutMode === "VERTICAL") W = parent.width - parent.paddingLeft - parent.paddingRight;
      else H = parent.height - parent.paddingTop - parent.paddingBottom;
    }
    if (n.type === "TEXT") {
      const { st: ts0, g } = textCss(n);
      const ts = W !== n.width ? ts0.map((x) => (x.startsWith("width:") && !x.includes("max-content") ? `width:${W}px` : x)) : ts0;
      const inner = textInner(n);
      if (g) {
        // (the gradient spans the layer, seen through the glyphs)
        const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">${paintLayer(g, 100, 100)}</svg>`;
        ts.push(`background-image:url('data:image/svg+xml,${encodeURIComponent(bg)}')`, "background-size:100% 100%", "-webkit-background-clip:text", "background-clip:text");
      }
      return `<div data-n="${esc(n.name)}" style="${[...st, ...ts].join(";")}">${inner}</div>`;
    }
    st.push(`width:${W}px`, `height:${H}px`, "box-sizing:border-box");
    const fx = [];
    for (const e of n.effects || []) {
      if (e.visible === false) continue;
      // (Figma drops a shadow's spread unless the frame clips its content and shows a fill)
      const spreadOk = n.clipsContent && (n.fills || []).some((p) => p.visible !== false);
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") fx.push(`${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${spreadOk ? e.spread || 0 : 0}px ${rgba(e.color)}`);
      else if (e.type === "LAYER_BLUR") st.push(`filter:blur(${e.radius}px)`);
      else if (e.type === "BACKGROUND_BLUR") st.push(`backdrop-filter:blur(${e.radius}px)`);
    }
    st.push(`border-radius:${radiusCss(n)}`);
    const outer = fx.filter((s) => !s.startsWith("inset"));
    if (outer.length) st.push(`box-shadow:${outer.join(",")}`);
    if (n.layoutMode !== "NONE") {
      st.push("display:flex", `flex-direction:${n.layoutMode === "HORIZONTAL" ? "row" : "column"}`, `gap:${n.itemSpacing}px`, `padding:${n.paddingTop}px ${n.paddingRight}px ${n.paddingBottom}px ${n.paddingLeft}px`);
      st.push(`justify-content:${{ MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" }[n.primaryAxisAlignItems]}`, `align-items:${{ MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" }[n.counterAxisAlignItems]}`);
    }
    // fills under everything, clipped to the corners; inner shadows over the fills
    const svg = (n.fills || []).map((p) => paintLayer(p, W, H)).join("");
    const insets = fx.filter((s) => s.startsWith("inset"));
    const under = `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;border-radius:${radiusCss(n)};overflow:hidden"><svg width="${W}" height="${H}" style="display:block;position:absolute;left:0;top:0">${svg}</svg>${insets.length ? `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;border-radius:${radiusCss(n)};box-shadow:${insets.join(",")}"></div>` : ""}</div>`;
    // a vector frame: Figma scales what createNodeFromSvg made with the frame
    const vec = n._svg ? n._svg.replace(/<svg/, `<svg preserveAspectRatio="none" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible"`) : "";
    const kids = n.children.map((k) => draw(k, n)).join("");
    // children over the fills — clipped to the frame's shape when it clips
    const body = n.clipsContent ? `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;border-radius:${radiusCss(n)};overflow:hidden;${n.layoutMode !== "NONE" ? st.filter((s) => /^(display|flex-direction|gap|padding|justify-content|align-items):/.test(s)).join(";") + ";box-sizing:border-box" : ""}">${kids}</div>` : kids;
    // strokes inside the box, over the content
    let stroke = "";
    if ((n.strokes || []).length) {
      const s = n._sides || n._uniform();
      const p = n.strokes[0];
      stroke = `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;box-sizing:border-box;border-radius:${radiusCss(n)};border-style:${n.dashPattern.length ? "dashed" : "solid"};border-color:${rgba(p.color, p.opacity ?? 1)};border-width:${s.t}px ${s.r}px ${s.b}px ${s.l}px;pointer-events:none"></div>`;
    }
    const style = n.clipsContent ? st.filter((x) => !/^(display|flex-direction|gap|padding|justify-content|align-items):/.test(x)) : st;
    // (a frame passes its children's blend modes through to what's under it — Figma's PASS_THROUGH — unless it has a
    // blend mode of its own)
    const iso = n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL" ? ";isolation:isolate" : "";
    return `<div data-n="${esc(n.name)}" style="${style.join(";")}${iso}">${under}${vec}${body}${stroke}</div>`;
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const imageSize = new Map();

  // ── the API ───────────────────────────────────────────────────────────────────
  window.runPlugin = async (snap, opts = {}) => {
    const fontList = opts.fonts || [];
    const page = { type: "PAGE", children: [], appendChild(n) { n.remove(); this.children.push(n); n.parent = this; } };
    let handler = null, done = null;
    const replies = [];
    const vars = { collections: 0, variables: 0 }, styles = [];
    const make = (n) => { page.appendChild(n); return n; };
    window.figma = {
      showUI() {}, notify() {},
      ui: { set onmessage(f) { handler = f; }, postMessage(m) { replies.push(m); if (m.type === "done" || m.type === "error") done?.(m); } },
      currentPage: page,
      viewport: { scrollAndZoomIntoView() {} },
      createFrame: () => make(new Frame()),
      createText: () => make(new Text()),
      createNodeFromSvg(svg) {
        const f = make(new Frame());
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (doc.querySelector("parsererror")) fail("createNodeFromSvg: not an SVG Figma can read");
        const el = doc.documentElement;
        f.resize(parseFloat(el.getAttribute("width")) || 100, parseFloat(el.getAttribute("height")) || 100);
        f.fills = [];
        f._svg = svg; f._svgW = f.width; f._svgH = f.height;
        return f;
      },
      createImage(bytes) {
        // (Figma takes PNG, JPEG and GIF)
        const b = bytes;
        const kind = b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpeg" : b[0] === 0x47 && b[1] === 0x49 ? "gif" : "";
        if (!kind) fail("createImage: Figma takes PNG, JPEG or GIF only");
        const hash = `h${images.size + 1}`;
        const url = URL.createObjectURL(new Blob([bytes]));
        images.set(hash, url);
        return { hash };
      },
      async loadFontAsync(f) {
        if (!fontList.some((x) => x.family === f.family && x.style === f.style)) fail(`loadFontAsync: Figma has no “${fontKey(f)}”`);
        loaded.add(fontKey(f));
      },
      async listAvailableFontsAsync() { return fontList.map((fontName) => ({ fontName })); },
      variables: {
        createVariableCollection() { vars.collections++; return { modes: [{ modeId: "m1" }] }; },
        createVariable(name, _c, type) { if (type !== "COLOR") fail("variable type"); vars.variables++; return { name, setValueForMode(_m, v) { if (!(v.r >= 0 && v.r <= 1)) fail("colour out of range"); } }; },
      },
      createTextStyle() { const s = {}; styles.push(s); return s; },
    };
    window.__html__ = "";
    // the pictures, as the bundle carries them; their sizes (for tiles)
    const bytes = {};
    // tiled pictures keep their own size (Figma tiles at it)
    const tiles = new Set();
    const walkT = (n) => { for (const f of n.fills || []) if (f.k === "image" && f.fit === "tile") tiles.add(f.img); for (const k of n.kids || []) walkT(k); };
    walkT(snap.root);
    for (const im of snap.images) {
      try {
        const r = await fetch(im.url);
        let b = new Uint8Array(await r.arrayBuffer());
        // packed the way the extension packs a bundle's pictures
        if (window.slPrepare) {
          const out = await window.slPrepare(b, r.headers.get("content-type") || "", im.w, im.h, tiles.has(im.id));
          if (!out) continue;
          b = out.data;
        }
        bytes[im.id] = b;
        const bmp = await createImageBitmap(new Blob([b]));
        imageSize.set(`h${Object.keys(bytes).length}`, { w: bmp.width, h: bmp.height });
      } catch { /* a picture that didn't load */ }
    }
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = opts.code || "/plugin/code.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const result = new Promise((r) => (done = r));
    handler({ type: "import", snap, images: bytes, variables: true });
    const out = await result;
    if (out.type === "error") throw new Error(out.message);
    // the root frame, drawn at the page's top-left
    const root = page.children[page.children.length - 1];
    const html = draw({ ...root, x: 0, y: 0, rot: null, children: root.children, _uniform: root._uniform, _sides: root._sides }, null);
    const stage = document.createElement("div");
    stage.style.cssText = "position:absolute;left:0;top:0";
    stage.innerHTML = html;
    document.body.appendChild(stage);
    let svgs = 0;
    const walk = (n) => { if (n._svg) svgs++; for (const k of n.children || []) walk(k); };
    walk(root);
    return { ...out, collections: vars.collections, textStyles: styles.length, rootName: root.name, rootX: root.x, svgs };
  };
})();
