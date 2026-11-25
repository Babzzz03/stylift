// Page capture engine. Injected via chrome.scripting.executeScript({ func, args }),
// so this file exports ONE self-contained async function: it closes over nothing
// but page globals. Its output is a faithful, static, self-describing HTML
// document of the page *as currently rendered* (your StyleLift edits included).
//
// What it does beyond `documentElement.outerHTML` (techniques in the spirit of
// SingleFile, re-implemented from scratch — no AGPL code is used):
//   • loads deferred content first: `loading=lazy` → eager, data-src lazy
//     patterns resolved, then a scroll pass through the page (and any
//     full-screen scroller) so IntersectionObserver-driven images and
//     scroll/appear animations (Framer, GSAP ScrollTrigger, AOS…) fire,
//   • stylesheets are serialized from the live CSSOM in cascade order — so
//     CSS-in-JS rules inserted with insertRule (styled-components, emotion,
//     Framer) are captured, @imports are flattened, url()s absolutized, and
//     adopted stylesheets (document + shadow roots) are inlined,
//   • shadow roots → declarative `<template shadowrootmode>`,
//   • <canvas> → <img data-url>, <video> without a poster gets one from the
//     current frame, <img srcset/picture> collapses to its best candidate,
//   • form state (values, checked, selected) is written into attributes,
//   • same-origin <iframe>s are inlined as srcdoc, tracking/editor frames dropped,
//   • scripts (+ on* handlers, preload hints) are stripped unless `scripts:"keep"`,
//   • elements an appear-animation left at `opacity:0` are revealed.

export interface CaptureOptions {
  /** Scroll through the page to trigger lazy images + scroll animations. */
  loadDeferred?: boolean;
  /** Time budget for the scroll pass, ms. */
  maxScrollMs?: number;
  /** Strip scripts (static, safe capture) or keep them (hydratable). */
  scripts?: "strip" | "keep";
  /** Neutralize inline `opacity:0`/translate left by appear animations. */
  revealHidden?: boolean;
  /** Inline same-origin iframes as srcdoc. */
  frames?: boolean;
  /** Snapshot a poster for <video> elements that have none. */
  posters?: boolean;
  /** Pick the largest srcset candidate instead of the currently displayed one. */
  bestImages?: boolean;
  /** Remove cookie / consent banners and their backdrops. */
  stripCookieBanners?: boolean;
  /** Compile Framer appear animations to CSS so the copy replays them. */
  replayAnimations?: boolean;
  /** Turn scroll-triggered reveals into CSS scroll-driven animations. */
  scrollReveals?: boolean;
  /** Record scroll-linked effects (parallax, scrubbed transforms) as CSS scroll timelines. */
  scrollLinked?: boolean;
  /** Record hover effects the page runs with JavaScript (GSAP on mouseenter…) as CSS :hover rules. */
  hoverMotion?: boolean;
}

export interface CaptureStats {
  images: number;
  imagesLoaded: number;
  lazyEagered: number;
  scrollSteps: number;
  shadowRoots: number;
  canvases: number;
  scriptsStripped: number;
  sheets: number;
  crossOriginSheets: number;
  adoptedSheets: number;
  frames: number;
  revealed: number;
  bannersRemoved: number;
  varShorthands: number;
  appearAnimations: number;
  scrollReveals: number;
  spritesInlined: number;
  scrollLinked: number;
  /** GSAP animations recorded before settling and replayed with CSS */
  gsapMotion?: number;
  /** script-driven marquees / tickers measured while scrolling and looped with CSS */
  marquees?: number;
  /** scroll locks (a paused smooth scroller, a modal's overflow:hidden) lifted in the copy */
  scrollUnlocked?: number;
  concealers: number;
  headersRestored: number;
  animatedBaked: number;
  inputs: number;
  bytes: number;
  ms: number;
  /** CSS width of the viewport the page was captured at */
  viewportWidth?: number;
  /** the document's MIME type — "text/plain" / "text/markdown" / "application/json" aren't web pages */
  contentType?: string;
  /** decorative videos set to autoplay (muted, inline, looping) in the copy */
  videosAutoplay?: number;
  /** embedded players the page had removed after they were on screen, kept in the copy */
  playersRestored?: number;
  /** decided reveal / curtain states the page had overwritten before the copy */
  reapplied?: number;
  /** elements renamed so the HTML parser keeps their nesting (div in p → span) */
  retagged?: number;
  /** fixed full-screen canvas layers over the content, placed on the first screen */
  overlaysUnpinned?: number;
  /** steps of pinned scroll stories replayed on the page's scroll timeline */
  pinnedSteps?: number;
  /** sections GSAP pins on screen while scrolling through them, held the same way in the copy */
  pinned?: number;
  /** hover effects run by the page's scripts, recorded and replayed as CSS :hover */
  hoverMotion?: number;
  /** reveals replayed over their own measured time (duration, stagger delay, easing) as they come into view */
  timedReveals?: number;
  /** content switched on and off as the page scrolled (an active list item, posters taking turns), replayed on the scroll position */
  switchSteps?: number;
  /** elements following the pointer (magnetic parts, 3D tilt) and cursor followers, replayed by the trigger script */
  pointerEffects?: number;
  /** 3D scenes (WebGL canvases) marked so an export can keep them live, running the site's own code */
  islands?: number;
  /** canvases sized to the capture window, made to fill the viewer's window instead */
  screenCanvases?: number;
  /** elements a timer switches back and forth (slideshows): kept as they were when copied */
  timerSlides?: number;
  /** videos the site plays once as they come into view: played there by the trigger script */
  videosOnEnter?: number;
  /** tabs, Previous / Next arrows of sliding galleries and video play buttons, made to work in the copy */
  widgets?: number;
  /** classes the page puts on itself / its bars past a scroll position (a bar appearing, a header turning solid) */
  scrollClasses?: number;
  /** capture-page --why: the decisions about the elements asked about */
  debug?: string;
  /** how many elements were watched for classes that follow the scroll position, and which (tag#id.class) */
  scrollClassWatch?: number;
  scrollClassWatched?: string;
  /** reveals scrubbed by the scroll over their own measured stretch */
  revealRanges?: number;
  /** stops made again for pictures a script fills only when they come near, passed too quickly the first time */
  lazyRevisits?: number;
  /** the site's own one-shot CSS animations below the first screen, held until they come into view */
  heldAnimations?: number;
  /** reveals whose finished look would have stayed hidden (their block kept its "before" class): shown */
  revealsPinned?: number;
  /** progress variables (--progress…) the page's scripts set as it scrolled, played back on the scroll timeline */
  scrollVars?: number;
  /** entrances the page ran as Web Animations (element.animate — Framer Motion's in-view effects), replayed */
  waapiEntrances?: number;
  /** timed entrances in pinned sections, started at the scroll position where they played */
  pinnedEntrances?: number;
  /** elements the page made during the scroll pass (split text, mounted sections), judged with the rest */
  lateBorn?: number;
  cursorFollowers?: number;
  /** count-up numbers written into the copy at the value they reached */
  countersSet?: number;
  /** Rive / Lottie animations wired to play their real file in the copy */
  liveAnimations?: number;
  /** frames recorded for canvases (3D scenes) that change as the page scrolls */
  scrollFrames?: number;
  quality?: number;
}

export interface CaptureResult {
  html: string;
  url: string;
  title: string;
  stats: CaptureStats;
  warnings: string[];
  /** Raw Framer appear-animation data; compiled to CSS on the panel side. */
  framerAppear?: { json: string; breakpoints?: string };
  /** ids (data-sl-shoot) of canvases to screenshot: they could not be read back */
  needsScreenshot?: string[];
  /** where each pictured embed was on the page (document px) — sites that unmount off-screen players */
  shotBoxes?: Record<string, { x: number; y: number; w: number; h: number }>;
}

