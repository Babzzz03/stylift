// Responsive layouts that only exist after JavaScript runs at a given width.
//
// Framer server-renders one copy of a section per breakpoint (.ssr-variant, hidden
// with hidden-<hash> classes outside its range) — but often only the copies needed
// for the width the page was first loaded at. A desktop capture then has no tablet
// or phone layout at all, and those artboards/exports render blank.
//
// mergeVariantCaptures() takes the desktop capture plus captures made at tablet and
// phone widths and adds every missing variant (and the CSS only it uses) to the
// desktop document. unhideLoneVariants() is the fallback for whatever is still
// missing: a variant with no sibling alternatives is shown at every width instead
// of leaving that width empty.

const sigOf = (el: Element) =>
  Array.from(el.classList)
    .filter((c) => c.startsWith("hidden-"))
    .sort()
    .join(" ");
/** A stable address for a variant group: the parent's identity + nearest named ancestors. */
function slotKey(parent: Element): string {
  const parts: string[] = [];
  for (let a: Element | null = parent, i = 0; a && i < 6; a = a.parentElement, i++) {
    const name = a.getAttribute("data-framer-name") || a.id || "";
    // Framer swaps per-width variant classes (framer-v-…) on the same element, so
    // they must not be part of the address; component container classes are stable
    const cls = Array.from(a.classList)
      .filter((c) => !c.startsWith("hidden-") && c !== "ssr-variant" && !/^framer-v-/.test(c))
      .slice(0, 2)
      .join(".");
    parts.push(`${a.localName}#${name}.${cls}`);
  }
  return parts.join(">");
}

