// A Figma snapshot drawn back as plain HTML, the way Figma will draw the layers the StyleLift plugin builds from it:
// every layer placed where it was measured (Auto Layout frames laid out by their own rules — a wrong guess shows),
// fills stacked last-on-top, strokes inside the box, effects, text in its runs with a fixed width. The accuracy test
// puts this next to the page, pixel by pixel.
import type { FFill, FNode, FigmaSnapshot, RGBA } from "../extractor/figma-snapshot";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rgba = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

function paint(f: FFill, img: (id: string) => string): { image: string; size: string; repeat: string; pos?: string } | { color: string } {
  if (f.k === "solid") return { color: rgba(f.color) };
  if (f.k === "linear") return { image: `linear-gradient(${f.angle}deg, ${f.stops.map((s) => `${rgba(s.color)} ${Math.round(s.pos * 1000) / 10}%`).join(", ")})`, size: "100% 100%", repeat: "no-repeat" };
  const stops = (list: { pos: number; color: RGBA }[]) => list.map((s) => `${rgba(s.color)} ${Math.round(s.pos * 1000) / 10}%`).join(", ");
  const pc = (x: number) => `${Math.round(x * 10000) / 100}%`;
  if (f.k === "radial") return { image: `radial-gradient(${f.at ? `${pc(f.at.rx)} ${pc(f.at.ry)} at ${pc(f.at.cx)} ${pc(f.at.cy)}, ` : ""}${stops(f.stops)})`, size: "100% 100%", repeat: "no-repeat" };
  if (f.k === "conic") return { image: `conic-gradient(from ${Math.round(f.angle * 100) / 100}deg${f.at ? ` at ${pc(f.at.cx)} ${pc(f.at.cy)}` : ""}, ${stops(f.stops)})`, size: "100% 100%", repeat: "no-repeat" };
  const image = `url('${img(f.img).replace(/'/g, "%27")}')`;
  if (f.fit === "crop" && f.xf) {
    // the picture's 0–1 square through the inverse of the crop: its size and corner in the layer
    const [[sx, , tx], [, sy, ty]] = f.xf;
    return { image, size: `${(100 / sx).toFixed(3)}% ${(100 / sy).toFixed(3)}%`, repeat: "no-repeat", pos: `${xfPos(-tx / sx, 1 / sx)} ${xfPos(-ty / sy, 1 / sy)}` };
  }
  return { image, size: f.fit === "fit" ? "contain" : f.fit === "tile" ? "auto" : "cover", repeat: f.fit === "tile" ? "repeat" : "no-repeat", pos: f.fit === "tile" ? "0 0" : "center" };
}
// a CSS background-position (percent of the free room) for a picture starting at `start` (fraction of the box) and
// `span` box widths wide
function xfPos(start: number, span: number): string {
  const free = 1 - span;
  return Math.abs(free) < 1e-6 ? "0%" : `${((start / free) * 100).toFixed(3)}%`;
}

function boxStyle(n: FNode, img: (id: string) => string): string[] {
  const st: string[] = [];
  const fills = n.fills || [];
  // Figma: the last fill on top — CSS: the first background layer on top
  const layers: string[] = [], sizes: string[] = [], repeats: string[] = [], poss: string[] = [];
  let color = "";
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = paint(fills[i], img);
    if ("color" in p) {
      if (i === 0 && !layers.length) color = p.color;
      else if (i === 0) color = p.color;
      else { layers.push(`linear-gradient(${p.color}, ${p.color})`); sizes.push("100% 100%"); repeats.push("no-repeat"); poss.push("center"); }
    } else { layers.push(p.image); sizes.push(p.size); repeats.push(p.repeat); poss.push(p.pos || "center"); }
  }
  // (Figma tiles a picture from the layer's corner, as CSS does from the padding box's)
  if (layers.length) st.push(`background-image:${layers.join(",")}`, `background-size:${sizes.join(",")}`, `background-repeat:${repeats.join(",")}`, `background-position:${poss.join(",")}`, "background-origin:border-box");
  if (color) st.push(`background-color:${color}`);
  if (n.stroke) {
    const [t, r, b, l] = n.stroke.w;
    st.push(`border-style:${n.stroke.dash ? "dashed" : "solid"}`, `border-color:${rgba(n.stroke.color)}`, `border-width:${t}px ${r}px ${b}px ${l}px`);
  }
  if (n.ellipse) st.push("border-radius:50%");
  else if (n.radius) st.push(`border-radius:${n.radius.map((x) => x + "px").join(" ")}`);
  const shadows: string[] = [];
  for (const e of n.effects || []) {
    if (e.k === "drop" || e.k === "inner") shadows.push(`${e.k === "inner" ? "inset " : ""}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${rgba(e.color)}`);
    else if (e.k === "blur") st.push(`filter:blur(${e.radius}px)`);
    else if (e.k === "bgblur") st.push(`backdrop-filter:blur(${e.radius}px)`);
  }
  if (shadows.length) st.push(`box-shadow:${shadows.join(",")}`);
  if (n.clip) st.push("overflow:hidden");
  if (n.op !== undefined) st.push(`opacity:${n.op}`);
  if (n.blend) st.push(`mix-blend-mode:${n.blend}`);
  if (n.rot) st.push(`transform:rotate(${n.rot}deg)`);
  return st;
}

