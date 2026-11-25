// StyleLift Studio — a Framer-style editor for captured pages.
//
// Canvas: the page at Desktop / Tablet / Phone side by side (same-origin srcdoc
// iframes, so the studio drives them directly — no script runs inside the page).
// Layers: the canonical document's tree, named like the designer named it.
// Properties: edits go to the breakpoint you are editing (Desktop = base,
// Tablet / Phone override below their widths) and compile to one stylesheet.
// Text, links, images and structure are edited on the canonical document and
// mirrored into every artboard by data-sl-id.

import { MODEL_VIEWER_SRC } from "../shared/model-viewer";
import {
  ID_ATTR,
  PROPERTY_SECTIONS,
  SCOPES,
  assignIds,
  buildExportHtml,
  editsToCss,
  effectiveEdit,
  layerKind,
  layerName,
  maxId,
  mergedEdits,
  resolveViewportUnits,
  resolveViewportUnitsInHtml,
  setEdit,
  toHex,
  type LayerKind,
  type Scope,
  type StyleEdits,
} from "./model";
import { deleteProject, getPage, getProject, getScenes, listProjects, savePage, saveProject, type SceneFiles, type StudioProject } from "../shared/projects";
import { addIslandTag, hasIslands, islandAttrs } from "../panel/islands";
import { startFrameInterception, startPreview, type FrameSession } from "../panel/preview";
import { buildHtmlProject, buildSiteProject, type FileMap } from "../panel/project";
import { buildNextProject, buildNextSiteProject, buildReactViteProject } from "../panel/react-project";
import { buildElementorTemplate } from "../panel/elementor";
import { inlineFontFaces, inlineForOffline } from "../panel/offline";
import { downloadBlob, downloadZip, fetchText, makeByteFetcher, makeDataFetcher } from "../panel/export-helpers";
import { icon, type IconName } from "../shared/icons";
import { closeMenu, menuOpen, openMenu, type MenuEntry } from "./menu";
import { htmlToJsx } from "../panel/jsx";
import { EASES, ENTER_FX, HOVER_FX, LOOP_FX, MOTION_KEYS, TRIGGERS, defaultMotion, effectsFor, isMotionProp, motionToProps, readMotion, splitWords, type Motion, type MotionOn } from "./motion";
import { DEFAULT_GRIDS, formatTranslate, gridColumns, gridLines, measureBetween, parseTranslate, snapBox, type Box, type GridSpec, type Guide } from "./align";

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  project: null as StudioProject | null,
  doc: null as Document | null, // canonical document
  edits: {} as StyleEdits,
  scope: "base" as Scope,
  sel: null as string | null,
  multi: [] as string[], // further selected layers (shift-click, marquee, ⌘A); S.sel is the first
  zoom: 0.4,
  animations: false,
  expanded: new Set<string>(),
  search: "",
  history: [] as { html: string; edits: StyleEdits }[],
  future: [] as { html: string; edits: StyleEdits }[],
  html: "", // serialized canonical doc at the current history point
  frames: new Map<Scope, HTMLIFrameElement>(),
  /** the page open in a whole-site project, and each page's own undo history */
  page: 0,
  pageHistory: new Map<number, { history: { html: string; edits: StyleEdits }[]; future: { html: string; edits: StyleEdits }[] }>(),
};
const isSite = () => !!S.project?.pageList?.length;
// canvas tools (kept per browser): how dragging moves things, the layout grid, snapping
const UI = (() => {
  const d = { mode: "free" as "reorder" | "free", grid: false, snap: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem("sl-studio-ui") || "{}") };
  } catch {
    return d;
  }
})();
function saveUI(): void {
  try {
    localStorage.setItem("sl-studio-ui", JSON.stringify(UI));
  } catch {
    /* private window */
  }
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const stage = $<HTMLDivElement>("#stage");
const canvas = $<HTMLElement>("#canvas");
const layersEl = $<HTMLDivElement>("#layers");
const propsEl = $<HTMLDivElement>("#props");
const homeEl = $<HTMLDivElement>("#home");

function toast(msg: string, error = false): void {
  const t = $<HTMLDivElement>("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => (t.hidden = true), error ? 6000 : 3200);
}

// ── icons + tooltips ──────────────────────────────────────────────────────────
/** Fill every [data-icon] placeholder in the static markup with its icon. */
function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    if (el.querySelector(":scope > svg.ico")) return;
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon as IconName, Number(el.dataset.iconSize) || 16));
  });
}
// One tooltip for the whole app (title= tooltips are slow, unstyled and clipped by nothing we control):
// the label, plus the keyboard shortcut when there is one.
const tipEl = document.getElementById("tip") as HTMLDivElement;
let tipFor: HTMLElement | null = null;
let tipTimer = 0;
function hideTip(): void {
  clearTimeout(tipTimer);
  tipEl.hidden = true;
}
function showTip(t: HTMLElement): void {
  if (!t.isConnected) return;
  tipEl.replaceChildren(document.createTextNode(t.dataset.tip || ""));
  if (t.dataset.key) {
    const k = document.createElement("kbd");
    k.textContent = t.dataset.key;
    tipEl.appendChild(k);
  }
  tipEl.hidden = false;
  const r = t.getBoundingClientRect();
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 8;
  if (y + h > innerHeight - 8) y = r.top - h - 8;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
}
document.addEventListener("mouseover", (e) => {
  const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
  if (t === tipFor) return;
  tipFor = t;
  hideTip();
  if (t) tipTimer = window.setTimeout(() => showTip(t), tipEl.hidden ? 450 : 0);
});
document.addEventListener("mousedown", hideTip, true);
document.addEventListener("scroll", hideTip, true);
window.addEventListener("blur", hideTip);
function setSaveState(kind: "saving" | "saved" | "error"): void {
  const el = $<HTMLSpanElement>("#save-state");
  el.className = "save-state " + kind;
  el.innerHTML = kind === "saving" ? `<span class="dot"></span>Saving…` : kind === "saved" ? `${icon("check", 14)}Saved` : `${icon("close", 14)}Not saved`;
}
const serialize = (d: Document) => "<!doctype html>\n" + d.documentElement.outerHTML;
const byId = (d: Document, id: string) => d.querySelector(`[${ID_ATTR}="${CSS.escape(id)}"]`);

// ── persistence + history ─────────────────────────────────────────────────────
let saveTimer = 0;
function scheduleSave(): void {
  if (!S.project) return;
  setSaveState("saving");
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 600);
}
/** Write the open page now (a site project writes only that page, plus which page is open). */
async function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  if (!S.project || !S.doc) return;
  try {
    if (isSite()) {
      await savePage(S.project.id, S.page, { html: S.html, edits: S.edits });
      S.project = { ...S.project, page: S.page };
    } else S.project = { ...S.project, html: S.html, edits: S.edits };
    await saveProject(S.project);
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
    toast("Could not save the project: " + (e instanceof Error ? e.message : String(e)), true);
  }
}
/** Record the state before a change. Call commit() after the change. */
function checkpoint(): void {
  S.history.push({ html: S.html, edits: S.edits });
  if (S.history.length > 80) S.history.shift();
  S.future = [];
}
function commit(contentChanged: boolean): void {
  if (contentChanged && S.doc) S.html = serialize(S.doc);
  applyEditCss();
  refreshOverlays();
  scheduleSave();
  syncUndo();
}
function restore(state: { html: string; edits: StyleEdits }): void {
  const htmlChanged = state.html !== S.html;
  S.edits = state.edits;
  if (htmlChanged) {
    S.html = state.html;
    S.doc = new DOMParser().parseFromString(state.html, "text/html");
    renderFrames();
  } else applyEditCss();
  if (S.sel && S.doc && !byId(S.doc, S.sel)) S.sel = null;
  renderLayers();
  renderProps();
  scheduleSave();
  syncUndo();
}
function undo(): void {
  const prev = S.history.pop();
  if (!prev) return;
  S.future.push({ html: S.html, edits: S.edits });
  restore(prev);
}
function redo(): void {
  const next = S.future.pop();
  if (!next) return;
  S.history.push({ html: S.html, edits: S.edits });
  restore(next);
}
function syncUndo(): void {
  $<HTMLButtonElement>("#undo-btn").disabled = !S.history.length;
  $<HTMLButtonElement>("#redo-btn").disabled = !S.future.length;
}

// ── canvas ────────────────────────────────────────────────────────────────────
const EDITOR_CSS = `
[data-sl-hover] { outline: 1px solid #3b82f6 !important; outline-offset: -1px !important; }
[data-sl-sel] { outline: 2px solid #3b82f6 !important; outline-offset: -2px !important; }
[contenteditable="true"] { outline: 2px dashed #3b82f6 !important; cursor: text !important; }
/* the artboards run no scripts, and Chrome then shows its own controls on every video: not the page's look */
video::-webkit-media-controls, video::-webkit-media-controls-enclosure, video::-webkit-media-controls-panel { display: none !important; }
/* a live 3D scene: its picture stands in here; the site's own code runs it in Preview and the exports */
[data-sl-island]:not([data-sl-sel]) { outline: 2px dashed rgba(124, 58, 237, .6) !important; outline-offset: -2px; }
[data-sl-sel]:not([contenteditable="true"]) { cursor: grab !important; }
html[data-sl-dragging], html[data-sl-dragging] * { cursor: grabbing !important; user-select: none !important; }
[data-sl-drag] { opacity: 0.45 !important; }
html[data-sl-resizing], html[data-sl-resizing] * { cursor: var(--sl-cursor) !important; user-select: none !important; }
html[data-sl-tool="draw"], html[data-sl-tool="draw"] * { cursor: crosshair !important; }
html[data-sl-tool="text"], html[data-sl-tool="text"] * { cursor: text !important; }
html { scrollbar-width: thin; }`;
// Animations off = every animation finished at once: the page as it looks once loaded. (Removing them
// would leave anything a site fades in with fill-mode forwards invisible, and a preloader that fades
// out on top.) Studio's own motion rules are more specific, so they still play.
const NO_ANIM_CSS = `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; }`;

function frameDoc(sc: Scope): Document | null {
  return S.frames.get(sc)?.contentDocument || null;
}
function forEachFrame(fn: (d: Document, sc: Scope) => void): void {
  for (const sc of SCOPES) {
    const d = frameDoc(sc.id);
    if (d && d.documentElement) fn(d, sc.id);
  }
}
function applyEditCss(): void {
  const css = editsToCss(S.edits, { motionGuard: false }); // the editor always shows motion
  forEachFrame((d, scId) => {
    const sz = sizeOf(scId);
    let st = d.getElementById("__sl_studio_edits") as HTMLStyleElement | null;
    if (!st) {
      st = d.createElement("style");
      st.id = "__sl_studio_edits";
      st.setAttribute("data-sl-editor", "");
      (d.head || d.documentElement).appendChild(st);
    }
    st.textContent = resolveViewportUnits(css, sz.w, sz.h);
  });
}
function applyAnimToggle(): void {
  forEachFrame((d) => {
    let st = d.getElementById("__sl_studio_noanim");
    if (!S.animations && !st) {
      st = d.createElement("style");
      st.id = "__sl_studio_noanim";
      st.setAttribute("data-sl-editor", "");
      st.textContent = NO_ANIM_CSS;
      (d.head || d.documentElement).appendChild(st);
    } else if (S.animations && st) st.remove();
  });
}
/**
 * The page as an artboard shows it: viewport units resolved for that screen, and embedded players
 * pictured at capture (Vimeo, YouTube…) shown as that picture. Artboards run no scripts, so a player
 * can't play there. Its picture is the frame element's own background (painted by the artboard
 * itself); the frame gets an empty, transparent page, never the player, since a page inside it may
 * paint over the picture or, nested in an artboard, not be painted at all until its frame moves.
 * The document, Preview and every export keep the embed exactly as it was.
 */
function artboardHtml(html: string, w: number, h: number): string {
  const shown = html.replace(/<iframe\b[^>]*\sdata-sl-poster\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\s(src|srcdoc)=("[^"]*"|'[^']*')/gi, "")
      .replace(/^<iframe\b/i, '<iframe srcdoc="<meta name=color-scheme content=light><style>html,body{background:transparent}</style>"')
      .replace(/\sstyle="/i, ' style="color-scheme: light; '),
  );
  return resolveViewportUnitsInHtml(shown, w, h);
}
function renderFrames(): void {
  stage.replaceChildren();
  S.frames.clear();
  const html = S.html;
  for (const sc of SCOPES) {
    const ab = document.createElement("div");
    ab.className = "artboard" + (sc.id === S.scope ? " active" : "");
    ab.dataset.scope = sc.id;
    const sz = sizeOf(sc.id);
    const label = document.createElement("div");
    label.className = "ab-label";
    label.innerHTML = `<span class="ab-name"></span><span class="ab-size"></span>`;
    label.querySelector(".ab-name")!.textContent = sc.label;
    label.addEventListener("click", () => setScope(sc.id));
    const f = document.createElement("iframe");
    f.width = String(sz.w);
    f.height = String(sz.h);
    f.title = `${sc.label} artboard`;
    f.setAttribute("sandbox", "allow-same-origin"); // no scripts inside the page
    f.setAttribute("scrolling", "no");
    // full-height artboard: viewport units resolved against this breakpoint's screen
    f.srcdoc = artboardHtml(html, sz.w, sz.h);
    f.addEventListener("load", () => wireFrame(f, sc.id));
    // resize: drag the right edge (width) or the fold line (the screen height 100vh is measured against)
    const box = document.createElement("div");
    box.className = "ab-frame";
    const grid = document.createElement("div");
    grid.className = "ab-grid";
    grid.setAttribute("aria-hidden", "true");
    const fold = document.createElement("div");
    fold.className = "ab-fold";
    fold.dataset.tip = "Drag to change the screen height (100vh)";
    fold.innerHTML = `<span class="ab-fold-tag"></span>`;
    fold.addEventListener("pointerdown", (e) => startResize(e, sc.id));
    box.append(f, grid, fold);
    const inner = document.createElement("button");
    inner.className = "ab-inner";
    inner.type = "button";
    inner.hidden = true;
    inner.addEventListener("click", (e) => {
      e.stopPropagation();
      fitHeight(sc.id);
    });
    ab.style.width = `${sz.w}px`; // nothing inside (labels, the hint) can widen an artboard
    ab.append(label, box, inner);
    stage.appendChild(ab);
    S.frames.set(sc.id, f);
    updateArtboardChrome(sc.id);
    renderGridOverlay(sc.id);
  }
  applyZoom();
}

// ── artboard sizes ────────────────────────────────────────────────────────────
// Each breakpoint's artboard can be resized inside its own range (so Tablet stays a tablet), and its
// height is the SCREEN height: what 100vh means on that artboard. Pages longer than that still show in
// full; pages built as one screen that scrolls inside a box (app shells) show more as it grows.
const HEIGHT_RANGE: [number, number] = [400, 20000];
const clampTo = (v: number, [a, b]: [number, number]) => Math.round(Math.min(b, Math.max(a, v)));
/** An artboard's size: its breakpoint's width (fixed, so each artboard is a true Desktop / Tablet / Phone)
 *  and the screen height the user chose. */
function sizeOf(sc: Scope): { w: number; h: number } {
  const d = SCOPES.find((x) => x.id === sc)!;
  const s = S.project?.frames?.[sc];
  return { w: d.width, h: s?.h || d.height };
}
/** Set an artboard's screen height (its width is its breakpoint's). */
function setArtboardSize(sc: Scope, h: number): void {
  if (!S.project) return;
  const cur = sizeOf(sc);
  const next = { w: cur.w, h: clampTo(h, HEIGHT_RANGE) };
  if (next.w === cur.w && next.h === cur.h) {
    updateArtboardChrome(sc);
    return;
  }
  S.project = { ...S.project, frames: { ...(S.project.frames || {}), [sc]: next } };
  rerenderFrame(sc);
  afterSizeChange();
}
function resetArtboardSize(sc: Scope): void {
  if (!S.project?.frames?.[sc]) return;
  const frames = { ...S.project.frames };
  delete frames[sc];
  S.project = { ...S.project, frames };
  rerenderFrame(sc);
  afterSizeChange();
}
function afterSizeChange(): void {
  renderScopeTabs();
  if (!S.sel) renderProps();
  scheduleSave();
}
// ── layout grid ───────────────────────────────────────────────────────────────
const gridSpecOf = (sc: Scope): GridSpec => ({ ...DEFAULT_GRIDS[sc], ...(S.project?.grids?.[sc] || {}) });
function setGridSpec(sc: Scope, g: Partial<GridSpec>): void {
  if (!S.project) return;
  const next = { ...gridSpecOf(sc), ...g };
  S.project = { ...S.project, grids: { ...(S.project.grids || {}), [sc]: next } };
  renderGridOverlay(sc);
  scheduleSave();
}
/** The columns drawn over an artboard (above the page, under nothing you can click). */
function renderGridOverlay(sc: Scope): void {
  const el = S.frames.get(sc)?.closest(".artboard")?.querySelector<HTMLElement>(".ab-grid");
  if (!el) return;
  el.hidden = !UI.grid;
  if (!UI.grid) return;
  el.replaceChildren(
    ...gridColumns(sizeOf(sc).w, gridSpecOf(sc)).map((c) => {
      const col = document.createElement("i");
      col.style.left = `${c.start}px`;
      col.style.width = `${c.end - c.start}px`;
      return col;
    }),
  );
}
function setTools(next: Partial<typeof UI>): void {
  Object.assign(UI, next);
  saveUI();
  $<HTMLButtonElement>("#mode-reorder").setAttribute("aria-pressed", String(UI.mode === "reorder"));
  $<HTMLButtonElement>("#mode-free").setAttribute("aria-pressed", String(UI.mode === "free"));
  $<HTMLButtonElement>("#grid-btn").setAttribute("aria-pressed", String(UI.grid));
  $<HTMLButtonElement>("#snap-btn").setAttribute("aria-pressed", String(UI.snap));
  document.body.classList.toggle("mode-free", UI.mode === "free");
  for (const sc of S.frames.keys()) renderGridOverlay(sc);
  refreshOverlays();
}

/** Load the page again in one artboard (viewport units are resolved against its new size). */
function rerenderFrame(sc: Scope): void {
  const f = S.frames.get(sc);
  if (!f) return;
  const { w, h } = sizeOf(sc);
  innerExtra.delete(sc);
  f.width = String(w);
  f.height = String(h);
  f.srcdoc = artboardHtml(S.html, w, h);
  updateArtboardChrome(sc);
  applyZoom();
}
/** How much more a page that scrolls inside a box (an app shell) would show with a taller screen. */
const innerExtra = new Map<Scope, number>();
function innerScrollExtra(d: Document): number {
  const win = d.defaultView;
  if (!d.body || !win) return 0;
  let best = 0;
  const all = d.body.getElementsByTagName("*");
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i] as HTMLElement;
    const extra = el.scrollHeight - el.clientHeight;
    if (extra > best && el.clientHeight > 160 && /auto|scroll|overlay/.test(win.getComputedStyle(el).overflowY)) best = extra;
  }
  return best > 80 ? best : 0;
}
/** A page whose content scrolls inside a box: first try a taller artboard (a box pinned to the screen's
 *  edges grows with it); if the box is locked to the screen height (100vh), go back and offer to raise
 *  the screen height instead — never a tall artboard with blank space under the page. */