export async function capturePage(rawOpts?: CaptureOptions): Promise<CaptureResult> {
  const o = {
    loadDeferred: true,
    maxScrollMs: 26000,
    scripts: "strip" as "strip" | "keep",
    revealHidden: true,
    frames: true,
    posters: true,
    bestImages: true,
    stripCookieBanners: true,
    replayAnimations: true,
    scrollReveals: true,
    scrollLinked: true,
    hoverMotion: true,
    ...(rawOpts || {}),
  };
  const t0 = performance.now();
  const warnings: string[] = [];
  // Investigating a real site (scripts/capture-page.mjs --why "<selector>"): what the capture decided about the
  // elements matching window.__slDebugSel, and why — written to stats.debug. Off unless that is set.
  const DBG = (() => {
    try {
      const v = (window as unknown as { __slDebugSel?: unknown }).__slDebugSel;
      return typeof v === "string" && v ? v : null;
    } catch {
      return null;
    }
  })();
  const dbgLog: string[] = [];
  const dbg = (el: Element, m: string) => {
    if (!DBG || dbgLog.length >= 300) return;
    try {
      if (!el.matches(DBG)) return;
      const name = el.localName + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
      dbgLog.push(`${name} '${(el.textContent || "").trim().slice(0, 16)}': ${m}`);
    } catch {
      /* a selector the page can't take */
    }
  };
  // a hidden page (window behind another, minimized, display asleep) gets slowed timers and no frames
  let wasHidden = document.visibilityState === "hidden";
  const onVis = () => { if (document.visibilityState === "hidden") wasHidden = true; };
  document.addEventListener("visibilitychange", onVis);
  const stats: CaptureStats = {
    images: 0, imagesLoaded: 0, lazyEagered: 0, scrollSteps: 0, shadowRoots: 0,
    canvases: 0, scriptsStripped: 0, sheets: 0, crossOriginSheets: 0, adoptedSheets: 0,
    frames: 0, revealed: 0, bannersRemoved: 0, varShorthands: 0, appearAnimations: 0, scrollReveals: 0, spritesInlined: 0, scrollLinked: 0, gsapMotion: 0, concealers: 0, headersRestored: 0, animatedBaked: 0, inputs: 0, bytes: 0, ms: 0,
    viewportWidth: innerWidth,
    contentType: document.contentType,
  };
  const MARK = "data-sl-i";
  const EMPTY_PNG = "data:,";
  const UI_SELECTOR = "#__sl_editor_host, .__sl_ui";
  // canvases the page couldn't read back, left tagged for the panel to screenshot
  const SHOOT_ATTR = "data-sl-shoot";
  const RETAG_ATTR = "data-sl-retag";
  const P_CLOSERS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DETAILS|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HGROUP|HR|MAIN|MENU|NAV|OL|P|PRE|SECTION|TABLE|UL)$/;
  const needsShot: string[] = [];
  const shotBoxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const goneFrames: { frame: Element; holder: Element; parent: Element; next: Node | null }[] = [];
  document.querySelectorAll(`[${SHOOT_ATTR}]`).forEach((e) => e.removeAttribute(SHOOT_ATTR)); // stale tags
  // set when something kept changing with the page at rest (carousel, number roll)
  let timerDriven = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Libraries react to scrolling on the next frame they draw (Webflow interactions, GSAP, AOS). On a
  // busy machine frames come late while timers keep firing — so before judging a stop, let the page
  // draw two frames and go idle (capped, and a tab Chrome isn't drawing still moves on).
  const framesThenIdle = (cap = 900) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      setTimeout(finish, cap);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
          if (ric) ric(finish, { timeout: Math.max(50, cap - 300) });
          else setTimeout(finish, 30);
        }),
      );
    });
  const abs = (u: string, base?: string): string => {
    try {
      return new URL(u, base || document.baseURI).href;
    } catch {
      return u;
    }
  };
  // Quote-aware url() mapper. A naive regex re-matches url() tokens INSIDE a
  // data: URI string (e.g. an SVG mask whose <rect fill='url(%23p)'>) and
  // corrupts the outer string; this scanner consumes each url(...) token whole.
  function mapCssUrls(css: string, map: (url: string) => string | null): string {
    let out = "";
    let i = 0;
    const n = css.length;
    while (i < n) {
      const j = css.indexOf("url(", i);
      if (j === -1) {
        out += css.slice(i);
        break;
      }
      out += css.slice(i, j);
      if (j > 0 && /[\w-]/.test(css[j - 1])) {
        out += "url(";
        i = j + 4;
        continue; // part of a longer ident, not a url() token
      }
      let k = j + 4;
      while (k < n && /\s/.test(css[k])) k++;
      const q = css[k] === '"' || css[k] === "'" ? css[k] : "";
      let url = "";
      let end = -1;
      if (q) {
        const close = css.indexOf(q, k + 1);
        if (close === -1) {
          out += css.slice(j);
          break;
        }
        url = css.slice(k + 1, close);
        end = css.indexOf(")", close + 1);
      } else {
        end = css.indexOf(")", k);
        if (end !== -1) url = css.slice(k, end).trim();
      }
      if (end === -1) {
        out += css.slice(j);
        break;
      }
      const mapped = url.includes("\\") ? null : map(url); // leave escaped urls alone
      out += mapped === null ? css.slice(j, end + 1) : `url("${mapped}")`;
      i = end + 1;
    }
    return out;
  }
  const absolutizeCssUrls = (css: string, base: string): string =>
    mapCssUrls(css, (u) => {
      const v = u.trim();
      if (!v || /^(data:|blob:|#|about:)/i.test(v)) return null;
      return abs(v, base);
    });

  // A value that is a function of scroll position: it never changes while the page
  // stands still, and it moves in one direction as the page scrolls. Timer-driven
  // animations (text scramble, marquees, loops) fail one of the two tests.
  const matrixNums = (tf: string): number[] => {
    if (tf === "none") return [1, 0, 0, 1, 0, 0];
    const m = /matrix(3d)?\(([^)]+)\)/.exec(tf);
    if (!m) return [];
    const n = m[2].split(",").map(Number);
    return m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n;
  };
  function isScrollLinked(el: HTMLElement, arr: { y: number; tf: string; op: number }[], inGroup = false, fewSteps = false): boolean {
    const r = el.getBoundingClientRect();
    // parallax layers are blocks, not glyphs — unless the element is one of a row of words / letters that all
    // follow the scroll (a text lighting up as you scroll); letter scrambles run on timers and fail test 1
    if (!inGroup) {
      if (r.width < 40 || r.height < 40) return false;
      // a letter or two of text (a scramble's glyph); an empty block moving with the scroll (a coloured strip,
      // a gradient track) is real motion
      const tl = (el.textContent || "").trim().length;
      if (getComputedStyle(el).display === "inline" || (tl > 0 && tl <= 2 && !el.querySelector("img,svg,video,picture,canvas") && !/url\(/.test(getComputedStyle(el).backgroundImage))) return false;
    } else if (r.width < 4 || r.height < 4) return false;
    // 1. still page → still value: several different values at one scroll position = timer
    const byY = new Map<number, Set<string>>();
    for (const p of arr) {
      const k = `${p.tf}|${p.op.toFixed(2)}`;
      if (!byY.has(p.y)) byY.set(p.y, new Set());
      byY.get(p.y)!.add(k);
    }
    if (Array.from(byY.values()).some((set) => set.size > 2)) return false;
    const pts = Array.from(new Map(arr.map((p) => [p.y, p])).values()).sort((a, b) => a.y - b.y);
    if (pts.length < 3) return false;
    // 2. monotonic in every component, with a real amount of change somewhere
    const series = pts.map((p) => [...matrixNums(p.tf), p.op]);
    if (series.some((v) => v.length !== 7)) return false;
    // 3. it keeps changing as you scroll: a reveal changes once or twice (hidden → shown) and then rests,
    //    parallax changes at stop after stop
    let steps = 0;
    for (let i = 1; i < series.length; i++) if (series[i].some((v, c) => Math.abs(v - series[i - 1][c]) > (c >= 4 && c <= 5 ? 1.5 : 0.01))) steps++;
    // One of a row of words lighting up: each word's own change is short (a stagger spread over the
    // scroll), so it can fall between two stops — two changes are enough when one stop caught it part way
    // (a timed reveal never rests at an in-between value; it shows hidden or shown)
    if (steps < 2) return false;
    if (steps < 3) {
      // (the site's bar too: never a reveal, and a logo shrinks over a short stretch of scrolling)
      if (!inGroup && !fewSteps) return false;
      const partWay = [0, 1, 2, 3, 4, 5, 6].some((c) => {
        const vals = series.map((v) => v[c]);
        const lo = Math.min(...vals), hi = Math.max(...vals), tol = c >= 4 && c <= 5 ? 4 : 0.03;
        return hi - lo > tol * 3 && vals.some((x) => x - lo > tol && hi - x > tol);
      });
      if (!partWay) return false;
    }
    let moving = false;
    for (let c = 0; c < 7; c++) {
      const vals = series.map((v) => v[c]);
      const tol = c >= 4 && c <= 5 ? 1.5 : 0.01; // px for translate, unitless otherwise
      let up = false, down = false;
      for (let i = 1; i < vals.length; i++) {
        const d = vals[i] - vals[i - 1];
        if (d > tol) up = true;
        if (d < -tol) down = true;
      }
      if (up && down) return false;
      const range = Math.max(...vals) - Math.min(...vals);
      if ((c >= 4 && c <= 5 && range > 8) || (c < 4 && range > 0.03) || (c === 6 && range > 0.15)) moving = true;
    }
    return moving;
  }

  // Pinned sections (GSAP ScrollTrigger pin): held on screen while the page scrolls through them. GSAP
  // wraps each in a "pin-spacer" whose padding is the stretch it stays pinned for, and fixes it to the
  // screen meanwhile; the copy keeps the spacer, so the section is moved down by exactly what is scrolled
  // over that stretch (a scroll timeline) — it looks fixed, then scrolls on, and works inside overflow:
  // hidden wrappers where position: sticky would not. Its contents' scrubbed motion (a gallery sliding
  // sideways) is recorded by the scroll sampling like any other.
  const PIN_ATTR = "data-sl-pinned";
  const pinTop = new Map<HTMLElement, number>(); // pinned element → its top while fixed (the pin's "top 20%")
  const pinned: { el: HTMLElement; id: string; s: number; e: number }[] = [];
  function pinCss(): string {
    const out: string[] = [];
    for (const p of pinned) {
      out.push(`@keyframes sl-pin-${p.id} { from { translate: 0 0; } to { translate: 0 ${p.e - p.s}px; } }`);
      out.push(`[${PIN_ATTR}="${p.id}"] { animation: sl-pin-${p.id} linear both; animation-timeline: scroll(root block); animation-range: ${p.s}px ${p.e}px; }`);
    }
    return (
      `/* Pinned sections (GSAP ScrollTrigger pins), recorded by StyleLift: each is held on screen over the\n` +
      `   stretch of scrolling the page pinned it for, on the page's scroll timeline. */\n` +
      `@supports (animation-timeline: scroll()) {\n${out.join("\n")}\n}\n`
    );
  }

  // ── Progress variables replayed (a script sets --progress on a bar as you scroll; its CSS reads var(--progress)) ──
  // The variable itself, sampled at every stop, is played back on the page's scroll timeline — registered with
  // @property so it moves smoothly — and everything the site's CSS draws from it follows, exactly.
  const VAR_ATTR = "data-sl-var";
  const varHosts = new Set<HTMLElement>();
  // elements whose own custom properties the page switched while we scrolled (wearebulletproof.com's letters:
  // --x: -21vw → 0vw, the site's CSS gliding them in over a second): looked at again once each stop has settled —
  // at the moment of the switch the glide hasn't begun, and nothing in the DOM changes while it runs
  const varLooks = new Set<HTMLElement>();
  let varStopY = 0; // the last stop sampled
  const varSamples = new Map<HTMLElement, Map<string, { y: number; v: string }[]>>();
  const varPlays: { el: HTMLElement; id: string; keys: { at: number; decl: string }[]; a: number; b: number }[] = [];
  const varTypes = new Map<string, { syntax: string; zero: string }>();
  function varCss(): string {
    const out: string[] = [];
    for (const [prop, r] of varTypes) out.push(`@property ${prop} { syntax: "${r.syntax}"; inherits: true; initial-value: ${r.zero}; }`);
    for (const p of varPlays) {
      out.push(`@keyframes sl-var-${p.id} { ${p.keys.map((k) => `${Math.round(k.at * 10000) / 100}% { ${k.decl} }`).join(" ")} }`);
      out.push(`[${VAR_ATTR}="${p.id}"] { animation: sl-var-${p.id} linear both; animation-timeline: scroll(root block); animation-range: ${p.a}px ${p.b}px; }`);
    }
    return (
      `/* Progress variables the page's scripts set as it scrolled (--progress…), recorded by StyleLift and played
` +
      `   back on the page's scroll timeline: what the site's CSS draws from them follows exactly. Without
` +
      `   scroll timelines the values stay at those of the top of the page. */
` +
      `@supports (animation-timeline: scroll()) {
${out.join("\n")}
}
`
    );
  }

  // Scroll-linked effects (parallax, scrubbed transforms) → CSS scroll timelines.
  const SCROLL_ATTR = "data-sl-scroll";
  // a timed entrance set off at a scroll position (inside a pinned section): the runtime plays it once the page
  // has scrolled that far, instead of when it comes into view
  const IN_AT_ATTR = "data-sl-in-at";
  const linked: { el: HTMLElement; id: string; pts: { y: number; tf: string; op: number }[]; preStyle: string | null }[] = [];
  // ── scroll-scrubbed canvases (3D / WebGL scenes that change as you scroll) ──────
  // A scene the page re-renders as you scroll (a model rolling along, a camera flying
  // through) is recorded at every scroll stop; the copy stacks those frames and shows
  // the one for the current scroll position on the page's scroll timeline. Looks and
  // scrolls like the original without the site's code (no mouse interaction).
  const scrubFrames = new Map<HTMLCanvasElement, { y: number; data: string }[]>();
  const scrubPrint = new Map<HTMLCanvasElement, Uint8ClampedArray>();
  let scrubCands: HTMLCanvasElement[] = [];
  const SCRUB_MAX_FRAMES = 40;
  function pickScrubCanvases(): void {
    scrubCands = Array.from(document.querySelectorAll("canvas"))
      .filter((c) => { const r = c.getBoundingClientRect(); return c.width >= 200 && c.height >= 120 && r.width >= 200 && r.height >= 120; })
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)
      .slice(0, 4);
  }
  async function grabScrubFrames(y: number): Promise<void> {
    if (!scrubCands.length) return;
    await new Promise<void>((res) => {
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        const t = document.createElement("canvas");
        t.width = t.height = 24;
        const tg = t.getContext("2d", { willReadFrequently: true });
        for (const c of scrubCands) {
          try {
            const r = c.getBoundingClientRect();
            if (!tg || r.bottom <= 0 || r.top >= innerHeight || r.width < 2) continue;
            tg.clearRect(0, 0, 24, 24);
            tg.drawImage(c, 0, 0, 24, 24);
            const print = tg.getImageData(0, 0, 24, 24).data;
            let ink = false;
            for (let i = 3; i < print.length; i += 4) if (print[i]) { ink = true; break; }
            if (!ink) continue; // cleared buffer this frame
            const prev = scrubPrint.get(c);
            if (prev) {
              let sum = 0;
              for (let i = 0; i < print.length; i++) sum += Math.abs(print[i] - prev[i]);
              if (sum / print.length < 3) continue; // looks the same as the last frame kept
            }
            const frames = scrubFrames.get(c) || [];
            if (frames.length >= SCRUB_MAX_FRAMES) continue;
            const scale = Math.min(1, 960 / c.width);
            const w = document.createElement("canvas");
            w.width = Math.max(1, Math.round(c.width * scale));
            w.height = Math.max(1, Math.round(c.height * scale));
            w.getContext("2d")!.drawImage(c, 0, 0, w.width, w.height);
            frames.push({ y, data: w.toDataURL("image/webp", 0.72) });
            scrubFrames.set(c, frames);
            scrubPrint.set(c, print.slice());
          } catch {
            /* tainted canvas: can't be recorded */
          }
        }
        res();
      };
      requestAnimationFrame(run); // WebGL buffers are readable right after the page draws
      setTimeout(run, 250);
    });
  }
  const scrubCssRules: string[] = [];
  let scrubCount = 0;
  /** Replace a recorded canvas's copy with a stack of frames switched by scroll position. */
  function buildScrub(src: HTMLCanvasElement, img: HTMLElement): HTMLElement | null {
    const frames = (scrubFrames.get(src) || []).slice().sort((a, b) => a.y - b.y);
    if (frames.length < 3) return null;
    const id = `f${++scrubCount}`;
    const wrap = document.createElement("span");
    for (const a of Array.from(img.attributes)) if (a.name !== "src" && a.name !== "data-sl-canvas" && a.name !== "data-sl-shoot") wrap.setAttribute(a.name, a.value);
    wrap.setAttribute("data-sl-scrub", id);
    const cs = getComputedStyle(src);
    const r = src.getBoundingClientRect();
    wrap.style.display = /^inline/.test(cs.display) ? "inline-block" : cs.display;
    if (cs.position === "static") wrap.style.position = "relative";
    if (!wrap.style.width) wrap.style.width = `${Math.round(r.width)}px`;
    if (!wrap.style.height) wrap.style.height = `${Math.round(r.height)}px`;
    const maxScroll = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    frames.forEach((f, i) => {
      const im = document.createElement("img");
      im.setAttribute("src", f.data);
      im.setAttribute("alt", "");
      im.setAttribute("data-sl-frame", `${id}-${i}`);
      im.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;display:block;max-width:none");
      wrap.appendChild(im);
      const from = i === 0 ? 0 : Math.round((frames[i - 1].y + f.y) / 2);
      const to = i === frames.length - 1 ? maxScroll + 2000 : Math.round((f.y + frames[i + 1].y) / 2);
      scrubCssRules.push(`[data-sl-frame="${id}-${i}"] { animation: sl-frame-on linear; animation-timeline: scroll(root block); animation-range: ${from}px ${to}px; }`);
    });
    stats.scrollFrames = (stats.scrollFrames || 0) + frames.length;
    return wrap;
  }
  function scrubCss(): string {
    return (
      `/* 3D / canvas scenes recorded at each scroll stop by StyleLift: the frame for the current\n` +
      `   scroll position is shown. Without scroll timelines the first frame stays. */\n` +
      `[data-sl-scrub] > img:not(:first-child) { opacity: 0; }\n` +
      `@supports (animation-timeline: scroll()) {\n@keyframes sl-frame-on { from, to { opacity: 1; } }\n[data-sl-scrub] > img:first-child { opacity: 0; }\n${scrubCssRules.join("\n")}\n}\n`
    );
  }
  // GSAP motion, as recorded by settle.ts on each element (start state, duration, delay + stagger, easing,
  // trigger). Entrances animate FROM the recorded start TO the element's own (end) styles; scroll-triggered
  // ones carry --slm-on: enter so the exports' small trigger script holds them until they come into view
  // (without it, they simply play on load). Infinite ones (marquees, floating) loop between both states.
  function gsapCss(root: HTMLElement): { css: string; reveals: number; loops: number } {
    type Look = { o: string; t: string; tr: string; s: string; r: string; fi: string; c: string };
    const decl = (l: Look) => {
      const d: string[] = [];
      const op = parseFloat(l.o);
      if (!isNaN(op)) d.push(`opacity: ${Math.round(op * 1000) / 1000}`);
      if (l.t && l.t !== "none") d.push(`transform: ${l.t}`);
      if (l.tr && l.tr !== "none") d.push(`translate: ${l.tr}`);
      if (l.s && l.s !== "none") d.push(`scale: ${l.s}`);
      if (l.r && l.r !== "none") d.push(`rotate: ${l.r}`);
      if (l.fi && l.fi !== "none") d.push(`filter: ${l.fi}`);
      if (l.c && l.c !== "none") d.push(`clip-path: ${l.c}`);
      return d.join("; ");
    };
    const kinds = new Map<string, string>(), loopKinds = new Map<string, string>();
    const keyframes: string[] = [];
    let reveals = 0, loops = 0;
    const timing = (el: HTMLElement, spec: { d?: number; dl?: number; e?: string }) => {
      el.style.setProperty("--sl-in-d", `${Math.max(50, Number(spec.d) || 800)}ms`);
      el.style.setProperty("--sl-in-dl", `${Math.max(0, Math.min(8000, Number(spec.dl) || 0))}ms`);
      // (a Web Animation's own easing may be a keyword, a curve, or a spring written as linear(…) points)
      if (spec.e && /^(linear|ease(-in|-out|-in-out)?|cubic-bezier\([-\d.,\s]+\)|linear\([-\d.,%\s]+\))$/.test(spec.e)) el.style.setProperty("--sl-in-e", spec.e);
    };
    root.querySelectorAll("[data-sl-gsap]").forEach((node) => {
      const el = node as HTMLElement;
      const raw = el.getAttribute("data-sl-gsap");
      el.removeAttribute("data-sl-gsap");
      let spec: { f?: Look; d?: number; dl?: number; e?: string; tr?: string };
      try {
        spec = JSON.parse(raw || "");
      } catch {
        return;
      }
      if (!spec.f || reveals >= 1500) return;
      // a start that is already at rest (opacity 1, nothing moved, clipped or blurred) animates nothing:
      // leave the element as it is (and keep any reveal the scroll pass found for it)
      const f0 = spec.f;
      const tfRest = !f0.t || f0.t === "none" || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(f0.t) || /^matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\)$/.test(f0.t);
      if ((parseFloat(f0.o) || 0) >= 0.99 && tfRest && (!f0.tr || f0.tr === "none") && (!f0.s || f0.s === "none") && (!f0.r || f0.r === "none") && (!f0.fi || f0.fi === "none") && (!f0.c || f0.c === "none")) return;
      const from = decl(spec.f);
      if (!from) return;
      let id = kinds.get(from);
      if (!id) {
        id = `g${kinds.size + 1}`;
        kinds.set(from, id);
        keyframes.push(`@keyframes sl-in-${id} { from { ${from} } }`);
      }
      // one animation per element: the page's own beats a scroll reveal guessed from the scroll pass
      el.removeAttribute(REVEAL_ATTR);
      el.removeAttribute(TL_USE_ATTR);
      el.setAttribute("data-sl-in", id);
      if (spec.tr === "scroll") el.setAttribute("data-sl-in-on", "enter");
      timing(el, spec);
      reveals++;
    });
    root.querySelectorAll("[data-sl-gsap-loop]").forEach((node) => {
      const el = node as HTMLElement;
      const raw = el.getAttribute("data-sl-gsap-loop");
      el.removeAttribute("data-sl-gsap-loop");
      let spec: { f?: Look; to?: Look; d?: number; dl?: number; e?: string; yoyo?: boolean };
      try {
        spec = JSON.parse(raw || "");
      } catch {
        return;
      }
      if (!spec.f || !spec.to || loops >= 300) return;
      const a = decl(spec.f), b = decl(spec.to);
      if (!a || !b || a === b) return;
      const key = `${a}|${b}|${spec.yoyo ? 1 : 0}`;
      let id = loopKinds.get(key);
      if (!id) {
        id = `l${loopKinds.size + 1}`;
        loopKinds.set(key, id);
        keyframes.push(`@keyframes sl-loop-${id} { from { ${a} } to { ${b} } }`);
      }
      el.setAttribute("data-sl-loop", id);
      el.setAttribute("data-sl-loop-dir", spec.yoyo ? "alternate" : "normal");
      timing(el, spec);
      loops++;
    });
    if (!reveals && !loops) return { css: "", reveals, loops };
    const rules: string[] = [];
    for (const id of kinds.values()) rules.push(`[data-sl-in="${id}"] { animation: sl-in-${id} var(--sl-in-d, 800ms) var(--sl-in-e, cubic-bezier(.25,.46,.45,.94)) var(--sl-in-dl, 0ms) backwards; }`);
    for (const id of loopKinds.values()) rules.push(`[data-sl-loop="${id}"] { animation: sl-loop-${id} var(--sl-in-d, 1000ms) var(--sl-in-e, linear) var(--sl-in-dl, 0ms) infinite normal both; }`);
    rules.push(`[data-sl-loop-dir="alternate"] { animation-direction: alternate; }`);
    rules.push(`[data-sl-in-on="enter"] { --slm-on: enter; }`);
    return {
      css:
        `/* The page's GSAP animations, recorded by StyleLift before they were fast-forwarded and replayed\n` +
        `   with CSS: entrances from where they started, with their own timing, easing and stagger; loops\n` +
        `   (marquees, floating) forever. Scroll-triggered entrances wait until they come into view. */\n` +
        `@media (prefers-reduced-motion: no-preference) {\n${keyframes.join("\n")}\n${rules.join("\n")}\n}\n`,
      reveals,
      loops,
    };
  }
  function linkedCss(): string {
    if (!linked.length) return "";
    const out: string[] = [];
    for (const l of linked) {
      const y0 = l.pts[0].y, yn = l.pts[l.pts.length - 1].y;
      if (yn - y0 < 40) continue;
      const opVaries = new Set(l.pts.map((p) => p.op.toFixed(2))).size > 1;
      const frames = l.pts.map((p) => {
        const pct = Math.round(((p.y - y0) / (yn - y0)) * 10000) / 100;
        return `${pct}% { transform: ${p.tf === "none" ? "none" : p.tf};${opVaries ? ` opacity: ${Math.round(p.op * 1000) / 1000};` : ""} }`;
      });
      out.push(`@keyframes sl-scroll-${l.id} { ${frames.join(" ")} }`);
      out.push(`[${SCROLL_ATTR}="${l.id}"] { animation: sl-scroll-${l.id} linear both; animation-timeline: scroll(root block); animation-range: ${y0}px ${yn}px; }`);
    }
    return (
      `/* Scroll-linked effects (parallax, scrubbed transforms) recorded by StyleLift while\n` +
      `   scrolling the live page, replayed on the page's scroll timeline. Without support,\n` +
      `   each element rests where it sits when centred on screen. */\n` +
      `@supports (animation-timeline: scroll()) {\n@media (prefers-reduced-motion: no-preference) {\n${out.join("\n")}\n}\n}\n`
    );
  }

  // Scroll reveals found during the scroll pass → CSS scroll-driven animations.
  const REVEAL_ATTR = "data-sl-reveal";
  // view() measures against the NEAREST scroll container, and any overflow:hidden box
  // is one (rounded image wrappers, clipped sections) even though it never scrolls —
  // a reveal inside one would never progress. Such reveals get a named view timeline
  // on the outermost clipping ancestor, which does move with the page.
  const TIMELINE_ATTR = "data-sl-vt";
  const TL_USE_ATTR = "data-sl-tl";
  const timelineOf = new Map<Element, string>();
  /** null → plain view(); Element → timeline anchor; false → no animation (pinned). */
  function revealAnchor(el: Element): Element | null | false {
    let anchor: Element | null = null;
    for (let a: Element | null = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === "sticky" || cs.position === "fixed") return false; // pinned content doesn't scroll by
      const clips = (v: string) => v !== "visible" && v !== "clip";
      if (a !== el && (clips(cs.overflowX) || clips(cs.overflowY))) anchor = a;
    }
    return anchor;
  }
  const reveals: { el: Element; id: string }[] = [];
  let cloneReveals = 0; // hidden-on-load elements given a scroll-in in the copy itself
  // elements whose look the scroll pass decided (revealed / curtain kept open): the
  // page may re-render them before the copy (React resets inline styles, Framer
  // replays "in view" effects) — their decided class/style is re-applied right before
  const decided = new Set<Element>();
  let maxWindowScroll = 0; // how far the window itself scrolled during the pass (0 = it scrolls inside a box)
  // count-up numbers ("98%", "28K", "3") reached during the pass: element → its text at the peak
  const countPeak = new Map<Element, { text: string; value: number }>();
  const COUNT_ATTR = "data-sl-count";
  // count-ups drawn from a CSS custom property (`--n` rising to `--to: 98`, shown with a
  // CSS counter): element → property → highest value seen
  const varPeak = new Map<HTMLElement, Map<string, number>>();
  const decidedState = new Map<Element, { cls: string | null; style: string | null }>();
  // identical starting states share one @keyframes (text effects reveal hundreds of
  // letters that all start the same way)
  const revealKinds = new Map<string, string>(); // from-declarations → id
  const revealIdFor = (f: { opacity: number; transform: string; filter: string; clipPath: string }): string => {
    const decl: string[] = [`opacity: ${Math.round(Math.max(0, Math.min(1, f.opacity)) * 1000) / 1000}`];
    if (f.transform && f.transform !== "none") decl.push(`transform: ${f.transform}`);
    if (f.filter && f.filter !== "none") decl.push(`filter: ${f.filter}`);
    if (f.clipPath && f.clipPath !== "none") decl.push(`clip-path: ${f.clipPath}`);
    const key = decl.join("; ");
    let id = revealKinds.get(key);
    if (!id) {
      id = `r${revealKinds.size + 1}`;
      revealKinds.set(key, id);
    }
    return id;
  };
  // The covering state of a concealer, as "from" declarations: the inline-style
  // properties that changed between the start and the retracted state.
  const ANIMATABLE = /^(opacity|transform|translate|scale|rotate|width|height|top|left|right|bottom|inset|clip-path|filter)$/;
  // parse through a scratch element so "top:0" and "top: 0px" compare equal
  const scratch = document.createElement("div");
  const parseDecls = (st: string | null) => {
    const m = new Map<string, string>();
    scratch.style.cssText = st || "";
    for (let i = 0; i < scratch.style.length; i++) {
      const k = scratch.style.item(i);
      m.set(k, scratch.style.getPropertyValue(k));
    }
    return m;
  };
  function concealFrom(pre: string | null, post: string | null): string | null {
    const a = parseDecls(pre), b = parseDecls(post);
    const out: string[] = [];
    for (const [k, v] of a) if (ANIMATABLE.test(k) && b.get(k) !== v) out.push(`${k}: ${v}`);
    return out.length ? out.join("; ") : null;
  }
  // ── live Rive / Lottie animations ──────────────────────────────────────────────
  // Declared ways a page names an animation file:
  //   • lottie-web's registry (tagged by the page-world settle step: data-sl-lottie-*)
  //   • Webflow: [data-animation-type="lottie"][data-src], [data-animation-type="rive"]
  //   • <lottie-player src>, any element whose src / data-src / data-rive-* points at .riv
  // Each becomes data-sl-anim="lottie|rive" + data-sl-anim-src, and one loader script
  // starts the matching runtime. Custom-coded Rive canvases (no file named in the DOM)
  // keep the screenshot of their frame.
  const LOTTIE_JS = "https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js";
  const RIVE_JS = "https://unpkg.com/@rive-app/canvas@2.21.6/rive.js";
  function wireLiveAnimations(root: Element): number {
    let n = 0;
    const mark = (el: Element, kind: "lottie" | "rive", src: string, extra: Record<string, string> = {}) => {
      if (!src || el.hasAttribute("data-sl-anim")) return;
      el.setAttribute("data-sl-anim", kind);
      el.setAttribute("data-sl-anim-src", src);
      for (const [k, v] of Object.entries(extra)) if (v) el.setAttribute(`data-sl-anim-${k}`, v);
      n++;
    };
    root.querySelectorAll("[data-sl-lottie-src], [data-sl-lottie-json]").forEach((el) => {
      const json = el.getAttribute("data-sl-lottie-json");
      mark(el, "lottie", el.getAttribute("data-sl-lottie-src") || "inline", {
        json: json || "", loop: el.getAttribute("data-sl-lottie-loop") || "1", autoplay: el.getAttribute("data-sl-lottie-autoplay") || "1",
        renderer: el.getAttribute("data-sl-lottie-renderer") || "svg",
      });
      ["src", "json", "loop", "autoplay", "renderer"].forEach((k) => el.removeAttribute(`data-sl-lottie-${k}`));
    });
    root.querySelectorAll('[data-animation-type="lottie"][data-src]').forEach((el) => {
      mark(el, "lottie", abs(el.getAttribute("data-src") || ""), {
        loop: el.getAttribute("data-loop") === "0" ? "0" : "1", autoplay: el.getAttribute("data-autoplay") === "0" ? "0" : "1",
        renderer: el.getAttribute("data-renderer") || "svg",
      });
    });
    root.querySelectorAll("lottie-player[src]").forEach((el) => {
      const src = el.getAttribute("src") || "";
      if (!/\.json(\?|#|$)/i.test(src) && !/^https?:/i.test(src)) return;
      // the custom element has no definition in the copy: a plain box that lottie-web fills
      const box = el.ownerDocument.createElement("div");
      for (const a of Array.from(el.attributes)) if (a.name !== "src") box.setAttribute(a.name, a.value);
      el.replaceWith(box);
      mark(box, "lottie", abs(src), { loop: el.hasAttribute("loop") ? "1" : "0", autoplay: el.hasAttribute("autoplay") ? "1" : "0", renderer: el.getAttribute("renderer") || "svg" });
    });
    root.querySelectorAll("*").forEach((el) => {
      if (el.hasAttribute("data-sl-anim")) return;
      for (const name of ["data-rive-url", "data-rive-src", "data-src", "src", "data-url"]) {
        const v = el.getAttribute(name) || "";
        if (/\.riv(\?|#|$)/i.test(v)) {
          mark(el, "rive", abs(v), {
            artboard: el.getAttribute("data-rive-artboard") || "",
            statemachine: el.getAttribute("data-rive-state-machine") || el.getAttribute("data-rive-statemachine") || "",
          });
          break;
        }
      }
    });
    if (!n) return 0;
    const doc = root.ownerDocument;
    const loader = doc.createElement("script");
    loader.setAttribute("data-sl-anim-runtime", "");
    // plain ES5 so it runs in any export; every step is optional (fallback frame stays)
    loader.textContent = `(function () {
  function load(src, cb) { var s = document.createElement("script"); s.src = src; s.async = true; s.onload = cb; document.head.appendChild(s); }
  var L = [].slice.call(document.querySelectorAll('[data-sl-anim="lottie"]'));
  var R = [].slice.call(document.querySelectorAll('[data-sl-anim="rive"]'));
  if (L.length) load(${JSON.stringify(LOTTIE_JS)}, function () {
    L.forEach(function (el) {
      try {
        var json = el.getAttribute("data-sl-anim-json"), opts = { container: el, renderer: el.getAttribute("data-sl-anim-renderer") || "svg",
          loop: el.getAttribute("data-sl-anim-loop") !== "0", autoplay: el.getAttribute("data-sl-anim-autoplay") !== "0" };
        if (json) opts.animationData = JSON.parse(json); else opts.path = el.getAttribute("data-sl-anim-src");
        el.innerHTML = "";
        window.lottie.loadAnimation(opts);
      } catch (e) {}
    });
  });
  if (R.length) load(${JSON.stringify(RIVE_JS)}, function () {
    R.forEach(function (el) {
      try {
        var canvas = el.tagName === "CANVAS" ? el : null;
        var still = el.tagName === "IMG" ? el : el.querySelector("img[data-sl-canvas], canvas");
        if (!canvas) {
          canvas = document.createElement("canvas");
          var ref = still || el, r = ref.getBoundingClientRect();
          if (still) { canvas.className = still.className; canvas.setAttribute("style", still.getAttribute("style") || ""); }
          else canvas.style.cssText = "display:block;width:100%;height:100%";
          canvas.width = Math.max(1, Math.round((r.width || 300) * (window.devicePixelRatio || 1)));
          canvas.height = Math.max(1, Math.round((r.height || 150) * (window.devicePixelRatio || 1)));
          if (still && still !== el) still.replaceWith(canvas); else if (still === el) el.replaceWith(canvas); else el.appendChild(canvas);
        }
        var sm = el.getAttribute("data-sl-anim-statemachine");
        var inst = new window.rive.Rive({ src: el.getAttribute("data-sl-anim-src"), canvas: canvas, autoplay: true,
          artboard: el.getAttribute("data-sl-anim-artboard") || undefined, stateMachines: sm ? [sm] : undefined,
          onLoad: function () { try { inst.resizeDrawingSurfaceToCanvas(); if (!sm && inst.stateMachineNames && inst.stateMachineNames.length) inst.play(inst.stateMachineNames[0]); } catch (e) {} } });
      } catch (e) {}
    });
  });
})();`;
    (root.querySelector("body") || root).appendChild(loader); // the COPY's body, never the live page
    return n;
  }
  // A scroll-in completes 35vh after the element starts entering. Near the end of the
  // page there may be no scroll left for that: the element would stay half-hidden
  // forever, so it keeps its final look instead.
  function canReplay(el: Element): boolean {
    const top = el.getBoundingClientRect().top + scrollY;
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return docHeight - top >= innerHeight * 0.4;
  }
  function revealIdForDecl(key: string): string {
    let id = revealKinds.get(key);
    if (!id) {
      id = `r${revealKinds.size + 1}`;
      revealKinds.set(key, id);
    }
    return id;
  }
  function revealCss(): string {
    if (!reveals.length && !cloneReveals) return "";
    const kf: string[] = [];
    const rules: string[] = [];
    for (const [decl, id] of revealKinds) {
      kf.push(`@keyframes sl-reveal-${id} { from { ${decl}; } }`);
      // the reveal completes within the first 35% of the viewport height after the
      // element starts entering — independent of how tall the element is
      // (one scrubbed over a longer stretch carries its own measured range in --sl-rr)
      rules.push(`[${REVEAL_ATTR}="${id}"] { animation: sl-reveal-${id} linear both; animation-timeline: view(); animation-range: var(--sl-rr, entry 0% entry 35vh); }`);
    }
    const tls = Array.from(timelineOf.values());
    const tlCss = tls.length
      ? `html { timeline-scope: ${tls.map((t) => `--sl-${t}`).join(", ")}; }\n` +
        tls.map((t) => `[${TIMELINE_ATTR}="${t}"] { view-timeline: --sl-${t} block; }\n[${TL_USE_ATTR}="${t}"] { animation-timeline: --sl-${t}; }`).join("\n") + "\n"
      : "";
    return (
      `/* Scroll-triggered reveals recorded by StyleLift, replayed with CSS scroll-driven animations.\n` +
      `   Browsers without animation-timeline simply show the final state. */\n` +
      `@supports (animation-timeline: view()) {\n@media (prefers-reduced-motion: no-preference) {\n${kf.join("\n")}\n${rules.join("\n")}\n${tlCss}}\n}\n`
    );
  }

  const topBars: { el: HTMLElement; html: string; sig: string }[] = [];
  const barSignature = (el: Element) => `${el.querySelectorAll("*").length}|${(el.textContent || "").replace(/\s+/g, " ").trim()}`;

  // ── 1. deferred content ────────────────────────────────────────────────────
  async function loadDeferred(): Promise<void> {
    // the intro recorder (if this is the page-start reload): whatever its intro showed and took away again is
    // decided now, before our scrolling moves anything
    try {
      document.dispatchEvent(new CustomEvent("sl-exits"));
    } catch {
      /* no recorder on this page */
    }
    // the page lays itself out again for its window (sizes measured, sliders fitted) — and a page that rebuilds on
    // resize (wearebulletproof.com splits its texts into letters again) does it now, before the snapshot, not
    // after the scroll pass where it would swap out every letter the pass watched
    dispatchEvent(new UIEvent("resize"));
    await sleep(300);
    const sx = scrollX, sy = scrollY;
    // Pinned bars at the top (headers / navs) often swap to a compact "scrolled"
    // version, rebuilding their content. Keep their at-the-top content.
    topBars.length = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (topBars.length >= 6) break;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      const r = el.getBoundingClientRect();
      if (r.top > 40 || r.width < innerWidth * 0.5 || r.height < 24 || r.height > innerHeight * 0.4) continue;
      if (topBars.some((b) => b.el.contains(el))) continue;
      topBars.push({ el, html: el.innerHTML, sig: barSignature(el) });
    }
    // Snapshot class + style on every element so the page's own scroll handlers
    // (Webflow nav, sticky headers, scroll-synced show/hide, etc.) can't leave the
    // live page in a disturbed state after capture.
    // Also watch every style/class mutation during the scroll and remember each
    // element's MOST REVEALED state: scroll-triggered reveals (Framer whileInView,
    // GSAP ScrollTrigger, AOS, Webflow IX) must stay revealed in the copy, while
    // other side effects (menus opened by scroll handlers) are undone.
    // scroll step (set before the pass starts; used to back-date the first pinned sample)
    let stepPx = Math.max(240, Math.floor(innerHeight * 0.45));
    const liveSnapshot: { el: Element; cls: string | null; style: string | null }[] = [];
    const allLive = document.querySelectorAll("*");
    for (let i = 0; i < allLive.length; i++) {
      const el = allLive[i];
      liveSnapshot.push({ el, cls: el.getAttribute("class"), style: el.getAttribute("style") });
    }
    // Elements the page makes while we scroll (text split into words as its section comes in, a section a framework
    // mounts on the way): not in the snapshot, so remembered as they were made — their class and style before the
    // page first changed them — and judged with everything else (a reveal, a scroll effect, or put back)
    const inSnapshot = new Set<Element>(Array.from(allLive));
    const lateBorn = new Map<Element, { cls: string | null; style: string | null }>();
    const visualOf = (el: Element) => {
      const cs = getComputedStyle(el);
      const op = parseFloat(cs.opacity);
      return { opacity: isNaN(op) ? 1 : op, transform: cs.transform, filter: cs.filter, clipPath: cs.clipPath, visibility: cs.visibility };
    };
    // "at rest": animation libraries end a slide at translate(0, 0) — computed matrix(1, 0, 0, 1, 0, 0), not
    // "none" — and a wipe at inset(0). Judging those as moved hid every slide-only reveal (text lines rising
    // in their masks, images gliding in) from the reveal detection.
    const restingTf = (t: string) => {
      if (!t || t === "none") return true;
      const m = /^matrix(3d)?\(([^)]+)\)$/.exec(t);
      if (!m) return false;
      const n = m[2].split(",").map((x) => parseFloat(x));
      const [a, b, c, d, e, f] = m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n;
      return Math.abs(a - 1) < 0.01 && Math.abs(d - 1) < 0.01 && Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && Math.abs(e) < 0.5 && Math.abs(f) < 0.5;
    };
    const restingClip = (c: string) => !c || c === "none" || /^inset\(\s*0(px|%)?(\s+0(px|%)?){0,3}\s*\)$/.test(c);
    const score = (v: ReturnType<typeof visualOf>) =>
      v.opacity + (restingTf(v.transform) ? 0.4 : 0) + (v.filter === "none" ? 0.1 : 0) + (restingClip(v.clipPath) ? 0.2 : 0) + (v.visibility === "hidden" ? -1 : 0);
    type Seen = {
      pre: ReturnType<typeof visualOf>; preScore: number; best: number; cls: string | null; style: string | null; at: ReturnType<typeof visualOf>;
      // concealers (curtains / overlays that retract to uncover content)
      preCover: number; minCover: number; minCls: string | null; minStyle: string | null; minTop: number;
      // revealed by a class on a section around it (an in-view observer, Locomotive's is-inview): that
      // section's class when this element looked its best, so the copy can keep it
      ancCls?: string | null;
    };
    const coverOf = (el: Element, v: ReturnType<typeof visualOf>) => {
      const r = el.getBoundingClientRect();
      return v.visibility === "hidden" ? 0 : Math.max(0, r.width) * Math.max(0, r.height) * v.opacity;
    };
    const seen = new Map<Element, Seen>();
    const samples = new Map<Element, { y: number; tf: string; op: number }[]>();
    // Pinned scroll stories (a tall section with a sticky screen whose steps switch as
    // you scroll): their children change on and off with the scroll position. Sample
    // their SETTLED look at every stop — a class toggle observed at the moment it
    // happens only shows where its CSS transition starts.
    const stickyOf = new Map<Element, boolean>();
    const inSticky = (el: Element): boolean => {
      const chain: Element[] = [];
      let hit = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const known = stickyOf.get(a);
        if (known !== undefined) { hit = known; break; }
        chain.push(a);
        if (getComputedStyle(a).position === "sticky") { hit = true; break; }
      }
      for (const a of chain) stickyOf.set(a, hit);
      return hit;
    };
    const stickyWatch = new Set<Element>();
    const stickySamples = new Map<Element, { y: number; tf: string; op: number }[]>();
    // Content that switches as you scroll anywhere else (the active item of a list lighting up, posters /
    // captions taking turns): anything that changed while scrolling has its SETTLED look sampled at every stop
    // from then on; one that turns on and off again is replayed on the scroll position.
    const switchWatch = new Set<Element>();
    const switchSamples = new Map<Element, { y: number; tf: string; op: number }[]>();
    // Timed reveals: how an element moved at the stop where it came in — when its first frame changed (after
    // the earliest change anything made at that stop: the trigger), how long until its last, and the shape of
    // the curve. The copy replays the reveal over that time, with that delay (the stagger of letters / words /
    // cards), when it comes into view — not scrubbed by the scroll position.
    let stopN = 0;
    const stopYs = new Map<number, number>(); // where each stop of the pass scrolled to
    const firstStop = new Map<Element, number>(); // the stop at which each element first changed
    type Tween = { stop: number; first: number; last: number; n: number; key: string; pts: { t: number; v: ReturnType<typeof visualOf> }[]; wait?: boolean };
    const tweenNow = new Map<Element, Tween>();
    const tweenBest = new Map<Element, Tween>();
    const stopFirst = new Map<number, number>();
    // how many separate bursts of motion (one per stop, settled in between): an eased scroll scrub, not a tween
    const movedStops = new Map<Element, number>();
    const keepTween = (el: Element, tw: Tween) => {
      if (tw.n < 3 || tw.last - tw.first < 90) return;
      const b = tweenBest.get(el);
      if (!b || tw.n > b.n) tweenBest.set(el, tw);
    };
    let scrollPhase: "idle" | "down" | "done" | "still" = "idle";
    // The site's bar (a <header> fixed / sticky to the screen, or a short one) is chrome; a page's hero built as
    // a <header> (tall, in the flow: the big words moving as you scroll) is content
    const barOf = new WeakMap<Element, boolean>();
    const isBar = (h: Element): boolean => {
      let v = barOf.get(h);
      if (v === undefined) {
        const pos = getComputedStyle(h).position;
        v = pos === "fixed" || pos === "sticky" || h.getBoundingClientRect().height < innerHeight * 0.5;
        barOf.set(h, v);
      }
      return v;
    };
    const inChrome = (el: Element) => {
      if (el.closest("nav, [role='navigation'], [role='menu'], [role='dialog'], [class*='dropdown' i], [class*='menu' i]")) return true;
      for (let h = el.closest("header"); h; h = h.parentElement?.closest("header") || null) if (isBar(h)) return true;
      return false;
    };
    // elements that keep changing after the scrolling stopped are driven by timers
    // (carousels, odometer numbers, tickers), not by our scroll: keep their latest state
    const timerTouched = new Set<Element>();
    const stillRoots = new Set<Element>(); // what itself changed with the page at rest
    const offStops = new Map<Element, { stop: number; n: number }>(); // changes while far off screen, by stop
    const offCandidates = new Set<Element>(); // …at three or more stops: a timer, perhaps
    const slideBlock = new Set<Element>(); // inside a slideshow's block: kept as it is now (still scroll-linked if it is)
    // eased by the scroll (apple.com's scroll animations move part of the way to where the scroll says, a moment
    // after each stop): its samples settled part-way at several stops — a slide only flips on and off. Such an
    // element still gliding into place once the page is at rest is not a timer's doing.
    const easedScrub = (el: Element): boolean => {
      const arr = samples.get(el);
      if (!arr || arr.length < 4) return false;
      const mv = (p: { tf: string }) => { const m = matrixNums(p.tf); return m.length === 16 ? [m[12], m[13]] : m.length === 6 ? [m[4], m[5]] : [0, 0]; };
      const first = arr[0], last = arr[arr.length - 1];
      const e = mv(last), d0 = Math.hypot(mv(first)[0] - e[0], mv(first)[1] - e[1]);
      const prog = (p: { tf: string; op: number }) => Math.abs(last.op - first.op) > 0.05 ? (p.op - first.op) / (last.op - first.op) : d0 > 2 ? 1 - Math.hypot(mv(p)[0] - e[0], mv(p)[1] - e[1]) / d0 : NaN;
      return arr.filter((p) => { const q = prog(p); return q > 0.08 && q < 0.92; }).length >= 2;
    };
    // (an eased one that is STILL changing well after the page came to rest is a timer after all: a ticker)
    const settling = new Map<Element, number>();
    let extending = false; // the longer watch at rest (slides only)
    const extendedRoots = new Set<Element>();
    const observe = (el: Element) => {
      if (scrollPhase === "still" && extending) {
        if (extendedRoots.size < 2000) extendedRoots.add(el);
      } else if (scrollPhase === "still") {
        if (easedScrub(el)) settling.set(el, performance.now());
        else {
          if (!timerTouched.has(el)) dbg(el, "changed with the page at rest → timer-driven");
          timerTouched.add(el); // page at rest, nothing scrolling it
          if (stillRoots.size < 2000) stillRoots.add(el);
        }
      } else if (scrollPhase === "down" && offCandidates.size < 2000 && !offCandidates.has(el)) {
        // changed while far off screen (the hero's slideshow, as we scroll the page's middle) — maybe a timer, maybe
        // the page's scroll system tidying what is out of view (apple.com rewrites its headings far away). Not taken
        // for a slideshow by itself: it only makes us watch the page at rest longer, where a timer shows itself.
        // (at three or more separate stops — a lazy picture loading ahead of us changes once)
        const r0 = el.getBoundingClientRect();
        if (r0.height > 0 && (r0.bottom < -innerHeight * 0.5 || r0.top > innerHeight * 1.5)) {
          const seen = offStops.get(el);
          if (!seen) offStops.set(el, { stop: stopN, n: 1 });
          else if (seen.stop !== stopN) {
            seen.stop = stopN;
            if (++seen.n >= 3) offCandidates.add(el);
          }
        }
      }
      if (el instanceof HTMLElement && el.style.position === "fixed" && el.parentElement?.classList.contains("pin-spacer")) pinTop.set(el, parseFloat(el.style.top) || 0);
      if (el instanceof HTMLElement && el.style.length) {
        for (let i = 0; i < el.style.length; i++) {
          const prop = el.style.item(i);
          if (!prop.startsWith("--")) continue;
          const v = parseFloat(el.style.getPropertyValue(prop));
          if (isNaN(v)) continue;
          let m = varPeak.get(el);
          if (!m) varPeak.set(el, (m = new Map()));
          if (!m.has(prop) || v > m.get(prop)!) m.set(prop, v);
        }
      }
      // the site's bar / menus: sampled for motion tied to the scroll position (a logo shrinking, a progress
      // line) but never a reveal — menu state is not page motion
      const chrome = inChrome(el);
      let s0 = seen.get(el);
      const v = visualOf(el);
      if (scrollPhase === "down" && !firstStop.has(el)) firstStop.set(el, stopN);
      if (scrollPhase === "down" && !chrome && !stickyWatch.has(el) && !switchWatch.has(el) && switchWatch.size < 2000 && el instanceof HTMLElement && !inSticky(el)) {
        switchWatch.add(el);
        const v0 = startVisual.get(el);
        if (v0) switchSamples.set(el, [{ y: startY, tf: v0.transform, op: v0.opacity }, ...(Math.round(scrollY) - stepPx > startY ? [{ y: Math.round(scrollY) - stepPx, tf: v0.transform, op: v0.opacity }] : [])]);
      }
      if (scrollPhase === "down" && !chrome && !stickyWatch.has(el) && stickyWatch.size < 1000 && el instanceof HTMLElement && inSticky(el)) {
        stickyWatch.add(el);
        // it looked like its starting self until the stop before this one
        const v0 = startVisual.get(el);
        if (v0) stickySamples.set(el, [{ y: startY, tf: v0.transform, op: v0.opacity }, ...(Math.round(scrollY) - stepPx > startY ? [{ y: Math.round(scrollY) - stepPx, tf: v0.transform, op: v0.opacity }] : [])]);
      }
      if (scrollPhase === "down") {
        const now = performance.now();
        const k = `${v.opacity.toFixed(3)}|${v.transform}|${v.clipPath}|${v.filter}`;
        let tw = tweenNow.get(el);
        // a new stop starts a new record — unless the element is still mid-tween (it began before we scrolled on)
        if (!tw || (tw.stop !== stopN && now - tw.last > 120)) {
          if (tw) keepTween(el, tw);
          if (tw && tw.n > 0) movedStops.set(el, (movedStops.get(el) || 0) + 1);
          // (its style rewritten with nothing changed yet — a script setting every word of a staggered line on every
          // frame, those still waiting their turn included: its clock starts when it really starts to move)
          const prevArr = samples.get(el), lp = prevArr && prevArr[prevArr.length - 1], sv = startVisual.get(el);
          const before = lp ? { tf: lp.tf, op: lp.op } : sv ? { tf: sv.transform, op: sv.opacity } : null;
          const wait = !!before && before.tf === v.transform && Math.abs(before.op - v.opacity) <= 0.001;
          tw = { stop: stopN, first: now, last: now, n: 0, key: k, pts: [{ t: now, v }], wait };
          tweenNow.set(el, tw);
          const f0 = stopFirst.get(stopN);
          if (!wait && (f0 === undefined || now < f0)) stopFirst.set(stopN, now);
        } else if (tw.key !== k) {
          if (tw.wait) {
            tw.wait = false;
            tw.first = tw.last = now - 16; // the frame before this one still showed where it started
            tw.pts = [{ t: now - 16, v: tw.pts[0].v }];
            const f0 = stopFirst.get(tw.stop);
            if (f0 === undefined || now - 16 < f0) stopFirst.set(tw.stop, now - 16);
          }
          tw.n++;
          tw.last = now;
          tw.key = k;
          if (tw.pts.length < 80) tw.pts.push({ t: now, v });
        }
        // sample (scroll position → transform/opacity) for scroll-linked effects
        let arr = samples.get(el);
        if (!arr) {
          // the state at the starting scroll position is the first sample: elements
          // that move away as you scroll (hero letters) rest where they started
          samples.set(el, (arr = []));
          const v0 = startVisual.get(el);
          if (v0) arr.push({ y: startY, tf: v0.transform, op: v0.opacity });
        }
        const last = arr[arr.length - 1];
        const y = Math.round(scrollY);
        if (!last || last.tf !== v.transform || Math.abs(last.op - v.opacity) > 0.01) arr.push({ y, tf: v.transform, op: v.opacity });
        else if (last.y !== y && arr.length < 400) arr.push({ y, tf: v.transform, op: v.opacity });
      }
      if (chrome) return;
      const sc = score(v);
      if (!s0) {
        // first mutation: the pre-state is whatever the snapshot recorded; recompute it
        // from the attribute snapshot by temporarily trusting the first observed value
        const pc = startCover.get(el) ?? coverOf(el, v);
        s0 = { pre: preVisual.get(el) || v, preScore: preVisual.has(el) ? score(preVisual.get(el)!) : sc, best: -Infinity, cls: null, style: null, at: v, preCover: pc, minCover: Infinity, minCls: null, minStyle: null, minTop: 0 };
        seen.set(el, s0);
      }
      if (scrollPhase === "down") {
        const cv = coverOf(el, v);
        if (cv < s0.minCover) {
          s0.minCover = cv;
          s0.minCls = el.getAttribute("class");
          s0.minStyle = el.getAttribute("style");
          s0.minTop = el.getBoundingClientRect().top;
        }
      }
      if (sc > s0.best) {
        s0.best = sc;
        s0.cls = el.getAttribute("class");
        s0.style = el.getAttribute("style");
        s0.at = v;
        const anc = viaAncestor.get(el);
        if (anc) s0.ancCls = anc.getAttribute("class");
      }
    };
    // Elements revealed through a class on a section around them: their own class and style never change,
    // so they're followed from the moment that section's class changes, and looked at again at every stop
    // (a CSS transition shows its end only after it ran).
    const viaAncestor = new Map<Element, Element>();
    const classKids = new Set<Element>();
    // elements whose OWN class changed while scrolling (an in-view library adding "aos-animate" / "in"): the
    // change is seen as its transition starts, before anything moved — looked at again once it ran
    const classSelf = new Set<Element>();
    // Slideshows on a timer: an element whose class comes BACK to a value it had (on → off → on) while the page
    // wasn't being scrolled is driven by a timer, not by the scroll — a reveal changes once. It keeps the state
    // it has when copied (one slide), as do its contents.
    const clsHist = new Map<Element, { vals: string[]; late: boolean }>();
    let lastScrollAt = 0;
    // pre-visuals only for plausible reveal candidates (hidden or offset now)
    const preVisual = new Map<Element, ReturnType<typeof visualOf>>(); // reveal candidates
    const startVisual = new Map<Element, ReturnType<typeof visualOf>>(); // everything, for scroll sampling
    const startCover = new Map<Element, number>(); // absolutely positioned elements: opacity × area
    const startY = Math.round(scrollY);
    for (let i = 0; i < allLive.length; i++) {
      const el = allLive[i];
      if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue;
      const v = visualOf(el);
      startVisual.set(el, v);
      if (getComputedStyle(el).position === "absolute") startCover.set(el, coverOf(el, v));
      if (v.opacity < 0.5 || v.transform !== "none" || v.clipPath !== "none" || v.filter !== "none" || v.visibility === "hidden") preVisual.set(el, v);
    }
    let lastMutation = 0;
    // an element that has been changing non-stop for ~2 s (marquee, ticker, loop) is
    // not something a scroll step should wait for
    const streaks = new Map<Element, { start: number; last: number }>();
    const varLook = new WeakMap<Element, number>();
    const revealObserver = new MutationObserver((records) => {
      const now = performance.now();
      const batch = new Set<Element>();
      // a script setting a progress variable on a section (--progress, --x) moves its children through CSS
      // (transform: translateX(var(--x))): their attributes never change, so they are looked at with it
      for (const r of records) {
        const t = r.target;
        if (r.attributeName !== "style" || scrollPhase !== "down" || !(t instanceof HTMLElement) || t === document.documentElement || t === document.body) continue;
        const vars = (v: string | null) => (v || "").split(";").filter((d) => /^\s*--/.test(d)).join(";");
        if (vars(t.getAttribute("style")) === vars(r.oldValue)) continue;
        if (varHosts.size < 200) varHosts.add(t);
        if (varLooks.size < 1200) varLooks.add(t);
        const nowV = performance.now();
        if (nowV - (varLook.get(t) || 0) < 90) continue;
        varLook.set(t, nowV);
        const kids = t.getElementsByTagName("*");
        for (let i = 0; i < kids.length && i < 300; i++) batch.add(kids[i]);
      }
      const bornNow = new Map<Element, Set<string>>(); // late-born elements first met in this batch: attributes read
      for (const r of records) {
        if (!(r.target instanceof Element) || inSnapshot.has(r.target) || !r.attributeName) continue;
        const t = r.target;
        let got = bornNow.get(t);
        if (!lateBorn.has(t)) {
          if (lateBorn.size >= 3000 || t === document.documentElement || t === document.body) continue;
          lateBorn.set(t, { cls: t.getAttribute("class"), style: t.getAttribute("style") });
          bornNow.set(t, (got = new Set()));
        }
        // its first change of each attribute in this batch tells what it was before (later ones already changed it)
        if (got && !got.has(r.attributeName)) {
          got.add(r.attributeName);
          const rec = lateBorn.get(t)!;
          if (r.attributeName === "class") rec.cls = r.oldValue; else if (r.attributeName === "style") rec.style = r.oldValue;
        }
      }
      for (const r of records) {
        if (!(r.target instanceof Element)) continue;
        batch.add(r.target);
        // a class change on a section: its children that started hidden / offset come along
        if (r.attributeName === "class" && scrollPhase === "down" && r.target !== document.documentElement && r.target !== document.body && classSelf.size < 2500) classSelf.add(r.target);
        if (r.attributeName === "class" && (scrollPhase === "down" || scrollPhase === "still") && clsHist.size < 4000) {
          const v = r.target.getAttribute("class") || "";
          let h = clsHist.get(r.target);
          if (!h) clsHist.set(r.target, (h = { vals: [r.oldValue || ""], late: false }));
          if (h.vals[h.vals.length - 1] !== v) h.vals.push(v);
          if (performance.now() - lastScrollAt > 700) h.late = true;
        }
        if (r.attributeName === "class" && scrollPhase === "down" && r.target !== document.documentElement && r.target !== document.body && classKids.size < 2500) {
          const kids = r.target.getElementsByTagName("*");
          for (let i = 0; i < kids.length && i < 400; i++) {
            const d = kids[i];
            if (!preVisual.has(d)) continue;
            if (!viaAncestor.has(d)) viaAncestor.set(d, r.target);
            classKids.add(d);
          }
        }
      }
      for (const el of batch) {
        const st = streaks.get(el);
        if (!st || now - st.last > 200) streaks.set(el, { start: now, last: now });
        else st.last = now;
        if (now - streaks.get(el)!.start < 1800) lastMutation = now;
        observe(el);
      }
    });
    revealObserver.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style", "class"], attributeOldValue: true });
    // Embedded players from other sites that the page takes out again once scrolled past (figma.com's
    // product videos only exist while on screen): remember where each was, so the copy can keep it
    const playerObserver = new MutationObserver((records) => {
      for (const rec of records) {
        for (const n of Array.from(rec.removedNodes)) {
          if (!(n instanceof Element)) continue;
          const frames = n.localName === "iframe" ? [n] : Array.from(n.querySelectorAll("iframe"));
          for (const f of frames) {
            const src = f.getAttribute("src") || "";
            let other = false;
            try {
              other = /^https?:$/.test(new URL(src, location.href).protocol) && new URL(src, location.href).origin !== location.origin;
            } catch {
              other = false;
            }
            if (!other || goneFrames.length >= 24 || goneFrames.some((g) => g.frame === f)) continue;
            // where to put it back: the removed subtree's old place (the iframe inside it, if it was nested)
            goneFrames.push({ frame: f, holder: n, parent: rec.target as Element, next: rec.nextSibling });
          }
        }
      }
    });
    playerObserver.observe(document.documentElement, { childList: true, subtree: true });
    // Count-up statistics animate their TEXT when scrolled into view (0 → 98%) and many
    // reset when they leave; remember each one's highest value.
    const NUMERIC = /^[\s$€£¥+\-−~≈]*\d[\d.,\s]*\s*(%|[KkMmBb]\+?|\+|x|×|hrs?|h|s|ms|°)?\s*$/;
    const numberOf = (t: string) => parseFloat(t.replace(/[^\d.]/g, "")) || 0;
    const countObserver = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.type === "characterData" ? r.target.parentElement : (r.target as Element);
        if (!el || !(el instanceof HTMLElement) || el.childElementCount > 0) continue;
        const t = (el.textContent || "").trim();
        if (t.length > 14 || !NUMERIC.test(t)) continue;
        const v = numberOf(t);
        const prev = countPeak.get(el);
        if (!prev || v > prev.value) countPeak.set(el, { text: el.textContent || "", value: v });
      }
    });
    countObserver.observe(document.body || document.documentElement, { characterData: true, childList: true, subtree: true });
    document.querySelectorAll<HTMLImageElement | HTMLIFrameElement>('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
      el.loading = "eager";
      stats.lazyEagered++;
    });
    // common data-attribute lazy patterns (lazysizes, WordPress, custom)
    const lazyAttrs = ["data-src", "data-lazy-src", "data-original", "data-lazy"];
    document.querySelectorAll<HTMLImageElement>("img, source").forEach((el) => {
      const cur = el.getAttribute("src") || "";
      for (const a of lazyAttrs) {
        const v = el.getAttribute(a);
        if (v && (!cur || cur.startsWith("data:") || /placeholder|blank|spacer/i.test(cur))) {
          el.setAttribute("src", v);
          stats.lazyEagered++;
          break;
        }
      }
      const ss = el.getAttribute("data-srcset") || el.getAttribute("data-lazy-srcset");
      if (ss && !el.getAttribute("srcset")) el.setAttribute("srcset", ss);
    });

    // After each scroll step: in-view effects (reveals, curtains, counters) start a beat
    // after an element enters — an IntersectionObserver callback plus the effect's own
    // delay — and many run without touching the DOM. Stay a moment, then keep waiting
    // while the page is still changing or animating on screen (bounded per step).
    // `budget`: how long this stop may take at most (shrinks on long / heavy pages so
    // the pass still reaches the bottom; after the deadline it's a quick trigger pass)
    // Web Animations the page starts as things come into view (Framer Motion's in-view effects, motion-one, a
    // script's element.animate()) move things without touching the DOM: the mutation watch never sees them. Each one
    // is written down while it runs (its first frame, length, delay, easing, when it started, at which stop).
    // (only those the page starts while we scroll — one that ran at load and holds its value, a digit strip rolled
    // to its number, is no entrance: its held value is written into the copy as it is)
    const waapiSeen = new WeakSet<Animation>();
    const waapiIn = new Map<Element, { kf0: Record<string, string>; d: number; e: string; t0: number; stop: number }>();
    let waapiFrom = -1; // the page's animation clock when the pass began
    const startWaapi = () => {
      try {
        waapiFrom = Number(document.timeline.currentTime) || 0;
        for (const a of document.getAnimations()) waapiSeen.add(a); // already there before the pass
      } catch {
        waapiFrom = 0;
      }
    };
    let waapiAt = 0;
    const noteWaapi = (force = false) => {
      if (scrollPhase !== "down" || waapiIn.size >= 1500) return;
      // (every 200 ms at most: listing the page's animations makes the browser bring every style up to date)
      const now = performance.now();
      if (!force && now - waapiAt < 200) return;
      waapiAt = now;
      try {
        if (waapiFrom < 0) startWaapi();
        for (const a of document.getAnimations()) {
          if (waapiSeen.has(a)) continue;
          waapiSeen.add(a);
          if (typeof a.startTime === "number" && a.startTime < waapiFrom) continue;
          // (the site's CSS animations and transitions stay as they are; scroll-linked ones run on their own timeline)
          if (a instanceof CSSAnimation || a instanceof CSSTransition || (a.timeline && a.timeline !== document.timeline)) continue;
          const eff = a.effect as KeyframeEffect | null;
          const el = eff?.target;
          if (!eff || !el || eff.pseudoElement) continue;
          const tm = eff.getTiming();
          const d = Number(tm.duration);
          if (!isFinite(d) || d < 80 || d > 4000 || (tm.iterations ?? 1) !== 1) continue;
          const kfs = eff.getKeyframes();
          if (kfs.length < 2) continue;
          const k0 = kfs[0] as unknown as Record<string, unknown>;
          const kf0: Record<string, string> = {};
          for (const p of ["opacity", "transform", "translate", "scale", "rotate", "filter", "clipPath"]) if (k0[p] != null && k0[p] !== "") kf0[p] = String(k0[p]);
          if (!Object.keys(kf0).length) continue;
          const st = typeof a.startTime === "number" ? a.startTime : Number(document.timeline.currentTime) || performance.now();
          const t0 = st + Math.max(0, Number(tm.delay) || 0);
          const ease = String(tm.easing && tm.easing !== "linear" ? tm.easing : k0.easing || "linear");
          const prev = waapiIn.get(el);
          // (one element, several animations — opacity and transform apart, as Framer Motion runs them: merged)
          if (prev && prev.stop === stopN) {
            for (const k in kf0) if (!(k in prev.kf0)) prev.kf0[k] = kf0[k];
            prev.d = Math.max(prev.d, d);
            prev.t0 = Math.min(prev.t0, t0);
            continue;
          }
          waapiIn.set(el, { kf0, d, e: ease, t0, stop: stopN });
        }
      } catch {
        /* getAnimations unsupported */
      }
    };
    async function settleStep(budget = 810): Promise<void> {
      const first = Math.min(110, budget * 0.4);
      await sleep(first);
      await framesThenIdle(); // the page has seen this position before anything is judged
      noteWaapi(true);
      const t0 = performance.now();
      const rest = Math.max(0, budget - first);
      const dwell = t0 + Math.min(200, rest * 0.3), end = t0 + Math.min(700, rest);
      while (performance.now() < end) {
        const now = performance.now();
        noteWaapi();
        if (now >= dwell && now - lastMutation >= 140 && !animatingOnScreen()) break;
        await sleep(60);
      }
      noteWaapi(true);
    }
    const docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const deadline = performance.now() + o.maxScrollMs;
    // small enough that anything up to ~55% of the screen is FULLY in view at some
    // stop: "in view" effects often wait for (nearly) all of an element to show
    const step = stepPx;
    // window scroll pass
    if (docH() > innerHeight + 10) {
      let y = 0;
      scrollPhase = "down";
      startWaapi();
      sampleScrollClasses(Math.round(scrollY));
      if (o.scrollLinked) {
        pickScrubCanvases();
        await grabScrubFrames(Math.round(scrollY));
      }
      // Marquees / tickers moved by a script every frame (not a CSS animation the copy keeps, not a GSAP
      // loop the recorder sees): long strips inside a narrower clipping box. Their sideways speed is
      // measured around each stop, while they're on screen; the copy loops them with CSS.
      const strips = new Map<HTMLElement, { v: number[]; dist: number }>();
      try {
        for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
          if (strips.size >= 40 || el.childElementCount < 1) continue;
          const w = el.scrollWidth;
          let clip: HTMLElement | null = el.parentElement;
          for (let i = 0; clip && i < 4; clip = clip.parentElement, i++) if (/(hidden|clip)/.test(getComputedStyle(clip).overflowX)) break;
          if (!clip || clip === document.body) continue;
          const cw = clip.getBoundingClientRect().width;
          if (cw < 200 || w < cw * 1.3) continue;
          if (Array.from(strips.keys()).some((s2) => s2.contains(el) || el.contains(s2))) continue;
          // one repeat of its content: the first half when it's doubled, else itself when copies of it sit
          // side by side (each set moves by its own width)
          const kids = Array.from(el.children);
          const half = kids.length % 2 === 0 && kids.length >= 2 && kids.slice(0, kids.length / 2).map((k) => k.textContent).join("|") === kids.slice(kids.length / 2).map((k) => k.textContent).join("|");
          const twins = !!el.parentElement && Array.from(el.parentElement.children).filter((c) => c !== el && c.className === el.className && c.className).length > 0;
          const dist = half ? w / 2 : twins ? el.getBoundingClientRect().width : 0;
          if (dist > 20) strips.set(el, { v: [], dist });
        }
      } catch {
        /* layout reads only */
      }
      const stripX = (el: HTMLElement) => {
        const m = /matrix(3d)?\(([^)]+)\)/.exec(getComputedStyle(el).transform);
        if (!m) return 0;
        const n = m[2].split(",").map(parseFloat);
        return m[1] ? n[12] : n[4];
      };
      const stripsBefore = () => {
        const at = new Map<HTMLElement, { x: number; t: number }>();
        for (const el of strips.keys()) {
          const r = el.getBoundingClientRect();
          if (r.bottom > 0 && r.top < innerHeight) at.set(el, { x: stripX(el), t: performance.now() });
        }
        return at;
      };
      const stripsAfter = (at: Map<HTMLElement, { x: number; t: number }>) => {
        for (const [el, a] of at) {
          const dt = performance.now() - a.t;
          if (dt < 150) continue;
          strips.get(el)!.v.push(((stripX(el) - a.x) / dt) * 1000);
        }
      };
      // Never stop short of the bottom: sections never scrolled to never get their
      // "in view" trigger and stay hidden in the copy. Each stop gets a share of the
      // time left; past the deadline the pass keeps going with quick stops (bounded).
      const hardStop = deadline + 15000;
      while (y < docH() - innerHeight && performance.now() < hardStop) {
        y += step;
        stopN++;
        stopYs.set(stopN, Math.min(y, Math.max(0, docH() - innerHeight)));
        lastScrollAt = performance.now();
        scrollTo(0, y);
        dispatchEvent(new Event("scroll"));
        stats.scrollSteps++;
        // GSAP reveals made as things come into view (ScrollTrigger.batch, onEnter callbacks) run for a
        // moment and are then dropped by GSAP: let the page react, then have them written down now
        // (capped: a tab in the background barely gets animation frames)
        await new Promise((res) => {
          requestAnimationFrame(() => requestAnimationFrame(() => res(null)));
          setTimeout(() => res(null), 120);
        });
        try {
          document.dispatchEvent(new CustomEvent("sl-gsap-record"));
        } catch {
          /* no recorder on this page */
        }
        const left = Math.max(1, Math.ceil((docH() - innerHeight - y) / step) + 1);
        const share = (deadline - performance.now()) / left;
        const stripAt = strips.size ? stripsBefore() : null;
        await settleStep(share > 0 ? Math.max(260, Math.min(810, share)) : 160);
        if (stripAt) stripsAfter(stripAt);
        for (const el of classKids) observe(el); // their look after the section's transition ran
        for (const el of classSelf) if (!classKids.has(el)) observe(el); // …and their own
        for (const el of varLooks) if (!classSelf.has(el) && el.isConnected) observe(el); // …and where their variables took them
        if (DBG && dbgLog.length < 250) {
          try {
            const firsts = Array.from(document.querySelectorAll(DBG)).slice(0, 2);
            dbgLog.push(`stop at ${Math.round(scrollY)}: ` + firsts.map((e) => `[${(e.getAttribute("style") || "").replace(/position: relative; display: inline-block; /, "").slice(0, 70)}] ${getComputedStyle(e).transform} top ${Math.round(e.getBoundingClientRect().top)}`).join(" | "));
          } catch {
            /* selector */
          }
        }
        maxWindowScroll = Math.max(maxWindowScroll, scrollY);
        sampleScrollClasses(Math.round(scrollY));
        for (const h of varHosts) {
          let m = varSamples.get(h);
          if (!m) varSamples.set(h, (m = new Map()));
          for (let i = 0; i < h.style.length; i++) {
            const prop = h.style.item(i);
            if (!prop.startsWith("--")) continue;
            let arr = m.get(prop);
            if (!arr) {
              // its value at the top of the page (before the pass), as the first sample
              const pre = liveSnapshot.find((x) => x.el === h)?.style || "";
              const m0 = new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`).exec(pre);
              // …and still that at the stop before this one (it only began to change since)
              arr = m0 ? [{ y: startY, v: m0[1].trim() }, ...(varStopY > startY ? [{ y: varStopY, v: m0[1].trim() }] : [])] : [];
              m.set(prop, arr);
            }
            const v = h.style.getPropertyValue(prop).trim();
            const last = arr[arr.length - 1];
            if (arr.length < 120 && (!last || last.y !== Math.round(scrollY))) arr.push({ y: Math.round(scrollY), v });
          }
        }
        varStopY = Math.round(scrollY);
        if (o.scrollLinked) await grabScrubFrames(Math.round(scrollY));
        const yy = Math.round(scrollY);
        for (const el of stickyWatch) {
          const v = visualOf(el);
          const arr = stickySamples.get(el) || [];
          const last = arr[arr.length - 1];
          if (!last || last.y !== yy) arr.push({ y: yy, tf: v.transform, op: v.opacity });
          stickySamples.set(el, arr);
        }
        for (const el of switchWatch) {
          const v = visualOf(el);
          const arr = switchSamples.get(el) || [];
          const last = arr[arr.length - 1];
          if (!last || last.y !== yy) arr.push({ y: yy, tf: v.transform, op: v.opacity });
          switchSamples.set(el, arr);
        }
      }
      if (y < docH() - innerHeight) warnings.push("The page is very long or slow: the scroll pass stopped before the bottom, so effects further down may be missing.");
      for (const [el, st] of strips) {
        // steady: moving the same way at a similar speed at every look (a wrap-around jump is one odd sample)
        const vs = st.v.filter((v) => Math.abs(v) >= 8);
        if (!vs.length || el.hasAttribute("data-sl-gsap-loop") || getComputedStyle(el).animationName !== "none") continue;
        const same = vs.filter((v) => Math.sign(v) === Math.sign(vs[0]));
        if (same.length < Math.max(1, vs.length - 1)) continue;
        const speed = same.reduce((a, b) => a + Math.abs(b), 0) / same.length;
        const dir = Math.sign(same[0]);
        const rest = { o: "1", tr: "none", s: "none", r: "none", fi: "none", c: "none" };
        const a = `matrix(1, 0, 0, 1, ${dir < 0 ? 0 : -Math.round(st.dist)}, 0)`, b = `matrix(1, 0, 0, 1, ${dir < 0 ? -Math.round(st.dist) : 0}, 0)`;
        el.setAttribute("data-sl-gsap-loop", JSON.stringify({ f: { ...rest, t: a }, to: { ...rest, t: b }, d: Math.round((st.dist / speed) * 1000), dl: 0, e: "linear", yoyo: false }));
        stats.marquees = (stats.marquees || 0) + 1;
      }
      scrollTo(0, docH());
      dispatchEvent(new Event("scroll"));
      await sleep(200);
      scrollPhase = "done";
    }
    // nested full-size scroller (apps / smooth-scroll wrappers)
    const scroller = findScroller();
    if (scroller) {
      let y = 0;
      while (y < scroller.scrollHeight - scroller.clientHeight && performance.now() < deadline) {
        y += step;
        scroller.scrollTop = y;
        scroller.dispatchEvent(new Event("scroll"));
        stats.scrollSteps++;
        await settleStep();
      }
    }
    // Pictures a script fills only when they come near (apple.com's data-lazy: a 1×1 placeholder until then, the
    // real file named by nothing in the markup) that a long page's quick stops passed too fast: each visited
    // again, a moment each — nearby ones together; bounded (a few seconds, 40 stops)
    {
      const blank = (i: HTMLImageElement) => {
        if (!i.isConnected || !i.complete) return false;
        const src = i.currentSrc || i.src || "";
        if (!(src.startsWith("data:") || i.naturalWidth <= 2)) return false;
        const r = i.getBoundingClientRect(), pr = (i.parentElement?.tagName === "PICTURE" ? i.parentElement : i).getBoundingClientRect();
        return Math.max(r.width, pr.width) >= 16 && Math.max(r.height, pr.height) >= 16 && getComputedStyle(i).display !== "none";
      };
      const todo = Array.from(document.images).filter(blank).map((i) => ({ i, y: i.getBoundingClientRect().top + scrollY })).sort((a, b) => a.y - b.y);
      const t0 = performance.now();
      let stops = 0, lastY = -1e9;
      for (const it of todo) {
        if (stops >= 40 || performance.now() - t0 > 10000) break;
        if (!blank(it.i) || Math.abs(it.y - lastY) < innerHeight * 0.6) continue; // filled already / seen with the last stop
        lastY = it.y;
        stops++;
        scrollTo(0, Math.max(0, it.y - innerHeight / 2));
        dispatchEvent(new Event("scroll"));
        await sleep(250);
        for (let k = 0; k < 16 && blank(it.i); k++) await sleep(60);
      }
      if (stops) {
        stats.lazyRevisits = stops;
        scrollTo(sx, sy);
        await sleep(150);
      }
    }
    // (no "resize" here: the page was told once before the snapshot — after the pass a site that rebuilds on resize
    // (text split into letters again, a slider re-made) would swap out exactly what the pass watched)
    // wait for images (bounded)
    const imgs = Array.from(document.images);
    stats.images = imgs.length;
    const pending = imgs.filter((i) => !i.complete).map(
      (i) => new Promise<void>((r) => {
        i.addEventListener("load", () => r(), { once: true });
        i.addEventListener("error", () => r(), { once: true });
      }),
    );
    if (pending.length) await Promise.race([Promise.all(pending), sleep(8000)]);
    stats.imagesLoaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    await sleep(350); // let entrance transitions settle
    if (scroller) scroller.scrollTop = 0;
    scrollTo(sx, sy);
    await sleep(120);
    await waitQuiet(2500); // let re-triggered entrance animations finish
    // Page at rest: anything that still changes now is driven by a timer (carousel,
    // number roll-up, ticker). Watch a little longer if something is, to catch a cycle.
    scrollPhase = "still";
    await sleep(800);
    // something eased still gliding at rest: watched until it comes to rest (a glide slows down and stops, even a
    // slow one within a few seconds) or the watch ends — still moving then, it goes on by itself: a ticker
    if (settling.size) {
      for (let t = 800; t < 4000; t += 300) {
        const now = performance.now();
        let moving = false;
        for (const v of settling.values()) if (now - v < 600) { moving = true; break; }
        if (!moving) break;
        await sleep(300);
      }
      const endT = performance.now();
      for (const [el, t] of settling)
        if (endT - t < 600) {
          timerTouched.add(el);
          if (stillRoots.size < 2000) stillRoots.add(el);
        }
    }
    if (timerTouched.size) await sleep(2600);
    if (!timerTouched.size && offCandidates.size) {
      // something kept changing far off screen as we scrolled: watch the page at rest a while longer — a slideshow's
      // timer shows itself here (a slide every few seconds). What changes in this longer watch only goes to the
      // slide-set search below — not taken for a timer's doing (smooth scroll effects still settling there would
      // lose their scroll-linking: framer.com)
      extending = true;
      for (let t = 0; t < 6000 && !extendedRoots.size; t += 300) await sleep(300);
      if (extendedRoots.size) await sleep(1500);
      extending = false;
      for (const el of extendedRoots) if (stillRoots.size < 2000) stillRoots.add(el);
    }
    for (const [el, h] of clsHist) {
      // came back to an earlier class (A → B → A), at a moment nothing was scrolling it
      if (!h.late || h.vals.length < 3 || !h.vals.some((v, i) => h.vals.indexOf(v) < i - 1)) continue;
      if (!el.isConnected || el === document.body || el === document.documentElement) continue;
      timerTouched.add(el);
      const kids = el.getElementsByTagName("*");
      for (let i = 0; i < kids.length && i < 600; i++) timerTouched.add(kids[i]);
      stats.timerSlides = (stats.timerSlides || 0) + 1;
      stillRoots.add(el);
    }
    // A slideshow is a SET: slides taking turns (one looks different from its same-kind siblings — or two,
    // mid-crossfade), with titles, pictures and progress bars elsewhere in the same block following them.
    // One part seen changing with the page at rest means the timer drives the whole block, including the
    // parts that happened to change while we scrolled — kept all as they are now, so they agree (putting
    // back only those would show two slides at once).
    {
      const sig = (e: Element) => {
        const c = getComputedStyle(e);
        return `${Array.from(e.classList).sort().join(" ")}|${c.opacity}|${c.visibility}|${c.zIndex}|${c.display}`;
      };
      const blocks = new Set<Element>();
      let looked = 0;
      for (const root of stillRoots) {
        if (++looked > 300 || !root.isConnected || slideBlock.size > 20000) break;
        for (let a: Element | null = root, up = 0; a && up < 4; a = a.parentElement, up++) {
          const p = a.parentElement;
          if (!p || p === document.body || p === document.documentElement) break;
          const first = a.classList[0];
          const sibs = Array.from(p.children).filter((x) => x.tagName === a!.tagName && (!first || x.classList.contains(first)));
          if (sibs.length < 2 || sibs.length > 30) continue;
          if (!sibs.some((x) => { const r = x.getBoundingClientRect(); return r.width >= 100 && r.height >= 40; })) continue;
          const count = new Map<string, number>();
          for (const x of sibs) { const k = sig(x); count.set(k, (count.get(k) || 0) + 1); }
          const most = Math.max(...count.values());
          if (most === sibs.length || most < sibs.length - 2) continue; // all alike / no single slide on
          // the block: up from the set while it stays about a screen tall
          let block: Element = p;
          for (let b = p.parentElement; b && b !== document.body && b.getBoundingClientRect().height <= innerHeight * 1.5; b = b.parentElement) block = b;
          blocks.add(block);
          break;
        }
      }
      for (const b of blocks) {
        if (inChrome(b)) continue;
        slideBlock.add(b);
        const kids = b.getElementsByTagName("*");
        for (let i = 0; i < kids.length && i < 3000; i++) {
          slideBlock.add(kids[i]);
          dbg(kids[i], "inside a slideshow block (kept as it is)");
        }
        stats.timerSlides = (stats.timerSlides || 0) + 1;
      }
    }
    timerDriven = timerTouched.size > 0;
    revealObserver.disconnect();
    playerObserver.disconnect();
    countObserver.disconnect();
    for (const [el, rec] of lateBorn) if (el.isConnected) liveSnapshot.push({ el, ...rec });
    if (lateBorn.size) stats.lateBorn = lateBorn.size;
    // Resolve every element the scroll touched:
    //  • revealed (its best state is clearly more visible than before) → keep the
    //    best state and remember where it started, for a CSS scroll animation;
    //  • anything else (menus opened by scroll handlers…) → restore the original.
    let seq = 0;
    const concealed: { el: Element; shrunk: string[] }[] = [];
    const docTop = (el: Element) => el.getBoundingClientRect().top + scrollY;
    // where it sits in the layout (no transforms — as a view timeline sees it)
    const layoutTop = (el: HTMLElement) => {
      let y = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) y += n.offsetTop || 0;
      return y;
    };
    // pinned sections: seen fixed to the screen during the pass; GSAP's own start / end when settle.ts
    // could read them, else the spacer's top and padding (bundled GSAP)
    for (const [el, top] of pinTop) {
      const sp = el.parentElement;
      if (!el.isConnected || !sp || pinned.length >= 40) continue;
      let s = NaN, e = NaN;
      try {
        const j = JSON.parse(el.getAttribute("data-sl-pin") || "null") as { s?: number; e?: number } | null;
        if (j && typeof j.s === "number" && typeof j.e === "number") { s = j.s; e = j.e; }
      } catch {
        /* no record */
      }
      if (!isFinite(s)) {
        const pad = parseFloat((sp as HTMLElement).style.paddingBottom) || parseFloat(getComputedStyle(sp).paddingBottom) || 0;
        s = Math.round(docTop(sp) - top);
        e = s + Math.round(pad);
      }
      if (!(e - s >= 40)) continue;
      const id = `p${pinned.length + 1}`;
      pinned.push({ el, id, s: Math.max(0, s), e });
      el.setAttribute(PIN_ATTR, id);
    }
    const pinEls = new Set<Element>(pinned.map((p) => p.el));
    if (pinned.length) stats.pinned = pinned.length;
    for (const [el, tw] of tweenNow) keepTween(el, tw);
    // A reveal's own timing: measured from its frames (a script's tween), else its CSS transition (a class or
    // style set off a transition: the delay is often the stagger, set per element). The curve's shape at
    // half time picks the easing.
    const CSS_EASE: Record<string, string> = { ease: "ease", linear: "linear", "ease-in": "cubic-bezier(.42,0,1,1)", "ease-out": "cubic-bezier(0,0,.58,1)", "ease-in-out": "cubic-bezier(.42,0,.58,1)" };
    const easeOfFrames = (pts: { t: number; v: ReturnType<typeof visualOf> }[], from: ReturnType<typeof visualOf>): string => {
      const comp = (v: ReturnType<typeof visualOf>) => {
        const m = matrixNums(v.transform);
        return [v.opacity, m[4] || 0, m[5] || 0, m[0] ?? 1];
      };
      const a = comp(from), b = comp(pts[pts.length - 1].v);
      let c = 0, best = 0;
      [1, 0.01, 0.01, 1].forEach((w, i) => { const r = Math.abs(b[i] - a[i]) * w; if (r > best) { best = r; c = i; } });
      if (!(best > 0)) return "cubic-bezier(.22,1,.36,1)";
      const t0 = pts[0].t - 16, t1 = pts[pts.length - 1].t;
      const at = (f: number) => {
        const t = t0 + (t1 - t0) * f;
        let prev = { t: t0, p: 0 };
        for (const q of pts) {
          const p = (comp(q.v)[c] - a[c]) / (b[c] - a[c]);
          if (q.t >= t) return prev.p + ((p - prev.p) * (t - prev.t)) / Math.max(1, q.t - prev.t);
          prev = { t: q.t, p };
        }
        return 1;
      };
      const h = at(0.5), q = at(0.25);
      if (h >= 0.85) return "cubic-bezier(.16,1,.3,1)";
      if (h >= 0.72) return "cubic-bezier(.22,1,.36,1)";
      if (h >= 0.6) return "cubic-bezier(.25,.46,.45,.94)";
      if (h >= 0.42) return Math.abs(q - 0.25) < 0.08 ? "linear" : "cubic-bezier(.45,0,.55,1)";
      return "cubic-bezier(.55,.055,.675,.19)";
    };
    const timedList: { el: Element; spec: Record<string, unknown>; stop: number }[] = [];
    const revealShown = new Map<Element, number>(); // how visible each reveal was once it had come in
    const blockId = new Map<Element, number>();
    const timedSpec = (el: Element, s0: Seen): Record<string, unknown> | null => {
      const f = { o: String(s0.pre.opacity), t: s0.pre.transform || "none", tr: "none", s: "none", r: "none", fi: s0.pre.filter || "none", c: s0.pre.clipPath || "none" };
      const tw = tweenBest.get(el);
      if (tw) {
        const base = stopFirst.get(tw.stop) ?? tw.first;
        if (tw.first - base > 3000) return null; // started long after the stop: a timer's doing, not the scroll's
        return { f, d: Math.round(Math.max(120, Math.min(4000, tw.last - tw.first + 16))), dl: Math.round(Math.max(0, Math.min(5000, tw.first - base - 16))), e: easeOfFrames(tw.pts, s0.pre), tr: "scroll", m: "frames" };
      }
      const cs = getComputedStyle(el);
      const list = (v: string) => v.split(/,(?![^(]*\))/).map((x) => x.trim());
      const props = list(cs.transitionProperty), durs = list(cs.transitionDuration), dels = list(cs.transitionDelay), eases = list(cs.transitionTimingFunction);
      const ms = (x: string) => (/ms$/.test(x) ? parseFloat(x) : parseFloat(x) * 1000) || 0;
      let d = 0, dl = 0, e = "";
      props.forEach((p, i) => {
        if (!/^(all|opacity|transform|translate|scale|rotate|clip-path|filter)$/.test(p)) return;
        const di = ms(durs[i % durs.length]);
        if (di > d) { d = di; dl = ms(dels[i % dels.length]); e = eases[i % eases.length]; }
      });
      if (d < 60) return null; // an instant switch: nothing to time
      return { f, d: Math.round(Math.min(4000, d)), dl: Math.round(Math.max(0, Math.min(5000, dl))), e: CSS_EASE[e] || (/^cubic-bezier\(/.test(e) ? e : "ease"), tr: "scroll", m: "transition" };
    };
    // Entrances run as Web Animations (noteWaapi): replayed from their own first frame, with their own length, easing
    // and stagger (when each started after the first of its block at that stop) — when they come into view, or in a
    // pinned section at the scroll position where they played. Only what ended shown; hover / loop frames start
    // where the element is and are no entrance.
    const waapiDone = new Set<Element>();
    {
      const blockOf = (el: Element) => el.parentElement?.parentElement?.parentElement || el.parentElement || el;
      const blockIds = new Map<Element, number>();
      const seqOf = (b: Element) => {
        let n = blockIds.get(b);
        if (n === undefined) blockIds.set(b, (n = blockIds.size));
        return n;
      };
      const first = new Map<string, number>();
      for (const [el, w] of waapiIn) {
        const k = `${w.stop}|${seqOf(blockOf(el))}`;
        first.set(k, Math.min(first.get(k) ?? Infinity, w.t0));
      }
      for (const [el, w] of waapiIn) {
        if (!(el instanceof HTMLElement) || !el.isConnected || timerTouched.has(el) || slideBlock.has(el) || inChrome(el)) continue;
        if (el.hasAttribute("data-sl-gsap") || el.hasAttribute("data-sl-in") || el.hasAttribute("data-framer-appear-id")) continue;
        const cs = getComputedStyle(el);
        if (parseFloat(cs.opacity) < 0.5 || cs.visibility === "hidden" || getComputedStyle(el).position === "fixed") continue;
        const k = w.kf0;
        const f = { o: k.opacity ?? cs.opacity, t: k.transform ?? "none", tr: k.translate ?? "none", s: k.scale ?? "none", r: k.rotate ?? "none", fi: k.filter ?? "none", c: k.clipPath ?? "none" };
        const moved = (v: string, rest: string) => v !== "none" && v !== rest && !/^(translate([XYZ]|3d)?\(0(px)?(, ?0(px)?){0,2}\)|scale[XY]?\(1\)|rotate[XYZ]?\(0(deg)?\)|blur\(0(px)?\)|0px|0px 0px|1|inset\(0(px|%)?\))$/.test(v);
        if (!(parseFloat(f.o) < parseFloat(cs.opacity) - 0.1 || moved(f.t, cs.transform) || moved(f.tr, cs.translate) || moved(f.s, cs.scale) || moved(f.r, cs.rotate) || moved(f.fi, cs.filter) || moved(f.c, cs.clipPath))) continue;
        const dl = Math.round(Math.max(0, Math.min(3000, w.t0 - (first.get(`${w.stop}|${seqOf(blockOf(el))}`) ?? w.t0))));
        const e = /^(linear|ease(-in|-out|-in-out)?|cubic-bezier\([-\d.,\s]+\)|linear\([-\d.,%\s]+\))$/.test(w.e) ? w.e : "ease";
        el.setAttribute("data-sl-gsap", JSON.stringify({ f, d: Math.round(w.d), dl, e, tr: "scroll", m: "waapi" }));
        if (inSticky(el)) {
          const yAt = stopYs.get(w.stop), yBefore = stopYs.get(w.stop - 1) ?? startY;
          if (yAt !== undefined) el.setAttribute(IN_AT_ATTR, String(Math.round((Math.min(yBefore, yAt) + yAt) / 2)));
        }
        waapiDone.add(el);
        decided.add(el);
        stats.waapiEntrances = (stats.waapiEntrances || 0) + 1;
      }
    }
    // a row's children in a pinned section: at how many different stops they came in (half way to their end look)
    const rowSpreadOf = new Map<Element, number>();
    const rowSpread = (row: Element): number => {
      let n = rowSpreadOf.get(row);
      if (n !== undefined) return n;
      const at = new Set<number>();
      for (const k of Array.from(row.children)) {
        const sa = stickySamples.get(k);
        if (!sa || sa.length < 3) continue;
        const ops = sa.map((p) => p.op), lo = Math.min(...ops), hi = Math.max(...ops);
        if (hi - lo <= 0.3) continue;
        const first = sa.find((p) => (p.op - ops[0]) / (hi - lo) * Math.sign(ops[ops.length - 1] - ops[0] || 1) >= 0.5);
        if (first) at.add(first.y);
      }
      rowSpreadOf.set(row, (n = at.size));
      return n;
    };
    for (const { el, cls, style } of liveSnapshot) {
      try {
        if (!el.isConnected || waapiDone.has(el)) continue;
        const changed = el.getAttribute("class") !== cls || el.getAttribute("style") !== style;
        // a pinned section is held by its own scroll timeline: never a reveal or parallax layer; back to
        // how it looked before the page pinned it
        if (pinEls.has(el)) {
          if (changed) {
            if (cls === null) el.removeAttribute("class"); else el.setAttribute("class", cls);
            if (style === null) el.removeAttribute("style"); else el.setAttribute("style", style);
          }
          continue;
        }
        // pinned scroll story step: on and off with the scroll position → scroll-linked
        const sarr = o.scrollLinked ? stickySamples.get(el) : undefined;
        // (a word or letter of a split text: one of a row of four or more)
        const ofRow = !!el.parentElement && el.parentElement.childElementCount >= 4;
        if (sarr && sarr.length >= 3 && el instanceof HTMLElement && linked.length < (ofRow ? 600 : 250) && !timerTouched.has(el) && !inChrome(el)) {
          const pts = Array.from(new Map(sarr.map((p) => [p.y, p])).values()).sort((a, b) => a.y - b.y);
          const ops = pts.map((p) => p.op);
          const tys = pts.map((p) => matrixNums(p.tf)).filter((m) => m.length === 6);
          const opRange = Math.max(...ops) - Math.min(...ops);
          const tRange = tys.length ? Math.max(...tys.map((m) => Math.max(Math.abs(m[4]), Math.abs(m[5])))) - Math.min(...tys.map((m) => Math.max(Math.abs(m[4]), Math.abs(m[5])))) : 0;
          // on AND off again (a reveal that stays on keeps the reveal treatment)
          const bothWays = (vals: number[], tol: number) => {
            let up = false, down = false;
            for (let i = 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; if (d > tol) up = true; if (d < -tol) down = true; }
            return up && down;
          };
          const ty = tys.map((m) => m[5]);
          // …or one way only but scrubbed: caught part-way at two stops or more (words of a pinned text lighting up
          // as you scroll through it) — a reveal on a timer is hidden or shown at a stop, part-way at one at most
          const partWay = (vals: number[], tol: number) => {
            const lo = Math.min(...vals), hi = Math.max(...vals);
            if (hi - lo <= tol) return false;
            return vals.filter((x) => (x - lo) / (hi - lo) > 0.08 && (x - lo) / (hi - lo) < 0.92).length >= 2;
          };
          // …or one of a row (the words of a split text) that come in at different stops down the scroll — each
          // word's own change is short, but the row's is spread over the scroll (a timed row comes in all at one stop)
          const scrubbed = partWay(ops, 0.3) || (tys.length === pts.length && partWay(ty, 12)) || (ofRow && rowSpread(el.parentElement!) >= 3);
          // (but a row that came in all at one stop, each word moving on by itself for a moment after we stopped —
          // a timed entrance set off at that point of the pinned scroll: replayed as one, started there)
          const tb = tweenBest.get(el);
          const timedRow = ofRow && !!tb && tb.last - tb.first < 2500 && rowSpread(el.parentElement!) <= 2 && !bothWays(ops, 0.15) && !bothWays(ty, 8);
          const r = el.getBoundingClientRect();
          if (!timedRow && (opRange > 0.3 || tRange > 12) && (bothWays(ops, 0.15) || bothWays(ty, 8) || scrubbed) && ((r.width >= 20 && r.height >= 10) || (ofRow && r.width >= 4 && r.height >= 4))) {
            if (cls === null) el.removeAttribute("class"); else el.setAttribute("class", cls);
            el.setAttribute("style", style || "");
            const id = `s${linked.length + 1}`;
            el.setAttribute(SCROLL_ATTR, id);
            linked.push({ el, id, pts, preStyle: style });
            stats.pinnedSteps = (stats.pinnedSteps || 0) + 1;
            dbg(el, `scroll-linked in a pinned section (${pts.length} samples)`);
            continue;
          }
        }
        // scroll-linked (parallax / scrubbed): many distinct values at many scroll positions
        const arr = o.scrollLinked ? samples.get(el) : undefined;
        // one of a row of words / letters that all change with the scroll (scroll-scrubbed text)
        const inGroup = !!arr && !!el.parentElement && el.parentElement.childElementCount >= 4 && Array.from(el.parentElement.children).filter((c) => (samples.get(c)?.length || 0) >= 3).length >= 4;
        if (arr && arr.length >= 3 && el instanceof HTMLElement && linked.length < (inGroup ? 600 : 250) && !timerTouched.has(el) && isScrollLinked(el, arr, inGroup, inChrome(el)) && (revealAnchor(el) !== false || inChrome(el))) {
          const pts = Array.from(new Map(arr.map((p) => [p.y, p])).values()).sort((a, b) => a.y - b.y);
          {
            // static fallback (no scroll timelines): the state when the element is centred
            const centreY = docTop(el) - innerHeight / 2;
            const rest = pts.reduce((a, b) => (Math.abs(b.y - centreY) < Math.abs(a.y - centreY) ? b : a));
            if (cls === null) el.removeAttribute("class"); else el.setAttribute("class", cls);
            el.setAttribute("style", style || "");
            el.style.transform = rest.tf;
            el.style.opacity = String(rest.op);
            const id = `s${linked.length + 1}`;
            el.setAttribute(SCROLL_ATTR, id);
            linked.push({ el, id, pts, preStyle: style });
            dbg(el, `scroll-linked (${pts.length} samples)`);
            continue;
          }
        }
        const s0 = seen.get(el);
        // a reveal happens once and stays put; things still moving after the scrolling
        // stopped (odometer digits rolling through 0, carousels) are not reveals
        // Moved away from its "best" look while fully visible and on screen: a counter
        // or carousel that rolled after we scrolled back up (its digit 0 scores as
        // transform: none). A reveal settles on its most visible state, or hides
        // again off screen; this one is showing its real state now, so keep it.
        if (s0 && !timerTouched.has(el) && restingTf(s0.at.transform)) {
          const now = visualOf(el);
          const r = el.getBoundingClientRect();
          const onScreen = r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0;
          // a strip moved inside a much smaller clipping window (digit reel, ticker,
          // carousel track) shows its content by moving — wherever it is on the page
          const clip = el.parentElement;
          const track = !!clip && r.height > 0 && (() => {
            const cs = getComputedStyle(clip);
            if (!/(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) return false;
            const c = clip.getBoundingClientRect();
            return r.height >= c.height * 1.8 || r.width >= c.width * 1.8;
          })();
          if ((onScreen || track) && !restingTf(now.transform) && now.visibility !== "hidden" && now.opacity >= s0.at.opacity - 0.05 && s0.pre.opacity >= s0.at.opacity - 0.05) continue;
        }
        // a fixed element belongs to the viewport, not to a spot on the page: an overlay
        // shown only while you scroll through some sections (a 3D model "rolling along")
        // must look the way it does at the top, where the copy opens
        const pinned = !!s0 && getComputedStyle(el).position === "fixed";
        // switched on and off again while ON SCREEN as the page scrolled (the active item of a list, posters /
        // captions taking turns) — a reveal stays on, or hides only once scrolled away: replayed on the scroll
        // position, starting from how it looked at the top
        const warr = o.scrollLinked ? switchSamples.get(el) : undefined;
        // (a row's letters / words count apart: a page splits hundreds of them — wearebulletproof.com ~300)
        if (warr && warr.length >= 3 && el instanceof HTMLElement && linked.length < (ofRow ? 800 : 250) && !timerTouched.has(el) && !slideBlock.has(el) && !inChrome(el) && getComputedStyle(el).position !== "fixed") {
          const pts = Array.from(new Map(warr.map((p) => [p.y, p])).values()).sort((a, b) => a.y - b.y);
          const tys = pts.map((p) => matrixNums(p.tf));
          const top = docTop(el), hgt = el.getBoundingClientRect().height;
          const onScreen = (y: number) => top - y < innerHeight && top - y + hgt > 0; // any of it showing
          // a value that went one way and then back the other, the way back happening on screen
          const offOnScreen = (vals: number[], tol: number) => {
            let up = false, down = false;
            for (let i = 1; i < vals.length; i++) {
              const d = vals[i] - vals[i - 1];
              if (d > tol) { if (down && onScreen(pts[i].y)) return true; up = true; }
              if (d < -tol) { if (up && onScreen(pts[i].y)) return true; down = true; }
            }
            return false;
          };
          const r = el.getBoundingClientRect();
          // …or one showing all along that glides with the scroll stop after stop and never comes to rest (a wheel's
          // cards turning a quarter round as you scroll past, eased so each settles late — some only one way): moved
          // at three stops or more, eased by the scroll, not a timer's doing (a slide-in comes to rest: a reveal)
          let moves = 0;
          for (let i = 1; i < tys.length; i++) if (tys[i].length === 6 && tys[i - 1].length === 6 && (Math.abs(tys[i][4] - tys[i - 1][4]) > 4 || Math.abs(tys[i][5] - tys[i - 1][5]) > 4 || Math.abs(tys[i][0] - tys[i - 1][0]) > 0.02)) moves++;
          const glides = moves >= 3 && pts.every((p) => p.op >= 0.5) && !restingTf(pts[pts.length - 1].tf) && easedScrub(el);
          if (tys.every((m) => m.length === 6) && (offOnScreen(pts.map((p) => p.op), 0.3) || offOnScreen(tys.map((m) => m[5]), 12) || offOnScreen(tys.map((m) => m[4]), 12) || glides) && ((r.width >= 20 && r.height >= 10) || (ofRow && r.width >= 4 && r.height >= 4))) {
            if (cls === null) el.removeAttribute("class"); else el.setAttribute("class", cls);
            if (style === null) el.removeAttribute("style"); else el.setAttribute("style", style);
            const id = `s${linked.length + 1}`;
            el.setAttribute(SCROLL_ATTR, id);
            linked.push({ el, id, pts, preStyle: style });
            stats.switchSteps = (stats.switchSteps || 0) + 1;
            dbg(el, `switching with the scroll on screen / gliding (${pts.length} samples)`);
            continue;
          }
        }
        const isReveal = !!s0 && !pinned && !timerTouched.has(el) && !slideBlock.has(el) && s0.best >= s0.preScore + 0.3 && s0.at.opacity > 0.5;
        // came in with its OWN CSS animation running now (a gradient swiping across a headline, set off by a class
        // added as it came in): kept as it is — that class, that animation; ours would replace it. Held until it
        // comes into view instead (markHeldAnimations), shown when it ends.
        if (isReveal && s0 && el instanceof HTMLElement && getComputedStyle(el).animationName !== "none" && !/(^|,\s*)(sl-|slm-)/.test(getComputedStyle(el).animationName)) {
          decided.add(el);
          revealShown.set(el, s0.at.opacity);
          continue;
        }
        if (isReveal && s0) {
          if (s0.cls === null) el.removeAttribute("class"); else el.setAttribute("class", s0.cls);
          if (s0.style === null) el.removeAttribute("style"); else el.setAttribute("style", s0.style);
          decided.add(el);
          revealShown.set(el, s0.at.opacity); // it came in: it must end shown (checked once everything is decided)
          dbg(el, `a reveal (best ${s0.best.toFixed(2)} vs before ${s0.preScore.toFixed(2)})`);
          // revealed by its section's class: keep that class in the copy
          const anc = viaAncestor.get(el);
          if (anc && s0.ancCls !== undefined && !decided.has(anc)) {
            if (s0.ancCls === null) anc.removeAttribute("class"); else anc.setAttribute("class", s0.ancCls);
            decided.add(anc);
          }
          const cs = getComputedStyle(el);
          // an element with its own CSS animation keeps it; we only add reveals elsewhere
          if (o.scrollReveals && cs.animationName === "none" && !el.hasAttribute("data-framer-appear-id") && !el.closest(`[${REVEAL_ATTR}]`) && el.getBoundingClientRect().top + scrollY > innerHeight * 0.6 && canReplay(el)) {
            const anchor = revealAnchor(el);
            if (anchor !== false) {
              const id = revealIdFor(s0.pre);
              el.setAttribute(REVEAL_ATTR, id);
              reveals.push({ el, id });
              // its own timing when we know it: replayed over time as it comes into view (an exact GSAP record
              // already on it wins)
              // scrubbed by the scroll over a longer stretch (a hardware shot sliding together as you scroll — eased,
              // so it moves on a moment after each stop): settled part-way at several stops, in separate bursts. Its
              // own measured stretch, not a timed entrance nor the usual "done a third of a screen after it comes in"
              let scrub: [number, number] | null = null;
              {
                const arr = samples.get(el);
                const bursts = (movedStops.get(el) || 0) + ((tweenNow.get(el)?.n || 0) > 0 ? 1 : 0);
                // (or one long glide across several stops — eased so slowly it never stopped between them: an
                // "entrance" of seconds that settled part-way at stops follows the scroll)
                const tb = tweenBest.get(el);
                const longGlide = !!tb && tb.last - tb.first >= 2000 && easedScrub(el);
                if (arr && arr.length >= 4 && (bursts >= 2 || !tb || longGlide)) {
                  const key = (p: { tf: string; op: number }) => `${p.op.toFixed(2)}|${p.tf}`;
                  const k0 = key(arr[0]), kEnd = key(arr[arr.length - 1]);
                  const i0 = arr.findIndex((p) => key(p) !== k0);
                  const i1 = arr.findIndex((p) => key(p) === kEnd);
                  if (i0 > 0 && i1 - i0 >= 2) {
                    const subject = anchor || el;
                    const base = (subject instanceof HTMLElement ? layoutTop(subject) : docTop(subject)) - innerHeight;
                    let a = Math.max(0, Math.round(arr[i0 - 1].y - base)), b = Math.round(arr[i1].y - base);
                    // the stops in between settled part of the way: a line through them finds where it really
                    // starts and ends (stops are a third of a screen apart)
                    const first = arr[0], last = arr[arr.length - 1];
                    const mv = (p: { tf: string }) => { const m = matrixNums(p.tf); return m.length === 16 ? [m[12], m[13]] : m.length === 6 ? [m[4], m[5]] : [0, 0]; };
                    const e = mv(last), d0 = Math.hypot(mv(first)[0] - e[0], mv(first)[1] - e[1]);
                    const prog = (p: { tf: string; op: number }) => Math.abs(last.op - first.op) > 0.05 ? (p.op - first.op) / (last.op - first.op) : d0 > 2 ? 1 - Math.hypot(mv(p)[0] - e[0], mv(p)[1] - e[1]) / d0 : NaN;
                    const mids = arr.map((p) => [p.y - base, prog(p)]).filter(([, q]) => q > 0.03 && q < 0.97);
                    if (mids.length >= 2) {
                      const n = mids.length, sq = mids.reduce((t, [, q]) => t + q, 0) / n, sy = mids.reduce((t, [y]) => t + y, 0) / n;
                      const cov = mids.reduce((t, [y, q]) => t + (q - sq) * (y - sy), 0), vq = mids.reduce((t, [, q]) => t + (q - sq) ** 2, 0);
                      if (vq > 1e-4 && cov > 0) {
                        const beta = cov / vq, alpha = sy - beta * sq;
                        a = Math.max(a, Math.round(alpha));
                        b = Math.min(b, Math.round(alpha + beta));
                      }
                    }
                    if (b > a + 40) scrub = [a, b];
                  }
                }
              }
              if (scrub && !el.hasAttribute("data-sl-gsap") && el instanceof HTMLElement) {
                el.style.setProperty("--sl-rr", `cover ${scrub[0]}px cover ${scrub[1]}px`);
                stats.revealRanges = (stats.revealRanges || 0) + 1;
              } else if (!el.hasAttribute("data-sl-gsap")) {
                const spec = timedSpec(el, s0);
                if (spec) {
                  el.setAttribute("data-sl-gsap", JSON.stringify(spec));
                  timedList.push({ el, spec, stop: tweenBest.get(el)?.stop ?? -1 });
                  stats.timedReveals = (stats.timedReveals || 0) + 1;
                }
              }
              if (anchor) {
                let tl = timelineOf.get(anchor);
                if (!tl) {
                  tl = `t${timelineOf.size + 1}`;
                  timelineOf.set(anchor, tl);
                  anchor.setAttribute(TIMELINE_ATTR, tl);
                }
                el.setAttribute(TL_USE_ATTR, tl);
              }
              seq++;
            } else if (el instanceof HTMLElement && !el.hasAttribute("data-sl-gsap") && inSticky(el)) {
              // in a pinned (sticky) section it is on screen all along — no "comes into view" to replay it on. A
              // timed entrance (words coming in one after another once the scroll reaches a point of the pin) is
              // replayed with its own timing, started at the scroll position where it played
              // (it was set off somewhere between the stop before and this one: half way, as the best guess)
              // (a CSS transition records no frames: the stop where it first changed tells where)
              const tb = tweenBest.get(el);
              const st = tb?.stop ?? firstStop.get(el) ?? -1;
              const yAt = stopYs.get(st), yBefore = stopYs.get(st - 1) ?? startY;
              const at = yAt === undefined ? undefined : Math.round((Math.min(yBefore, yAt) + yAt) / 2);
              const spec = at !== undefined ? timedSpec(el, s0) : null;
              if (spec) {
                el.setAttribute("data-sl-gsap", JSON.stringify(spec));
                el.setAttribute(IN_AT_ATTR, String(at));
                timedList.push({ el, spec, stop: st });
                stats.timedReveals = (stats.timedReveals || 0) + 1;
                stats.pinnedEntrances = (stats.pinnedEntrances || 0) + 1;
                seq++;
              }
            }
          }
          continue;
        }
        // concealer: an overlay that retracted / faded away while it was on screen
        // (curtain reveals over images). Keep it retracted so the content shows.
        // (judged on what happened DURING the scroll: many sites close the curtain
        // again once it leaves the screen, so the end state looks untouched)
        if (s0 && (s0.minCls !== null || s0.minStyle !== null)) {
          const isConcealer =
            !!s0 && !pinned && !timerTouched.has(el) && !slideBlock.has(el) && s0.preCover > 400 && s0.minCover < s0.preCover * 0.35 && s0.minTop > -innerHeight * 0.25 &&
            startCover.has(el) && !inChrome(el);
          if (isConcealer && s0) {
            if (s0.minCls === null) el.removeAttribute("class"); else el.setAttribute("class", s0.minCls);
            if (s0.minStyle === null) el.removeAttribute("style"); else el.setAttribute("style", s0.minStyle);
            decided.add(el);
            // we may have caught it half-open: finish whatever was shrinking
            const shrunk: string[] = [];
            if (el instanceof HTMLElement) {
              const a = parseDecls(style), b = parseDecls(s0.minStyle);
              for (const [k, v] of a) {
                const pv = parseFloat(v), nv = parseFloat(b.get(k) || "");
                if (!/^(width|height|opacity|max-height|max-width)$/.test(k) || isNaN(pv) || isNaN(nv) || nv >= pv) continue;
                el.style.setProperty(k, k === "opacity" ? "0" : `0${(v.match(/[a-z%]+$/i) || ["px"])[0]}`);
                shrunk.push(k);
              }
              // the property may be animated without being in the starting style
              // (e.g. height added by the animation): retract that too
              for (const [k] of b) if (!a.has(k) && /^(height|width)$/.test(k) && parseFloat(b.get(k) || "1") < 50) { el.style.setProperty(k, "0px"); shrunk.push(k); }
            }
            concealed.push({ el, shrunk: shrunk.length ? shrunk : ["height"] });
            // replay the retraction as the overlay scrolls into view
            const from = concealFrom(style, el.getAttribute("style"));
            if (o.scrollReveals && from && canReplay(el) && revealAnchor(el) !== false) {
              const id = revealIdForDecl(from);
              el.setAttribute(REVEAL_ATTR, id);
              reveals.push({ el, id });
            }
            stats.concealers++;
            continue;
          }
        }
        if (!changed) { dbg(el, `unchanged (samples ${samples.get(el)?.length || 0}, seen ${seen.has(el)}, ${inSnapshot.has(el) ? "in the snapshot" : lateBorn.has(el) ? "made during the pass" : "made after"})`); continue; }
        if ((timerTouched.has(el) || slideBlock.has(el)) && !inChrome(el)) { dbg(el, "timer-driven / slideshow: kept as it is now"); continue; } // timer-driven: latest state is the real one
        dbg(el, `put back as it was (samples ${samples.get(el)?.length || 0}, switch ${switchSamples.get(el)?.length || 0}, sticky ${stickySamples.get(el)?.length || 0}, best ${seen.get(el)?.best?.toFixed(2)} vs before ${seen.get(el)?.preScore?.toFixed(2)}; ${inSnapshot.has(el) ? "in the snapshot" : lateBorn.has(el) ? "made during the pass" : "made after"}, start look ${preVisual.has(el) ? "recorded" : "not recorded"} ${seen.get(el)?.pre?.transform}; switch x ${(switchSamples.get(el) || []).map((p) => Math.round(matrixNums(p.tf)[4] ?? 0)).join(",")})`);
        if (cls === null) { if (el.hasAttribute("class")) el.removeAttribute("class"); }
        else if (el.getAttribute("class") !== cls) el.setAttribute("class", cls);
        // custom properties still different back at the top aren't scroll state: a size the page measured
        // once its part came near (--max-width: 0px → 1440px, labels placed in it) — those stay as they are
        const now = el instanceof HTMLElement ? el.style : null;
        const vars: [string, string][] = [];
        for (let i = 0; now && i < now.length; i++) if (now.item(i).startsWith("--")) vars.push([now.item(i), now.getPropertyValue(now.item(i))]);
        let put = style;
        if (vars.length) {
          const tmp = document.createElement("i");
          if (style !== null) tmp.setAttribute("style", style);
          for (const [k, v] of vars) tmp.style.setProperty(k, v);
          put = tmp.getAttribute("style");
        }
        if (put === null || !put.trim()) { if (el.hasAttribute("style")) el.removeAttribute("style"); }
        else if (el.getAttribute("style") !== put) el.setAttribute("style", put);
      } catch { /* detached node */ }
    }
    // A reveal must END shown. One shown by a class on its block (apple.com's staggered-start → staggered-end) whose
    // block was settled by another rule (its own entrance) keeps the block's "before" class — its finished look
    // would still be hidden: its shown opacity is written on it.
    for (const [el, op] of revealShown) {
      if (!(el instanceof HTMLElement) || !el.isConnected || op < 0.5) continue;
      const c = getComputedStyle(el);
      // where it's heading (the site's class just flipped back: an opacity transition still running)
      let rest = parseFloat(c.opacity);
      for (const a of el.getAnimations ? el.getAnimations() : []) {
        if (!(a instanceof CSSTransition) || a.transitionProperty !== "opacity") continue;
        const k = (a.effect as KeyframeEffect | null)?.getKeyframes() || [];
        const end = parseFloat(String(k[k.length - 1]?.opacity ?? ""));
        if (!isNaN(end)) rest = end;
      }
      if (rest < 0.05) {
        el.style.setProperty("opacity", String(Math.round(op * 1000) / 1000));
        stats.revealsPinned = (stats.revealsPinned || 0) + 1;
      }
      if (c.visibility === "hidden") el.style.setProperty("visibility", "visible");
    }
    // Content that came in as we scrolled and STAYED shown (its last look in the pass was visible) but would end
    // hidden in the copy — put back to its top-of-page look, which a block's "before" class hides (apple.com's
    // staggered items whose block reverted to staggered-start): replayed as a reveal, its shown look written on
    // it. Never what went away again in the pass (a spinner), slides, menus or an intro's exits.
    if (o.scrollReveals) {
      let saved = 0;
      for (const [el, arr] of samples) {
        if (saved >= 400 || !(el instanceof HTMLElement) || !el.isConnected || arr.length < 2) continue;
        const last = arr[arr.length - 1], first = arr[0];
        if (last.op < 0.5 || first.op >= 0.5 || el.hasAttribute(REVEAL_ATTR) || el.hasAttribute(SCROLL_ATTR) || el.hasAttribute("data-sl-exited")) continue;
        if (timerTouched.has(el) || slideBlock.has(el) || inChrome(el) || el.closest(`[${REVEAL_ATTR}]`)) continue;
        const c = getComputedStyle(el);
        if (parseFloat(c.opacity) >= 0.05 || c.display === "none" || c.position === "fixed") continue;
        if (el.getAttribute("aria-hidden") === "true" || /^(menu|dialog|tooltip|listbox)$/.test(el.getAttribute("role") || "")) continue;
        const decl = [`opacity: ${Math.round(first.op * 1000) / 1000}`];
        if (/translate|scale|matrix|rotate/.test(first.tf) && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(first.tf)) decl.push(`transform: ${first.tf}`);
        el.style.setProperty("opacity", String(Math.round(last.op * 1000) / 1000));
        // (one with its own CSS animation — a gradient swiping in — keeps it: that one is held until in view instead)
        if (c.animationName === "none" && canReplay(el) && el.getBoundingClientRect().top + scrollY > innerHeight * 0.6) {
          const id = revealIdForDecl(decl.join("; "));
          el.setAttribute(REVEAL_ATTR, id);
          reveals.push({ el, id });
        }
        saved++;
      }
      if (saved) stats.revealsPinned = (stats.revealsPinned || 0) + saved;
    }
    // A measured reveal's delay is its place in the stagger of what came in with it — the block it belongs to (same stop,
    // same nearby ancestor): the first of a block starts at once, as the copy plays each one when it comes into
    // view. Measured from the stop's first change, a busy page (a long stop) would hold it back for seconds.
    {
      const groups = new Map<string, typeof timedList>();
      for (const t of timedList) {
        if (t.spec.m !== "frames") continue; // a CSS transition-delay is the site's own, exact
        let a: Element | null = t.el;
        for (let k = 0; k < 3 && a?.parentElement && a.parentElement !== document.body; k++) a = a.parentElement;
        let key = `${t.stop}`;
        const blockOf = (x: Element | null) => { let id = blockId.get(x as Element); if (!id) { id = blockId.size + 1; blockId.set(x as Element, id); } return id; };
        key += `|${blockOf(a)}`;
        const g = groups.get(key);
        if (g) g.push(t);
        else groups.set(key, [t]);
      }
      for (const g of groups.values()) {
        const min = Math.min(...g.map((t) => Number(t.spec.dl) || 0));
        for (const t of g) {
          const dl = Math.min(1500, Math.max(0, (Number(t.spec.dl) || 0) - min));
          if (dl === t.spec.dl) continue;
          t.spec.dl = dl;
          t.el.setAttribute("data-sl-gsap", JSON.stringify(t.spec));
        }
      }
    }
    // Curtains come in sets (two halves, four quarters) that open a beat apart; when
    // one is confirmed, its same-looking overlay siblings are curtains too.
    const snapStyle = new Map(liveSnapshot.map((x) => [x.el, x.style] as const));
    const done = new Set(concealed.map((c) => c.el));
    for (const c of concealed.slice()) {
      const bg = getComputedStyle(c.el).backgroundColor;
      for (const sib of Array.from(c.el.parentElement?.children || [])) {
        if (done.has(sib) || !(sib instanceof HTMLElement)) continue;
        const cs = getComputedStyle(sib);
        if (cs.position !== "absolute" || cs.backgroundColor !== bg || inChrome(sib)) continue;
        const before = snapStyle.get(sib) ?? sib.getAttribute("style");
        if (before !== null) sib.setAttribute("style", before);
        for (const k of c.shrunk) sib.style.setProperty(k, k === "opacity" ? "0" : "0px");
        const from = concealFrom(before, sib.getAttribute("style")) || c.shrunk.map((k) => `${k}: ${k === "opacity" ? "1" : "100%"}`).join("; ");
        if (o.scrollReveals && canReplay(sib) && revealAnchor(sib) !== false) {
          const id = revealIdForDecl(from);
          sib.setAttribute(REVEAL_ATTR, id);
          reveals.push({ el: sib, id });
        }
        done.add(sib);
        decided.add(sib);
        stats.concealers++;
      }
    }
    // Masks the pass never saw open: an empty, opaque, absolutely positioned block over
    // an image / video in its container, built to animate (will-change, a size or
    // transform transition). A solid block hiding a photo is never the resting design
    // — it is an image-reveal curtain whose trigger didn't fire during our pass (a
    // lagging smooth-scroll library, a "fully in view" threshold, a trigger further down).
    if (o.revealHidden) {
      let masks = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body div, body span, body figure, body i"))) {
        if (masks >= 200) break;
        if (decided.has(el) || el.childElementCount > 0 || (el.textContent || "").trim()) continue;
        try {
          const cs = getComputedStyle(el);
          if (cs.position !== "absolute" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.95 || cs.backgroundImage !== "none") continue;
          const anim = `${cs.willChange} ${cs.transitionDuration !== "0s" ? cs.transitionProperty : ""}`;
          if (!/(height|width|transform|clip-path|scale|inset)/.test(anim) && !/will-change/.test(el.getAttribute("style") || "")) continue;
          const bg = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
          if (!bg) continue;
          const ch = bg[1].split(",").map((x) => parseFloat(x));
          if (ch.length === 4 && ch[3] < 0.95) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) continue;
          let covers = false;
          for (let host = el.parentElement, i = 0; host && i < 3 && !covers; host = host.parentElement, i++) {
            for (const m of Array.from(host.querySelectorAll("img, video, canvas, [style*='background-image']"))) {
              if (m === el || el.contains(m) || !(m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
              const mr = m.getBoundingClientRect();
              if (mr.width < 40 || mr.height < 40) continue;
              const ix = Math.max(0, Math.min(r.right, mr.right) - Math.max(r.left, mr.left));
              const iy = Math.max(0, Math.min(r.bottom, mr.bottom) - Math.max(r.top, mr.top));
              if (ix * iy >= mr.width * mr.height * 0.3) { covers = true; break; }
            }
          }
          if (!covers) continue;
          const prop = /height/.test(anim) ? "height" : /width/.test(anim) ? "width" : "opacity";
          const before = el.getAttribute("style");
          el.style.setProperty(prop, prop === "opacity" ? "0" : "0px");
          decided.add(el);
          concealed.push({ el, shrunk: [prop] });
          const from = concealFrom(before, el.getAttribute("style")) || `${prop}: ${prop === "opacity" ? "1" : "100%"}`;
          if (o.scrollReveals && canReplay(el) && revealAnchor(el) !== false) {
            const id = revealIdForDecl(from);
            el.setAttribute(REVEAL_ATTR, id);
            reveals.push({ el, id });
          }
          stats.concealers++;
          masks++;
        } catch {
          /* detached */
        }
      }
    }
    // Progress variables the page set as we scrolled (--progress on a bar): played back on the scroll timeline (varCss).
    // Only what follows the position — numbers in one unit, at least three values, back at the top where it began,
    // never changing at rest — and only when the site's own CSS never gives that variable a value of another kind
    // (registering its type would void those).
    if (o.scrollLinked && varSamples.size) {
      let sheetText: string | null = null;
      const cssAgrees = (prop: string, re: RegExp) => {
        if (sheetText === null) {
          sheetText = "";
          for (const sh of Array.from(document.styleSheets)) {
            try {
              for (const r of Array.from(sh.cssRules)) sheetText += r.cssText + "\n";
            } catch {
              /* cross-origin: can't read it */
            }
            if (sheetText.length > 6_000_000) break;
          }
        }
        const rx = new RegExp(`${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;}]+)`, "g");
        for (const m of sheetText.matchAll(rx)) if (!re.test(m[1].trim())) return false;
        return true;
      };
      const UNIT = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|%|deg|turn|rad)?$/;
      for (const [el, m] of varSamples) {
        if (varPlays.length >= 60 || !el.isConnected || timerTouched.has(el) || slideBlock.has(el) || stillRoots.has(el) || el.hasAttribute(SCROLL_ATTR) || el.hasAttribute(REVEAL_ATTR)) continue;
        const take: { prop: string; arr: { y: number; v: string }[] }[] = [];
        for (const [prop, arr] of m) {
          if (arr.length < 3) continue;
          const parsed = arr.map((x) => UNIT.exec(x.v));
          if (parsed.some((x) => !x)) continue;
          const unit = parsed[0]![2] || "";
          if (parsed.some((x) => (x![2] || "") !== unit) || new Set(parsed.map((x) => parseFloat(x![1]))).size < 3) continue;
          if (el.style.getPropertyValue(prop).trim() !== arr[0].v) continue; // not where it began, back at the top
          const syntax = unit === "px" ? "<length>" : unit === "%" ? "<percentage>" : unit ? "<angle>" : "<number>";
          const zero = unit === "px" ? "0px" : unit === "%" ? "0%" : unit ? `0${unit}` : "0";
          const ok = unit === "px" ? /^(-?\d*\.?\d+px|0|calc\(.*\))$/ : unit === "%" ? /^(-?\d*\.?\d+%|calc\(.*\))$/ : unit ? /^(-?\d*\.?\d+(deg|turn|rad)|calc\(.*\))$/ : /^(-?\d*\.?\d+(e-?\d+)?|calc\(.*\))$/;
          const known = varTypes.get(prop);
          if ((known && known.syntax !== syntax) || !cssAgrees(prop, ok)) continue;
          varTypes.set(prop, { syntax, zero });
          take.push({ prop, arr });
        }
        if (!take.length) continue;
        // one animation for the element: every variable of it at each stop (they were sampled at the same stops)
        const ys = Array.from(new Set(take.flatMap((t) => t.arr.map((x) => x.y)))).sort((p, q) => p - q);
        const a = ys[0], b = ys[ys.length - 1];
        if (b - a < 50) continue;
        const valueAt = (arr: { y: number; v: string }[], y: number) => { let v = arr[0].v; for (const x of arr) { if (x.y <= y) v = x.v; else break; } return v; };
        const keys: { at: number; decl: string }[] = [];
        let prev = "";
        ys.forEach((y, i) => {
          const decl = take.map((t) => `${t.prop}: ${valueAt(t.arr, y)};`).join(" ");
          const next = i + 1 < ys.length ? take.map((t) => `${t.prop}: ${valueAt(t.arr, ys[i + 1])};`).join(" ") : "";
          if (decl === prev && decl === next) return; // the middle of a run of equal stops adds nothing
          keys.push({ at: (y - a) / (b - a), decl });
          prev = decl;
        });
        const id = `v${varPlays.length + 1}`;
        el.setAttribute(VAR_ATTR, id);
        el.removeAttribute("data-sl-gsap"); // its own variable drives it now, not an entrance of ours
        varPlays.push({ el, id, keys, a, b });
        decided.add(el);
      }
      if (varPlays.length) stats.scrollVars = varPlays.length;
    }
    // count-ups drawn from a custom property that dropped back: show the target they reached
    for (const [el, peaks] of varPeak) {
      if (!el.isConnected) continue;
      for (const [prop, peak] of peaks) {
        const now = parseFloat(el.style.getPropertyValue(prop));
        if (isNaN(now) || now >= peak || peak === 0) continue;
        let hasTarget = false;
        for (let i = 0; i < el.style.length; i++) {
          const other = el.style.item(i);
          if (other !== prop && other.startsWith("--") && parseFloat(el.style.getPropertyValue(other)) === peak) hasTarget = true;
        }
        if (!hasTarget) continue;
        el.style.setProperty(prop, String(peak));
        decided.add(el);
        stats.countersSet = (stats.countersSet || 0) + 1;
      }
    }
    for (const el of decided) decidedState.set(el, { cls: el.getAttribute("class"), style: el.getAttribute("style") });
  }
  // Resolve once no inline-style / attribute mutations happened for 400 ms (or at maxMs).
  // Resolve once nothing has changed for 400 ms — ignoring perpetual animations
  // (marquees, tickers, loops) that have been changing non-stop for ~2 s, which
  // would otherwise keep the page from ever looking quiet. Bounded by maxMs.
  // Is something on screen still animating (finite Web Animation / CSS transition)?
  // In-view effects often run as script animations with no DOM change to observe.
  function animatingOnScreen(): boolean {
    try {
      return document.getAnimations().some((a) => {
        if (a.playState !== "running" && !a.pending) return false;
        const eff = a.effect as KeyframeEffect | null;
        const t = eff?.getComputedTiming();
        const end = Number(t?.endTime), at = Number(t?.localTime ?? 0);
        if (!t || !isFinite(end) || !isFinite(at) || end - at <= 0 || end - at > 2500) return false;
        const el = eff?.target;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0;
      });
    } catch {
      return false;
    }
  }
  function waitQuiet(maxMs: number, quietMs = 400): Promise<void> {
    return new Promise((resolve) => {
      const streak = new Map<Node, { start: number; last: number }>();
      let lastRelevant = performance.now();
      const PERPETUAL = 1800, GAP = 160;
      const mo = new MutationObserver((records) => {
        const now = performance.now();
        for (const r of records) {
          const t = r.target;
          const s0 = streak.get(t);
          if (!s0 || now - s0.last > GAP) streak.set(t, { start: now, last: now });
          else s0.last = now;
          const cur = streak.get(t)!;
          if (now - cur.start < PERPETUAL) lastRelevant = now; // not (yet) a perpetual animation
        }
      });
      mo.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ["style", "class"] });
      const t0 = performance.now();
      // Web Animations move things without touching the DOM (a carousel swaps in new
      // digit columns, then rolls them after a staggered delay): a finite animation
      // that is still running or waiting out its delay is activity too. Long and
      // infinite ones (loops, marquees) are not waited for.
      const animating = () => {
        try {
          return document.getAnimations().some((a) => {
            if (a.playState !== "running" && !a.pending) return false;
            const t = a.effect?.getComputedTiming();
            const end = Number(t?.endTime), at = Number(t?.localTime ?? 0);
            if (!t || !isFinite(end) || !isFinite(at)) return false;
            const left = (end - at) / Math.abs(a.playbackRate || 1);
            return left > 0 && left < 4000;
          });
        } catch {
          return false;
        }
      };
      const tick = () => {
        const now = performance.now();
        if (animating()) lastRelevant = now;
        if (now - lastRelevant >= quietMs || now - t0 >= maxMs) {
          mo.disconnect();
          resolve();
        } else setTimeout(tick, 50);
      };
      setTimeout(tick, 60);
    });
  }
  function findScroller(): HTMLElement | null {
    const minH = innerHeight * 0.5, minW = innerWidth * 0.5;
    let layer: Element[] = [document.documentElement];
    for (let depth = 0; depth < 6 && layer.length; depth++) {
      const next: Element[] = [];
      for (const el of layer) {
        for (const c of Array.from(el.children)) {
          const h = c as HTMLElement;
          if (h.clientHeight >= minH && h.clientWidth >= minW) {
            const st = getComputedStyle(h);
            if (/(auto|scroll|overlay)/.test(st.overflowY) && h.scrollHeight > h.clientHeight + 10) return h;
            next.push(h);
          }
        }
      }
      layer = next;
    }
    return null;
  }

  // ── 2. mark live elements that need special serialization ──────────────────
  const live: Element[] = [];
  const BANNER_SELECTOR = [
    "#cc-main", ".cc-window", ".cc_banner", "#cookie-law-info-bar", "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay",
    "#onetrust-consent-sdk", "#usercentrics-root", "#usercentrics-cmp-ui", "#truste-consent-track", ".truste_overlay", ".truste_box_overlay",
    "#didomi-host", ".qc-cmp2-container", "#sp_message_container_", "[id^='sp_message_container']", "#cmpbox", "#cmpbox2", ".cmp-wrapper", ".cc-banner",
    ".cookie-consent", ".cookieconsent", ".cookie-notice", "#cookie-notice", ".cookie-banner", "#cookie-banner", ".cookie-bar", "#cookie-bar",
    ".cookies-banner", ".cookie-popup", ".cookie-modal", ".gdpr-banner", "#gdpr-banner", ".gdpr-consent", "[class*='cookie-consent' i]",
    "[id*='cookie-consent' i]", "[class*='cookiebanner' i]", "[id*='cookiebanner' i]", "[aria-label*='cookie' i][role='dialog']",
    "[aria-label*='consent' i][role='dialog']", "[data-nosnippet][id*='cookie' i]",
  ].join(",");
  const isBanner = (el: Element): boolean => {
    if (!o.stripCookieBanners || !(el instanceof HTMLElement)) return false;
    let hit = false;
    try {
      hit = el.matches(BANNER_SELECTOR);
    } catch {
      hit = false;
    }
    if (!hit) return false;
    const cs = getComputedStyle(el);
    // only overlays: fixed/sticky, or a direct body/html child that covers the viewport bottom/top
    if (cs.position === "fixed" || cs.position === "sticky") return true;
    if (el.parentElement === document.body || el.parentElement === document.documentElement) {
      const inner = el.querySelector("*");
      const ics = inner ? getComputedStyle(inner) : null;
      return !!ics && (ics.position === "fixed" || ics.position === "sticky");
    }
    return false;
  };
  // Content a STYLESHEET holds invisible while it waits for a class to animate it in
  // (".fl-anim section { opacity: 0 }" until ".fl-in"): a large in-flow block of real
  // text, primed to animate opacity. If the class never came during our pass, the copy
  // would be blank there.
  const STAGED_TAGS = /^(SECTION|ARTICLE|DIV|MAIN|HEADER|FOOTER|ASIDE|UL|OL|LI|FIGURE|P|H[1-6])$/;
  const stagedHidden = (el: HTMLElement): boolean => {
    if (!STAGED_TAGS.test(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) >= 0.05 || cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") return false;
    const primed = (/opacity|all/.test(cs.transitionProperty) && cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0)) || /opacity/.test(cs.willChange);
    if (!primed) return false;
    if (el.getAttribute("aria-hidden") === "true" || /^(menu|dialog|tooltip|listbox|tabpanel)$/.test(el.getAttribute("role") || "")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 200 && r.height >= 80 && (el.textContent || "").replace(/\s+/g, " ").trim().length >= 20;
  };
  const shouldReveal = (el: Element): boolean => {
    if (!o.revealHidden || !(el instanceof HTMLElement)) return false;
    // seen showing and then hidden again (an intro's exit): its hidden look is where it rests
    if (el.hasAttribute("data-sl-exited")) return false;
    const st = el.style;
    const opv = parseFloat(st.opacity);
    const op = (!isNaN(opv) && opv < 0.05) || st.visibility === "hidden";
    if (!op) return stagedHidden(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 2) return false;
    // never reveal overlays / menus / dialogs that are hidden on purpose
    if (el.getAttribute("aria-hidden") === "true" || /^(menu|dialog|tooltip|listbox)$/.test(el.getAttribute("role") || "")) return false;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.display === "none") return false;
    // …nor what the site's bar or menu hides (a closed menu's items, an intro's tagline that left the header): in a
    // fixed / sticky bar, a navigation, or a "menu" block at the very top of the page
    if (el.closest("nav, [role='navigation'], [role='menu']")) return false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      // (a sticky BAR — not a tall pinned scroll story, whose content does wait to be revealed)
      if (p === "fixed" || (p === "sticky" && a.getBoundingClientRect().height < innerHeight * 0.5)) return false;
    }
    if (r.top + scrollY < 120 && el.closest("[class*='menu' i], [class*='header' i]")) return false;
    // pointer-events: none marks an overlay that is hidden on purpose (a closed panel)
    // only when it is itself positioned over the page — text inherits it from
    // decorative wrappers (Framer text effects) and must still be revealed
    if (cs.pointerEvents === "none" && cs.position === "absolute") return false;
    const hint = /translate|scale|matrix/.test(st.transform) || !!st.willChange || el.hasAttribute("data-framer-appear-id") || el.classList.contains("aos-init") ||
      /inset\(|circle\(|polygon\(|ellipse\(/.test(st.clipPath) || /blur\(/.test(st.filter); // GSAP / Motion start states
    if (hint) return true;
    // a hidden glyph inside an otherwise visible word: text-scramble / letter-by-letter
    // effects were mid-way when captured; the finished text is what the page shows
    const glyph = (el.textContent || "").trim().length <= 2 && /^inline/.test(cs.display);
    const parent = el.parentElement;
    if (glyph && parent && parent.children.length >= 3) {
      const shown = Array.from(parent.children).filter((c) => c !== el && parseFloat(getComputedStyle(c).opacity) > 0.5).length;
      return shown >= 2;
    }
    return false;
  };
  function mark(root: Document | ShadowRoot | Element): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode() as Element | null;
    while (n) {
      const el = n;
      const tag = el.tagName.toUpperCase();
      const interesting =
        el.shadowRoot || isBanner(el) || waapiProps.has(el) || EMPTY_DECL.test(el.getAttribute("style") || "") ||
        tag === "CANVAS" || tag === "IMG" || tag === "PICTURE" || tag === "INPUT" || tag === "TEXTAREA" ||
        tag === "SELECT" || tag === "VIDEO" || tag === "AUDIO" || tag === "IFRAME" ||
        tag === "STYLE" || (tag === "LINK" && /\bstylesheet\b/i.test(el.getAttribute("rel") || "")) ||
        shouldReveal(el);
      if (interesting) {
        el.setAttribute(MARK, String(live.length));
        live.push(el);
      }
      if (el.shadowRoot) mark(el.shadowRoot);
      n = walker.nextNode() as Element | null;
    }
  }
  function unmark(): void {
    for (const el of live) el.removeAttribute(MARK);
  }

  // ── 3. stylesheet serialization from the live CSSOM ────────────────────────
  // ── Shorthand-with-var() repair ───────────────────────────────────────────
  // `font: var(--x)` makes every font longhand "pending-substitution", and Chrome
  // serializes those as EMPTY values ("font-style: ; font-weight: ; …"), which are
  // invalid, so the declaration silently disappears from any copy built from
  // cssText. We detect empty longhands and re-emit the authored shorthand, whose
  // getPropertyValue() still returns the original var() expression.
  const SHORTHANDS = [
    "font", "background", "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-block", "border-inline", "border-block-start", "border-block-end", "border-inline-start", "border-inline-end",
    "border-width", "border-style", "border-color", "border-radius", "border-image",
    "margin", "margin-block", "margin-inline", "padding", "padding-block", "padding-inline", "inset", "inset-block", "inset-inline",
    "outline", "transition", "animation", "flex", "flex-flow", "grid", "grid-template", "grid-area", "grid-row", "grid-column",
    "gap", "place-items", "place-content", "place-self", "overflow", "text-decoration", "list-style", "columns", "column-rule",
    "mask", "mask-border", "font-variant", "text-emphasis", "scroll-margin", "scroll-padding", "offset", "container",
    "white-space", "contain-intrinsic-size", "background-position", "mask-position", "overscroll-behavior", "text-wrap",
    "border-spacing", "font-synthesis", "position-try", "view-timeline", "scroll-timeline", "animation-range",
  ];
  const SHORTHAND_EXTRA: Record<string, string[]> = {
    font: ["line-height"],
    inset: ["top", "right", "bottom", "left"],
    gap: ["row-gap", "column-gap"],
    "place-items": ["align-items", "justify-items"],
    "place-content": ["align-content", "justify-content"],
    "place-self": ["align-self", "justify-self"],
    columns: ["column-width", "column-count"],
    "white-space": ["white-space-collapse", "text-wrap-mode"],
    "text-wrap": ["text-wrap-mode", "text-wrap-style"],
  };
  const covers = (sh: string, prop: string): boolean =>
    prop.startsWith(sh + "-") ||
    (SHORTHAND_EXTRA[sh] || []).includes(prop) ||
    (sh === "border-radius" && /^border-.+-radius$/.test(prop)) ||
    (sh === "grid-area" && /^grid-(row|column)-(start|end)$/.test(prop));
  // When a var() shorthand is followed by an override of one of its longhands in
  // the same block (`font: var(--f); font-size: 12px`), Chrome can't rebuild the
  // shorthand at all. The authored text of a <style> element still has it, so we
  // recover the declaration from the source block of the same selector.
  const SHORTHAND_DECL_RE = new RegExp("(?:^|[;{\\s])(" + SHORTHANDS.map((x) => x.replace(/-/g, "\\-")).join("|") + ")\\s*:\\s*([^;}]*var\\([^;}]*)", "g");
  function authoredShorthands(src: string | undefined, selector: string | undefined, need: string[]): string[] {
    if (!src || !selector) return [];
    const out: string[] = [];
    const sel = selector.trim();
    let from = 0;
    while (out.length === 0) {
      const at = src.indexOf(sel, from);
      if (at === -1) break;
      from = at + sel.length;
      // must be a whole selector: next non-space char is "{"
      let k = from;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] !== "{") continue;
      const prev = src[at - 1];
      if (prev && !/[\s}{;,>]/.test(prev)) continue;
      const end = src.indexOf("}", k);
      if (end === -1) break;
      const block = src.slice(k, end);
      SHORTHAND_DECL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SHORTHAND_DECL_RE.exec(block))) {
        const prop = m[1];
        if (need.some((p) => covers(prop, p))) out.push(`${prop}: ${m[2].trim()};`);
      }
    }
    return out;
  }
  function declText(style: CSSStyleDeclaration, src?: string, selector?: string): string {
    const empty: string[] = [];
    const parts: string[] = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i);
      const val = style.getPropertyValue(prop);
      // an empty custom property is a real declaration (Tailwind's
      // `--tw-gradient-from-position: ;` — without it every gradient is invalid)
      if (val === "" && !prop.startsWith("--")) empty.push(prop);
      else parts.push(`${prop}: ${val}${style.getPropertyPriority(prop) ? " !important" : ""};`);
    }
    if (!empty.length) return style.cssText;
    let left = empty;
    const recovered: string[] = [];
    for (const sh of SHORTHANDS) {
      if (!left.length) break;
      if (!left.some((p) => covers(sh, p))) continue;
      const v = style.getPropertyValue(sh);
      if (!v || !v.includes("var(")) continue;
      recovered.push(`${sh}: ${v}${style.getPropertyPriority(sh) ? " !important" : ""};`);
      left = left.filter((p) => !covers(sh, p));
    }
    if (left.length) {
      for (const d of authoredShorthands(src, selector, left)) {
        recovered.push(d);
        const prop = d.slice(0, d.indexOf(":"));
        left = left.filter((p) => !covers(prop, p));
      }
    }
    stats.varShorthands += recovered.length;
    return [...recovered, ...parts].join(" ");
  }
  const EMPTY_DECL = /[\w-]:\s*;/;
  function ruleText(rule: CSSRule, src?: string): string {
    const text = rule.cssText;
    if (!EMPTY_DECL.test(text)) return text; // fast path: nothing to repair
    const anyRule = rule as CSSRule & { style?: CSSStyleDeclaration; cssRules?: CSSRuleList; selectorText?: string };
    try {
      const kids = anyRule.cssRules ? Array.from(anyRule.cssRules).map((r) => ruleText(r, src)).join(" ") : "";
      if (anyRule.style) {
        const head = text.slice(0, text.indexOf("{")).trim();
        return `${head} { ${declText(anyRule.style, src, anyRule.selectorText)}${kids ? " " + kids : ""} }`;
      }
      if (anyRule.cssRules) {
        const head = text.slice(0, text.indexOf("{")).trim();
        return `${head} { ${kids} }`;
      }
    } catch {
      /* fall back to the browser's serialization */
    }
    return text;
  }

  function rulesText(sheet: CSSStyleSheet, base: string, depth = 0): string {
    let out = "";
    const owner = sheet.ownerNode as Element | null;
    const src = owner && owner.tagName === "STYLE" ? owner.textContent || undefined : undefined;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      throw new Error("cross-origin");
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule) {
        if (depth < 6 && rule.styleSheet) {
          try {
            const inner = rulesText(rule.styleSheet, rule.styleSheet.href || base, depth + 1);
            const mq = rule.media && rule.media.mediaText;
            out += mq ? `@media ${mq}{\n${inner}}\n` : inner;
            continue;
          } catch {
            out += `@import url("${abs(rule.href, base)}")${rule.media?.mediaText ? " " + rule.media.mediaText : ""};\n`;
            continue;
          }
        }
        out += `@import url("${abs(rule.href, base)}");\n`;
        continue;
      }
      out += ruleText(rule, src) + "\n";
    }
    return absolutizeCssUrls(out, base);
  }
  const sheetErrors: string[] = [];
  let canvasErrors = 0;
  function sheetToStyle(sheet: CSSStyleSheet, base: string): HTMLStyleElement | null {
    try {
      const text = rulesText(sheet, base);
      const st = document.createElement("style");
      if (sheet.media && sheet.media.mediaText) st.setAttribute("media", sheet.media.mediaText);
      st.textContent = text;
      stats.sheets++;
      return st;
    } catch (e) {
      if (sheetErrors.length < 5) sheetErrors.push(`${sheet.href || "inline"}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ── 4. fix-ups on the clone ─────────────────────────────────────────────────
  function bestImageSrc(img: HTMLImageElement): string {
    const srcset = img.getAttribute("srcset") || (img.parentElement?.tagName === "PICTURE" ? "" : "");
    if (o.bestImages && srcset) {
      let best = "", bestW = -1;
      for (const part of srcset.split(",")) {
        const [u, d] = part.trim().split(/\s+/);
        if (!u) continue;
        const w = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 0;
        if (w > bestW) {
          bestW = w;
          best = u;
        }
      }
      if (best) return abs(best);
    }
    const raw = img.currentSrc || (img.getAttribute("src") || "").trim();
    if (raw && !/^about:blank/.test(raw)) return img.currentSrc || abs(raw);
    // never loaded (a lazy image that wasn't reached, a placeholder): the address the site's lazy loader
    // would have used — and never an empty address, which the browser would load as the page itself
    // (webflow.com: 8 "images" fetching https://webflow.com/)
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || (img.getAttribute("data-srcset") || "").split(",")[0].trim().split(/\s+/)[0] || "";
    return lazy ? abs(lazy) : "";
  }
  function fixTree(root: Element | DocumentFragment): void {
    if (spriteDefs.size) inlineSprites(root, document.baseURI);
    const marked = Array.from(root.querySelectorAll(`[${MARK}]`));
    for (const node of marked) {
      const idx = Number(node.getAttribute(MARK));
      node.removeAttribute(MARK);
      const src = live[idx];
      if (!src) continue;
      try {
        fixNode(node, src);
      } catch (e) {
        if (warnings.length < 20) warnings.push(`<${node.tagName.toLowerCase()}> could not be processed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  function fixNode(node: Element, src: Element): void {
    {
      const tag = node.tagName.toUpperCase();
      if (src instanceof HTMLElement && EMPTY_DECL.test(src.getAttribute("style") || "")) {
        node.setAttribute("style", declText(src.style));
      }
      const animated = decidedState.has(src) ? undefined : waapiProps.get(src);
      if (animated && (node instanceof HTMLElement || node instanceof SVGElement)) {
        const cs = getComputedStyle(src);
        const end = waapiEnd.get(src);
        for (const p of animated) {
          const v = end?.get(p) ?? cs.getPropertyValue(p);
          if (v) node.style.setProperty(p, v);
        }
        stats.animatedBaked++;
      }

      if (isBanner(src)) {
        node.remove();
        stats.bannersRemoved++;
        return;
      }
      if (src.shadowRoot) {
        const sr = src.shadowRoot;
        const tpl = document.createElement("template");
        tpl.setAttribute("shadowrootmode", sr.mode);
        if (sr.delegatesFocus) tpl.setAttribute("shadowrootdelegatesfocus", "");
        const frag = tpl.content;
        try {
          for (const s of Array.from(sr.adoptedStyleSheets || [])) {
            const st = sheetToStyle(s, location.href);
            if (st) {
              frag.appendChild(st);
              stats.adoptedSheets++;
            }
          }
        } catch { /* ignore */ }
        for (const c of Array.from(sr.childNodes)) frag.appendChild(c.cloneNode(true));
        fixTree(frag);
        node.insertBefore(tpl, node.firstChild);
        stats.shadowRoots++;
      }

      if (shouldReveal(src) && node instanceof HTMLElement) {
        // held invisible by a stylesheet (not inline): its look comes from computed style
        const scs = getComputedStyle(src);
        const staged = !(parseFloat((src as HTMLElement).style.opacity) < 0.05) && (src as HTMLElement).style.visibility !== "hidden";
        const hiddenOp = staged ? parseFloat(scs.opacity) : parseFloat(node.style.opacity);
        const hiddenTf = staged ? (/^matrix\(1, 0, 0, 1, /.test(scs.transform) ? scs.transform : "") : node.style.transform;
        const hiddenClip = /inset\(|circle\(|polygon\(|ellipse\(/.test(node.style.clipPath) ? node.style.clipPath : "";
        const hiddenBlur = /blur\(/.test(node.style.filter) ? node.style.filter : "";
        node.style.opacity = "";
        node.style.visibility = "";
        if (/translate|scale|matrix/.test(node.style.transform)) node.style.transform = "";
        if (hiddenClip) node.style.clipPath = "";
        if (hiddenBlur) node.style.filter = "";
        if (staged) {
          node.style.setProperty("opacity", "1");
          if (hiddenTf) node.style.setProperty("transform", "none");
        }
        if (!node.getAttribute("style")?.trim()) node.removeAttribute("style");
        stats.revealed++;
        // below the first screen it was waiting to animate in: replay that as a
        // scroll-in from the site's own hidden state (shown as is above the fold)
        if (o.scrollReveals && !node.hasAttribute(REVEAL_ATTR) && !src.parentElement?.closest(`[${REVEAL_ATTR}]`)) {
          const r = src.getBoundingClientRect();
          if (r.top + scrollY > innerHeight * 0.6 && canReplay(src)) {
            const decl = [`opacity: ${isNaN(hiddenOp) ? 0 : Math.round(hiddenOp * 1000) / 1000}`];
            if (/translate|scale|matrix|rotate/.test(hiddenTf)) decl.push(`transform: ${hiddenTf}`);
            if (hiddenClip) decl.push(`clip-path: ${hiddenClip}`);
            if (hiddenBlur) decl.push(`filter: ${hiddenBlur}`);
            node.setAttribute(REVEAL_ATTR, revealIdForDecl(decl.join("; ")));
            cloneReveals++;
          }
        }
      }

      if (tag === "CANVAS") {
        try {
          const c = src as HTMLCanvasElement;
          if (c.width && c.height) {
            const shot = canvasShots.get(src);
            const data = shot || c.toDataURL("image/png");
            const img = document.createElement("img");
            for (const a of Array.from(node.attributes)) img.setAttribute(a.name, a.value);
            img.setAttribute("src", data);
            img.setAttribute("data-sl-canvas", "");
            // a canvas sized to the window it was captured in (renderer.setSize(innerWidth, innerHeight) writes
            // those pixels inline) fills whatever window the copy is seen in — not the capture's height
            {
              const iw = parseFloat(c.style.width), ih = parseFloat(c.style.height);
              if (/px$/.test(c.style.width) && /px$/.test(c.style.height) && Math.abs(iw - innerWidth) <= 2 && Math.abs(ih - innerHeight) <= 2) {
                img.style.setProperty("width", "100vw");
                img.style.setProperty("height", "100vh");
                stats.screenCanvases = (stats.screenCanvases || 0) + 1;
              }
            }
            const scrub = buildScrub(c, img);
            let fixedAt = ""; // a full-screen scene layer the copy un-pins below: where it sat on the screen
            // A full-screen, click-through layer ABOVE the content that only holds a
            // canvas is a 3D scene following the scroll (a model "rolling along"). Its
            // snapshot belongs to the first screen: pinned, it would float over every
            // section of the copy. Fixed backgrounds (behind the content) stay fixed.
            for (let la: Element | null = scrub ? null : src.parentElement, ca: Element | null = node.parentElement, i = 0; i < 4 && la && ca && la !== document.body; la = la.parentElement, ca = ca.parentElement, i++) {
              const acs = getComputedStyle(la);
              if (acs.position !== "fixed") continue;
              const ar = la.getBoundingClientRect();
              if (acs.pointerEvents === "none" && (parseInt(acs.zIndex, 10) || 0) > 0 && ar.width >= innerWidth * 0.8 && ar.height >= innerHeight * 0.8 && !(la.textContent || "").trim() && ca instanceof HTMLElement) {
                let base: Element | null = la.parentElement;
                while (base && base !== document.documentElement && getComputedStyle(base).position === "static") base = base.parentElement;
                const br = base && base !== document.documentElement ? base.getBoundingClientRect() : { top: -scrollY, left: -scrollX };
                ca.style.setProperty("position", "absolute", "important");
                ca.style.setProperty("top", `${Math.round(ar.top - br.top)}px`, "important");
                ca.style.setProperty("left", `${Math.round(ar.left - br.left)}px`, "important");
                ca.style.setProperty("width", `${Math.round(ar.width)}px`, "important");
                ca.style.setProperty("height", `${Math.round(ar.height)}px`, "important");
                ca.style.setProperty("right", "auto", "important");
                ca.style.setProperty("bottom", "auto", "important");
                fixedAt = `${Math.round(ar.left)},${Math.round(ar.top)},${Math.round(ar.width)},${Math.round(ar.height)}`;
                stats.overlaysUnpinned = (stats.overlaysUnpinned || 0) + 1;
              }
              break;
            }
            // A WebGL scene drawn once (icons, paused 3D) can't be read back: its buffer
            // is cleared after it's shown. The panel screenshots what is on screen
            // instead — tag the live canvas and its copy so it can find and patch it.
            if (!shot && !scrub && needsShot.length < 12) {
              const r = c.getBoundingClientRect();
              const cs = getComputedStyle(c);
              if (r.width >= 12 && r.height >= 12 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05) {
                const blank = document.createElement("canvas");
                blank.width = c.width;
                blank.height = c.height;
                if (data === blank.toDataURL("image/png")) {
                  const id = `c${needsShot.length + 1}`;
                  img.setAttribute(SHOOT_ATTR, id);
                  c.setAttribute(SHOOT_ATTR, id);
                  needsShot.push(id);
                }
              }
            }
            // A 3D scene (the page drew it with WebGL / WebGPU or in a worker): marked so an export can keep it
            // live — the site's own code drawing it, in a frame — with this picture standing in until then (and
            // wherever scripts don't run: Studio's artboards, a file opened from disk)
            const glKind = src.getAttribute("data-sl-gl");
            img.removeAttribute("data-sl-gl");
            scrub?.removeAttribute("data-sl-gl");
            if (glKind && islandPick?.has(src)) {
              {
                const ph = scrub || img;
                if (!canvasOrder) canvasOrder = Array.from(document.querySelectorAll("canvas"));
                ph.setAttribute("data-sl-island", String(canvasOrder.indexOf(c)));
                ph.setAttribute("data-sl-island-sel", cssPathOf(c));
                ph.setAttribute("data-sl-island-kind", glKind);
                if (fixedAt) ph.setAttribute("data-sl-island-fixed", fixedAt);
                islandN++;
                stats.islands = islandN;
              }
            }
            node.replaceWith(scrub || img);
            stats.canvases++;
          }
        } catch {
          canvasErrors++;
        }
      } else if (tag === "IMG") {
        const img = src as HTMLImageElement;
        const best = bestImageSrc(img);
        // tracking pixels (ad / analytics beacons): not content — a copy that kept them would report
        // fake visits, and they show as broken images wherever the beacon refuses (notion.com: Bing's)
        if (/^https?:\/\/([^/]+\.)?(bat\.bing\.com|facebook\.com\/tr|google-analytics\.com|googleadservices\.com|doubleclick\.net|analytics\.twitter\.com|t\.co\/i\/adsct|px\.ads\.linkedin\.com|ct\.pinterest\.com|q\.quora\.com|px\.srvcs\.tumblr\.com|sp\.analytics\.yahoo\.com|insight\.adsrvr\.org|ads\.reddit\.com|alb\.reddit\.com|tr\.snapchat\.com|analytics\.tiktok\.com|pixel\.wp\.com|stats\.wp\.com)/i.test(best) || (img.naturalWidth <= 1 && img.naturalHeight <= 1 && /[?&](id|tid|ti|pid|ev|event|cid|uid|sid)=/i.test(best))) {
          node.remove();
          return;
        }
        if (best.startsWith("blob:")) {
          const d = blobSrcMap.get(best);
          if (d) node.setAttribute("src", d);
        } else if (best) node.setAttribute("src", best);
        else {
          node.removeAttribute("src"); // nothing to show: no request at all (not the page's own address)
          node.removeAttribute("srcset");
        }
        // keep the chosen file as a one-candidate srcset with its descriptor (and the
        // sizes): the image keeps the intrinsic size the live page laid out with, even
        // when the file is a sharper one (fit-content boxes would grow otherwise)
        let desc = "";
        let named = false; // the density came from the page's own srcset (the browser chose by it)
        if (best && !best.startsWith("blob:")) {
          for (const part of (img.getAttribute("srcset") || "").split(/,\s+/)) {
            const [u, d] = part.trim().split(/\s+/);
            if (u && d && /^\d+(\.\d+)?[wx]$/.test(d) && abs(u) === best) { desc = d; named = true; break; }
          }
          // a <picture> names its files on its <source>s (the copy drops them): the chosen file's density there.
          // Without it, the sharper file a high-density screen picked (…_2x.png) would show at twice the size.
          const pic = img.parentElement?.tagName === "PICTURE" ? img.parentElement : null;
          if (!desc && pic) {
            for (const so of Array.from(pic.querySelectorAll("source"))) {
              for (const part of (so.getAttribute("srcset") || "").split(/,\s+/)) {
                const [u, d] = part.trim().split(/\s+/);
                if (u && d && /^\d+(\.\d+)?[wx]$/.test(d) && abs(u) === best) {
                  desc = d;
                  named = true;
                  const sz = so.getAttribute("sizes");
                  if (/w$/.test(d) && sz) node.setAttribute("sizes", sz);
                  break;
                }
              }
              if (desc) break;
            }
          }
          // still none: the file's own pixels against the size it was shown at (2 / 3 = a 2x / 3x file)
          if (!desc && best === img.currentSrc && img.naturalWidth > 0) {
            const rw = img.getBoundingClientRect().width;
            const ratio = rw > 0 ? img.naturalWidth / rw : 0;
            if (ratio > 1.4 && ratio < 3.2 && Math.abs(ratio - Math.round(ratio)) < 0.06) desc = `${Math.round(ratio)}x`;
          }
        }
        // a sharper file (2x / 3x) is written by its real width and the size it was shown at: with only a
        // density, a normal screen takes the plain src as the "1x" version — the same file, twice the size
        const dens = /^(\d+(?:\.\d+)?)x$/.exec(desc);
        if (dens && parseFloat(dens[1]) > 1 && best === img.currentSrc && img.naturalWidth > 0) {
          // (chosen by its density, the image reports its size already divided by it)
          const x = parseFloat(dens[1]);
          const px = named ? Math.round(img.naturalWidth * x) : img.naturalWidth;
          node.setAttribute("srcset", `${best} ${px}w`);
          node.setAttribute("sizes", `${Math.round(px / x)}px`);
        } else if (desc) node.setAttribute("srcset", `${best} ${desc}`);
        else {
          node.removeAttribute("srcset");
          node.removeAttribute("sizes");
        }
        if (node.getAttribute("loading") === "lazy") node.setAttribute("loading", "eager");
      } else if (tag === "PICTURE") {
        node.querySelectorAll("source").forEach((s) => s.remove());
      } else if (tag === "INPUT") {
        const i = src as HTMLInputElement;
        if (i.type === "checkbox" || i.type === "radio") {
          if (i.checked) node.setAttribute("checked", "");
          else node.removeAttribute("checked");
        } else if (i.type !== "password" && i.type !== "file") {
          node.setAttribute("value", i.value);
        }
        stats.inputs++;
      } else if (tag === "TEXTAREA") {
        node.textContent = (src as HTMLTextAreaElement).value;
        stats.inputs++;
      } else if (tag === "SELECT") {
        const opts = Array.from((src as HTMLSelectElement).options);
        Array.from(node.querySelectorAll("option")).forEach((op, i) => {
          if (opts[i]?.selected) op.setAttribute("selected", "");
          else op.removeAttribute("selected");
        });
        stats.inputs++;
      } else if (tag === "VIDEO" || tag === "AUDIO") {
        const m = src as HTMLMediaElement;
        if (m.currentSrc && !m.currentSrc.startsWith("blob:")) node.setAttribute("src", m.currentSrc);
        // Background videos are usually started by the site's script (muted, no
        // controls, played when in view); the copy has no script, so say it in markup.
        if (tag === "VIDEO" && !m.controls && (m.muted || m.hasAttribute("muted") || !m.paused)) {
          const r = src.getBoundingClientRect();
          const shown = r.width > 1 && r.height > 1 && getComputedStyle(src).visibility !== "hidden";
          if (m.loop || (m.hasAttribute("autoplay") && m.duration > 0 && m.duration < 30 && !m.ended && m.currentTime > 0 && m.currentTime < m.duration - 0.2)) {
            // a background loop: plays by itself, round and round
            node.setAttribute("autoplay", "");
            node.setAttribute("muted", "");
            node.setAttribute("playsinline", "");
            node.setAttribute("loop", "");
            stats.videosAutoplay = (stats.videosAutoplay || 0) + 1;
          } else if (!m.paused || m.autoplay || shown || m.played.length > 0 || m.hasAttribute("data-inline-media")) {
            // an animation the site plays ONCE as it comes into view (apple.com's product films): the trigger
            // script plays it there, once; without scripts (or with reduced motion) its still frame shows
            node.removeAttribute("autoplay");
            node.removeAttribute("loop");
            node.setAttribute("muted", "");
            node.setAttribute("playsinline", "");
            node.setAttribute("preload", "auto");
            node.setAttribute("data-sl-play", "enter");
            stats.videosOnEnter = (stats.videosOnEnter || 0) + 1;
          }
        }
        if (tag === "VIDEO" && o.posters && !node.getAttribute("poster")) {
          const v = m as HTMLVideoElement;
          if (v.videoWidth && v.videoHeight) {
            try {
              const c = document.createElement("canvas");
              c.width = Math.min(v.videoWidth, 1280);
              c.height = Math.round((c.width / v.videoWidth) * v.videoHeight);
              c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
              node.setAttribute("poster", c.toDataURL("image/jpeg", 0.82));
            } catch { /* tainted */ }
          }
        }
      } else if (tag === "IFRAME") {
        const f = src as HTMLIFrameElement;
        const fsrc = f.getAttribute("src") || "";
        const hidden = (f.width === "0" && f.height === "0") || f.style.display === "none" || f.getBoundingClientRect().width < 2;
        // widgets that only work with their own scripts (captchas, tag managers, chat messengers): dead weight
        // in a copy — and wherever scripts don't run (Studio), a blank box
        const widget = /(^|\/\/)([^/]+\.)?(google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|googletagmanager\.com|doubleclick\.net|intercom(cdn)?\.io|widget\.intercom|js\.driftt\.com|drift\.com|qualified\.com|tawk\.to|crisp\.chat|zdassets\.com|livechatinc\.com|hubspot\.com\/conversations|app\.chatwoot)/i.test(fsrc) || /^(reCAPTCHA|.*\bmessenger\b.*|.*\blive chat\b.*|.*\bchat widget\b.*)$/i.test(f.title || "") || /messenger|chat-?widget|intercom-frame|drift-frame/i.test(f.id || "");
        if (f.id === "__framer-editorbar" || /framer\.com\/edit/.test(fsrc) || hidden || widget) {
          node.remove();
          return;
        }
        let crossOrigin = false;
        try {
          crossOrigin = !!fsrc && /^https?:$/.test(new URL(fsrc, location.href).protocol) && new URL(fsrc, location.href).origin !== location.origin;
        } catch {
          crossOrigin = false;
        }
        if (o.frames) {
          try {
            // (a frame addressed to another site keeps its address, even while its document is still the
            // blank one it starts with — a player put back for the copy, a slow embed)
            const d = crossOrigin ? null : f.contentDocument;
            if (d && d.documentElement) {
              const inner = serializeFrameDoc(d);
              node.setAttribute("srcdoc", inner);
              node.removeAttribute("src");
              stats.frames++;
            } else if (fsrc) node.setAttribute("src", abs(fsrc));
          } catch {
            if (fsrc) node.setAttribute("src", abs(fsrc));
          }
        }
        // A background video player (Vimeo / YouTube embed: muted, no controls or looping) is usually set
        // playing by the site's script, which the copy doesn't have — say it in its address instead, as
        // for background <video>s (figma.com starts its product videos this way)
        const ns = node.getAttribute("src");
        if (ns) {
          try {
            const u = new URL(ns, location.href);
            const q = u.searchParams;
            const vimeo = /(^|\.)player\.vimeo\.com$/i.test(u.hostname);
            const yt = /(^|\.)youtube(-nocookie)?\.com$/i.test(u.hostname) && u.pathname.startsWith("/embed/");
            const muted = q.get("muted") === "1" || q.get("mute") === "1" || q.get("background") === "1";
            const bg = muted && (q.get("controls") === "0" || q.get("loop") === "1" || q.get("background") === "1");
            if ((vimeo || yt) && bg && q.get("autoplay") !== "1") {
              q.set("autoplay", "1");
              if (yt) {
                q.set("mute", "1");
                const vid = u.pathname.split("/")[2];
                if (q.get("loop") === "1" && vid && !q.get("playlist")) q.set("playlist", vid); // YouTube loops only with a playlist
              }
              node.setAttribute("src", u.href);
              const allow = node.getAttribute("allow") || "";
              if (!/autoplay/.test(allow)) node.setAttribute("allow", (allow ? allow.replace(/;?\s*$/, "; ") : "") + "autoplay; fullscreen; picture-in-picture");
              stats.videosAutoplay = (stats.videosAutoplay || 0) + 1;
            }
          } catch {
            /* not a URL */
          }
        }
        // An embed from another site (a Vimeo / YouTube player, a map, a widget) can only be linked, not
        // copied — and it won't show wherever it can't run: StyleLift Studio's canvas (no scripts there),
        // offline, or a player that only plays on its owner's domain. The panel takes a picture of it on
        // screen and the copy keeps that picture behind the embed (figma.com's product videos are these).
        if (node.hasAttribute("src") && !node.hasAttribute("srcdoc") && needsShot.length < 24) {
          const r = f.getBoundingClientRect();
          const cs = getComputedStyle(f);
          if (r.width >= 60 && r.height >= 40 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05) {
            const id = `f${needsShot.length + 1}`;
            f.setAttribute(SHOOT_ATTR, id);
            node.setAttribute(SHOOT_ATTR, id);
            needsShot.push(id);
            shotBoxes[id] = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
          }
        }
      } else if (tag === "STYLE") {
        const sheet = (src as HTMLStyleElement).sheet;
        if (src.id === "__sl_editor_css") return; // StyleLift edits: keep verbatim
        if ((src as HTMLStyleElement).disabled) {
          node.remove();
          return;
        }
        if (sheet) {
          const st = sheetToStyle(sheet, location.href);
          if (st && (st.textContent || "").trim()) {
            for (const a of Array.from(node.attributes)) if (a.name !== "media") st.setAttribute(a.name, a.value);
            node.replaceWith(st);
          }
        }
      } else if (tag === "LINK") {
        const l = src as HTMLLinkElement;
        if (l.disabled) {
          node.remove();
          return;
        }
        const st = l.sheet ? sheetToStyle(l.sheet, l.sheet.href || abs(l.href)) : null;
        if (st && (st.textContent || "").trim()) {
          if (l.media) st.setAttribute("media", l.media);
          st.setAttribute("data-sl-href", abs(l.href));
          node.replaceWith(st);
        } else {
          node.setAttribute("href", abs(l.href));
          stats.crossOriginSheets++;
        }
      }
    }
  }
  // Same-origin frame: lightweight serialization (styles inlined, scripts per option).
  function serializeFrameDoc(d: Document): string {
    const root = d.documentElement.cloneNode(true) as HTMLElement;
    const sheets = Array.from(d.styleSheets);
    root.querySelectorAll("link[rel~=stylesheet], style").forEach((n) => n.remove());
    const head = root.querySelector("head") || root;
    for (const s of sheets) {
      const st = sheetToStyle(s, s.href || d.baseURI);
      if (st) head.appendChild(st);
    }
    if (!root.querySelector("base")) {
      const b = d.createElement("base");
      b.href = d.baseURI;
      head.insertBefore(b, head.firstChild);
    }
    if (o.scripts === "strip") root.querySelectorAll("script").forEach((s) => s.remove());
    return "<!doctype html>\n" + root.outerHTML;
  }

  // Canvas shots (WebGL-aware). Read inside rAF callbacks so WebGL buffers that are
  // cleared after compositing are grabbed in the same frame the page draws them.
  const canvasShots = new Map<Element, string>();
  // live 3D scenes (islands) marked in the copy, in document order of the page's canvases
  let islandN = 0;
  let canvasOrder: Element[] | null = null;
  // which 3D scenes stay live: the two largest (each live scene loads the site's page again in the visitor's
  // browser — a heavy WebGL site many times over would swamp it); the others keep their pictures
  let islandPick: Set<Element> | null = null;
  // ── Classes put on the page itself (html / body) and its bars past a scroll position ────────────
  // ("show-localnav" once past the hero, "is-scrolled" turning a header solid): sampled at every stop of
  // the scroll pass, written as data-sl-scroll-classes='[{"t":token,"a":from,"b":to}]' for the trigger
  // script. Only what follows the position: a class still there back at the top (a "loaded" flag set while
  // we scrolled) isn't one, nor a bar hiding while scrolling down (that follows the direction).
  const scrollCls: { y: number; c: Map<Element, Set<string>> }[] = [];
  let clsTargets: Element[] | null = null;
  function sampleScrollClasses(y: number): void {
    try {
      if (!clsTargets) {
        clsTargets = [document.documentElement, document.body];
        // (the classes may sit on the bar or on a box inside or around it — apple.com's sticky nav#localnav never
        // changes, the div#localnav-container inside it gets "sticky" and "reveal": each is watched on its own)
        // (each kind has its own budget: a page with many sticky strips further down — apple.com's galleries' tab
        // navs — must not use up the places before its bar <div>s are looked at)
        let navs = 0;
        for (const b of Array.from(document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]'))) {
          if (navs >= 16) break;
          const pos = getComputedStyle(b).position;
          if (pos === "fixed" || pos === "sticky") {
            clsTargets.push(b);
            navs++;
          }
        }
        // …and a bar that is a plain <div> named like one (apple.com's "localnav-container"), at the top of the page
        const BAR = /(^|[-_\s])((local|sub|top|main|site|page|global)?-?nav(bar|igation)?|header|topbar|toolbar|menubar|navbar)([-_\s]|$)/i;
        let bars = 0;
        for (const b of Array.from(document.querySelectorAll("body div[id], body div[class]")).slice(0, 4000)) {
          if (bars >= 8) break;
          if (!BAR.test(`${b.id} ${typeof b.className === "string" ? b.className : ""}`) || clsTargets.includes(b)) continue;
          // (its box may hold the bar's own hidden menu too — apple.com's is 557 px tall with it). A bar spans the page:
          // the global nav's menus, flyouts and items above it (globalnav-flyout, globalnav-item…: hidden, or narrow)
          // are not bars and must not use up the places
          const r = b.getBoundingClientRect();
          if (r.top + scrollY > 200 || r.height > innerHeight * 0.8 || r.height < 8 || r.width < innerWidth * 0.5) continue;
          const bc = getComputedStyle(b);
          if (bc.visibility === "hidden" || bc.display === "none") continue;
          clsTargets.push(b);
          bars++;
        }
      }
      if (scrollCls.length > 400) return;
      const c = new Map<Element, Set<string>>();
      for (const t of clsTargets) c.set(t, new Set(Array.from(t.classList)));
      scrollCls.push({ y, c });
    } catch {
      /* never in the way */
    }
  }
  function markScrollClasses(): number {
    if (scrollCls.length < 3 || !clsTargets) return 0;
    const DIRECTION = /pin|unpin|hidden|hide|hiding|scroll(ing)?[-_]?(up|down)|direction|(^|[-_])(up|down)($|[-_])|headroom|invisible|out$/i;
    const STATE = /open|menu|modal|dialog|loading|loaded|ready|init|lock|fonts?-|wf-|js$|touch|hover|focus|lenis|smooth/i;
    let n = 0;
    for (const el of clsTargets) {
      if (!el.isConnected) continue;
      const all = new Set<string>();
      for (const s0 of scrollCls) for (const t of s0.c.get(el) || []) all.add(t);
      const rules: { t: string; a: number; b: number | null }[] = [];
      const top = scrollCls[0].c.get(el) || new Set<string>();
      // feature flags, Modernizr-style ("x" / "no-x": apple.com drops "enhanced-rt" for "no-enhanced-rt" when frames
      // run slow — the capture's doing, not the scroll's)
      const flag = (t: string) => /^no-/.test(t) || all.has("no-" + t);
      for (const t of all) {
        if (DIRECTION.test(t) || STATE.test(t) || flag(t)) continue;
        // back at the top now (the copy is taken here): as it was at the top before the pass
        if (el.classList.contains(t) !== top.has(t)) continue;
        const on = scrollCls.map((s0) => !!s0.c.get(el)?.has(t));
        const flips: number[] = [];
        for (let i = 1; i < on.length; i++) if (on[i] !== on[i - 1]) flips.push(i);
        if (!flips.length || flips.length > 2) continue;
        const at = (i: number) => Math.round((scrollCls[i - 1].y + scrollCls[i].y) / 2);
        if (!on[0] && flips.length === 1) rules.push({ t, a: at(flips[0]), b: null });
        else if (on[0] && flips.length === 1) rules.push({ t, a: 0, b: at(flips[0]) });
        else if (!on[0] && flips.length === 2) rules.push({ t, a: at(flips[0]), b: at(flips[1]) });
      }
      if (rules.length) {
        el.setAttribute("data-sl-scroll-classes", JSON.stringify(rules.slice(0, 8)));
        n += rules.length;
      }
    }
    return n;
  }
  // ── Widgets the page's scripts run: made to work in the copy by the trigger script ─────────────
  // Marked on the live page just before the copy is cloned (the marks travel with it; cleared after):
  //   • tab lists (role="tablist" whose tabs name their panels): data-sl-tabs — the copy learns each
  //     list's "selected" look from the page itself (the selected tab and panel against the others);
  //   • Previous / Next arrows of a sliding gallery, paired with what they move — a scroll strip, or a
  //     track inside a clipped frame: data-sl-paddle="-1|1:n" + data-sl-scroller="n";
  //   • a video's play / pause button: data-sl-media="n" + data-sl-media-v="n", and the wrappers whose
  //     playing / paused / ended classes the page's CSS reads: data-sl-media-ui="n".
  // A one-shot CSS animation of the site's own below the first screen (a gradient swiping across a headline,
  // set off by a class added as it came into view): in the copy the class is there from the start, so it would
  // play — and finish — at page load, long before anyone scrolls there. Marked data-sl-hold: the trigger script
  // holds it at its first frame until it comes into view. Endless loops are left running.
  function markHeldAnimations(): number {
    let n = 0;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (let i = 0; i < all.length && i < 12000 && n < 200; i++) {
      const el = all[i];
      if (!(el instanceof HTMLElement) || el.hasAttribute("data-sl-in") || el.hasAttribute(REVEAL_ATTR) || el.hasAttribute(SCROLL_ATTR) || el.hasAttribute("data-sl-id")) continue;
      const c = getComputedStyle(el);
      if (c.animationName === "none" || /(^|,\s*)(sl-|slm-)/.test(c.animationName) || /infinite/.test(c.animationIterationCount)) continue;
      if (!c.animationDuration.split(",").some((d) => parseFloat(d) > 0) || c.display === "none" || c.position === "fixed") continue;
      if (/view|scroll|--/.test(c.getPropertyValue("animation-timeline"))) continue; // scroll-driven already
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.top + scrollY < innerHeight * 0.9) continue;
      el.setAttribute("data-sl-hold", "");
      n++;
    }
    return n;
  }
  // Readable HTML: the copy is indented by nesting — but ONLY whitespace that is already there between tags is
  // re-laid (never added where there was none: inline-block items would gain a gap), and only where the live
  // page's CSS collapses whitespace (white-space normal / nowrap: any run of spaces and line breaks shows as one
  // space or nothing) — so the page renders exactly the same. Walks the live page and its fresh copy together.
  function tidyWhitespace(live: Element, copy: Element): void {
    const SKIP = /^(pre|textarea|script|style|template|code|listing|xmp|plaintext|svg|math|noscript|iframe|title)$/i;
    let budget = 60000;
    const walk = (a: Element, b: Element, depth: number) => {
      if (--budget < 0 || SKIP.test(a.localName)) return;
      let collapses = true;
      try {
        collapses = /^(normal|nowrap)$/.test(getComputedStyle(a).whiteSpace) || getComputedStyle(a).whiteSpaceCollapse === "collapse";
      } catch {
        collapses = false;
      }
      const ak = a.childNodes, bk = b.childNodes;
      if (ak.length !== bk.length) return; // not the same shape (shouldn't happen right after cloning)
      for (let i = 0; i < ak.length; i++) {
        const x = ak[i], y = bk[i];
        if (x.nodeType === 1 && y.nodeType === 1) walk(x as Element, y as Element, depth + 1);
        else if (collapses && y.nodeType === 3 && /^[ \t\n\r\f]+$/.test(y.nodeValue || "")) {
          // before the closing tag: back to this element's own depth
          const last = !Array.from(bk).slice(i + 1).some((z) => z.nodeType === 1 || (z.nodeType === 3 && (z.nodeValue || "").trim()));
          y.nodeValue = "\n" + "  ".repeat(Math.max(0, last ? depth : depth + 1));
        }
      }
    };
    walk(live, copy, 0);
  }
  function markWidgets(): number {
    let n = 0;
    const tabsOf = (tl: Element) => Array.from(tl.querySelectorAll('[role="tab"]')).filter((t) => t.closest('[role="tablist"]') === tl);
    const panelOf = (t: Element): Element | null => {
      const id = (t.getAttribute("aria-controls") || "").trim().split(/\s+/)[0];
      let p: Element | null = id ? document.getElementById(id) : null;
      if (!p && t.id) p = Array.from(document.querySelectorAll('[role="tabpanel"][aria-labelledby]')).find((x) => (x.getAttribute("aria-labelledby") || "").split(/\s+/).includes(t.id)) || null;
      return p;
    };
    for (const tl of Array.from(document.querySelectorAll('[role="tablist"]'))) {
      const tabs = tabsOf(tl);
      if (tabs.length >= 2 && tabs.every((t) => panelOf(t))) {
        tl.setAttribute("data-sl-tabs", "");
        n++;
      }
    }
    // a strip that scrolls sideways, or a clipped frame whose track is wider than it (a slider moving it)
    const stripSeen = new Map<Element, "scroll" | "track" | null>();
    const strip = (el: Element): "scroll" | "track" | null => {
      if (stripSeen.has(el)) return stripSeen.get(el) || null;
      let kind: "scroll" | "track" | null = null;
      if (el instanceof HTMLElement && el.clientWidth >= 120) {
        const wide = el.scrollWidth > el.clientWidth + 4;
        const one = el.children.length === 1 && el.children[0].children.length >= 2;
        if (wide || one) {
          const ox = getComputedStyle(el).overflowX;
          if (wide && /auto|scroll/.test(ox)) kind = "scroll";
          else if (one && /hidden|clip/.test(ox)) {
            const kids = el.children[0].children;
            const r = el.getBoundingClientRect();
            if (wide || kids[kids.length - 1].getBoundingClientRect().right > r.right + 4 || kids[0].getBoundingClientRect().left < r.left - 4) kind = "track";
          }
        }
      }
      stripSeen.set(el, kind);
      return kind;
    };
    // which way an arrow goes: its label ("Next item", "Scroll left"), its class (slick-prev,
    // swiper-button-next, arrow-left — not a bare "left" / "right", which layout classes use) or its glyph
    const DIR_LABEL = (el: Element): number => {
      const said = (txt: string) => {
        const w = txt.toLowerCase().split(/[^a-z]+/);
        if (w.some((x) => x === "prev" || x === "previous" || x === "back" || x === "left" || x === "backward")) return -1;
        if (w.some((x) => x === "next" || x === "forward" || x === "right")) return 1;
        return 0;
      };
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase().split(/\s+/);
      const byClass = cls.some((c) => /(^|[-_])(prev|previous)([-_]|$)|(arrow|chevron|paddle|caret|nav)[-_]*left|left[-_]*(arrow|chevron|paddle|caret)/.test(c))
        ? -1
        : cls.some((c) => /(^|[-_])next([-_]|$)|(arrow|chevron|paddle|caret|nav)[-_]*right|right[-_]*(arrow|chevron|paddle|caret)/.test(c))
          ? 1
          : 0;
      const t = (el.textContent || "").trim();
      const byText = t.length > 12 ? 0 : /^(‹|<|←|❮|〈|prev\b|previous\b|back\b)/i.test(t) ? -1 : /(›|>|→|❯|〉|\bnext)$/i.test(t) ? 1 : 0;
      return said(el.getAttribute("aria-label") || "") || said(el.getAttribute("title") || "") || byClass || byText;
    };
    let strips = 0;
    const stripId = new Map<Element, string>();
    let looked = 0;
    for (const b of Array.from(document.querySelectorAll('button, [role="button"], a:not([href]), a[href="#"]'))) {
      if (b.closest('[role="tablist"], nav, header, [role="navigation"], [role="dialog"]') || b.hasAttribute("data-sl-paddle")) continue;
      if (++looked > 400) break;
      const dir = DIR_LABEL(b);
      if (!dir) continue;
      const br = b.getBoundingClientRect();
      if (br.width < 8 || br.height < 8) continue;
      // what it moves: the nearest strip within a few levels up, next to it on the page
      let found: Element | null = null;
      for (let a = b.parentElement, up = 0; a && up < 6 && !found; a = a.parentElement, up++) {
        const all = a.getElementsByTagName("*");
        const cands: Element[] = [a];
        for (let i = 0; i < all.length && cands.length < 400; i++) if (!all[i].contains(b)) cands.push(all[i]);
        let best: Element | null = null, bestA = 0;
        for (const el of cands) {
          if (!strip(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < br.top - 300 || r.top > br.bottom + 300) continue;
          if (r.width * r.height > bestA) { best = el; bestA = r.width * r.height; }
        }
        found = best;
      }
      if (!found) continue;
      let id = stripId.get(found);
      if (!id) {
        id = String(++strips);
        stripId.set(found, id);
        found.setAttribute("data-sl-scroller", `${strip(found)}:${id}`);
        n++;
      }
      b.setAttribute("data-sl-paddle", `${dir}:${id}`);
    }
    // video play / pause buttons, and the wrappers that show the video's state through classes
    let media = 0;
    const STATE = /(^|\s)(playing|paused|ended)(\s|$)/;
    const uiOf = (v: Element, id: string, stop: Element | null) => {
      for (let a: Element | null = v.parentElement, up = 0; a && up < 4; a = a.parentElement, up++) {
        if (STATE.test(typeof a.className === "string" ? a.className : "")) a.setAttribute("data-sl-media-ui", id);
        a.querySelectorAll("[class]").forEach((x) => { if (x !== v && !x.querySelector("video") && STATE.test(typeof x.className === "string" ? x.className : "") && !x.hasAttribute("data-sl-media-ui")) x.setAttribute("data-sl-media-ui", id); });
        if (a === stop) break;
      }
    };
    for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      if (!/^(play|pause|replay)\b/i.test((b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim())) continue;
      let box: Element | null = null;
      for (let a = b.parentElement, up = 0; a && up < 5; a = a.parentElement, up++) {
        const vs = a.querySelectorAll("video");
        if (vs.length === 1) { box = a; break; }
        if (vs.length > 1) break;
      }
      // a controls bar that names its video (aria-controls on the button or a wrapper)
      const named = (b.getAttribute("aria-controls") && document.getElementById(b.getAttribute("aria-controls") || "")) || null;
      const v = named instanceof HTMLVideoElement ? named : box?.querySelector("video");
      if (!v) continue;
      let id = v.getAttribute("data-sl-media-v");
      if (!id) {
        id = String(++media);
        v.setAttribute("data-sl-media-v", id);
        uiOf(v, id, box);
        n++;
      }
      b.setAttribute("data-sl-media", id);
    }
    // videos played once on entering (their state classes follow them too), without a button
    for (const v of Array.from(document.querySelectorAll("video"))) {
      if (v.hasAttribute("data-sl-media-v")) continue;
      let ui = false;
      for (let a: Element | null = v.parentElement, up = 0; a && up < 3 && !ui; a = a.parentElement, up++) if (STATE.test(typeof a.className === "string" ? a.className : "")) ui = true;
      if (!ui) continue;
      const id = String(++media);
      v.setAttribute("data-sl-media-v", id);
      uiOf(v, id, null);
    }
    return n;
  }
  // a selector that finds the same element again in the site's own page (an id, else its place in the tree)
  const cssPathOf = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll(`#${el.id}`).length === 1) return `#${el.id}`;
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement && parts.length < 14; e = e.parentElement) {
      const p: Element | null = e.parentElement;
      if (!p) break;
      const same = Array.from(p.children).filter((x) => x.localName === e!.localName);
      parts.unshift(same.length > 1 ? `${e.localName}:nth-of-type(${same.indexOf(e) + 1})` : e.localName);
    }
    return "body > " + parts.join(" > ");
  };
  // Wait until on-screen canvases stop changing (tiny thumbnails compared frame to
  // frame). A spinning model barely changes a 24×24 thumbnail; one gliding across the
  // screen changes it a lot. Tainted or blank-buffer canvases are ignored.
  async function settleCanvases(maxMs: number): Promise<void> {
    const list = Array.from(document.querySelectorAll("canvas")).filter((c) => {
      const r = c.getBoundingClientRect();
      return c.width > 0 && c.height > 0 && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    if (!list.length) return;
    const t = document.createElement("canvas");
    t.width = t.height = 24;
    const ctx = t.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const prints = (): (Uint8ClampedArray | null)[] =>
      list.map((c) => {
        try {
          ctx.clearRect(0, 0, 24, 24);
          ctx.drawImage(c, 0, 0, 24, 24);
          const d = ctx.getImageData(0, 0, 24, 24).data;
          for (let i = 3; i < d.length; i += 4) if (d[i]) return d.slice();
          return null; // cleared buffer: nothing to compare
        } catch {
          return null;
        }
      });
    const sample = () =>
      new Promise<(Uint8ClampedArray | null)[]>((resolve) => {
        let done = false;
        const fire = () => { if (!done) { done = true; resolve(prints()); } };
        requestAnimationFrame(fire);
        setTimeout(fire, 300);
      });
    const t0 = performance.now();
    let prev: (Uint8ClampedArray | null)[] | null = null;
    let calm = 0;
    while (performance.now() - t0 < maxMs) {
      const cur = await sample();
      if (prev) {
        let moving = false;
        for (let i = 0; i < cur.length; i++) {
          const a = prev[i], b = cur[i];
          if (!a || !b) continue;
          let sum = 0;
          for (let j = 0; j < a.length; j++) sum += Math.abs(a[j] - b[j]);
          if (sum / a.length > 4) moving = true;
        }
        calm = moving ? 0 : calm + 1;
        if (calm >= 2) return;
      }
      prev = cur;
      await sleep(120);
    }
  }
  async function grabCanvases(): Promise<void> {
    const canvases = Array.from(document.querySelectorAll("canvas")).filter((c) => c.width > 0 && c.height > 0);
    if (!canvases.length) return;
    const blankCache = new Map<string, string>();
    const blankOf = (w: number, h: number): string => {
      const k = w + "x" + h;
      let b = blankCache.get(k);
      if (!b) {
        const bc = document.createElement("canvas");
        bc.width = w;
        bc.height = h;
        b = bc.toDataURL("image/png");
        blankCache.set(k, b);
      }
      return b;
    };
    const tryGrab = () => {
      for (const c of canvases) {
        if (canvasShots.has(c)) continue;
        try {
          const d = c.toDataURL("image/png");
          if (d && d !== EMPTY_PNG && d !== blankOf(c.width, c.height)) canvasShots.set(c, d);
        } catch {
          /* tainted / detached — the per-node fallback counts it */
        }
      }
    };
    tryGrab(); // 2D canvases read fine immediately
    for (let i = 0; i < 10 && canvasShots.size < canvases.length; i++) {
      await Promise.race([
        new Promise<void>((r) => requestAnimationFrame(() => { tryGrab(); r(); })),
        sleep(300), // a throttled page can't stall the capture
      ]);
    }
  }

  // ── B. blob: images → data: URIs (blob URLs die with the tab) ───────────────
  const blobSrcMap = new Map<string, string>();
  async function resolveBlobImages(): Promise<void> {
    const urls = new Set<string>();
    for (const i of Array.from(document.images)) {
      const u = i.currentSrc || i.getAttribute("src") || "";
      if (u.startsWith("blob:")) urls.add(u);
    }
    for (const u of urls) {
      try {
        const b = await (await fetch(u)).blob();
        if (b.size > 8_000_000) continue;
        const d = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(b);
        });
        blobSrcMap.set(u, d);
      } catch {
        /* revoked object URL */
      }
    }
  }

  // ── external SVG sprites: <use href="/icons.svg#id"> ──────────────────────
  // Browsers refuse <use> references to another origin, so a saved copy loses every
  // sprite icon. Fetch each sprite file once (same-origin from here) and inline the
  // referenced symbol in place of the <use>.
  const spriteDefs = new Map<string, { node: Element; viewBox: string | null } | null>(); // abs url#id → def
  async function prefetchSprites(): Promise<void> {
    const uses: Element[] = [];
    const scan = (root: Document | ShadowRoot) => {
      root.querySelectorAll("use").forEach((u) => uses.push(u));
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    };
    scan(document);
    const files = new Map<string, Document | null>();
    for (const u of uses) {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (!href || href.startsWith("#") || href.startsWith("data:")) continue;
      const full = abs(href, (u.getRootNode() as Document).baseURI || document.baseURI);
      if (spriteDefs.has(full)) continue;
      const [file, id] = full.split("#");
      if (!files.has(file)) {
        let svgDoc: Document | null = null;
        try {
          const res = await fetch(file, { credentials: "same-origin" });
          if (res.ok) svgDoc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
          if (svgDoc && svgDoc.querySelector("parsererror")) svgDoc = null;
        } catch {
          /* cross-origin without CORS, or offline */
        }
        files.set(file, svgDoc);
      }
      const svgDoc = files.get(file);
      const node = id ? svgDoc?.getElementById(id) : svgDoc?.documentElement;
      spriteDefs.set(full, node ? { node, viewBox: node.getAttribute("viewBox") } : null);
    }
  }
  function inlineSprites(root: Element | DocumentFragment, baseUri: string): void {
    for (const u of Array.from(root.querySelectorAll("use"))) {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (!href || href.startsWith("#") || href.startsWith("data:")) continue;
      const def = spriteDefs.get(abs(href, baseUri));
      if (!def) {
        u.setAttribute("href", abs(href, baseUri));
        continue;
      }
      const NS = "http://www.w3.org/2000/svg";
      const doc = u.ownerDocument;
      // <symbol>/<svg> → nested <svg viewBox>; anything else → <g>
      const isBox = /^(symbol|svg)$/i.test(def.node.localName);
      const rep = doc.createElementNS(NS, isBox ? "svg" : "g");
      for (const a of Array.from(u.attributes)) if (!/^(xlink:)?href$/.test(a.name)) rep.setAttribute(a.name, a.value);
      if (isBox) {
        if (def.viewBox && !rep.hasAttribute("viewBox")) rep.setAttribute("viewBox", def.viewBox);
        for (const a of ["preserveAspectRatio", "fill", "stroke"]) {
          const v = def.node.getAttribute(a);
          if (v && !rep.hasAttribute(a)) rep.setAttribute(a, v);
        }
        if (!rep.hasAttribute("width")) rep.setAttribute("width", "100%");
        if (!rep.hasAttribute("height")) rep.setAttribute("height", "100%");
        for (const c of Array.from(def.node.childNodes)) rep.appendChild(doc.importNode(c, true));
      } else {
        const x = u.getAttribute("x"), y = u.getAttribute("y");
        if (x || y) rep.setAttribute("transform", `translate(${x || 0} ${y || 0})`);
        rep.appendChild(doc.importNode(def.node, true));
      }
      u.replaceWith(rep);
      stats.spritesInlined++;
    }
  }

  // ── hover effects run by scripts ────────────────────────────────────────────
  // CSS :hover effects are in the stylesheets and come along. Effects a script plays when the pointer comes
  // over an element (GSAP on mouseenter: an image zooming, a card lifting, a line drawing in; a class added
  // on hover) are lost with the scripts. Each hoverable element is sent the pointer-over events — they run
  // the page's handlers but not its CSS :hover, so only the scripted effect shows — what changes in it is
  // recorded at rest, its timing measured, the pointer-out events sent and everything put back exactly.
  // The copy gets a CSS :hover rule with that look and timing (only where there's a real pointer).
  const HOV_ATTR = "data-sl-hov", HOVT_ATTR = "data-sl-hovt";
  const hoverCss: string[] = [];
  // pointer effects the page runs while the pointer moves: magnetic parts, 3D tilt, cursor followers
  const pointerCss: string[] = [];
  let pointerN = 0;
  // Cursor followers: a small element fixed to the screen that goes where the pointer goes. The pointer is
  // moved across the page twice; whatever travelled with it is one — its offset from the pointer and how
  // quickly it catches up (eased every frame, as these are) are measured, then everything is put back.
  async function recordCursor(): Promise<void> {
    const small: HTMLElement[] = [];
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (let i = 0; i < all.length && i < 8000 && small.length < 40; i++) {
      const el = all[i];
      if (!(el instanceof HTMLElement) || el.childElementCount > 8 || el.closest(UI_SELECTOR)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 320 || r.height > 320 || r.width + r.height < 4) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || (pos === "absolute" && el.parentElement === document.body)) small.push(el);
    }
    if (!small.length) return;
    const centre = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const old = new Map<Element, { style?: string | null; cls?: string | null }>();
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        const t = r.target;
        if (!(t instanceof Element)) continue;
        let o0 = old.get(t);
        if (!o0) old.set(t, (o0 = {}));
        if (r.attributeName === "style" && !("style" in o0)) o0.style = r.oldValue;
        if (r.attributeName === "class" && !("cls" in o0)) o0.cls = r.oldValue;
      }
    });
    mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style", "class"], attributeOldValue: true });
    const move = (x: number, y: number) => {
      const t = document.elementFromPoint(x, y) || document.body;
      const base = { clientX: x, clientY: y, view: window, bubbles: true, cancelable: true, composed: true };
      try {
        t.dispatchEvent(typeof PointerEvent === "function" ? new PointerEvent("pointermove", { ...base, pointerType: "mouse", isPrimary: true }) : new MouseEvent("pointermove", base));
        t.dispatchEvent(new MouseEvent("mousemove", base));
      } catch {
        /* a handler threw */
      }
    };
    try {
      const P1 = { x: Math.round(innerWidth * 0.3), y: Math.round(innerHeight * 0.4) }, P2 = { x: Math.round(innerWidth * 0.65), y: Math.round(innerHeight * 0.62) };
      move(P1.x, P1.y);
      await sleep(700);
      const c1 = small.map(centre);
      const t0 = performance.now();
      move(P2.x, P2.y);
      const track: { t: number; c: { x: number; y: number }[] }[] = [];
      while (performance.now() - t0 < 1000) {
        await sleep(40);
        track.push({ t: performance.now() - t0, c: small.map(centre) });
      }
      const dP = Math.hypot(P2.x - P1.x, P2.y - P1.y);
      small.forEach((el, i) => {
        const c2 = track[track.length - 1].c[i];
        const mx = c2.x - c1[i].x, my = c2.y - c1[i].y;
        // went where the pointer went (±20%), and sits near it
        if (Math.hypot(mx - (P2.x - P1.x), my - (P2.y - P1.y)) > dP * 0.2 || Math.hypot(c2.x - P2.x, c2.y - P2.y) > 160) return;
        if (el.hasAttribute("data-sl-cursor") || pointerN > 60) return;
        // how long until it was 90% of the way there → the share of the gap it closes each frame
        const hit = track.find((s) => Math.hypot(track[track.length - 1].c[i].x - s.c[i].x, track[track.length - 1].c[i].y - s.c[i].y) < dP * 0.1);
        const frames = Math.max(1, (hit ? hit.t : 1000) / 16.7);
        const k = hit && hit.t <= 45 ? 1 : 1 - Math.pow(0.1, 1 / frames);
        el.setAttribute("data-sl-cursor", JSON.stringify({ k: Math.round(k * 1000) / 1000, ox: Math.round(c2.x - P2.x), oy: Math.round(c2.y - P2.y) }));
        // its own script keeps placing it every frame: the copy gets how it looked before we moved the pointer
        const o0 = old.get(el);
        if (o0 && "style" in o0) el.setAttribute("data-sl-cursor-rest", o0.style ?? "");
        pointerN++;
        stats.cursorFollowers = (stats.cursorFollowers || 0) + 1;
      });
      if (stats.cursorFollowers) pointerCss.push(`[data-sl-cursor] { translate: var(--slm-cx, 0px) var(--slm-cy, 0px) !important; }`);
      await sleep(250);
    } finally {
      mo.disconnect();
      for (const [el, o0] of old) {
        if ("style" in o0) { if (o0.style == null) el.removeAttribute("style"); else el.setAttribute("style", o0.style); }
        if ("cls" in o0) { if (o0.cls == null) el.removeAttribute("class"); else el.setAttribute("class", o0.cls); }
      }
    }
  }
  async function recordHovers(budget = 10000): Promise<void> {
    const tStart = performance.now();
    const PROPS = ["transform", "translate", "scale", "rotate", "opacity", "filter", "clip-path", "color", "background-color", "border-color", "box-shadow", "width", "letter-spacing", "visibility"];
    const docArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
    const usable = (el: Element): boolean => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement) || !el.isConnected || el === document.body || el === document.documentElement) return false;
      if (el.closest(UI_SELECTOR)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 12 || r.width * r.height > docArea * 0.5) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    };
    // 1. the elements the page listens to for the pointer coming over them (the page-world recorder noted
    //    them when it ran from the start), then what looks hoverable: links, buttons and cards with parts
    try {
      document.dispatchEvent(new CustomEvent("sl-hover-mark"));
    } catch {
      /* no recorder */
    }
    const picked = new Set<Element>();
    document.querySelectorAll("[data-sl-hl]").forEach((el) => {
      el.removeAttribute("data-sl-hl");
      if (picked.size < 80 && usable(el)) picked.add(el);
    });
    const wfDone = document.documentElement.hasAttribute("data-sl-wf-css"); // Webflow hovers come from its own data
    {
      const pool = document.querySelectorAll("a[href], button, [role='button'], [class*='card' i], [class*='hover' i], [class*='tile' i]");
      let extra = 0;
      for (let i = 0; i < pool.length && i < 600 && extra < 40; i++) {
        const el = pool[i];
        if (picked.has(el) || !el.firstElementChild || !usable(el)) continue;
        const a = /^(a|button)$/i.test(el.localName) || el.getAttribute("role") === "button";
        if (!a && getComputedStyle(el).cursor !== "pointer" && !/card|tile/i.test(String(el.getAttribute("class") || ""))) continue;
        picked.add(el);
        extra++;
      }
    }
    let cands = Array.from(picked).filter((el) => !(wfDone && el.hasAttribute("data-w-id")));
    if (!cands.length) return;
    // what changes by itself, with nobody hovering (tickers, carousels, counters): never a hover effect
    const restless = new Set<Element>();
    {
      const mo0 = new MutationObserver((recs) => recs.forEach((r) => r.target instanceof Element && restless.add(r.target)));
      mo0.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
      await sleep(450);
      mo0.disconnect();
    }
    // the outermost of nested ones go first in a batch; nested ones wait for a later batch
    const fire = (el: Element, enter: boolean) => {
      const r = el.getBoundingClientRect();
      const base = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window, cancelable: true, composed: true, relatedTarget: null };
      const seq: [string, boolean][] = enter
        ? [["pointerover", true], ["pointerenter", false], ["mouseover", true], ["mouseenter", false]]
        : [["pointerout", true], ["pointerleave", false], ["mouseout", true], ["mouseleave", false]];
      for (const [type, bubbles] of seq) {
        try {
          el.dispatchEvent(type.startsWith("pointer") && typeof PointerEvent === "function" ? new PointerEvent(type, { ...base, bubbles, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, { ...base, bubbles }));
        } catch {
          /* a handler threw */
        }
      }
    };
    const secs = (v: string) => v.split(",").map((x) => (/ms$/.test(x.trim()) ? parseFloat(x) / 1000 : parseFloat(x) || 0));
    let n = 0;
    while (cands.length && performance.now() - tStart < budget) {
      const batch: Element[] = [];
      const later: Element[] = [];
      for (const c of cands) {
        if (batch.length < 16 && !batch.some((b) => b.contains(c) || c.contains(b))) batch.push(c);
        else later.push(c);
      }
      cands = later;
      // each candidate's parts, as they look now
      const owner = new Map<Element, Element>();
      const before = new Map<Element, string[]>();
      for (const c of batch) {
        const parts = [c, ...Array.from(c.querySelectorAll("*")).slice(0, 120)];
        for (const el of parts) {
          if (owner.has(el)) continue;
          owner.set(el, c);
          const cs = getComputedStyle(el);
          before.set(el, PROPS.map((p) => cs.getPropertyValue(p)));
        }
      }
      // every style / class change from here on, with its first old value (to put everything back)
      const old = new Map<Element, { style?: string | null; cls?: string | null }>();
      const lastOf = new Map<Element, number>();
      let last = performance.now();
      const mo = new MutationObserver((recs) => {
        const now = performance.now();
        for (const r of recs) {
          const t = r.target;
          if (!(t instanceof Element)) continue;
          last = now;
          let o0 = old.get(t);
          if (!o0) old.set(t, (o0 = {}));
          if (r.attributeName === "style" && !("style" in o0)) o0.style = r.oldValue;
          if (r.attributeName === "class" && !("cls" in o0)) o0.cls = r.oldValue;
          const c = owner.get(t);
          if (c) lastOf.set(c, now);
        }
      });
      mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style", "class"], attributeOldValue: true });
      const t1 = performance.now();
      for (const c of batch) fire(c, true);
      // settle: no more changes for a moment, then the CSS transitions they set off run out
      const quiet = async (max: number) => {
        const end = performance.now() + max;
        await sleep(90);
        while (performance.now() < end && performance.now() - last < 160) await sleep(40);
        const running = document.getAnimations().filter((a) => {
          const tg = (a.effect as KeyframeEffect | null)?.target;
          // on what changed, or on any part of the hovered elements (a class on a card fades its picture)
          return !!tg && (old.has(tg) || owner.has(tg)) && a.playState === "running" && typeof CSSTransition !== "undefined" && a instanceof CSSTransition;
        });
        if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => null))), sleep(Math.max(0, end - performance.now()))]);
      };
      await quiet(1400);
      // what each candidate's hover changed in it
      for (const c of batch) {
        const changed: { el: Element; props: [string, string][] }[] = [];
        // a class changed somewhere in it: the site's CSS may restyle any of its parts → compare them all;
        // else only the parts a script styled. (Changes outside its own parts — a cursor follower — are
        // not hover effects of it.)
        const mine = Array.from(old.keys()).filter((el) => owner.get(el) === c && !restless.has(el));
        if (!mine.length) continue;
        const viaClass = mine.some((el) => "cls" in old.get(el)!);
        const look = (el: Element) => getComputedStyle(el);
        const peak = new Map<Element, string[]>();
        const parts = viaClass ? Array.from(before.keys()).filter((el) => owner.get(el) === c) : mine;
        for (const el of parts) {
          const cs = look(el);
          peak.set(el, PROPS.map((p) => cs.getPropertyValue(p)));
        }
        for (const el of parts) {
          if (restless.has(el)) continue;
          const b = before.get(el)!;
          const pk = peak.get(el)!;
          const up = el.parentElement ? peak.get(el.parentElement) : undefined, upB = el.parentElement ? before.get(el.parentElement) : undefined;
          const props: [string, string][] = [];
          PROPS.forEach((p, i) => {
            const now = pk[i];
            if (now === b[i]) return;
            // inherited from a parent that changed the same way (text colour, visibility): the parent's rule does it
            if (/^(color|visibility|letter-spacing)$/.test(p) && up && upB && up[i] === now && upB[i] === b[i]) return;
            if (p === "width") {
              // a line drawing in — only where the script set the width itself (children of something that
              // grew follow its width): what it wrote when that was a percentage, else the size it reached
              const inl = (el as HTMLElement).style?.width || "";
              if (inl) props.push([p, /%$/.test(inl) ? inl : now]);
            } else props.push([p, now]);
          });
          if (props.length) changed.push({ el, props });
        }
        if (!changed.length || changed.length > 30) continue;
        const id = `h${++n}`;
        c.setAttribute(HOV_ATTR, id);
        const span = Math.max(0, (lastOf.get(c) || t1) - t1);
        changed.forEach((ch, k) => {
          const tid = `${id}-${k + 1}`;
          ch.el.setAttribute(HOVT_ATTR, tid);
          const sel = ch.el === c ? `[${HOV_ATTR}="${id}"]:hover` : `[${HOV_ATTR}="${id}"]:hover [${HOVT_ATTR}="${tid}"]`;
          hoverCss.push(`@media (hover: hover) { ${sel} { ${ch.props.map(([p, v]) => `${p}: ${v} !important;`).join(" ")} } }`);
          // its own CSS transition plays it when a class did it; a script's tween gets one as long as it took
          const cs = getComputedStyle(ch.el);
          const tdur = secs(cs.transitionDuration), tprop = cs.transitionProperty.split(",").map((x) => x.trim());
          const covered = (p: string) => tprop.some((tp, i) => (tp === "all" || tp === p) && (tdur[i % tdur.length] || 0) > 0);
          const own = ch.props.filter(([p]) => !covered(p)).map(([p]) => p);
          if (own.length) {
            const d = Math.max(180, Math.min(1200, Math.round(span || 400)));
            const keep = tprop.map((tp, i) => ((tdur[i % tdur.length] || 0) > 0 ? `${tp} ${cs.transitionDuration.split(",")[i % tdur.length].trim()} ${cs.transitionTimingFunction.split(/,(?![^(]*\))/)[i % tdur.length]?.trim() || "ease"} ${cs.transitionDelay.split(",")[i % tdur.length]?.trim() || "0s"}` : "")).filter(Boolean);
            hoverCss.push(`[${HOVT_ATTR}="${tid}"] { transition: ${[...keep, ...own.map((p) => `${p} ${d}ms cubic-bezier(.22,1,.36,1)`)].join(", ")} !important; }`);
          }
        });
      }
      // Pointer effects: the pointer moved inside each (right of and below its middle). A part that shifts
      // toward it is magnetic (the share of the pointer's offset it follows); one that turns in 3D is tilted.
      {
        const tfBefore = new Map<Element, string>();
        for (const [el] of owner) tfBefore.set(el, getComputedStyle(el).transform);
        const offs = new Map<Element, { x: number; y: number; w: number; h: number }>();
        const tMove = performance.now();
        for (const c of batch) {
          const r = c.getBoundingClientRect();
          const o = { x: r.width * 0.3, y: r.height * 0.3, w: r.width, h: r.height };
          offs.set(c, o);
          const base = { clientX: r.left + r.width / 2 + o.x, clientY: r.top + r.height / 2 + o.y, view: window, bubbles: true, cancelable: true, composed: true };
          try {
            c.dispatchEvent(typeof PointerEvent === "function" ? new PointerEvent("pointermove", { ...base, pointerType: "mouse", isPrimary: true }) : new MouseEvent("pointermove", base));
            c.dispatchEvent(new MouseEvent("mousemove", base));
          } catch {
            /* a handler threw */
          }
        }
        await quiet(1200);
        const nums = (t: string) => (/^matrix3d\(/.test(t) ? t.slice(9, -1).split(",").map(parseFloat) : null);
        for (const c of batch) {
          const o = offs.get(c)!;
          if (o.w < 16 || o.h < 12) continue;
          let magnet: { el: Element; k: number } | null = null, tilt: { el: Element; deg: number; rest: string } | null = null;
          for (const [el, own] of owner) {
            if (own !== c || restless.has(el)) continue;
            const a = tfBefore.get(el) || "none", b = getComputedStyle(el).transform;
            if (a === b) continue;
            const m3 = nums(b);
            if (m3 && m3.length === 16) {
              const ay = (Math.asin(Math.max(-1, Math.min(1, Math.abs(m3[2])))) * 180) / Math.PI, ax = (Math.asin(Math.max(-1, Math.min(1, Math.abs(m3[6])))) * 180) / Math.PI;
              const deg = Math.max(ax, ay) / 0.6;
              if (deg > 1.5 && !tilt) {
                const bi = before.get(el);
                tilt = { el, deg: Math.min(30, deg), rest: bi ? bi[PROPS.indexOf("transform")] : "none" };
                continue;
              }
            }
            const ma = matrixNums(a), mb = matrixNums(b);
            if (ma.length !== 6 || mb.length !== 6) continue;
            const dx = mb[4] - ma[4], dy = mb[5] - ma[5];
            const ks: number[] = [];
            if (Math.abs(dx) > 1.5) ks.push(dx / o.x);
            if (Math.abs(dy) > 1.5) ks.push(dy / o.y);
            if (!ks.length) continue;
            const k = ks.reduce((x, y) => x + y, 0) / ks.length;
            if (Math.abs(k) >= 0.03 && Math.abs(k) <= 1.2 && (!magnet || Math.abs(k) > Math.abs(magnet.k))) magnet = { el, k };
          }
          const span = Math.max(150, Math.min(1200, Math.round(((lastOf.get(c) || tMove) - tMove) || 450)));
          if (magnet) {
            const id = `p${++pointerN}`;
            c.setAttribute("data-sl-magnet", magnet.k.toFixed(2));
            magnet.el.setAttribute("data-sl-pull", id);
            pointerCss.push(`[data-sl-pull="${id}"] { translate: var(--slm-mx, 0px) var(--slm-my, 0px) !important; transition: translate ${span}ms cubic-bezier(.22,1,.36,1) !important; }`);
          }
          if (tilt) {
            const id = `p${++pointerN}`;
            c.setAttribute("data-sl-tilt", tilt.deg.toFixed(1));
            tilt.el.setAttribute("data-sl-tilting", id);
            pointerCss.push(`[data-sl-tilting="${id}"] { transform: perspective(900px) rotateX(var(--slm-rx, 0deg)) rotateY(var(--slm-ry, 0deg))${tilt.rest && tilt.rest !== "none" ? " " + tilt.rest : ""} !important; transition: transform ${span}ms cubic-bezier(.22,1,.36,1) !important; }`);
          }
        }
      }
      for (const c of batch) fire(c, false);
      await quiet(1400);
      mo.disconnect();
      // put back exactly how everything looked before
      for (const [el, o0] of old) {
        if ("style" in o0) { if (o0.style == null) el.removeAttribute("style"); else el.setAttribute("style", o0.style); }
        if ("cls" in o0) { if (o0.cls == null) el.removeAttribute("class"); else el.setAttribute("class", o0.cls); }
      }
    }
    if (n) stats.hoverMotion = n;
  }

  // ── run ─────────────────────────────────────────────────────────────────────
  if (o.loadDeferred) {
    try {
      await loadDeferred();
    } catch (e) {
      warnings.push("Deferred-content pass failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  try {
    await resolveBlobImages();
    await prefetchSprites();
  } catch {
    /* non-fatal */
  }
  // Canvases after the scroll settled: a WebGL scene often glides its objects to where
  // the page now is (a 3D model that follows the sections) — snapshot it once it stops.
  try {
    await settleCanvases(3000);
    await grabCanvases();
  } catch {
    /* non-fatal */
  }
  if (o.hoverMotion && o.replayAnimations) {
    try {
      await recordHovers();
    } catch (e) {
      warnings.push("Hover effects pass failed: " + (e instanceof Error ? e.message : String(e)));
    }
    try {
      await recordCursor();
    } catch (e) {
      warnings.push("Cursor follower pass failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  // Live widgets (rotating carousels, number roll-ups, tickers) keep changing while we
  // fetch sprites and images. Take the copy in a quiet moment, not mid-transition —
  // nothing may run between this wait and the copy.
  // Timer-driven widgets get a longer budget to reach a resting moment.
  try {
    await waitQuiet(timerDriven ? 9000 : 6000);
  } catch {
    /* non-fatal */
  }
  let html = "";
  let framerAppear: CaptureResult["framerAppear"];
  const swappedBars: { el: HTMLElement; liveKids: ChildNode[] }[] = [];
  const waapiProps = new Map<Element, Set<string>>();
  const waapiEnd = new Map<Element, Map<string, string>>(); // running animations' final frame
  try {
    if (!document.documentElement) throw new Error("The document has no root element (still navigating?).");
    // put the at-the-top header content back for the duration of the (synchronous)
    // copy; the live nodes go back in the finally block before the page can notice
    for (const b of topBars) {
      if (!b.el.isConnected || barSignature(b.el) === b.sig) continue;
      const liveKids = Array.from(b.el.childNodes);
      const tpl = document.createElement("template");
      tpl.innerHTML = b.html;
      b.el.replaceChildren(tpl.content);
      swappedBars.push({ el: b.el, liveKids });
      stats.headersRestored++;
    }
    // Script-driven Web Animations hold their values in the animation, not in the
    // style attribute — a copy would snap them back (odometer digits → "0").
    waapiProps.clear();
    waapiEnd.clear();
    try {
      for (const a of document.getAnimations()) {
        if (typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) continue;
        if (typeof CSSTransition !== "undefined" && a instanceof CSSTransition) continue;
        const eff = a.effect as KeyframeEffect | null;
        const target = eff?.target;
        if (!eff || !target || eff.pseudoElement) continue;
        const props = waapiProps.get(target) || new Set<string>();
        const kfs = eff.getKeyframes();
        for (const kf of kfs)
          for (const k of Object.keys(kf)) if (!/^(offset|computedOffset|easing|composite)$/.test(k)) props.add(k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));
        if (props.size) waapiProps.set(target, props);
        // still running (or waiting out its delay) and set to hold its last frame: the copy
        // shows where it is heading, not a random in-between frame
        try {
          const ct = eff.getComputedTiming();
          const end = Number(ct.endTime), at = Number(ct.localTime ?? 0);
          if ((a.playState === "running" || a.pending) && isFinite(end) && end - at > 0 && /forwards|both/.test(String(eff.getTiming().fill)) && kfs.length) {
            const last = kfs[kfs.length - 1] as Record<string, unknown>;
            const vals = new Map<string, string>();
            for (const k of Object.keys(last)) if (!/^(offset|computedOffset|easing|composite)$/.test(k) && last[k] != null) vals.set(k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), String(last[k]));
            if (vals.size) waapiEnd.set(target, vals);
          }
        } catch {
          /* timing unavailable */
        }
      }
    } catch {
      /* getAnimations unsupported */
    }
    // Script-built DOM may nest tags that the HTML parser won't keep: a <div> inside a
    // <p> (SplitText / SplitType word and letter wrappers) closes the paragraph on
    // reload and spills the words out of it. Inline-looking ones become <span>s;
    // a real block inside makes the paragraph itself a <div>.
    for (const para of Array.from(document.querySelectorAll("p"))) {
      const bad = Array.from(para.querySelectorAll("*")).filter((d) => P_CLOSERS.test(d.tagName));
      if (!bad.length) continue;
      const blocky = bad.some((d) => { const disp = getComputedStyle(d).display; return !/^inline/.test(disp) && disp !== "contents" && disp !== "none"; });
      if (blocky) para.setAttribute(RETAG_ATTR, "div");
      else bad.forEach((d) => d.setAttribute(RETAG_ATTR, "span"));
      stats.retagged = (stats.retagged || 0) + (blocky ? 1 : bad.length);
    }
    // count-ups that dropped back (reset off screen) show the value they reached
    for (const [el, peak] of countPeak) {
      if (!el.isConnected || el.childElementCount > 0) continue;
      const now = parseFloat((el.textContent || "").replace(/[^\d.]/g, "")) || 0;
      if (peak.value > 0 && now < peak.value) el.setAttribute(COUNT_ATTR, String(Array.from(countPeak.keys()).indexOf(el)));
    }
    // the scroll pass's decisions win over re-renders that happened since
    for (const [el, d] of decidedState) {
      if (!el.isConnected) continue;
      if (el.getAttribute("class") !== d.cls) { if (d.cls === null) el.removeAttribute("class"); else el.setAttribute("class", d.cls); stats.reapplied = (stats.reapplied || 0) + 1; }
      if (el.getAttribute("style") !== d.style) { if (d.style === null) el.removeAttribute("style"); else el.setAttribute("style", d.style); stats.reapplied = (stats.reapplied || 0) + 1; }
    }
    // put back, for the copy only, the players the page removed after they were on screen
    const restored: Element[] = [];
    for (const g of goneFrames) {
      if (g.holder.isConnected || !g.parent.isConnected) continue;
      const src = g.frame.getAttribute("src");
      if (src && Array.from(g.parent.querySelectorAll("iframe")).some((x) => x.getAttribute("src") === src)) continue; // back already
      try {
        if (g.next && g.next.parentNode === g.parent) g.parent.insertBefore(g.holder, g.next);
        else g.parent.appendChild(g.holder);
        restored.push(g.holder);
      } catch {
        /* the page moved on */
      }
    }
    if (restored.length) stats.playersRestored = restored.length;
    mark(document);
    // GSAP animations made while we scrolled (ScrollTrigger.batch creates them on enter): the page-world
    // recorder (settle.ts) writes them down now, synchronously, before the copy
    try {
      document.dispatchEvent(new CustomEvent("sl-gsap-record"));
      document.dispatchEvent(new CustomEvent("sl-gl-mark")); // which canvases are 3D scenes (page-world recorder)
    } catch {
      /* no recorder on this page */
    }
    islandPick = new Set(
      Array.from(document.querySelectorAll("canvas[data-sl-gl]"))
        .map((c) => ({ c, r: c.getBoundingClientRect() }))
        .filter((x) => x.r.width >= 120 && x.r.height >= 90)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
        .slice(0, 2)
        .map((x) => x.c),
    );
    stats.widgets = markWidgets() || undefined;
    stats.heldAnimations = markHeldAnimations() || undefined;
    stats.scrollClasses = markScrollClasses() || undefined;
    // (what was watched for them — the bars and the page itself — as tag#id.class, for a look when none came out)
    const watched = clsTargets as Element[] | null;
    stats.scrollClassWatch = watched ? watched.length : 0;
    if (watched) stats.scrollClassWatched = watched.slice(0, 30).map((t) => t.localName + (t.id ? "#" + t.id : "") + (typeof t.className === "string" && t.className.trim() ? "." + t.className.trim().split(/\s+/).slice(0, 2).join(".") : "")).join(" ");
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    tidyWhitespace(document.documentElement, root);
    root.querySelectorAll(UI_SELECTOR).forEach((n) => n.remove());
    // <noscript>: the copy is the page as rendered, so its no-JavaScript fallbacks are never wanted —
    // they would show wherever scripts don't run (Studio's canvas): tracking pixels (shopify.com's
    // Facebook pixel), second copies of lazy images, "please enable JavaScript" notices
    if (o.scripts !== "keep") root.querySelectorAll("noscript").forEach((n) => n.remove());
    fixTree(root);
    // A scroll lock left on the page (a cookie dialog, menu or modal paused the smooth scroller — Lenis
    // "lenis-stopped" — or body-scroll-lock set overflow / position on <body>) would leave the copy
    // unable to scroll: the scripts that would lift it are gone. Lift it in the copy.
    {
      const LOCK = /^(lenis-stopped|lenis-scrolling|no-?scroll|scroll-?lock(ed)?|is-locked|is-scroll-locked|overflow-hidden|modal-open|menu-open|is-menu-open|nav-open|is-nav-open|has-modal|w--nav-menu-open)$/i;
      for (const el of [root, root.querySelector("body")]) {
        if (!el) continue;
        const cls = el.getAttribute("class");
        if (cls && cls.split(/\s+/).some((c) => LOCK.test(c))) {
          el.setAttribute("class", cls.split(/\s+/).filter((c) => c && !LOCK.test(c)).join(" "));
          stats.scrollUnlocked = (stats.scrollUnlocked || 0) + 1;
        }
        const st = el.getAttribute("style") || "";
        if (/overflow(-y)?\s*:\s*(hidden|clip)/i.test(st) || (el.localName === "body" && /position\s*:\s*fixed/i.test(st))) {
          const kept = st.split(";").filter((d) => d.trim() && !/^\s*overflow(-[xy])?\s*:\s*(hidden|clip)/i.test(d) && !(el.localName === "body" && /^\s*(position\s*:\s*fixed|top\s*:|left\s*:|right\s*:|width\s*:\s*100%)/i.test(d)));
          if (kept.length) el.setAttribute("style", kept.join(";"));
          else el.removeAttribute("style");
          stats.scrollUnlocked = (stats.scrollUnlocked || 0) + 1;
        }
      }
    }
    // Scrolled by a script: smooth scrollers (Lenis…) scroll the window themselves, so sites often set
    // overflow: hidden / a screen-high html in their own CSS. Without those scripts the copy would be stuck
    // on its first screen: when the window really scrolled during the pass, give the copy native scrolling.
    try {
      const hc = getComputedStyle(document.documentElement), bc = document.body ? getComputedStyle(document.body) : null;
      const blocked = (c: CSSStyleDeclaration | null) => !!c && /(hidden|clip)/.test(c.overflowY);
      if (maxWindowScroll > 200 && (blocked(hc) || blocked(bc))) {
        const st = document.createElement("style");
        st.setAttribute("data-sl-native-scroll", "");
        st.textContent = `/* this page was scrolled by a script (smooth scrolling); StyleLift gives the copy native scrolling */\nhtml { overflow-y: auto !important; height: auto !important; } body { overflow-y: visible !important; height: auto !important; max-height: none !important; }\n`;
        (root.querySelector("head") || root).appendChild(st);
        stats.scrollUnlocked = (stats.scrollUnlocked || 0) + 1;
      }
    } catch {
      /* computed styles unavailable */
    }
    for (const el of restored) el.remove(); // the live page goes back to how the site left it
    const peaks = Array.from(countPeak.values());
    root.querySelectorAll(`[${COUNT_ATTR}]`).forEach((el) => {
      const p = peaks[Number(el.getAttribute(COUNT_ATTR))];
      el.removeAttribute(COUNT_ATTR);
      if (p) { el.textContent = p.text; stats.countersSet = (stats.countersSet || 0) + 1; }
    });
    // Rive / Lottie animations whose file the page declares play for real in the copy
    // (the runtimes are MIT, loaded from a CDN); the frozen frame stays as the fallback.
    stats.liveAnimations = wireLiveAnimations(root);
    // rename what the parser would otherwise break apart (see above)
    root.querySelectorAll(`[${RETAG_ATTR}]`).forEach((el) => {
      const tag = el.getAttribute(RETAG_ATTR) || "span";
      el.removeAttribute(RETAG_ATTR);
      const n = document.createElement(tag);
      for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
      while (el.firstChild) n.appendChild(el.firstChild);
      el.replaceWith(n);
    });
    const head = root.querySelector("head") || root;

    // adopted stylesheets on the document itself
    try {
      for (const s of Array.from(document.adoptedStyleSheets || [])) {
        const st = sheetToStyle(s, location.href);
        if (st) {
          st.setAttribute("data-sl-adopted", "");
          head.appendChild(st);
          stats.adoptedSheets++;
        }
      }
    } catch { /* ignore */ }

    // scripts / hints
    if (o.scripts === "strip") {
      root.querySelectorAll("script").forEach((s) => {
        if ((s.getAttribute("type") || "") === "application/ld+json") return;
        if (s.hasAttribute("data-sl-anim-runtime")) return; // StyleLift's own animation loader
        s.remove();
        stats.scriptsStripped++;
      });
      root.querySelectorAll("link").forEach((l) => {
        const rel = (l.getAttribute("rel") || "").toLowerCase();
        if (/\b(modulepreload|preload|prefetch|prerender|dns-prefetch|preconnect)\b/.test(rel)) l.remove();
      });
      root.querySelectorAll("*").forEach((el) => {
        for (const a of Array.from(el.attributes)) if (/^on[a-z]+$/i.test(a.name)) el.removeAttribute(a.name);
      });
    } else {
      root.querySelectorAll("script[src]").forEach((s) => s.setAttribute("src", abs(s.getAttribute("src") || "")));
    }
    if (scrubCssRules.length) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-scroll-frames", String(scrubCount));
      st.textContent = scrubCss();
      head.appendChild(st);
    }
    if (pinned.length) {
      // pinned at the very top (the pin starts at scroll 0): the page had it fixed when copied — it sits at
      // the top of its spacer instead, and the scroll timeline holds it from there
      root.querySelectorAll<HTMLElement>(`[${PIN_ATTR}]`).forEach((el) => {
        el.removeAttribute("data-sl-pin");
        if (el.style.position === "fixed") {
          el.style.position = "absolute";
          el.style.top = "0px";
          el.style.left = "0px";
        }
      });
      const st = document.createElement("style");
      st.setAttribute("data-sl-pinned", String(pinned.length));
      st.textContent = pinCss();
      head.appendChild(st);
    }
    if (varPlays.length) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-scroll-vars", String(varPlays.length));
      st.textContent = varCss();
      head.appendChild(st);
    }
    if (linked.length) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-scroll-linked", String(linked.length));
      st.textContent = linkedCss();
      head.appendChild(st);
      stats.scrollLinked = linked.length;
    }
    if (reveals.length || cloneReveals) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-scroll-reveal", `${reveals.length + cloneReveals} elements, ${revealKinds.size} animations`);
      st.textContent = revealCss();
      head.appendChild(st);
      stats.scrollReveals = reveals.length + cloneReveals;
    }
    // Webflow interactions converted from the page's own interaction data (settle.ts): hover and scroll CSS
    {
      const wf = root.getAttribute("data-sl-wf-css");
      root.removeAttribute("data-sl-wf-css");
      if (wf) {
        const st = document.createElement("style");
        st.setAttribute("data-sl-webflow-motion", "");
        st.textContent = `/* The page's Webflow Interactions, converted by StyleLift from their own data: hover effects\n   with Webflow's in / out timings, scroll-linked keyframes. */\n@media (prefers-reduced-motion: no-preference) {\n${wf}\n}\n`;
        head.appendChild(st);
      }
    }
    root.querySelectorAll("[data-sl-exited]").forEach((el) => el.removeAttribute("data-sl-exited"));
    root.querySelectorAll("[data-sl-cursor-rest]").forEach((el) => {
      const v = el.getAttribute("data-sl-cursor-rest") || "";
      el.removeAttribute("data-sl-cursor-rest");
      if (v) el.setAttribute("style", v);
      else el.removeAttribute("style");
    });
    if (pointerCss.length) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-pointer-motion", String(pointerN));
      st.textContent = `/* Pointer effects the page ran with scripts, recorded by StyleLift: parts pulled toward the pointer\n   (magnetic), tilted by it, cursor followers. The trigger script sets the --slm-* values from the pointer. */\n${pointerCss.join("\n")}\n`;
      head.appendChild(st);
      stats.pointerEffects = pointerN;
    }
    if (hoverCss.length) {
      const st = document.createElement("style");
      st.setAttribute("data-sl-hover-motion", String(stats.hoverMotion || 0));
      st.textContent = `/* Hover effects the page ran with scripts, recorded by StyleLift: the look each part reached and\n   how long it took, replayed with CSS :hover (only where there's a real pointer). */\n@media (prefers-reduced-motion: no-preference) {\n${hoverCss.join("\n")}\n}\n`;
      head.appendChild(st);
    }
    // GSAP animations written down before they were fast-forwarded (settle.ts): replayed with CSS
    {
      const g = gsapCss(root);
      if (g.css) {
        const st = document.createElement("style");
        st.setAttribute("data-sl-gsap-motion", `${g.reveals} entrances, ${g.loops} loops`);
        st.textContent = g.css;
        head.appendChild(st);
        stats.gsapMotion = g.reveals + g.loops;
      }
    }
    // Framer responsive variants: each .ssr-variant carries hidden-<hash> classes and
    // a server-rendered <style data-framer-breakpoint-css> hides them per width. The
    // runtime deletes that style once it hydrates (it keeps only the matching variant),
    // so a copy that later gains the other widths' variants would show them all.
    // Rebuild the rules from the breakpoint table Framer leaves in the page.
    {
      const bpEl = document.getElementById("__framer__breakpoints");
      const hasRules = !!root.querySelector("style[data-framer-breakpoint-css]");
      if (bpEl && bpEl.textContent && !hasRules) {
        try {
          const table = JSON.parse(bpEl.textContent) as { hash?: string; mediaQuery?: string }[];
          const rules = table
            .filter((b) => b && typeof b.hash === "string" && /^[\w-]+$/.test(b.hash) && typeof b.mediaQuery === "string" && !/[{}<]/.test(b.mediaQuery))
            .map((b) => `@media ${b.mediaQuery} { .hidden-${b.hash} { display: none !important; } }`);
          if (rules.length) {
            const st = document.createElement("style");
            st.setAttribute("data-framer-breakpoint-css", "");
            st.setAttribute("data-sl-restored", "");
            st.textContent = rules.join("\n");
            head.appendChild(st);
          }
        } catch {
          /* malformed table: leave as is */
        }
      }
    }
    // Framer appear-animation data: returned raw, compiled to CSS on the panel side
    // (this function is injected by source text, so it can't import a compiler).
    if (o.replayAnimations) {
      const appear = document.getElementById("__framer__appearAnimationsContent");
      if (appear && appear.textContent) {
        const bps = document.getElementById("__framer__breakpoints");
        framerAppear = { json: appear.textContent, breakpoints: bps?.textContent || undefined };
      }
    }
    root.querySelectorAll("meta[http-equiv]").forEach((m) => {
      if (/refresh/i.test(m.getAttribute("http-equiv") || "")) m.remove();
    });
    root.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
    // Nav/menu state that framework JS toggles during our scroll pass: strip the
    // open-state markers so the captured copy doesn't freeze menus in their opened state.
    // Framework classes that JS handlers toggle while we scroll (Webflow w--open,
    // custom-menu open markers). Replace-once per class, no /g test() lastIndex trap.
    const OPEN_CLASS_RE = /\b(w--open|w--nav-dropdown-open|w--nav-menu-open|mm-dropdown--open|is-open|menu-open|nav-open|is-active-nav)\b/g;
    root.querySelectorAll("[class]").forEach((el) => {
      const cls = el.getAttribute("class") || "";
      if (OPEN_CLASS_RE.test(cls) || cls.match(OPEN_CLASS_RE)) {
        const next = cls.replace(OPEN_CLASS_RE, "").replace(/\s+/g, " ").trim();
        if (next !== cls) el.setAttribute("class", next);
      }
      OPEN_CLASS_RE.lastIndex = 0;
      if (el.getAttribute("aria-expanded") === "true" && /nav|menu|dropdown/i.test(cls)) el.setAttribute("aria-expanded", "false");
    });
    // Also reset style attrs animation libs leave (e.g. Webflow sets inline display on open menus)
    root.querySelectorAll("nav [style*='display: block'], nav [style*='display:block']").forEach((el) => {
      const s = (el.getAttribute("style") || "").replace(/display\s*:\s*block\s*;?/i, "").trim();
      if (s) el.setAttribute("style", s); else el.removeAttribute("style");
    });
    if (o.stripCookieBanners) {
      for (const el of [root, root.querySelector("body")]) {
        if (!el) continue;
        for (const c of Array.from(el.classList)) if (/consent|cookie|cc--|modal-open|no-scroll|scroll-lock/i.test(c) && stats.bannersRemoved) el.classList.remove(c);
        if (!el.classList.length) el.removeAttribute("class");
      }
    }
    root.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));

    // Ensure an ABSOLUTE <base>: SPAs ship relative ones (<base href="/">) that
    // would resolve against the filesystem once the capture is saved to disk.
    const existingBase = root.querySelector("base");
    if (existingBase) {
      if (!/^https?:/i.test(existingBase.getAttribute("href") || "")) existingBase.setAttribute("href", document.baseURI);
    } else {
      const base = document.createElement("base");
      base.href = document.baseURI;
      head.insertBefore(base, head.firstChild);
    }
    if (!root.querySelector("meta[charset]")) {
      const m = document.createElement("meta");
      m.setAttribute("charset", "utf-8");
      head.insertBefore(m, head.firstChild);
    }
    // provenance (a <meta> survives re-serialization by DOMParser-based builders)
    root.querySelectorAll('meta[name="generator"][content^="StyleLift"]').forEach((m) => m.remove());
    const gen = document.createElement("meta");
    gen.setAttribute("name", "generator");
    gen.setAttribute("content", `StyleLift capture of ${location.href} on ${new Date().toISOString()}`);
    head.insertBefore(gen, head.firstChild);
    html = "<!doctype html>\n" + root.outerHTML;
  } finally {
    for (const sw of swappedBars) sw.el.replaceChildren(...sw.liveKids);
    unmark();
    for (const r of reveals) { r.el.removeAttribute(REVEAL_ATTR); r.el.removeAttribute(TL_USE_ATTR); } // leave the live page untouched
    document.querySelectorAll("[data-sl-gsap], [data-sl-gsap-loop], [data-sl-wfs], [data-sl-pin], [data-sl-pinned], [data-sl-hov], [data-sl-hovt], [data-sl-magnet], [data-sl-pull], [data-sl-tilt], [data-sl-tilting], [data-sl-cursor], [data-sl-cursor-rest], [data-sl-gl], [data-sl-exited], [data-sl-tabs], [data-sl-paddle], [data-sl-scroller], [data-sl-media], [data-sl-media-v], [data-sl-media-ui], [data-sl-scroll-classes], [data-sl-hold], [data-sl-var]").forEach((e) => { for (const a of ["data-sl-gsap", "data-sl-gsap-loop", "data-sl-wfs", "data-sl-pin", "data-sl-pinned", "data-sl-hov", "data-sl-hovt", "data-sl-magnet", "data-sl-pull", "data-sl-tilt", "data-sl-tilting", "data-sl-cursor", "data-sl-cursor-rest", "data-sl-gl", "data-sl-exited", "data-sl-tabs", "data-sl-paddle", "data-sl-scroller", "data-sl-media", "data-sl-media-v", "data-sl-media-ui", "data-sl-scroll-classes", "data-sl-hold", "data-sl-var"]) e.removeAttribute(a); });
    document.documentElement.removeAttribute("data-sl-wf-css");
    document.querySelectorAll(`[${RETAG_ATTR}]`).forEach((e) => e.removeAttribute(RETAG_ATTR));
    document.querySelectorAll(`[${COUNT_ATTR}]`).forEach((e) => e.removeAttribute(COUNT_ATTR));
    document.querySelectorAll("[data-sl-lottie-src], [data-sl-lottie-json]").forEach((e) => ["src", "json", "loop", "autoplay", "renderer"].forEach((k) => e.removeAttribute(`data-sl-lottie-${k}`)));
    for (const a of timelineOf.keys()) a.removeAttribute(TIMELINE_ATTR);
    for (const l of linked) {
      // live page: back to exactly how it was
      l.el.removeAttribute(SCROLL_ATTR);
      if (l.preStyle === null) l.el.removeAttribute("style"); else l.el.setAttribute("style", l.preStyle);
    }
  }
  if (stats.crossOriginSheets) {
    warnings.push(`${stats.crossOriginSheets} stylesheet(s) could not be read from the CSSOM (cross-origin CDN) and stay linked; project/single-file exports download them.` + (sheetErrors.length ? ` First: ${sheetErrors[0]}` : ""));
  }
  // Self-diagnosis: what a user needs to know without a developer in the loop.
  const textLen = (document.body?.innerText || "").replace(/\s+/g, " ").length;
  const imgsOk = stats.images === 0 ? 1 : stats.imagesLoaded / stats.images;
  if (textLen < 200 && document.title) warnings.push("Very little text was captured — the page may be rendered by scripts and need 'Keep scripts' to look right offline, or it served an anti-bot challenge.");
  if (imgsOk < 0.5 && stats.images > 4) warnings.push(`Only ${stats.imagesLoaded} of ${stats.images} images finished loading in the budget; raise 'Load lazy content' time, or re-run — captured <img src> is still absolute so exports will fetch them.`);
  if (stats.sheets === 0 && stats.crossOriginSheets === 0 && textLen > 100) warnings.push("No stylesheets were serialized — the page may use only linked CDN CSS; exports inline those.");
  if (stats.canvases > 0 && canvasErrors) warnings.push(`${canvasErrors} <canvas> element(s) could not be captured (WebGL / tainted cross-origin). Those regions stay blank in a static copy.`);
  const errorPage = location.protocol === "chrome-error:" || !!document.querySelector("#main-frame-error, body.neterror");
  if (errorPage) warnings.push("This is the browser's own error page — the site did not load (offline, DNS or blocked). Reload the page and capture again.");
  // a bot wall shows its challenge; an invisible reCAPTCHA behind a form (BBC, most news sites) isn't one
  const shownChallenge = Array.from(document.querySelectorAll<HTMLElement>("iframe[src*='captcha' i], iframe[src*='challenge' i], #px-captcha")).some((f) => {
    const r = f.getBoundingClientRect();
    return r.width >= 250 && r.height >= 60 && getComputedStyle(f).visibility !== "hidden";
  });
  if (shownChallenge || /pardon our interruption|unusual activity|are you human/i.test((document.body?.innerText || "").slice(0, 2000))) warnings.push("The page looks like a bot-check / CAPTCHA screen — the capture reflects that, not the real site.");

  document.removeEventListener("visibilitychange", onVis);
  if (wasHidden) warnings.push("This page was hidden while it was captured (its window was covered or minimized, or the display slept): Chrome slows hidden pages, so animations and late-loading content may be missing. Keep the capture window visible.");
  stats.bytes = html.length;
  stats.ms = Math.round(performance.now() - t0);
  if (DBG) stats.debug = dbgLog.join("\n");
  (stats as unknown as { quality: number }).quality = errorPage ? 0 : Math.round(100 * (
    0.35 * (textLen > 100 ? 1 : textLen / 100) +
    0.25 * imgsOk +
    0.15 * (stats.sheets + stats.crossOriginSheets > 0 ? 1 : 0) +
    0.15 * (stats.scriptsStripped > 0 || textLen > 500 ? 1 : 0) +
    0.10 * (warnings.length === 0 ? 1 : Math.max(0, 1 - warnings.length * 0.2))
  ));
  return { html, url: location.href, title: document.title, stats, warnings, framerAppear, needsScreenshot: needsShot.length ? needsShot : undefined, shotBoxes: Object.keys(shotBoxes).length ? shotBoxes : undefined };
}
