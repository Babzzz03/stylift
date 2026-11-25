// Framer appear animations → plain CSS. Framer ships each page's entrance
// animations as JSON in <script type="framer/appear" id="__framer__appearAnimationsContent">:
//   { [appearId]: { default: { initial, animate }, [breakpointHash]: { initial, animate } } }
// with breakpoints in #__framer__breakpoints: [{ hash, mediaQuery }].
// We compile that into @keyframes + rules on [data-framer-appear-id], so an
// exported page replays the same entrance animations with NO Framer runtime.
// Springs become CSS linear() easings sampled from a damped-spring curve.
//
// This module is imported by capture.ts and bundled into the injected function,
// so it must stay dependency-free and side-effect free.

type Num = number | string;
interface MotionState {
  [k: string]: Num | MotionTransition | undefined;
  transition?: MotionTransition;
}
interface MotionTransition {
  type?: string; // "spring" | "tween" | "inertia"
  duration?: number; // seconds
  delay?: number; // seconds
  bounce?: number; // 0..1
  ease?: number[] | string;
  stiffness?: number;
  damping?: number;
  mass?: number;
}
interface Variant {
  initial?: MotionState;
  animate?: MotionState;
}

const px = (v: Num) => (typeof v === "number" ? `${round(v)}px` : v);
const deg = (v: Num) => (typeof v === "number" ? `${round(v)}deg` : v);
const round = (n: number) => Math.round(n * 1000) / 1000;

export function motionToCss(state: MotionState | undefined): string {
  if (!state) return "";
  const t: string[] = [];
  const g = (k: string) => state[k] as Num | undefined;
  const x = g("x"), y = g("y"), z = g("z");
  if ((x !== undefined && x !== 0) || (y !== undefined && y !== 0) || (z !== undefined && z !== 0)) {
    t.push(z !== undefined && z !== 0 ? `translate3d(${px(x ?? 0)}, ${px(y ?? 0)}, ${px(z)})` : `translate(${px(x ?? 0)}, ${px(y ?? 0)})`);
  }
  const sc = g("scale"), sx = g("scaleX"), sy = g("scaleY");
  if (sc !== undefined && sc !== 1) t.push(`scale(${sc})`);
  if (sx !== undefined && sx !== 1) t.push(`scaleX(${sx})`);
  if (sy !== undefined && sy !== 1) t.push(`scaleY(${sy})`);
  for (const [k, fn] of [["rotate", "rotate"], ["rotateX", "rotateX"], ["rotateY", "rotateY"], ["rotateZ", "rotateZ"], ["skewX", "skewX"], ["skewY", "skewY"]] as const) {
    const v = g(k);
    if (v !== undefined && v !== 0) t.push(`${fn}(${deg(v)})`);
  }
  const out: string[] = [];
  const op = g("opacity");
  if (op !== undefined) out.push(`opacity: ${op}`);
  out.push(`transform: ${t.length ? t.join(" ") : "none"}`);
  for (const k of ["filter", "clipPath", "backgroundColor", "color", "borderRadius"]) {
    const v = g(k);
    if (v !== undefined) out.push(`${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${typeof v === "number" && k === "borderRadius" ? px(v) : v}`);
  }
  const persp = g("transformPerspective");
  if (persp !== undefined) out[out.length - 1 - (out.length > 1 ? 0 : 0)] += "";
  return out.join("; ");
}

/** Damped-spring progress curve → CSS linear() easing. */
export function springEasing(tr: MotionTransition): { easing: string; duration: number } {
  let zeta: number, omega: number, duration: number;
  if (tr.stiffness !== undefined || tr.damping !== undefined) {
    const k = tr.stiffness ?? 100, c = tr.damping ?? 10, m = tr.mass ?? 1;
    omega = Math.sqrt(k / m);
    zeta = c / (2 * Math.sqrt(k * m));
    duration = Math.min(4, Math.max(0.2, 5.3 / (Math.max(zeta, 0.05) * omega)));
  } else {
    duration = tr.duration ?? 0.4;
    zeta = Math.min(1, Math.max(0.05, 1 - (tr.bounce ?? 0.25)));
    omega = 5.3 / (zeta * duration); // envelope e^(-ζωt) ≈ 0.5% at t = duration
  }
  const pos = (t: number): number => {
    if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
  };
  const N = 40;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) pts.push(String(round(i === N ? 1 : pos((i / N) * duration))));
  return { easing: `linear(${pts.join(", ")})`, duration };
}