function measureInnerScroll(f: HTMLIFrameElement, sc: Scope): void {
  const d = f.contentDocument;
  if (!d?.body) return;
  const extra = innerScrollExtra(d);
  if (!extra) {
    innerExtra.set(sc, 0);
    return updateArtboardChrome(sc);
  }
  const before = Number(f.height);
  f.height = String(Math.min(MAX_ARTBOARD, before + extra));
  setTimeout(() => {
    if (f.contentDocument !== d) return; // reloaded meanwhile
    const left = innerScrollExtra(d);
    if (left && left >= extra - 20) {
      f.height = String(before);
      innerExtra.set(sc, left);
    } else innerExtra.set(sc, 0);
    applyZoom();
    updateArtboardChrome(sc);
  }, 200);
}
function fitHeight(sc: Scope): void {
  const extra = innerExtra.get(sc) || 0;
  if (!extra) return toast("The whole page already shows on this artboard.");
  const { h } = sizeOf(sc);
  setArtboardSize(sc, h + extra);
  toast(`${SCOPES.find((x) => x.id === sc)!.label}: screen height ${clampTo(h + extra, HEIGHT_RANGE)} px — the whole page shows now.`);
}
/** The artboard's size readout, its fold line and the "scrolls inside a box" hint. */
function updateArtboardChrome(sc: Scope): void {
  const f = S.frames.get(sc);
  const ab = f?.closest(".artboard");
  if (!f || !ab) return;
  const { w, h } = sizeOf(sc);
  ab.querySelector(".ab-size")!.textContent = `${w} × ${h}`;
  const fold = ab.querySelector<HTMLElement>(".ab-fold")!;
  fold.style.top = `${h}px`;
  fold.querySelector(".ab-fold-tag")!.textContent = `${h}`;
  const extra = innerExtra.get(sc) || 0;
  const inner = ab.querySelector<HTMLButtonElement>(".ab-inner")!;
  inner.hidden = !extra;
  const room = w * S.zoom; // the artboard's width on screen
  ab.classList.toggle("narrow", room < 170);
  const more = `+${extra.toLocaleString("en-US")} px`;
  if (room < 110) inner.innerHTML = icon("size", 13); // too narrow for words: the icon, and its tooltip
  else inner.textContent = room >= 380 ? `This page scrolls inside a box — show all of it (${more})` : room >= 190 ? `Show whole page (${more})` : "Show all";
  inner.setAttribute("aria-label", `Show all of the page (${more})`);
  inner.dataset.tip = `This page scrolls inside a box: show all of it (${more} of screen height)`;
}
/** Drag the fold line: the artboard's screen height (100vh) follows the pointer. */
function startResize(e: PointerEvent, sc: Scope): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  hideTip();
  const f = S.frames.get(sc)!;
  const ab = f.closest(".artboard")!;
  const handle = e.currentTarget as HTMLElement;
  const start = sizeOf(sc);
  const y0 = e.clientY;
  let h = start.h;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing", "resizing-h");
  const fold = ab.querySelector<HTMLElement>(".ab-fold")!;
  const move = (ev: PointerEvent) => {
    h = clampTo(start.h + (ev.clientY - y0) / S.zoom, HEIGHT_RANGE);
    fold.style.top = `${h}px`;
    fold.querySelector(".ab-fold-tag")!.textContent = `${h}`;
    if (h > Number(f.height)) f.height = String(h);
    ab.querySelector(".ab-size")!.textContent = `${start.w} × ${h}`;
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    document.body.classList.remove("resizing", "resizing-h");
    setArtboardSize(sc, h);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end, { once: true });
  handle.addEventListener("pointercancel", end, { once: true });
}
const MAX_ARTBOARD = 60000;
/** Grow the artboard to the page's full height (re-run as images and fonts load). */
function autoSize(f: HTMLIFrameElement, sc: Scope): void {
  const d = f.contentDocument;
  if (!d || !d.documentElement) return;
  const min = sizeOf(sc).h;
  // (pages that scroll inside a box are handled by measureInnerScroll)
  let h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
  h = Math.min(MAX_ARTBOARD, Math.max(min, Math.ceil(h)));
  if (Math.abs(Number(f.height) - h) > 2) {
    f.height = String(h);
    applyZoom();
  }
}
function wireFrame(f: HTMLIFrameElement, sc: Scope): void {
  const d = f.contentDocument;
  if (!d) return;
  // the artboard itself never scrolls; the canvas does
  const noScroll = d.createElement("style");
  noScroll.setAttribute("data-sl-editor", "");
  noScroll.textContent = "html, body { overflow: visible !important; }";
  (d.head || d.documentElement).appendChild(noScroll);
  autoSize(f, sc);
  try {
    new (d.defaultView as unknown as typeof window).ResizeObserver(() => autoSize(f, sc)).observe(d.documentElement);
  } catch {
    /* no ResizeObserver */
  }
  d.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => autoSize(f, sc), { once: true }));
  d.fonts?.ready.then(() => autoSize(f, sc)).catch(() => {});
  setTimeout(() => autoSize(f, sc), 1500);
  setTimeout(() => measureInnerScroll(f, sc), 900);
  const st = d.createElement("style");
  st.setAttribute("data-sl-editor", "");
  st.textContent = EDITOR_CSS;
  (d.head || d.documentElement).appendChild(st);
  applyEditCss();
  applyAnimToggle();
  // image files dropped from the desktop land where they're dropped
  d.addEventListener("dragover", (e) => {
    if (!Array.from(e.dataTransfer?.items || []).some((i) => i.kind === "file")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  d.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    if (sc !== S.scope) setScope(sc, false);
    files.forEach((file, i) => readImage(file, (src, w, h) => placeImage(d, sc, e.clientX + i * 24, e.clientY + i * 24, src, w, h)));
  });
  let hovered: Element | null = null;
  const target = (e: Event) => {
    let t = e.target instanceof d.defaultView!.Element ? (e.target as Element).closest(`[${ID_ATTR}]`) : null;
    // a drawing / icon is one thing on the canvas: a click inside an <svg> picks the svg, not a path in it
    // (its parts stay selectable in the Layers panel)
    const svg = t?.closest("svg");
    if (svg && svg !== t) {
      let top: Element = svg;
      for (let a = svg.parentElement?.closest("svg"); a; a = a.parentElement?.closest("svg") || null) top = a;
      if (top.hasAttribute(ID_ATTR)) t = top;
    }
    while (t && isLocked(t.getAttribute(ID_ATTR))) t = t.parentElement?.closest(`[${ID_ATTR}]`) || null; // locked: what's around it
    return t;
  };
  d.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const t = target(e);
    if (!t || t.localName === "body") return;
    const id = t.getAttribute(ID_ATTR)!;
    if (sc !== S.scope) setScope(sc, false);
    if (!selection().includes(id)) select(id, false);
    const fr = f.getBoundingClientRect();
    openLayerMenu(fr.left + e.clientX * S.zoom, fr.top + e.clientY * S.zoom, id, layersAt(d, e.clientX, e.clientY));
  });
  // drag to move. Reorder: before / after another element, or inside a container (the page keeps its
  // layout). Free move: anywhere, snapping to other elements, the layout grid and the artboard.
  let press: { x: number; y: number; id: string } | null = null;
  let dragging = false;
  let drop: Drop | null = null;
  let free: FreeDrag | null = null;
  let swallowClick = false;
  d.documentElement.setAttribute("data-sl-tool", tool === "move" ? "" : tool === "text" ? "text" : "draw");
  d.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // a new press: a click still waiting to be swallowed belonged to a drag released outside the artboard
    // (no click came after it), so this press's click must select as usual
    swallowClick = false;
    if (menuOpen()) closeMenu();
    const handle = (e.target as Element)?.closest?.("[data-sl-handle]");
    if (handle) {
      e.preventDefault();
      d.documentElement.style.setProperty("--sl-cursor", HANDLE_CURSOR[handle.getAttribute("data-sl-handle") as Handle]);
      return startResizeEl(d, handle.getAttribute("data-sl-handle") as Handle, e);
    }
    if (tool !== "move" && tool !== "hand") {
      e.preventDefault();
      if (!(e.target as Element)?.closest?.("[contenteditable='true']")) startDraw(d, sc, e);
      return;
    }
    const t = target(e);
    if ((e.target as Element)?.closest?.("[contenteditable='true']")) return;
    if ((!t || t.localName === "body") && tool === "move") {
      // empty space: drag a box to select several layers
      marquee = { d, sc, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, add: e.shiftKey };
      e.preventDefault();
      return;
    }
    if (!t || t.localName === "body") return;
    // grabbing inside a selected element drags it (select a card, drag it by its text; with several
    // selected, they move together); otherwise the element under the pointer drags
    const held = selection().find((sid) => {
      const el = byId(d, sid);
      return !!el && el.localName !== "body" && el.contains(e.target as Node);
    });
    const id = !e.shiftKey && held ? held : t.getAttribute(ID_ATTR)!;
    press = { x: e.clientX, y: e.clientY, id };
    e.preventDefault(); // no text selection while dragging
  });
  d.addEventListener("mousemove", (e) => {
    if (rs && rs.d === d) {
      if ((e.buttons & 1) === 0) {
        swallowClick = true;
        return endResizeEl();
      }
      return moveResizeEl(e);
    }
    if (draw && draw.d === d) {
      if (draw.tool !== "pen" && (e.buttons & 1) === 0) {
        swallowClick = true;
        return finishDraw(); // released outside the artboard
      }
      return moveDraw(e);
    }
    if (marquee && marquee.d === d) {
      if ((e.buttons & 1) === 0) return endDrag();
      marquee.x = e.clientX;
      marquee.y = e.clientY;
      if (Math.hypot(marquee.x - marquee.x0, marquee.y - marquee.y0) >= 4) drawMarquee(marquee, d);
      return;
    }
    if (press && (e.buttons & 1) === 0) {
      // the button was released outside the artboard: cancel
      drop = null;
      if (free) free.cancel = true;
      endDrag();
    }
    if (press) {
      if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
      if (!dragging) {
        dragging = true;
        if (sc !== S.scope) setScope(sc, false);
        if (!selection().includes(press.id)) select(press.id, false);
        d.documentElement.setAttribute("data-sl-dragging", "");
        hideTip();
        clearMeasure(d);
        if (UI.mode === "free") free = startFree(d, sc, press.id, press.x, press.y);
        else byId(d, press.id)?.setAttribute("data-sl-drag", "");
      }
      if (free) moveFree(d, free, e);
      else {
        drop = dropAt(d, e.clientX, e.clientY, press.id);
        showDrop(d, drop);
      }
      return;
    }
    const t = target(e);
    // ⌥ held with something selected: the distances to the element under the pointer (like Figma)
    if (e.altKey && S.sel && sc === S.scope) showMeasure(d, t);
    else clearMeasure(d);
    if (t === hovered) return;
    hovered?.removeAttribute("data-sl-hover");
    hovered = t;
    t?.setAttribute("data-sl-hover", "");
  });
  d.addEventListener("mouseleave", () => hovered?.removeAttribute("data-sl-hover"));
  const endDrag = () => {
    if (marquee && marquee.d === d) {
      const m = marquee;
      marquee = null;
      if (Math.hypot(m.x - m.x0, m.y - m.y0) >= 4) {
        swallowClick = true; // the click that ends a marquee doesn't select what's under it
        finishMarquee(m);
      } else drawMarquee(null, d);
      return;
    }
    if (rs && rs.d === d) {
      swallowClick = true;
      return endResizeEl();
    }
    if (draw && draw.d === d && draw.tool !== "pen") {
      swallowClick = true; // the click that ends a drawing doesn't select what's under it
      return finishDraw();
    }
    if (free) {
      swallowClick = true;
      endFree(d, free);
      free = null;
    } else if (dragging && press && drop) {
      swallowClick = true;
      moveTo(press.id, drop.id, drop.where);
    } else if (dragging) swallowClick = true;
    if (press) byId(d, press.id)?.removeAttribute("data-sl-drag");
    d.documentElement.removeAttribute("data-sl-dragging");
    showDrop(d, null);
    press = null;
    dragging = false;
    drop = null;
  };
  d.addEventListener("mouseup", endDrag);
  d.documentElement.addEventListener("mouseleave", () => clearMeasure(d));
  d.addEventListener(
    "click",
    (e) => {
      const t = target(e);
      if ((e.target as Element)?.closest?.("[contenteditable='true']")) return;
      e.preventDefault();
      e.stopPropagation();
      if (swallowClick) {
        swallowClick = false; // the click that ends a drag doesn't select
        return;
      }
      if (tool !== "move") return; // drawing tools don't select
      if (!t) return;
      setScope(sc, false);
      if (e.shiftKey && t.localName !== "body") return toggleSelect(t.getAttribute(ID_ATTR)!);
      select(t.getAttribute(ID_ATTR), false);
    },
    true,
  );
  d.addEventListener("submit", (e) => e.preventDefault(), true);
  d.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scrolling pans the canvas as usual
      e.preventDefault();
      const fr = f.getBoundingClientRect();
      wheelZoom(e.deltaY, fr.left + e.clientX * S.zoom, fr.top + e.clientY * S.zoom);
    },
    { passive: false },
  );
  d.addEventListener("dblclick", (e) => {
    if (draw && draw.tool === "pen") {
      // the double-click's own two clicks added the same point twice: drop the repeat, then finish
      const p = draw.pts;
      while (p.length > 1 && Math.hypot(p[p.length - 1].x - p[p.length - 2].x, p[p.length - 1].y - p[p.length - 2].y) < 3) p.pop();
      return finishDraw();
    }
    if (tool !== "move") return;
    const t = target(e) as HTMLElement | null;
    if (!t) return;
    const kind = layerKind(t);
    if (kind === "text" || kind === "link" || kind === "button") startTextEdit(t, sc);
  });
  if (S.sel) markSelection();
}
// ── moving layers (drag on the canvas or in the Layers panel) ──────────────────
type Where = "before" | "after" | "inside";
interface Drop {
  id: string;
  where: Where;
}
// elements that can take children when something is dropped on their middle
const CONTAINER = /^(div|section|article|main|header|footer|nav|aside|ul|ol|li|form|figure|details|fieldset|blockquote|table|tbody|thead|tr|td|th|span|a)$/i;
const canHold = (el: Element) => CONTAINER.test(el.localName) && !/^(span|a)$/i.test(el.localName) || (/^(span|a)$/i.test(el.localName) && el.children.length > 0);
/** Where a drop at (x, y) in an artboard would put the dragged element. */
function dropAt(d: Document, x: number, y: number, dragId: string): Drop | null {
  const dragged = byId(d, dragId);
  const hit = d.elementFromPoint(x, y)?.closest(`[${ID_ATTR}]`);
  if (!dragged || !hit || dragged === hit || dragged.contains(hit)) return null;
  if (hit.localName === "body") return { id: hit.getAttribute(ID_ATTR)!, where: "inside" }; // the end of the page
  const win = d.defaultView!;
  const r = hit.getBoundingClientRect();
  const parent = hit.parentElement;
  const pcs = parent ? win.getComputedStyle(parent) : null;
  const across = !!pcs && ((/flex/.test(pcs.display) && /row/.test(pcs.flexDirection)) || /grid/.test(pcs.display));
  const pos = across ? (x - r.left) / Math.max(1, r.width) : (y - r.top) / Math.max(1, r.height);
  const where: Where = pos < 0.28 ? "before" : pos > 0.72 ? "after" : canHold(hit) ? "inside" : pos < 0.5 ? "before" : "after";
  return { id: hit.getAttribute(ID_ATTR)!, where };
}
/** The drop marker: a line before / after the target, or a box when dropping inside it. */
function showDrop(d: Document, drop: Drop | null): void {
  let m = d.getElementById("__sl_drop") as HTMLDivElement | null;
  if (!drop) {
    m?.remove();
    d.getElementById("__sl_drop_parent")?.remove();
    return;
  }
  const t = byId(d, drop.id);
  if (!t) return;
  if (!m) {
    m = d.createElement("div");
    m.id = "__sl_drop";
    m.setAttribute("data-sl-editor", "");
    d.documentElement.appendChild(m);
  }
  const r = t.getBoundingClientRect();
  const win = d.defaultView!;
  const pcs = t.parentElement ? win.getComputedStyle(t.parentElement) : null;
  const across = !!pcs && ((/flex/.test(pcs.display) && /row/.test(pcs.flexDirection)) || /grid/.test(pcs.display));
  const base = "position:fixed;z-index:2147483647;pointer-events:none;border-radius:3px;";
  const k = 3 / S.zoom; // the line looks 3 px thick at any zoom
  if (drop.where === "inside") m.style.cssText = `${base}left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:${k * 0.7}px solid #3b82f6;background:rgba(59,130,246,.12)`;
  else if (across) m.style.cssText = `${base}left:${(drop.where === "before" ? r.left : r.right) - k / 2}px;top:${r.top}px;width:${k}px;height:${r.height}px;background:#3b82f6`;
  else m.style.cssText = `${base}left:${r.left}px;top:${(drop.where === "before" ? r.top : r.bottom) - k / 2}px;width:${r.width}px;height:${k}px;background:#3b82f6`;
  // the container it will land in, dashed
  const host = drop.where === "inside" ? null : t.parentElement;
  let pm = d.getElementById("__sl_drop_parent") as HTMLDivElement | null;
  if (host && host.localName !== "body") {
    if (!pm) {
      pm = d.createElement("div");
      pm.id = "__sl_drop_parent";
      pm.setAttribute("data-sl-editor", "");
      d.documentElement.appendChild(pm);
    }
    const hr = host.getBoundingClientRect();
    pm.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;left:${hr.left}px;top:${hr.top}px;width:${hr.width}px;height:${hr.height}px;outline:${k / 2}px dashed rgba(59,130,246,.8)`;
  } else pm?.remove();
}
// ── free move: snapping, guides, distances, margin / padding ───────────────────
interface FreeDrag {
  id: string;
  el: HTMLElement;
  r0: Box;
  t0: { x: number; y: number };
  x0: number;
  y0: number;
  targets: Box[];
  linesX: number[];
  dx: number;
  dy: number;
  cancel?: boolean;
  /** artboard px → translate px for this element (see moveMap) */
  map: MoveMap;
  /** the rest of the selection, moved by the same amount */
  others: { id: string; el: HTMLElement; t0: { x: number; y: number }; map: MoveMap }[];
}
const px = (n: number) => `${n / S.zoom}px`; // a size that looks the same at any zoom
const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};
/**
 * How an element's offset (CSS translate) maps to where it shows. Measured, not assumed: inside a flipped,
 * scaled or rotated container, 10 px to the right on screen is not +10 px of translate. Returns the
 * translate change that moves it by (dx, dy) on the artboard.
 */
type MoveMap = (dx: number, dy: number) => { x: number; y: number };
function moveMap(el: HTMLElement, t0: { x: number; y: number }): MoveMap {
  const st = el.style;
  const prev = st.getPropertyValue("translate"), prio = st.getPropertyPriority("translate");
  const at = (x: number, y: number) => {
    st.setProperty("translate", `${x}px ${y}px`, "important");
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  };
  const o = at(t0.x, t0.y), a = at(t0.x + 100, t0.y), b = at(t0.x, t0.y + 100);
  if (prev) st.setProperty("translate", prev, prio);
  else st.removeProperty("translate");
  const m11 = (a.x - o.x) / 100, m21 = (a.y - o.y) / 100, m12 = (b.x - o.x) / 100, m22 = (b.y - o.y) / 100;
  const det = m11 * m22 - m12 * m21;
  if (Math.abs(det) < 1e-4) return (dx, dy) => ({ x: dx, y: dy }); // translate has no effect (inline text): as is
  return (dx, dy) => ({ x: (m22 * dx - m12 * dy) / det, y: (-m21 * dx + m11 * dy) / det });
}
function startFree(d: Document, sc: Scope, id: string, x0: number, y0: number): FreeDrag | null {
  const el = byId(d, id) as HTMLElement | null;
  if (!el) return null;
  const t0 = parseTranslate(effectiveEdit(S.edits, id, S.scope, "translate") || d.defaultView!.getComputedStyle(el).translate);
  // the rest of the selection comes along
  const others = selection()
    .filter((o) => o !== id)
    .map((o) => ({ id: o, el: byId(d, o) as HTMLElement | null }))
    .filter((o): o is { id: string; el: HTMLElement } => !!o.el)
    .map((o) => {
      const t = parseTranslate(effectiveEdit(S.edits, o.id, S.scope, "translate") || d.defaultView!.getComputedStyle(o.el).translate);
      return { ...o, t0: t, map: moveMap(o.el, t) };
    });
  // what it can line up with: everything visible except itself, its insides and the boxes around it
  // (its own parent stays: aligning to the parent's edges and centre is the common case)
  const targets: Box[] = [];
  const all = d.body.querySelectorAll<HTMLElement>(`[${ID_ATTR}]`);
  for (let i = 0; i < all.length && targets.length < 1500; i++) {
    const n = all[i];
    if (n === el || el.contains(n) || (n.contains(el) && n !== el.parentElement) || others.some((o) => o.el === n || o.el.contains(n))) continue;
    const b = boxOf(n);
    if (b.width >= 2 && b.height >= 2) targets.push(b);
  }
  const w = sizeOf(sc).w;
  return { id, el, r0: boxOf(el), t0, map: moveMap(el, t0), x0, y0, targets, linesX: [0, w / 2, w, ...(UI.grid ? gridLines(w, gridSpecOf(sc)) : [])], dx: 0, dy: 0, others };
}
function moveFree(d: Document, f: FreeDrag, e: MouseEvent): void {
  let dx = e.clientX - f.x0, dy = e.clientY - f.y0;
  const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx), lockY = e.shiftKey && !lockX; // ⇧: one axis only
  if (lockX) dx = 0;
  if (lockY) dy = 0;
  let guides: Guide[] = [];
  if (UI.snap && !(e.metaKey || e.ctrlKey)) {
    const s = snapBox({ ...f.r0, left: f.r0.left + dx, top: f.r0.top + dy }, f.targets, { x: f.linesX }, 6 / S.zoom);
    if (!lockX) dx += s.dx;
    if (!lockY) dy += s.dy;
    guides = s.guides.filter((g) => (g.axis === "x" ? !lockX : !lockY));
  }
  f.dx = dx;
  f.dy = dy;
  const m = f.map(dx, dy);
  f.el.style.setProperty("translate", `${f.t0.x + m.x}px ${f.t0.y + m.y}px`, "important");
  for (const o of f.others) {
    const om = o.map(dx, dy);
    o.el.style.setProperty("translate", `${o.t0.x + om.x}px ${o.t0.y + om.y}px`, "important");
  }
  drawGuides(d, guides, { ...f.r0, left: f.r0.left + dx, top: f.r0.top + dy }, f.t0.x + m.x, f.t0.y + m.y);
}
function endFree(d: Document, f: FreeDrag): void {
  f.el.style.removeProperty("translate");
  for (const o of f.others) o.el.style.removeProperty("translate");
  drawGuides(d, [], null, 0, 0);
  if (f.cancel || (Math.round(f.dx) === 0 && Math.round(f.dy) === 0)) return;
  if (!selection().includes(f.id)) select(f.id, false);
  checkpoint();
  const m = f.map(f.dx, f.dy);
  S.edits = setEdit(S.edits, f.id, S.scope, "translate", formatTranslate(f.t0.x + m.x, f.t0.y + m.y));
  for (const o of f.others) {
    const om = o.map(f.dx, f.dy);
    S.edits = setEdit(S.edits, o.id, S.scope, "translate", formatTranslate(o.t0.x + om.x, o.t0.y + om.y));
  }
  commit(false);
  renderProps();
  // an ancestor that clips its content hides whatever is moved outside it: say so, and how to move it
  const win = d.defaultView!;
  const moved = boxOf(f.el);
  for (let a = f.el.parentElement; a && a.localName !== "body"; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    if (!/hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
    const c = boxOf(a);
    const outside = moved.left < c.left - 1 || moved.top < c.top - 1 || moved.left + moved.width > c.left + c.width + 1 || moved.top + moved.height > c.top + c.height + 1;
    if (outside) {
      const name = a.hasAttribute(ID_ATTR) && S.doc ? layerName(byId(S.doc, a.getAttribute(ID_ATTR)!) || a) : a.localName;
      toast(`Part of it is now hidden: “${name}” clips what sticks out. To put it in another section, switch to Reorder (M) and drag it there.`);
    }
    break;
  }
}
/** A layer of marks drawn inside an artboard (guides, distances, margin / padding): fixed to the
 *  artboard, never clickable, never saved — the saved page is the canonical document, not the artboard. */
function overlay(d: Document, id: string): HTMLDivElement {
  let o = d.getElementById(id) as HTMLDivElement | null;
  if (!o) {
    o = d.createElement("div");
    o.id = id;
    o.setAttribute("data-sl-editor", "");
    o.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none";
    d.documentElement.appendChild(o);
  }
  return o;
}
function mark(o: HTMLElement, css: string, text = ""): void {
  const m = o.ownerDocument.createElement("div");
  m.style.cssText = `position:fixed;pointer-events:none;box-sizing:border-box;${css}`;
  if (text) m.textContent = text;
  o.appendChild(m);
}
const tagCss = (bg: string) => `font:600 ${px(11)}/1 system-ui,sans-serif;color:#fff;background:${bg};padding:${px(3)} ${px(5)};border-radius:${px(4)};white-space:nowrap;transform:translate(-50%,-50%)`;
function drawGuides(d: Document, guides: Guide[], box: Box | null, tx: number, ty: number): void {
  const o = overlay(d, "__sl_guides");
  o.replaceChildren();
  if (!box) return;
  const H = d.documentElement.scrollHeight, W = d.documentElement.clientWidth;
  const t = px(1);
  for (const g of guides) {
    const from = Math.max(0, g.from), to = Math.min(g.axis === "x" ? H : W, g.to);
    if (g.axis === "x") mark(o, `left:${g.at}px;top:${from}px;width:${t};height:${to - from}px;background:#f43f5e;margin-left:-${px(0.5)}`);
    else mark(o, `top:${g.at}px;left:${from}px;height:${t};width:${to - from}px;background:#f43f5e;margin-top:-${px(0.5)}`);
  }
  mark(o, `left:${box.left + box.width / 2}px;top:${box.top + box.height}px;margin-top:${px(16)};${tagCss("#f43f5e")}`, `X ${Math.round(tx)}   Y ${Math.round(ty)}`);
}
function clearMeasure(d: Document): void {
  d.getElementById("__sl_measure")?.replaceChildren();
}
function showMeasure(d: Document, t: Element | null): void {
  const sel = S.sel ? byId(d, S.sel) : null;
  const o = overlay(d, "__sl_measure");
  o.replaceChildren();
  if (!sel || !t || t === sel || t.localName === "body") return;
  const a = boxOf(sel), b = boxOf(t);
  mark(o, `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;outline:${px(1)} dashed #f43f5e`);
  for (const m of measureBetween(a, b)) {
    if (m.axis === "x") mark(o, `left:${m.from}px;top:${m.at}px;width:${m.to - m.from}px;height:${px(1)};background:#f43f5e`);
    else mark(o, `left:${m.at}px;top:${m.from}px;height:${m.to - m.from}px;width:${px(1)};background:#f43f5e`);
    const lx = m.axis === "x" ? (m.from + m.to) / 2 : m.at, ly = m.axis === "x" ? m.at : (m.from + m.to) / 2;
    mark(o, `left:${lx}px;top:${ly}px;${tagCss("#f43f5e")}`, String(Math.round(m.value)));
  }
}
/** The selected element's margin (orange) and padding (green), with their sizes, on the active artboard. */
function drawBoxModel(d: Document, id: string | null): void {
  const o = overlay(d, "__sl_box");
  o.replaceChildren();
  const el = id ? (byId(d, id) as HTMLElement | null) : null;
  if (!el || el.localName === "body" || d.documentElement.hasAttribute("data-sl-dragging")) return;
  const cs = d.defaultView!.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const n = (v: string) => Math.max(0, parseFloat(v) || 0);
  const m = { t: n(cs.marginTop), r: n(cs.marginRight), b: n(cs.marginBottom), l: n(cs.marginLeft) };
  const p = { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) };
  const band = (x: number, y: number, w: number, h: number, bg: string, v: number, tag: string) => {
    if (w <= 0 || h <= 0) return;
    mark(o, `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg}`);
    if (v >= 1 && Math.min(w, h) * S.zoom >= 9) mark(o, `left:${x + w / 2}px;top:${y + h / 2}px;${tagCss(tag)}`, String(Math.round(v)));
  };
  const M = "rgba(251,146,60,.28)", Pd = "rgba(74,222,128,.26)";
  band(r.left, r.top - m.t, r.width, m.t, M, m.t, "#ea7a26");
  band(r.left, r.bottom, r.width, m.b, M, m.b, "#ea7a26");
  band(r.left - m.l, r.top, m.l, r.height, M, m.l, "#ea7a26");
  band(r.right, r.top, m.r, r.height, M, m.r, "#ea7a26");
  band(r.left, r.top, r.width, p.t, Pd, p.t, "#16a34a");
  band(r.left, r.bottom - p.b, r.width, p.b, Pd, p.b, "#16a34a");
  band(r.left, r.top + p.t, p.l, r.height - p.t - p.b, Pd, p.l, "#16a34a");
  band(r.right - p.r, r.top + p.t, p.r, r.height - p.t - p.b, Pd, p.r, "#16a34a");
  // the selection's name, so it's clear what a drag will move (grab anywhere inside it)
  const node = S.doc && id ? byId(S.doc, id) : null;
  if (node) {
    mark(
      o,
      `left:${r.left}px;top:${Math.max(0, r.top)}px;transform:translateY(${r.top > 20 / S.zoom ? "-100%" : "0"});font:600 ${px(11)}/1 system-ui,sans-serif;color:#fff;background:#3b82f6;padding:${px(3)} ${px(6)};border-radius:${px(4)} ${px(4)} ${px(4)} 0;white-space:nowrap;max-width:${Math.max(r.width, 80 / S.zoom)}px;overflow:hidden;text-overflow:ellipsis`,
      `${layerName(node)} · ${UI.mode === "free" ? "drag to move" : "drag to reorder"}`,
    );
  }
}
let overlayRaf = 0;
/** Redraw the margin / padding marks after anything that can move the selection. */
function refreshOverlays(): void {
  cancelAnimationFrame(overlayRaf);
  overlayRaf = requestAnimationFrame(() =>
    forEachFrame((d, sc) => {
      const many = isMulti();
      drawBoxModel(d, sc === S.scope && !many ? S.sel : null);
      drawMulti(d, sc === S.scope && many ? selection() : []);
      if (!rs) drawHandles(d, sc === S.scope && !many ? S.sel : null);
    }),
  );
}
/** Several layers selected: the box around them all, and how many. */
function drawMulti(d: Document, ids: string[]): void {
  const o = overlay(d, "__sl_multi");
  o.replaceChildren();
  if (ids.length < 2) return;
  const boxes = ids.map((id) => byId(d, id)).filter((e): e is Element => !!e).map(boxOf);
  if (!boxes.length) return;
  const L = Math.min(...boxes.map((b) => b.left)), T = Math.min(...boxes.map((b) => b.top));
  const R = Math.max(...boxes.map((b) => b.left + b.width)), B = Math.max(...boxes.map((b) => b.top + b.height));
  mark(o, `left:${L}px;top:${T}px;width:${R - L}px;height:${B - T}px;outline:${px(1)} dashed #3b82f6;outline-offset:${px(2)}`);
  mark(o, `left:${L}px;top:${Math.max(0, T)}px;transform:translateY(${T > 20 / S.zoom ? "-100%" : "0"});font:600 ${px(11)}/1 system-ui,sans-serif;color:#fff;background:#3b82f6;padding:${px(3)} ${px(6)};border-radius:${px(4)} ${px(4)} ${px(4)} 0;white-space:nowrap`, `${ids.length} layers · ${UI.mode === "free" ? "drag to move together" : "selected"}`);
}
/** Drag a box on an artboard's empty space to select what's inside it (⇧ adds to the selection). */
interface Marquee {
  d: Document;
  sc: Scope;
  x0: number;
  y0: number;
  x: number;
  y: number;
  add: boolean;
}
let marquee: Marquee | null = null;
const marqueeBox = (m: Marquee): Box => ({ left: Math.min(m.x0, m.x), top: Math.min(m.y0, m.y), width: Math.abs(m.x - m.x0), height: Math.abs(m.y - m.y0) });
function drawMarquee(m: Marquee | null, d: Document): void {
  const o = overlay(d, "__sl_marquee");
  o.replaceChildren();
  if (!m) return;
  const b = marqueeBox(m);
  mark(o, `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;border:${px(1)} solid #3b82f6;background:rgba(59,130,246,.08)`);
}
/** What a marquee selects: the outermost layers that lie wholly inside it (not locked, not hidden). */
function finishMarquee(m: Marquee): void {
  drawMarquee(null, m.d);
  const r = marqueeBox(m);
  const inside: Element[] = [];
  const all = m.d.body.querySelectorAll(`[${ID_ATTR}]`);
  const win = m.d.defaultView!;
  for (let i = 0; i < all.length && inside.length < 400; i++) {
    const el = all[i];
    const id = el.getAttribute(ID_ATTR)!;
    if (isLocked(id)) continue;
    const b = boxOf(el);
    if (b.width < 2 || b.height < 2) continue;
    if (b.left < r.left - 0.5 || b.top < r.top - 0.5 || b.left + b.width > r.left + r.width + 0.5 || b.top + b.height > r.top + r.height + 0.5) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    inside.push(el);
  }
  const outer = inside.filter((el) => !inside.some((o) => o !== el && o.contains(el))).map((el) => el.getAttribute(ID_ATTR)!);
  setScope(m.sc, false);
  const ids = m.add ? [...selection(), ...outer] : outer;
  if (!ids.length) return select(null, false);
  selectMany(ids);
}
/** Nudge the selection with the arrow keys (free move): 1 px, 10 px with ⇧. */
function nudge(dx: number, dy: number): void {
  const ids = selection();
  if (!ids.length) return;
  const d = frameDoc(S.scope);
  checkpoint();
  for (const id of ids) {
    const el = d ? (byId(d, id) as HTMLElement | null) : null;
    const t = parseTranslate(effectiveEdit(S.edits, id, S.scope, "translate") || (el ? d!.defaultView!.getComputedStyle(el).translate : ""));
    const m = el ? moveMap(el, t)(dx, dy) : { x: dx, y: dy };
    S.edits = setEdit(S.edits, id, S.scope, "translate", formatTranslate(t.x + m.x, t.y + m.y));
  }
  commit(false);
  renderProps();
}

/** Move a layer before / after another one, or into it (every artboard + the saved page). */
function moveTo(id: string, targetId: string, where: Where): void {
  if (!S.doc || id === targetId) return;
  const el = byId(S.doc, id), tgt = byId(S.doc, targetId);
  if (!el || !tgt || el.contains(tgt)) return;
  checkpoint();
  mirror((d) => {
    const a = byId(d, id), b = byId(d, targetId);
    if (!a || !b || a.contains(b)) return;
    if (where === "before") b.before(a);
    else if (where === "after") b.after(a);
    else b.appendChild(a);
  });
  if (where === "inside") S.expanded.add(targetId);
  commit(true);
  select(id, false);
  renderLayers();
  toast(`Moved ${where === "inside" ? "into" : where} “${layerName(tgt)}”.`);
}

function applyZoom(): void {
  stage.style.transform = `scale(${S.zoom})`;
  stage.style.setProperty("--z", String(S.zoom)); // handles keep a usable size at any zoom
  for (const sc of S.frames.keys()) updateArtboardChrome(sc);
  refreshOverlays();
  const w = stage.scrollWidth * S.zoom, h = stage.scrollHeight * S.zoom;
  // reserve the scaled size so the canvas scrolls correctly
  let spacer = canvas.querySelector<HTMLDivElement>(".spacer");
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.className = "spacer";
    spacer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
    canvas.appendChild(spacer);
  }
  spacer.style.width = `${w}px`;
  spacer.style.height = `${h}px`;
  $<HTMLButtonElement>("#zoom-label").textContent = `${Math.round(S.zoom * 100)}%`;
}
/** Zoom so the point under (x, y) — window coordinates — stays under the pointer, like Figma. */
function zoomAt(next: number, x: number, y: number): void {
  const z0 = S.zoom;
  const z1 = Math.max(0.05, Math.min(4, next));
  if (Math.abs(z1 - z0) < 1e-4) return;
  const r = canvas.getBoundingClientRect();
  const px = canvas.scrollLeft + (x - r.left), py = canvas.scrollTop + (y - r.top); // stage pixels × z0
  S.zoom = z1;
  applyZoom();
  canvas.scrollLeft = (px / z0) * z1 - (x - r.left);
  canvas.scrollTop = (py / z0) * z1 - (y - r.top);
}
/** A trackpad pinch arrives as a wheel event with ctrlKey (small, smooth deltas); ⌘ + mouse wheel too. */
function wheelZoom(deltaY: number, x: number, y: number): void {
  const d = Math.max(-60, Math.min(60, deltaY));
  zoomAt(S.zoom * Math.exp(-d * 0.0125), x, y);
}
function fitZoom(): void {
  const total = SCOPES.reduce((a, s) => a + sizeOf(s.id).w, 0) + 80 * (SCOPES.length - 1) + 160;
  S.zoom = Math.max(0.1, Math.min(1, (canvas.clientWidth - 20) / total));
  applyZoom();
}