// ── minimal CSS block splitter (brace / string / comment aware) ──────────────
export interface Block {
  prelude: string; // selector or @rule header
  body: string; // inner text without the outer braces
}
export function splitBlocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    // skip whitespace / comments
    while (i < n && /\s/.test(css[i])) i++;
    if (css.startsWith("/*", i)) {
      const e = css.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (i >= n) break;
    let j = i, quote = "";
    while (j < n && (quote || (css[j] !== "{" && css[j] !== ";"))) {
      if (quote) {
        if (css[j] === "\\") j++;
        else if (css[j] === quote) quote = "";
      } else if (css[j] === '"' || css[j] === "'") quote = css[j];
      j++;
    }
    if (j >= n) break;
    const prelude = css.slice(i, j).trim();
    if (css[j] === ";") {
      out.push({ prelude, body: "" }); // @import / @charset
      i = j + 1;
      continue;
    }
    let depth = 1, k = j + 1;
    quote = "";
    while (k < n && depth) {
      const ch = css[k];
      if (quote) {
        if (ch === "\\") k++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (css.startsWith("/*", k)) {
        const e = css.indexOf("*/", k + 2);
        k = e < 0 ? n : e + 1;
      } else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      k++;
    }
    out.push({ prelude, body: css.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}
const GROUPING = /^@(media|supports|container|layer|scope|document)\b/i;
/** Keep only the parts of a stylesheet that style the given (new) classes. */
function filterCss(css: string, wanted: Set<string>, knownAtRules: Set<string>, wantedIds: Set<string> = new Set()): string {
  const usesWanted = (sel: string) => {
    for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (wanted.has(m[1])) return true;
    // (a StyleLift motion rule for one of the new layouts' own elements)
    for (const m of sel.matchAll(/\[data-sl-[a-z-]+="([^"]+)"\]/g)) if (wantedIds.has(m[1])) return true;
    return false;
  };
  let out = "";
  for (const b of splitBlocks(css)) {
    if (GROUPING.test(b.prelude)) {
      const inner = filterCss(b.body, wanted, knownAtRules, wantedIds);
      if (inner.trim()) out += `${b.prelude}{${inner}}\n`;
    } else if (/^@(font-face|keyframes|-webkit-keyframes|property|counter-style)\b/i.test(b.prelude)) {
      const text = `${b.prelude}{${b.body}}`;
      if (!knownAtRules.has(text.replace(/\s+/g, ""))) out += text + "\n";
    } else if (!b.prelude.startsWith("@") && usesWanted(b.prelude)) out += `${b.prelude}{${b.body}}\n`;
  }
  return out;
}

export interface VariantMergeResult {
  html: string;
  added: number; // variants added from the narrower captures
  styles: number; // stylesheets added for them
  covered: number; // skipped: those widths already had a variant
  unplaced: number; // skipped: no matching spot in the desktop page
}

export function mergeVariantCaptures(desktopHtml: string, extras: string[]): VariantMergeResult {
  const doc = new DOMParser().parseFromString(desktopHtml, "text/html");
  let added = 0;
  let styles = 0;
  let coveredN = 0;
  let unplaced = 0;
  const groups = new Map<string, Element>(); // slot → parent in the desktop doc
  doc.querySelectorAll(".ssr-variant").forEach((v) => {
    if (v.parentElement) groups.set(slotKey(v.parentElement), v.parentElement);
  });
  const have = new Set<string>();
  for (const [slot, parent] of groups)
    for (const c of Array.from(parent.children)) if (c.classList.contains("ssr-variant")) have.add(`${slot}|${sigOf(c)}`);
  const styleTexts = new Set(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || ""));
  const head = doc.head || doc.documentElement;

  // Which widths each slot already shows. A variant is visible wherever none of its
  // hidden-* classes applies; the slot's universe is every hidden-* class seen there
  // in any capture. Framer often renders one variant for two widths (desktop+tablet)
  // while the narrower capture hydrates a tablet-only twin of it: adding that twin
  // would show the section twice at tablet width.
  // (each narrower capture numbered its animations from 1, like the desktop one: renamed apart first)
  const extraDocs = extras.map((x, i) => new DOMParser().parseFromString(namespaceAnimations(x, `w${i + 1}`), "text/html"));
  const universe = new Map<string, Set<string>>();
  const addToUniverse = (slot: string, v: Element) => {
    const u = universe.get(slot) ?? new Set<string>();
    v.classList.forEach((c) => c.startsWith("hidden-") && u.add(c));
    universe.set(slot, u);
  };
  for (const [slot, parent] of groups) for (const c of Array.from(parent.children)) if (c.classList.contains("ssr-variant")) addToUniverse(slot, c);
  for (const e of extraDocs) e.querySelectorAll(".ssr-variant").forEach((v) => v.parentElement && addToUniverse(slotKey(v.parentElement), v));
  const visibleAt = (slot: string, v: Element) => Array.from(universe.get(slot) ?? []).filter((c) => !v.classList.contains(c));
  const covered = new Map<string, Set<string>>();
  const cover = (slot: string, v: Element) => {
    const s0 = covered.get(slot) ?? new Set<string>();
    visibleAt(slot, v).forEach((c) => s0.add(c));
    covered.set(slot, s0);
  };
  for (const [slot, parent] of groups) for (const c of Array.from(parent.children)) if (c.classList.contains("ssr-variant")) cover(slot, c);

  // classes the desktop document already styles; @font-face/@keyframes it already has
  const knownClasses = new Set<string>();
  doc.querySelectorAll("[class]").forEach((el) => el.classList.forEach((c) => knownClasses.add(c)));
  const knownAtRules = new Set<string>();
  for (const t of styleTexts)
    for (const b of splitBlocks(t)) if (/^@(font-face|keyframes|-webkit-keyframes|property)/i.test(b.prelude)) knownAtRules.add(`${b.prelude}{${b.body}}`.replace(/\s+/g, ""));

  for (const e of extraDocs) {
    let usedHere = false;
    const newClasses = new Set<string>();
    const newIds = new Set<string>();
    e.querySelectorAll(".ssr-variant").forEach((v) => {
      if (!v.parentElement) return;
      const slot = slotKey(v.parentElement);
      const parent = groups.get(slot);
      const sig = sigOf(v);
      // a section with no hidden-* classes shows at EVERY width: after hydrating at a
      // narrow width some sites drop the classes, and adding it would duplicate content
      if (!sig) return;
      const key = `${slot}|${sig}`;
      if (!parent) {
        unplaced++;
        return;
      }
      if (have.has(key)) return;
      const shows = visibleAt(slot, v);
      const already = covered.get(slot);
      if (already && shows.every((c) => already.has(c))) {
        coveredN++; // those widths already have a variant
        return;
      }
      // place it after the group's last variant so document order matches Framer's
      const variants = Array.from(parent.children).filter((c) => c.classList.contains("ssr-variant"));
      const node = doc.importNode(v, true);
      [node, ...Array.from(node.querySelectorAll("[class]"))].forEach((el) => el.classList.forEach((c) => !knownClasses.has(c) && newClasses.add(c)));
      motionIds(node).forEach((x) => newIds.add(x));
      if (variants.length) variants[variants.length - 1].after(node);
      else parent.appendChild(node);
      have.add(key);
      cover(slot, v);
      added++;
      usedHere = true;
    });
    if (!usedHere) continue;
    // CSS that only the new layouts need (Framer injects per-component CSS on demand).
    // Only rules that mention classes the desktop document never used are brought
    // over — whole sheets would re-declare desktop selectors and override them.
    let extraCss = "";
    e.querySelectorAll("style").forEach((s) => {
      const t = s.textContent || "";
      if (!t.trim() || styleTexts.has(t)) return;
      extraCss += filterCss(t, newClasses, knownAtRules, newIds);
    });
    if (extraCss.trim()) {
      const st = doc.createElement("style");
      st.setAttribute("data-sl-layouts", "tablet-phone");
      st.textContent = extraCss;
      head.appendChild(st);
      styles++;
    }
    newClasses.forEach((c) => knownClasses.add(c));
  }
  return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, added, styles, covered: coveredN, unplaced };
}

/** Variants with no sibling alternatives are shown at every width. */
export function unhideLoneVariants(html: string): { html: string; unhidden: number } {
  if (!html.includes("ssr-variant")) return { html, unhidden: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  let unhidden = 0;
  doc.querySelectorAll(".ssr-variant").forEach((v) => {
    const sibs = v.parentElement ? Array.from(v.parentElement.children).filter((c) => c.classList.contains("ssr-variant")) : [v];
    if (sibs.length !== 1) return;
    const hidden = Array.from(v.classList).filter((c) => c.startsWith("hidden-"));
    if (!hidden.length) return;
    hidden.forEach((c) => v.classList.remove(c));
    unhidden++;
  });
  return unhidden ? { html: "<!doctype html>\n" + doc.documentElement.outerHTML, unhidden } : { html, unhidden: 0 };
}

/** Does this capture have responsive layouts that only JavaScript builds? */
export const needsVariantCapture = (html: string) => /class="[^"]*\bssr-variant\b/.test(html) && /data-framer-/.test(html);

// ── whole per-width layouts ───────────────────────────────────────────────────
// When the narrower page swaps *component variants* with JavaScript (Framer
// framer-v-* classes: a navigation that becomes a menu button, a hero that
// re-flows into a different component), merging .ssr-variant copies is not enough.
// The narrow page is then kept as its own layout, shown only at that width — the
// way Framer itself treats breakpoints as separate layouts.

export type LayoutLabel = "tablet" | "phone";
export const LAYOUT_MEDIA: Record<LayoutLabel, string> = {
  tablet: "(min-width: 810px) and (max-width: 1199.98px)",
  phone: "(max-width: 809.98px)",
};
const variantClasses = (html: string) => new Set(html.match(/\bframer-v-[\w-]+/g) || []);

/** Does the narrow capture use component variants the desktop page never rendered? */
export function needsWholeLayout(desktopHtml: string, narrowHtml: string): boolean {
  const d = variantClasses(desktopHtml);
  let fresh = 0;
  for (const c of variantClasses(narrowHtml)) if (!d.has(c)) fresh++;
  return fresh >= 2;
}

/** Rename StyleLift animation ids so a second layout can't collide with the first: every id the capture numbers
 *  (scroll-linked s#, reveals r#, entrances g#, loops l#, hovers h# / h#-#, pointer effects p#, pins p#, progress
 *  variables v#, scrubbed frames f#-#, timelines t#) — in the attributes, the selectors and the keyframes' names.
 *  (Each capture numbers from 1: merged as they were, a tablet capture's sl-scroll-s1 replaced the desktop's —
 *  monodrift.framer.website's hero panel slid by the tablet's numbers.) */
const ID_ATTRS: [string, string][] = [
  ["data-sl-reveal", "r"], ["data-sl-scroll", "s"], ["data-sl-in", "g"], ["data-sl-loop", "l"], ["data-sl-hov", "h"], ["data-sl-hovt", "h"],
  ["data-sl-pull", "p"], ["data-sl-tilting", "p"], ["data-sl-pinned", "p"], ["data-sl-var", "v"], ["data-sl-frame", "f"], ["data-sl-vt", "t"], ["data-sl-tl", "t"],
];
const ID_KEYFRAMES: [string, string][] = [["sl-reveal-", "r"], ["sl-scroll-", "s"], ["sl-in-", "g"], ["sl-loop-", "l"], ["sl-pin-", "p"], ["sl-var-", "v"]];
export function namespaceAnimations(html: string, p: string): string {
  let out = html;
  for (const [a, x] of ID_ATTRS) out = out.replace(new RegExp(`(${a}=["']?)${x}(\\d)`, "g"), `$1${p}${x}$2`);
  for (const [k, x] of ID_KEYFRAMES) out = out.replace(new RegExp(`\\b${k}${x}(\\d)`, "g"), `${k}${p}${x}$1`);
  return out.replace(/--sl-t(\d+)/g, `--sl-${p}t$1`);
}
/** the StyleLift motion ids used in a subtree (its rules come along with it) */
function motionIds(root: Element): Set<string> {
  const ids = new Set<string>();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) for (const [a] of ID_ATTRS) { const v = el.getAttribute(a); if (v) ids.add(v); }
  return ids;
}

export function addWholeLayout(desktopHtml: string, narrowHtml: string, label: LayoutLabel): { html: string; styles: number } {
  const doc = new DOMParser().parseFromString(desktopHtml, "text/html");
  const narrow = new DOMParser().parseFromString(namespaceAnimations(narrowHtml, label[0]), "text/html");
  const head = doc.head || doc.documentElement;
  // 1. the layout itself: the narrow page's body content, in a layout-neutral wrapper
  doc.querySelectorAll(`[data-sl-layout="${label}"], style[data-sl-layout-css="${label}"]`).forEach((n) => n.remove());
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-sl-layout", label);
  wrap.setAttribute("data-name", label === "phone" ? "Phone layout" : "Tablet layout");
  for (const c of Array.from(narrow.body.childNodes)) {
    if (c.nodeType === 1 && /^(script|style|link|meta|noscript)$/i.test((c as Element).localName)) continue;
    wrap.appendChild(doc.importNode(c, true));
  }
  doc.body.appendChild(wrap);
  // 2. CSS: classes the desktop page never used + this layout's own animations
  let styles = 0;
  const known = new Set<string>();
  doc.querySelectorAll("[class]").forEach((el) => {
    if (!el.closest("[data-sl-layout]")) el.classList.forEach((c) => known.add(c));
  });
  const fresh = new Set<string>();
  wrap.querySelectorAll("[class]").forEach((el) => el.classList.forEach((c) => !known.has(c) && fresh.add(c)));
  const desktopTexts = new Set(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || ""));
  const knownAt = new Set<string>();
  for (const t of desktopTexts) for (const b of splitBlocks(t)) if (/^@(font-face|keyframes|-webkit-keyframes|property)/i.test(b.prelude)) knownAt.add(`${b.prelude}{${b.body}}`.replace(/\s+/g, ""));
  let css = "";
  narrow.querySelectorAll("style").forEach((s) => {
    const t = s.textContent || "";
    if (!t.trim() || desktopTexts.has(t)) return;
    if (s.hasAttribute("data-sl-scroll-reveal") || s.hasAttribute("data-sl-scroll-linked")) css += t + "\n"; // already namespaced
    else css += filterCss(t, fresh, knownAt);
  });
  if (css.trim()) {
    const st = doc.createElement("style");
    st.setAttribute("data-sl-layout-css", label);
    st.textContent = css;
    head.appendChild(st);
    styles++;
  }
  // 3. switching: each layout shows only at its width; desktop content hides there
  const layouts = Array.from(doc.querySelectorAll("[data-sl-layout]")).map((n) => n.getAttribute("data-sl-layout") as LayoutLabel);
  doc.querySelectorAll("style[data-sl-layouts-switch]").forEach((n) => n.remove());
  const sw = doc.createElement("style");
  sw.setAttribute("data-sl-layouts-switch", "");
  sw.textContent =
    `/* StyleLift: per-width layouts (the site builds them with JavaScript at that width) */\n` +
    `[data-sl-layout] { display: none !important; }\n` +
    layouts
      .map(
        (l) =>
          `@media ${LAYOUT_MEDIA[l]} {\n  body > :not([data-sl-layout]):not(script):not(style) { display: none !important; }\n  [data-sl-layout="${l}"] { display: contents !important; }\n}`,
      )
      .join("\n") +
    "\n";
  head.appendChild(sw);
  return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, styles };
}