function textHtml(n: FNode): string {
  const chars = n.chars || "";
  const runs = n.runs || [];
  let out = "";
  let at = 0;
  const span = (s: string, r?: (typeof runs)[number]) => {
    if (!s) return;
    if (!r) { out += esc(s); return; }
    const st = [
      `font-family:'${r.family.replace(/'/g, "")}', Inter, sans-serif`,
      `font-weight:${r.weight}`,
      `font-style:${r.italic ? "italic" : "normal"}`,
      `font-size:${r.size}px`,
      `line-height:${r.lh === null ? "normal" : r.lh + "px"}`,
      `letter-spacing:${r.ls}px`,
    ];
    // (a gradient fill spans the whole text layer in Figma: painted once by the layer, seen through these glyphs)
    if (r.fill && r.fill.k !== "image") st.push("color:transparent");
    else st.push(`color:${rgba(r.color)}`);
    if (r.deco) st.push(`text-decoration:${r.deco === "strike" ? "line-through" : "underline"}`);
    if (r.textCase) st.push(`text-transform:${r.textCase === "upper" ? "uppercase" : r.textCase === "lower" ? "lowercase" : "capitalize"}`);
    out += `<span style="${st.join(";")}">${esc(s)}</span>`;
  };
  for (const r of runs) {
    span(chars.slice(at, r.start));
    span(chars.slice(r.start, r.end), r);
    at = r.end;
  }
  span(chars.slice(at));
  return out;
}