// ── selection ─────────────────────────────────────────────────────────────────
function markSelection(): void {
  const ids = selection();
  forEachFrame((d) => {
    d.querySelectorAll("[data-sl-sel]").forEach((n) => n.removeAttribute("data-sl-sel"));
    for (const id of ids) byId(d, id)?.setAttribute("data-sl-sel", "");
  });
  refreshOverlays();
}
/** Every selected layer, the first one (S.sel) first. */
function selection(): string[] {
  if (!S.sel) return [];
  const out = [S.sel];
  for (const id of S.multi) if (!out.includes(id) && (!S.doc || byId(S.doc, id))) out.push(id);
  return out;
}
const isMulti = () => selection().length > 1;
/** Select exactly these layers (a layer and something inside it never both: the outer one stays). */
function selectMany(ids: string[]): void {
  if (!S.doc) return;
  const els = ids.map((id) => ({ id, el: byId(S.doc!, id) })).filter((x): x is { id: string; el: Element } => !!x.el && x.el.localName !== "body");
  const keep = els.filter((a) => !els.some((b) => b !== a && b.el.contains(a.el))).map((x) => x.id);
  const uniq = Array.from(new Set(keep));
  if (uniq.length <= 1) return select(uniq[0] || null, false);
  S.sel = uniq[0];
  S.multi = uniq.slice(1);
  for (const id of uniq)
    for (let a = byId(S.doc, id)?.parentElement; a; a = a.parentElement) {
      const aid = a.getAttribute(ID_ATTR);
      if (aid) S.expanded.add(aid);
    }
  markSelection();
  renderLayers();
  renderProps();
}
/** ⇧-click: add a layer to the selection, or take it out. */
function toggleSelect(id: string): void {
  const cur = selection();
  if (!cur.length) return select(id, false);
  if (cur.includes(id)) {
    const rest = cur.filter((x) => x !== id);
    return rest.length > 1 ? selectMany(rest) : select(rest[0] || null, false);
  }
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el || el.localName === "body") return;
  selectMany([...cur.filter((x) => { const o = byId(S.doc!, x); return o && !o.contains(el) && !el.contains(o); }), id]);
}
/** ⌘A: everything next to the selection (in the same container), like Figma. */
function selectSiblings(): void {
  if (!S.doc) return;
  const first = S.sel ? byId(S.doc, S.sel) : null;
  const parent = first && first.localName !== "body" ? first.parentElement : S.doc.body;
  if (!parent) return;
  const ids = Array.from(parent.children)
    .map((c) => c.getAttribute(ID_ATTR))
    .filter((id): id is string => !!id && !isLocked(id) && !isHidden(id));
  if (ids.length) selectMany(ids);
}
function select(id: string | null, scrollFrames = true): void {
  S.multi = [];
  S.sel = id;
  markSelection();
  if (id && S.doc) {
    for (let a = byId(S.doc, id)?.parentElement; a; a = a.parentElement) {
      const aid = a.getAttribute(ID_ATTR);
      if (aid) S.expanded.add(aid);
    }
    if (scrollFrames) {
      const f = S.frames.get(S.scope);
      const el = f?.contentDocument ? (byId(f.contentDocument, id) as HTMLElement | null) : null;
      if (f && el) {
        const r = el.getBoundingClientRect(); // in artboard px (the artboard never scrolls)
        const top = (f.offsetTop + (f.parentElement?.offsetTop || 0) + r.top) * S.zoom;
        const left = (f.parentElement!.offsetLeft + r.left) * S.zoom;
        const view = canvas.getBoundingClientRect();
        if (top < canvas.scrollTop || top > canvas.scrollTop + view.height - 80)
          canvas.scrollTo({ top: Math.max(0, top - view.height / 3), left: Math.max(0, left - 60), behavior: "smooth" });
      }
    }
  }
  renderLayers();
  renderProps();
  layersEl.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
}
function setScope(sc: Scope, rerender = true): void {
  S.scope = sc;
  document.querySelectorAll<HTMLElement>(".artboard").forEach((a) => a.classList.toggle("active", a.dataset.scope === sc));
  document.querySelectorAll<HTMLElement>(".scope-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.scope === sc)));
  if (liveScenes.size) syncLiveScenes(); // a live scene follows you to the artboard you edit
  if (rerender) renderProps();
}

// ── layers ────────────────────────────────────────────────────────────────────
const KIND_ICON: Record<LayerKind, IconName> = { frame: "frame", text: "text", image: "image", link: "link", button: "button", svg: "vector", video: "video", input: "input", section: "section", component: "component" };
const KIND_NAME: Record<LayerKind, string> = { frame: "Frame", text: "Text", image: "Image", link: "Link", button: "Button", svg: "Vector", video: "Video", input: "Input", section: "Section", component: "Component" };
const scopeLabel = () => SCOPES.find((x) => x.id === S.scope)?.label || "Desktop";
const isHidden = (id: string) => effectiveEdit(S.edits, id, S.scope, "display") === "none";
/** Hide or show a layer on the breakpoint being edited (Desktop = everywhere). */
function toggleHiddenFor(id: string): void {
  checkpoint();
  S.edits = setEdit(S.edits, id, S.scope, "display", isHidden(id) ? "" : "none");
  commit(false);
  renderLayers();
  if (id === S.sel) renderProps();
}
const layerChildren = (el: Element) => Array.from(el.children).filter((c) => c.hasAttribute(ID_ATTR));
function renderLayers(): void {
  if (!S.doc) return;
  const frag = document.createDocumentFragment();
  const q = S.search.trim().toLowerCase();
  const picked = new Set(selection());
  const row = (el: Element, depth: number, hasKids: boolean) => {
    const id = el.getAttribute(ID_ATTR)!;
    const r = document.createElement("div");
    r.className = "row" + (picked.has(id) ? " selected" : "") + (isLocked(id) ? " is-locked" : "");
    r.dataset.id = id;
    r.setAttribute("role", "treeitem");
    r.style.paddingLeft = `${4 + depth * 12}px`;
    const hidden = isHidden(id);
    if (hidden) r.classList.add("is-hidden");
    const caret = document.createElement("span");
    caret.className = "caret" + (S.expanded.has(id) ? " open" : "");
    if (hasKids) caret.innerHTML = icon("chevronRight", 12);
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      if (S.expanded.has(id)) S.expanded.delete(id);
      else S.expanded.add(id);
      renderLayers();
    });
    const ico = document.createElement("span");
    ico.className = "ico";
    const kind = layerKind(el);
    ico.innerHTML = icon(KIND_ICON[kind], 14);
    ico.dataset.tip = KIND_NAME[kind];
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = layerName(el);
    const eye = document.createElement("button");
    eye.className = "row-eye";
    eye.type = "button";
    eye.innerHTML = icon(hidden ? "eyeOff" : "eye", 14);
    eye.dataset.tip = `${hidden ? "Show" : "Hide"} on ${scopeLabel()}`;
    eye.setAttribute("aria-label", eye.dataset.tip);
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHiddenFor(id);
    });
    const lock = document.createElement("button");
    lock.className = "row-lock";
    lock.type = "button";
    lock.innerHTML = isLocked(id) ? `<svg class="ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>` : `<svg class="ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>`;
    lock.dataset.tip = isLocked(id) ? "Unlock" : "Lock (canvas clicks go to what's around it)";
    lock.setAttribute("aria-label", lock.dataset.tip);
    lock.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLock(id);
    });
    nm.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renameLayer(id);
    });
    r.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!selection().includes(id)) select(id);
      openLayerMenu(e.clientX, e.clientY, id);
    });
    const mo = motionOf(id);
    const smo = !mo || mo.on === "none" ? siteMotion(el) : null;
    if (smo && effectiveEdit(S.edits, id, S.scope, "animation") !== "none") {
      const b = document.createElement("span");
      b.className = "row-motion site";
      b.innerHTML = icon("sparkles", 12);
      b.dataset.tip = `Animated on the original site: ${smo.kind}`;
      r.append(caret, ico, nm, b, lock, eye);
    } else if (mo && mo.on !== "none") {
      const b = document.createElement("span");
      b.className = "row-motion";
      b.innerHTML = icon("sparkles", 12);
      b.dataset.tip = `Animated: ${TRIGGERS.find((t) => t.id === mo.on)?.label} · ${(mo.on === "hover" ? HOVER_FX[mo.fx]?.label : mo.on === "loop" ? LOOP_FX[mo.fx]?.label : ENTER_FX[mo.fx]?.label) || mo.fx}`;
      r.append(caret, ico, nm, b, lock, eye);
    } else r.append(caret, ico, nm, lock, eye);
    r.addEventListener("click", (e) => (e.shiftKey ? toggleSelect(id) : select(id))); // ⇧-click adds to the selection
    if (!q) wireLayerDrag(r, id, el);
    r.addEventListener("mouseenter", () => forEachFrame((d) => byId(d, id)?.setAttribute("data-sl-hover", "")));
    r.addEventListener("mouseleave", () => forEachFrame((d) => byId(d, id)?.removeAttribute("data-sl-hover")));
    frag.appendChild(r);
  };
  if (q) {
    let n = 0;
    S.doc.querySelectorAll(`body [${ID_ATTR}]`).forEach((el) => {
      if (n > 300) return;
      if (layerName(el).toLowerCase().includes(q)) {
        row(el, 0, false);
        n++;
      }
    });
  } else {
    const walk = (el: Element, depth: number) => {
      const kids = layerChildren(el);
      row(el, depth, kids.length > 0);
      if (S.expanded.has(el.getAttribute(ID_ATTR)!)) for (const k of kids) walk(k, depth + 1);
    };
    for (const top of layerChildren(S.doc.body)) walk(top, 0);
  }
  layersEl.replaceChildren(frag);
  const count = document.getElementById("layer-count");
  if (count) count.textContent = String(S.doc.querySelectorAll(`body [${ID_ATTR}]`).length);
}

let layerDrag: string | null = null;
/** Layers panel drag and drop: the top / bottom of a row = before / after it, the middle = inside it. */
function wireLayerDrag(r: HTMLElement, id: string, el: Element): void {
  r.draggable = true;
  const clear = () => r.classList.remove("drop-before", "drop-after", "drop-inside");
  r.addEventListener("dragstart", (e) => {
    layerDrag = id;
    hideTip();
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    r.classList.add("dragging");
  });
  r.addEventListener("dragend", () => {
    layerDrag = null;
    r.classList.remove("dragging");
    layersEl.querySelectorAll(".drop-before, .drop-after, .drop-inside").forEach((x) => x.classList.remove("drop-before", "drop-after", "drop-inside"));
  });
  r.addEventListener("dragover", (e) => {
    const from = layerDrag && S.doc ? byId(S.doc, layerDrag) : null;
    if (!from || layerDrag === id || from.contains(el)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = r.getBoundingClientRect();
    const pos = (e.clientY - rect.top) / Math.max(1, rect.height);
    const where: Where = pos < 0.3 ? "before" : pos > 0.7 ? "after" : canHold(el) ? "inside" : pos < 0.5 ? "before" : "after";
    clear();
    r.classList.add(`drop-${where}`);
    r.dataset.drop = where;
  });
  r.addEventListener("dragleave", clear);
  r.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = layerDrag;
    const where = (r.dataset.drop || "after") as Where;
    clear();
    layerDrag = null;
    if (from && from !== id) moveTo(from, id, where);
  });
}

// ── properties ────────────────────────────────────────────────────────────────
function scopeNote(): string {
  return S.scope === "base"
    ? `Editing <b>Desktop</b> — applies to every size unless Tablet or Phone override it.`
    : S.scope === "tablet"
      ? `Editing <b>Tablet</b> — overrides Desktop below 1200 px.`
      : `Editing <b>Phone</b> — overrides Tablet and Desktop below 810 px.`;
}
function setStyle(prop: string, value: string, record = true): void {
  if (!S.sel) return;
  if (record) checkpoint();
  for (const id of selection()) S.edits = setEdit(S.edits, id, S.scope, prop, value.trim()); // several selected: all of them
  commit(false);
}
function renderProps(): void {
  if (panelTab === "inspect") return renderInspect();
  if (isMulti() && S.doc) return renderMultiProps();
  if (!S.sel || !S.doc) {
    propsEl.innerHTML = `${S.doc ? `<div class="sec ab-sec"></div>` : ""}<div class="empty-props"><span class="empty-ico">${icon("cursor", 22)}</span><strong>Select a layer</strong><span>Click anything on a canvas or in the Layers panel. Double-click text to edit it in place.</span>
<dl class="keys"><dt><kbd>⌘Z</kbd></dt><dd>Undo</dd><dt><kbd>⇧⌘Z</kbd></dt><dd>Redo</dd><dt><kbd>⌘D</kbd></dt><dd>Duplicate</dd><dt><kbd>⌫</kbd></dt><dd>Delete</dd><dt><kbd>Esc</kbd></dt><dd>Select parent</dd><dt><kbd>⌘ scroll</kbd></dt><dd>Zoom</dd></dl><button class="mini" data-keys>All shortcuts <kbd>?</kbd></button></div>`;
    propsEl.querySelector("[data-keys]")?.addEventListener("click", showShortcuts);
    const ab = propsEl.querySelector(".ab-sec");
    if (ab) ab.replaceWith(artboardSection());
    return;
  }
  const el = byId(S.doc, S.sel);
  if (!el) return;
  const live = byId(frameDoc(S.scope) || S.doc, S.sel) as HTMLElement | null;
  const cs = live && live.ownerDocument.defaultView ? live.ownerDocument.defaultView.getComputedStyle(live) : ({} as CSSStyleDeclaration);
  const kind = layerKind(el);
  const wrap = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "prop-head";
  head.innerHTML = `<div class="ph-row"><span class="kind-badge">${icon(KIND_ICON[kind], 16)}</span><div class="ph-name"><strong></strong><small></small></div></div><span class="scope-note">${icon(S.scope === "base" ? "desktop" : S.scope === "tablet" ? "tablet" : "phone", 13)}<span>${scopeNote()}</span></span>`;
  head.querySelector("strong")!.textContent = layerName(el);
  head.querySelector("small")!.textContent = `${KIND_NAME[kind]} · <${el.localName}>`;
  wrap.appendChild(head);

  // element actions
  const act = section("Element");
  const row = document.createElement("div");
  row.className = "tiles";
  const hidden = isHidden(S.sel);
  row.append(
    tile("parent", "Parent", "Select the parent layer", () => selectParent(), "Esc"),
    tile("copy", "Duplicate", "Duplicate this layer", () => duplicate(), "⌘D"),
    tile(hidden ? "eye" : "eyeOff", hidden ? "Show" : "Hide", `${hidden ? "Show" : "Hide"} on ${scopeLabel()}${S.scope === "base" ? " (every size)" : ""}`, () => toggleHidden()),
    tile("arrowUp", "Move up", "Move before the previous layer", () => move(-1)),
    tile("arrowDown", "Move down", "Move after the next layer", () => move(1)),
    tile("trash", "Delete", "Delete this layer", () => remove(), "⌫", true),
  );
  act.appendChild(row);
  wrap.appendChild(act);

  // content
  if ((kind === "text" || kind === "link" || kind === "button") && !Array.from(el.children).some((c) => !/^(br|span|b|strong|i|em|u|small)$/i.test(c.localName))) {
    const sec = section("Content");
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = (el as HTMLElement).innerText ?? el.textContent ?? "";
    ta.addEventListener("change", () => setText(ta.value));
    sec.appendChild(ta);
    wrap.appendChild(sec);
  }
  if (kind === "link" || el.localName === "a") {
    const sec = section("Link");
    sec.appendChild(textField("URL", el.getAttribute("href") || "", "", (v) => setAttr("href", v)));
    sec.appendChild(textField("Target", el.getAttribute("target") || "", "_self", (v) => setAttr("target", v)));
    wrap.appendChild(sec);
  }
  if (kind === "image") {
    const sec = section("Image");
    const isImg = el.localName === "img" || !!el.querySelector("img");
    const btns = document.createElement("div");
    btns.className = "btn-row";
    btns.append(miniBtn("Replace image…", () => replaceImage(isImg), false, "image"));
    sec.appendChild(btns);
    if (isImg) sec.appendChild(textField("Alt text", (el.localName === "img" ? el : el.querySelector("img"))?.getAttribute("alt") || "", "", (v) => setAttr("alt", v, true)));
    sec.appendChild(selectField("Fit", "objectFit", ["fill", "contain", "cover", "none", "scale-down"], cs));
    wrap.appendChild(sec);
  }

  for (const def of PROPERTY_SECTIONS) {
    if (def.when && !def.when(kind, cs)) continue;
    const sec = section(def.title);
    for (const f of def.fields) {
      if (def.title === "Spacing") {
        if (f === def.fields[0]) sec.appendChild(boxModelField(cs));
        continue;
      }
      if (SEGMENTS[f.prop]) sec.appendChild(segField(f.label, f.prop, SEGMENTS[f.prop], cs));
      else if (f.type === "select") sec.appendChild(selectField(f.label, f.prop, f.options || [], cs));
      else if (f.type === "color") sec.appendChild(colorField(f.label, f.prop, cs));
      else if (f.type === "range") sec.appendChild(rangeField(f.label, f.prop, cs, f.min!, f.max!, f.step!));
      else sec.appendChild(styleText(f.label, f.prop, cs));
    }
    wrap.appendChild(sec);
  }
  // lines, arrows and drawings: their stroke
  if (kind === "svg") {
    const sec = section("Stroke");
    sec.appendChild(colorField("Color", "stroke", cs));
    sec.appendChild(styleText("Width", "strokeWidth", cs));
    sec.appendChild(colorField("Fill", "fill", cs));
    wrap.appendChild(sec);
  }
  wrap.appendChild(motionSection(el, kind));
  // custom css
  const custom = section("Custom CSS");
  const ta = document.createElement("textarea");
  ta.rows = 4;
  ta.placeholder = "e.g.\nbackdrop-filter: blur(8px);\nmix-blend-mode: difference;";
  ta.value = Object.entries(S.edits[S.sel]?.[S.scope] || {})
    .filter(([k]) => !PROPERTY_SECTIONS.some((s) => s.fields.some((f) => f.prop === k)) && k !== "objectFit" && !BOX_PROPS.includes(k) && !isMotionProp(k) && !k.startsWith("--sl-in-") && !(kind === "svg" && /^(stroke|strokeWidth|fill)$/.test(k)))
    .map(([k, v]) => `${k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${v};`)
    .join("\n");
  ta.addEventListener("change", () => {
    checkpoint();
    for (const line of ta.value.split(/;|\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const k = name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()); // custom properties keep their name
      if (k) S.edits = setEdit(S.edits, S.sel!, S.scope, k, line.slice(i + 1).trim());
    }
    commit(false);
  });
  custom.appendChild(ta);
  wrap.appendChild(custom);
  propsEl.replaceChildren(wrap);
}
// ── Animate: motion added in Studio (stored as --slm-* edits, compiled to CSS; exports carry it) ──
const motionOf = (id: string, scope: Scope = S.scope): Motion | null => readMotion(mergedEdits(S.edits, id, scope));
const widerScope = (sc: Scope): Scope | null => (sc === "phone" ? "tablet" : sc === "tablet" ? "base" : null);
const isTextKind = (k: LayerKind) => k === "text" || k === "link" || k === "button";
/** Give a layer a motion on the current breakpoint (and smaller); null removes this breakpoint's. */
function setMotion(id: string, m: Motion | null, record = true): void {
  if (record) checkpoint();
  for (const k of Object.values(MOTION_KEYS)) S.edits = setEdit(S.edits, id, S.scope, k, "");
  if (m) for (const [k, v] of Object.entries(motionToProps(m))) S.edits = setEdit(S.edits, id, S.scope, k, v);
  commit(false);
  renderLayers();
  if (m && m.on !== "none") setTimeout(() => playMotion(id), 30);
}
/** "None": on Desktop that removes it; on a smaller breakpoint it switches the wider one's motion off there. */
function clearMotion(id: string): void {
  const w = widerScope(S.scope);
  setMotion(id, w && motionOf(id, w) ? { ...defaultMotion("enter"), on: "none" } : null);
}
/** Play a layer's motion on every artboard (hover effects show for a moment). */
function playMotion(id: string): void {
  forEachFrame((d) => {
    const el = byId(d, id) as HTMLElement | null;
    const win = d.defaultView;
    if (!el || !win) return;
    const cs = win.getComputedStyle(el);
    const on = cs.getPropertyValue(MOTION_KEYS.on).trim();
    if (!on || on === "none") return;
    if (on === "hover") {
      el.setAttribute("data-slm-hover", "");
      setTimeout(() => el.removeAttribute("data-slm-hover"), 1200);
      return;
    }
    const fx = cs.getPropertyValue(MOTION_KEYS.fx).trim();
    let undoSplit: (() => void) | null = null;
    if (fx === "words" && on !== "scroll" && !el.hasAttribute("data-slm-split")) {
      const before = el.innerHTML;
      splitWords(d, el);
      undoSplit = () => {
        el.innerHTML = before;
        el.removeAttribute("data-slm-split");
      };
    }
    const targets: HTMLElement[] = [el];
    if (el.hasAttribute("data-slm-split")) targets.push(...Array.from(el.querySelectorAll<HTMLElement>(".slm-w")));
    else if (parseFloat(cs.getPropertyValue(MOTION_KEYS.stagger)) > 0) targets.push(...(Array.from(el.children) as HTMLElement[]));
    for (const t of targets) t.style.setProperty("animation-name", "none", "important");
    void el.offsetWidth;
    for (const t of targets) t.style.removeProperty("animation-name");
    if (undoSplit) {
      const m = motionOf(id);
      const words = targets.length - 1;
      setTimeout(undoSplit, (m ? m.delay + m.dur + words * (m.stagger || 45) : 2000) + 400);
    }
  });
}
/** An animation that came with the page (recorded from the original site at capture), if any. */
function siteMotion(el: Element, pointer = true): { kind: string; timed: boolean } | null {
  if (!pointer) {
    /* the timeline animations only (entrances, loops, scroll) */
  } else if (el.hasAttribute("data-sl-magnet")) return { kind: "Follows the pointer (magnetic)", timed: false };
  else if (el.hasAttribute("data-sl-tilt")) return { kind: "Tilts toward the pointer (3D)", timed: false };
  else if (el.hasAttribute("data-sl-cursor")) return { kind: "Cursor follower", timed: false };
  if (el.hasAttribute("data-sl-loop")) return { kind: "Loop (marquee / floating)", timed: true };
  if (el.hasAttribute("data-sl-in")) return { kind: el.getAttribute("data-sl-in-on") === "enter" ? "Entrance as it scrolls into view" : "Entrance on page load", timed: true };
  if (el.hasAttribute("data-sl-wfs")) return { kind: "Moves with the scroll position", timed: false };
  if (el.hasAttribute("data-sl-scroll")) return { kind: "Moves with the scroll position", timed: false };
  if (el.hasAttribute("data-sl-reveal")) return { kind: "Reveal while scrolling", timed: false };
  return null;
}
/** The site's own animation on this layer: what it is, its timing (editable), play it, or switch it off. */
function siteMotionBlock(el: Element, id: string): HTMLElement | null {
  const sm = siteMotion(el, false);
  if (!sm) return null;
  const box = document.createElement("div");
  box.className = "site-motion";
  const off = effectiveEdit(S.edits, id, S.scope, "animation") === "none";
  const head = document.createElement("div");
  head.className = "sm-head";
  head.innerHTML = `${icon("sparkles", 13)}<span></span>`;
  head.querySelector("span")!.textContent = `From the original site: ${sm.kind}${off ? " (off)" : ""}`;
  box.appendChild(head);
  if (sm.timed && !off) {
    const live = byId(frameDoc(S.scope) || S.doc!, id) as HTMLElement | null;
    const cs = live?.ownerDocument.defaultView?.getComputedStyle(live);
    const ms = (p: string) => Math.round(parseFloat(effectiveEdit(S.edits, id, S.scope, p) || cs?.getPropertyValue(p) || "0") || 0);
    const field = (label: string, prop: string) => {
      const { row } = fieldShell(label, prop);
      const wrap = document.createElement("div");
      wrap.className = "num-unit";
      const i = document.createElement("input");
      i.type = "number";
      i.min = "0";
      i.step = "50";
      i.value = String(ms(prop));
      i.addEventListener("change", () => {
        const v = parseFloat(i.value);
        if (Number.isFinite(v)) setStyle(prop, `${Math.max(0, Math.round(v))}ms`);
      });
      const u = document.createElement("span");
      u.className = "unit";
      u.textContent = "ms";
      wrap.append(i, u);
      row.appendChild(wrap);
      return row;
    };
    box.append(field("Duration", "--sl-in-d"), field("Delay", "--sl-in-dl"));
  }
  const btns = document.createElement("div");
  btns.className = "btn-row";
  if (!off) btns.append(miniBtn("Play", () => playMotion(id), false, "play"));
  btns.append(
    miniBtn(off ? "Turn back on" : `Off on ${scopeLabel()}`, () => {
      setStyle("animation", off ? "" : "none");
      renderProps();
      renderLayers();
    }, !off, off ? "sparkles" : "eyeOff"),
  );
  box.appendChild(btns);
  const p = document.createElement("p");
  p.className = "sec-hint";
  p.textContent = "Recorded from the site when it was captured. Pick a trigger below to replace it with one of Studio's.";
  box.appendChild(p);
  return box;
}
/** A live 3D scene (one of the site's WebGL canvases): what happens to it, and how to keep the picture instead. */
function sceneBlock(el: Element): HTMLElement | null {
  if (!el.hasAttribute("data-sl-island")) return null;
  const box = document.createElement("div");
  box.className = "site-motion";
  const head = document.createElement("div");
  head.className = "sm-head";
  head.innerHTML = `${icon("sparkles", 13)}<span></span>`;
  head.querySelector("span")!.textContent = "Live 3D scene from the original site";
  const p = document.createElement("p");
  p.className = "sec-hint";
  p.textContent = "The site's own code runs it — interactive, following the scroll and the pointer — in Preview and in the HTML / React / Next.js exports (served from a web server). This picture stands in for it here, in the single-file and Elementor exports, and wherever scripts can't run. Move or resize it like any layer.";
  const btns = document.createElement("div");
  btns.className = "btn-row";
  btns.append(
    miniBtn("Replace with your 3D model…", () => replaceWithModel(), false, "sparkles"),
    miniBtn("Replace with an image…", () => { setAttr("data-sl-island", ""); replaceImage(true); renderLayers(); }, false, "image"),
    miniBtn("Use the picture instead", () => { setAttr("data-sl-island", ""); renderProps(); renderLayers(); }, false, "eyeOff"),
  );
  // ("Play live on the canvas" for the site's own scenes is switched off: it runs the site's whole page inside
  // Studio next to the artboards — twice that froze an 8 GB Mac. Preview runs the scene, one copy, safely.)
  if (LIVE_SITE_SCENES) {
    const id = S.sel!;
    const live = document.createElement("div");
    live.className = "btn-row";
    live.append(miniBtn(liveScenes.has(id) ? "Stop playing on the canvas" : "Play live on the canvas", () => void toggleLiveScene(id), false, "sparkles"));
    box.append(live);
  }
  const pv = document.createElement("p");
  pv.className = "sec-hint";
  pv.textContent = "To see it running and try its interaction, open Preview.";
  box.append(head, p, btns, pv);
  return box;
}
/** Live site scenes over the artboards: off (see sceneBlock) until they can run without the memory of a whole site. */
const LIVE_SITE_SCENES = false;
// ── "Play live" for the site's own scenes ─────────────────────────────────────────────────────────────────
// Each scene layer gets a clipping box over its spot in each artboard holding the scene's frame — the site's page,
// its own code drawing only that scene (as in the exports) — the artboard's width and screen tall, scrolled to
// where the layer sits on the page and shifted / scaled so its canvas lands on the layer. The scene's files come
// from the project (the same answers as the preview tab gives), served to those frames through the debugger
// attached to Studio's own tab while any scene plays.
const liveScenes = new Set<string>();
const liveSceneOv = new Map<string, { box: HTMLDivElement; f: HTMLIFrameElement; rect: { left: number; top: number; width: number; height: number } | null; ready: boolean }>();
let sceneSession: FrameSession | null = null, sceneRaf = 0, sceneTick = 0;
async function toggleLiveScene(id: string): Promise<void> {
  if (liveScenes.has(id)) {
    liveScenes.delete(id);
    syncLiveScenes();
    if (!liveScenes.size && sceneSession) {
      const s0 = sceneSession;
      sceneSession = null;
      await s0.stop();
    }
    renderProps();
    return;
  }
  if (!sceneSession) {
    const files = S.doc ? await sceneFiles(buildExportHtml(S.doc, S.edits)) : null;
    if (!files || !S.project) return toast("This project has no live scene files (export it again with \u201cKeep 3D scenes live\u201d on).", true);
    try {
      sceneSession = await startFrameInterception(files, S.project.url, () => {
        sceneSession = null;
        liveScenes.clear();
        syncLiveScenes();
        renderProps();
      });
    } catch (e) {
      return toast(`The scene couldn't start here (${e instanceof Error ? e.message : String(e)}). Preview still shows it running.`, true);
    }
  }
  // one live scene at a time: each is the site's whole page running (a second one would double the memory)
  liveScenes.clear();
  liveScenes.add(id);
  syncLiveScenes();
  renderProps();
}
function syncLiveScenes(): void {
  const want = new Set<string>();
  // only on the artboard being edited (each artboard would run the site's whole page once more — on a small
  // machine three at once is too much), and not while Studio's tab is hidden
  if (sceneSession && document.visibilityState === "visible")
    for (const id of liveScenes)
      for (const sc of SCOPES.filter((x) => x.id === S.scope)) {
        const f = S.frames.get(sc.id), d = f?.contentDocument, ph = d && byId(d, id);
        if (!f || !ph || !ph.hasAttribute("data-sl-island")) continue;
        const key = `${id}|${sc.id}`;
        want.add(key);
        const had = liveSceneOv.get(key);
        if (had && had.box.isConnected) continue;
        had?.box.remove();
        const sz = sizeOf(sc.id);
        const box = document.createElement("div");
        box.className = "sl-live-ov";
        box.setAttribute("aria-hidden", "true");
        box.style.cssText = "position:absolute;overflow:hidden;pointer-events:none;z-index:3";
        const fr = document.createElement("iframe");
        fr.title = "Live scene";
        fr.style.cssText = `position:absolute;left:0;top:0;border:0;width:${sz.w}px;height:${sz.h}px;transform-origin:0 0;opacity:0;transition:opacity .4s;background:transparent;color-scheme:normal`;
        fr.src = `${sceneSession.origin}/_3d/island.html?sl-island=${encodeURIComponent(ph.getAttribute("data-sl-island") || "0")}&sl-sel=${encodeURIComponent(ph.getAttribute("data-sl-island-sel") || "")}&sl-attrs=${encodeURIComponent(islandAttrs(ph))}`;
        box.appendChild(fr);
        f.parentElement?.appendChild(box);
        liveSceneOv.set(key, { box, f: fr, rect: null, ready: false });
      }
  for (const [k, o] of liveSceneOv) if (!want.has(k)) { o.box.remove(); liveSceneOv.delete(k); }
  if (liveSceneOv.size && !sceneRaf) sceneRaf = requestAnimationFrame(placeLiveScenes);
}
function placeLiveScenes(): void {
  sceneRaf = 0;
  if (++sceneTick % 30 === 0) syncLiveScenes();
  for (const [k, o] of liveSceneOv) {
    const [id, sc] = k.split("|");
    const f = S.frames.get(sc as Scope), d = f?.contentDocument, ph = d && (byId(d, id) as HTMLElement | null);
    if (!f || !ph) { o.box.style.display = "none"; continue; }
    const r = ph.getBoundingClientRect(), sz = sizeOf(sc as Scope);
    o.box.style.display = r.width > 2 && r.height > 2 ? "block" : "none";
    Object.assign(o.box.style, { left: `${f.offsetLeft + r.left}px`, top: `${f.offsetTop + r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // the scene at the spot the layer has on the page (centred in the screen), its canvas onto the layer
    const y = Math.max(0, Math.round(r.top - (sz.h - r.height) / 2));
    if (sceneTick % 6 === 0) o.f.contentWindow?.postMessage({ type: "sl-island-ask", key: k, x: 0, y }, "*");
    if (o.rect && o.rect.width > 0 && o.rect.height > 0) {
      const sx = r.width / o.rect.width, sy = r.height / o.rect.height;
      o.f.style.transform = `translate(${-o.rect.left * sx}px, ${-o.rect.top * sy}px) scale(${sx}, ${sy})`;
    }
    o.f.style.opacity = o.ready ? "1" : "0";
    o.f.style.pointerEvents = o.ready && liveAlt ? "auto" : "none";
    o.box.style.pointerEvents = o.ready && liveAlt ? "auto" : "none";
  }
  if (liveSceneOv.size) sceneRaf = requestAnimationFrame(placeLiveScenes);
}
document.addEventListener("visibilitychange", () => syncLiveScenes());
addEventListener("message", (e) => {
  const dta = e.data as { type?: string; key?: string; ready?: boolean; rect?: { left: number; top: number; width: number; height: number } | null };
  if (!dta || dta.type !== "sl-island-state" || !dta.key) return;
  const o = liveSceneOv.get(dta.key);
  if (!o || o.f.contentWindow !== e.source) return;
  o.ready = !!dta.ready;
  if (dta.rect) o.rect = dta.rect;
});
/** A 3D model of the user's own on this layer (replaced a scene): spin, turn with the pointer, swap it, or go back. */
function modelBlock(el: Element): HTMLElement | null {
  if (el.localName !== "model-viewer" || !el.hasAttribute("data-sl-model")) return null;
  const box = document.createElement("div");
  box.className = "site-motion";
  const head = document.createElement("div");
  head.className = "sm-head";
  head.innerHTML = `${icon("sparkles", 13)}<span></span>`;
  head.querySelector("span")!.textContent = `Your 3D model: ${el.getAttribute("data-sl-model") || "model"}`;
  const p = document.createElement("p");
  p.className = "sec-hint";
  p.textContent = "Shown turnable in Preview and in every export (Google's model-viewer, loaded from a CDN). Here on the canvas its poster — the scene's picture — stands in.";
  const toggles = document.createElement("div");
  toggles.className = "btn-row";
  const flag = (attr: string, on: string, off: string) =>
    // (a boolean attribute: its presence is what counts)
    miniBtn(el.hasAttribute(attr) ? off : on, () => { setAttr(attr, el.hasAttribute(attr) ? "" : attr); renderProps(); }, false, "sparkles");
  toggles.append(flag("auto-rotate", "Spin on its own", "Stop spinning"), flag("camera-controls", "Let visitors turn it", "Lock the view"));
  const btns = document.createElement("div");
  btns.className = "btn-row";
  btns.append(miniBtn("Replace model…", () => replaceWithModel(), false, "sparkles"), miniBtn("Use the picture instead", () => modelToPicture(), true, "eyeOff"));
  const id = S.sel!;
  const live = document.createElement("div");
  live.className = "btn-row";
  live.append(miniBtn(liveModels.has(id) ? "Stop playing on the canvas" : "Play live on the canvas", () => { if (liveModels.has(id)) liveModels.delete(id); else liveModels.add(id); syncLiveModels(); renderProps(); }, false, "sparkles"));
  const liveHint = document.createElement("p");
  liveHint.className = "sec-hint";
  liveHint.textContent = liveModels.has(id) ? "Running over the canvas — clicks still select and edit what's underneath. Hold Alt (⌥) to turn it with the mouse." : "Shows the model running right here, over its picture, while you edit around it (nothing in the page changes).";
  box.append(head, p, toggles, btns, live, liveHint);
  return box;
}
// ── "Play live" on the canvas ─────────────────────────────────────────────────────────────────────────────
// The artboards run no scripts (so editing stays safe); a model of yours can still be seen running there: a small
// frame over its spot in each artboard — Studio's sandboxed preview page (its own origin, scripts allowed) showing
// just that model. Nothing is added to the page; clicks pass through to the artboard, Alt held lets the pointer
// turn the model. Positioned in the artboard's own coordinates, so zoom and scrolling move it along.
const liveModels = new Set<string>();
const liveOv = new Map<string, HTMLIFrameElement>(); // "id|scope" → its frame
let liveRaf = 0, liveTick = 0, liveAlt = false;
function liveModelHtml(el: Element): string {
  const keep = ["src", "camera-controls", "auto-rotate", "exposure", "shadow-intensity", "environment-image", "skybox-image", "camera-orbit", "field-of-view", "rotation-per-second", "alt"];
  const attrs = keep.filter((a) => el.hasAttribute(a)).map((a) => `${a}="${(el.getAttribute(a) || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join(" ");
  return `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="${MODEL_VIEWER_SRC}"></script><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}model-viewer{width:100%;height:100%;--poster-color:transparent}</style></head><body><model-viewer ${attrs} interaction-prompt="none"></model-viewer></body></html>`;
}
function syncLiveModels(): void {
  const want = new Set<string>();
  for (const id of liveModels)
    for (const sc of SCOPES) {
      const f = S.frames.get(sc.id), d = f?.contentDocument, el = d && byId(d, id);
      if (!f || !el || el.localName !== "model-viewer") continue;
      const key = `${id}|${sc.id}`;
      want.add(key);
      // (still in place and showing this model as it is now: kept; else made again)
      const sig = `${(el.getAttribute("src") || "").length}|${(el.getAttribute("src") || "").slice(-48)}|${el.hasAttribute("auto-rotate")}|${el.hasAttribute("camera-controls")}`;
      const had = liveOv.get(key);
      if (had && had.isConnected && had.dataset.sig === sig) continue;
      had?.remove();
      const ov = document.createElement("iframe");
      ov.className = "sl-live-ov";
      ov.title = "Live model";
      ov.setAttribute("aria-hidden", "true");
      ov.style.cssText = "position:absolute;border:0;background:transparent;pointer-events:none;z-index:3;color-scheme:normal";
      ov.src = chrome.runtime.getURL("sl-preview.html");
      ov.dataset.html = liveModelHtml(el);
      ov.dataset.sig = sig;
      f.parentElement?.appendChild(ov);
      liveOv.set(key, ov);
    }
  for (const [k, ov] of liveOv) if (!want.has(k)) { ov.remove(); liveOv.delete(k); }
  if (liveOv.size && !liveRaf) liveRaf = requestAnimationFrame(placeLive);
}
function placeLive(): void {
  liveRaf = 0;
  if (++liveTick % 30 === 0) syncLiveModels(); // the artboards re-render after edits: re-attach
  for (const [k, ov] of liveOv) {
    const [id, sc] = k.split("|");
    const f = S.frames.get(sc as Scope), d = f?.contentDocument, el = d && (byId(d, id) as HTMLElement | null);
    if (!f || !el) { ov.style.display = "none"; continue; }
    const r = el.getBoundingClientRect(); // in the artboard's own (unscaled) coordinates
    ov.style.display = r.width > 2 && r.height > 2 ? "block" : "none";
    ov.style.left = `${f.offsetLeft + r.left}px`;
    ov.style.top = `${f.offsetTop + r.top}px`;
    ov.style.width = `${r.width}px`;
    ov.style.height = `${r.height}px`;
    ov.style.pointerEvents = liveAlt ? "auto" : "none";
  }
  if (liveOv.size) liveRaf = requestAnimationFrame(placeLive);
}
addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "sl-preview-ready") return;
  for (const ov of liveOv.values()) if (ov.contentWindow === e.source && ov.dataset.html) ov.contentWindow!.postMessage({ type: "sl-preview", html: ov.dataset.html }, "*");
});
addEventListener("keydown", (e) => { if (e.key === "Alt") liveAlt = true; });
addEventListener("keyup", (e) => { if (e.key === "Alt") liveAlt = false; });
addEventListener("blur", () => { liveAlt = false; });
/** Pick a .glb / .gltf and put it in place of the selected scene (or model): a <model-viewer> that keeps the layer —
 *  its id, classes, styles and size (its box: the picture's size, or the width / height the page gives it) — with
 *  the picture inside as its poster (what shows where scripts don't run, and while the model loads). */
