// In-page visual editor (Elementor-style). Injected via executeScript({ func }).
// Self-contained: all helpers nested, references only page globals + the `chrome`
// APIs available to injected scripts (chrome.storage). It paints its own UI inside
// a shadow root, lets the user click any element, edit text inline, and
// move/duplicate/delete it — persisting everything to chrome.storage so the
// background worker can replay it on reload.
//
// It also exposes window.__slEditor with a programmatic API used by the tests.

export function injectVisualEditor(): boolean {
  const w = window as unknown as {
    __slEditor?: { stop?: () => void } & Record<string, unknown>;
    __slEditorActive?: boolean;
  };
  // tear down any prior instance (incl. one from an older build) so there's never
  // more than one toolbar / set of listeners attached
  try {
    w.__slEditor?.stop?.();
  } catch {
    /* ignore */
  }
  document.querySelectorAll("#__sl_editor_host").forEach((n) => n.remove());
  w.__slEditorActive = true;

  const OVK = "stylelift:overrides";
  const STK = "stylelift:structops";
  const origin = location.origin;

  // ── selector + label ──────────────────────────────────────────────────────
  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const cls = (node.getAttribute("class") || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => "." + CSS.escape(c))
        .join("");
      part += cls;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  function label(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return el.id ? `${tag}#${el.id}` : cls.length ? `${tag}.${cls.join(".")}` : tag;
  }
  function colorToHex(input: string): string {
    const s = (input || "").trim().toLowerCase();
    if (s[0] === "#") return s.length === 4 ? "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s.slice(0, 7);
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return "#000000";
    const p = m[1].split(/[,/\s]+/).filter(Boolean);
    const h = (n: string) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, "0");
    return p.length >= 3 ? "#" + h(p[0]) + h(p[1]) + h(p[2]) : "#000000";
  }

  // ── storage ───────────────────────────────────────────────────────────────
  interface Edit {
    props: Record<string, string>;
    states?: Record<string, Record<string, string>>;
    responsive?: Record<string, Record<string, string>>;
    html?: string;
    css?: string;
    attrs?: Record<string, string>;
    label?: string;
  }
  const BP: Record<string, number> = { tablet: 1024, mobile: 640 };
  interface Op {
    selector: string;
    op: string;
    label?: string;
    html?: string;
    position?: string;
    targetSelector?: string;
  }
  let overrides: Record<string, Edit> = {};
  let structOps: Op[] = [];
  const store = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) || null;
  function load(cb?: () => void): void {
    if (!store) {
      cb && cb();
      return;
    }
    store.get([OVK, STK], (d) => {
      overrides = (d[OVK] || {})[origin] || {};
      structOps = (d[STK] || {})[origin] || [];
      cb && cb();
    });
  }
  function save(): void {
    if (!store) return; // not in an extension context (e.g. test harness)
    store.get([OVK, STK], (d) => {
      const o = d[OVK] || {};
      const s = d[STK] || {};
      if (Object.keys(overrides).length) o[origin] = overrides;
      else delete o[origin];
      if (structOps.length) s[origin] = structOps;
      else delete s[origin];
      store.set({ [OVK]: o, [STK]: s });
    });
  }
  function editFor(sel: string, el: Element): Edit {
    if (!overrides[sel]) overrides[sel] = { props: {}, label: label(el) };
    return overrides[sel];
  }

  // ── undo / redo history ────────────────────────────────────────────────────
  type HEntry = { undo: () => void; redo: () => void };
  const undoStack: HEntry[] = [];
  const redoStack: HEntry[] = [];
  const HISTORY_MAX = 120;
  let matchClipboard: Record<string, string> | null = null; // for "match style"
  // element ref-map for the Layers panel + breadcrumb (robust across overlays/shadow)
  const refMap = new Map<string, Element>();
  let refN = 0;
  const refFor = (el: Element) => {
    const r = "r" + ++refN;
    refMap.set(r, el);
    return r;
  };
  function childrenOf(root: Element | null): { ref: string; label: string; tag: string; hasChildren: boolean }[] {
    if (!root) return [];
    const list: Element[] = [];
    if ((root as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
      list.push(...Array.from((root as Element & { shadowRoot: ShadowRoot }).shadowRoot.children));
    }
    list.push(...Array.from(root.children));
    return list
      .filter((c) => c.id !== "__sl_editor_host")
      .map((c) => ({
        ref: refFor(c),
        label: label(c),
        tag: c.tagName.toLowerCase(),
        hasChildren: c.children.length > 0 || !!(c as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot,
      }));
  }
  // original DOM values captured the first time we touch an attr/innerHTML, so undo
  // can restore the page's true initial state.
  const originals: Record<string, { attrs?: Record<string, string | null>; html?: string }> = {};
  const clone = (o: unknown) => JSON.parse(JSON.stringify(o));
  function pushHist(e: HEntry): void {
    undoStack.push(e);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
    emitHistory();
  }
  function emitHistory(): void {
    try {
      chrome.runtime?.sendMessage?.({
        type: "SL_HISTORY",
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      });
    } catch {
      /* not in extension context */
    }
  }
  // Re-derive the whole page from `overrides` (+ captured originals) — used by undo/redo.
  function applyAll(): void {
    rebuildCss();
    const sels = new Set([...Object.keys(overrides), ...Object.keys(originals)]);
    for (const sel of sels) {
      const e = overrides[sel];
      const orig = originals[sel] || {};
      let el: Element | null = null;
      try {
        el = document.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;
      if (orig.attrs) {
        for (const name of Object.keys(orig.attrs)) {
          const val = e?.attrs?.[name];
          if (val == null) {
            if (orig.attrs[name] == null) el.removeAttribute(name);
            else el.setAttribute(name, orig.attrs[name] as string);
          } else {
            if (name === "src" && el.tagName === "IMG") el.removeAttribute("srcset");
            el.setAttribute(name, val);
          }
        }
      }
      if ("html" in orig) el.innerHTML = e?.html ?? orig.html ?? el.innerHTML;
    }
    save();
  }
  function recordOverrideChange(before: Record<string, Edit>): void {
    const b = clone(before);
    const a = clone(overrides);
    pushHist({
      undo: () => {
        overrides = clone(b);
        applyAll();
        if (selected) emitSelect(selected);
      },
      redo: () => {
        overrides = clone(a);
        applyAll();
        if (selected) emitSelect(selected);
      },
    });
  }
  function undo(): void {
    const e = undoStack.pop();
    if (!e) return;
    e.undo();
    redoStack.push(e);
    emitHistory();
  }
  function redo(): void {
    const e = redoStack.pop();
    if (!e) return;
    e.redo();
    undoStack.push(e);
    emitHistory();
  }

  // ── inline SVG icons (no emojis) ──────────────────────────────────────────
  const ICONS: Record<string, string> = {
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    up: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14"/><path d="M5 12l7 7 7-7"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
    brush: '<path d="M9.5 14.5L3 21"/><path d="M14 4l6 6-7 7-6-6z"/>',
  };
  const ic = (name: string) =>
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

  // ── UI (shadow root, immune to page CSS) ──────────────────────────────────
  const host = document.createElement("div");
  host.id = "__sl_editor_host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .hl { position: fixed; pointer-events: none; z-index: 2147483646; border-radius: 3px; transition: all .04s ease; }
      .hover { border: 1px dashed #9a9aa0; background: rgba(255,255,255,.07); }
      .sel { border: 2px solid #f1f1f3; background: rgba(255,255,255,.10); }
      .bar { position: fixed; top: 0; left: 0; right: 0; height: 34px; z-index: 2147483647;
        background: #11151d; color: #e6e8ec; display: flex; align-items: center; gap: 10px;
        padding: 0 12px; font: 600 12px/1 -apple-system, system-ui, sans-serif;
        border-bottom: 1px solid #2a2f3a; }
      .bar .dot { color: #f1f1f3; }
      .bar .spacer { flex: 1; }
      .bar button { font: 600 11px/1 system-ui; border: 1px solid #2a2f3a; background: #1d212b;
        color: #e6e8ec; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
      .bar button.stop { background: #f1f1f3; color: #18181a; border: none; }
      .toolbar { position: fixed; z-index: 2147483647; display: none; gap: 4px; align-items: center;
        background: #171a21; border: 1px solid #2a2f3a; border-radius: 8px; padding: 5px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45); font: 500 11px/1 system-ui; }
      .toolbar.show { display: flex; }
      .toolbar button { border: none; background: #1d212b; color: #e6e8ec; padding: 6px 8px;
        border-radius: 6px; cursor: pointer; font: 600 12px/1 system-ui;
        display: inline-flex; align-items: center; gap: 4px; }
      .bar .dot svg { vertical-align: middle; }
      .toolbar button:hover { background: #2a2f3a; }
      .toolbar button.danger { color: #e5687a; }
      .toolbar .tag { color: #9aa1ad; font-family: ui-monospace, Menlo, monospace; padding: 0 6px;
        max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .toolbar input[type=color] { width: 24px; height: 24px; border: 1px solid #2a2f3a;
        border-radius: 5px; background: #1d212b; padding: 0; cursor: pointer; }
      .toolbar input[type=number] { width: 52px; background: #1d212b; border: 1px solid #2a2f3a;
        color: #e6e8ec; border-radius: 5px; padding: 4px; font: 500 11px/1 system-ui; }
      .sep { width: 1px; height: 18px; background: #2a2f3a; margin: 0 2px; }
      .ctxmenu { position: fixed; z-index: 2147483647; display: none; min-width: 150px;
        background: #1b1b1d; border: 1px solid #353539; border-radius: 8px; padding: 4px;
        box-shadow: 0 10px 30px rgba(0,0,0,.5); font: 500 12px/1 system-ui; }
      .ctxmenu button { display: block; width: 100%; text-align: left; border: none;
        background: transparent; color: #f1f1f3; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
      .ctxmenu button:hover { background: #242427; }
      .ctxmenu button.danger { color: #d98c8c; }
    </style>
    <div class="hl hover" id="hover"></div>
    <div class="hl sel" id="sel"></div>
    <div class="bar">
      <span class="dot">${ic("brush")}</span> StyleLift Visual Editor
      <span class="tag" id="seltag"></span>
      <span class="spacer"></span>
      <button id="undo" title="Reload to discard structural changes">Discard</button>
      <button class="stop" id="done">Done</button>
    </div>
    <div class="toolbar" id="toolbar">
      <span class="tag" id="ttag"></span>
      <button id="b-text" title="Edit text inline">${ic("edit")}</button>
      <span class="sep"></span>
      <input type="color" id="b-fg" title="Text color" />
      <input type="color" id="b-bg" title="Background color" />
      <input type="number" id="b-size" title="Font size (px)" min="6" max="200" />
      <span class="sep"></span>
      <button id="b-up" title="Move up">${ic("up")}</button>
      <button id="b-down" title="Move down">${ic("down")}</button>
      <button id="b-drag" title="Drag to reorder">${ic("grip")}</button>
      <button id="b-dup" title="Duplicate">${ic("copy")}</button>
      <button id="b-del" class="danger" title="Delete">${ic("trash")}</button>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (id: string) => root.getElementById(id) as HTMLElement;
  const hoverBox = $("hover");
  const selBox = $("sel");
  const toolbar = $("toolbar");
  const seltag = $("seltag");
  const ttag = $("ttag");
  const fg = $("b-fg") as HTMLInputElement;
  const bg = $("b-bg") as HTMLInputElement;
  const sizeInp = $("b-size") as HTMLInputElement;
  // nudge the page down so the top bar doesn't cover content
  const prevPadTop = document.documentElement.style.paddingTop;
  document.documentElement.style.paddingTop = "34px";

  let selected: HTMLElement | null = null;
  let editing = false;

  const r = (el: Element) => el.getBoundingClientRect();
  function setBox(box: HTMLElement, el: Element | null): void {
    if (!el) {
      box.style.display = "none";
      return;
    }
    const b = r(el);
    Object.assign(box.style, {
      display: "block",
      top: b.top + "px",
      left: b.left + "px",
      width: b.width + "px",
      height: b.height + "px",
    });
  }
  function positionToolbar(): void {
    if (!selected) {
      toolbar.classList.remove("show");
      return;
    }
    setBox(selBox, selected);
    const b = r(selected);
    toolbar.classList.add("show");
    const tb = toolbar.getBoundingClientRect();
    let top = b.top - tb.height - 8;
    if (top < 40) top = b.bottom + 8;
    toolbar.style.top = Math.max(40, top) + "px";
    toolbar.style.left = Math.max(6, Math.min(b.left, window.innerWidth - tb.width - 6)) + "px";
  }

  const PROPS = [
    "color", "background-color", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "text-transform", "font-family", "padding", "margin", "border-radius",
    "border-width", "border-style", "border-color", "box-shadow", "opacity", "display",
    "flex-direction", "justify-content", "align-items", "gap", "width", "height", "z-index",
  ];
  const ATTR_KEYS = ["src", "alt", "href", "target", "poster", "title", "rel"];
  function emitSelect(el: HTMLElement): void {
    const cs = getComputedStyle(el);
    const values: Record<string, string> = {};
    for (const p of PROPS) values[p] = cs.getPropertyValue(p).trim();
    const attrs: Record<string, string> = {};
    for (const k of ATTR_KEYS) {
      const v = el.getAttribute(k);
      if (v != null) attrs[k] = v;
    }
    if (el.tagName === "IMG") attrs.src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || attrs.src || "";
    const bg = cs.backgroundImage;
    // ancestor chain (crosses shadow boundaries) for the breadcrumb
    const ancestors: { ref: string; label: string; tag: string }[] = [];
    let p: Element | null = el;
    let d = 0;
    while (p && p.nodeType === 1 && d < 12) {
      ancestors.unshift({ ref: refFor(p), label: label(p), tag: p.tagName.toLowerCase() });
      if (p === document.body) break;
      const rootNode: Node | null = p.getRootNode ? p.getRootNode() : null;
      p = p.parentElement || (rootNode instanceof ShadowRoot ? rootNode.host : null);
      d++;
    }
    try {
      chrome.runtime?.sendMessage?.({
        type: "SL_SELECT",
        selector: cssPath(el),
        label: label(el),
        tag: el.tagName.toLowerCase(),
        ancestors,
        values,
        attrs,
        bg: bg && bg !== "none" ? bg : "",
        // boolean media attributes (present or not)
        media:
          el.tagName === "VIDEO"
            ? {
                loop: el.hasAttribute("loop"),
                muted: el.hasAttribute("muted"),
                autoplay: el.hasAttribute("autoplay"),
                controls: el.hasAttribute("controls"),
              }
            : null,
        canText: el.children.length === 0,
        text: el.children.length === 0 ? el.textContent || "" : "",
      });
    } catch {
      /* not in extension context */
    }
  }
  function applyAttr(sel: string, name: string, value: string | null): void {
    const before = clone(overrides);
    const el = document.querySelector(sel);
    // capture the original attribute value once, so undo can restore it
    if (el) {
      const o = (originals[sel] ||= {});
      o.attrs ||= {};
      if (!(name in o.attrs)) o.attrs[name] = el.getAttribute(name);
    }
    const e = editFor(sel, el || selected || document.body);
    if (!e.attrs) e.attrs = {};
    if (value == null) {
      delete e.attrs[name];
      if (el) el.removeAttribute(name);
    } else {
      e.attrs[name] = value;
      if (el) {
        if (name === "src" && el.tagName === "IMG") el.removeAttribute("srcset");
        el.setAttribute(name, value);
      }
    }
    save();
    recordOverrideChange(before);
    if (selected && cssPath(selected) === sel) emitSelect(selected);
  }
  function select(el: HTMLElement): void {
    if (editing) commitText();
    selected = el;
    seltag.textContent = label(el);
    ttag.textContent = label(el);
    const cs = getComputedStyle(el);
    fg.value = colorToHex(cs.color);
    bg.value = colorToHex(cs.backgroundColor);
    sizeInp.value = String(Math.round(parseFloat(cs.fontSize)) || "");
    positionToolbar();
    emitSelect(el);
  }

  // ── operations ──────────────────────────────────────────────────────────────
  // Robust override stylesheet rebuilt from `overrides` — survives re-renders and
  // wins via !important, instead of fragile inline styles.
  function rebuildCss(): void {
    let css = "";
    const media: Record<string, string[]> = {};
    const decl = (props: Record<string, string>) =>
      Object.entries(props || {})
        .filter(([, v]) => v)
        .map(([p, v]) => `${p}: ${v} !important`);
    for (const [sel, e] of Object.entries(overrides)) {
      const base = decl(e.props || {});
      if (e.css && e.css.trim()) base.push(e.css.trim());
      if (base.length) css += `${sel} { ${base.join("; ")} }\n`;
      for (const [st, props] of Object.entries(e.states || {})) {
        const d = decl(props);
        if (d.length) css += `${sel}:${st} { ${d.join("; ")} }\n`;
      }
      for (const [bp, props] of Object.entries(e.responsive || {})) {
        const d = decl(props);
        if (d.length) (media[bp] = media[bp] || []).push(`${sel} { ${d.join("; ")} }`);
      }
    }
    for (const [bp, rules] of Object.entries(media)) {
      if (BP[bp] && rules.length) css += `@media (max-width:${BP[bp]}px){ ${rules.join(" ")} }\n`;
    }
    let tag = document.getElementById("__sl_editor_css") as HTMLStyleElement | null;
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "__sl_editor_css";
      (document.head || document.documentElement).appendChild(tag);
    }
    tag.textContent = css;
  }
  // scope: "base" | "hover"/"focus" | "tablet"/"mobile"
  function bucket(e: Edit, scope: string): Record<string, string> {
    if (scope === "hover" || scope === "focus") return (e.states ||= {})[scope] ||= {};
    if (scope === "tablet" || scope === "mobile") return (e.responsive ||= {})[scope] ||= {};
    return e.props;
  }
  function applyProp(sel: string, prop: string, value: string, scope = "base"): void {
    const before = clone(overrides);
    const el = document.querySelector(sel);
    const e = editFor(sel, el || selected || document.body);
    const b = bucket(e, scope);
    if (value === "" || value == null) delete b[prop];
    else b[prop] = value;
    rebuildCss();
    save();
    recordOverrideChange(before);
    if (selected && cssPath(selected) === sel) emitSelect(selected);
  }
  function quickStyle(prop: string, value: string): void {
    if (!selected) return;
    applyProp(cssPath(selected), prop, value);
  }
  function startTextEdit(): void {
    if (!selected) return;
    editing = true;
    selected.setAttribute("contenteditable", "true");
    (selected as HTMLElement).focus();
    // scope the selection to THIS element's contents (never selectAll the document)
    try {
      const range = document.createRange();
      range.selectNodeContents(selected);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* selection not supported here */
    }
  }
  function commitText(): void {
    if (!selected || !editing) return;
    editing = false;
    selected.removeAttribute("contenteditable");
    const sel = cssPath(selected);
    const before = clone(overrides);
    const o = (originals[sel] ||= {});
    if (!("html" in o)) o.html = selected.innerHTML; // not strictly original but pre-commit
    editFor(sel, selected).html = selected.innerHTML;
    save();
    recordOverrideChange(before);
  }
  function duplicate(): void {
    if (!selected || !selected.parentNode) return;
    const sel = cssPath(selected);
    const cloneNode = selected.cloneNode(true) as HTMLElement;
    const parent = selected.parentNode;
    parent.insertBefore(cloneNode, selected.nextSibling);
    structOps.push({ selector: sel, op: "duplicate", label: label(selected) });
    save();
    pushHist({
      undo: () => {
        cloneNode.remove();
        structOps.pop();
        save();
      },
      redo: () => {
        parent.insertBefore(cloneNode, null);
        save();
      },
    });
  }
  function move(dir: "up" | "down"): void {
    if (!selected || !selected.parentNode) return;
    const sel = cssPath(selected);
    const el = selected;
    const parent = el.parentNode as Node & ParentNode;
    const anchor = el.nextSibling; // remember position to undo
    if (dir === "up") {
      const prev = el.previousElementSibling;
      if (!prev) return;
      parent.insertBefore(el, prev);
      structOps.push({ selector: sel, op: "moveUp", label: label(el) });
    } else {
      const next = el.nextElementSibling;
      if (!next) return;
      parent.insertBefore(next, el);
      structOps.push({ selector: sel, op: "moveDown", label: label(el) });
    }
    save();
    positionToolbar();
    pushHist({
      undo: () => {
        parent.insertBefore(el, anchor);
        structOps.pop();
        save();
        positionToolbar();
      },
      redo: () => {
        if (dir === "up") {
          const p = el.previousElementSibling;
          if (p) parent.insertBefore(el, p);
        } else {
          const n = el.nextElementSibling;
          if (n) parent.insertBefore(n, el);
        }
        save();
      },
    });
  }
  function remove(): void {
    if (!selected) return;
    const sel = cssPath(selected);
    const el = selected;
    const parent = el.parentNode!;
    const anchor = el.nextSibling;
    structOps.push({ selector: sel, op: "delete", label: label(el) });
    el.remove();
    selected = null;
    setBox(selBox, null);
    toolbar.classList.remove("show");
    save();
    pushHist({
      undo: () => {
        parent.insertBefore(el, anchor);
        structOps.pop();
        save();
      },
      redo: () => {
        el.remove();
        save();
      },
    });
  }
  // move the selected element to just before a target element (drag-to-reorder)
  function moveBefore(targetSel: string): void {
    if (!selected) return;
    let target: Element | null = null;
    try {
      target = document.querySelector(targetSel);
    } catch {
      return;
    }
    if (!target || !target.parentNode || target === selected || selected.contains(target)) return;
    const el = selected;
    const parent = el.parentNode as Node & ParentNode;
    const anchor = el.nextSibling;
    const sel = cssPath(el);
    target.parentNode.insertBefore(el, target);
    structOps.push({ selector: sel, op: "moveBefore", targetSelector: targetSel, label: label(el) });
    save();
    positionToolbar();
    pushHist({
      undo: () => {
        parent.insertBefore(el, anchor);
        structOps.pop();
        save();
        positionToolbar();
      },
      redo: () => {
        const t = document.querySelector(targetSel);
        if (t && t.parentNode) t.parentNode.insertBefore(el, t);
        save();
      },
    });
  }

  // ── insert a new widget ───────────────────────────────────────────────────
  const WIDGETS: Record<string, string> = {
    heading: "<h2>New heading</h2>",
    text: "<p>New text block. Double-click to edit.</p>",
    button: '<a href="#" style="display:inline-block;padding:10px 18px;background:#1f1f22;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Button</a>',
    image: '<img src="https://placehold.co/600x300/png" alt="placeholder" style="max-width:100%" />',
    spacer: '<div style="height:48px"></div>',
    divider: '<hr style="border:none;border-top:1px solid currentColor;opacity:.3;margin:16px 0" />',
    container: '<div style="padding:24px;border:1px dashed #9a9aa0;min-height:60px"></div>',
  };
  function insertWidget(kind: string): void {
    const html = WIDGETS[kind];
    if (!html) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = html.trim();
    const node = tmp.firstElementChild as HTMLElement | null;
    if (!node) return;
    let parent: Node;
    let anchor: Node | null;
    if (selected && selected.parentNode) {
      parent = selected.parentNode;
      anchor = selected.nextSibling;
    } else {
      parent = document.body;
      anchor = null;
    }
    parent.insertBefore(node, anchor);
    structOps.push({ selector: selected ? cssPath(selected) : "body", op: "insert", label: kind, html, position: selected ? "after" : "append" });
    save();
    pushHist({
      undo: () => {
        node.remove();
        structOps.pop();
        save();
      },
      redo: () => {
        parent.insertBefore(node, anchor);
        save();
      },
    });
    select(node);
  }
  function copyStyle(): void {
    if (selected) matchClipboard = clone(editFor(cssPath(selected), selected).props || {});
  }
  function pasteStyle(): void {
    if (!selected || !matchClipboard) return;
    const before = clone(overrides);
    const e = editFor(cssPath(selected), selected);
    e.props = { ...e.props, ...matchClipboard };
    rebuildCss();
    save();
    recordOverrideChange(before);
    emitSelect(selected);
  }
  function stop(): void {
    if (editing) commitText();
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("dblclick", onDblClick, true);
    document.removeEventListener("contextmenu", onContext, true);
    document.removeEventListener("scroll", hideMenu, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition, true);
    host.remove();
    document.documentElement.style.paddingTop = prevPadTop;
    w.__slEditorActive = false;
    w.__slEditor = undefined;
  }

  // ── events ────────────────────────────────────────────────────────────────
  const inOwnUi = (e: Event) => e.composedPath().includes(host);
  // composedPath()[0] is the true deepest target — pierces shadow DOM, unlike
  // e.target which the browser retargets to the shadow host.
  const deepTarget = (e: Event): HTMLElement | null =>
    (e.composedPath()[0] as HTMLElement) || (e.target as HTMLElement) || null;
  function onOver(e: MouseEvent): void {
    if (inOwnUi(e)) return;
    const t = deepTarget(e);
    if (!t || t === document.documentElement || t === document.body) {
      setBox(hoverBox, null);
      return;
    }
    setBox(hoverBox, t);
  }
  function onClick(e: MouseEvent): void {
    if (inOwnUi(e)) return; // clicks on the toolbar are handled by their own listeners
    hideMenu();
    if (editing) return; // let clicks place the caret while editing text
    e.preventDefault();
    e.stopPropagation();
    const t = deepTarget(e);
    if (t && t !== document.documentElement && t !== document.body) select(t);
  }
  // double-click → edit the text inline right away
  function onDblClick(e: MouseEvent): void {
    if (inOwnUi(e)) return;
    const t = deepTarget(e);
    if (!t || t === document.documentElement || t === document.body) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected !== t) select(t);
    startTextEdit();
  }
  function reposition(): void {
    if (selected) positionToolbar();
  }

  // stop the browser from starting a text selection when you click to select
  function onDown(e: MouseEvent): void {
    if (editing || inOwnUi(e)) return;
    e.preventDefault();
  }

  // ── right-click context menu ───────────────────────────────────────────────
  const ctxmenu = document.createElement("div");
  ctxmenu.className = "ctxmenu";
  root.appendChild(ctxmenu);
  const hideMenu = () => (ctxmenu.style.display = "none");
  function onContext(e: MouseEvent): void {
    if (inOwnUi(e)) return;
    e.preventDefault();
    const t = deepTarget(e);
    if (!t || t === document.documentElement || t === document.body) return;
    if (selected !== t) select(t);
    const items: [string, () => void][] = [
      ["Edit text", startTextEdit],
      ["Duplicate", duplicate],
      ["Move up", () => move("up")],
      ["Move down", () => move("down")],
      ["Copy style", copyStyle],
      ["Paste style", pasteStyle],
      ["Delete", remove],
    ];
    ctxmenu.innerHTML = "";
    for (const [label, fn] of items) {
      const b = document.createElement("button");
      b.textContent = label;
      if (label === "Delete") b.className = "danger";
      b.addEventListener("click", () => {
        hideMenu();
        fn();
      });
      ctxmenu.appendChild(b);
    }
    ctxmenu.style.display = "block";
    ctxmenu.style.left = Math.min(e.clientX, window.innerWidth - 170) + "px";
    ctxmenu.style.top = Math.min(e.clientY, window.innerHeight - 240) + "px";
  }

  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDblClick, true);
  document.addEventListener("contextmenu", onContext, true);
  document.addEventListener("scroll", hideMenu, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition, true);

  // commands from the side-panel property editor
  function structOpOn(sel: string, op: string): void {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    if (selected !== el) select(el);
    if (op === "duplicate") duplicate();
    else if (op === "moveUp") move("up");
    else if (op === "moveDown") move("down");
    else if (op === "delete") remove();
  }
  try {
    chrome.runtime?.onMessage?.addListener(
      (msg: { type?: string; [k: string]: unknown }, _s: unknown, respond: (r: unknown) => void) => {
        if (!msg) return;
        if (msg.type === "SL_APPLY_PROP") applyProp(msg.selector as string, msg.prop as string, msg.value as string, (msg.scope as string) || "base");
        else if (msg.type === "SL_APPLY_ATTR") applyAttr(msg.selector as string, msg.name as string, (msg.value as string) ?? null);
        else if (msg.type === "SL_APPLY_CSS") {
          editFor(msg.selector as string, document.querySelector(msg.selector as string) || document.body).css = msg.css as string;
          rebuildCss();
          save();
        } else if (msg.type === "SL_SET_TEXT") {
          const el = document.querySelector(msg.selector as string);
          if (el) {
            const before = clone(overrides);
            const o = (originals[msg.selector as string] ||= {});
            if (!("html" in o)) o.html = el.innerHTML;
            el.innerHTML = msg.value as string;
            editFor(msg.selector as string, el).html = msg.value as string;
            save();
            recordOverrideChange(before);
          }
        } else if (msg.type === "SL_STRUCT") structOpOn(msg.selector as string, msg.op as string);
        else if (msg.type === "SL_INSERT") insertWidget(msg.kind as string);
        else if (msg.type === "SL_UNDO") undo();
        else if (msg.type === "SL_REDO") redo();
        else if (msg.type === "SL_MATCH_COPY") {
          copyStyle();
          respond?.({ ok: !!matchClipboard });
          return true;
        } else if (msg.type === "SL_MATCH_PASTE") {
          pasteStyle();
        } else if (msg.type === "SL_SELECT_BY") {
          const el = refMap.get(msg.ref as string);
          if (el) {
            (el as HTMLElement).scrollIntoView?.({ block: "center", behavior: "auto" });
            select(el as HTMLElement);
          }
        } else if (msg.type === "SL_HILITE") {
          const el = msg.ref ? refMap.get(msg.ref as string) : null;
          setBox(hoverBox, (el as HTMLElement) || null);
        } else if (msg.type === "SL_GET_CHILDREN") {
          const root = msg.ref ? refMap.get(msg.ref as string) || null : document.body;
          respond?.({ children: childrenOf(root) });
          return true;
        } else if (msg.type === "SL_GET_HTML") {
          const el = msg.selector ? document.querySelector(msg.selector as string) : document.body;
          respond?.({ html: el ? el.outerHTML : "" });
          return true;
        }
      },
    );
  } catch {
    /* not in extension context */
  }

  // toolbar wiring
  $("b-text").addEventListener("click", startTextEdit);
  $("b-up").addEventListener("click", () => move("up"));
  $("b-down").addEventListener("click", () => move("down"));
  $("b-dup").addEventListener("click", duplicate);
  $("b-del").addEventListener("click", remove);
  // drag-to-reorder: hold the ⠿ handle and release over the target element
  let dragging = false;
  $("b-drag").addEventListener("mousedown", (e) => {
    if (!selected) return;
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "grabbing";
  });
  document.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      if (!dragging) return;
      const t = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (t && !inOwnUi(e) && t !== selected) setBox(hoverBox, t);
    },
    true,
  );
  document.addEventListener(
    "mouseup",
    (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "crosshair";
      setBox(hoverBox, null);
      const t = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (t && t !== selected && t !== document.body && t !== document.documentElement && !inOwnUi(e)) {
        moveBefore(cssPath(t));
      }
    },
    true,
  );
  fg.addEventListener("input", () => quickStyle("color", fg.value));
  bg.addEventListener("input", () => quickStyle("background-color", bg.value));
  sizeInp.addEventListener("change", () => sizeInp.value && quickStyle("font-size", sizeInp.value + "px"));
  $("done").addEventListener("click", stop);
  $("undo").addEventListener("click", () => location.reload());
  // commit inline text when focus leaves the edited element
  document.addEventListener(
    "focusout",
    () => {
      if (editing) commitText();
    },
    true,
  );
  // keyboard: Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redo — unless editing text
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (editing) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    },
    true,
  );

  // expose a programmatic API (used by the UI above + automated tests)
  w.__slEditor = {
    selectBySelector: (s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (el) select(el);
      return !!el;
    },
    hasSelection: () => !!selected,
    selectedLabel: () => (selected ? label(selected) : ""),
    applyAttr: (name: string, value: string | null) => {
      if (selected) applyAttr(cssPath(selected), name, value);
    },
    applyProp,
    insertWidget,
    moveBefore,
    // layers navigator primitives (also used by the side panel via messages)
    getChildren: (ref?: string) => childrenOf(ref ? refMap.get(ref) || null : document.body),
    selectByRef: (ref: string) => {
      const el = refMap.get(ref);
      if (el) select(el as HTMLElement);
      return !!el;
    },
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    setText: (htmlValue: string) => {
      if (!selected) return false;
      selected.innerHTML = htmlValue;
      const sel = cssPath(selected);
      editFor(sel, selected).html = htmlValue;
      save();
      return true;
    },
    quickStyle,
    duplicate,
    move,
    remove,
    stop,
    state: () => ({ overrides, structOps }),
  };

  load(() => rebuildCss());
  return true;
}

export function stopVisualEditor(): boolean {
  const w = window as unknown as { __slEditor?: { stop?: () => void } };
  w.__slEditor?.stop?.();
  return true;
}
