// Animation settling. Injected into the page's MAIN world (world: "MAIN") just
// before capturePage, because animation libraries live on the page's window,
// which the extension's isolated world cannot see. Self-contained function.
//
// It fast-forwards everything to its end state so the capture freezes the
// *final* frame, not a mid-flight one:
//   • Web Animations API / CSS transitions → finish() (infinite ones are skipped),
//   • GSAP tweens & timelines (incl. ScrollTrigger-driven) → progress(1),
//   • anime.js / motion-one: nothing to do (they drive WAAPI or inline styles
//     that are already covered by the capture's quiescence wait).

export interface SettleResult {
  waapi: number;
  gsap: number;
  libs: string[];
}

export function settleAnimations(): SettleResult {
  const out: SettleResult = { waapi: 0, gsap: 0, libs: [] };
  const w = window as unknown as Record<string, unknown>;
  // Live mirror: remember every file the page loads from now on (the capture's scroll pass
  // triggers lazy 3D models, textures, chunks). Browsers keep ~250 entries by default.
  try {
    if (!w.__slResources) {
      const seen = new Set<string>();
      w.__slResources = seen;
      for (const e of performance.getEntriesByType("resource")) seen.add(e.name);
      performance.setResourceTimingBufferSize?.(20000);
      new PerformanceObserver((list) => { for (const e of list.getEntries()) seen.add(e.name); }).observe({ type: "resource", buffered: true });
    }
  } catch {
    /* no resource timing */
  }
  try {
    for (const a of document.getAnimations()) {
      try {
        // scroll- / view-driven animations are *state*, not motion: finishing them
        // would freeze the page in its scrolled-to-the-end look. Paused ones are
        // intentionally paused (hover effects etc.). Only running, finite,
        // time-based animations are fast-forwarded.
        const tl = a.timeline as AnimationTimeline | null;
        if (tl && !(tl instanceof DocumentTimeline)) continue;
        if (a.playState !== "running") continue;
        const eff = a.effect as KeyframeEffect | null;
        const t = eff?.getTiming ? eff.getTiming() : null;
        if (!t || t.iterations === Infinity) continue; // looping decoration — leave it
        const total = (Number(t.delay) || 0) + (Number(t.duration) || 0) * (Number(t.iterations) || 1);
        if (total > 15000) continue;
        a.finish();
        out.waapi++;
      } catch {
        /* finish() throws for some edge cases */
      }
    }
  } catch {
    /* no WAAPI */
  }
  const gsap = w.gsap as { globalTimeline?: { getChildren(a: boolean, b: boolean, c: boolean): unknown[] } } | undefined;
  // Before fast-forwarding, write down what each GSAP animation DOES, on its elements (data-sl-gsap /
  // data-sl-gsap-loop, JSON): where it starts (progress 0), where it ends, how long it takes, its delay
  // in its timeline plus its stagger step, its easing, and whether a scroll trigger starts it. The copy
  // replays that with CSS, without GSAP. Scrubbed ones (tied to the scroll position) are left to the
  // capture's scroll sampling.
  // Before fast-forwarding, write down what each GSAP animation DOES, on its elements (data-sl-gsap /
  // data-sl-gsap-loop, JSON): where it starts (progress 0), where it ends, how long it takes, its delay
  // in its timeline plus its stagger step, its easing, and whether a scroll trigger starts it. The copy
  // replays that with CSS, without GSAP. Scrubbed ones (tied to the scroll position) are left to the
  // capture's scroll sampling. The capture asks again right before it copies the page (a DOM event
  // reaches this world): animations made while it scrolled (ScrollTrigger.batch onEnter) are new then.
  const recordGsap = (): number => {
    const g = w.gsap as { globalTimeline?: { getChildren(a: boolean, b: boolean, c: boolean): unknown[] }; defaults?: () => { ease?: unknown } } | undefined;
    if (!g?.globalTimeline) return 0;
    let written = 0;
    try {
      type GTw = {
        targets?: () => unknown[];
        progress: (p?: number, suppress?: boolean) => number;
        duration: () => number;
        delay: () => number;
        startTime: () => number;
        repeat?: () => number;
        yoyo?: () => boolean;
        vars?: { ease?: unknown; stagger?: unknown; repeat?: number; yoyo?: boolean; defaults?: { ease?: unknown } };
        parent?: GTw | null;
        paused?: () => boolean;
        scrollTrigger?: { vars?: { scrub?: unknown } };
      };
      const root = g.globalTimeline as unknown as GTw;
      const look = (el: Element) => {
        const c = getComputedStyle(el);
        return { o: c.opacity, t: c.transform, tr: c.translate, s: c.scale, r: c.rotate, fi: c.filter, c: c.clipPath };
      };
      type Look = ReturnType<typeof look>;
      const same = (a: Look, b: Look) => Math.abs(parseFloat(a.o) - parseFloat(b.o)) < 0.05 && a.t === b.t && a.tr === b.tr && a.s === b.s && a.r === b.r && a.fi === b.fi && a.c === b.c;
      // GSAP's easings as CSS curves (closest match; GSAP's default is power1.out)
      const CURVE: Record<string, [string, string, string]> = {
        // name: [in, out, inOut]
        power1: ["cubic-bezier(.55,.085,.68,.53)", "cubic-bezier(.25,.46,.45,.94)", "cubic-bezier(.455,.03,.515,.955)"],
        quad: ["cubic-bezier(.55,.085,.68,.53)", "cubic-bezier(.25,.46,.45,.94)", "cubic-bezier(.455,.03,.515,.955)"],
        power2: ["cubic-bezier(.55,.055,.675,.19)", "cubic-bezier(.215,.61,.355,1)", "cubic-bezier(.645,.045,.355,1)"],
        cubic: ["cubic-bezier(.55,.055,.675,.19)", "cubic-bezier(.215,.61,.355,1)", "cubic-bezier(.645,.045,.355,1)"],
        power3: ["cubic-bezier(.895,.03,.685,.22)", "cubic-bezier(.165,.84,.44,1)", "cubic-bezier(.77,0,.175,1)"],
        quart: ["cubic-bezier(.895,.03,.685,.22)", "cubic-bezier(.165,.84,.44,1)", "cubic-bezier(.77,0,.175,1)"],
        power4: ["cubic-bezier(.755,.05,.855,.06)", "cubic-bezier(.23,1,.32,1)", "cubic-bezier(.86,0,.07,1)"],
        quint: ["cubic-bezier(.755,.05,.855,.06)", "cubic-bezier(.23,1,.32,1)", "cubic-bezier(.86,0,.07,1)"],
        strong: ["cubic-bezier(.755,.05,.855,.06)", "cubic-bezier(.23,1,.32,1)", "cubic-bezier(.86,0,.07,1)"],
        expo: ["cubic-bezier(.95,.05,.795,.035)", "cubic-bezier(.19,1,.22,1)", "cubic-bezier(1,0,0,1)"],
        circ: ["cubic-bezier(.6,.04,.98,.335)", "cubic-bezier(.075,.82,.165,1)", "cubic-bezier(.785,.135,.15,.86)"],
        sine: ["cubic-bezier(.47,0,.745,.715)", "cubic-bezier(.39,.575,.565,1)", "cubic-bezier(.445,.05,.55,.95)"],
        back: ["cubic-bezier(.6,-.28,.735,.045)", "cubic-bezier(.175,.885,.32,1.275)", "cubic-bezier(.68,-.55,.265,1.55)"],
        elastic: ["cubic-bezier(.6,-.28,.735,.045)", "cubic-bezier(.175,.885,.32,1.275)", "cubic-bezier(.68,-.55,.265,1.55)"],
      };
      const easeCss = (e: unknown): string => {
        if (typeof e !== "string") return CURVE.power1[1];
        const m = /^(\w+)(?:\.(in|out|inOut))?/.exec(e.trim());
        if (!m) return CURVE.power1[1];
        const name = m[1].toLowerCase();
        if (name === "none" || name === "linear") return "linear";
        const c = CURVE[name] || CURVE.power1;
        return m[2] === "in" ? c[0] : m[2] === "inOut" ? c[2] : c[1];
      };
      // a tween's easing: its own, else its timelines' defaults, else GSAP's global default
      const easeOf = (t: GTw): unknown => {
        if (t.vars?.ease !== undefined) return t.vars.ease;
        for (let a = t.parent; a && a !== root; a = a.parent) if (a.vars?.defaults?.ease !== undefined) return a.vars.defaults.ease;
        try {
          return g.defaults?.()?.ease;
        } catch {
          return undefined;
        }
      };
      const triggerOf = (t: GTw) => {
        for (let a: GTw | null | undefined = t; a && a !== root; a = a.parent) if (a.scrollTrigger) return a.scrollTrigger;
        return null;
      };
      // Reading a tween means jumping it to its start and end. Several tweens on one element (an intro, then
      // a hover in and out) would leave it wherever the last jump put it: every element read is put back
      // exactly as it was, at the end.
      const kept = new Map<Element, string | null>();
      // where a tween sits on GSAP's root timeline (nested ones: their outermost timeline)
      const rootStart = (t: GTw): number => {
        let a: GTw = t;
        while (a.parent && a.parent !== root) a = a.parent;
        return a.startTime();
      };
      const hoverAt = typeof w.__slHoverAt === "number" ? (w.__slHoverAt as number) : Infinity;
      try {
      for (const child of g.globalTimeline.getChildren(true, true, false)) {
        const t = child as GTw;
        if (written > 2500 || typeof t.targets !== "function") continue;
        // made while StyleLift hovered things to record their hover effects: not page motion
        if (rootStart(t) >= hoverAt - 0.001) continue;
        const els = t.targets().filter((x): x is Element => x instanceof Element && !x.hasAttribute("data-sl-gsap") && !x.hasAttribute("data-sl-gsap-loop")).slice(0, 600);
        if (!els.length) continue;
        const st = triggerOf(t);
        if (st?.vars?.scrub) continue; // follows the scroll position: sampled by the capture's scroll pass
        // paused with no scroll trigger = waits for a click or hover (a menu, a hover effect): not page motion
        let held = false;
        for (let a: GTw | null | undefined = t; a && a !== root; a = a.parent) if (a.paused?.()) held = true;
        if (held && !st) continue;
        const rep = typeof t.repeat === "function" ? t.repeat() : t.vars?.repeat ?? 0;
        for (const el of els) if (!kept.has(el)) kept.set(el, el.getAttribute("style"));
        const p0 = t.progress();
        t.progress(0, true);
        const from = els.map(look);
        t.progress(1, true);
        const to = els.map(look);
        t.progress(p0, true);
        // where it starts in its timeline (a scroll trigger or an intro timeline): its own delay when alone
        let at = 0;
        if (t.parent === root || !t.parent) at = t.delay();
        else for (let a: GTw | null | undefined = t; a && a.parent && a.parent !== root; a = a.parent) at += a.startTime();
        const sv = t.vars?.stagger as number | { each?: number; amount?: number; from?: string | number } | undefined;
        const n = els.length;
        let each = 0, fromWhere: string | number = "start";
        if (typeof sv === "number") each = sv;
        else if (sv && typeof sv === "object") {
          each = sv.each ?? (sv.amount != null && n > 1 ? sv.amount / (n - 1) : 0);
          fromWhere = sv.from ?? "start";
        }
        const dur = Math.round(Math.max(0.05, t.duration()) * 1000);
        const ease = easeCss(easeOf(t));
        els.forEach((el, i) => {
          if (same(from[i], to[i])) return;
          const k =
            typeof fromWhere === "number" ? Math.abs(i - fromWhere)
            : fromWhere === "end" ? n - 1 - i
            : fromWhere === "center" ? Math.abs(i - (n - 1) / 2)
            : fromWhere === "edges" ? (n - 1) / 2 - Math.abs(i - (n - 1) / 2)
            : i;
          // below the first screen = it plays when it comes into view (a trigger, or made on enter by
          // ScrollTrigger.batch); on the first screen with no trigger = an intro that plays on load
          const below = el.getBoundingClientRect().top + scrollY > innerHeight * 0.9;
          const spec: Record<string, unknown> = { f: from[i], d: dur, dl: Math.round((at + each * k) * 1000), e: ease, tr: st || below ? "scroll" : "load" };
          if (rep === -1) el.setAttribute("data-sl-gsap-loop", JSON.stringify({ ...spec, to: to[i], yoyo: typeof t.yoyo === "function" ? t.yoyo() : !!t.vars?.yoyo }));
          else el.setAttribute("data-sl-gsap", JSON.stringify(spec)); // the first one that moves it
          written++;
        });
      }
      } finally {
        for (const [el, st] of kept) {
          if (el.getAttribute("style") === st) continue;
          if (st === null) el.removeAttribute("style");
          else el.setAttribute("style", st);
        }
      }
    } catch {
      /* a GSAP build without these methods: nothing recorded */
    }
    return written;
  };
  // Webflow Interactions (IX2): the page holds every interaction as data (trigger, targets, steps with
  // duration / delay / easing). Converted, not guessed: hover → :hover CSS (Webflow's in and out timings,
  // only on the breakpoints it runs on), page load / scroll into view → entrances (data-sl-gsap, replayed
  // like GSAP's), while scrolling / page scroll → keyframes on the scroll position. Hover / scroll CSS
  // travels to the copy on <html data-sl-wf-css> (the live page itself is never restyled).
  const recordWebflow = (): number => {
    type Item = { actionTypeId?: string; config?: Record<string, any> };
    type Group = { actionItems?: Item[]; keyframe?: number };
    type List = { actionItemGroups?: Group[]; useFirstGroupAsInitialState?: boolean; continuousParameterGroups?: { type?: string; continuousActionGroups?: Group[] }[] };
    type Ev = { eventTypeId?: string; action?: { config?: { actionListId?: string; delay?: number } }; target?: { selector?: string; id?: string; appliesTo?: string }; mediaQueries?: string[]; config?: Record<string, any> };
    let ix: { events?: Record<string, Ev>; actionLists?: Record<string, List> } | undefined;
    try {
      const W = w.Webflow as { require?: (m: string) => { store?: { getState?: () => { ixData?: typeof ix } } } } | undefined;
      ix = W?.require?.("ix2")?.store?.getState?.()?.ixData;
    } catch {
      return 0;
    }
    if (!ix?.events || !ix.actionLists) return 0;
    // easings.net curves for Webflow's easing names
    const EASE: Record<string, string> = {
      "": "ease", ease: "ease", easeIn: "ease-in", easeOut: "ease-out", easeInOut: "ease-in-out", linear: "linear",
      inQuad: "cubic-bezier(.11,0,.5,0)", outQuad: "cubic-bezier(.5,1,.89,1)", inOutQuad: "cubic-bezier(.45,0,.55,1)",
      inCubic: "cubic-bezier(.32,0,.67,0)", outCubic: "cubic-bezier(.33,1,.68,1)", inOutCubic: "cubic-bezier(.65,0,.35,1)",
      inQuart: "cubic-bezier(.5,0,.75,0)", outQuart: "cubic-bezier(.25,1,.5,1)", inOutQuart: "cubic-bezier(.76,0,.24,1)",
      inQuint: "cubic-bezier(.64,0,.78,0)", outQuint: "cubic-bezier(.22,1,.36,1)", inOutQuint: "cubic-bezier(.83,0,.17,1)",
      inSine: "cubic-bezier(.12,0,.39,0)", outSine: "cubic-bezier(.61,1,.88,1)", inOutSine: "cubic-bezier(.37,0,.63,1)",
      inExpo: "cubic-bezier(.7,0,.84,0)", outExpo: "cubic-bezier(.16,1,.3,1)", inOutExpo: "cubic-bezier(.87,0,.13,1)",
      inCirc: "cubic-bezier(.55,0,1,.45)", outCirc: "cubic-bezier(0,.55,.45,1)", inOutCirc: "cubic-bezier(.85,0,.15,1)",
      inBack: "cubic-bezier(.36,0,.66,-.56)", outBack: "cubic-bezier(.34,1.56,.64,1)", inOutBack: "cubic-bezier(.68,-.6,.32,1.6)",
    };
    const ease = (e: unknown) => EASE[String(e ?? "")] || "ease";
    const unit = (u: unknown, dflt = "px") => {
      const x = String(u || "").toUpperCase();
      return x === "%" ? "%" : x === "VW" ? "vw" : x === "VH" ? "vh" : x === "EM" ? "em" : x === "REM" ? "rem" : x === "DEG" ? "deg" : x === "RAD" ? "rad" : x === "TURN" ? "turn" : dflt;
    };
    // the look a list of steps leaves behind, as CSS (Webflow composes transforms in this order)
    type Look = { mv?: string[]; sc?: number[]; ro?: string[]; sk?: string[]; op?: number; blur?: string; bg?: string; color?: string };
    const apply = (look: Look, it: Item) => {
      const c = it.config || {};
      const n = (v: unknown, d: number) => (typeof v === "number" ? v : d);
      switch (it.actionTypeId) {
        case "TRANSFORM_MOVE": look.mv = [`${n(c.xValue, 0)}${unit(c.xUnit)}`, `${n(c.yValue, 0)}${unit(c.yUnit)}`, `${n(c.zValue, 0)}${unit(c.zUnit)}`]; break;
        case "TRANSFORM_SCALE": look.sc = [n(c.xValue, 1), n(c.yValue, 1), n(c.zValue, 1)]; break;
        case "TRANSFORM_ROTATE": look.ro = [`${n(c.xValue, 0)}${unit(c.xUnit, "deg")}`, `${n(c.yValue, 0)}${unit(c.yUnit, "deg")}`, `${n(c.zValue, 0)}${unit(c.zUnit, "deg")}`]; break;
        case "TRANSFORM_SKEW": look.sk = [`${n(c.xValue, 0)}${unit(c.xUnit, "deg")}`, `${n(c.yValue, 0)}${unit(c.yUnit, "deg")}`]; break;
        case "STYLE_OPACITY": look.op = n(c.value, 100) / 100; break;
        case "STYLE_FILTER": {
          const b = (c.filters || []).find((f: { type?: string }) => f.type === "blur");
          if (b) look.blur = `blur(${n(b.value, 0)}${unit(b.unit)})`;
          break;
        }
        case "STYLE_BACKGROUND_COLOR": look.bg = `rgba(${n(c.rValue, 0)}, ${n(c.gValue, 0)}, ${n(c.bValue, 0)}, ${n(c.aValue, 1)})`; break;
        case "STYLE_TEXT_COLOR": look.color = `rgba(${n(c.rValue, 0)}, ${n(c.gValue, 0)}, ${n(c.bValue, 0)}, ${n(c.aValue, 1)})`; break;
      }
    };
    const tf = (l: Look) => {
      if (!l.mv && !l.sc && !l.ro && !l.sk) return "";
      const mv = l.mv || ["0px", "0px", "0px"], sc = l.sc || [1, 1, 1], ro = l.ro || ["0deg", "0deg", "0deg"], sk = l.sk || ["0deg", "0deg"];
      return `translate3d(${mv.join(", ")}) scale3d(${sc.join(", ")}) rotateX(${ro[0]}) rotateY(${ro[1]}) rotateZ(${ro[2]}) skew(${sk.join(", ")})`;
    };
    const decls = (l: Look) => {
      const d: string[] = [];
      const t = tf(l);
      if (t) d.push(`transform: ${t}`);
      if (l.op !== undefined) d.push(`opacity: ${l.op}`);
      if (l.blur) d.push(`filter: ${l.blur}`);
      if (l.bg) d.push(`background-color: ${l.bg}`);
      if (l.color) d.push(`color: ${l.color}`);
      return d;
    };
    // the elements a step acts on, as a selector relative to the trigger (for hover CSS) and as elements
    const idOf = (v?: string) => (v && v.includes("|") ? v.split("|")[1] : v || "");
    const trigSel = (e: Ev) => (e.target?.appliesTo === "CLASS" && e.target.selector ? e.target.selector : e.target?.id ? `[data-w-id="${idOf(e.target.id)}"]` : "");
    const relSel = (trig: string, t: Record<string, any> | undefined): string | null => {
      if (!t) return null;
      const id = idOf(t.id);
      if (t.useEventTarget === true) return `${trig}:hover`;
      if (t.useEventTarget === "CHILDREN" && id) return `${trig}:hover [data-w-id="${id}"]`;
      if (t.useEventTarget === "SIBLINGS" && id) return `${trig}:hover ~ [data-w-id="${id}"]`;
      if (t.useEventTarget === "PARENT" && id) return `[data-w-id="${id}"]:has(${trig}:hover)`;
      if (t.selector) return `body:has(${trig}:hover) ${t.selector}`;
      if (id) return `body:has(${trig}:hover) [data-w-id="${id}"]`;
      return null;
    };
    const restSel = (sel: string) => sel.replace(/:hover/g, "");
    const elsFor = (trigEl: Element, t: Record<string, any> | undefined): Element[] => {
      if (!t) return [];
      const id = idOf(t.id);
      try {
        if (t.useEventTarget === true) return [trigEl];
        if (t.useEventTarget === "CHILDREN" && id) return Array.from(trigEl.querySelectorAll(`[data-w-id="${id}"]`));
        if (t.useEventTarget === "SIBLINGS" && id) return Array.from(trigEl.parentElement?.children || []).filter((c) => c !== trigEl && c.getAttribute("data-w-id") === id);
        if (t.useEventTarget === "PARENT" && id) { const p = trigEl.parentElement?.closest(`[data-w-id="${id}"]`); return p ? [p] : []; }
        if (t.selector) return Array.from(document.querySelectorAll(t.selector));
        if (id) return Array.from(document.querySelectorAll(`[data-w-id="${id}"]`));
      } catch {
        /* a selector the browser rejects */
      }
      return [];
    };
    const trigEls = (e: Ev): Element[] => {
      try {
        if (e.target?.appliesTo === "PAGE") return [document.body];
        const sel = trigSel(e);
        return sel ? Array.from(document.querySelectorAll(sel)) : [];
      } catch {
        return [];
      }
    };
    // a step list → per target: the look at each group's end, and the timing of each group
    type Track = { key: string; looks: Look[]; timing: { dur: number; delay: number; ease: string }[] };
    const tracks = (list: List, groups?: Group[]): Map<string, Track> => {
      const out = new Map<string, Track>();
      (groups || list.actionItemGroups || []).forEach((g, gi) => {
        for (const it of g.actionItems || []) {
          const key = JSON.stringify(it.config?.target || {});
          let tr = out.get(key);
          if (!tr) { tr = { key, looks: [], timing: [] }; out.set(key, tr); }
          while (tr.looks.length <= gi) tr.looks.push({ ...(tr.looks[tr.looks.length - 1] || {}) });
          apply(tr.looks[gi], it);
          const c = it.config || {};
          const t = tr.timing[gi] || { dur: 0, delay: Infinity, ease: "ease" };
          t.dur = Math.max(t.dur, (Number(c.delay) || 0) + (Number(c.duration) || 0));
          t.delay = Math.min(t.delay, Number(c.delay) || 0);
          if (c.easing !== undefined) t.ease = ease(c.easing);
          tr.timing[gi] = t;
        }
      });
      return out;
    };
    const MQ: Record<string, string> = { main: "(min-width: 992px)", medium: "(min-width: 768px) and (max-width: 991px)", small: "(min-width: 480px) and (max-width: 767px)", tiny: "(max-width: 479px)" };
    const inMedia = (e: Ev, css: string) => {
      const m = (e.mediaQueries || []).filter((q) => MQ[q]);
      if (!m.length || m.length === 4) return css;
      return m.map((q) => `@media ${MQ[q]} { ${css} }`).join("\n");
    };
    const css: string[] = [];
    let n = 0, scrollId = 0;
    const events = Object.values(ix.events);
    const listOf = (e: Ev) => (e.action?.config?.actionListId ? ix!.actionLists![e.action.config.actionListId] : undefined);
    for (const e of events) {
      const list = listOf(e);
      if (!list) continue;
      const type = e.eventTypeId || "";
      if (type === "MOUSE_OVER" || type === "MOUSE_HOVER_IN") {
        // hover in → the look it ends on; hover out (its pair) → the timing back
        const trig = trigSel(e);
        if (!trig) continue;
        const out = events.find((o) => (o.eventTypeId === "MOUSE_OUT" || o.eventTypeId === "MOUSE_HOVER_OUT") && trigSel(o) === trig);
        const outList = out ? listOf(out) : undefined;
        const inT = tracks(list), outT = outList ? tracks(outList) : new Map<string, Track>();
        for (const tr of inT.values()) {
          const sel = relSel(trig, JSON.parse(tr.key));
          if (!sel) continue;
          const end = decls(tr.looks[tr.looks.length - 1] || {});
          if (!end.length) continue;
          const last = tr.timing[tr.timing.length - 1] || { dur: 300, delay: 0, ease: "ease" };
          const back = outT.get(tr.key)?.timing.slice(-1)[0] || last;
          const props = end.map((d) => d.split(":")[0]);
          const tIn = props.map((p) => `${p} ${Math.round(last.dur)}ms ${last.ease}`).join(", ");
          const tOut = props.map((p) => `${p} ${Math.round(back.dur)}ms ${back.ease}`).join(", ");
          css.push(inMedia(e, `@media (hover: hover) { ${restSel(sel)} { transition: ${tOut}; } ${sel} { ${end.map((d) => d + " !important").join("; ")}; transition: ${tIn}; } }`));
          n++;
        }
      } else if (type === "SCROLL_INTO_VIEW" || type === "PAGE_START" || type === "PAGE_FINISH") {
        const ts = tracks(list);
        const startAt = Number(e.action?.config?.delay) || Number(e.config?.delay) || 0;
        for (const trigEl of trigEls(e).slice(0, 200))
          for (const tr of ts.values()) {
            if (tr.looks.length < 2 && !list.useFirstGroupAsInitialState) continue;
            const from = decls(tr.looks[0]);
            if (!from.length) continue;
            const rest = tr.timing.slice(1);
            const dur = rest.reduce((a, t) => a + t.dur, 0) || tr.timing[0]?.dur || 600;
            const delay = startAt + (rest[0]?.delay || 0);
            const e2 = rest[rest.length - 1]?.ease || "ease";
            for (const el of elsFor(trigEl, JSON.parse(tr.key)).slice(0, 200)) {
              if (el.hasAttribute("data-sl-gsap")) continue;
              const fl = tr.looks[0];
              const below = el.getBoundingClientRect().top + scrollY > innerHeight * 0.9;
              el.setAttribute("data-sl-gsap", JSON.stringify({
                f: { o: String(fl.op ?? getComputedStyle(el).opacity), t: tf(fl) || "none", tr: "none", s: "none", r: "none", fi: fl.blur || "none", c: "none" },
                d: Math.round(dur), dl: Math.round(delay), e: e2, tr: type === "SCROLL_INTO_VIEW" || below ? "scroll" : "load",
              }));
              n++;
            }
          }
      } else if (type === "SCROLLING_IN_VIEW" || type === "PAGE_SCROLL") {
        // keyframes on the scroll position: in view (the element crossing the screen) or the whole page
        for (const pg of list.continuousParameterGroups || []) {
          if (pg.type && pg.type !== "SCROLL_PROGRESS") continue;
          const groups = (pg.continuousActionGroups || []).slice().sort((a, b) => (a.keyframe || 0) - (b.keyframe || 0));
          if (groups.length < 2) continue;
          const ts = tracks(list, groups);
          const trigList = type === "PAGE_SCROLL" ? [document.body] : trigEls(e).slice(0, 100);
          for (const trigEl of trigList)
            for (const tr of ts.values()) {
              const frames = tr.looks.map((l, i) => `${groups[i]?.keyframe ?? 0}% { ${decls(l).join("; ")} }`).filter((f) => !/\{\s*\}/.test(f));
              if (frames.length < 2) continue;
              for (const el of elsFor(trigEl, JSON.parse(tr.key)).slice(0, 100)) {
                const id = `w${++scrollId}`;
                el.setAttribute("data-sl-wfs", id);
                const range = type === "PAGE_SCROLL" ? "animation-timeline: scroll(root block);" : "animation-timeline: view(); animation-range: cover 0% cover 100%;";
                css.push(inMedia(e, `@supports (animation-timeline: view()) { @keyframes sl-wfs-${id} { ${frames.join(" ")} } [data-sl-wfs="${id}"] { animation: sl-wfs-${id} linear both; ${range} } }`));
                n++;
              }
            }
        }
      }
    }
    if (css.length) document.documentElement.setAttribute("data-sl-wf-css", css.join("\n"));
    return n;
  };
  try {
    const wf = recordWebflow();
    if (wf) out.libs.push(`webflow-ix-recorded×${wf}`);
  } catch {
    /* an IX build we don't know */
  }
  // Pinned sections (ScrollTrigger pin: a section held on screen while you scroll through it, a horizontal
  // gallery sliding sideways): GSAP's own numbers — the scroll position where the pin starts and ends —
  // go on the pinned element. The capture holds it in place over that stretch of the copy's scroll.
  const recordPins = (): number => {
    const g = w.gsap as { core?: { globals?: () => Record<string, unknown> } } | undefined;
    let ST: { getAll?: () => unknown[] } | undefined;
    try {
      ST = (w.ScrollTrigger || g?.core?.globals?.().ScrollTrigger) as typeof ST;
    } catch {
      /* not GSAP's */
    }
    if (!ST || typeof ST.getAll !== "function") return 0;
    let n = 0;
    try {
      for (const t of ST.getAll()) {
        const st = t as { pin?: unknown; start?: number; end?: number; vars?: { scroller?: unknown; pinType?: string; horizontal?: boolean } };
        const el = st.pin;
        if (!(el instanceof HTMLElement) || typeof st.start !== "number" || typeof st.end !== "number" || !(st.end - st.start > 40)) continue;
        // pinned with position: fixed against the window only (a smooth-scroll wrapper pins by moving it)
        const sc = st.vars?.scroller;
        if (st.vars?.horizontal || st.vars?.pinType === "transform") continue;
        if (sc && sc !== window && sc !== document.body && sc !== document.documentElement && sc !== "body" && sc !== "html") continue;
        el.setAttribute("data-sl-pin", JSON.stringify({ s: Math.round(st.start), e: Math.round(st.end) }));
        n++;
      }
    } catch {
      /* a ScrollTrigger build we don't know */
    }
    return n;
  };
  const recorded = recordGsap();
  if (recorded) out.libs.push(`gsap-recorded×${recorded}`);
  const pins = recordPins();
  if (pins) out.libs.push(`gsap-pins×${pins}`);
  if (!w.__slGsapAsk) {
    w.__slGsapAsk = true;
    // the capture is about to hover things to record their hover effects: GSAP tweens made from now on are
    // those effects, not the page's own motion
    document.addEventListener("sl-hover-mark", () => {
      try {
        const g = w.gsap as { globalTimeline?: { time?: () => number } } | undefined;
        if (g?.globalTimeline?.time) w.__slHoverAt = g.globalTimeline.time();
      } catch {
        /* not GSAP's */
      }
    });
    document.addEventListener("sl-gsap-record", () => {
      recordGsap();
      recordPins();
    });
  }
  if (gsap?.globalTimeline) {
    out.libs.push("gsap");
    try {
      for (const t of gsap.globalTimeline.getChildren(true, true, true)) {
        const tw = t as { repeat?: () => number; progress?: (p: number) => void; vars?: { repeat?: number }; scrollTrigger?: { vars?: { scrub?: unknown } }; parent?: unknown };
        const rep = typeof tw.repeat === "function" ? tw.repeat() : tw.vars?.repeat ?? 0;
        if (rep === -1) continue;
        // tied to the scroll position (scrub): it is where the scroll puts it — jumping it to its end would
        // make the scroll pass see it start at the end and jump back (a pinned gallery read as a reveal)
        let scrubbed = false;
        for (let a = tw as typeof tw | undefined; a && a !== (gsap.globalTimeline as unknown); a = a.parent as typeof tw | undefined) if (a.scrollTrigger?.vars?.scrub) scrubbed = true;
        if (scrubbed) continue;
        tw.progress?.(1);
        out.gsap++;
      }
    } catch {
      /* ignore */
    }
  }
  if (w.ScrollTrigger) out.libs.push("scrolltrigger");
  if (w.Lenis || document.querySelector("html.lenis, [data-lenis-prevent]")) out.libs.push("lenis");
  if (w.AOS) out.libs.push("aos");
  if (document.querySelector("[data-framer-name]")) out.libs.push("framer");
  if (document.querySelector("[data-wf-site]")) out.libs.push("webflow");
  // Lottie animations playing through lottie-web: its registry (page world only) knows
  // each animation's container and file. Tag the container so the copy can load the
  // real animation instead of a frozen frame.
  try {
    const lot = (w.lottie || w.bodymovin) as { getRegisteredAnimations?: () => unknown[] } | undefined;
    const anims = lot?.getRegisteredAnimations?.() || [];
    let n = 0;
    for (const a of anims as Array<{ wrapper?: Element; path?: string; fileName?: string; animationData?: unknown; loop?: boolean | number; autoplay?: boolean; renderer?: { rendererType?: string } }>) {
      const el = a.wrapper;
      if (!(el instanceof Element) || el.hasAttribute("data-sl-lottie-src") || el.hasAttribute("data-sl-lottie-json")) continue;
      const file = a.path && a.fileName ? new URL(`${a.path}${a.fileName}.json`, location.href).href : "";
      if (file) el.setAttribute("data-sl-lottie-src", file);
      else if (a.animationData) {
        const json = JSON.stringify(a.animationData);
        if (json.length > 2_000_000) continue; // too large to carry inline
        el.setAttribute("data-sl-lottie-json", json);
      } else continue;
      el.setAttribute("data-sl-lottie-loop", a.loop === false ? "0" : "1");
      el.setAttribute("data-sl-lottie-autoplay", a.autoplay === false ? "0" : "1");
      if (a.renderer?.rendererType) el.setAttribute("data-sl-lottie-renderer", a.renderer.rendererType);
      n++;
    }
    if (n) out.libs.push(`lottie×${n}`);
  } catch {
    /* lottie-web not on the page */
  }
  return out;
}