function replaceWithModel(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".glb,.gltf,model/gltf-binary,model/gltf+json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 60_000_000) return toast("That model is over 60 MB — too big for a web page. Export a lighter version (.glb, compressed textures).", true);
    if (/\.gltf$/i.test(file.name)) toast("A .gltf that points at separate .bin / texture files can't come along — a single .glb (everything inside) is best.");
    const fr = new FileReader();
    fr.onload = () => {
      const data = String(fr.result).replace(/^data:[^;,]*/, /\.gltf$/i.test(file.name) ? "data:model/gltf+json" : "data:model/gltf-binary");
      const id = S.sel!;
      // the size the stand-in shows at on the canvas (for one with no size from the page's CSS)
      let shown: { w: number; h: number; fromCss: boolean } | null = null;
      forEachFrame((d) => {
        const h = byId(d, id) as HTMLElement | null;
        if (!h || shown) return;
        const r = h.getBoundingClientRect(), aw = parseFloat(h.getAttribute("width") || "0");
        shown = { w: Math.round(r.width), h: Math.round(r.height), fromCss: !aw || Math.abs(aw - r.width) > 1 };
      });
      checkpoint();
      mirror((d) => {
        const host = byId(d, id);
        if (!host) return;
        if (host.localName === "model-viewer") {
          host.setAttribute("src", data);
          host.setAttribute("data-sl-model", file.name);
          return;
        }
        const mv = d.createElement("model-viewer");
        for (const a of Array.from(host.attributes)) if (!/^(src|srcset|sizes|alt|width|height|loading|decoding|fetchpriority|data-sl-island.*|data-sl-canvas|data-file)$/.test(a.name)) mv.setAttribute(a.name, a.value);
        mv.setAttribute("src", data);
        mv.setAttribute("data-sl-model", file.name);
        mv.setAttribute("alt", file.name.replace(/\.[^.]+$/, ""));
        for (const f of ["camera-controls", "auto-rotate"]) mv.setAttribute(f, "");
        mv.setAttribute("touch-action", "pan-y");
        mv.setAttribute("interaction-prompt", "none");
        mv.setAttribute("shadow-intensity", "1");
        const st = (mv as HTMLElement).style;
        st.setProperty("display", "block");
        const w = parseFloat(host.getAttribute("width") || "0"), h = parseFloat(host.getAttribute("height") || "0");
        if (w > 0 && h > 0) st.setProperty("aspect-ratio", `${w} / ${h}`);
        const sz = shown as { w: number; h: number; fromCss: boolean } | null;
        if (sz && !sz.fromCss && !st.width) {
          st.setProperty("width", `${sz.w}px`);
          st.setProperty("max-width", "100%");
          st.setProperty("height", "auto");
        }
        // the picture: its poster (and the old picture to go back to)
        const src = host.localName === "img" ? host.getAttribute("src") : (host.querySelector("img") as HTMLImageElement | null)?.getAttribute("src");
        if (src) {
          const poster = d.createElement("img");
          poster.setAttribute("slot", "poster");
          poster.setAttribute("src", src);
          poster.setAttribute("alt", "");
          poster.setAttribute("style", "width: 100%; height: 100%; object-fit: contain; display: block;");
          mv.appendChild(poster);
        }
        host.replaceWith(mv);
      });
      commit(true);
      renderProps();
      renderLayers();
      toast(`${file.name} is in — turnable in Preview and in every export.`);
    };
    fr.readAsDataURL(file);
  };
  input.click();
}
/** Back to the picture: the model's poster becomes the layer again. */
function modelToPicture(): void {
  const id = S.sel!;
  checkpoint();
  mirror((d) => {
    const mv = byId(d, id);
    if (!mv || mv.localName !== "model-viewer") return;
    const img = d.createElement("img");
    for (const a of Array.from(mv.attributes)) if (!/^(src|data-sl-model|camera-controls|auto-rotate|touch-action|interaction-prompt|shadow-intensity|alt)$/.test(a.name)) img.setAttribute(a.name, a.value);
    const poster = mv.querySelector('img[slot="poster"]');
    img.setAttribute("src", poster?.getAttribute("src") || "");
    img.setAttribute("alt", "");
    mv.replaceWith(img);
  });
  commit(true);
  renderProps();
  renderLayers();
}
/** The site's pointer effects on this layer (recorded at capture): how strongly it follows, or switch it off.
 *  Stored on the element itself (attributes), so every export and the Preview carry the change. */
