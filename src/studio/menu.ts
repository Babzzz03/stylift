// Studio's right-click menu: sections, shortcut hints, submenus, disabled items, keyboard navigation
// (↑ ↓ to move, → to open a submenu, ← to close it, Enter to run, Esc to close). One menu at a time.
import { icon, type IconName } from "../shared/icons";

export interface MenuItem {
  label: string;
  key?: string; // shortcut shown on the right, e.g. "⌘C"
  icon?: IconName;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sub?: MenuEntry[];
  /** called while the item is hovered or focused (e.g. highlight a layer) */
  hover?: (on: boolean) => void;
}
export type MenuEntry = MenuItem | "-";

let open: HTMLElement[] = []; // the menu and any open submenus, outermost first
let onClose: (() => void) | null = null;

export function closeMenu(): void {
  for (const m of open) m.remove();
  open = [];
  document.removeEventListener("mousedown", outside, true);
  document.removeEventListener("keydown", keys, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  const f = onClose;
  onClose = null;
  f?.();
}
export const menuOpen = () => open.length > 0;

function outside(e: MouseEvent): void {
  if (!open.some((m) => m.contains(e.target as Node))) closeMenu();
}
function items(m: HTMLElement): HTMLButtonElement[] {
  return Array.from(m.querySelectorAll<HTMLButtonElement>(":scope > .cm-item:not(:disabled)"));
}
function keys(e: KeyboardEvent): void {
  const m = open[open.length - 1];
  if (!m) return;
  const list = items(m);
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === "Escape") {
    stop();
    if (open.length > 1) closeSub(open.length - 1);
    else closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    stop();
    const n = list.length;
    if (n) list[(i + (e.key === "ArrowDown" ? 1 : -1) + n + (i < 0 && e.key === "ArrowUp" ? 1 : 0)) % n].focus();
  } else if (e.key === "ArrowRight") {
    stop();
    if (i >= 0 && list[i].classList.contains("has-sub")) list[i].click();
  } else if (e.key === "ArrowLeft") {
    stop();
    if (open.length > 1) closeSub(open.length - 1);
  } else if (e.key === "Enter" || e.key === " ") {
    if (i >= 0) {
      stop();
      list[i].click();
    }
  }
}
function closeSub(level: number): void {
  const parent = open[level - 1];
  for (const m of open.splice(level)) m.remove();
  parent?.querySelectorAll(".cm-item.sub-open").forEach((b) => b.classList.remove("sub-open"));
  (parent?.querySelector(".cm-item.sub-open") as HTMLElement | null)?.focus();
}

function build(entries: MenuEntry[], level: number): HTMLElement {
  const m = document.createElement("div");
  m.className = "cm";
  m.setAttribute("role", "menu");
  let subTimer = 0;
  for (const e of entries) {
    if (e === "-") {
      if (m.lastElementChild && !m.lastElementChild.classList.contains("cm-sep")) {
        const s = document.createElement("div");
        s.className = "cm-sep";
        m.appendChild(s);
      }
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-item" + (e.sub ? " has-sub" : "") + (e.danger ? " danger" : "");
    b.setAttribute("role", "menuitem");
    b.disabled = !!e.disabled || (!e.run && !e.sub?.length);
    b.innerHTML = `<span class="cm-ico">${e.icon ? icon(e.icon, 15) : ""}</span><span class="cm-label"></span><span class="cm-key"></span>`;
    b.querySelector(".cm-label")!.textContent = e.label;
    if (e.sub) b.querySelector(".cm-key")!.innerHTML = icon("chevronRight", 13);
    else if (e.key) b.querySelector(".cm-key")!.textContent = e.key;
    const openSub = () => {
      if (!e.sub || b.disabled) return;
      if (open[level + 1] && b.classList.contains("sub-open")) return;
      closeSubsFrom(level + 1);
      m.querySelectorAll(".cm-item.sub-open").forEach((x) => x.classList.remove("sub-open"));
      b.classList.add("sub-open");
      const sm = build(e.sub, level + 1);
      document.body.appendChild(sm);
      open[level + 1] = sm;
      const r = b.getBoundingClientRect();
      place(sm, r.right - 4, r.top - 5, r.left + 4);
      (sm.querySelector(".cm-item:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });
    };
    b.addEventListener("mouseenter", () => {
      e.hover?.(true);
      b.focus({ preventScroll: true });
      clearTimeout(subTimer);
      if (e.sub) subTimer = window.setTimeout(openSub, 120);
      else subTimer = window.setTimeout(() => {
        if (open.length > level + 1) closeSub(level + 1);
      }, 150);
    });
    b.addEventListener("mouseleave", () => e.hover?.(false));
    b.addEventListener("focus", () => e.hover?.(true));
    b.addEventListener("blur", () => e.hover?.(false));
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (b.disabled) return;
      if (e.sub) return openSub();
      closeMenu();
      e.run?.();
    });
    m.appendChild(b);
  }
  if (m.lastElementChild?.classList.contains("cm-sep")) m.lastElementChild.remove();
  return m;
}
function closeSubsFrom(level: number): void {
  for (const m of open.splice(level)) m.remove();
}
/** Put a menu at (x, y), flipping left / up when it would leave the window. */
function place(m: HTMLElement, x: number, y: number, flipX = x): void {
  m.style.left = "0px";
  m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  const left = x + w > innerWidth - 6 ? Math.max(6, flipX - w) : x;
  const top = Math.max(6, Math.min(y, innerHeight - h - 6));
  m.style.left = `${Math.round(left)}px`;
  m.style.top = `${Math.round(top)}px`;
}

/** Open a menu at the pointer. `closed` runs when it goes away (to drop a highlight). */
export function openMenu(x: number, y: number, entries: MenuEntry[], closed?: () => void, above = false): void {
  closeMenu();
  const m = build(entries, 0);
  document.body.appendChild(m);
  open = [m];
  onClose = closed || null;
  place(m, x, above ? y - m.offsetHeight : y); // above: a toolbar's menu opens upward
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", keys, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
  }, 0);
  m.focus();
}
