import { READABLE_RUNTIME } from "./motion-runtime.generated";
// Studio motion: entrance, scroll, hover and looping animations added in Studio.
//
// An animation is stored as --slm-* custom properties among the element's ordinary style edits, so
// undo, copy / paste, duplicate, breakpoints (e.g. "None" on Phone), saving and every export carry
// it with no extra bookkeeping. editsToCss compiles those properties into plain CSS: keyframes, the
// element's animation, hover transitions. Only "Scroll into view" and "Text word by word" need a
// script, the small `motionRuntime` below, shipped with the exports that use them. Without it
// (no JavaScript) everything simply plays when the page loads, so nothing is ever left hidden.
//
// Entrances animate FROM a state back to the element's own styles (fill-mode backwards, implicit
// end keyframe): once finished they leave nothing behind. Movement is composed onto the element's
// existing transform (animation-composition: add), so a site's own transforms are never replaced.

export type MotionOn = "enter" | "load" | "scroll" | "hover" | "loop" | "none";
export interface Motion {
  on: MotionOn;
  fx: string;
  dur: number; // ms
  delay: number; // ms
  ease: string; // a key of EASES
  dist: number; // px: how far a slide travels / a hover lifts
  stagger: number; // ms between children (or words); 0 = the element as one
  replay: boolean; // play again each time it scrolls into view
}
export const MOTION_KEYS = {
  on: "--slm-on",
  fx: "--slm-fx",
  dur: "--slm-dur",
  delay: "--slm-delay",
  ease: "--slm-ease",
  dist: "--slm-dist",
  stagger: "--slm-stagger",
  replay: "--slm-replay",
} as const;
export const isMotionProp = (k: string) => k.startsWith("--slm-");

export const TRIGGERS: { id: MotionOn; label: string; hint: string }[] = [
  { id: "none", label: "None", hint: "No animation" },
  { id: "enter", label: "Scroll into view", hint: "Plays when it comes on screen" },
  { id: "load", label: "Page load", hint: "Plays as soon as the page opens" },
  { id: "scroll", label: "While scrolling", hint: "Moves with the scroll position" },
  { id: "hover", label: "Hover", hint: "While the pointer is over it" },
  { id: "loop", label: "Loop", hint: "Plays continuously" },
];

interface EnterFx {
  label: string;
  o?: number; // start opacity
  t?: string; // start movement (composed onto the element's transform)
  f?: string; // start filter
  clip?: string; // start clip-path (a wipe)
  text?: boolean; // text layers only
  dist?: boolean; // uses the Distance field
}
export const ENTER_FX: Record<string, EnterFx> = {
  fade: { label: "Fade in", o: 0 },
  up: { label: "Slide up", o: 0, t: "translateY(var(--slm-d, 32px))", dist: true },
  down: { label: "Slide down", o: 0, t: "translateY(calc(var(--slm-d, 32px) * -1))", dist: true },
  left: { label: "Slide in from left", o: 0, t: "translateX(calc(var(--slm-d, 32px) * -1))", dist: true },
  right: { label: "Slide in from right", o: 0, t: "translateX(var(--slm-d, 32px))", dist: true },
  zoom: { label: "Zoom in", o: 0, t: "scale(.86)" },
  pop: { label: "Pop", o: 0, t: "scale(.5)" },
  out: { label: "Zoom out", o: 0, t: "scale(1.18)" },
  blur: { label: "Blur in", o: 0, f: "blur(16px)" },
  flip: { label: "Flip up", o: 0, t: "perspective(900px) rotateX(-70deg)" },
  rotate: { label: "Rotate in", o: 0, t: "rotate(-12deg) scale(.9)" },
  wipe: { label: "Wipe in", clip: "inset(0 100% 0 0)" },
  reveal: { label: "Reveal up", clip: "inset(100% 0 0 0)", t: "translateY(calc(var(--slm-d, 32px) * .5))", dist: true },
  words: { label: "Text word by word", o: 0, t: "translateY(.5em)", f: "blur(6px)", text: true },
};
interface HoverFx {
  label: string;
  dist?: boolean;
  js?: boolean; // follows the pointer: the runtime sets the values, CSS moves it
  unit?: string; // what the Distance field means for it
}
export const HOVER_FX: Record<string, HoverFx> = {
  lift: { label: "Lift", dist: true },
  grow: { label: "Grow" },
  shrink: { label: "Press in" },
  tilt: { label: "Tilt" },
  dim: { label: "Dim" },
  shadow: { label: "Shadow" },
  magnet: { label: "Magnetic (follows the pointer)", dist: true, js: true, unit: "px" },
  tilt3d: { label: "3D tilt (follows the pointer)", dist: true, js: true, unit: "°" },
};
interface LoopFx {
  label: string;
  kf: string; // keyframes body
  add: boolean; // composed onto the element's transform
  alternate: boolean;
  dur: number;
  ease: string;
}
export const LOOP_FX: Record<string, LoopFx> = {
  float: { label: "Float", kf: "from { transform: none } to { transform: translateY(calc(var(--slm-d, 10px) * -1)) }", add: true, alternate: true, dur: 2800, ease: "inout" },
  pulse: { label: "Pulse", kf: "from { transform: none } to { transform: scale(1.07) }", add: true, alternate: true, dur: 1100, ease: "inout" },
  spin: { label: "Spin", kf: "from { transform: none } to { transform: rotate(360deg) }", add: true, alternate: false, dur: 8000, ease: "linear" },
  bounce: { label: "Bounce", kf: "0%, 100% { transform: none } 45% { transform: translateY(calc(var(--slm-d, 14px) * -1)) } 60% { transform: translateY(calc(var(--slm-d, 14px) * -.8)) }", add: true, alternate: false, dur: 1500, ease: "inout" },
  wiggle: { label: "Wiggle", kf: "0%, 100% { transform: none } 25% { transform: rotate(-5deg) } 75% { transform: rotate(5deg) }", add: true, alternate: false, dur: 1300, ease: "inout" },
  sway: { label: "Sway", kf: "from { transform: translateX(calc(var(--slm-d, 10px) * -1)) } to { transform: translateX(var(--slm-d, 10px)) }", add: true, alternate: true, dur: 3200, ease: "inout" },
  blink: { label: "Fade in and out", kf: "from { opacity: 1 } to { opacity: .35 }", add: false, alternate: true, dur: 1400, ease: "inout" },
};
export const EASES: Record<string, { label: string; css: string }> = {
  smooth: { label: "Smooth", css: "cubic-bezier(.22, 1, .36, 1)" },
  spring: { label: "Spring", css: "cubic-bezier(.34, 1.56, .64, 1)" },
  ease: { label: "Ease", css: "ease" },
  inout: { label: "Ease in-out", css: "cubic-bezier(.65, 0, .35, 1)" },
  linear: { label: "Linear", css: "linear" },
};