function sitePointerBlock(el: Element): HTMLElement | null {
  const kinds: { attr: string; label: string; field: string; unit: string; hint: string; get: (v: string) => number; set: (n: number, v: string) => string }[] = [
    { attr: "data-sl-magnet", label: "Follows the pointer (magnetic)", field: "Strength", unit: "%", hint: "How much of the pointer's offset it follows", get: (v) => Math.round((parseFloat(v) || 0) * 100), set: (n) => (n / 100).toFixed(2) },
    { attr: "data-sl-tilt", label: "Tilts toward the pointer (3D)", field: "Angle", unit: "°", hint: "How far it tilts at its edge", get: (v) => Math.round((parseFloat(v) || 0) * 10) / 10, set: (n) => String(Math.max(0.5, Math.min(45, n))) },
    {
      attr: "data-sl-cursor", label: "Cursor follower", field: "Catch-up", unit: "%", hint: "How much of the way to the pointer it closes each frame (100 = sticks to it)",
      get: (v) => { try { return Math.round((JSON.parse(v).k || 0.2) * 100); } catch { return 20; } },
      set: (n, v) => { let o: Record<string, number> = {}; try { o = JSON.parse(v); } catch { /* fresh */ } return JSON.stringify({ ...o, k: Math.max(0.02, Math.min(1, n / 100)) }); },
    },
  ];
  const have = kinds.filter((k) => el.hasAttribute(k.attr));
  if (!have.length) return null;
  const box = document.createElement("div");
  box.className = "site-motion";
  for (const k of have) {
    const v = el.getAttribute(k.attr) || "";
    const head = document.createElement("div");
    head.className = "sm-head";
    head.innerHTML = `${icon("sparkles", 13)}<span></span>`;
    head.querySelector("span")!.textContent = `From the original site: ${k.label}`;
    const { row } = fieldShell(k.field, null);
    row.title = k.hint;
    const wrap = document.createElement("div");
    wrap.className = "num-unit";
    const i = document.createElement("input");
    i.type = "number";
    i.step = k.unit === "°" ? "0.5" : "5";
    i.value = String(k.get(v));
    i.addEventListener("change", () => {
      const n = parseFloat(i.value);
      if (Number.isFinite(n)) setAttr(k.attr, k.set(n, el.getAttribute(k.attr) || v));
    });
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = k.unit;
    wrap.append(i, u);
    row.appendChild(wrap);
    const btns = document.createElement("div");
    btns.className = "btn-row";
    btns.append(miniBtn("Off", () => { setAttr(k.attr, ""); renderProps(); renderLayers(); }, true, "eyeOff"));
    box.append(head, row, btns);
  }
  const p = document.createElement("p");
  p.className = "sec-hint";
  p.textContent = "Runs in the Preview and the exports with a real pointer (the artboards don't move with it). Undo brings a switched-off effect back.";
  box.appendChild(p);
  return box;
}
function motionSection(el: Element, kind: LayerKind): HTMLElement {
  const sec = section("Animate");
  const id = S.sel!;
  const m = motionOf(id);
  const scene = sceneBlock(el) || modelBlock(el);
  if (scene) sec.appendChild(scene);
  const pointerFx = sitePointerBlock(el);
  if (pointerFx) sec.appendChild(pointerFx);
  const fromSite = !m || m.on === "none" ? siteMotionBlock(el, id) : null;
  if (fromSite) sec.appendChild(fromSite);
  const own = Object.keys(S.edits[id]?.[S.scope] || {}).some(isMotionProp);
  const textLayer = isTextKind(kind);
  const update = (patch: Partial<Motion>) => {
    if (!m) return;
    setMotion(id, { ...m, ...patch });
    renderProps();
  };
  // trigger
  const { row: trow } = fieldShell("Trigger", null);
  if (own) trow.classList.add("edited");
  const trig = document.createElement("select");
  trig.innerHTML = TRIGGERS.map((t) => `<option value="${t.id}"${(m?.on || "none") === t.id ? " selected" : ""}>${t.label}</option>`).join("");
  trig.addEventListener("change", () => {
    const on = trig.value as MotionOn;
    if (on === "none") clearMotion(id);
    else setMotion(id, defaultMotion(on, textLayer, m && m.on !== "none" ? m.fx : undefined));
    renderProps();
  });
  trow.appendChild(trig);
  sec.appendChild(trow);
  if (!m || m.on === "none") {
    const p = document.createElement("p");
    p.className = "sec-hint";
    p.textContent = m?.on === "none" ? `Switched off on ${scopeLabel()}.` : "Fade, slide, zoom or reveal it as it scrolls into view, on hover, or in a loop. Exports carry it.";
    sec.appendChild(p);
    return sec;
  }
  // effect
  const { row: erow } = fieldShell("Effect", null);
  const eff = document.createElement("select");
  eff.innerHTML = effectsFor(m.on, textLayer).map(([k, label]) => `<option value="${k}"${k === m.fx ? " selected" : ""}>${label}</option>`).join("");
  eff.addEventListener("change", () => {
    const d = defaultMotion(m.on, textLayer, eff.value);
    update({ fx: eff.value, ...(m.on === "loop" ? { dur: d.dur, ease: d.ease, dist: d.dist } : {}), ...(eff.value === "words" ? { stagger: 45, dur: 700 } : m.fx === "words" ? { stagger: 0 } : {}) });
  });
  erow.appendChild(eff);
  sec.appendChild(erow);
  const num = (label: string, value: number, unit: string, tip: string, on: (v: number) => void, step = 50) => {
    const { row } = fieldShell(label, null);
    row.title = tip;
    const wrap = document.createElement("div");
    wrap.className = "num-unit";
    const i = document.createElement("input");
    i.type = "number";
    i.min = "0";
    i.step = String(step);
    i.value = String(value);
    i.addEventListener("change", () => {
      const v = parseFloat(i.value);
      if (Number.isFinite(v)) on(v);
    });
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = unit;
    wrap.append(i, u);
    row.appendChild(wrap);
    return row;
  };
  if (m.on !== "scroll") {
    sec.appendChild(num("Duration", m.dur, "ms", "How long it takes", (v) => update({ dur: v })));
    sec.appendChild(num("Delay", m.delay, "ms", "Wait before it starts", (v) => update({ delay: v })));
    const { row: arow } = fieldShell("Easing", null);
    const ez = document.createElement("select");
    ez.innerHTML = Object.entries(EASES).map(([k, e]) => `<option value="${k}"${k === m.ease ? " selected" : ""}>${e.label}</option>`).join("");
    ez.addEventListener("change", () => update({ ease: ez.value }));
    arow.appendChild(ez);
    sec.appendChild(arow);
  }
  const usesDist = (m.on === "hover" && HOVER_FX[m.fx]?.dist) || (m.on === "loop" && /float|bounce|sway/.test(m.fx)) || (m.on !== "hover" && m.on !== "loop" && ENTER_FX[m.fx]?.dist);
  if (usesDist && m.on === "hover" && m.fx === "magnet") sec.appendChild(num("Pull", m.dist, "px", "How far it can be pulled toward the pointer at its edge", (v) => update({ dist: v }), 2));
  else if (usesDist && m.on === "hover" && m.fx === "tilt3d") sec.appendChild(num("Angle", m.dist, "°", "How far it tilts toward the pointer at its edge", (v) => update({ dist: v }), 1));
  else if (usesDist) sec.appendChild(num("Distance", m.dist, "px", "How far it moves", (v) => update({ dist: v }), 2));
  if ((m.on === "enter" || m.on === "load") && m.fx === "words") sec.appendChild(num("Per word", m.stagger || 45, "ms", "Time between one word and the next", (v) => update({ stagger: v }), 5));
  else if ((m.on === "enter" || m.on === "load") && el.children.length > 1) {
    sec.appendChild(num("Stagger", m.stagger, "ms", "0 = all together; otherwise its items come in one after another, this far apart", (v) => update({ stagger: v }), 10));
  }
  if (m.on === "enter") {
    const lab = document.createElement("label");
    lab.className = "check-row";
    lab.innerHTML = `<input type="checkbox" ${m.replay ? "checked" : ""}><span>Play every time it scrolls into view</span>`;
    lab.querySelector("input")!.addEventListener("change", (e) => update({ replay: (e.target as HTMLInputElement).checked }));
    sec.appendChild(lab);
  }
  const p = document.createElement("p");
  p.className = "sec-hint";
  p.textContent = `${TRIGGERS.find((t) => t.id === m.on)?.hint || ""}${m.on === "scroll" ? " (Chrome, Edge, Safari; elsewhere it simply shows)" : ""}. ${own ? `Set on ${scopeLabel()}${S.scope === "base" ? " (every size)" : " and smaller"}.` : `From ${widerScope(S.scope) === "base" ? "Desktop" : "Tablet"}; changing it here applies to ${scopeLabel()} and smaller.`}`;
  sec.appendChild(p);
  const btns = document.createElement("div");
  btns.className = "btn-row";
  if (m.on !== "scroll") btns.append(miniBtn(m.on === "hover" ? "Preview" : "Play", () => playMotion(id), false, "play"));
  btns.append(miniBtn(S.scope === "base" || own ? "Remove" : `Off on ${scopeLabel()}`, () => {
    if (own && S.scope !== "base") setMotion(id, null);
    else clearMotion(id);
    renderProps();
  }, true, "trash"));
  sec.appendChild(btns);
  return sec;
}
/** The right-click menu's Animate submenu: one-click presets (fine-tune them in the Animate section). */
function animateMenu(id: string, kind: LayerKind, hasKids: boolean): MenuEntry[] {
  const text = isTextKind(kind);
  const pick = (on: MotionOn, fx: string, extra: Partial<Motion> = {}) => () => {
    select(id, false);
    setMotion(id, { ...defaultMotion(on, text, fx), ...extra });
    renderProps();
  };
  const m = motionOf(id);
  return [
    { label: "Fade in on scroll", run: pick("enter", "fade") },
    { label: "Slide up on scroll", run: pick("enter", "up") },
    { label: "Zoom in on scroll", run: pick("enter", "zoom") },
    ...(text ? [{ label: "Text word by word", run: pick("enter", "words") } as MenuEntry] : []),
    ...(hasKids ? [{ label: "Items one after another", run: pick("enter", "up", { stagger: 90 }) } as MenuEntry] : []),
    { label: "Move with the scroll", run: pick("scroll", "up") },
    "-",
    { label: "Lift on hover", run: pick("hover", "lift") },
    { label: "Grow on hover", run: pick("hover", "grow") },
    "-",
    { label: "Float (loop)", run: pick("loop", "float") },
    { label: "Pulse (loop)", run: pick("loop", "pulse") },
    { label: "Spin (loop)", run: pick("loop", "spin") },
    "-",
    { label: "Play", icon: "play", disabled: !m || m.on === "none" || m.on === "scroll", run: () => playMotion(id) },
    { label: "Remove animation", icon: "trash", disabled: !m || m.on === "none", run: () => { select(id, false); clearMotion(id); renderProps(); } },
  ];
}
/** Several layers selected: align / space them, act on them together, and styles that apply to all. */
function renderMultiProps(): void {
  const ids = selection();
  const els = ids.map((id) => byId(S.doc!, id)).filter((e): e is Element => !!e);
  const live = byId(frameDoc(S.scope) || S.doc!, ids[0]) as HTMLElement | null;
  const cs = live && live.ownerDocument.defaultView ? live.ownerDocument.defaultView.getComputedStyle(live) : ({} as CSSStyleDeclaration);
  const wrap = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "prop-head";
  head.innerHTML = `<div class="ph-row"><span class="kind-badge">${icon("selectMany", 16)}</span><div class="ph-name"><strong></strong><small></small></div></div><span class="scope-note">${icon(S.scope === "base" ? "desktop" : S.scope === "tablet" ? "tablet" : "phone", 13)}<span>${scopeNote()}</span></span>`;
  head.querySelector("strong")!.textContent = `${ids.length} layers`;
  const names = els.slice(0, 3).map((e) => layerName(e));
  head.querySelector("small")!.textContent = names.join(", ") + (els.length > 3 ? ` and ${els.length - 3} more` : "");
  wrap.appendChild(head);
  const al = section("Align");
  const row = document.createElement("div");
  row.className = "tiles tiles-4";
  row.append(
    tile("alignObjLeft", "Left", "Align left edges", () => alignSelection("left"), "⌥A"),
    tile("alignObjCenter", "Centre", "Align centres (across)", () => alignSelection("hcenter"), "⌥H"),
    tile("alignObjRight", "Right", "Align right edges", () => alignSelection("right"), "⌥D"),
    tile("distributeX", "Space across", "Space evenly across (3 or more)", () => distributeSelection("x"), "⌃⌥H"),
    tile("alignObjTop", "Top", "Align top edges", () => alignSelection("top"), "⌥W"),
    tile("alignObjMiddle", "Middle", "Align middles (down)", () => alignSelection("vcenter"), "⌥V"),
    tile("alignObjBottom", "Bottom", "Align bottom edges", () => alignSelection("bottom"), "⌥S"),
    tile("distributeY", "Space down", "Space evenly down (3 or more)", () => distributeSelection("y"), "⌃⌥V"),
  );
  al.appendChild(row);
  const hint = document.createElement("p");
  hint.className = "sec-hint";
  hint.textContent = `Lines them up with the box around them all, on ${scopeLabel()}${S.scope === "base" ? " (every size)" : " and smaller"}. ⇧-click or drag a box to change the selection; Esc keeps just the first.`;
  al.appendChild(hint);
  wrap.appendChild(al);
  const act = section("Selection");
  const row2 = document.createElement("div");
  row2.className = "tiles";
  row2.append(
    tile("frame", "Group", "Group them in one container", () => wrapSelection(false), "⌘G"),
    tile("layout", "Frame", "Frame them with auto layout", () => wrapSelection(true), "⌥⌘G"),
    tile("copy", "Duplicate", "Duplicate each one", () => duplicate(), "⌘D"),
    tile("eyeOff", "Hide", `Hide them on ${scopeLabel()}`, () => hideSelection()),
    tile("trash", "Delete", "Delete them", () => remove(), "⌫", true),
  );
  act.appendChild(row2);
  wrap.appendChild(act);
  // styles: whatever is changed here applies to every selected layer (values shown are the first one's)
  const allText = els.every((e) => isTextKind(layerKind(e)));
  for (const def of PROPERTY_SECTIONS) {
    if (!["Size", "Styles", "Text", "Transforms"].includes(def.title)) continue;
    if (def.title === "Text" && !allText) continue;
    const sec = section(def.title);
    if (def.title === "Size") {
      const p = document.createElement("p");
      p.className = "sec-hint";
      p.textContent = `Changes here apply to all ${ids.length} (shown: the first one's values).`;
      sec.appendChild(p);
    }
    for (const f of def.fields) {
      if (SEGMENTS[f.prop]) sec.appendChild(segField(f.label, f.prop, SEGMENTS[f.prop], cs));
      else if (f.type === "select") sec.appendChild(selectField(f.label, f.prop, f.options || [], cs));
      else if (f.type === "color") sec.appendChild(colorField(f.label, f.prop, cs));
      else if (f.type === "range") sec.appendChild(rangeField(f.label, f.prop, cs, f.min!, f.max!, f.step!));
      else sec.appendChild(styleText(f.label, f.prop, cs));
    }
    wrap.appendChild(sec);
  }
  propsEl.replaceChildren(wrap);
}
const SECTION_ICON: Record<string, IconName> = {
  Element: "cursor", Content: "paragraph", Link: "link", Image: "image", Position: "move", Size: "size", Layout: "layout",
  Spacing: "spacing", Styles: "droplet", Transforms: "rotate", Text: "type", "Custom CSS": "braces", Artboard: "desktop", Stroke: "pen", Grid: "grid", Animate: "sparkles", Align: "alignObjLeft", Selection: "selectMany",
};
/** The breakpoint's artboard: its width (within its range), its screen height, presets, fit, reset. */
function artboardSection(): HTMLElement {
  const sc = S.scope;
  const { w, h } = sizeOf(sc);
  const label = scopeLabel();
  const sec = section("Artboard");
  sec.classList.add("ab-sec");
  sec.querySelector("h4 span")!.textContent = `${label} artboard`;
  const num = (lbl: string, value: number, [min, max]: [number, number], tip: string, on: (v: number) => void) => {
    const { row } = fieldShell(lbl, null);
    row.dataset.tip = tip;
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    i.addEventListener("change", () => on(Number(i.value) || value));
    row.appendChild(i);
    return row;
  };
  const width = fieldShell("Width", null).row;
  const wv = document.createElement("span");
  wv.className = "ro";
  wv.textContent = `${w} px`;
  width.dataset.tip = `${label} is always ${w} px wide — the other sizes have their own artboards`;
  width.appendChild(wv);
  sec.append(width, num("Height", h, HEIGHT_RANGE, "The screen height (what 100vh means here). Longer pages still show in full.", (v) => setArtboardSize(sc, v)));
  const acts = document.createElement("div");
  acts.className = "btn-row";
  acts.append(miniBtn("Fit height to page", () => fitHeight(sc), false, "size"), miniBtn("Reset", () => resetArtboardSize(sc), false, "undo"));
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Or drag the dashed fold line on the canvas.";
  sec.append(acts, hint);
  // layout grid for this breakpoint
  const g = gridSpecOf(sc);
  const gh = document.createElement("div");
  gh.className = "sub-head";
  gh.innerHTML = `${icon("columns", 14)}<span>Layout grid</span>`;
  const show = document.createElement("label");
  show.className = "switch-row";
  show.innerHTML = `<input type="checkbox" ${UI.grid ? "checked" : ""}><span class="switch" aria-hidden="true"></span><span>Show</span>`;
  show.querySelector("input")!.addEventListener("change", (e) => setTools({ grid: (e.target as HTMLInputElement).checked }));
  gh.appendChild(show);
  sec.append(
    gh,
    num("Columns", g.columns, [1, 24], "How many columns", (v) => setGridSpec(sc, { columns: v })),
    num("Gutter", g.gutter, [0, 200], "Space between columns (px)", (v) => setGridSpec(sc, { gutter: v })),
    num("Margin", g.margin, [0, 400], "Space at the left and right edges (px)", (v) => setGridSpec(sc, { margin: v })),
  );
  return sec;
}
// margin and padding, side by side, as a box: like the browser's box model (Figma has no margins)
const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
const BOX_PROPS = ["margin", "padding"].flatMap((k) => SIDES.map((sd) => k + sd));
const unitless = (v: string) => (/^-?\d*\.?\d+px$/.test(v.trim()) ? String(parseFloat(v)) : v);
const withPx = (v: string) => (/^-?\d*\.?\d+$/.test(v.trim()) ? `${v.trim()}px` : v.trim());
function boxModelField(cs: CSSStyleDeclaration): HTMLElement {
  const box = document.createElement("div");
  box.className = "boxm";
  const input = (kind: "margin" | "padding", side: (typeof SIDES)[number]) => {
    const prop = kind + side;
    const i = document.createElement("input");
    i.className = `bm-in bm-${side.toLowerCase()}` + (S.edits[S.sel!]?.[S.scope]?.[prop] !== undefined ? " edited" : "");
    i.value = unitless(effectiveEdit(S.edits, S.sel!, S.scope, prop) || "");
    i.placeholder = unitless(computedOf(cs, prop)) || "0";
    i.dataset.tip = `${kind[0].toUpperCase() + kind.slice(1)} ${side.toLowerCase()} — ↑ ↓ to nudge (⇧ ×10)`;
    i.setAttribute("aria-label", `${kind} ${side.toLowerCase()}`);
    i.addEventListener("change", () => setStyle(prop, withPx(i.value)));
    i.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const n = parseFloat(i.value || i.placeholder) || 0;
      i.value = String(n + (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1));
      setStyle(prop, withPx(i.value));
    });
    return i;
  };
  const pad = document.createElement("div");
  pad.className = "bm-pad";
  const core = document.createElement("div");
  core.className = "bm-core";
  core.textContent = `${Math.round(parseFloat(cs.width) || 0)} × ${Math.round(parseFloat(cs.height) || 0)}`;
  const lp = document.createElement("span");
  lp.className = "bm-label";
  lp.textContent = "Padding";
  pad.append(lp, input("padding", "Top"), input("padding", "Left"), core, input("padding", "Right"), input("padding", "Bottom"));
  const lm = document.createElement("span");
  lm.className = "bm-label";
  lm.textContent = "Margin";
  box.append(lm, input("margin", "Top"), input("margin", "Left"), pad, input("margin", "Right"), input("margin", "Bottom"));
  return box;
}
function section(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "sec";
  const h = document.createElement("h4");
  h.innerHTML = icon(SECTION_ICON[title] || "box", 14);
  const t = document.createElement("span");
  t.textContent = title;
  h.appendChild(t);
  s.appendChild(h);
  return s;
}
function miniBtn(label: string, fn: () => void, danger = false, ic?: IconName): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "mini" + (danger ? " danger" : "");
  if (ic) b.innerHTML = icon(ic, 14);
  b.append(label);
  b.addEventListener("click", fn);
  return b;
}
/** An action tile: icon above a short label (easy to find), the full description + shortcut as tooltip. */
function tile(ic: IconName, label: string, tip: string, fn: () => void, key = "", danger = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tile" + (danger ? " danger" : "");
  b.innerHTML = icon(ic, 16);
  const l = document.createElement("span");
  l.textContent = label;
  b.appendChild(l);
  b.dataset.tip = tip;
  if (key) b.dataset.key = key;
  b.setAttribute("aria-label", tip);
  b.addEventListener("click", fn);
  return b;
}
// choices that read better as pictures than as words in a dropdown
const SEGMENTS: Record<string, [string, IconName, string][]> = {
  textAlign: [["left", "alignLeft", "Align left"], ["center", "alignCenter", "Align center"], ["right", "alignRight", "Align right"], ["justify", "alignJustify", "Justify"]],
  flexDirection: [["row", "arrowRight", "Row — left to right"], ["column", "arrowDown", "Column — top to bottom"], ["row-reverse", "arrowLeft", "Row, reversed"], ["column-reverse", "arrowUp", "Column, reversed"]],
};
function segField(label: string, prop: string, segs: [string, IconName, string][], cs: CSSStyleDeclaration): HTMLElement {
  const { row } = fieldShell(label, prop);
  const g = document.createElement("div");
  g.className = "seg-ctl";
  g.setAttribute("role", "radiogroup");
  g.setAttribute("aria-label", label);
  const raw = effectiveEdit(S.edits, S.sel!, S.scope, prop) || computedOf(cs, prop);
  const cur = raw === "start" ? "left" : raw === "end" ? "right" : raw;
  const btns: HTMLButtonElement[] = [];
  for (const [value, ic, tip] of segs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (cur === value ? " on" : "");
    b.innerHTML = icon(ic, 15);
    b.dataset.tip = tip;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", tip);
    b.setAttribute("aria-checked", String(cur === value));
    b.addEventListener("click", () => {
      setStyle(prop, value);
      for (const x of btns) {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-checked", String(x === b));
      }
      row.classList.add("edited");
    });
    btns.push(b);
    g.appendChild(b);
  }
  row.appendChild(g);
  return row;
}
function fieldShell(label: string, prop: string | null): { row: HTMLDivElement } {
  const row = document.createElement("div");
  row.className = "field" + (prop && S.sel && S.edits[S.sel]?.[S.scope]?.[prop] !== undefined ? " edited" : "");
  const l = document.createElement("label");
  l.textContent = label;
  l.title = prop ? `${label} — ${S.scope === "base" ? "Desktop" : S.scope} value` : label;
  row.appendChild(l);
  return { row };
}
const computedOf = (cs: CSSStyleDeclaration, prop: string) => ((cs as unknown as Record<string, string>)[prop] || "") as string;
function styleText(label: string, prop: string, cs: CSSStyleDeclaration): HTMLElement {
  const { row } = fieldShell(label, prop);
  const i = document.createElement("input");
  i.value = effectiveEdit(S.edits, S.sel!, S.scope, prop) || "";
  i.placeholder = computedOf(cs, prop);
  i.addEventListener("change", () => setStyle(prop, i.value));
  scrubLabel(row.querySelector("label")!, i, prop);
  i.addEventListener("keydown", (e) => {
    // ↑/↓ nudge numbers like Framer (shift = ×10)
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const src = i.value || i.placeholder;
    const m = /^(-?\d*\.?\d+)(.*)$/.exec(src.trim());
    if (!m) return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
    i.value = `${Math.round((parseFloat(m[1]) + step) * 100) / 100}${m[2] || "px"}`;
    setStyle(prop, i.value);
  });
  row.appendChild(i);
  return row;
}
/** Drag a number field's label sideways to change it (⇧ ×10), like Figma. */
function scrubLabel(label: HTMLElement, i: HTMLInputElement, prop: string): void {
  label.classList.add("scrub");
  label.addEventListener("mousedown", (e) => {
    const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec((i.value || i.placeholder).trim());
    if (!m || e.button !== 0) return;
    e.preventDefault();
    hideTip();
    const start = parseFloat(m[1]), unit = m[2] || "px", x0 = e.clientX;
    let first = true;
    document.body.classList.add("scrubbing");
    const move = (ev: MouseEvent) => {
      const step = (ev.shiftKey ? 10 : 1) * (unit === "" || /^(em|rem)$/.test(unit) ? 0.1 : 1);
      const v = Math.round((start + Math.round((ev.clientX - x0) / 2) * step) * 100) / 100;
      i.value = `${v}${unit}`;
      setStyle(prop, i.value, first);
      first = false;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.body.classList.remove("scrubbing");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  });
}
function textField(label: string, value: string, placeholder: string, onChange: (v: string) => void): HTMLElement {
  const { row } = fieldShell(label, null);
  const i = document.createElement("input");
  i.value = value;
  i.placeholder = placeholder;
  i.addEventListener("change", () => onChange(i.value));
  row.appendChild(i);
  return row;
}
function selectField(label: string, prop: string, options: string[], cs: CSSStyleDeclaration): HTMLElement {
  const { row } = fieldShell(label, prop);
  const s = document.createElement("select");
  const cur = effectiveEdit(S.edits, S.sel!, S.scope, prop);
  const computed = computedOf(cs, prop);
  s.innerHTML = `<option value="">${computed ? computed + " (current)" : "—"}</option>` + options.map((o) => `<option${o === cur ? " selected" : ""}>${o}</option>`).join("");
  s.addEventListener("change", () => setStyle(prop, s.value));
  row.appendChild(s);
  return row;
}
function colorField(label: string, prop: string, cs: CSSStyleDeclaration): HTMLElement {
  const { row } = fieldShell(label, prop);
  const wrap = document.createElement("div");
  wrap.className = "color-row";
  const cur = effectiveEdit(S.edits, S.sel!, S.scope, prop) || "";
  const pick = document.createElement("input");
  pick.type = "color";
  pick.value = toHex(cur || computedOf(cs, prop));
  const txt = document.createElement("input");
  txt.value = cur;
  txt.placeholder = computedOf(cs, prop);
  let first = true;
  pick.addEventListener("input", () => {
    txt.value = pick.value;
    setStyle(prop, pick.value, first);
    first = false;
  });
  pick.addEventListener("change", () => (first = true));
  txt.addEventListener("change", () => setStyle(prop, txt.value));
  wrap.append(pick, txt);
  row.appendChild(wrap);
  // the page's own colours, one click away
  const colors = collectPageColors();
  if (colors.length) {
    const sw = document.createElement("div");
    sw.className = "swatches";
    for (const c of colors) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = c;
      b.dataset.tip = `${c} — used on this page`;
      b.setAttribute("aria-label", `Use ${c}`);
      b.addEventListener("click", () => {
        txt.value = c;
        pick.value = c;
        setStyle(prop, c);
      });
      sw.appendChild(b);
    }
    row.appendChild(sw);
  }
  return row;
}
function rangeField(label: string, prop: string, cs: CSSStyleDeclaration, min: number, max: number, step: number): HTMLElement {
  const { row } = fieldShell(label, prop);
  const wrap = document.createElement("div");
  wrap.className = "color-row";
  const r = document.createElement("input");
  r.type = "range";
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  const cur = effectiveEdit(S.edits, S.sel!, S.scope, prop);
  r.value = cur || computedOf(cs, prop) || String(max);
  const n = document.createElement("input");
  n.value = cur || "";
  n.placeholder = computedOf(cs, prop);
  n.style.width = "56px";
  let first = true;
  r.addEventListener("input", () => {
    n.value = r.value;
    setStyle(prop, r.value, first);
    first = false;
  });
  r.addEventListener("change", () => (first = true));
  n.addEventListener("change", () => setStyle(prop, n.value));
  wrap.append(r, n);
  row.appendChild(wrap);
  return row;
}

// ── content + structure (canonical doc first, mirrored into every artboard) ───
function mirror(fn: (d: Document) => void): void {
  if (S.doc) fn(S.doc);
  forEachFrame((d) => fn(d));
}
function setText(value: string): void {
  const id = S.sel;
  if (!id) return;
  checkpoint();
  mirror((d) => {
    const el = byId(d, id) as HTMLElement | null;
    if (el) el.textContent = value;
  });
  commit(true);
  renderLayers();
}
function setAttr(name: string, value: string, onInnerImg = false): void {
  const id = S.sel;
  if (!id) return;
  checkpoint();
  mirror((d) => {
    let el = byId(d, id);
    if (onInnerImg && el && el.localName !== "img") el = el.querySelector("img");
    if (!el) return;
    if (value) el.setAttribute(name, value);
    else el.removeAttribute(name);
  });
  commit(true);
}
function startTextEdit(el: HTMLElement, sc: Scope): void {
  const id = el.getAttribute(ID_ATTR)!;
  setScope(sc, false);
  select(id, false);
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "false");
  el.focus();
  const before = el.innerHTML;
  const finish = () => {
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeEventListener("blur", finish);
    if (el.innerHTML === before) return;
    const html = el.innerHTML;
    checkpoint();
    if (S.doc) {
      const c = byId(S.doc, id);
      if (c) c.innerHTML = html;
    }
    forEachFrame((d) => {
      const n = byId(d, id);
      if (n && n !== el) n.innerHTML = html;
    });
    commit(true);
    renderLayers();
    renderProps();
  };
  el.addEventListener("blur", finish);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el.blur();
  });
}
function selectParent(): void {
  if (!S.sel || !S.doc) return;
  const p = byId(S.doc, S.sel)?.parentElement?.closest(`[${ID_ATTR}]`);
  if (p) select(p.getAttribute(ID_ATTR));
}
function remove(): void {
  const ids = selection();
  if (!ids.length || !S.doc) return;
  const parent = byId(S.doc, ids[0])?.parentElement?.closest(`[${ID_ATTR}]`)?.getAttribute(ID_ATTR) || null;
  checkpoint();
  mirror((d) => ids.forEach((id) => byId(d, id)?.remove()));
  const next = { ...S.edits };
  for (const id of ids) delete next[id];
  S.edits = next;
  commit(true);
  select(parent);
  if (ids.length > 1) toast(`Deleted ${ids.length} layers.`);
}
function duplicate(): void {
  const ids = selection();
  if (ids.length > 1) {
    // each one copied next to itself; the copies end up selected
    checkpoint();
    const copies = ids.map((id) => duplicateOne(id)).filter((x): x is string => !!x);
    commit(true);
    selectMany(copies);
    return;
  }
  const id = S.sel;
  if (!id || !S.doc) return;
  if (!byId(S.doc, id)) return;
  checkpoint();
  const nid = duplicateOne(id);
  commit(true);
  select(nid || id);
}
/** Copy one layer next to itself with its styles (no checkpoint / commit). Returns the copy's id. */
function duplicateOne(id: string): string | null {
  const src = S.doc ? byId(S.doc, id) : null;
  if (!src || !S.doc) return null;
  let next = maxId(S.doc);
  const copy = src.cloneNode(true) as Element;
  const map = new Map<string, string>();
  [copy, ...Array.from(copy.querySelectorAll(`[${ID_ATTR}]`))].forEach((n) => {
    const nid = String(++next);
    map.set(n.getAttribute(ID_ATTR)!, nid);
    n.setAttribute(ID_ATTR, nid);
  });
  // copies keep their styles
  for (const [from, to] of map) if (S.edits[from]) S.edits = { ...S.edits, [to]: JSON.parse(JSON.stringify(S.edits[from])) };
  mirror((d) => {
    const at = byId(d, id);
    if (at) at.after(d.importNode(copy, true));
  });
  return map.get(id) || null;
}
function move(dir: -1 | 1): void {
  const id = S.sel;
  if (!id) return;
  checkpoint();
  mirror((d) => {
    const el = byId(d, id);
    if (!el) return;
    if (dir < 0 && el.previousElementSibling) el.previousElementSibling.before(el);
    if (dir > 0 && el.nextElementSibling) el.nextElementSibling.after(el);
  });
  commit(true);
  renderLayers();
}
function toggleHidden(): void {
  if (S.sel) toggleHiddenFor(S.sel);
}
function replaceImage(isImg: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const data = String(fr.result);
      if (isImg) {
        const id = S.sel!;
        checkpoint();
        mirror((d) => {
          const host = byId(d, id);
          const img = host && (host.localName === "img" ? host : host.querySelector("img"));
          if (!img) return;
          img.setAttribute("src", data);
          img.removeAttribute("srcset");
          img.closest("picture")?.querySelectorAll("source").forEach((s) => s.remove());
        });
        commit(true);
      } else setStyle("backgroundImage", `url("${data}")`);
      renderProps();
    };
    fr.readAsDataURL(file);
  };
  input.click();
}

// ── export ────────────────────────────────────────────────────────────────────
/** The project's live 3D scene files (kept from the capture), at `prefix` — or null (no scenes in this page). */
async function sceneFiles(html: string, prefix = ""): Promise<SceneFiles | null> {
  if (!S.project || !hasIslands(html)) return null;
  const f = await getScenes(S.project.id).catch(() => undefined);
  if (!f) return null;
  if (!prefix) return f;
  const out: SceneFiles = {};
  for (const [k, v] of Object.entries(f)) out[prefix + k] = v;
  return out;
}
/** Font files for Studio's Preview, fetched with the extension's access and kept for the session. */
const previewFonts = makeDataFetcher(4_000_000);
async function exportAs(kind: string): Promise<void> {
  if (!S.project || !S.doc) return;
  if (kind === "site-html" || kind === "site-next") return exportSite(kind);
  const html = buildExportHtml(S.doc, S.edits);
  const url = S.project.url;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "site";
    }
  })();
  toast("Building your export — downloading assets…");
  try {
    if (kind === "single") {
      const out = await inlineForOffline(html, url, { fetchText, fetchData: makeDataFetcher() });
      downloadBlob(out, `${host}.studio.html`, "text/html");
    } else if (kind === "elementor") {
      const tpl = buildElementorTemplate(html, S.project.title || host);
      downloadBlob(JSON.stringify(tpl, null, 2), `${host}.elementor.json`, "application/json");
    } else {
      const r = { fetchText, fetchBytes: makeByteFetcher() };
      // its 3D scenes kept live (the site's own code, see panel/islands.ts): HTML at the root, React / Next.js in public/
      const scenes = await sceneFiles(html, kind === "html" ? "" : "public/");
      const page = scenes ? addIslandTag(html) : html;
      const files: FileMap =
        kind === "next" ? await buildNextProject(page, url, r, host) : kind === "react" ? await buildReactViteProject(page, url, r, host) : await buildHtmlProject(page, url, r, host);
      if (scenes) Object.assign(files, scenes);
      const n = downloadZip(files, `${host}.${kind}.zip`);
      toast(`Exported ${n} files.`);
      return;
    }
    toast("Exported.");
  } catch (e) {
    toast("Export failed: " + (e instanceof Error ? e.message : String(e)), true);
  }
}

/** Every page of a site project with its edits baked in → the same site exports the panel makes. */
async function exportSite(kind: "site-html" | "site-next"): Promise<void> {
  const p = S.project;
  if (!p?.pageList || !S.doc) return;
  await saveNow();
  toast(`Building the whole site (${p.pageList.length} pages) — downloading assets…`);
  try {
    const pages = [];
    for (let i = 0; i < p.pageList.length; i++) {
      const ref = p.pageList[i];
      let html: string;
      if (i === S.page) html = buildExportHtml(S.doc, S.edits);
      else {
        const d = await getPage(p.id, i);
        if (!d) continue;
        const doc = new DOMParser().parseFromString(d.html, "text/html");
        assignIds(doc);
        html = buildExportHtml(doc, d.edits);
      }
      pages.push({ url: ref.url, path: ref.path, title: ref.title, html });
    }
    let host = "site";
    try {
      host = new URL(p.url).host;
    } catch {
      /* keep "site" */
    }
    const r = { fetchText, fetchBytes: makeByteFetcher() };
    const files: FileMap = kind === "site-next" ? await buildNextSiteProject(pages, r, host) : await buildSiteProject(pages, r, host);
    const n = downloadZip(files, `${host}.studio-site${kind === "site-next" ? ".nextjs" : ""}.zip`);
    toast(`Exported ${pages.length} pages (${n} files).`);
  } catch (e) {
    toast("Export failed: " + (e instanceof Error ? e.message : String(e)), true);
  }
}

// ── the right-click menu and its actions (each one also has a shortcut) ───────────────────────────
// Every action changes the saved page or its edit stylesheet, so the exports carry it: arrange = z-index,
// flip = scale, group = a real wrapper element, auto layout = flex, hide = display:none, rename = data-name.
// Lock is the one editor-only state (it only stops canvas clicks).
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** A shortcut label: k("⇧⌘", "H") → "⇧⌘H" on a Mac, "Ctrl+Shift+H" elsewhere. */
const k = (mods: string, key: string) =>
  MAC ? mods + key : [mods.includes("⌃") || mods.includes("⌘") ? "Ctrl" : "", mods.includes("⌥") ? "Alt" : "", mods.includes("⇧") ? "Shift" : "", key].filter(Boolean).join("+");
const isLocked = (id: string | null) => !!id && !!S.project?.locked?.includes(id);
function toggleLock(id: string): void {
  if (!S.project) return;
  const set = new Set(S.project.locked || []);
  const was = set.has(id);
  if (was) set.delete(id);
  else set.add(id);
  S.project = { ...S.project, locked: Array.from(set) };
  scheduleSave();
  renderLayers();
  refreshOverlays(); // a locked layer loses its resize handles at once
  if (id === S.sel) renderProps();
  toast(was ? "Unlocked — it can be clicked on the canvas again." : "Locked — clicks on the canvas go to what's around it. Unlock it from the Layers panel.");
}
/** The layer in clean HTML: no editor attributes, ids kept only where a style edit needs them. */
function cleanHtml(el: Element, keepEdited = false): string {
  const c = el.cloneNode(true) as Element;
  [c, ...Array.from(c.querySelectorAll("*"))].forEach((n) => {
    const id = n.getAttribute(ID_ATTR);
    if (!keepEdited || !id || !S.edits[id]) n.removeAttribute(ID_ATTR);
    ["data-sl-sel", "data-sl-hover", "data-sl-drag", "contenteditable", "spellcheck"].forEach((a) => n.removeAttribute(a));
  });
  return c.outerHTML;
}
const subtreeIds = (el: Element) => [el, ...Array.from(el.querySelectorAll(`[${ID_ATTR}]`))].map((n) => n.getAttribute(ID_ATTR)!).filter(Boolean);

