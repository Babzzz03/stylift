// Studio artboards show a whole page at once and never scroll: how its scroll-driven motion is shown there.

/** Every animation run by the page's scroll (a ScrollTimeline — not an element's own view() timeline) shown as it looks
 *  when its element is on screen: an artboard shows the whole page at once and never scrolls. Moved to a time clock and
 *  paused at the point of its scroll range where the page would be scrolled to bring the element to the middle of the
 *  screen (`screenH`: the artboard's screen height) — the top of the page for one fixed to the screen (a hero stage held
 *  behind the page). Not all at the top: what fades in as you scroll down would show empty (framer.com's feature grid);
 *  nor all at the end: what leaves as you scroll would show gone (monodrift.framer.website's hero panels). Called again
 *  as the page settles (pictures loading move things down): the held ones are placed again. */
const heldByScroll = new WeakSet<Animation>();
export function pageScrollInView(d: Document, screenH: number): void {
  const W = d.defaultView as (Window & typeof globalThis & { ScrollTimeline?: { new (): unknown }; ViewTimeline?: { new (): unknown } }) | null;
  if (!W?.ScrollTimeline || !d.getAnimations) return;
  const maxScroll = Math.max(0, d.documentElement.scrollHeight - screenH);
  // a scroll range's end, from the element's animation-range (px, % of the scroll, or normal)
  const at = (v: string | undefined, dflt: number) => {
    const px = /(-?[\d.]+)px/.exec(v || ""), pc = /(-?[\d.]+)%/.exec(v || "");
    return px ? parseFloat(px[1]) : pc ? (parseFloat(pc[1]) / 100) * maxScroll : dflt;
  };
  for (const a of d.getAnimations()) {
    const tl = a.timeline as unknown;
    const scrollTl = !!tl && tl instanceof W.ScrollTimeline && !(W.ViewTimeline && tl instanceof W.ViewTimeline);
    if (!scrollTl && !heldByScroll.has(a)) continue;
    const el = (a.effect as KeyframeEffect | null)?.target;
    if (!el) continue;
    try {
      const cs = W.getComputedStyle(el);
      // where the page would be scrolled to show it: the top for anything fixed to the screen
      let fixed = false;
      for (let e: Element | null = el; e && e !== d.documentElement; e = e.parentElement) if (W.getComputedStyle(e).position === "fixed") { fixed = true; break; }
      const r = el.getBoundingClientRect();
      const y = fixed ? 0 : Math.max(0, Math.min(maxScroll, r.top + W.scrollY + r.height / 2 - screenH / 2));
      // its range: the animation-range written for this animation (the same place in the comma lists as its name)
      const name = (a as Animation & { animationName?: string }).animationName;
      const i = Math.max(0, name ? cs.animationName.split(",").map((x) => x.trim()).indexOf(name) : 0);
      const pick = (list: string) => (list || "").split(",")[i]?.trim();
      const csr = cs as CSSStyleDeclaration & { animationRangeStart?: string; animationRangeEnd?: string };
      const y0 = at(pick(csr.animationRangeStart || ""), 0), yn = at(pick(csr.animationRangeEnd || ""), maxScroll);
      const p = yn > y0 ? Math.max(0, Math.min(1, (y - y0) / (yn - y0))) : y >= y0 ? 1 : 0;
      if (scrollTl) {
        a.timeline = d.timeline;
        a.effect?.updateTiming({ duration: 1000, delay: 0, iterations: 1, fill: "both" });
        a.pause();
        heldByScroll.add(a);
      }
      a.currentTime = p * 1000;
    } catch {
      /* an animation the browser won't move to another clock */
    }
  }
}