export const effectsFor = (on: MotionOn, textLayer: boolean): [string, string][] => {
  if (on === "hover") return Object.entries(HOVER_FX).map(([k, v]) => [k, v.label]);
  if (on === "loop") return Object.entries(LOOP_FX).map(([k, v]) => [k, v.label]);
  if (on === "none") return [];
  return Object.entries(ENTER_FX)
    .filter(([, v]) => (on === "scroll" ? !v.text : !v.text || textLayer))
    .map(([k, v]) => [k, v.label]);
};
/** Sensible settings when a trigger is picked (what the panel fills in). */
export function defaultMotion(on: MotionOn, textLayer = false, fx?: string): Motion {
  if (on === "hover") {
    const k = fx && HOVER_FX[fx] ? fx : "lift";
    return { on, fx: k, dur: k === "magnet" ? 450 : k === "tilt3d" ? 300 : 260, delay: 0, ease: "smooth", dist: k === "magnet" ? 14 : k === "tilt3d" ? 10 : 6, stagger: 0, replay: false };
  }
  if (on === "loop") {
    const k = fx && LOOP_FX[fx] ? fx : "float";
    return { on, fx: k, dur: LOOP_FX[k].dur, delay: 0, ease: LOOP_FX[k].ease, dist: k === "bounce" ? 14 : 10, stagger: 0, replay: false };
  }
  const k = fx && ENTER_FX[fx] && (!ENTER_FX[fx].text || textLayer) ? fx : textLayer && on !== "scroll" ? "words" : "up";
  return { on, fx: k, dur: k === "words" ? 700 : 800, delay: 0, ease: k === "pop" ? "spring" : "smooth", dist: 32, stagger: k === "words" ? 45 : 0, replay: false };
}
export function motionToProps(m: Motion): Record<string, string> {
  if (m.on === "none") return { [MOTION_KEYS.on]: "none" };
  return {
    [MOTION_KEYS.on]: m.on,
    [MOTION_KEYS.fx]: m.fx,
    [MOTION_KEYS.dur]: String(Math.max(0, Math.round(m.dur))),
    [MOTION_KEYS.delay]: String(Math.max(0, Math.round(m.delay))),
    [MOTION_KEYS.ease]: m.ease,
    [MOTION_KEYS.dist]: String(Math.round(m.dist)),
    [MOTION_KEYS.stagger]: String(Math.max(0, Math.round(m.stagger))),
    [MOTION_KEYS.replay]: m.replay ? "1" : "0",
  };
}
/** The motion an element has in effect from its (merged) --slm-* properties, or null for none. */
export function readMotion(props: Record<string, string | undefined>): Motion | null {
  const on = (props[MOTION_KEYS.on] || "") as MotionOn;
  if (!on) return null;
  if (on === "none") return { on, fx: "", dur: 0, delay: 0, ease: "smooth", dist: 0, stagger: 0, replay: false };
  if (!TRIGGERS.some((t) => t.id === on)) return null;
  const d = defaultMotion(on, true, props[MOTION_KEYS.fx]);
  const num = (k: string, dflt: number) => {
    const v = parseFloat(props[k] || "");
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    on,
    fx: d.fx,
    dur: num(MOTION_KEYS.dur, d.dur),
    delay: num(MOTION_KEYS.delay, d.delay),
    ease: EASES[props[MOTION_KEYS.ease] || ""] ? props[MOTION_KEYS.ease]! : d.ease,
    dist: num(MOTION_KEYS.dist, d.dist),
    stagger: num(MOTION_KEYS.stagger, d.stagger),
    replay: props[MOTION_KEYS.replay] === "1",
  };
}

