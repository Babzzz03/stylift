// Injected, self-contained edit helpers. Like the other extractors, these are
// serialized via chrome.scripting.executeScript({ func }) and must reference only
// page globals.

export interface EditTarget {
  selector: string;
  label: string;
  values: Record<string, string>; // current computed values for the requested props
  canEditText: boolean; // true when the element holds only text (safe to rewrite)
  text: string; // current text content (when canEditText)
}

/**
 * Interactive picker for live editing. Highlights elements on hover; on click,
 * returns a stable selector, a label, and the current computed values for the
 * given properties (so the panel can pre-fill its controls). Resolves null on Esc.
 */
export function pickElementForEdit(props: string[]): Promise<EditTarget | null> {
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
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  function shortLabel(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return el.id ? `${tag}#${el.id}` : cls.length ? `${tag}.${cls.join(".")}` : tag;
  }

  return new Promise<EditTarget | null>((resolve) => {
    const prevCursor = document.body.style.cursor;
    const mk = (style: Partial<CSSStyleDeclaration>) => {
      const d = document.createElement("div");
      Object.assign(d.style, style);
      document.documentElement.appendChild(d);
      return d;
    };
    const overlay = mk({
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "rgba(255,255,255,0.16)",
      border: "1px solid #f1f1f3",
      borderRadius: "3px",
    });
    const badge = mk({
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "#f1f1f3",
      color: "#18181a",
      font: "600 11px/1.4 ui-monospace, Menlo, monospace",
      padding: "2px 6px",
      borderRadius: "4px",
    });
    const hint = mk({
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#171a21",
      color: "#e6e8ec",
      font: "500 12px/1 -apple-system, system-ui, sans-serif",
      padding: "8px 14px",
      borderRadius: "8px",
      border: "1px solid #2a2f3a",
    });
    hint.textContent = "StyleLift — click an element to edit · Esc to cancel";
    document.body.style.cursor = "crosshair";

    let current: HTMLElement | null = null;
    const own = new Set<Element>([overlay, badge, hint]);

    function place(el: HTMLElement): void {
      const r = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        top: r.top + "px",
        left: r.left + "px",
        width: r.width + "px",
        height: r.height + "px",
      });
      badge.textContent = `${shortLabel(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      const by = r.top > 22 ? r.top - 20 : r.bottom + 4;
      Object.assign(badge.style, { top: by + "px", left: Math.max(0, r.left) + "px" });
    }
    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || own.has(t)) return;
      current = t;
      place(t);
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      badge.remove();
      hint.remove();
      document.body.style.cursor = prevCursor;
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = (e.target as HTMLElement) || current;
      cleanup();
      if (!el || el === document.documentElement || el === document.body) {
        resolve(null);
        return;
      }
      const cs = getComputedStyle(el);
      const values: Record<string, string> = {};
      for (const p of props) values[p] = cs.getPropertyValue(p).trim();
      // text is safe to rewrite only when the element has no element children
      const canEditText = el.children.length === 0 && (el.textContent || "").trim().length > 0;
      resolve({
        selector: cssPath(el),
        label: shortLabel(el),
        values,
        canEditText,
        text: canEditText ? el.textContent || "" : "",
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}

/**
 * Apply (or clear) the override stylesheet. A single <style> element keyed by
 * selector means edits naturally re-apply to elements that frameworks re-render;
 * a MutationObserver re-attaches the tag if the page ever removes it.
 */
export function applyOverridesToPage(cssText: string): boolean {
  const ID = "__stylelift_overrides__";
  const w = window as unknown as { __slEditObserver?: MutationObserver };
  let style = document.getElementById(ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = ID;
  }
  style.textContent = cssText || "";
  const host = document.head || document.documentElement;
  if (style.parentNode !== host) host.appendChild(style);

  if (!w.__slEditObserver) {
    // Re-attach only if the page removes our tag (avoids an observer feedback loop).
    const reattach = () => {
      if (!document.getElementById(ID)) {
        (document.head || document.documentElement).appendChild(style!);
      }
    };
    const obs = new MutationObserver(reattach);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    w.__slEditObserver = obs;
  }
  return true;
}

/**
 * Apply both CSS overrides and text-content overrides. Text can't live in a
 * stylesheet, so it's set on the matching elements directly and re-applied via a
 * MutationObserver when the framework re-renders and resets the words.
 */
export function applyEdits(
  cssText: string,
  textPairs: [string, string][],
  htmlPairs: [string, string][] = [],
  attrTriples: [string, string, string][] = [],
): boolean {
  applyOverridesToPage(cssText);
  const w = window as unknown as {
    __slText?: [string, string][];
    __slHtml?: [string, string][];
    __slAttr?: [string, string, string][];
    __slTextObserver?: MutationObserver;
  };
  w.__slText = textPairs || [];
  w.__slHtml = htmlPairs || [];
  w.__slAttr = attrTriples || [];

  const applyContent = () => {
    for (const [selector, value] of w.__slText || []) {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el || el.children.length > 0) continue; // never clobber elements with children
      if (el.textContent !== value) el.textContent = value;
    }
    for (const [selector, value] of w.__slHtml || []) {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (el && el.innerHTML !== value) el.innerHTML = value;
    }
    for (const [selector, name, value] of w.__slAttr || []) {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el) continue;
      if (name === "src" && el.tagName === "IMG") el.removeAttribute("srcset");
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
  };
  applyContent();

  if (
    ((w.__slText || []).length || (w.__slHtml || []).length || (w.__slAttr || []).length) &&
    !w.__slTextObserver
  ) {
    // setting content to the desired value is idempotent, so this won't loop
    const obs = new MutationObserver(() => applyContent());
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    w.__slTextObserver = obs;
  }
  return true;
}

/**
 * Apply a sequence of structural (DOM) edits in order. Used live with a single op,
 * and on reload to replay the whole log. Returns the count actually applied.
 */
export function applyStructuralOps(
  ops: { selector: string; op: string; html?: string; position?: string; targetSelector?: string }[],
): number {
  let applied = 0;
  for (const { selector, op, html, position, targetSelector } of ops) {
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      continue;
    }
    if (op === "insert") {
      const tmp = document.createElement("div");
      tmp.innerHTML = (html || "").trim();
      const node = tmp.firstElementChild;
      if (!node) continue;
      if (position === "append" || !el) (el || document.body).appendChild(node);
      else if (position === "before") el.parentNode?.insertBefore(node, el);
      else el.parentNode?.insertBefore(node, el.nextSibling);
      applied++;
      continue;
    }
    if (op === "moveBefore") {
      if (!el || !targetSelector) continue;
      let target: Element | null = null;
      try {
        target = document.querySelector(targetSelector);
      } catch {
        continue;
      }
      if (target && target.parentNode && target !== el) {
        target.parentNode.insertBefore(el, target);
        applied++;
      }
      continue;
    }
    if (!el) continue;
    const parent = el.parentNode;
    if (op === "delete") {
      el.remove();
      applied++;
    } else if (op === "duplicate") {
      if (parent) {
        const clone = el.cloneNode(true);
        parent.insertBefore(clone, el.nextSibling);
        applied++;
      }
    } else if (op === "moveUp") {
      const prev = el.previousElementSibling;
      if (prev && parent) {
        parent.insertBefore(el, prev);
        applied++;
      }
    } else if (op === "moveDown") {
      const next = el.nextElementSibling;
      if (next && parent) {
        parent.insertBefore(next, el);
        applied++;
      }
    }
  }
  return applied;
}