const NAMED_EASE: Record<string, string> = {
  linear: "linear", easeIn: "ease-in", easeOut: "ease-out", easeInOut: "ease-in-out",
  circIn: "cubic-bezier(0.55, 0, 1, 0.45)", circOut: "cubic-bezier(0, 0.55, 0.45, 1)", circInOut: "cubic-bezier(0.85, 0, 0.15, 1)",
  backIn: "cubic-bezier(0.31, 0.01, 0.66, -0.59)", backOut: "cubic-bezier(0.33, 1.53, 0.69, 0.99)", backInOut: "cubic-bezier(0.68, -0.6, 0.32, 1.6)",
  anticipate: "cubic-bezier(0.68, -0.6, 0.32, 1.6)",
};
export function timing(tr: MotionTransition | undefined): { easing: string; duration: number; delay: number } {
  const t = tr || {};
  const delay = t.delay ?? 0;
  if (t.type === "spring" || (t.type === undefined && (t.bounce !== undefined || t.stiffness !== undefined))) {
    const s = springEasing(t);
    return { ...s, delay };
  }
  let easing = "ease";
  if (Array.isArray(t.ease) && t.ease.length === 4) easing = `cubic-bezier(${t.ease.map(round).join(", ")})`;
  else if (typeof t.ease === "string") easing = NAMED_EASE[t.ease] || "ease";
  return { easing, duration: t.duration ?? 0.3, delay };
}

const cssId = (s: string) => s.replace(/[^\w-]/g, "_");

export interface FramerAppearCompiled {
  css: string;
  count: number;
}

/** Compile Framer's appear JSON (+ breakpoints) into CSS. */
export function compileFramerAppear(json: string, breakpointsJson?: string): FramerAppearCompiled {
  let data: Record<string, Record<string, Variant>>;
  try {
    data = JSON.parse(json);
  } catch {
    return { css: "", count: 0 };
  }
  const bp = new Map<string, string>();
  try {
    for (const b of JSON.parse(breakpointsJson || "[]") as { hash: string; mediaQuery: string }[]) bp.set(b.hash, b.mediaQuery);
  } catch {
    /* no breakpoints */
  }
  const keyframes: string[] = [];
  const base: string[] = [];
  const media = new Map<string, string[]>();
  let count = 0;
  for (const [id, variants] of Object.entries(data || {})) {
    if (!variants || typeof variants !== "object") continue;
    const sel = `[data-framer-appear-id="${id.replace(/"/g, "")}"]`;
    for (const [hash, v] of Object.entries(variants)) {
      if (!v || !v.initial || !v.animate) continue;
      const name = `sl-appear-${cssId(id)}-${cssId(hash)}`;
      const from = motionToCss(v.initial);
      const to = motionToCss(v.animate);
      if (!from && !to) continue;
      const tm = timing(v.animate.transition);
      keyframes.push(`@keyframes ${name} { from { ${from}; } to { ${to}; } }`);
      const rule = `${sel} { animation: ${name} ${round(tm.duration)}s ${tm.easing} ${round(tm.delay)}s both; }`;
      if (hash === "default") base.push(rule);
      else {
        const mq = bp.get(hash);
        if (!mq) continue;
        if (!media.has(mq)) media.set(mq, []);
        media.get(mq)!.push(rule);
      }
      count++;
    }
  }
  if (!count) return { css: "", count: 0 };
  let css = `/* Framer appear animations, compiled to CSS by StyleLift (no Framer runtime needed) */\n`;
  css += `@media (prefers-reduced-motion: no-preference) {\n${keyframes.join("\n")}\n${base.join("\n")}\n`;
  for (const [mq, rules] of media) css += `@media ${mq} {\n${rules.join("\n")}\n}\n`;
  css += `}\n`;
  return { css, count };
}

/** Insert compiled appear CSS (+ the inert source JSON) into a captured document.
 *  String-based so it runs in the panel and in node tests alike. */
export function applyFramerAppear(r: { html: string; stats: { appearAnimations?: number }; framerAppear?: { json: string; breakpoints?: string } }): void {
  if (!r.framerAppear) return;
  const { css, count } = compileFramerAppear(r.framerAppear.json, r.framerAppear.breakpoints);
  if (!count) return;
  const safeJson = r.framerAppear.json.replace(/<\/(script)/gi, "<\\/$1");
  const block =
    `<style data-sl-framer-appear="${count}">\n${css}</style>\n` +
    `<script type="application/json" data-sl-framer-appear-source="">${safeJson}</script>\n`;
  const i = r.html.search(/<\/head\s*>/i);
  r.html = i === -1 ? block + r.html : r.html.slice(0, i) + block + r.html.slice(i);
  r.stats.appearAnimations = count;
  delete r.framerAppear;
}
