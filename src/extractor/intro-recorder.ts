// Intro recorder. Injected at the very start of a reload (CDP Page.addScriptToEvaluateOnNewDocument, the
// page's MAIN world) so StyleLift sees the intro a site plays when it opens — hero text rising, a loader
// lifting, logos fading in — which has long finished by the time someone clicks capture.
//
// • GSAP loaded as a global: its root timeline is told to keep finished animations, so the GSAP recorder
//   (settle.ts) reads the intro exactly (start state, duration, easing, stagger) — nothing is guessed.
// • Everything else (bundled GSAP, Webflow, hand-written code, CSS transitions set off by a "loaded" class):
//   each element's most hidden / offset look and when it moved from there to where it rests are watched
//   for the first seconds; an element that came into view gets an entrance (data-sl-gsap JSON, the same
//   format the GSAP recorder writes) that the copy replays on load.
// Self-contained (serialised as text), plain enough for any page. Stops at 7 s after load, or when the
// capture asks (the "sl-gsap-record" event).
export function introRecorder(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__slIntro) return;
  // GSAP: keep finished animations
  try {
    const keep = (v: unknown) => {
      try {
        const tl = (v as { globalTimeline?: { autoRemoveChildren?: boolean } })?.globalTimeline;
        if (tl) tl.autoRemoveChildren = false;
      } catch {
        /* not GSAP */
      }
    };
    if (w.gsap) keep(w.gsap);
    else {
      let g: unknown;
      Object.defineProperty(window, "gsap", { configurable: true, enumerable: true, get: () => g, set: (v) => { g = v; keep(v); } });
    }
  } catch {
    /* the page defines gsap itself in a way we can't wrap */
  }
  // Hover handlers: the elements the page listens to for the pointer coming over them are noted (nothing
  // on the page changes) and marked only when the capture asks ("sl-hover-mark"), so it knows exactly what
  // to hover when it records the hover effects scripts play.
  try {
    const HOVER = /^(mouseenter|mouseover|pointerenter|pointerover)$/;
    const listening = new Set<Element>();
    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    proto.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      try {
        if (HOVER.test(type) && this instanceof Element && listening.size < 3000 && this !== document.documentElement && this !== document.body) listening.add(this);
      } catch {
        /* never in the page's way */
      }
      return (add as (...a: unknown[]) => void).apply(this, [type, ...rest]);
    } as typeof proto.addEventListener;
    add.call(document, "sl-hover-mark", () => {
      for (const el of listening) if (el.isConnected) el.setAttribute("data-sl-hl", "");
    });
  } catch {
    /* a page that froze EventTarget */
  }
  // 3D scenes: the canvases the page asks for a WebGL context (or hands to a worker to draw in) are noted
  // (nothing on the page changes) and marked data-sl-gl when the capture asks ("sl-gl-mark"), so an export
  // can keep them live — the site's own code drawing them — instead of a picture.
  try {
    const gl = new Map<HTMLCanvasElement, string>();
    const cp = HTMLCanvasElement.prototype;
    const getCtx = cp.getContext;
    cp.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (getCtx as (...a: unknown[]) => unknown).apply(this, [type, ...rest]);
      try {
        if (ctx && /^(webgl2?|experimental-webgl|webgpu)$/.test(String(type)) && gl.size < 50) gl.set(this, String(type));
      } catch {
        /* never in the page's way */
      }
      return ctx;
    } as typeof cp.getContext;
    const toOff = (cp as unknown as { transferControlToOffscreen?: () => unknown }).transferControlToOffscreen;
    if (toOff)
      (cp as unknown as { transferControlToOffscreen: () => unknown }).transferControlToOffscreen = function (this: HTMLCanvasElement) {
        try {
          if (gl.size < 50) gl.set(this, "offscreen");
        } catch {
          /* never in the page's way */
        }
        return toOff.apply(this);
      };
    document.addEventListener("sl-gl-mark", () => {
      for (const [c, t] of gl) if (c.isConnected) c.setAttribute("data-sl-gl", t);
    });
  } catch {
    /* a page that froze the canvas prototype */
  }
  type Look = { o: number; tf: string; fi: string; c: string; hidden: boolean };
  const look = (el: Element): Look => {
    const c = getComputedStyle(el);
    const o = parseFloat(c.opacity);
    return { o: isNaN(o) ? 1 : o, tf: c.transform, fi: c.filter, c: c.clipPath, hidden: c.visibility === "hidden" };
  };
  const restingTf = (t: string) => {
    if (!t || t === "none") return true;
    const m = /^matrix(3d)?\(([^)]+)\)$/.exec(t);
    if (!m) return false;
    const n = m[2].split(",").map((x) => parseFloat(x));
    const v = m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n;
    return Math.abs(v[0] - 1) < 0.01 && Math.abs(v[3] - 1) < 0.01 && Math.abs(v[1]) < 0.01 && Math.abs(v[2]) < 0.01 && Math.abs(v[4]) < 0.5 && Math.abs(v[5]) < 0.5;
  };
  const restingClip = (c: string) => !c || c === "none" || /^inset\(\s*0(px|%)?(\s+0(px|%)?){0,3}\s*\)$/.test(c);
  const score = (v: Look) => v.o + (restingTf(v.tf) ? 0.4 : 0) + (v.fi === "none" ? 0.1 : 0) + (restingClip(v.c) ? 0.2 : 0) + (v.hidden ? -1 : 0);
  type Rec = { min: Look; minT: number; moveT: number; lastT: number; viaClass: boolean; max: Look };
  const track = new Map<Element, Rec>();
  // What the page SHOWED after it had been hidden (an intro's tagline fading in) — at page start and at every
  // change since. One that is hidden again at the end went away: it rests hidden. (Content the page merely
  // hides until it is scrolled to goes visible → hidden and stays: never "shown after hidden".) Kept apart from
  // the full tracking above, which a big page fills with what starts hidden.
  const shown = new Map<Element, { hid: boolean; back: boolean; vis: boolean }>();
  // when something last appeared or went away: the capture waits for a quiet moment after the intro
  let lastFlip = 0;
  const noteShown = (el: Element, o: number) => {
    let s0 = shown.get(el);
    if (!s0) {
      if (shown.size >= 20000) return;
      shown.set(el, (s0 = { hid: false, back: false, vis: o >= 0.5 }));
      return void (o < 0.05 && (s0.hid = true));
    }
    if (o < 0.05) s0.hid = true;
    else if (o >= 0.5 && s0.hid) s0.back = true;
    const vis = o < 0.05 ? false : o >= 0.5 ? true : s0.vis;
    if (vis !== s0.vis) {
      s0.vis = vis;
      lastFlip = performance.now();
    }
  };
  const lastAt = new WeakMap<Element, number>();
  let on = true;
  let watching = true; // the shown → hidden watch lasts the whole intro: until the capture starts scrolling
  let readyT = 0;
  const sample = (el: Element, now: number, viaClass = false) => {
    if (!on || track.size > 4000 || el === document.documentElement || el === document.body) return;
    const v = look(el);
    const r = track.get(el);
    if (!r) {
      track.set(el, { min: v, minT: now, moveT: -1, lastT: now, viaClass, max: v });
      return;
    }
    if (score(v) > score(r.max)) r.max = v;
    if (score(v) < score(r.min) - 0.01) {
      r.min = v;
      r.minT = now;
      r.moveT = -1;
    } else if (r.moveT < 0 && score(v) > score(r.min) + 0.05) r.moveT = now;
    r.lastT = now;
    if (viaClass) r.viaClass = true;
  };
  const mo = new MutationObserver((recs) => {
    const now = performance.now();
    for (const rec of recs) {
      const el = rec.target;
      if (!(el instanceof Element)) continue;
      if (now - (lastAt.get(el) || 0) > 30) {
        lastAt.set(el, now);
        sample(el, now);
        if (watching) noteShown(el, look(el).o);
      }
      // a class on a section / the page ("is-loaded"): its children animate through CSS
      if (rec.attributeName === "class") {
        const kids = el.getElementsByTagName("*");
        for (let i = 0; i < kids.length && i < 300; i++) if (track.has(kids[i])) sample(kids[i], now, true);
      }
    }
  });
  mo.observe(document, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
  // the look of everything once the page has built itself: what starts hidden / offset
  const snapshot = () => {
    readyT = performance.now();
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (/^(script|style|link|meta|noscript|template|br)$/i.test(el.localName)) continue;
      const v = look(el);
      noteShown(el, v.hidden ? 0 : v.o);
      if (v.o < 0.5 || !restingTf(v.tf) || v.fi !== "none" || !restingClip(v.c) || v.hidden) sample(el, readyT);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", snapshot, { once: true });
  else snapshot();
  // Shown by the page after being hidden, and hidden again: it went away (an intro's tagline, a loader's
  // words) — not an entrance that never ran. Decided when the capture starts its scroll pass (it says so:
  // "sl-exits") — an intro that waits for its media can end well after the first seconds; the page's own
  // scrolling while it loads (scroll restored on reload, a smooth scroller resetting to the top) doesn't count.
  const exits = () => {
    if (!watching) return;
    watching = false;
    if (!on) mo.disconnect();
    for (const [el, s0] of shown) {
      if (!s0.back || !el.isConnected || el === document.documentElement || el === document.body) continue;
      const v = look(el);
      if (v.o < 0.05 || v.hidden) {
        el.setAttribute("data-sl-exited", "");
        el.removeAttribute("data-sl-gsap"); // its entrance (seen at 7 s) is over: it rests hidden
      }
    }
    shown.clear();
  };
  const finish = () => {
    if (!on) return;
    on = false;
    if (!watching) mo.disconnect();
    const gsapGlobal = !!w.gsap;
    for (const [el, r] of track) {
      if (!el.isConnected || el.hasAttribute("data-sl-exited")) continue;
      if (el.hasAttribute("data-sl-gsap")) continue;
      if (gsapGlobal && (el as unknown as { _gsap?: unknown })._gsap) continue; // GSAP's own record is exact
      const v = look(el);
      if (v.o < 0.5 || v.hidden || score(v) < score(r.min) + 0.3) continue; // not something that came in
      // its OWN look changed (a fade, a slide, a wipe, a blur) — not just visibility it inherits from a page
      // that hides itself while loading (that moves nothing, and would replace the element's real reveal)
      const ownChange = r.min.o < v.o - 0.2 || !restingTf(r.min.tf) || (r.min.fi !== "none" && r.min.fi !== v.fi) || (!restingClip(r.min.c) && r.min.c !== v.c);
      if (!ownChange) continue;
      const start = r.moveT > 0 ? r.moveT : r.minT;
      let d = r.lastT - start;
      // set off by a class: the element only changed once — its CSS transition says how long it took
      const cs = getComputedStyle(el);
      if (d < 120 || r.viaClass) {
        const secs = (s: string) => Math.max(0, ...s.split(",").map((x) => (/ms$/.test(x.trim()) ? parseFloat(x) / 1000 : parseFloat(x) || 0)));
        const td = (secs(cs.transitionDuration) + secs(cs.transitionDelay)) * 1000;
        if (td > d) d = td;
      }
      d = Math.max(250, Math.min(4000, Math.round(d)));
      const below = el.getBoundingClientRect().top + scrollY > innerHeight * 0.9;
      el.setAttribute(
        "data-sl-gsap",
        JSON.stringify({
          f: { o: String(r.min.o), t: r.min.tf || "none", tr: "none", s: "none", r: "none", fi: r.min.fi || "none", c: r.min.c || "none" },
          d,
          // below the first screen it plays as it comes into view: a delay counted from the page's load
          // (the moment its script set things up) would hold it back for seconds there
          dl: below ? 0 : Math.max(0, Math.min(5000, Math.round(start - (readyT || start)))),
          e: "cubic-bezier(.22,1,.36,1)",
          tr: below ? "scroll" : "load",
        }),
      );
    }
  };
  addEventListener("load", () => { setTimeout(finish, 7000); setTimeout(exits, 60000); }, { once: true });
  document.addEventListener("sl-exits", exits);
  document.addEventListener("sl-gsap-record", () => { exits(); finish(); });
  // how long nothing has appeared or gone away (the panel waits for the intro to be over before capturing)
  w.__slIntro = { finish, quiet: () => performance.now() - lastFlip };
}
export const introRecorderSource = () => `(${introRecorder.toString()})();`;