// copy / paste: the layer, its children and their edits — kept in this browser, so a layer copied in
// one project pastes into another
interface Clip {
  html: string;
  edits: StyleEdits;
  name: string;
  text: string; // what the system clipboard got (to recognise our own copy on paste)
}
const CLIP_KEY = "sl-studio-clip";
function readClip(): Clip | null {
  try {
    return JSON.parse(localStorage.getItem(CLIP_KEY) || "null");
  } catch {
    return null;
  }
}
function makeClip(id: string): Clip | null {
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el || el.localName === "body") return null;
  const edits: StyleEdits = {};
  for (const i of subtreeIds(el)) if (S.edits[i]) edits[i] = JSON.parse(JSON.stringify(S.edits[i]));
  const clip: Clip = { html: el.outerHTML, edits, name: layerName(el), text: cleanHtml(el) };
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
  } catch {
    toast("This layer is too big to copy.", true);
    return null;
  }
  return clip;
}
function copyLayer(id: string, cut = false, toSystem = true): Clip | null {
  const clip = makeClip(id);
  if (!clip) return null;
  if (toSystem) void navigator.clipboard?.writeText(clip.text).catch(() => {});
  if (cut) {
    select(id, false);
    remove();
    toast(`Cut “${clip.name}”.`);
  } else toast(`Copied “${clip.name}”.`);
  return clip;
}
type Place = "after" | "inside" | "replace";
/** Paste a copy: every node gets a new id, its edits come along. */
function pasteClip(clip: Clip, where: Place, targetId: string | null = S.sel): void {
  if (!S.doc) return;
  const tpl = S.doc.createElement("template");
  tpl.innerHTML = clip.html.trim();
  const node = tpl.content.firstElementChild;
  if (!node) return;
  let next = maxId(S.doc);
  const map = new Map<string, string>();
  [node, ...Array.from(node.querySelectorAll("*"))].forEach((n) => {
    if (/^(script|style|template|noscript)$/i.test(n.localName)) return;
    const old = n.getAttribute(ID_ATTR);
    const nid = String(++next);
    if (old) map.set(old, nid);
    n.setAttribute(ID_ATTR, nid);
  });
  const target = targetId ? byId(S.doc, targetId) : null;
  if (where !== "after" && (!target || target.localName === "body")) where = "after";
  checkpoint();
  for (const [from, to] of map) if (clip.edits[from]) S.edits = { ...S.edits, [to]: JSON.parse(JSON.stringify(clip.edits[from])) };
  if (where === "replace" && targetId) {
    const gone = new Set(subtreeIds(target!));
    S.edits = Object.fromEntries(Object.entries(S.edits).filter(([i]) => !gone.has(i)));
  }
  mirror((d) => {
    const at = targetId ? byId(d, targetId) : null;
    const copy = d.importNode(node, true);
    if (!at || at.localName === "body") d.body.appendChild(copy);
    else if (where === "inside") at.appendChild(copy);
    else if (where === "replace") at.replaceWith(copy);
    else at.after(copy);
  });
  commit(true);
  const nid = node.getAttribute(ID_ATTR)!;
  select(nid);
  renderLayers();
  toast(`Pasted “${clip.name}”${where === "inside" ? " inside" : where === "replace" ? " in its place" : ""}.`);
}
/** HTML from another app: scripts, styles, frames and event handlers removed, then pasted like a layer. */
function pasteExternal(html: string, plain = false): void {
  if (!S.doc) return;
  const tpl = S.doc.createElement("template");
  if (plain) {
    const p = S.doc.createElement("p");
    p.textContent = html;
    tpl.content.appendChild(p);
  } else tpl.innerHTML = html;
  tpl.content.querySelectorAll("script, style, link, meta, iframe, object, embed, frame, frameset, base, noscript").forEach((n) => n.remove());
  tpl.content.querySelectorAll("*").forEach((n) => {
    for (const a of Array.from(n.attributes)) {
      if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) || /^data-sl-/i.test(a.name)) n.removeAttribute(a.name);
    }
  });
  const kids = Array.from(tpl.content.children);
  if (!kids.length) return;
  let root: Element;
  if (kids.length === 1) root = kids[0];
  else {
    root = S.doc.createElement("div");
    root.setAttribute("data-name", "Pasted");
    kids.forEach((c) => root.appendChild(c));
  }
  pasteClip({ html: root.outerHTML, edits: {}, name: plain ? "Text" : "Pasted content", text: "" }, "after");
}
/** Copy as HTML (with its edits as a stylesheet), CSS (how it looks now) or a React component. */
function copyAs(id: string, kind: "html" | "css" | "jsx"): void {
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el) return;
  let out = "";
  if (kind === "html") {
    const edits: StyleEdits = {};
    for (const i of subtreeIds(el)) if (S.edits[i]) edits[i] = S.edits[i];
    const css = editsToCss(edits);
    out = (css ? `<style>\n${css}\n</style>\n` : "") + cleanHtml(el, true);
  } else if (kind === "jsx") out = htmlToJsx(cleanHtml(el), (layerName(el).replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z]+/, "") || "Layer").replace(/^./, (c) => c.toUpperCase()));
  else {
    const d = frameDoc(S.scope);
    const live = d ? (byId(d, id) as HTMLElement | null) : null;
    if (!live) return;
    const cs = d!.defaultView!.getComputedStyle(live);
    const PROPS = ["display", "position", "top", "right", "bottom", "left", "z-index", "width", "height", "margin", "padding", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "text-align", "text-transform", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity", "transform", "translate", "scale", "rotate", "overflow"];
    const SKIP = /^(none|normal|auto|0px|static|visible|rgba\(0, 0, 0, 0\)|0px none.*|start)$/;
    const lines: string[] = [];
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p).trim();
      if (!v || SKIP.test(v)) continue;
      if (/^(flex-direction|flex-wrap|justify-content|align-items|gap)$/.test(p) && !/flex|grid/.test(cs.display)) continue;
      if (p === "grid-template-columns" && !/grid/.test(cs.display)) continue;
      if (/^(top|right|bottom|left|z-index)$/.test(p) && cs.position === "static") continue;
      if (p === "opacity" && v === "1") continue;
      lines.push(`  ${p}: ${v};`);
    }
    out = `/* ${layerName(el)} — as it looks on ${scopeLabel()} */\n.${(layerName(el).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "layer")} {\n${lines.join("\n")}\n}`;
  }
  navigator.clipboard
    .writeText(out)
    .then(() => toast(`Copied as ${kind === "jsx" ? "a React component" : kind.toUpperCase()}.`))
    .catch(() => toast("The browser blocked the clipboard.", true));
}

/** Arrange overlapping layers: front / back among their siblings (z-index; the parent keeps negative
 *  values above its own background by becoming its own stacking context). */
function arrange(id: string, how: "front" | "forward" | "backward" | "back"): void {
  const d = frameDoc(S.scope);
  const el = d ? (byId(d, id) as HTMLElement | null) : null;
  if (!el || !el.parentElement || el.localName === "body") return;
  const win = d!.defaultView!;
  const zOf = (n: Element) => {
    const v = parseInt(win.getComputedStyle(n).zIndex, 10);
    return Number.isNaN(v) ? 0 : v;
  };
  const sibs = Array.from(el.parentElement.children).filter((n) => n !== el && n.hasAttribute(ID_ATTR));
  const zs = sibs.map(zOf);
  const cur = zOf(el);
  const next = how === "front" ? Math.max(0, ...zs) + 1 : how === "back" ? Math.min(0, ...zs) - 1 : how === "forward" ? cur + 1 : cur - 1;
  checkpoint();
  if (win.getComputedStyle(el).position === "static") S.edits = setEdit(S.edits, id, S.scope, "position", "relative");
  S.edits = setEdit(S.edits, id, S.scope, "zIndex", String(next));
  const pid = el.parentElement.getAttribute(ID_ATTR);
  if (next < 0 && pid && el.parentElement.localName !== "body") S.edits = setEdit(S.edits, pid, S.scope, "isolation", "isolate");
  commit(false);
  renderProps();
  toast(how === "front" ? "Brought to front." : how === "back" ? "Sent to back." : how === "forward" ? "Brought forward." : "Sent backward.");
}
/** Group: wrap the layer in a new container (a Frame also gets auto layout). */
/** Group / frame the whole selection: one wrapper around them (they must share a container). */
function wrapSelection(frame: boolean): void {
  const ids = selection();
  if (ids.length < 2) return S.sel ? wrapLayer(S.sel, frame) : undefined;
  if (!S.doc) return;
  const els = ids.map((id) => byId(S.doc!, id)).filter((e): e is Element => !!e);
  const parent = els[0].parentElement;
  if (!parent || els.some((e) => e.parentElement !== parent)) return toast("To group them, they need to be in the same container. Move them next to each other first (Reorder, M).");
  const order = Array.from(parent.children).filter((c) => els.includes(c)).map((c) => c.getAttribute(ID_ATTR)!);
  checkpoint();
  const nid = String(maxId(S.doc) + 1);
  mirror((d) => {
    const items = order.map((id) => byId(d, id)).filter((e): e is Element => !!e);
    if (!items.length) return;
    const w = d.createElement("div");
    w.setAttribute(ID_ATTR, nid);
    w.setAttribute("data-name", frame ? "Frame" : "Group");
    items[0].before(w);
    for (const it of items) w.appendChild(it);
  });
  if (frame) {
    S.edits = setEdit(S.edits, nid, "base", "display", "flex");
    S.edits = setEdit(S.edits, nid, "base", "flexDirection", "column");
  }
  S.expanded.add(nid);
  commit(true);
  select(nid);
  renderLayers();
  toast(`${frame ? "Framed" : "Grouped"} ${order.length} layers.`);
}
/** Line several layers up with the edges or centre of the box around them all (moves them, like Figma). */
type AlignHow = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
interface SelBox {
  id: string;
  b: Box;
  t: { x: number; y: number };
  map: MoveMap;
}
function selectionBoxes(): SelBox[] {
  const d = frameDoc(S.scope);
  if (!d) return [];
  return selection()
    .map((id) => {
      const el = byId(d, id) as HTMLElement | null;
      if (!el) return null;
      const t = parseTranslate(effectiveEdit(S.edits, id, S.scope, "translate") || d.defaultView!.getComputedStyle(el).translate);
      return { id, b: boxOf(el), t, map: moveMap(el, t) };
    })
    .filter((x): x is SelBox => !!x);
}
/** Move one selected layer by (dx, dy) artboard px (no checkpoint / commit). */
const shiftBy = (i: SelBox, dx: number, dy: number) => {
  const m = i.map(dx, dy);
  S.edits = setEdit(S.edits, i.id, S.scope, "translate", formatTranslate(i.t.x + m.x, i.t.y + m.y));
};
function alignSelection(how: AlignHow): void {
  const items = selectionBoxes();
  if (items.length < 2) return toast("Select two or more layers to align them (⇧-click, or drag a box around them).");
  const L = Math.min(...items.map((i) => i.b.left)), R = Math.max(...items.map((i) => i.b.left + i.b.width));
  const T = Math.min(...items.map((i) => i.b.top)), B = Math.max(...items.map((i) => i.b.top + i.b.height));
  checkpoint();
  for (const it of items) {
    const b = it.b;
    const dx = how === "left" ? L - b.left : how === "right" ? R - (b.left + b.width) : how === "hcenter" ? (L + R) / 2 - (b.left + b.width / 2) : 0;
    const dy = how === "top" ? T - b.top : how === "bottom" ? B - (b.top + b.height) : how === "vcenter" ? (T + B) / 2 - (b.top + b.height / 2) : 0;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    shiftBy(it, dx, dy);
  }
  commit(false);
  renderProps();
}
/** Space three or more layers evenly between the first and the last (across, or down). */
function distributeSelection(axis: "x" | "y"): void {
  const items = selectionBoxes();
  if (items.length < 3) return toast("Select three or more layers to space them evenly.");
  const pos = (i: (typeof items)[number]) => (axis === "x" ? i.b.left : i.b.top);
  const size = (i: (typeof items)[number]) => (axis === "x" ? i.b.width : i.b.height);
  items.sort((a, b) => pos(a) - pos(b));
  const first = items[0], last = items[items.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const gap = (span - items.reduce((a, i) => a + size(i), 0)) / (items.length - 1);
  checkpoint();
  let at = pos(first) + size(first) + gap;
  for (const it of items.slice(1, -1)) {
    const d = at - pos(it);
    if (Math.abs(d) >= 0.5) shiftBy(it, axis === "x" ? d : 0, axis === "y" ? d : 0);
    at += size(it) + gap;
  }
  commit(false);
  renderProps();
}
function wrapLayer(id: string, frame: boolean): void {
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el || el.localName === "body") return;
  checkpoint();
  const nid = String(maxId(S.doc!) + 1);
  mirror((d) => {
    const a = byId(d, id);
    if (!a) return;
    const w = d.createElement("div");
    w.setAttribute(ID_ATTR, nid);
    w.setAttribute("data-name", frame ? "Frame" : "Group");
    a.before(w);
    w.appendChild(a);
  });
  if (frame) {
    S.edits = setEdit(S.edits, nid, "base", "display", "flex");
    S.edits = setEdit(S.edits, nid, "base", "flexDirection", "column");
  }
  S.expanded.add(nid);
  commit(true);
  select(nid);
  renderLayers();
  toast(frame ? "Wrapped in a Frame with auto layout." : "Grouped.");
}
function ungroupLayer(id: string): void {
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el || el.localName === "body") return;
  if (!el.children.length) return toast("Nothing to ungroup: it has no layers inside.");
  const first = el.querySelector(`:scope > [${ID_ATTR}]`)?.getAttribute(ID_ATTR) || null;
  checkpoint();
  mirror((d) => {
    const a = byId(d, id);
    if (a) a.replaceWith(...Array.from(a.childNodes));
  });
  const next = { ...S.edits };
  delete next[id];
  S.edits = next;
  commit(true);
  select(first);
  renderLayers();
  toast("Ungrouped.");
}
/** Auto layout = flex: the direction is guessed from how the children sit now. */
function setAutoLayout(id: string, on: boolean): void {
  const d = frameDoc(S.scope);
  const el = d ? byId(d, id) : null;
  if (!el) return;
  checkpoint();
  if (on) {
    const kids = Array.from(el.children).map((c) => c.getBoundingClientRect()).filter((r) => r.width && r.height);
    let row = false;
    if (kids.length > 1) row = Math.abs(kids[1].top - kids[0].top) < Math.abs(kids[1].left - kids[0].left);
    S.edits = setEdit(S.edits, id, S.scope, "display", "flex");
    S.edits = setEdit(S.edits, id, S.scope, "flexDirection", row ? "row" : "column");
  } else {
    S.edits = setEdit(S.edits, id, S.scope, "display", "block");
    for (const p of ["flexDirection", "flexWrap", "justifyContent", "alignItems", "gap"]) S.edits = setEdit(S.edits, id, S.scope, p, "");
  }
  commit(false);
  renderProps();
  toast(on ? "Auto layout added." : "Auto layout removed.");
}
function setProps(id: string, props: Record<string, string>): void {
  checkpoint();
  for (const [p, v] of Object.entries(props)) S.edits = setEdit(S.edits, id, S.scope, p, v);
  commit(false);
  renderProps();
}
function flip(id: string, axis: "x" | "y"): void {
  const parts = (effectiveEdit(S.edits, id, S.scope, "scale") || "1").trim().split(/\s+/).map((v) => Number(v));
  let sx = Number.isFinite(parts[0]) ? parts[0] : 1;
  let sy = parts.length > 1 && Number.isFinite(parts[1]) ? parts[1] : sx;
  if (axis === "x") sx = -sx;
  else sy = -sy;
  select(id, false);
  setStyle("scale", sx === 1 && sy === 1 ? "" : `${sx} ${sy}`);
  renderProps();
}
// copy / paste style: a layer's edits on every breakpoint
const STYLE_KEY = "sl-studio-style";
function copyStyle(id: string): void {
  const e = S.edits[id];
  if (!e) return toast("This layer has no style changes to copy yet.");
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(e));
  } catch {
    /* storage full */
  }
  toast("Style copied.");
}
function pasteStyle(id: string): void {
  let e: StyleEdits[string] | null = null;
  try {
    e = JSON.parse(localStorage.getItem(STYLE_KEY) || "null");
  } catch {
    /* none */
  }
  if (!e) return toast("Copy a style first.");
  checkpoint();
  S.edits = { ...S.edits, [id]: JSON.parse(JSON.stringify(e)) };
  commit(false);
  renderProps();
  toast("Style pasted.");
}
function resetLayer(id: string): void {
  if (!S.edits[id]) return;
  checkpoint();
  const next = { ...S.edits };
  delete next[id];
  S.edits = next;
  commit(false);
  renderProps();
  toast("Changes to this layer were reset.");
}
/** Rename in place in the Layers panel (the name is saved as data-name and travels with the export). */
function renameLayer(id: string): void {
  S.expanded.add(id);
  select(id, false);
  renderLayers();
  const row = layersEl.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
  const nm = row?.querySelector<HTMLElement>(".nm");
  if (!row || !nm || !S.doc) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = layerName(byId(S.doc, id)!);
  nm.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save) {
      checkpoint();
      mirror((d) => {
        const a = byId(d, id);
        if (!a) return;
        if (v) a.setAttribute("data-name", v);
        else a.removeAttribute("data-name");
      });
      commit(true);
    }
    renderLayers();
    if (id === S.sel) renderProps();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}
/** Move a layer to another page of a whole-site project (it's added at the end of that page). */
async function moveToPage(id: string, page: number): Promise<void> {
  const p = S.project;
  const clip = makeClip(id);
  if (!p?.pageList || !clip) return;
  const data = await getPage(p.id, page);
  if (!data) return;
  const doc = new DOMParser().parseFromString(data.html, "text/html");
  assignIds(doc);
  const tpl = doc.createElement("template");
  tpl.innerHTML = clip.html.trim();
  const node = tpl.content.firstElementChild;
  if (!node) return;
  let next = maxId(doc);
  const edits: StyleEdits = { ...data.edits };
  [node, ...Array.from(node.querySelectorAll("*"))].forEach((n) => {
    const old = n.getAttribute(ID_ATTR);
    const nid = String(++next);
    if (old && clip.edits[old]) edits[nid] = clip.edits[old];
    n.setAttribute(ID_ATTR, nid);
  });
  doc.body.appendChild(doc.importNode(node, true));
  await savePage(p.id, page, { html: serialize(doc), edits });
  select(id, false);
  remove();
  toast(`Moved “${clip.name}” to the end of “${p.pageList[page].title}”.`);
}

