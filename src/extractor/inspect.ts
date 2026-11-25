import type { ComponentBlueprint } from "../shared/types";

/**
 * Interactive component inspector.
 *
 * Injected into the page via chrome.scripting.executeScript({ func }). Like the
 * token extractor, it is FULLY SELF-CONTAINED — all helpers are nested, the body
 * references only page globals. It returns a Promise that resolves when the user
 * clicks an element (or null on Escape).
 *
 * It measures structure and CSS; it never invents. Every value in the blueprint
 * is read from the rendered page. DeepSeek (separately) only explains it.
 */
export function pickAndInspectComponent(): Promise<ComponentBlueprint | null> {
  const SUBTREE_CAP = 600;
  const DIGEST_CAP = 28;
  const TRIGGER_CAP = 40;
  const HTML_CAP = 16000;

  // ── small color helper (kept local for self-containment) ─────────────────────
  function toHex(input: string | null | undefined): string | null {
    if (!input) return null;
    const s = input.trim().toLowerCase();
    if (!s || s === "none" || s === "transparent" || s === "currentcolor") return null;
    if (s[0] === "#") return s;
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/\s]+/).filter(Boolean);
    if (p.length < 3) return null;
    const ch = (x: string) => (x.endsWith("%") ? (parseFloat(x) / 100) * 255 : parseFloat(x));
    const r = ch(p[0]), g = ch(p[1]), b = ch(p[2]);
    if ([r, g, b].some(Number.isNaN)) return null;
    let a = 1;
    if (p.length >= 4) a = p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    if (a <= 0) return null;
    const h2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    const base = "#" + h2(r) + h2(g) + h2(b);
    return a >= 1 ? base : base + h2(a * 255);
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + node.id;
        parts.unshift(part);
        break;
      }
      const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      const parent = node.parentElement;
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
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return el.id ? `${tag}#${el.id}` : cls.length ? `${tag}.${cls.join(".")}` : tag;
  }

  // ── the deterministic blueprint builder ──────────────────────────────────────
  function build(root: HTMLElement): ComponentBlueprint {
    // deep walk that pierces open shadow roots within the subtree
    const nodes: HTMLElement[] = [];
    (function walk(r: ParentNode): void {
      if (nodes.length >= SUBTREE_CAP) return;
      if ((r as Node).nodeType === 1) nodes.push(r as HTMLElement); // the root element itself
      for (const el of Array.from(r.querySelectorAll("*"))) {
        if (nodes.length >= SUBTREE_CAP) break;
        nodes.push(el as HTMLElement);
        const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr) walk(sr);
      }
    })(root);

    // collect every @keyframes block once (cross-origin sheets are skipped)
    const keyframesMap = new Map<string, string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.constructor && rule.constructor.name === "CSSKeyframesRule") {
          const kf = rule as CSSKeyframesRule;
          if (!keyframesMap.has(kf.name)) keyframesMap.set(kf.name, kf.cssText);
        }
      }
    }

    const animations: ComponentBlueprint["animations"] = [];
    const transitions: ComponentBlueprint["transitions"] = [];
    const usedKeyframes = new Set<string>();
    const reconstructed = new Map<string, string>(); // name -> @keyframes rebuilt from WAAPI
    const techniqueSet = new Set<string>();
    const effects = new Set<string>();
    const colors = new Set<string>();
    const fonts = new Set<string>();
    const radii = new Set<string>();
    const shadows = new Set<string>();
    const gradients = new Set<string>();
    const spacing = new Set<string>();
    const cssUrls = new Set<string>(); // url() refs from background-image / mask-image
    const digests: ComponentBlueprint["digests"] = [];

    const collectUrls = (value: string): void => {
      if (!value || value === "none") return;
      for (const m of value.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) cssUrls.add(m[2]);
    };

    // dedup-aware collectors (the same animation/transition often repeats on many nodes)
    const animKeys = new Set<string>();
    const transKeys = new Set<string>();
    const ANIM_CAP = 60;
    const TRANS_CAP = 60;
    const normDur = (d: string): string => {
      if (!d) return "";
      if (d.endsWith("ms")) return Math.round(parseFloat(d)) + "ms";
      if (d.endsWith("s")) return Math.round(parseFloat(d) * 1000) + "ms";
      return d;
    };
    function pushAnimation(a: ComponentBlueprint["animations"][number]): void {
      // dedupe on name + normalized duration (a "2s" CSS read and a "2000ms" WAAPI
      // read are the same animation); hover-started ones key on name alone.
      const key = a.source === "hover" ? `hover|${a.name}` : `${a.name}|${normDur(a.duration)}`;
      if (animKeys.has(key) || animations.length >= ANIM_CAP) return;
      animKeys.add(key);
      animations.push(a);
      techniqueSet.add(
        a.source === "script"
          ? `Scripted animation (JS / Web Animations API)`
          : `Keyframe animation \`${a.name}\``,
      );
    }
    function pushTransition(t: ComponentBlueprint["transitions"][number]): void {
      const key = `${t.property}|${t.duration}|${t.timingFunction}`;
      if (transKeys.has(key) || transitions.length >= TRANS_CAP) return;
      transKeys.add(key);
      transitions.push(t);
    }

    const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    // Rebuild a @keyframes block from the Web Animations API — works even when the
    // source stylesheet is cross-origin and otherwise unreadable.
    function serializeKeyframes(name: string, frames: Keyframe[]): string {
      const body = frames
        .map((f) => {
          const offset = typeof f.offset === "number" ? `${Math.round(f.offset * 100)}%` : "from";
          const decls = Object.entries(f)
            .filter(([k]) => !["offset", "easing", "composite"].includes(k))
            .map(([k, v]) => `    ${kebab(k)}: ${String(v)};`)
            .join("\n");
          return `  ${offset} {\n${decls}\n  }`;
        })
        .join("\n");
      return `@keyframes ${name} {\n${body}\n}`;
    }

    // Pull the keyframes name out of an `animation` / `animation-name` declaration.
    function animationNameIn(decl: string): string | null {
      const explicit = decl.match(/animation-name:\s*([a-zA-Z_][\w-]*)/);
      if (explicit && explicit[1] !== "none") return explicit[1];
      const sh = decl.match(/(?:^|[;\s])animation:\s*([^;]+)/);
      if (!sh) return null;
      const cleaned = sh[1].replace(/cubic-bezier\([^)]*\)/g, "").replace(/steps\([^)]*\)/g, "");
      const TIMING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/;
      const KW = new Set(["infinite", "normal", "alternate", "alternate-reverse", "reverse", "forwards", "backwards", "both", "none", "running", "paused"]);
      for (const tk of cleaned.trim().split(/\s+/)) {
        if (!tk || /^[\d.]+m?s$/.test(tk) || /^[\d.]+$/.test(tk) || TIMING.test(tk) || KW.has(tk)) continue;
        return tk;
      }
      return null;
    }
    function durationIn(decl: string): string | null {
      const d =
        decl.match(/animation-duration:\s*([\d.]+m?s)/) ||
        decl.match(/animation:\s*[^;]*?([\d.]+m?s)/);
      return d ? d[1] : null;
    }

    const DIGEST_PROPS = [
      "display", "position", "top", "right", "bottom", "left", "z-index",
      "width", "height", "aspect-ratio", "flex", "flex-direction", "flex-wrap",
      "justify-content", "align-items", "gap", "grid-template-columns",
      "grid-template-rows", "grid-column", "grid-row", "grid-auto-flow",
      "padding", "margin", "overflow", "border", "border-radius",
      "background-color", "background-image", "color", "-webkit-text-fill-color",
      "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
      "text-transform", "box-shadow", "filter", "backdrop-filter", "mix-blend-mode",
      "mask-image", "-webkit-mask-image", "clip-path", "transform", "transform-origin",
      "perspective", "transition", "animation", "opacity", "will-change", "object-fit",
    ];
    const SKIP_VALUES = new Set([
      "none", "normal", "auto", "0px", "0s", "visible", "static", "0", "1",
      "rgba(0, 0, 0, 0)", "rgb(0, 0, 0)", "0% 0%", "stretch", "row", "nowrap",
      "0px 0px", "ease 0s", "0deg", "content-box", "border-box", "repeat",
    ]);

    for (const el of nodes) {
      const cs = getComputedStyle(el);
      const sel = cssPath(el);

      // tokens within the subtree
      const c1 = toHex(cs.color); if (c1) colors.add(c1);
      const c2 = toHex(cs.backgroundColor); if (c2) colors.add(c2);
      const fam = (cs.fontFamily.split(",")[0] || "").replace(/['"]/g, "").trim();
      if (fam) fonts.add(fam);
      for (const corner of ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]) {
        const v = cs.getPropertyValue(corner).trim();
        if (v && v !== "0px") radii.add(v);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") shadows.add(cs.boxShadow);
      for (const p of ["padding-top", "padding-bottom", "padding-left", "padding-right", "row-gap", "column-gap"]) {
        const v = cs.getPropertyValue(p).trim();
        if (v && v !== "0px" && v !== "normal" && v[0] !== "-") spacing.add(v);
      }
      const bgImg = cs.backgroundImage;
      if (bgImg && bgImg.includes("gradient(")) {
        gradients.add(bgImg);
        techniqueSet.add("Gradient fills (background-image)");
      }
      collectUrls(bgImg);
      collectUrls(cs.maskImage || cs.getPropertyValue("-webkit-mask-image"));

      // animations declared in computed style (CSS @keyframes currently applied)
      if (cs.animationName && cs.animationName !== "none") {
        const names = cs.animationName.split(",").map((x) => x.trim());
        names.forEach((name, idx) => {
          if (!name || name === "none") return;
          usedKeyframes.add(name);
          const pick = (v: string) => v.split(",").map((x) => x.trim())[idx] || v.split(",")[0]?.trim() || "";
          pushAnimation({
            selector: sel,
            name,
            duration: pick(cs.animationDuration),
            timingFunction: pick(cs.animationTimingFunction),
            iterationCount: pick(cs.animationIterationCount),
            delay: pick(cs.animationDelay),
            direction: pick(cs.animationDirection),
            fillMode: pick(cs.animationFillMode),
            source: "css",
          });
        });
      }

      // transitions — any element that declares a non-zero duration can animate.
      // (We keep `all` too; it is common and meaningful, just deduped.)
      if (cs.transitionDuration && /[1-9]/.test(cs.transitionDuration)) {
        pushTransition({
          selector: sel,
          property: cs.transitionProperty,
          duration: cs.transitionDuration,
          timingFunction: cs.transitionTimingFunction,
          delay: cs.transitionDelay,
        });
        if (/transform|opacity|filter|all/.test(cs.transitionProperty)) {
          techniqueSet.add("Interaction transitions (transform / opacity)");
        }
      }
      if (cs.willChange && cs.willChange !== "auto") {
        techniqueSet.add(`Compositor hint (will-change: ${cs.willChange})`);
      }

      // architecture + effects
      if (cs.display.includes("grid")) {
        const cols = cs.gridTemplateColumns;
        const n = cols && cols !== "none" ? cols.split(/\s+/).filter(Boolean).length : 0;
        techniqueSet.add(n ? `CSS Grid (${n}-column)` : "CSS Grid layout");
      }
      if (cs.display.includes("flex")) techniqueSet.add(`Flexbox (${cs.flexDirection})`);
      if (["absolute", "fixed"].includes(cs.position)) {
        techniqueSet.add("Layered stacking (absolute positioning + z-index)");
      }
      if (cs.position === "sticky") techniqueSet.add("Sticky positioning");
      if (cs.overflow === "hidden" && el === root) techniqueSet.add("Clipped overflow (content masking)");
      if (cs.backdropFilter && cs.backdropFilter !== "none") {
        techniqueSet.add("Backdrop blur (glassmorphism)");
        effects.add(`backdrop-filter: ${cs.backdropFilter}`);
      }
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") {
        techniqueSet.add(`Blend-mode compositing (${cs.mixBlendMode})`);
        effects.add(`mix-blend-mode: ${cs.mixBlendMode}`);
      }
      const mask = cs.maskImage || cs.getPropertyValue("-webkit-mask-image");
      if (mask && mask !== "none") {
        techniqueSet.add("Masking (mask-image)");
        effects.add(`mask-image: ${mask}`);
      }
      if (cs.clipPath && cs.clipPath !== "none") {
        techniqueSet.add("Clip-path shaping");
        effects.add(`clip-path: ${cs.clipPath}`);
      }
      if (cs.filter && cs.filter !== "none") effects.add(`filter: ${cs.filter}`);
      if (cs.transform && cs.transform !== "none") {
        if (/matrix3d|perspective|rotate3d|translate3d|rotatex|rotatey/i.test(cs.transform) || (cs.perspective && cs.perspective !== "none")) {
          techniqueSet.add("3D transforms");
        }
      }
      if (cs.aspectRatio && cs.aspectRatio !== "auto") techniqueSet.add("Intrinsic aspect-ratio");

      // curated digest for the root and "notable" nodes
      const notable =
        el === root ||
        (cs.animationName && cs.animationName !== "none") ||
        (cs.transitionDuration && /[1-9]/.test(cs.transitionDuration)) ||
        (cs.transform && cs.transform !== "none") ||
        (cs.filter && cs.filter !== "none") ||
        (cs.backdropFilter && cs.backdropFilter !== "none") ||
        (cs.mixBlendMode && cs.mixBlendMode !== "normal") ||
        ["absolute", "fixed", "sticky"].includes(cs.position) ||
        (bgImg && bgImg.includes("gradient("));
      if (notable && digests.length < DIGEST_CAP) {
        const styles: Record<string, string> = {};
        for (const prop of DIGEST_PROPS) {
          const v = cs.getPropertyValue(prop).trim();
          if (!v || SKIP_VALUES.has(v)) continue;
          if (prop === "background-image" && v === "none") continue;
          if (prop === "transform" && v === "none") continue;
          if (prop === "border" && /0px/.test(v) && /none/.test(v)) continue;
          styles[prop] = v;
        }
        if (Object.keys(styles).length) {
          digests.push({ selector: sel, label: shortLabel(el), styles });
        }
      }
    }

    // ── Web Animations API pass ──────────────────────────────────────────────
    // The single most reliable source of truth: getAnimations() surfaces CSS
    // animations, CSS transitions, AND script-driven animations (Framer Motion,
    // GSAP-via-WAAPI, element.animate()) that are running or pending right now.
    try {
      const live = (root as Element & {
        getAnimations?: (o?: { subtree?: boolean }) => Animation[];
      }).getAnimations?.({ subtree: true }) || [];
      for (const anim of live) {
        const effect = anim.effect as KeyframeEffect | null;
        if (!effect || typeof effect.getTiming !== "function") continue;
        const t = effect.getTiming();
        const targetEl = (effect as KeyframeEffect).target as Element | null;
        const sel = targetEl ? cssPath(targetEl) : root === document.body ? "body" : cssPath(root);
        const dur = typeof t.duration === "number" ? `${Math.round(t.duration)}ms` : String(t.duration ?? "");
        const ctor = anim.constructor?.name || "";

        if (ctor === "CSSTransition") {
          const prop = (anim as Animation & { transitionProperty?: string }).transitionProperty || "all";
          pushTransition({
            selector: sel,
            property: prop,
            duration: dur,
            timingFunction: String(t.easing ?? "ease"),
            delay: `${t.delay ?? 0}ms`,
          });
          techniqueSet.add("Interaction transitions (transform / opacity)");
          continue;
        }

        // CSSAnimation or a scripted Animation
        const animName =
          (anim as Animation & { animationName?: string }).animationName ||
          anim.id ||
          (ctor === "CSSAnimation" ? "css-animation" : "scripted");
        const isScript = ctor !== "CSSAnimation";
        // reconstruct keyframes from the running effect
        try {
          if (typeof effect.getKeyframes === "function") {
            const frames = effect.getKeyframes();
            if (frames.length && !keyframesMap.has(animName) && !reconstructed.has(animName)) {
              reconstructed.set(animName, serializeKeyframes(animName, frames));
            }
          }
        } catch {
          /* getKeyframes can throw on some composited effects */
        }
        usedKeyframes.add(animName);
        pushAnimation({
          selector: sel,
          name: animName,
          duration: dur,
          timingFunction: String(t.easing ?? "ease"),
          iterationCount: t.iterations === Infinity ? "infinite" : String(t.iterations ?? 1),
          delay: `${t.delay ?? 0}ms`,
          direction: String(t.direction ?? "normal"),
          fillMode: String(t.fill ?? "none"),
          source: isScript ? "script" : "css",
        });
      }
    } catch {
      /* getAnimations unsupported */
    }

    // ── @keyframes blocks (stylesheet first, WAAPI-reconstructed as fallback) ──
    const keyframes: ComponentBlueprint["keyframes"] = [];
    const emittedKf = new Set<string>();
    for (const name of usedKeyframes) {
      const css = keyframesMap.get(name) || reconstructed.get(name);
      if (css && !emittedKf.has(name)) {
        emittedKf.add(name);
        keyframes.push({ name, css });
      }
    }

    // :hover / :focus / :active rules that target something in the subtree
    const triggers: ComponentBlueprint["triggers"] = [];
    const STATE = /:(hover|focus|focus-visible|focus-within|active)\b/;
    const seenTriggers = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        if (!styleRule.selectorText || !STATE.test(styleRule.selectorText)) continue;
        const base = styleRule.selectorText.replace(/:(hover|focus|focus-visible|focus-within|active)\b/g, "");
        let matched = false;
        for (const part of base.split(",")) {
          const p = part.trim();
          if (!p) continue;
          try {
            if (root.matches(p) || root.querySelector(p)) {
              matched = true;
              break;
            }
          } catch {
            /* invalid selector fragment */
          }
        }
        if (matched && !seenTriggers.has(styleRule.selectorText)) {
          seenTriggers.add(styleRule.selectorText);
          const decl = (styleRule.style.cssText || "").trim();
          triggers.push({ selectorText: styleRule.selectorText, css: decl });

          // a :hover/:focus rule may *start* an animation — surface it + its keyframes
          const animName = animationNameIn(decl);
          if (animName) {
            usedKeyframes.add(animName);
            pushAnimation({
              selector: styleRule.selectorText,
              name: animName,
              duration: durationIn(decl) || "",
              timingFunction: "",
              iterationCount: /infinite/.test(decl) ? "infinite" : "1",
              delay: "",
              direction: "",
              fillMode: "",
              source: "hover",
            });
          }
          if (triggers.length >= TRIGGER_CAP) break;
        }
      }
      if (triggers.length >= TRIGGER_CAP) break;
    }
    if (triggers.length) techniqueSet.add("State-driven styling (:hover / :focus rules)");

    // append any keyframes referenced by trigger rules
    for (const name of usedKeyframes) {
      const css = keyframesMap.get(name) || reconstructed.get(name);
      if (css && !emittedKf.has(name)) {
        emittedKf.add(name);
        keyframes.push({ name, css });
      }
    }

    // assets within the subtree
    const imageSet = new Set<string>();
    const videoSet = new Set<string>();
    const inlineImages: ComponentBlueprint["assets"]["images"] = [];
    const seenInline = new Set<string>();
    const videoExt = /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(\?|$)/i;
    const absolutize = (u: string) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return u;
      }
    };
    const addInline = (src: string) => {
      if (inlineImages.length >= 60 || seenInline.has(src)) return;
      const m = src.match(/^data:image\/([\w+.-]+)[;,]/i);
      if (!m) return;
      const b64 = src.includes(";base64,") ? src.split(",")[1] || "" : "";
      const bytes = b64 ? Math.floor(b64.length * 0.75) : src.length;
      if (bytes < 80) return; // tracking pixel / spacer
      seenInline.add(src);
      inlineImages.push({ url: src, type: m[1].split("+")[0].toLowerCase(), inline: true, bytes });
    };
    const addUrl = (raw: string) => {
      const u = (raw || "").trim();
      if (!u || u.startsWith("#")) return;
      if (u.startsWith("data:")) {
        addInline(u);
        return;
      }
      const abs = absolutize(u);
      (videoExt.test(abs) ? videoSet : imageSet).add(abs);
    };
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const el = img as HTMLImageElement;
      if (el.naturalWidth && el.naturalWidth <= 2 && el.naturalHeight <= 2) continue;
      addUrl(el.currentSrc || el.src);
    }
    for (const v of Array.from(root.querySelectorAll("video"))) {
      const vid = v as HTMLVideoElement;
      addUrl(vid.currentSrc || vid.src);
      if (vid.poster) addUrl(vid.poster);
    }
    // SVG sprite / external image references: <use href> and <image href>
    for (const u of Array.from(root.querySelectorAll("use, image"))) {
      addUrl(u.getAttribute("href") || u.getAttribute("xlink:href") || "");
    }
    // background-image / mask-image url() references collected during the node walk
    for (const u of cssUrls) addUrl(u);

    // inline <svg> icons/illustrations (copyable markup, not a URL). Include the
    // root itself when the user clicked directly on an <svg>.
    const svgs: ComponentBlueprint["assets"]["svgs"] = [];
    const svgEls =
      root.tagName.toLowerCase() === "svg"
        ? [root]
        : Array.from(root.querySelectorAll("svg")).filter((s) => s.closest("svg") === s);
    for (const svg of svgEls) {
      if (svgs.length >= 24) break;
      let markup = svg.outerHTML;
      // outerHTML of an INLINE svg omits the namespace; a standalone .svg / data:
      // URI requires it, so inject it (and xlink if the markup uses xlink:href).
      if (!/\sxmlns\s*=/.test(markup)) {
        markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      if (/xlink:href/.test(markup) && !/xmlns:xlink\s*=/.test(markup)) {
        markup = markup.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
      }
      markup = markup.replace(/data:[^,]*,[^"')\s]{200,}/g, "data:…(truncated)");
      // keep markup valid: only truncate at a tag boundary, and close the <svg>
      if (markup.length > 24000) {
        const cut = markup.lastIndexOf("><", 24000);
        markup = markup.slice(0, cut > 0 ? cut + 1 : 24000) + "</svg><!-- truncated -->";
      }
      const label =
        svg.getAttribute("aria-label") ||
        svg.getAttribute("data-icon") ||
        svg.getAttribute("data-testid") ||
        (svg.getAttribute("class") || "").trim().split(/\s+/).find((c) => /icon|logo|illus|glyph/i.test(c)) ||
        `svg-${svgs.length + 1}`;
      svgs.push({ label, markup });
    }
    if (svgs.length) techniqueSet.add(`Inline SVG (${svgs.length} icon/illustration${svgs.length > 1 ? "s" : ""})`);

    const extOf = (url: string) => {
      const e = (url.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
      return e.length <= 5 ? e : "";
    };
    const toEntries = (set: Set<string>) => Array.from(set).map((url) => ({ url, type: extOf(url) }));

    // cleaned HTML
    const html = cleanHtml(root);

    // attach effects to techniques list (so they surface in the guide)
    for (const e of Array.from(effects).slice(0, 6)) techniqueSet.add("Effect — " + e);

    const r = root.getBoundingClientRect();
    return {
      label: shortLabel(root),
      selector: cssPath(root),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      nodeCount: nodes.length,
      html,
      techniques: Array.from(techniqueSet),
      animations,
      transitions,
      keyframes,
      triggers,
      digests,
      tokens: {
        colors: Array.from(colors),
        fonts: Array.from(fonts),
        radii: Array.from(radii),
        shadows: Array.from(shadows).slice(0, 12),
        gradients: Array.from(gradients).slice(0, 12),
        spacing: Array.from(spacing),
      },
      assets: {
        images: [...toEntries(imageSet), ...inlineImages],
        videos: toEntries(videoSet),
        svgs,
      },
    };
  }

  function cleanHtml(root: HTMLElement): string {
    const clone = root.cloneNode(true) as HTMLElement;
    for (const bad of Array.from(clone.querySelectorAll("script, noscript, style, template"))) {
      bad.remove();
    }
    // strip giant data: URIs so the markup stays readable
    for (const el of Array.from(clone.querySelectorAll("[src], [srcset], [href], [style]"))) {
      for (const attr of ["src", "srcset", "href", "style"]) {
        const val = el.getAttribute(attr);
        if (val && /data:[^,]*,.{200,}/.test(val)) {
          el.setAttribute(attr, val.replace(/data:[^,]*,[^"')\s]+/g, "data:…(truncated)"));
        }
      }
    }
    let out = clone.outerHTML;
    // collapse runs of whitespace-only text between tags
    out = out.replace(/>\s{2,}</g, "> <");
    if (out.length > HTML_CAP) out = out.slice(0, HTML_CAP) + "\n<!-- …truncated… -->";
    return out;
  }

  // ── interactive picker ───────────────────────────────────────────────────────
  return new Promise<ComponentBlueprint | null>((resolve) => {
    const prevCursor = document.body.style.cursor;
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "rgba(255,255,255,0.16)",
      border: "1px solid #f1f1f3",
      borderRadius: "3px",
      boxShadow: "0 0 0 1px rgba(0,0,0,0.25)",
      transition: "all 0.05s ease",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
    } as CSSStyleDeclaration);
    const badge = document.createElement("div");
    Object.assign(badge.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "#f1f1f3",
      color: "#18181a",
      font: "600 11px/1.4 ui-monospace, Menlo, monospace",
      padding: "2px 6px",
      borderRadius: "4px",
      top: "0",
      left: "0",
      maxWidth: "60vw",
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
    } as CSSStyleDeclaration);
    const hint = document.createElement("div");
    hint.textContent = "StyleLift — click a section to inspect · Esc to cancel";
    Object.assign(hint.style, {
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
      boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
    } as CSSStyleDeclaration);

    document.documentElement.append(overlay, badge, hint);
    document.body.style.cursor = "crosshair";

    let current: HTMLElement | null = null;

    function position(el: HTMLElement): void {
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

    function onMove(e: MouseEvent): void {
      const t = e.target as HTMLElement | null;
      if (!t || t === overlay || t === badge || t === hint) return;
      current = t;
      position(t);
    }
    function cleanup(): void {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      badge.remove();
      hint.remove();
      document.body.style.cursor = prevCursor;
    }
    async function onClick(e: MouseEvent): Promise<void> {
      e.preventDefault();
      e.stopPropagation();
      const target = (e.target as HTMLElement) || current;
      cleanup();
      if (!target || target === document.documentElement || target === document.body) {
        resolve(null);
        return;
      }
      try {
        // Bring the element into view and let scroll/entrance animations begin, so
        // getAnimations() captures motion that only runs while the section is visible.
        try {
          target.scrollIntoView?.({ block: "center", behavior: "auto" });
        } catch {
          /* scrollIntoView unavailable */
        }
        const raf =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16);
        await new Promise((r) => raf(() => raf(() => r(null))));
        await new Promise((r) => setTimeout(r, 280));
        resolve(build(target));
      } catch (err) {
        console.error("StyleLift inspect failed:", err);
        resolve(null);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}