// ── breakpoint rules for Framer's hidden-* classes ───────────────────────────
// Framer hides each responsive variant with hidden-<hash> classes and a style that
// its runtime deletes after hydrating. Captures rebuild that style from the page's
// breakpoint table; this is the fallback for pages without one. Each capture holds
// only the variants of its own width, so a class that never appears at a width is
// the one that hides there.
type Breakpoint = "desktop" | LayoutLabel;
export const BREAKPOINT_MEDIA: Record<Breakpoint, string> = {
  desktop: "(min-width: 1200px)",
  ...LAYOUT_MEDIA,
};
export const breakpointForWidth = (w: number): Breakpoint => (w >= 1200 ? "desktop" : w >= 810 ? "tablet" : "phone");

function variantHiddenClasses(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    const cls = m[1].split(/\s+/);
    if (!cls.includes("ssr-variant")) continue;
    for (const c of cls) if (/^hidden-[\w-]+$/.test(c)) out.add(c);
  }
  return out;
}
const hasRuleFor = (html: string, cls: string) => new RegExp(`\\.${cls}(?![\\w-])[^{}<]*\\{`).test(html);

export function ensureBreakpointRules(html: string, captures: { width: number; html: string }[]): { html: string; rules: number } {
  const missing = Array.from(variantHiddenClasses(html)).filter((c) => !hasRuleFor(html, c));
  if (!missing.length) return { html, rules: 0 };
  const present = new Map<Breakpoint, Set<string>>();
  for (const c of captures) {
    const bp = breakpointForWidth(c.width);
    const set = present.get(bp) ?? new Set<string>();
    variantHiddenClasses(c.html).forEach((x) => set.add(x));
    present.set(bp, set);
  }
  if (present.size < 2) return { html, rules: 0 }; // one width tells nothing
  const rules: string[] = [];
  for (const c of missing) {
    const hiddenAt = Array.from(present).filter(([, s]) => !s.has(c)).map(([bp]) => bp);
    // never hide a class at every captured width
    if (!hiddenAt.length || hiddenAt.length === present.size) continue;
    for (const bp of hiddenAt) rules.push(`@media ${BREAKPOINT_MEDIA[bp]} { .${c} { display: none !important; } }`);
  }
  if (!rules.length) return { html, rules: 0 };
  const style = `<style data-framer-breakpoint-css data-sl-inferred>\n${rules.join("\n")}\n</style>`;
  const at = html.lastIndexOf("</head>");
  return { html: at >= 0 ? html.slice(0, at) + style + html.slice(at) : style + html, rules: rules.length };
}