/** The layers under the pointer on an artboard, topmost first (for "Select layer"). */
function layersAt(d: Document, x: number, y: number): string[] {
  const out: string[] = [];
  for (const n of d.elementsFromPoint(x, y)) {
    const id = n.closest(`[${ID_ATTR}]`)?.getAttribute(ID_ATTR);
    if (id && !out.includes(id) && byId(d, id)?.localName !== "body") out.push(id);
  }
  return out.slice(0, 14);
}
/** The right-click menu when several layers are selected. */
function openMultiMenu(x: number, y: number): void {
  const n = selection().length;
  openMenu(x, y, [
    { label: `Group ${n} layers`, icon: "frame", key: k("⌘", "G"), run: () => wrapSelection(false) },
    { label: "Frame selection", icon: "layout", key: k("⌥⌘", "G"), run: () => wrapSelection(true) },
    "-",
    { label: "Align", icon: "alignObjLeft", sub: [
      { label: "Left", icon: "alignObjLeft", key: k("⌥", "A"), run: () => alignSelection("left") },
      { label: "Centre", icon: "alignObjCenter", key: k("⌥", "H"), run: () => alignSelection("hcenter") },
      { label: "Right", icon: "alignObjRight", key: k("⌥", "D"), run: () => alignSelection("right") },
      "-",
      { label: "Top", icon: "alignObjTop", key: k("⌥", "W"), run: () => alignSelection("top") },
      { label: "Middle", icon: "alignObjMiddle", key: k("⌥", "V"), run: () => alignSelection("vcenter") },
      { label: "Bottom", icon: "alignObjBottom", key: k("⌥", "S"), run: () => alignSelection("bottom") },
      "-",
      { label: "Space evenly across", icon: "distributeX", key: k("⌃⌥", "H"), disabled: n < 3, run: () => distributeSelection("x") },
      { label: "Space evenly down", icon: "distributeY", key: k("⌃⌥", "V"), disabled: n < 3, run: () => distributeSelection("y") },
    ] },
    "-",
    { label: "Duplicate", icon: "copy", key: k("⌘", "D"), run: () => duplicate() },
    { label: `Hide on ${scopeLabel()}`, icon: "eyeOff", run: () => hideSelection() },
    "-",
    { label: `Delete ${n} layers`, icon: "trash", key: "⌫", danger: true, run: () => remove() },
  ]);
}
function hideSelection(): void {
  checkpoint();
  for (const id of selection()) S.edits = setEdit(S.edits, id, S.scope, "display", "none");
  commit(false);
  renderLayers();
  renderProps();
}
function openLayerMenu(x: number, y: number, id: string, under: string[] = []): void {
  if (isMulti() && selection().includes(id)) return openMultiMenu(x, y);
  const el = S.doc ? byId(S.doc, id) : null;
  if (!el) return;
  const live = frameDoc(S.scope) ? byId(frameDoc(S.scope)!, id) : null;
  const cs = live ? live.ownerDocument.defaultView!.getComputedStyle(live) : null;
  const flex = !!cs && /flex/.test(cs.display);
  const clip = readClip();
  const hidden = isHidden(id), locked = isLocked(id);
  const parentId = el.parentElement?.closest(`[${ID_ATTR}]`)?.getAttribute(ID_ATTR) || null;
  // "Select layer": what's under the pointer, or (from the Layers panel) the chain of parents
  const chain: string[] = under.length ? under : [];
  if (!chain.length) for (let a: Element | null = el; a && a.localName !== "body"; a = a.parentElement?.closest(`[${ID_ATTR}]`) || null) chain.push(a.getAttribute(ID_ATTR)!);
  const hl = (lid: string, on: boolean) => forEachFrame((d) => (on ? byId(d, lid)?.setAttribute("data-sl-hover", "") : byId(d, lid)?.removeAttribute("data-sl-hover")));
  const layerItems: MenuEntry[] = chain.map((lid) => {
    const n = byId(S.doc!, lid)!;
    return { label: layerName(n), icon: KIND_ICON[layerKind(n)], run: () => select(lid), hover: (on: boolean) => hl(lid, on) };
  });
  const layoutSub: MenuEntry[] = [
    { label: "Horizontal", icon: "arrowRight", run: () => setProps(id, { flexDirection: "row" }) },
    { label: "Vertical", icon: "arrowDown", run: () => setProps(id, { flexDirection: "column" }) },
    "-",
    { label: cs?.flexWrap === "wrap" ? "Don't wrap" : "Wrap", run: () => setProps(id, { flexWrap: cs?.flexWrap === "wrap" ? "nowrap" : "wrap" }) },
    "-",
    { label: "Align start", icon: "alignLeft", run: () => setProps(id, { alignItems: "flex-start" }) },
    { label: "Align center", icon: "alignCenter", run: () => setProps(id, { alignItems: "center" }) },
    { label: "Align end", icon: "alignRight", run: () => setProps(id, { alignItems: "flex-end" }) },
    "-",
    { label: "Pack at start", run: () => setProps(id, { justifyContent: "flex-start" }) },
    { label: "Pack in the center", run: () => setProps(id, { justifyContent: "center" }) },
    { label: "Space between", run: () => setProps(id, { justifyContent: "space-between" }) },
  ];
  const pages = S.project?.pageList;
  const entries: MenuEntry[] = [
    { label: "Copy", icon: "copy", key: k("⌘", "C"), run: () => copyLayer(id) },
    { label: "Cut", key: k("⌘", "X"), run: () => copyLayer(id, true) },
    { label: "Paste after", icon: "paste", key: k("⌘", "V"), disabled: !clip, run: () => clip && pasteClip(clip, "after", id) },
    { label: "Paste inside", disabled: !clip || !canHold(el), run: () => clip && pasteClip(clip, "inside", id) },
    { label: "Paste to replace", disabled: !clip, run: () => clip && pasteClip(clip, "replace", id) },
    { label: "Copy as", icon: "code", sub: [
      { label: "HTML", key: "with its styles", run: () => copyAs(id, "html") },
      { label: "CSS", key: "how it looks", run: () => copyAs(id, "css") },
      { label: "React (JSX)", run: () => copyAs(id, "jsx") },
    ] },
    { label: "Duplicate", key: k("⌘", "D"), run: () => { select(id, false); duplicate(); } },
    "-",
    { label: "Select layer", icon: "layers", sub: layerItems },
    { label: "Select parent", icon: "parent", key: "Esc", disabled: !parentId, run: () => select(parentId) },
    ...(pages && pages.length > 1 ? [{ label: "Move to page", icon: "file" as IconName, sub: pages.map((pg, i): MenuEntry => ({ label: pg.title || pg.path, disabled: i === S.page, run: () => void moveToPage(id, i) })) }] : []),
    "-",
    { label: "Bring to front", key: "]", run: () => arrange(id, "front") },
    { label: "Bring forward", key: k("⌘", "]"), run: () => arrange(id, "forward") },
    { label: "Send backward", key: k("⌘", "["), run: () => arrange(id, "backward") },
    { label: "Send to back", key: "[", run: () => arrange(id, "back") },
    "-",
    { label: "Group selection", key: k("⌘", "G"), run: () => wrapLayer(id, false) },
    { label: "Frame selection", key: k("⌥⌘", "G"), run: () => wrapLayer(id, true) },
    { label: "Ungroup", key: k("⇧⌘", "G"), disabled: !el.children.length, run: () => ungroupLayer(id) },
    "-",
    flex
      ? { label: "Remove auto layout", key: k("⌥⇧", "A"), run: () => setAutoLayout(id, false) }
      : { label: "Add auto layout", icon: "layout", key: k("⇧", "A"), disabled: !el.children.length, run: () => setAutoLayout(id, true) },
    { label: "Auto layout options", disabled: !flex, sub: layoutSub },
    { label: cs && /grid/.test(cs.display) ? "Remove grid layout" : "Grid layout (3 columns)", icon: "columns", disabled: !el.children.length, run: () => (cs && /grid/.test(cs.display) ? setProps(id, { display: "block", gridTemplateColumns: "", gridTemplateRows: "", columnGap: "", rowGap: "" }) : setProps(id, { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", columnGap: "16px", rowGap: "16px" })) },
    "-",
    { label: "Copy style", icon: "brush", key: k("⌥⌘", "C"), disabled: !S.edits[id], run: () => copyStyle(id) },
    { label: "Paste style", key: k("⌥⌘", "V"), run: () => pasteStyle(id) },
    { label: "Reset changes", icon: "undo", disabled: !S.edits[id], run: () => resetLayer(id) },
    "-",
    { label: hidden ? `Show on ${scopeLabel()}` : `Hide on ${scopeLabel()}`, icon: hidden ? "eye" : "eyeOff", key: k("⇧⌘", "H"), run: () => toggleHiddenFor(id) },
    { label: locked ? "Unlock" : "Lock", key: k("⇧⌘", "L"), run: () => toggleLock(id) },
    { label: "Rename", icon: "edit", run: () => renameLayer(id) },
    "-",
    { label: "Animate", icon: "sparkles", sub: animateMenu(id, layerKind(el), el.children.length > 1) },
    "-",
    { label: "Flip horizontal", key: k("⇧", "H"), run: () => flip(id, "x") },
    { label: "Flip vertical", key: k("⇧", "V"), run: () => flip(id, "y") },
    "-",
    { label: "Delete", icon: "trash", key: "⌫", danger: true, run: () => { select(id, false); remove(); } },
  ];
  openMenu(x, y, entries, () => chain.forEach((lid) => hl(lid, false)));
}

// ── the toolbar: move, pan, draw (frame, shapes, lines, pen, pencil, text, image) and insert ──────
// Drawn things are positioned inside the container under the pointer (it becomes their positioning
// box); inserted widgets join the page's flow after the selection, so they stay responsive. Both are
// real elements in the saved page with their styles in the edit stylesheet — the exports carry them.
type Tool = "move" | "hand" | "frame" | "rect" | "ellipse" | "line" | "arrow" | "pen" | "pencil" | "text" | "image";
const TOOL_INFO: Record<Tool, { label: string; icon: IconName; key: string }> = {
  move: { label: "Move", icon: "cursor", key: "V" },
  hand: { label: "Hand — drag to pan (or hold Space)", icon: "hand", key: "H" },
  frame: { label: "Frame", icon: "frame", key: "F" },
  rect: { label: "Rectangle", icon: "box", key: "R" },
  ellipse: { label: "Ellipse", icon: "ellipse", key: "O" },
  line: { label: "Line", icon: "line", key: "L" },
  arrow: { label: "Arrow", icon: "arrowDiag", key: "⇧L" },
  pen: { label: "Pen — click points, double-click or Enter to finish", icon: "pen", key: "P" },
  pencil: { label: "Pencil — draw freehand", icon: "pencil", key: "⇧P" },
  text: { label: "Text — click to type, drag for a fixed width", icon: "type", key: "T" },
  image: { label: "Image — drag a box, then pick a file", icon: "image", key: "I" },
};
let tool: Tool = "move";
let spaceFrom: Tool | null = null; // the tool to return to when Space (pan) is released
const TOOL_KEYS: Record<string, Tool> = { KeyV: "move", KeyH: "hand", KeyF: "frame", KeyR: "rect", KeyO: "ellipse", KeyL: "line", "⇧KeyL": "arrow", KeyP: "pen", "⇧KeyP": "pencil", KeyT: "text", KeyI: "image" };
let shapeTool: Tool = "rect"; // the shape group remembers its last choice, like Figma
let penTool: Tool = "pen";
function setTool(t: Tool): void {
  if (draw && t !== tool) finishDraw(true);
  tool = t;
  if (["rect", "ellipse", "line", "arrow"].includes(t)) shapeTool = t;
  if (t === "pen" || t === "pencil") penTool = t;
  document.body.dataset.tool = t;
  refreshOverlays(); // resize handles show only with the Move tool
  forEachFrame((d) => d.documentElement.setAttribute("data-sl-tool", t === "move" ? "" : t === "text" ? "text" : "draw"));
  renderToolbar();
}
function renderToolbar(): void {
  const bar = document.getElementById("toolbar");
  if (!bar) return;
  const btn = (t: Tool, extra = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool" + (tool === t ? " on" : "") + extra;
    b.innerHTML = icon(TOOL_INFO[t].icon, 18);
    b.dataset.tip = TOOL_INFO[t].label;
    b.dataset.key = TOOL_INFO[t].key;
    b.setAttribute("aria-label", TOOL_INFO[t].label);
    b.setAttribute("aria-pressed", String(tool === t));
    b.addEventListener("click", () => setTool(t));
    return b;
  };
  const group = (shown: Tool, choices: Tool[]) => {
    const g = document.createElement("div");
    g.className = "tool-group";
    const main = btn(shown);
    if (choices.includes(tool)) main.classList.add("on");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "tool-more";
    more.innerHTML = icon("chevronDown", 13);
    more.setAttribute("aria-label", "More tools");
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.left - 10, r.top - 8, choices.map((c): MenuEntry => ({ label: TOOL_INFO[c].label.split(" — ")[0], icon: TOOL_INFO[c].icon, key: TOOL_INFO[c].key, run: () => setTool(c) })), undefined, true);
    });
    g.append(main, more);
    return g;
  };
  const sep = () => {
    const s = document.createElement("span");
    s.className = "tool-sep";
    return s;
  };
  const insert = document.createElement("button");
  insert.type = "button";
  insert.className = "tool tool-insert";
  insert.innerHTML = `${icon("insert", 18)}<span>Insert</span>`;
  insert.dataset.tip = "Add a heading, text, button, image, video, divider or your own HTML to the page";
  insert.addEventListener("click", () => {
    const r = insert.getBoundingClientRect();
    openInsertMenu(r.left, r.top - 8);
  });
  bar.replaceChildren(btn("move"), btn("hand"), sep(), btn("frame"), group(shapeTool, ["rect", "ellipse", "line", "arrow"]), group(penTool, ["pen", "pencil"]), btn("text"), btn("image"), sep(), insert);
}
function placeToolbar(): void {
  const bar = document.getElementById("toolbar");
  if (!bar) return;
  const r = canvas.getBoundingClientRect();
  bar.style.left = `${r.left + r.width / 2}px`;
}

// drawing on an artboard
interface Draw {
  tool: Tool;
  d: Document;
  sc: Scope;
  x0: number;
  y0: number;
  x: number;
  y: number;
  shift: boolean;
  pts: { x: number; y: number }[];
}
let draw: Draw | null = null;
function startDraw(d: Document, sc: Scope, e: MouseEvent): void {
  if (sc !== S.scope) setScope(sc, false);
  if (tool === "pen" && draw && draw.d === d) {
    // the pen: each click adds a point; clicking the first point again closes the shape
    const p0 = draw.pts[0];
    if (draw.pts.length > 2 && Math.hypot(e.clientX - p0.x, e.clientY - p0.y) < 8 / S.zoom) {
      draw.pts.push({ ...p0 });
      return finishDraw();
    }
    draw.pts.push({ x: e.clientX, y: e.clientY });
    return drawPreview();
  }
  draw = { tool, d, sc, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, shift: e.shiftKey, pts: [{ x: e.clientX, y: e.clientY }] };
  drawPreview();
}
function moveDraw(e: MouseEvent): void {
  if (!draw) return;
  draw.x = e.clientX;
  draw.y = e.clientY;
  draw.shift = e.shiftKey;
  if (draw.tool === "pencil") {
    const last = draw.pts[draw.pts.length - 1];
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 2) draw.pts.push({ x: e.clientX, y: e.clientY });
  }
  drawPreview();
}
/** The box being drawn (⇧ = square), in artboard pixels. */
function drawBox(dr: Draw): Box {
  let w = dr.x - dr.x0, h = dr.y - dr.y0;
  if (dr.shift && dr.tool !== "line" && dr.tool !== "arrow") {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  return { left: Math.min(dr.x0, dr.x0 + w), top: Math.min(dr.y0, dr.y0 + h), width: Math.abs(w), height: Math.abs(h) };
}
/** A line's end point (⇧ = in steps of 45°). */
function lineEnd(dr: Draw): { x: number; y: number } {
  if (!dr.shift) return { x: dr.x, y: dr.y };
  const dx = dr.x - dr.x0, dy = dr.y - dr.y0;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
  return { x: dr.x0 + Math.cos(a) * len, y: dr.y0 + Math.sin(a) * len };
}
function arrowHead(x0: number, y0: number, x1: number, y1: number): string {
  const a = Math.atan2(y1 - y0, x1 - x0), l = 12;
  const p = (da: number) => `${(x1 - Math.cos(a + da) * l).toFixed(1)} ${(y1 - Math.sin(a + da) * l).toFixed(1)}`;
  return ` M${p(0.45)} L${x1.toFixed(1)} ${y1.toFixed(1)} L${p(-0.45)}`;
}
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l.x.toFixed(1)} ${l.y.toFixed(1)}`;
}
/** The shape as an SVG path, in artboard pixels. */
function drawPath(dr: Draw): string {
  if (dr.tool === "line" || dr.tool === "arrow") {
    const e = lineEnd(dr);
    return `M${dr.x0.toFixed(1)} ${dr.y0.toFixed(1)} L${e.x.toFixed(1)} ${e.y.toFixed(1)}` + (dr.tool === "arrow" ? arrowHead(dr.x0, dr.y0, e.x, e.y) : "");
  }
  if (dr.tool === "pencil") return smoothPath(dr.pts);
  const pts = dr.tool === "pen" ? [...dr.pts, { x: dr.x, y: dr.y }] : dr.pts;
  return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}
function drawPreview(): void {
  if (!draw) return;
  const o = overlay(draw.d, "__sl_draw");
  o.replaceChildren();
  const blue = "#3b82f6";
  if (["line", "arrow", "pen", "pencil"].includes(draw.tool)) {
    const svg = draw.d.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("style", `position:fixed;left:0;top:0;width:100%;height:${draw.d.documentElement.scrollHeight}px;overflow:visible;pointer-events:none`);
    const path = draw.d.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", drawPath(draw));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", blue);
    path.setAttribute("stroke-width", String(2 / S.zoom));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    if (draw.tool === "pen") {
      for (const p of draw.pts) {
        const c = draw.d.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", String(p.x));
        c.setAttribute("cy", String(p.y));
        c.setAttribute("r", String(4 / S.zoom));
        c.setAttribute("fill", "#fff");
        c.setAttribute("stroke", blue);
        c.setAttribute("stroke-width", String(1.5 / S.zoom));
        svg.appendChild(c);
      }
    }
    o.appendChild(svg);
    return;
  }
  const b = drawBox(draw);
  const round = draw.tool === "ellipse" ? "border-radius:50%;" : "";
  mark(o, `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;${round}outline:${px(1.5)} solid ${blue};background:${draw.tool === "text" ? "transparent" : "rgba(59,130,246,.12)"}`);
  if (b.width > 2 || b.height > 2) mark(o, `left:${b.left + b.width / 2}px;top:${b.top + b.height}px;margin-top:${px(14)};${tagCss(blue)}`, `${Math.round(b.width)} × ${Math.round(b.height)}`);
}
/** Where a drawn element goes: the nearest block container under the point that can be its positioning
 *  box without moving anything already positioned inside it; otherwise the page itself. */
const BLOCKS = /^(div|section|article|main|header|footer|aside|nav|form|figure|li)$/i;
function drawHost(d: Document, x: number, y: number): Element {
  const win = d.defaultView!;
  let el: Element | null = d.elementFromPoint(x, y)?.closest(`[${ID_ATTR}]`) || null;
  for (; el && el.localName !== "body"; el = el.parentElement?.closest(`[${ID_ATTR}]`) || null) {
    if (!BLOCKS.test(el.localName) || isLocked(el.getAttribute(ID_ATTR))) continue;
    const cs = win.getComputedStyle(el);
    if (/inline|contents/.test(cs.display) && !/inline-(block|flex|grid)/.test(cs.display)) continue;
    if (cs.position !== "static") return el;
    // turning it into a positioning box must not move what's absolutely placed inside it
    const all = el.getElementsByTagName("*");
    let safe = true;
    for (let i = 0; i < all.length && i < 3000; i++) {
      const n = all[i] as HTMLElement;
      if (win.getComputedStyle(n).position === "absolute" && n.offsetParent && !el.contains(n.offsetParent)) {
        safe = false;
        break;
      }
    }
    if (safe) return el;
  }
  return d.body;
}
const SVG_KINDS = new Set<Tool>(["line", "arrow", "pen", "pencil"]);
const NAMES: Partial<Record<Tool, string>> = { frame: "Frame", rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow", pen: "Vector", pencil: "Drawing", text: "Text", image: "Image" };
function finishDraw(cancel = false): void {
  const dr = draw;
  draw = null;
  if (!dr) return;
  overlay(dr.d, "__sl_draw").replaceChildren();
  if (cancel) return;
  let box = drawBox(dr);
  let pathD = "";
  if (SVG_KINDS.has(dr.tool)) {
    const pts = dr.tool === "line" || dr.tool === "arrow" ? [{ x: dr.x0, y: dr.y0 }, lineEnd(dr)] : dr.tool === "pen" ? dr.pts : dr.pts;
    if (pts.length < 2 || (dr.tool !== "pen" && Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < 3 && dr.tool !== "pencil") || (dr.tool === "pencil" && pts.length < 3)) return setTool("move");
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    box = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
    const local = pts.map((p) => ({ x: p.x - box.left, y: p.y - box.top }));
    if (dr.tool === "pencil") pathD = smoothPath(local);
    else {
      pathD = local.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      if (dr.tool === "arrow") pathD += arrowHead(local[0].x, local[0].y, local[1].x, local[1].y);
      if (dr.tool === "pen" && pts.length > 2 && pts[pts.length - 1].x === pts[0].x && pts[pts.length - 1].y === pts[0].y) pathD += " Z";
    }
  } else if (dr.tool !== "text" && box.width < 4 && box.height < 4) {
    box = { left: box.left - 50, top: box.top - 50, width: 100, height: 100 }; // a click makes a 100 × 100 one
    if (dr.tool === "image") box = { left: dr.x0, top: dr.y0, width: 0, height: 0 };
  }
  if (dr.tool === "image") {
    pickImage((src, w, h) => {
      const width = box.width >= 4 ? box.width : Math.min(w, 480);
      const height = box.width >= 4 ? box.height : Math.round((width / Math.max(1, w)) * h);
      createDrawn(dr, { ...box, width, height }, `<img data-name="Image" alt="" src="${src.replace(/"/g, "&quot;")}">`, { objectFit: "cover" });
    });
    return setTool("move");
  }
  const name = NAMES[dr.tool] || "Layer";
  let html = "";
  let style: Record<string, string> = {};
  if (dr.tool === "text") html = `<p data-name="Text">Text</p>`;
  else if (SVG_KINDS.has(dr.tool)) html = `<svg data-name="${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box.width.toFixed(1)} ${box.height.toFixed(1)}" preserveAspectRatio="none"><path d="${pathD}" vector-effect="non-scaling-stroke"/></svg>`;
  else html = `<div data-name="${name}"></div>`;
  if (dr.tool === "frame") style = { backgroundColor: "#ffffff", overflow: "hidden" };
  if (dr.tool === "rect") style = { backgroundColor: "#d9d9d9" };
  if (dr.tool === "ellipse") style = { backgroundColor: "#d9d9d9", borderRadius: "50%" };
  if (dr.tool === "text") style = { margin: "0", fontSize: "24px", lineHeight: "1.25", color: "#111111", whiteSpace: "pre-wrap" };
  if (SVG_KINDS.has(dr.tool)) style = { overflow: "visible", fill: "none", stroke: "#111111", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" };
  const textBox = dr.tool === "text" ? (box.width > 20 ? { ...box, height: 0 } : { ...box, width: 0, height: 0 }) : box;
  const nid = createDrawn(dr, textBox, html, style);
  setTool("move");
  if (dr.tool === "text" && nid) {
    const el = byId(dr.d, nid) as HTMLElement | null;
    if (el) {
      startTextEdit(el, dr.sc);
      const sel = dr.d.getSelection();
      sel?.selectAllChildren(el);
    }
  }
}
/** Put a drawn element on the page (saved page + every artboard) with its position and look. */
function createDrawn(dr: Draw, box: Box, html: string, style: Record<string, string>): string | null {
  if (!S.doc) return null;
  const host = drawHost(dr.d, box.left + 1, box.top + 1);
  const hostId = host.getAttribute(ID_ATTR);
  const win = dr.d.defaultView!;
  const hcs = win.getComputedStyle(host);
  const isBody = host.localName === "body";
  const hr = host.getBoundingClientRect();
  const page = isBody && hcs.position === "static"; // positioned against the page itself
  const ox = page ? 0 : hr.left + (parseFloat(hcs.borderLeftWidth) || 0), oy = page ? 0 : hr.top + (parseFloat(hcs.borderTopWidth) || 0);
  const nid = String(maxId(S.doc) + 1);
  checkpoint();
  if (!isBody && hostId && hcs.position === "static") S.edits = setEdit(S.edits, hostId, "base", "position", "relative");
  const geo: Record<string, string> = { position: "absolute", left: `${Math.round(box.left - ox)}px`, top: `${Math.round(box.top - oy)}px` };
  if (box.width > 0) geo.width = `${Math.round(box.width)}px`;
  if (box.height > 0) geo.height = `${Math.round(box.height)}px`;
  for (const [p, v] of Object.entries({ ...geo, ...style })) S.edits = setEdit(S.edits, nid, "base", p, v);
  mirror((d) => {
    const h = (hostId && byId(d, hostId)) || d.body;
    const t = d.createElement("template");
    t.innerHTML = html;
    const el = t.content.firstElementChild;
    if (!el) return;
    el.setAttribute(ID_ATTR, nid);
    h.appendChild(el);
  });
  if (hostId) S.expanded.add(hostId);
  commit(true);
  select(nid, false);
  renderLayers();
  return nid;
}
/** An image file → a data URL and its natural size. */
function readImage(file: File, done: (src: string, w: number, h: number) => void): void {
  const fr = new FileReader();
  fr.onload = () => {
    const src = String(fr.result);
    const img = new Image();
    img.onload = () => done(src, img.naturalWidth || 320, img.naturalHeight || 200);
    img.onerror = () => done(src, 320, 200);
    img.src = src;
  };
  fr.readAsDataURL(file);
}
/** Put a picture on an artboard, centred on (x, y) in that artboard (dropped or pasted images). */
function placeImage(d: Document, sc: Scope, x: number, y: number, src: string, w: number, h: number): void {
  const width = Math.min(w, Math.round(sizeOf(sc).w * 0.5), 560);
  const height = Math.round((width / Math.max(1, w)) * h);
  const dr: Draw = { tool: "image", d, sc, x0: x, y0: y, x, y, shift: false, pts: [] };
  createDrawn(dr, { left: Math.max(0, x - width / 2), top: Math.max(0, y - height / 2), width, height }, `<img data-name="Image" alt="" src="${src.replace(/"/g, "&quot;")}">`, { objectFit: "cover" });
  toast("Image added — drag it into place, or resize it from its corners.");
}
/** Where a pasted image goes: on the selected layer, else the middle of the active artboard's visible part. */
function pastePoint(): { d: Document; sc: Scope; x: number; y: number } | null {
  const sc = S.scope;
  const f = S.frames.get(sc);
  const d = frameDoc(sc);
  if (!f || !d) return null;
  const sel = S.sel ? (byId(d, S.sel) as HTMLElement | null) : null;
  if (sel && sel.localName !== "body") {
    const r = sel.getBoundingClientRect();
    return { d, sc, x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200) };
  }
  const fr = f.getBoundingClientRect(), vr = stage.getBoundingClientRect();
  const cx = (Math.max(fr.left, Math.min(fr.right, (vr.left + vr.right) / 2)) - fr.left) / S.zoom;
  const cy = (Math.max(fr.top, Math.min(fr.bottom, (vr.top + vr.bottom) / 2)) - fr.top) / S.zoom;
  return { d, sc, x: cx, y: cy };
}
function pickImage(done: (src: string, w: number, h: number) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) readImage(file, done);
  };
  input.click();
}

// inserting widgets into the page's flow (simpler than Elementor: one click, sensible defaults)
interface Widget {
  label: string;
  icon: IconName;
  html: string | (() => Promise<string | null>);
  style?: Record<string, string>;
}
const WIDGETS: Widget[] = [
  { label: "Heading", icon: "heading", html: `<h2 data-name="Heading">Your heading</h2>`, style: { margin: "0 0 12px" } },
  { label: "Paragraph", icon: "paragraph", html: `<p data-name="Paragraph">Write something here. Double-click to edit this text.</p>`, style: { margin: "0 0 12px" } },
  { label: "Button", icon: "button", html: `<a data-name="Button" href="#">Get started</a>`, style: { display: "inline-block", padding: "12px 22px", backgroundColor: "#111111", color: "#ffffff", borderRadius: "999px", textDecoration: "none", fontWeight: "600" } },
  { label: "Link", icon: "link", html: `<a data-name="Link" href="#">Learn more</a>`, style: { textDecoration: "underline" } },
  { label: "Image", icon: "image", html: () => new Promise((res) => pickImage((src) => res(`<img data-name="Image" alt="" src="${src.replace(/"/g, "&quot;")}">`))), style: { display: "block", maxWidth: "100%", height: "auto" } },
  { label: "Video", icon: "video", html: async () => {
    const url = await ask("Add a video", "Paste a YouTube or Vimeo link, or the address of a video file");
    if (!url) return null;
    const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/.exec(url), vm = /vimeo\.com\/(\d+)/.exec(url);
    const esc = (s: string) => s.replace(/"/g, "&quot;");
    if (yt) return `<iframe data-name="Video" src="https://www.youtube.com/embed/${yt[1]}" title="Video" allowfullscreen loading="lazy"></iframe>`;
    if (vm) return `<iframe data-name="Video" src="https://player.vimeo.com/video/${vm[1]}" title="Video" allowfullscreen loading="lazy"></iframe>`;
    return `<video data-name="Video" src="${esc(url)}" controls playsinline></video>`;
  }, style: { display: "block", width: "100%", aspectRatio: "16 / 9", border: "0" } },
  { label: "Divider", icon: "divider", html: `<hr data-name="Divider">`, style: { border: "0", borderTop: "1px solid #e5e5e5", margin: "24px 0" } },
  { label: "Spacer", icon: "spacer", html: `<div data-name="Spacer"></div>`, style: { height: "48px" } },
  { label: "Embed HTML", icon: "code", html: async () => {
    const code = await ask("Embed your own HTML", "Paste HTML — a form, a map, a widget. It runs in the exported site.", true);
    return code ? `<div data-name="Embed">${code}</div>` : null;
  } },
];
function openInsertMenu(x: number, y: number): void {
  openMenu(x, y, [
    ...WIDGETS.map((w): MenuEntry => ({ label: w.label, icon: w.icon, run: () => void insertWidget(w) })),
  ], undefined, true);
}
async function insertWidget(w: Widget): Promise<void> {
  if (!S.doc) return;
  const html = typeof w.html === "string" ? w.html : await w.html();
  if (!html) return;
  const after = S.sel ? byId(S.doc, S.sel) : null;
  const target = after && after.localName !== "body" ? after.getAttribute(ID_ATTR) : null;
  const tpl = S.doc.createElement("template");
  tpl.innerHTML = html;
  const node = tpl.content.firstElementChild;
  if (!node) return;
  let next = maxId(S.doc);
  [node, ...Array.from(node.querySelectorAll("*"))].forEach((n) => {
    if (!/^(script|style|template|noscript)$/i.test(n.localName)) n.setAttribute(ID_ATTR, String(++next));
  });
  const nid = node.getAttribute(ID_ATTR)!;
  checkpoint();
  for (const [p, v] of Object.entries(w.style || {})) S.edits = setEdit(S.edits, nid, "base", p, v);
  mirror((d) => {
    const at = target ? byId(d, target) : null;
    const el = d.importNode(node, true);
    if (at) at.after(el);
    else (d.querySelector("main") || d.body).appendChild(el);
  });
  commit(true);
  select(nid);
  renderLayers();
  toast(`${w.label} added${target ? " after the selection" : " at the end of the page"} — double-click text to edit it.`);
}
/** A small dialog asking for one value (a link, a piece of code). */
function ask(title: string, hint: string, multiline = false): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask";
    wrap.innerHTML = `<div class="ask-card" role="dialog" aria-modal="true"><strong></strong><p></p>${multiline ? "<textarea rows=\"6\"></textarea>" : "<input type=\"text\">"}<div class="btn-row"><button class="mini" data-no>Cancel</button><button class="mini primary" data-ok>Add</button></div></div>`;
    wrap.querySelector("strong")!.textContent = title;
    wrap.querySelector("p")!.textContent = hint;
    const field = wrap.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
    const done = (v: string | null) => {
      wrap.remove();
      resolve(v && v.trim() ? v.trim() : null);
    };
    wrap.querySelector("[data-ok]")!.addEventListener("click", () => done(field.value));
    wrap.querySelector("[data-no]")!.addEventListener("click", () => done(null));
    wrap.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) done(field.value);
    });
    document.body.appendChild(wrap);
    field.focus();
  });
}

// ── resize handles on the selection (drag an edge or a corner) ─────────────────────────────────────
// Edges change the width / height; ⇧ keeps the proportions, ⌥ resizes from the centre. Text: the side
// edges set its width (it re-wraps) and a corner scales the text itself (font size), like Canva.
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLE_CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
const isTextLayer = (el: Element) => {
  const k = layerKind(el);
  return k === "text" || ((k === "link" || k === "button") && !el.querySelector("img, svg, video, canvas"));
};
function drawHandles(d: Document, id: string | null): void {
  let o = d.getElementById("__sl_handles") as HTMLDivElement | null;
  if (!o) {
    o = d.createElement("div");
    o.id = "__sl_handles";
    o.setAttribute("data-sl-editor", "");
    o.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    d.documentElement.appendChild(o);
  }
  o.replaceChildren();
  const el = id ? (byId(d, id) as HTMLElement | null) : null;
  if (!el || el.localName === "body" || tool !== "move" || isLocked(id) || d.documentElement.hasAttribute("data-sl-dragging") || el.isContentEditable) return;
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return;
  const text = isTextLayer(el);
  const s = 9 / S.zoom;
  // the grab strips along the edges never cover more than a quarter of the layer (a thin nav bar must
  // still be draggable from its middle)
  const edgeV = Math.min(7 / S.zoom, r.height / 4), edgeH = Math.min(7 / S.zoom, r.width / 4);
  const add = (h: Handle, css: string) => {
    const k = d.createElement("div");
    k.setAttribute("data-sl-handle", h);
    k.style.cssText = `position:fixed;pointer-events:auto;box-sizing:border-box;cursor:${HANDLE_CURSOR[h]};${css}`;
    o!.appendChild(k);
  };
  // the edges: invisible strips you can grab along their whole length
  const edges: Handle[] = text ? ["e", "w"] : ["n", "e", "s", "w"];
  for (const h of edges) {
    if (h === "n" || h === "s") add(h, `left:${r.left + s / 2}px;top:${(h === "n" ? r.top : r.bottom) - edgeV / 2}px;width:${Math.max(0, r.width - s)}px;height:${edgeV}px`);
    else add(h, `top:${r.top + s / 2}px;left:${(h === "w" ? r.left : r.right) - edgeH / 2}px;height:${Math.max(0, r.height - s)}px;width:${edgeH}px`);
  }
  // the corners (and, for boxes, the middle of each side): small squares
  const squares: Handle[] = text ? ["nw", "ne", "se", "sw", "e", "w"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  for (const h of squares) {
    const x = h.includes("w") ? r.left : h.includes("e") ? r.right : r.left + r.width / 2;
    const y = h.includes("n") ? r.top : h.includes("s") ? r.bottom : r.top + r.height / 2;
    add(h, `left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;background:#fff;border:${1.5 / S.zoom}px solid #3b82f6;border-radius:${2 / S.zoom}px`);
  }
}
interface Resize {
  d: Document;
  id: string;
  el: HTMLElement;
  h: Handle;
  x0: number;
  y0: number;
  w0: number;
  h0: number;
  abs: boolean;
  l0: number;
  t0: number;
  tr0: { x: number; y: number };
  text: boolean;
  scaleText: boolean;
  fs0: number;
  lh0: number | null;
  ls0: number | null;
  inline: boolean;
  w: number;
  hh: number;
  sx: number;
  sy: number;
  fs: number;
  moved: boolean;
}
let rs: Resize | null = null;
function startResizeEl(d: Document, h: Handle, e: MouseEvent): void {
  const id = S.sel;
  const el = id ? (byId(d, id) as HTMLElement | null) : null;
  if (!id || !el) return;
  const cs = d.defaultView!.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const text = isTextLayer(el);
  const px0 = (v: string) => (/px$/.test(v) ? parseFloat(v) : null);
  rs = {
    d, id, el, h, x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height,
    abs: /absolute|fixed/.test(cs.position), l0: parseFloat(cs.left) || 0, t0: parseFloat(cs.top) || 0,
    tr0: parseTranslate(effectiveEdit(S.edits, id, S.scope, "translate") || cs.translate),
    text, scaleText: text && h.length === 2, fs0: parseFloat(cs.fontSize) || 16, lh0: px0(cs.lineHeight), ls0: px0(cs.letterSpacing),
    inline: cs.display === "inline", w: r.width, hh: r.height, sx: 0, sy: 0, fs: parseFloat(cs.fontSize) || 16, moved: false,
  };
  d.documentElement.setAttribute("data-sl-resizing", "");
  hideTip();
}
function moveResizeEl(e: MouseEvent): void {
  const z = rs;
  if (!z) return;
  const dx = e.clientX - z.x0, dy = e.clientY - z.y0;
  if (!z.moved && Math.hypot(dx, dy) < 2) return;
  z.moved = true;
  const horiz = z.h.includes("e") || z.h.includes("w"), vert = z.h.includes("n") || z.h.includes("s");
  // growth on each axis (a west / north handle grows the other way)
  let gx = horiz ? (z.h.includes("e") ? dx : -dx) : 0;
  let gy = vert ? (z.h.includes("s") ? dy : -dy) : 0;
  const center = e.altKey;
  if (center) {
    gx *= 2;
    gy *= 2;
  }
  let w = Math.max(1, z.w0 + gx), hh = Math.max(1, z.h0 + gy);
  if ((e.shiftKey || z.scaleText) && horiz && vert) {
    const k = Math.max(w / z.w0, hh / z.h0);
    w = Math.max(1, z.w0 * k);
    hh = Math.max(1, z.h0 * k);
  }
  // keep the opposite edge where it was (or the centre, with ⌥)
  const sx = center ? -(w - z.w0) / 2 : z.h.includes("w") ? z.w0 - w : 0;
  const sy = center ? -(hh - z.h0) / 2 : z.h.includes("n") ? z.h0 - hh : 0;
  Object.assign(z, { w, hh, sx, sy });
  const st = z.el.style;
  if (z.inline) st.setProperty("display", "inline-block", "important");
  if (z.scaleText) {
    z.fs = Math.max(4, z.fs0 * (w / z.w0));
    st.setProperty("font-size", `${z.fs}px`, "important");
    if (z.lh0) st.setProperty("line-height", `${z.lh0 * (w / z.w0)}px`, "important");
    if (z.ls0) st.setProperty("letter-spacing", `${z.ls0 * (w / z.w0)}px`, "important");
  } else {
    if (horiz) st.setProperty("width", `${w}px`, "important");
    if (vert) st.setProperty("height", `${hh}px`, "important");
  }
  if (z.abs) {
    if (sx) st.setProperty("left", `${z.l0 + sx}px`, "important");
    if (sy) st.setProperty("top", `${z.t0 + sy}px`, "important");
  } else if (sx || sy) st.setProperty("translate", `${z.tr0.x + sx}px ${z.tr0.y + sy}px`, "important");
  const o = overlay(z.d, "__sl_guides");
  o.replaceChildren();
  const r = z.el.getBoundingClientRect();
  mark(o, `left:${r.left + r.width / 2}px;top:${r.bottom}px;margin-top:${px(16)};${tagCss("#3b82f6")}`, z.scaleText ? `${Math.round(z.fs)} px text` : `${Math.round(w)} × ${Math.round(hh)}`);
  drawHandles(z.d, null);
}
function endResizeEl(): void {
  const z = rs;
  rs = null;
  if (!z) return;
  z.d.documentElement.removeAttribute("data-sl-resizing");
  overlay(z.d, "__sl_guides").replaceChildren();
  for (const p of ["display", "width", "height", "font-size", "line-height", "letter-spacing", "left", "top", "translate"]) z.el.style.removeProperty(p);
  if (!z.moved) return refreshOverlays();
  const horiz = z.h.includes("e") || z.h.includes("w"), vert = z.h.includes("n") || z.h.includes("s");
  checkpoint();
  const set = (p: string, v: string) => (S.edits = setEdit(S.edits, z.id, S.scope, p, v));
  if (z.inline) set("display", "inline-block");
  if (z.scaleText) {
    set("fontSize", `${Math.round(z.fs * 10) / 10}px`);
    if (z.lh0) set("lineHeight", `${Math.round(z.lh0 * (z.w / z.w0) * 10) / 10}px`);
    if (z.ls0) set("letterSpacing", `${Math.round(z.ls0 * (z.w / z.w0) * 100) / 100}px`);
  } else {
    if (horiz) set("width", `${Math.round(z.w)}px`);
    if (vert) set("height", `${Math.round(z.hh)}px`);
  }
  if (z.abs) {
    if (z.sx) set("left", `${Math.round(z.l0 + z.sx)}px`);
    if (z.sy) set("top", `${Math.round(z.t0 + z.sy)}px`);
  } else if (z.sx || z.sy) set("translate", formatTranslate(z.tr0.x + z.sx, z.tr0.y + z.sy));
  commit(false);
  renderProps();
}

// ── Inspect: the selected layer's code — exactly what the exports contain for it ──────────────────
// (the idea of Penpot's Inspect mode; written for StyleLift's own model: the saved page + edit sheet)
let panelTab: "design" | "inspect" = "design";
function renderPanelTabs(): void {
  const tabs = document.getElementById("panel-tabs");
  if (!tabs) return;
  tabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    const on = b.dataset.tab === panelTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
}
function setPanelTab(t: "design" | "inspect"): void {
  panelTab = t;
  renderPanelTabs();
  renderProps();
}
/** How the layer looks now on the breakpoint being edited, as CSS (the properties that matter). */
function computedCss(id: string): string {
  const d = frameDoc(S.scope);
  const live = d ? (byId(d, id) as HTMLElement | null) : null;
  const el = S.doc ? byId(S.doc, id) : null;
  if (!live || !el) return "";
  const cs = d!.defaultView!.getComputedStyle(live);
  const PROPS = ["display", "position", "top", "right", "bottom", "left", "z-index", "width", "height", "margin", "padding", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "grid-template-rows", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "text-align", "text-transform", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity", "transform", "translate", "scale", "rotate", "overflow", "stroke", "stroke-width", "fill"];
  const SKIP = /^(none|normal|auto|0px|static|visible|rgba\(0, 0, 0, 0\)|0px none.*|start)$/;
  const lines: string[] = [];
  for (const p of PROPS) {
    const v = cs.getPropertyValue(p).trim();
    if (!v || SKIP.test(v)) continue;
    if (/^(flex-direction|flex-wrap|justify-content|align-items|gap)$/.test(p) && !/flex|grid/.test(cs.display)) continue;
    if (/^grid-template/.test(p) && !/grid/.test(cs.display)) continue;
    if (/^(top|right|bottom|left|z-index)$/.test(p) && cs.position === "static") continue;
    if (/^(stroke|stroke-width|fill)$/.test(p) && layerKind(el) !== "svg") continue;
    if (p === "opacity" && v === "1") continue;
    lines.push(`  ${p}: ${v};`);
  }
  const cls = layerName(el).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "layer";
  return `.${cls} {\n${lines.join("\n")}\n}`;
}
/** A little colour for code (tags / properties / values / strings), escaped. */
function highlight(code: string, lang: "html" | "css" | "jsx"): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (lang === "css") {
    return code
      .split("\n")
      .map((l) => {
        const m = /^(\s*)([\w-]+)(\s*:\s*)(.*?)(;?)$/.exec(l);
        if (m && !/[{}]/.test(l)) return `${m[1]}<span class="hl-p">${esc(m[2])}</span>${esc(m[3])}<span class="hl-v">${esc(m[4])}</span>${m[5]}`;
        return `<span class="hl-s">${esc(l)}</span>`;
      })
      .join("\n");
  }
  return esc(code)
    .replace(/(&lt;\/?)([\w.-]+)/g, `$1<span class="hl-t">$2</span>`)
    .replace(/([\w:-]+)=(&quot;|")([^"]*?)(")/g, `<span class="hl-p">$1</span>=<span class="hl-v">"$3"</span>`);
}
function prettyHtml(html: string): string {
  // one element per line, indented — readable, not a full formatter
  let depth = 0;
  const out: string[] = [];
  for (const tok of html.replace(/>\s*</g, ">\n<").split("\n")) {
    const t = tok.trim();
    if (!t) continue;
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + t);
    if (/^<[a-z]/i.test(t) && !/\/>$/.test(t) && !/^<(img|br|hr|input|meta|link|source|path|circle|rect|line|polyline|polygon|use)\b/i.test(t) && !/<\/[\w-]+>$/.test(t)) depth++;
  }
  return out.join("\n");
}
function codeBlock(title: string, lang: "html" | "css" | "jsx", code: string, note = ""): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "sec code-sec";
  const h = document.createElement("h4");
  h.innerHTML = icon(lang === "css" ? "braces" : "code", 14);
  const t = document.createElement("span");
  t.textContent = title;
  const copy = document.createElement("button");
  copy.className = "mini code-copy";
  copy.innerHTML = icon("copy", 13) + "Copy";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(code).then(
      () => toast(`${title} copied.`),
      () => toast("The browser blocked the clipboard.", true),
    );
  });
  h.append(t, copy);
  sec.appendChild(h);
  if (note) {
    const n = document.createElement("div");
    n.className = "hint";
    n.textContent = note;
    sec.appendChild(n);
  }
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.innerHTML = highlight(code.length > 12000 ? code.slice(0, 12000) + "\n… (copy for the rest)" : code, lang);
  sec.appendChild(pre);
  return sec;
}
function renderInspect(): void {
  if (!S.sel || !S.doc) {
    propsEl.innerHTML = `<div class="empty-props"><span class="empty-ico">${icon("code", 22)}</span><strong>Inspect a layer</strong><span>Select anything to see its HTML and CSS — exactly what the exports will contain for it, your changes included.</span></div>`;
    return;
  }
  const el = byId(S.doc, S.sel);
  if (!el) return;
  const wrap = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "prop-head";
  head.innerHTML = `<div class="ph-row"><span class="kind-badge">${icon(KIND_ICON[layerKind(el)], 16)}</span><div class="ph-name"><strong></strong><small></small></div></div>`;
  head.querySelector("strong")!.textContent = layerName(el);
  head.querySelector("small")!.textContent = `${KIND_NAME[layerKind(el)]} · <${el.localName}>`;
  wrap.appendChild(head);
  const edits: StyleEdits = {};
  for (const i of subtreeIds(el)) if (S.edits[i]) edits[i] = S.edits[i];
  const changes = editsToCss(edits);
  wrap.appendChild(
    changes
      ? codeBlock("Your changes (CSS)", "css", changes, "Added to the exported stylesheet as written — Tablet and Phone changes inside their media queries.")
      : (() => {
          const s = document.createElement("div");
          s.className = "sec";
          s.innerHTML = `<h4>${icon("braces", 14)}<span>Your changes (CSS)</span></h4><div class="hint">None yet — this layer exports exactly as it was captured.</div>`;
          return s;
        })(),
  );
  wrap.appendChild(codeBlock("HTML", "html", prettyHtml(cleanHtml(el, true)), "The element as exported (ids kept only where a change needs them)."));
  wrap.appendChild(codeBlock(`How it looks on ${scopeLabel()} (CSS)`, "css", computedCss(S.sel), "Measured from the artboard — handy to reuse elsewhere."));
  let jsx = "";
  try {
    jsx = htmlToJsx(cleanHtml(el), "Layer");
  } catch {
    jsx = "";
  }
  if (jsx) wrap.appendChild(codeBlock("React (JSX)", "jsx", jsx));
  propsEl.replaceChildren(wrap);
}