// ── compiling ─────────────────────────────────────────────────────────────────
/** The element's own transform-ish edits in a scope, so a hover effect builds on them. */
export interface BaseTransforms {
  translate?: string;
  scale?: string;
  rotate?: string;
  opacity?: string;
  boxShadow?: string;
}
const imp = (decls: string[]) => decls.map((d) => `${d} !important;`).join(" ");
const num2 = (n: number) => String(Math.round(n * 1000) / 1000);
function liftTranslate(base: string | undefined, d: number): string {
  const parts = (base || "").trim().split(/\s+/).filter((p) => p && p !== "none");
  const x = parts[0] || "0px", y = parts[1] || "0px";
  return `${x} calc(${y} - ${d}px)`;
}
function growScale(base: string | undefined, f: number): string {
  const parts = (base || "").trim().split(/\s+/).filter((p) => p && p !== "none").map((p) => parseFloat(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return num2(f);
  return parts.map((p) => num2(p * f)).join(" ");
}
const addRotate = (base: string | undefined, deg: number) => (base && base !== "none" ? `calc(${base} + ${deg}deg)` : `${deg}deg`);

/** The keyframes an entrance or loop needs (by effect), emitted once per stylesheet. */
export function motionKeyframes(names: Set<string>): string {
  const out: string[] = [];
  for (const n of names) {
    const [kind, fx] = n.split(":");
    if (kind === "in") {
      const e = ENTER_FX[fx];
      if (!e) continue;
      const plain = [e.o !== undefined ? `opacity: ${e.o}` : "", e.f ? `filter: ${e.f}` : ""].filter(Boolean).join("; ");
      if (plain) out.push(`@keyframes slm-${fx} { from { ${plain} } }`);
      if (e.t) out.push(`@keyframes slm-${fx}-t { from { transform: ${e.t} } }`);
      if (e.clip) out.push(`@keyframes slm-${fx}-c { from { clip-path: ${e.clip} } to { clip-path: inset(0 0 0 0) } }`);
    } else if (kind === "loop") {
      const l = LOOP_FX[fx];
      if (l) out.push(`@keyframes slm-loop-${fx} { ${l.kf} }`);
    }
  }
  return out.join("\n");
}

/**
 * CSS for one element's motion in one scope. `sel` is its selector; `prev` is the motion the wider
 * scopes give it (so "None" on Phone can switch a Desktop hover effect off). Returns rules (to go in
 * the scope's media block) and the keyframes they use.
 */
export function motionRules(sel: string, m: Motion, base: BaseTransforms, prev: Motion | null, keyframes: Set<string>, guard = true): string[] {
  const rules: string[] = [];
  const wrap = (css: string) => (guard ? `@media (prefers-reduced-motion: no-preference) { ${css} }` : css);
  const ease = EASES[m.ease]?.css || EASES.smooth.css;
  if (m.on === "none") {
    rules.push(`${sel} { animation: none !important; }`);
    if (prev?.on === "hover") {
      const reset = [`translate: ${base.translate || "none"}`, `scale: ${base.scale || "none"}`, `rotate: ${base.rotate || "none"}`];
      if (prev.fx === "dim") reset.push(`opacity: ${base.opacity || "1"}`);
      if (prev.fx === "shadow" || prev.fx === "lift") reset.push(`box-shadow: ${base.boxShadow || "none"}`);
      rules.push(`${sel}:hover, ${sel}[data-slm-hover] { ${imp(reset)} }`);
    }
    return rules;
  }
  if (m.on === "hover") {
    const fx = HOVER_FX[m.fx] ? m.fx : "lift";
    const on: string[] = [];
    if (fx === "lift") on.push(`translate: ${liftTranslate(base.translate, m.dist || 6)}`, `box-shadow: 0 ${Math.round((m.dist || 6) * 2.2)}px ${Math.round((m.dist || 6) * 5)}px -8px rgba(0, 0, 0, .28)`);
    if (fx === "grow") on.push(`scale: ${growScale(base.scale, 1.05)}`);
    if (fx === "shrink") on.push(`scale: ${growScale(base.scale, 0.96)}`);
    if (fx === "tilt") on.push(`rotate: ${addRotate(base.rotate, -2)}`, `scale: ${growScale(base.scale, 1.02)}`);
    if (fx === "dim") on.push(`opacity: .72`);
    if (fx === "shadow") on.push(`box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .3)`);
    if (fx === "magnet" || fx === "tilt3d") {
      // follows the pointer: the runtime sets --slm-mx / --slm-my (a pull) or --slm-rx / --slm-ry (a tilt) while
      // the pointer is over it; this moves it — built on its own position. Studio's preview shows a pull / tilt.
      const t = `${m.dur}ms ${ease}`;
      if (fx === "magnet") {
        const parts = (base.translate || "").trim().split(/\s+/).filter((x) => x && x !== "none");
        const bx = parts[0] || "0px", by = parts[1] || "0px";
        rules.push(wrap(`${sel} { translate: calc(${bx} + var(--slm-mx, 0px)) calc(${by} + var(--slm-my, 0px)) !important; transition: translate ${t} !important; }`));
        rules.push(`${sel}[data-slm-hover] { --slm-mx: ${num2((m.dist || 14) * 0.6)}px; --slm-my: ${num2(-(m.dist || 14) * 0.4)}px; }`);
      } else {
        rules.push(wrap(`${sel} { transform: perspective(900px) rotateX(var(--slm-rx, 0deg)) rotateY(var(--slm-ry, 0deg)) !important; transition: transform ${t} !important; }`));
        rules.push(`${sel}[data-slm-hover] { --slm-rx: ${num2((m.dist || 10) * 0.6)}deg; --slm-ry: ${num2(-(m.dist || 10) * 0.6)}deg; }`);
      }
      return rules;
    }
    const t = `${m.dur}ms ${ease} ${m.delay}ms`;
    rules.push(wrap(`${sel} { transition: translate ${t}, scale ${t}, rotate ${t}, opacity ${t}, box-shadow ${t}, color ${t}, background-color ${t}, border-color ${t} !important; }`));
    // only where there's a real pointer (a tap would leave the effect stuck); data-slm-hover = Studio's preview
    rules.push(`@media (hover: hover) { ${sel}:hover { ${imp(on)} } }`, `${sel}[data-slm-hover] { ${imp(on)} }`);
    return rules;
  }
  if (m.on === "loop") {
    const fx = LOOP_FX[m.fx] ? m.fx : "float";
    const l = LOOP_FX[fx];
    keyframes.add(`loop:${fx}`);
    rules.push(wrap(`${sel} { --slm-d: ${m.dist}px; animation: slm-loop-${fx} ${m.dur}ms ${ease} ${m.delay}ms infinite ${l.alternate ? "alternate" : "normal"} both !important; animation-composition: ${l.add ? "add" : "replace"} !important; }`));
    return rules;
  }
  // entrances: enter / load / scroll
  const fx = ENTER_FX[m.fx] ? m.fx : "up";
  const e = ENTER_FX[fx];
  keyframes.add(`in:${fx}`);
  const parts: { name: string; comp: string }[] = [];
  if (e.o !== undefined || e.f) parts.push({ name: `slm-${fx}`, comp: "replace" });
  if (e.t) parts.push({ name: `slm-${fx}-t`, comp: "add" });
  if (e.clip) parts.push({ name: `slm-${fx}-c`, comp: "replace" });
  const comp = `animation-composition: ${parts.map((p) => p.comp).join(", ")} !important;`;
  const vars = `--slm-d: ${m.dist}px !important;`;
  if (m.on === "scroll") {
    const anim = parts.map((p) => `${p.name} linear backwards`).join(", ");
    rules.push(`${sel} { ${vars} }`);
    rules.push(wrap(`@supports (animation-timeline: view()) { ${sel} { animation: ${anim} !important; ${comp} animation-timeline: ${parts.map(() => "view()").join(", ")} !important; animation-range: entry 0% cover 40% !important; } }`));
    return rules;
  }
  const anim = (delay: string) => parts.map((p) => `${p.name} ${m.dur}ms ${ease} ${delay} backwards`).join(", ");
  rules.push(`${sel} { ${vars} }`);
  if (fx === "words") {
    // split into words by the runtime (data-slm-split); without it the text comes in as one
    const step = m.stagger || 45;
    rules.push(wrap(`${sel}:not([data-slm-split]) { animation: ${anim(`${m.delay}ms`)} !important; ${comp} }`));
    rules.push(`${sel}[data-slm-split] .slm-w { display: inline-block; }`);
    rules.push(wrap(`${sel}[data-slm-split] .slm-w { animation: ${anim(`calc(${m.delay}ms + var(--slm-i, 0) * ${step}ms)`)} !important; ${comp} }`));
    return rules;
  }
  if (m.stagger > 0) {
    // the children one after another (cards in a row, list items…)
    rules.push(wrap(`${sel} > * { animation: ${anim(`${m.delay}ms`)} !important; ${comp} }`));
    const delays: string[] = [];
    for (let i = 2; i <= 12; i++) delays.push(`${sel} > :nth-child(${i}) { animation-delay: ${parts.map(() => `${m.delay + (i - 1) * m.stagger}ms`).join(", ")} !important; }`);
    delays.push(`${sel} > :nth-child(n+13) { animation-delay: ${parts.map(() => `${m.delay + 12 * m.stagger}ms`).join(", ")} !important; }`);
    rules.push(wrap(delays.join(" ")));
    return rules;
  }
  rules.push(wrap(`${sel} { animation: ${anim(`${m.delay}ms`)} !important; ${comp} }`));
  return rules;
}

/** Does a set of edits use anything that needs the runtime (scroll-into-view or word-by-word)? */
export function needsMotionRuntime(all: Record<string, string>[]): boolean {
  return all.some(
    (p) =>
      p[MOTION_KEYS.on] === "enter" ||
      (p[MOTION_KEYS.fx] === "words" && (p[MOTION_KEYS.on] === "load" || p[MOTION_KEYS.on] === "enter")) ||
      (p[MOTION_KEYS.on] === "hover" && !!HOVER_FX[p[MOTION_KEYS.fx]]?.js),
  );
}
/** Pointer effects recorded from the original site, in a page (they need the runtime too). */
export const POINTER_SELECTOR = "[data-sl-magnet], [data-sl-tilt], [data-sl-cursor], video[data-sl-play]";
/** Widgets the site's scripts ran, marked at capture (tabs, gallery arrows, video buttons): the runtime works them. */
export const WIDGET_SELECTOR = "[data-sl-tabs], [data-sl-paddle], [data-sl-media], video[data-sl-media-v], [data-sl-scroll-classes], [data-sl-hold]";

// ── runtime (shipped in exports; Studio's artboards run no scripts) ──────────────────────────────
/** Wrap each word of a text in <span class="slm-w"> (numbered --slm-i) for a word-by-word entrance. Self-contained. */
export function splitWords(doc: Document, el: Element): void {
  if (el.hasAttribute("data-slm-split")) return;
  var i = 0;
  var walk = function (n: Node) {
    var kids = [].slice.call(n.childNodes) as Node[];
    for (var k = 0; k < kids.length; k++) {
      var c = kids[k];
      if (c.nodeType === 3) {
        var text = c.nodeValue || "";
        if (!text.trim()) continue;
        var frag = doc.createDocumentFragment();
        var parts = text.split(/(\s+)/);
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j];
          if (!p) continue;
          if (/^\s+$/.test(p)) frag.appendChild(doc.createTextNode(p));
          else {
            var s = doc.createElement("span");
            s.className = "slm-w";
            s.style.setProperty("--slm-i", String(i++));
            s.textContent = p;
            frag.appendChild(s);
          }
        }
        n.replaceChild(frag, c);
      } else if (c.nodeType === 1 && !/^(script|style|svg|img|br|video|canvas|iframe)$/i.test((c as Element).localName)) walk(c);
    }
  };
  walk(el);
  el.setAttribute("data-slm-split", "");
}
/**
 * Splits word-by-word texts into words and holds each "Scroll into view" animation at its start
 * until the element comes on screen. Self-contained (it's serialised into the exports), plain ES5.
 */