function node(n: FNode, img: (id: string) => string, parent: FNode | null): string {
  const inFlow = !!parent?.layout && !n.abs;
  // (Figma places children from the frame's outer corner; CSS from inside its border)
  const bl = parent?.stroke ? parent.stroke.w[3] : 0, bt = parent?.stroke ? parent.stroke.w[0] : 0;
  const st: string[] = inFlow ? ["position:relative", "flex:none"] : ["position:absolute", `left:${Math.round((n.x - bl) * 100) / 100}px`, `top:${Math.round((n.y - bt) * 100) / 100}px`];
  st.push(`width:${n.w}px`, `height:${n.h}px`, "box-sizing:border-box", "margin:0");
  if (parent?.layout?.cross === "stretch" && inFlow) st.push("align-self:stretch");
  if (n.t === "text") {
    st.push("white-space:pre-wrap", "overflow-wrap:break-word", `text-align:${n.align || "left"}`);
    const g = (n.runs || []).find((r) => r.fill && r.fill.k !== "image")?.fill;
    if (g) st.push(`background-image:${(paint(g, () => "") as { image: string }).image}`, "-webkit-background-clip:text", "background-clip:text");
    if (n.op !== undefined) st.push(`opacity:${n.op}`);
    // (a text box taller than its text, aligned to its middle or bottom: the lines sit in a column that does)
    if (n.valign && n.valign !== "top") {
      st.push("display:flex", "flex-direction:column", `justify-content:${n.valign === "center" ? "center" : "flex-end"}`);
      return `<div data-n="${esc(n.n)}" style="${st.join(";")}"><div>${textHtml(n)}</div></div>`;
    }
    return `<div data-n="${esc(n.n)}" style="${st.join(";")}">${textHtml(n)}</div>`;
  }
  if (n.t === "image") {
    st.push(...boxStyle(n, img));
    if (n.fit === "crop" && n.xf) {
      const p = paint({ k: "image", img: n.img || "", fit: "crop", xf: n.xf }, img) as { image: string; size: string; pos?: string };
      return `<div data-n="${esc(n.n)}" style="${st.join(";")}"><div style="width:100%;height:100%;background-image:${p.image};background-size:${p.size};background-position:${p.pos};background-repeat:no-repeat"></div></div>`;
    }
    return `<div data-n="${esc(n.n)}" style="${st.join(";")}"><img src="${esc(img(n.img || ""))}" style="width:100%;height:100%;display:block;object-fit:${n.fit === "fit" ? "contain" : "cover"}"></div>`;
  }
  if (n.t === "svg") {
    st.push(...boxStyle(n, img));
    return `<div data-n="${esc(n.n)}" style="${st.join(";")}">${(n.svg || "").replace(/<svg/, '<svg style="display:block;width:100%;height:100%"')}</div>`;
  }
  st.push(...boxStyle(n, img));
  if (n.layout) {
    const L = n.layout;
    st.push("display:flex", `flex-direction:${L.mode === "row" ? "row" : "column"}`, `gap:${L.gap}px`);
    // the stroke's width sits inside the padding Figma keeps: the measured padding already includes the border
    const b = n.stroke ? n.stroke.w : [0, 0, 0, 0];
    st.push(`padding:${Math.max(0, L.pad[0] - b[0])}px ${Math.max(0, L.pad[1] - b[1])}px ${Math.max(0, L.pad[2] - b[2])}px ${Math.max(0, L.pad[3] - b[3])}px`);
    st.push(`justify-content:${L.main === "between" ? "space-between" : L.main === "center" ? "center" : L.main === "end" ? "flex-end" : "flex-start"}`);
    st.push(`align-items:${L.cross === "center" ? "center" : L.cross === "end" ? "flex-end" : L.cross === "baseline" ? "baseline" : "flex-start"}`);
  }
  const kids = (n.kids || []).map((k) => node(k, img, n)).join("");
  return `<div data-n="${esc(n.n)}" style="${st.join(";")}">${kids}</div>`;
}

/** The snapshot as a page that draws it the way Figma will. With `page`, a web page made from a Figma design: the
 *  design centred on wider screens, its background filling the window, its Google fonts linked, its title. */
export function renderFigmaHtml(snap: FigmaSnapshot, img: (id: string) => string, opts: { page?: boolean } = {}): string {
  const root = snap.root;
  const body = node({ ...root, x: 0, y: 0 }, img, null);
  if (!opts.page) return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{width:${snap.width}px;height:${snap.height}px;position:relative;overflow:hidden}</style></head><body>${body}</body></html>`;
  const bg = (root.fills || []).find((f) => f.k === "solid") as { color: RGBA } | undefined;
  // the families by their weights and slants, as Google Fonts takes them (a family it doesn't have is simply ignored)
  const fam = new Map<string, Set<string>>();
  for (const f of snap.fonts) {
    if (/^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-.*)$/i.test(f.family)) continue;
    let set = fam.get(f.family);
    if (!set) fam.set(f.family, (set = new Set()));
    set.add(`${f.italic ? 1 : 0},${Math.round(f.weight / 100) * 100 || 400}`);
  }
  const fontsLink = fam.size
    ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...fam].map(([f, set]) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@${[...set].sort().join(";")}`).join("&")}&display=swap">`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(snap.title || "Page")}</title>${fontsLink}<style>html,body{margin:0;padding:0}body{background:${bg ? rgba(bg.color) : "#fff"};overflow-x:hidden}.sl-design{position:relative;width:${snap.width}px;height:${snap.height}px;margin:0 auto}</style></head><body><div class="sl-design">${body}</div></body></html>`;
}