// ── page colours (Penpot / Figma "document colours"): one click puts a colour the page already uses ──
let pageColors: string[] | null = null;
function collectPageColors(): string[] {
  if (pageColors) return pageColors;
  const d = frameDoc("base");
  if (!d?.body) return [];
  const win = d.defaultView!;
  const count = new Map<string, number>();
  const all = d.body.getElementsByTagName("*");
  for (let i = 0; i < all.length && i < 4000; i++) {
    const cs = win.getComputedStyle(all[i]);
    for (const v of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
      if (!v || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/.test(v)) continue;
      const hex = toHex(v);
      if (hex) count.set(hex, (count.get(hex) || 0) + 1);
    }
  }
  pageColors = Array.from(count.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
  return pageColors;
}

// ── keyboard shortcuts (press ?) ───────────────────────────────────────────────────────────────
function showShortcuts(): void {
  document.querySelector(".ask")?.remove();
  const groups: [string, [string, string][]][] = [
    ["Tools", [["V", "Move"], ["H · hold Space", "Hand (pan)"], ["F", "Frame"], ["R", "Rectangle"], ["O", "Ellipse"], ["L", "Line"], ["⇧L", "Arrow"], ["P", "Pen"], ["⇧P", "Pencil"], ["T", "Text"], ["I", "Image"], ["M", "Reorder / Free move"], ["G", "Layout grid"]]],
    ["Edit", [[k("⌘", "Z"), "Undo"], [k("⇧⌘", "Z"), "Redo"], [k("⌘", "C"), "Copy"], [k("⌘", "X"), "Cut"], [k("⌘", "V"), "Paste"], [k("⌘", "D"), "Duplicate"], ["⌫", "Delete"], [k("⌥⌘", "C"), "Copy style"], [k("⌥⌘", "V"), "Paste style"]]],
    ["Arrange", [["]", "Bring to front"], ["[", "Send to back"], [k("⌘", "]"), "Bring forward"], [k("⌘", "["), "Send backward"], [k("⌘", "G"), "Group"], [k("⌥⌘", "G"), "Frame"], [k("⇧⌘", "G"), "Ungroup"], [k("⇧", "A"), "Add auto layout"], [k("⇧", "H") + " / " + k("⇧", "V"), "Flip"], ["Arrows", "Nudge 1 px (⇧ 10 px)"]]],
    ["Several layers", [["⇧ + click", "Add / remove from the selection"], ["Drag on empty space", "Select what's inside the box"], [k("⌘", "A"), "Select everything next to it"], [k("⌥", "A") + " " + k("⌥", "H") + " " + k("⌥", "D"), "Align left / centre / right"], [k("⌥", "W") + " " + k("⌥", "V") + " " + k("⌥", "S"), "Align top / middle / bottom"], [k("⌃⌥", "H") + " / " + k("⌃⌥", "V"), "Space evenly"], ["Esc", "Keep just the first"]]],
    ["View", [[k("⌘", "scroll") + " · pinch", "Zoom"], ["Esc", "Select parent"], [k("⇧⌘", "H"), "Show / hide"], [k("⇧⌘", "L"), "Lock / unlock"], ["⌥ + point", "Measure distances"], ["?", "This list"]]],
  ];
  const wrap = document.createElement("div");
  wrap.className = "ask";
  wrap.innerHTML = `<div class="ask-card keys-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div class="keys-head"><strong>Keyboard shortcuts</strong><button class="mini" data-no>${icon("close", 13)}Close</button></div><div class="keys-grid"></div></div>`;
  const grid = wrap.querySelector(".keys-grid")!;
  for (const [title, rows] of groups) {
    const col = document.createElement("div");
    const h = document.createElement("h5");
    h.textContent = title;
    col.appendChild(h);
    const dl = document.createElement("dl");
    for (const [key, what] of rows) {
      const dt = document.createElement("dt");
      dt.innerHTML = `<kbd></kbd>`;
      dt.querySelector("kbd")!.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = what;
      dl.append(dt, dd);
    }
    col.appendChild(dl);
    grid.appendChild(col);
  }
  const close = () => wrap.remove();
  wrap.querySelector("[data-no]")!.addEventListener("click", close);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.appendChild(wrap);
  (wrap.querySelector("[data-no]") as HTMLElement).focus();
}

// ── home (all projects) ───────────────────────────────────────────────────────
async function showHome(): Promise<void> {
  document.body.classList.add("home-mode"); // the projects list: no canvas tools
  homeEl.hidden = false;
  stage.hidden = true;
  const list = await listProjects();
  homeEl.innerHTML = `<h1>${icon("grid", 20)}Your captures</h1><p>${list.length ? "Open a project to edit it in the canvas." : 'Nothing here yet. Open any website, then choose <b>Edit in Studio</b> in the StyleLift panel.'}</p><div class="cards"></div>`;
  const cards = homeEl.querySelector(".cards")!;
  for (const p of list) {
    const c = document.createElement("div");
    c.className = "card";
    const t = document.createElement("strong");
    t.innerHTML = icon("globe", 15);
    t.append(p.title || p.url);
    const u = document.createElement("span");
    u.textContent = p.url;
    const when = document.createElement("span");
    when.textContent = p.pageList?.length
      ? `Edited ${new Date(p.updatedAt).toLocaleString()} · ${p.pageList.length} pages`
      : `Edited ${new Date(p.updatedAt).toLocaleString()} · ${Object.keys(p.edits || {}).length} styled layers`;
    const row = document.createElement("div");
    row.className = "btn-row";
    row.append(
      miniBtn("Open", () => (location.search = `?id=${encodeURIComponent(p.id)}`), false, "edit"),
      miniBtn("Delete", async () => {
        await deleteProject(p.id);
        showHome();
      }, true, "trash"),
    );
    c.append(t, u, when, row);
    cards.appendChild(c);
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────
function renderScopeTabs(): void {
  const tabs = $<HTMLDivElement>("#scope-tabs");
  tabs.replaceChildren(
    ...SCOPES.map((sc) => {
      const b = document.createElement("button");
      b.className = "scope-tab";
      b.dataset.scope = sc.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(sc.id === S.scope));
      b.innerHTML = `${icon(sc.id === "base" ? "desktop" : sc.id === "tablet" ? "tablet" : "phone", 15)}<span>${sc.label}</span><small>${sizeOf(sc.id).w}</small>`;
      b.dataset.tip = sc.id === "base" ? "Desktop edits apply to every size" : `${sc.label} edits apply below ${sc.id === "tablet" ? 1200 : 810} px`;
      b.addEventListener("click", () => setScope(sc.id));
      return b;
    }),
  );
}
async function boot(): Promise<void> {
  hydrateIcons();
  setTools({});
  $<HTMLButtonElement>("#mode-reorder").addEventListener("click", () => setTools({ mode: "reorder" }));
  $<HTMLButtonElement>("#mode-free").addEventListener("click", () => setTools({ mode: "free" }));
  $<HTMLButtonElement>("#grid-btn").addEventListener("click", () => {
    setTools({ grid: !UI.grid });
    if (!S.sel) renderProps();
  });
  $<HTMLButtonElement>("#snap-btn").addEventListener("click", () => setTools({ snap: !UI.snap }));
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") forEachFrame((d) => clearMeasure(d));
    if (e.code === "Space" && spaceFrom) {
      setTool(spaceFrom);
      spaceFrom = null;
    }
  });
  // the hand: drag the canvas to pan
  canvas.addEventListener("mousedown", (e) => {
    if (tool !== "hand" || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, sl = canvas.scrollLeft, st = canvas.scrollTop;
    document.body.classList.add("panning");
    const move = (ev: MouseEvent) => {
      canvas.scrollLeft = sl - (ev.clientX - x0);
      canvas.scrollTop = st - (ev.clientY - y0);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.body.classList.remove("panning");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  });
  renderToolbar();
  placeToolbar();
  document.querySelectorAll<HTMLButtonElement>("#panel-tabs button").forEach((b) => b.addEventListener("click", () => setPanelTab(b.dataset.tab as "design" | "inspect")));
  window.addEventListener("resize", placeToolbar);
  renderScopeTabs();
  renderProps();
  $<HTMLButtonElement>("#home-btn").addEventListener("click", () => (location.search = ""));
  $<HTMLButtonElement>("#undo-btn").addEventListener("click", undo);
  $<HTMLButtonElement>("#redo-btn").addEventListener("click", redo);
  const centre = () => {
    const r = canvas.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2] as const;
  };
  $<HTMLButtonElement>("#zoom-in").addEventListener("click", () => zoomAt(S.zoom * 1.25, ...centre()));
  $<HTMLButtonElement>("#zoom-out").addEventListener("click", () => zoomAt(S.zoom / 1.25, ...centre()));
  $<HTMLButtonElement>("#zoom-label").addEventListener("click", fitZoom);
  $<HTMLButtonElement>("#preview-btn").addEventListener("click", () => {
    if (!S.doc) return;
    // exactly what the exports start from: your edits, live animations, real scrolling — and the same code:
    // it opens in a sandboxed page (no extension access, its own origin) where the page's scripts run like
    // they do in the exports (the scroll-in trigger, Lottie / Rive, scripts kept at capture)
    const html = buildExportHtml(S.doc, S.edits);
    // live 3D scenes need a real address (their frames load the site's own page and files): the private
    // https://<site>.stylelift.test preview, answered from your edited page + the scenes' files
    if (hasIslands(html) && S.project) {
      const proj = S.project;
      void sceneFiles(html).then(async (scenes) => {
        if (!scenes) return openSandboxPreview(html);
        try {
          await startPreview({ "index.html": addIslandTag(html), ...scenes }, proj.url, "/", () => {});
        } catch (e) {
          toast("The 3D preview couldn't start (" + (e instanceof Error ? e.message : String(e)) + ") — showing the pictures instead.", true);
          openSandboxPreview(html);
        }
      });
      return;
    }
    openSandboxPreview(html);
  });
  function openSandboxPreview(html: string): void {
    const w = window.open(chrome.runtime.getURL("sl-preview.html"), "_blank");
    if (!w) {
      toast("The preview couldn't open a new tab — allow pop-ups for StyleLift and try again.", true);
      return;
    }
    // its fonts come embedded: a private origin can't load a font from the site's domain unless that
    // server allows it (fonts load with CORS); fetched once per Studio session
    let ready = false, page: string | null = null;
    const send = () => {
      if (ready && page !== null) w.postMessage({ type: "sl-preview", html: page }, "*");
    };
    const onReady = (e: MessageEvent) => {
      if (e.source !== w || !e.data || e.data.type !== "sl-preview-ready") return;
      removeEventListener("message", onReady);
      ready = true;
      send();
    };
    addEventListener("message", onReady);
    setTimeout(() => removeEventListener("message", onReady), 30000);
    Promise.race([inlineFontFaces(html, S.project?.url || location.href, previewFonts), new Promise<string>((r) => setTimeout(() => r(html), 5000))])
      .catch(() => html)
      .then((h) => {
        page = h;
        send();
      });
  }
  $<HTMLInputElement>("#anim-toggle").addEventListener("change", (e) => {
    S.animations = (e.target as HTMLInputElement).checked;
    if (S.animations) renderFrames(); // reload so entrance animations play from the start
    else applyAnimToggle();
  });
  $<HTMLInputElement>("#layer-search").addEventListener("input", (e) => {
    S.search = (e.target as HTMLInputElement).value;
    renderLayers();
  });
  const menu = $<HTMLDivElement>("#export-menu");
  const exportBtn = $<HTMLButtonElement>("#export-btn");
  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    exportBtn.setAttribute("aria-expanded", String(open));
  };
  exportBtn.addEventListener("click", () => setMenu(menu.hidden));
  menu.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      setMenu(false);
      exportAs(b.dataset.export || "next");
    }),
  );
  document.addEventListener("click", (e) => {
    if (!(e.target as Element).closest(".export")) setMenu(false);
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      wheelZoom(e.deltaY, e.clientX, e.clientY);
    },
    { passive: false },
  );
  const typingIn = (t: EventTarget | null) => /^(input|textarea|select)$/i.test((t as Element)?.localName || "") || !!(t as HTMLElement)?.isContentEditable;
  document.addEventListener("copy", (e) => {
    if (typingIn(e.target) || !S.sel || document.getSelection()?.toString()) return;
    const clip = copyLayer(S.sel, false, false);
    if (!clip) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", clip.text);
    e.clipboardData?.setData("text/html", clip.text);
  });
  document.addEventListener("cut", (e) => {
    if (typingIn(e.target) || !S.sel || document.getSelection()?.toString()) return;
    const clip = makeClip(S.sel);
    if (!clip) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", clip.text);
    e.clipboardData?.setData("text/html", clip.text);
    remove();
    toast(`Cut “${clip.name}”.`);
  });
  document.addEventListener("paste", (e) => {
    if (typingIn(e.target) || !S.doc) return;
    const html = e.clipboardData?.getData("text/html") || "";
    const text = e.clipboardData?.getData("text/plain") || "";
    const clip = readClip();
    e.preventDefault();
    // a picture on the clipboard (a screenshot, an image copied in another app)
    const img = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"));
    if (img && !(clip && text && text === clip.text)) {
      const at = pastePoint();
      if (at) readImage(img, (src, w, h) => placeImage(at.d, at.sc, at.x, at.y, src, w, h));
      return;
    }
    // our own copy (same text as we put on the clipboard) pastes with its styles; anything else from
    // another app arrives as clean HTML or as a text layer
    if (clip && (!text || text === clip.text)) pasteClip(clip, "after");
    else if (html) pasteExternal(html);
    else if (text.trim()) pasteExternal(text.trim(), true);
  });
  document.addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test((e.target as Element)?.localName || "");
    const mod = e.metaKey || e.ctrlKey;
    if (!typing && S.sel && !menuOpen()) {
      const id = S.sel, code = e.code, alt = e.altKey, shift = e.shiftKey;
      const act = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (!mod && !alt && code === "BracketRight") return act(() => arrange(id, "front"));
      if (!mod && !alt && code === "BracketLeft") return act(() => arrange(id, "back"));
      if (mod && !alt && code === "BracketRight") return act(() => arrange(id, "forward"));
      if (mod && !alt && code === "BracketLeft") return act(() => arrange(id, "backward"));
      if (mod && alt && !shift && code === "KeyG") return act(() => wrapSelection(true));
      if (mod && shift && !alt && code === "KeyG") return act(() => ungroupLayer(id));
      if (mod && !alt && !shift && code === "KeyG") return act(() => wrapSelection(false));
      // several selected: align (⌥ + W A S D / H V, like Figma) and space evenly (⌃⌥ H / V)
      if (isMulti() && alt && !mod && !shift && code === "KeyA") return act(() => alignSelection("left"));
      if (isMulti() && alt && !mod && !shift && code === "KeyD") return act(() => alignSelection("right"));
      if (isMulti() && alt && !mod && !shift && code === "KeyW") return act(() => alignSelection("top"));
      if (isMulti() && alt && !mod && !shift && code === "KeyS") return act(() => alignSelection("bottom"));
      if (isMulti() && alt && !mod && !shift && code === "KeyH") return act(() => alignSelection("hcenter"));
      if (isMulti() && alt && !mod && !shift && code === "KeyV") return act(() => alignSelection("vcenter"));
      if (isMulti() && alt && e.ctrlKey && !e.metaKey && code === "KeyH") return act(() => distributeSelection("x"));
      if (isMulti() && alt && e.ctrlKey && !e.metaKey && code === "KeyV") return act(() => distributeSelection("y"));
      if (mod && !alt && !shift && code === "Backspace") return act(() => ungroupLayer(id));
      if (!mod && shift && alt && code === "KeyA") return act(() => setAutoLayout(id, false));
      if (!mod && shift && !alt && code === "KeyA") return act(() => setAutoLayout(id, true));
      if (mod && shift && !alt && code === "KeyH") return act(() => toggleHiddenFor(id));
      if (mod && shift && !alt && code === "KeyL") return act(() => toggleLock(id));
      if (!mod && shift && !alt && code === "KeyH") return act(() => flip(id, "x"));
      if (!mod && shift && !alt && code === "KeyV") return act(() => flip(id, "y"));
      if (mod && alt && !shift && code === "KeyC") return act(() => copyStyle(id));
      if (mod && alt && !shift && code === "KeyV") return act(() => pasteStyle(id));
    }
    if (mod && e.key.toLowerCase() === "z") {
      if (typing) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === "d" && !typing) {
      e.preventDefault();
      duplicate();
    } else if ((e.key === "Backspace" || e.key === "Delete") && !typing && S.sel) {
      e.preventDefault();
      remove();
    } else if (e.key === "Escape" && !typing && (draw || tool !== "move")) {
      if (draw) finishDraw(draw.tool !== "pen" || draw.pts.length < 2);
      setTool("move");
    } else if (e.key === "Enter" && !typing && draw?.tool === "pen") finishDraw();
    else if (e.key === "Escape" && !typing) {
      if (isMulti()) select(S.sel, false); // several selected: back to one
      else selectParent();
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a" && !typing && S.doc) {
      e.preventDefault();
      selectSiblings();
    }
    else if (!typing && e.key === "?") showShortcuts();
    else if (!typing && !mod && !e.altKey && e.code === "Space") {
      e.preventDefault();
      if (!e.repeat && tool !== "hand") {
        spaceFrom = tool;
        setTool("hand");
      }
    } else if (!typing && !mod && !e.altKey && TOOL_KEYS[(e.shiftKey ? "⇧" : "") + e.code]) setTool(TOOL_KEYS[(e.shiftKey ? "⇧" : "") + e.code]);
    else if (!typing && !mod && !e.altKey && e.key.toLowerCase() === "g") {
      setTools({ grid: !UI.grid });
      if (!S.sel) renderProps();
    } else if (!typing && !mod && !e.altKey && e.key.toLowerCase() === "m") setTools({ mode: UI.mode === "free" ? "reorder" : "free" });
    else if (!typing && S.sel && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
      e.preventDefault();
      if (UI.mode === "free") {
        const n = e.shiftKey ? 10 : 1;
        nudge(e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) move(e.key === "ArrowUp" ? -1 : 1);
    }
  });
  window.addEventListener("resize", () => applyZoom());

  const id = new URLSearchParams(location.search).get("id");
  if (!id) return showHome();
  const p = await getProject(id);
  if (!p) {
    toast("That project no longer exists.", true);
    return showHome();
  }
  S.project = p;
  document.title = `${p.title || p.url} — StyleLift Studio`;
  $<HTMLSpanElement>("#project-title").textContent = p.title || p.url;
  let html = p.html, edits = p.edits || {};
  if (isSite()) {
    S.page = Math.min(p.page || 0, p.pageList!.length - 1);
    const d = await getPage(p.id, S.page);
    html = d?.html || "<!doctype html><html><body></body></html>";
    edits = d?.edits || {};
    $<HTMLElement>("#export-menu").classList.add("site");
  }
  const changed = openDoc(html, edits);
  renderPages();
  if (changed) scheduleSave();
  else setSaveState("saved");
  // test hook
  (window as unknown as { __studio: unknown }).__studio = { S, select, setStyle, setScope, setText, duplicate, remove, undo, redo, exportAs, openPage, moveTo, setArtboardSize, fitHeight, sizeOf, setTools, UI, setTool, insertWidget, WIDGETS, arrange, wrapLayer, ungroupLayer, flip, toggleLock, copyLayer, pasteClip, readClip, setMotion, playMotion, motionOf, placeImage, selection, selectMany, toggleSelect, alignSelection, distributeSelection, wrapSelection };
}
/** Show a document on the canvas (the project's page, or one page of a site). True if ids were added. */
function openDoc(html: string, edits: StyleEdits): boolean {
  pageColors = null;
  S.doc = new DOMParser().parseFromString(html, "text/html");
  assignIds(S.doc);
  S.edits = edits;
  S.html = serialize(S.doc);
  S.sel = null;
  S.expanded.clear();
  // expand the first two levels so the structure is visible straight away
  layerChildren(S.doc.body).forEach((el) => {
    S.expanded.add(el.getAttribute(ID_ATTR)!);
    layerChildren(el).forEach((k) => S.expanded.add(k.getAttribute(ID_ATTR)!));
  });
  renderFrames();
  renderLayers();
  renderProps();
  syncUndo();
  requestAnimationFrame(fitZoom);
  return S.html !== html;
}

// ── pages (a whole-site project) ──────────────────────────────────────────────
/** Switch to another page of the site: the open one is saved first, each page keeps its own undo. */
async function openPage(i: number): Promise<void> {
  if (!S.project?.pageList || i === S.page || i < 0 || i >= S.project.pageList.length) return;
  await saveNow();
  S.pageHistory.set(S.page, { history: S.history, future: S.future });
  const d = await getPage(S.project.id, i);
  S.page = i;
  const h = S.pageHistory.get(i);
  S.history = h?.history || [];
  S.future = h?.future || [];
  const changed = openDoc(d?.html || "<!doctype html><html><body></body></html>", d?.edits || {});
  renderPages();
  if (changed) scheduleSave();
  else void saveNow(); // remember which page is open
}
function renderPages(): void {
  const box = $<HTMLDivElement>("#pages-panel");
  const list = S.project?.pageList;
  box.hidden = !list?.length;
  if (!list?.length) return;
  $<HTMLSpanElement>("#page-count").textContent = String(list.length);
  const rows = $<HTMLDivElement>("#pages");
  rows.replaceChildren(
    ...list.map((pg, i) => {
      const r = document.createElement("button");
      r.type = "button";
      r.className = "page-row" + (i === S.page ? " selected" : "");
      r.setAttribute("aria-current", String(i === S.page));
      let path = "/";
      try {
        path = new URL(pg.url).pathname;
      } catch {
        /* keep "/" */
      }
      r.innerHTML = icon(i === 0 ? "globe" : "file", 14);
      const t = document.createElement("span");
      t.className = "nm";
      t.textContent = pg.title || path;
      const pth = document.createElement("small");
      pth.textContent = path;
      r.append(t, pth);
      r.dataset.tip = pg.url;
      r.addEventListener("click", () => void openPage(i));
      return r;
    }),
  );
}
boot();