export function motionRuntime(doc: Document, win: Window, split: (doc: Document, el: Element) => void): void {
  var cs = function (el: Element, p: string) {
    return win.getComputedStyle(el).getPropertyValue(p).trim();
  };
  // the element's own animated parts: itself, its children (one after another) or its words
  var targets = function (el: Element): HTMLElement[] {
    var list = [el as HTMLElement];
    if (el.hasAttribute("data-slm-split")) list = list.concat([].slice.call(el.querySelectorAll(".slm-w")));
    else if (parseFloat(cs(el, "--slm-stagger")) > 0) list = list.concat([].slice.call(el.children));
    return list;
  };
  var anims = function (el: Element): Animation[] {
    var out: Animation[] = [];
    var own = el.hasAttribute("data-sl-hold"); // the site's own one-shot animation, held until in view
    var t = targets(el);
    for (var i = 0; i < t.length; i++) {
      var a = typeof t[i].getAnimations === "function" ? t[i].getAnimations() : [];
      for (var j = 0; j < a.length; j++) if (/^(slm-|sl-in-)/.test((a[j] as CSSAnimation).animationName || "") || (own && a[j].timeline === doc.timeline && !!(a[j] as CSSAnimation).animationName)) out.push(a[j]);
    }
    return out;
  };
  var hold = function (el: Element) {
    var a = anims(el);
    for (var i = 0; i < a.length; i++) {
      a[i].pause();
      a[i].currentTime = 0;
    }
  };
  var play = function (el: Element) {
    var a = anims(el);
    for (var i = 0; i < a.length; i++) a[i].play();
  };
  // Pointer effects, only with a real pointer and motion allowed: elements pulled toward the pointer
  // (magnetic), tilted in 3D by it, and cursor followers — the site's own (recorded at capture: data-sl-magnet,
  // data-sl-tilt, data-sl-cursor) and those added in Studio (Hover → Magnetic / 3D tilt). Only custom
  // properties are set here; the page's CSS moves things, so their own transforms and edits are kept.
  var mm = function (q: string) {
    return !!win.matchMedia && win.matchMedia(q).matches;
  };
  var pointer = mm("(hover: hover) and (pointer: fine)") && !mm("(prefers-reduced-motion: reduce)");
  var follow = function (host: Element, magnet: number, tilt: number) {
    var pull = host.hasAttribute("data-sl-pull") ? host : host.querySelector("[data-sl-pull]") || host;
    var tiltEl = host.hasAttribute("data-sl-tilting") ? host : host.querySelector("[data-sl-tilting]") || host;
    host.addEventListener("pointermove", function (ev: Event) {
      var e = ev as PointerEvent;
      var r = host.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      if (magnet) {
        (pull as HTMLElement).style.setProperty("--slm-mx", (dx * magnet).toFixed(1) + "px");
        (pull as HTMLElement).style.setProperty("--slm-my", (dy * magnet).toFixed(1) + "px");
      }
      if (tilt) {
        (tiltEl as HTMLElement).style.setProperty("--slm-rx", ((-dy / Math.max(1, r.height / 2)) * tilt).toFixed(2) + "deg");
        (tiltEl as HTMLElement).style.setProperty("--slm-ry", ((dx / Math.max(1, r.width / 2)) * tilt).toFixed(2) + "deg");
      }
    });
    host.addEventListener("pointerleave", function () {
      var ps = ["--slm-mx", "--slm-my", "--slm-rx", "--slm-ry"];
      for (var i = 0; i < ps.length; i++) {
        (pull as HTMLElement).style.removeProperty(ps[i]);
        (tiltEl as HTMLElement).style.removeProperty(ps[i]);
      }
    });
  };
  if (pointer) {
    var site = [].slice.call(doc.querySelectorAll("[data-sl-magnet], [data-sl-tilt]")) as Element[];
    for (var si = 0; si < site.length; si++) follow(site[si], parseFloat(site[si].getAttribute("data-sl-magnet") || "") || 0, parseFloat(site[si].getAttribute("data-sl-tilt") || "") || 0);
    // cursor followers: eased toward the pointer every frame (their own lag), offset as on the site
    var cur = [].slice.call(doc.querySelectorAll("[data-sl-cursor]")) as HTMLElement[];
    if (cur.length) {
      var px = -1, py = -1;
      var st = cur.map(function (el) {
        var o: { k?: number; ox?: number; oy?: number } = {};
        try {
          o = JSON.parse(el.getAttribute("data-sl-cursor") || "{}");
        } catch (e) {
          o = {};
        }
        return { el: el, k: Math.max(0.02, Math.min(1, o.k || 0.2)), ox: o.ox || 0, oy: o.oy || 0, x: 0, y: 0, c: null as null | { x: number; y: number } };
      });
      var tick = function () {
        for (var i = 0; i < st.length; i++) {
          var f = st[i];
          if (!f.c) {
            var r = f.el.getBoundingClientRect();
            f.c = { x: r.left + r.width / 2 - f.x, y: r.top + r.height / 2 - f.y };
          }
          var tx = px + f.ox - f.c.x, ty = py + f.oy - f.c.y;
          f.x += (tx - f.x) * f.k;
          f.y += (ty - f.y) * f.k;
          f.el.style.setProperty("--slm-cx", f.x.toFixed(1) + "px");
          f.el.style.setProperty("--slm-cy", f.y.toFixed(1) + "px");
        }
        win.requestAnimationFrame(tick);
      };
      var started = false;
      win.addEventListener("pointermove", function (ev: Event) {
        px = (ev as PointerEvent).clientX;
        py = (ev as PointerEvent).clientY;
        if (!started) {
          started = true;
          win.requestAnimationFrame(tick);
        }
      }, { passive: true });
    }
  }
  // Videos the site plays ONCE as they come into view (data-sl-play="enter", from the capture): played then,
  // muted, once — by where they sit in the layout, like the entrances below. Reduced motion: their still frame.
  var vids = mm("(prefers-reduced-motion: reduce)") ? [] : ([].slice.call(doc.querySelectorAll('video[data-sl-play="enter"]')) as HTMLVideoElement[]);
  if (vids.length) {
    var vTop = function (el: Element): number {
      var y = 0;
      for (var m = el as HTMLElement | null; m; m = m.offsetParent as HTMLElement | null) y += m.offsetTop || 0;
      return y;
    };
    var played: boolean[] = [];
    var vCheck = function () {
      var line = (win.scrollY || 0) + win.innerHeight * 0.88, left = 0;
      for (var i = 0; i < vids.length; i++) {
        if (played[i]) continue;
        if (vTop(vids[i]) < line) {
          played[i] = true;
          vids[i].muted = true;
          try {
            var pr = vids[i].play();
            if (pr && pr.catch) pr.catch(function () {});
          } catch (e) {
            /* no playback */
          }
        } else left++;
      }
      if (!left) win.removeEventListener("scroll", vScroll);
    };
    var vQueued = false;
    var vScroll = function () {
      if (vQueued) return;
      vQueued = true;
      win.requestAnimationFrame(function () {
        vQueued = false;
        vCheck();
      });
    };
    win.addEventListener("scroll", vScroll, { passive: true });
    win.addEventListener("load", vCheck);
    vCheck();
  }
  // ── Widgets the site's scripts ran (marked at capture) ──
  var list = function (sel: string, root?: ParentNode): HTMLElement[] {
    return [].slice.call((root || doc).querySelectorAll(sel)) as HTMLElement[];
  };
  var still = mm("(prefers-reduced-motion: reduce)");
  // "Selected" and "not selected" looks, learned from the page itself: the classes, ARIA states and inline
  // styles the selected one has and the others share — whatever the site calls them (current, is-active…)
  var learn = function (on: Element, offs: Element[]) {
    var ATTRS = ["aria-selected", "aria-hidden", "aria-expanded", "aria-current", "hidden", "tabindex", "inert", "data-state", "data-active"];
    var cl = function (e: Element) {
      return [].slice.call(e.classList) as string[];
    };
    var onCls = cl(on).filter(function (c) {
      return offs.every(function (o) { return !o.classList.contains(c); });
    });
    var offCls = cl(offs[0]).filter(function (c) {
      return !on.classList.contains(c) && offs.every(function (o) { return o.classList.contains(c); });
    });
    var attrs: [string, string | null, string | null][] = [];
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], vOn = on.getAttribute(a), vOff = offs[0].getAttribute(a);
      if (vOn !== vOff && offs.every(function (o) { return o.getAttribute(a) === vOff; })) attrs.push([a, vOn, vOff]);
    }
    var css: [string, string, string][] = [];
    var props: string[] = [];
    var st = function (e: Element) {
      return (e as HTMLElement).style || null;
    };
    var add = function (e: Element) {
      var s0 = st(e);
      for (var k = 0; s0 && k < s0.length; k++) if (props.indexOf(s0.item(k)) < 0) props.push(s0.item(k));
    };
    add(on);
    add(offs[0]);
    for (var j = 0; j < props.length; j++) {
      var p = props[j], sOn = st(on) ? st(on).getPropertyValue(p) : "", sOff = st(offs[0]) ? st(offs[0]).getPropertyValue(p) : "";
      if (sOn !== sOff && offs.every(function (o) { return (st(o) ? st(o).getPropertyValue(p) : "") === sOff; })) css.push([p, sOn, sOff]);
    }
    return function (e: Element, yes: boolean) {
      for (var a1 = 0; a1 < onCls.length; a1++) e.classList.toggle(onCls[a1], yes);
      for (var a2 = 0; a2 < offCls.length; a2++) e.classList.toggle(offCls[a2], !yes);
      for (var a3 = 0; a3 < attrs.length; a3++) {
        var v = yes ? attrs[a3][1] : attrs[a3][2];
        if (v === null) e.removeAttribute(attrs[a3][0]);
        else e.setAttribute(attrs[a3][0], v);
      }
      for (var a4 = 0; a4 < css.length; a4++) {
        var cv = yes ? css[a4][1] : css[a4][2];
        if (cv) (e as HTMLElement).style.setProperty(css[a4][0], cv);
        else (e as HTMLElement).style.removeProperty(css[a4][0]);
      }
    };
  };
  var sideScroller = function (el: Element): HTMLElement | null {
    for (var a = el.parentElement; a && a !== doc.body; a = a.parentElement) if (/auto|scroll/.test(cs(a, "overflow-x")) && a.scrollWidth > a.clientWidth + 4) return a;
    return null;
  };
  // Tabs (role="tablist"): a tab shows its panel, in the site's own selected look; arrow keys move along
  var tabLists = list("[data-sl-tabs]");
  for (var ti = 0; ti < tabLists.length; ti++)
    (function (tl: HTMLElement) {
      var tabs = list('[role="tab"]', tl).filter(function (t) {
        return t.closest('[role="tablist"]') === tl;
      });
      var panelOf = function (t: Element): HTMLElement | null {
        var id = (t.getAttribute("aria-controls") || "").split(" ")[0];
        var pn = id ? doc.getElementById(id) : null;
        if (!pn && t.id) pn = list('[role="tabpanel"][aria-labelledby]').filter(function (x) { return (" " + x.getAttribute("aria-labelledby") + " ").indexOf(" " + t.id + " ") >= 0; })[0] || null;
        return pn;
      };
      var panels = tabs.map(panelOf);
      if (tabs.length < 2 || panels.some(function (pn, k) { return !pn || panels.indexOf(pn) !== k; })) return;
      var cur = 0;
      for (var k = 0; k < tabs.length; k++) if (tabs[k].getAttribute("aria-selected") === "true" || (tabs[k] as HTMLInputElement).checked) { cur = k; break; }
      var others = function (arr: Element[]) {
        return arr.filter(function (_, k2) { return k2 !== cur; });
      };
      var tabLook = learn(tabs[cur], others(tabs));
      var wraps = tabs.map(function (t) { return t.parentElement as HTMLElement; });
      var wrapLook = wraps.every(function (w, k3) { return w && w !== tl && wraps.indexOf(w) === k3; }) ? learn(wraps[cur], others(wraps)) : null;
      var sc = sideScroller(panels[0] as HTMLElement);
      var slide = !!sc && sc.contains(panels[1]) && Math.abs((panels[0] as HTMLElement).getBoundingClientRect().left - (panels[1] as HTMLElement).getBoundingClientRect().left) > 20;
      var panLook = slide ? null : learn(panels[cur] as HTMLElement, others(panels as HTMLElement[]));
      var show = function (i: number, move: boolean) {
        for (var m = 0; m < tabs.length; m++) {
          tabLook(tabs[m], m === i);
          if (wrapLook) wrapLook(wraps[m], m === i);
          if (panLook) panLook(panels[m] as HTMLElement, m === i);
        }
        if (tabs[i] instanceof HTMLInputElement) (tabs[i] as HTMLInputElement).checked = true;
        if (slide && move && sc) sc.scrollTo({ left: sc.scrollLeft + (panels[i] as HTMLElement).getBoundingClientRect().left - sc.getBoundingClientRect().left, behavior: still ? "auto" : "smooth" });
        else if (!slide && i !== cur && !still && typeof (panels[i] as HTMLElement).animate === "function") (panels[i] as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease" });
        cur = i;
      };
      tabs.forEach(function (t, i) {
        t.addEventListener("click", function (e) {
          if (!(t instanceof HTMLInputElement)) e.preventDefault();
          if (i !== cur) show(i, true);
        });
      });
      tl.addEventListener("keydown", function (e) {
        var key = (e as KeyboardEvent).key, d = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = (cur + d + tabs.length) % tabs.length;
        show(n, true);
        tabs[n].focus();
      });
      // a gallery the visitor scrolls itself: its tabs (dots) follow
      if (slide && sc) {
        var q = false;
        sc.addEventListener("scroll", function () {
          if (q) return;
          q = true;
          win.requestAnimationFrame(function () {
            q = false;
            var left = (sc as HTMLElement).getBoundingClientRect().left, best = cur, bd = 1e9;
            for (var m = 0; m < panels.length; m++) {
              var dd = Math.abs((panels[m] as HTMLElement).getBoundingClientRect().left - left);
              if (dd < bd) { bd = dd; best = m; }
            }
            if (best !== cur) show(best, false);
          });
        }, { passive: true });
      }
    })(tabLists[ti]);
  // A sliding gallery's Previous / Next: a scroll strip scrolls to the next item, a track in a clipped
  // frame moves by one; at either end that arrow turns off (as the site's own did)
  var strips: Record<string, { el: HTMLElement; kind: string; btns: [HTMLElement, number][] }> = {};
  var sEls = list("[data-sl-scroller]");
  for (var sj = 0; sj < sEls.length; sj++) {
    var sv = (sEls[sj].getAttribute("data-sl-scroller") || "").split(":");
    strips[sv[1]] = { el: sEls[sj], kind: sv[0], btns: [] };
  }
  var pads = list("[data-sl-paddle]");
  for (var pj = 0; pj < pads.length; pj++) {
    var pv = (pads[pj].getAttribute("data-sl-paddle") || "").split(":");
    if (strips[pv[1]]) strips[pv[1]].btns.push([pads[pj], parseFloat(pv[0]) < 0 ? -1 : 1]);
  }
  for (var sid in strips)
    (function (g: { el: HTMLElement; kind: string; btns: [HTMLElement, number][] }) {
      if (!g.btns.length) return;
      var track = g.el as Element;
      if (g.kind === "track") track = g.el.children[0];
      else while (track.children.length === 1) track = track.children[0];
      var items = function () {
        return ([].slice.call(track.children) as HTMLElement[]).filter(function (it) { return it.offsetWidth > 0; });
      };
      var x = 0;
      if (g.kind === "track") {
        var mt = /matrix(3d)?\(([^)]+)\)/.exec(cs(track, "transform"));
        if (mt) {
          var nums = mt[2].split(",");
          x = parseFloat(nums[mt[1] ? 12 : 4]) || 0;
        }
      }
      var ends = function () {
        var its = items();
        if (!its.length) return;
        var r = g.el.getBoundingClientRect();
        var atStart = g.kind === "track" ? its[0].getBoundingClientRect().left >= r.left - 2 : g.el.scrollLeft <= 1;
        var atEnd = g.kind === "track" ? its[its.length - 1].getBoundingClientRect().right <= r.right + 2 : g.el.scrollLeft >= g.el.scrollWidth - g.el.clientWidth - 1;
        for (var b = 0; b < g.btns.length; b++) {
          var off = g.btns[b][1] < 0 ? atStart : atEnd, bt = g.btns[b][0];
          if (bt instanceof HTMLButtonElement) bt.disabled = off;
          bt.setAttribute("aria-disabled", off ? "true" : "false");
        }
      };
      var aim: number | null = null, aimT = 0; // where a smooth scroll is heading (quick clicks go on from there)
      var go = function (dir: number) {
        var its = items();
        if (!its.length) return;
        var r = g.el.getBoundingClientRect();
        var pad = g.kind === "track" ? 0 : parseFloat(cs(g.el, "scroll-padding-left")) || parseFloat(cs(g.el, "padding-left")) || 0;
        var base = g.kind !== "track" && aim !== null ? aim : g.el.scrollLeft;
        var lefts = its.map(function (it) { return it.getBoundingClientRect().left - r.left - pad - (base - g.el.scrollLeft); });
        var to = -1;
        if (dir > 0) { for (var i = 0; i < lefts.length; i++) if (lefts[i] > 2) { to = i; break; } }
        else for (var i2 = lefts.length - 1; i2 >= 0; i2--) if (lefts[i2] < -2) { to = i2; break; }
        var d = to >= 0 ? lefts[to] : dir * g.el.clientWidth * 0.8;
        if (g.kind === "track") {
          var lastR = its[its.length - 1].getBoundingClientRect().right - r.right, firstL = its[0].getBoundingClientRect().left - r.left;
          d = dir > 0 ? Math.min(d, Math.max(0, lastR)) : Math.max(d, Math.min(0, firstL));
          x -= d;
          (track as HTMLElement).style.transition = still ? "none" : "transform .6s cubic-bezier(.25,.8,.25,1)";
          (track as HTMLElement).style.transform = "translate3d(" + x.toFixed(1) + "px, 0px, 0px)";
          win.setTimeout(ends, still ? 0 : 650);
        } else {
          var to2 = Math.max(0, Math.min(g.el.scrollWidth - g.el.clientWidth, base + d));
          aim = to2;
          var t0 = ++aimT;
          win.setTimeout(function () { if (t0 === aimT) aim = null; }, 900);
          g.el.scrollTo({ left: to2, behavior: still ? "auto" : "smooth" });
        }
      };
      for (var b = 0; b < g.btns.length; b++)
        (function (bt: HTMLElement, dir: number) {
          bt.addEventListener("click", function (e) {
            e.preventDefault();
            go(dir);
          });
        })(g.btns[b][0], g.btns[b][1]);
      if (g.kind !== "track") g.el.addEventListener("scroll", function () { win.requestAnimationFrame(ends); }, { passive: true });
      ends();
      win.addEventListener("load", ends);
    })(strips[sid]);
  // Video play / pause buttons, and the playing / paused / ended classes the site's CSS reads
  var mvs = list("video[data-sl-media-v]") as unknown as HTMLVideoElement[];
  for (var mj = 0; mj < mvs.length; mj++)
    (function (v: HTMLVideoElement) {
      var id = v.getAttribute("data-sl-media-v");
      var uis = list('[data-sl-media-ui="' + id + '"]');
      var state = function (s1: string) {
        for (var u = 0; u < uis.length; u++) {
          uis[u].classList.remove("playing", "paused", "ended");
          uis[u].classList.add(s1);
        }
      };
      v.addEventListener("play", function () { state("playing"); });
      v.addEventListener("pause", function () { if (!v.ended) state("paused"); });
      v.addEventListener("ended", function () { state("ended"); });
      var btns = list('[data-sl-media="' + id + '"]');
      for (var bj = 0; bj < btns.length; bj++)
        btns[bj].addEventListener("click", function (e) {
          e.preventDefault();
          if (v.paused || v.ended) {
            if (v.ended) v.currentTime = 0;
            v.muted = true;
            var pr = v.play();
            if (pr && pr.catch) pr.catch(function () {});
          } else v.pause();
        });
    })(mvs[mj]);
  // Classes the page put on itself / its bars past a scroll position (recorded at capture)
  var sClsEls = list("[data-sl-scroll-classes]");
  if (sClsEls.length) {
    var sRules = sClsEls.map(function (el) {
      var r: { t: string; a: number; b: number | null }[] = [];
      try {
        r = JSON.parse(el.getAttribute("data-sl-scroll-classes") || "[]");
      } catch (e) {
        r = [];
      }
      return { el: el, r: r };
    });
    var sApply = function () {
      var y = win.scrollY || 0;
      for (var i = 0; i < sRules.length; i++)
        for (var j = 0; j < sRules[i].r.length; j++) {
          var ru = sRules[i].r[j];
          sRules[i].el.classList.toggle(ru.t, y >= ru.a && (ru.b === null || y < ru.b));
        }
    };
    var sQ = false;
    win.addEventListener("scroll", function () {
      if (sQ) return;
      sQ = true;
      win.requestAnimationFrame(function () {
        sQ = false;
        sApply();
      });
    }, { passive: true });
    sApply();
  }
  // Studio motion (edited layers) and the page's own entrances recorded at capture (data-sl-in-on)
  var all = [].slice.call(doc.querySelectorAll("[data-sl-id], [data-sl-in-on], [data-sl-hold]")) as Element[];
  var enter: Element[] = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.hasAttribute("data-sl-hold")) {
      enter.push(el);
      continue;
    }
    var on = cs(el, "--slm-on");
    if (on === "hover" && pointer) {
      var hf = cs(el, "--slm-fx");
      // the Distance field: how far it can be pulled at its edge (px) / how far it tilts there (degrees)
      if (hf === "magnet") follow(el, (parseFloat(cs(el, "--slm-dist")) || 14) / Math.max(20, el.getBoundingClientRect().width / 2), 0);
      if (hf === "tilt3d") follow(el, 0, parseFloat(cs(el, "--slm-dist")) || 10);
      continue;
    }
    if (on !== "enter" && on !== "load") continue;
    if (cs(el, "--slm-fx") === "words") split(doc, el);
    if (on === "enter") enter.push(el);
  }
  if (!enter.length || typeof (doc.documentElement as Element).getAnimations !== "function") return;
  // When is it "in view"? By where it sits in the page layout (offsetTop: no transforms, no clipping), not by
  // what shows: held at its start, an entrance is often moved away or hidden in a mask (text lines sliding up
  // inside overflow:hidden), and a visibility observer would never see it. Plays once its spot passes 88%
  // of the screen height, like a scroll trigger's "top 88%".
  var topOf = function (el: Element): number {
    var n = el as HTMLElement | null;
    while (n && typeof n.offsetTop !== "number") n = n.parentElement; // svg parts: their html box
    var y = 0;
    for (var m = n; m; m = m.offsetParent as HTMLElement | null) y += m.offsetTop || 0;
    return y;
  };
  var tops: number[] = [];
  // …or, inside a pinned section (on screen all along), at the scroll position it played at on the site
  var ats: number[] = [];
  for (var ia = 0; ia < enter.length; ia++) ats[ia] = parseFloat(enter[ia].getAttribute("data-sl-in-at") || "");
  var measure = function () {
    for (var i = 0; i < enter.length; i++) tops[i] = topOf(enter[i]);
  };
  var done: boolean[] = [];
  var check = function () {
    var y = win.scrollY || (doc.documentElement ? doc.documentElement.scrollTop : 0) || 0;
    var line = y + win.innerHeight * 0.88;
    var left = 0;
    for (var i = 0; i < enter.length; i++) {
      var el = enter[i];
      var again = cs(el, "--slm-replay") === "1";
      if (!done[i] && (ats[i] >= 0 ? y >= ats[i] - 2 : tops[i] < line)) {
        play(el);
        done[i] = true;
      } else if (done[i] && again && tops[i] > y + win.innerHeight) {
        hold(el); // gone below the screen: ready to play again
        done[i] = false;
      }
      if (!done[i] || again) left++;
    }
    if (!left) {
      win.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", onResize);
    }
  };
  var queued = false;
  var onScroll = function () {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(function () {
      queued = false;
      check();
    });
  };
  var onResize = function () {
    measure();
    onScroll();
  };
  // Every entrance starts over from its first frame (it may have played already, e.g. before a framework
  // hydrated) and is held there — all at once: one by one, each would make the browser restyle and lay
  // out the whole page again (seconds on a big page).
  var tg: HTMLElement[] = [];
  for (var k = 0; k < enter.length; k++) tg = tg.concat(targets(enter[k]));
  for (var k1 = 0; k1 < tg.length; k1++) tg[k1].style.setProperty("animation-name", "none", "important");
  void (doc.body && doc.body.offsetWidth);
  for (var k2 = 0; k2 < tg.length; k2++) tg[k2].style.removeProperty("animation-name");
  var docAnims = typeof (doc as unknown as { getAnimations?: () => Animation[] }).getAnimations === "function" ? (doc as unknown as { getAnimations: () => Animation[] }).getAnimations() : null;
  if (docAnims) {
    var held = new Set<Element>(tg);
    for (var k3 = 0; k3 < docAnims.length; k3++) {
      var an = docAnims[k3] as CSSAnimation;
      var tgt = an.effect && (an.effect as KeyframeEffect).target;
      if (tgt && held.has(tgt) && (/^(slm-|sl-in-)/.test(an.animationName || "") || (tgt.hasAttribute("data-sl-hold") && an.timeline === doc.timeline && !!an.animationName))) {
        an.pause();
        an.currentTime = 0;
      }
    }
  } else for (var k4 = 0; k4 < enter.length; k4++) hold(enter[k4]);
  measure();
  check();
  win.addEventListener("scroll", onScroll, { passive: true });
  win.addEventListener("resize", onResize);
  win.addEventListener("load", onResize); // images and fonts move things down
}
/** The runtime as a script body for an export — readable: in the extension's minified bundle this function's own
 *  text would be one unreadable line, so the readable copy made at build time (scripts/build-runtime.mjs) is used. */
export const motionRuntimeSource = () =>
  motionRuntime.name === "motionRuntime" || !READABLE_RUNTIME
    ? `(${motionRuntime.toString()})(document, window, ${splitWords.toString()});`
    : READABLE_RUNTIME;
