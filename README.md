# StyleLift

A Manifest V3 Chrome extension that **captures any website — one page or the whole site —
as an editable project** (HTML, React, Elementor, or a single self-contained file), with
lazy content loaded and animations settled, so Framer, Webflow, GSAP, React/CSS-in-JS and
shadow-DOM sites come out looking like the real thing. It also reads a website's **design
system directly from the rendered page** — colors, typography, radii, shadows, spacing, CSS variables, and asset
URLs — and turns it into a copy‑pasteable `DESIGN.md`, Tailwind v4 `@theme`, CSS variables,
and W3C design tokens. It can also **reverse‑engineer a single section or card** (including
animated ones): structure, motion mechanics, the actual code, and a replication guide.

> **The core rule:** every *value* comes from the page, never from the model. The scraper
> measures; DeepSeek (optional) only **names, describes, and explains** what was measured.
> StyleLift is fully functional with **no API key** — DeepSeek is an enrichment layer.

---

## What it does

### Page mode — full design system
Click **Extract from page** and get five tabs, all rendered deterministically from one JSON
token object, before any LLM:

- **DESIGN.md** — title, theme line, a `Name | Value | Token | Role` colors table, a
  per‑font typography section (weights / sizes / line‑height / letter‑spacing / role), and
  heuristic DO/DON'T guidelines.
- **Tailwind v4** — a `@theme { --color-…; --font-…; --radius-…; --shadow-…; --spacing-… }` block.
- **CSS Variables** — the page's real `:root` custom properties plus the extracted palette.
- **Design Tokens** — W3C design‑tokens JSON (`{"color":{…:{"$value","$type"}}}`).
- **Assets** — fonts, images, **videos** (incl. HLS/DASH manifests), and 3D models, with
  download links and image thumbnails.

A **Compact / Extended** toggle controls verbosity; **Copy** copies the active tab and
**Download .md** saves `DESIGN.<host>.md`.

### Component mode — inspect one section
Click **Inspect a component**, then click any section/card on the page. StyleLift analyzes
that subtree and gives you:

- **Guide** (`COMPONENT.md`) — architecture techniques (CSS Grid, layered stacking, clipped
  overflow, glassmorphism, blend modes, masks, 3D transforms, gradients…), a **Motion**
  section (keyframe animations, transitions, and the `:hover`/`:focus` rules that trigger
  them), a **replication** walkthrough, the tokens used, and gotchas.
- **Structure** — an indented tag/class outline of the component tree.
- **Animations** — keyframe animations, `@keyframes` blocks verbatim, transitions, and
  triggered‑state rules.
- **Code** — the cleaned `outerHTML` plus a denoised, curated CSS digest per notable node.
- **Tokens** — colors / gradients / radii / shadows / spacing scoped to just this component.

### Live edit mode — restyle any element, then export
Click **✏️ Edit element**, then click an element on the page. A property panel opens
(color, typography, spacing & shape, effects, plus raw custom CSS). Changes apply
**live** through an injected override stylesheet keyed by selector, so they:
- **survive framework re-renders** (CSS by selector re-applies automatically; a
  `MutationObserver` re-attaches the tag if the page removes it),
- **persist per-site** in `chrome.storage` and re-apply on reload (the background
  worker re-injects them on `tabs.onUpdated`),
- **export** as a clean `.css` file (`stylelift.<host>.css`).
Manage every edit from the "Edits on this site" list (reset one, or reset all).

### Get source code — one page or the whole site
Click **Get source code**. Choose **This page** or **Whole site**, then an export:

| Export | What you get |
|---|---|
| **Next.js (.zip)** | App Router project: `app/layout.jsx` (html/body attributes + title, description, icons as `metadata`), `app/page.jsx`, `app/globals.css`, `components/<Section>.jsx`, `public/assets/`. `npm run export` gives a fully static site |
| **React (.zip)** | Vite + React 19: `index.html`, `src/main.jsx`, `src/App.jsx`, `src/components/<Section>.jsx`, `src/styles/global.css`, `public/assets/` |
| **HTML (.zip)** | `index.html` + `styles.css` + `assets/` (images, fonts, media, classic scripts) — open in VS Code and edit |
| **Next.js site (.zip)** | One App Router route per crawled page (`app/<route>/page.jsx` + `page.css`), components grouped per page, shared `public/assets/`, internal links rewritten to the routes |
| **HTML site (.zip)** | `index.html`, `<path>/index.html` per page, `styles/` per page, one shared de-duplicated `assets/`; internal links rewritten so the offline copy navigates |
| **Single-file pages** | One self-contained `.html` (assets embedded as data URIs) — per page, or a zip of them for a site |
| **Elementor (.json)** | An Elementor template: each top-level section → full-width Container with an HTML widget; page CSS in the first container. Import via *Templates → Saved Templates → Import* |
| **Raw HTML / .jsx** | The captured document as-is (CDN stylesheets inlined), or the page body as one React component |

### React / Next.js code structure

The page is split into real, named components instead of one giant file:

- the "sections root" is found by descending through single-child framework wrappers
  (`#__next`, `#root`, Framer's `#main`), which stay in the page file so every CSS selector
  (`body > header`, `.app > section`) still matches;
- each section becomes `components/<Name>.jsx`, named from what the page calls it: Framer layer
  names (`data-framer-name`: *Section 0 - Hero* → `Section0Hero`), `aria-label`, ids, landmarks
  (`Header`, `Navigation`, `Footer`, `Newsletter`), then headings. Utility classes (Tailwind,
  Bootstrap, Webflow helpers) and code-like text never become names;
- a section that is most of the page is split again, recursively; tiny empty elements are inlined;
- Framer pages that ship separate desktop / tablet / phone copies get `desktop/`, `tablet/`,
  `phone/` folders, labelled from Framer's own breakpoint data;
- components are plain React with no props. In Next.js they stay Server Components unless they
  need the shadow-DOM runtime (then `"use client"` is added for that file only);
- assets that could not be downloaded (missing on the site, blocked, rate-limited) keep their live
  URLs and are listed in the project's README; downloads retry with backoff first.

The HTML→JSX converter is verified on 26 real sites: every one compiles, server-renders with zero
React warnings and keeps 100 % of its text (JSON in data attributes, SVG case, `data:` URIs in
inline styles, `!important`, form state, `<pre>` whitespace, shadow roots…).

The capture engine (`src/extractor/capture.ts`) is what makes animated / lazy sites work:

- **Deferred content first** — `loading=lazy` → eager, `data-src` lazy patterns resolved, then a
  scroll pass through the page (and any full-screen scroller) so IntersectionObserver-driven
  images and scroll/appear animations (Framer, GSAP ScrollTrigger, AOS…) actually fire, with a
  bounded wait for images to finish and for inline-style mutations to go quiet.
- **Animations settled to their final frame** — `src/extractor/settle.ts` runs in the page's main
  world right before capture and fast-forwards Web Animations / CSS transitions and every GSAP
  tween (ScrollTrigger included) to its end state, so split-text and entrance effects are never
  frozen mid-flight. Infinite loops are left alone. Before it fast-forwards a GSAP animation it
  writes down what the animation does (see *GSAP motion* below), so the copy can replay it.
- **Styles from the live CSSOM**, in cascade order — CSS-in-JS rules inserted with `insertRule`
  (styled-components, emotion, Framer) are captured, `@import`s flattened, `url()`s absolutized,
  adopted stylesheets (document + shadow roots) inlined. Nothing is duplicated.
- **Shadow DOM → declarative `<template shadowrootmode>`**, `<canvas>` → image, `<video>` without a
  poster gets one from its current frame, `<img srcset>`/`<picture>` collapse to the best candidate,
  form state is written into attributes, same-origin iframes are inlined as `srcdoc`.
- **Embedded players** (Vimeo, YouTube, Wistia…) stay embeds and keep playing wherever scripts
  run (exports, Preview, a mirror); background players get `autoplay`. Each is also pictured from
  the screen and that picture sits behind it, so Studio's artboards, which run no scripts, show
  the picture instead of an empty player. A player the site unmounts once it scrolls away is put
  back for the copy.
- **Clean by default** — scripts, inline `on*` handlers, preload hints, tracking/editor iframes and
  cookie/consent dialogs (CookieConsent, OneTrust, Cookiebot, Usercentrics, Didomi…) are stripped
  (toggle *Keep scripts* for a hydratable copy, *Remove cookie banners* to keep them). Elements an
  appear animation left at `opacity:0` are revealed (toggle *Reveal animated-in elements*), while
  hidden menus, dialogs and fixed overlays are left alone.
- **Live page is left alone** — before the scroll pass StyleLift snapshots every element's `class`
  and `style` attributes, then restores them afterwards. Site JS (Webflow nav handlers, sticky
  headers, scroll-synced show/hide) can mutate the page as we scroll; the snapshot/restore makes
  those side-effects invisible to the user. Framework open-state class names left behind
  (`w--open` and friends) are additionally stripped from the captured clone.
- **Shorthands set through CSS variables survive** — `font: var(--font_0)` (Wix, Webflow
  variables, Tailwind v4 tokens…) makes Chrome serialize the rule as empty longhands
  (`font-style: ; font-weight: ; …`), which are invalid and silently vanish from any copy built
  from `cssText`. StyleLift detects the empty longhands and re-emits the authored shorthand — from
  the CSSOM when Chrome can rebuild it, otherwise from the `<style>` element's source text (the
  case where a longhand override follows in the same block). Wix went from 84 % to 100 %, Linear
  from 94 % to 100 %.
- **Quote-aware `url()` handling** — CSS `url()`s are rewritten by a tokenizer, not a regex, so
  a `url(#id)` nested inside a `data:image/svg+xml` mask is never corrupted (angular.dev's hero
  went from 71 % to 100 %). Relative `<base href="/">` tags are made absolute.
- **WebGL canvases and `blob:` images** — canvases are read inside `requestAnimationFrame`, in the
  same frame the page draws, so WebGL buffers without `preserveDrawingBuffer` are captured.
  `blob:` image URLs (which die with the tab) become `data:` URIs. External SVG sprites
  (`<use href="/sprite.svg#icon">`) are downloaded into project exports.
- **Framer animations, as code** — Framer ships its entrance animations as JSON
  (`<script type="framer/appear">`). StyleLift compiles that into real CSS `@keyframes` on
  `[data-framer-appear-id]` elements, including per-breakpoint variants as `@media` rules. Springs
  are converted to precise CSS `linear()` easings sampled from a damped-spring curve, tweens to
  `cubic-bezier()`. The exported page replays Framer's entrance animations with no Framer runtime,
  respects `prefers-reduced-motion`, and keeps the source JSON as inert data for developers.
- **Self-diagnosis** — every capture gets a `quality` score (0-100) based on visible text, image
  load ratio, stylesheets serialized, and warnings. The panel surfaces warnings in plain language
  when the page looks like a bot-check, when few images loaded in the budget, when a cross-origin
  stylesheet could not be read, when a `<canvas>` was tainted, so a user knows whether to trust the
  capture or re-run with different options. Below a threshold the extension automatically retries
  once with scripts kept.
- **Whole site** — same-origin links (+ `/sitemap.xml`) are crawled breadth-first with a page and
  depth budget. Pages are visited in a real, visible capture window because background tabs
  throttle timers and `requestAnimationFrame`, which would freeze animations and lazy loading.

Everything you changed in the visual editor is baked into every export.

### StyleLift Studio — edit any captured page like Framer
**Edit in Studio** (in the Get source code panel) captures the page and opens it in a full-tab editor:

- **Canvas** — the page at Desktop (1440), Tablet (810) and Phone (390) side by side; zoom with
  ⌘/Ctrl + scroll or the zoom buttons; click the size you are editing.
- **Layers** — the page tree with the designer's own names (Framer layer names, aria-labels,
  landmarks, text), search, expand / collapse, hover to highlight on every artboard.
- **Properties** — Position, Size, Layout (flex / grid), Spacing, Styles (opacity, fill, radius,
  border, shadow, overflow), Transforms, Text (font, size, weight, line height, letter spacing,
  colour, alignment, case), Content, Link, Image (replace, alt, fit) and free Custom CSS. ↑/↓ nudge
  numeric values (⇧ ×10).
- **Breakpoints like Framer** — edits on Desktop apply everywhere; edits on Tablet / Phone override
  below 1200 px / 810 px. Edits compile to one stylesheet of `[data-sl-id] { … !important }` rules,
  so they beat the site's own inline styles and survive every export.
- **Editing** — double-click text to edit in place; duplicate, delete, move, hide per breakpoint,
  select parent; undo / redo (⌘Z / ⇧⌘Z); autosave to the browser (IndexedDB), project list under
  **Projects**.
- **Export** — Next.js, React (Vite), HTML project, single-file HTML or Elementor, with the edits
  baked in (ids are kept only on edited elements). Every format starts from the same page: your edits,
  added pictures and shapes, Studio animations and the site's own recorded ones, and the small trigger
  script that plays entrances as they scroll into view (Elementor gets it as a last HTML widget).
- **Preview** — opens that same page in a new tab, in a sandboxed extension page (its own private
  origin, no access to the extension), so its scripts run exactly as in the exports: the scroll-in
  trigger, Lottie / Rive players, scripts kept at capture. Its web fonts are embedded on the way (a
  private origin can't load a font from a site that doesn't allow other origins).
- **Whole sites** — *Get source code → Whole site → Edit site in Studio* crawls the site (same page
  limits as the other site exports) and opens every page in one project: a **Pages** list above Layers
  switches the canvas between pages (each keeps its own edits and undo history; only the open page is
  saved on each change), and *Export → Whole site* gives the HTML site or Next.js site with every page's
  edits baked in and the links between pages kept.
- **Moving things** — two drag modes (top bar, or press **M**): *Free move* (the default) drags any
  element anywhere: it snaps to other elements' edges and centres, the artboard's edges and centre and the
  layout-grid columns, with pink guide lines and its X / Y as it moves (⇧ locks one axis, ⌘ drags without
  snapping, arrow keys nudge 1 px, ⇧ + arrows 10 px). The move is saved as a per-breakpoint offset, so the
  page's layout stays intact. *Reorder* drops it before / after another element or inside a container (a
  blue line, the target container dashed); the Layers panel takes drops the same way. Grab anywhere inside
  the selected element to drag it — its name tag on the canvas shows what will move.
- **Aligning** — **G** shows a layout grid on every artboard (Desktop 12 columns, Tablet 8, Phone 4;
  columns, gutter and margin set per breakpoint in the Artboard panel). The selected element shows its
  margin (orange) and padding (green) with their sizes; hold ⌥ and point at another element for the
  distances between them. The Spacing section is a box editor (margin around padding, each side its own
  field). Drag any number field's label sideways to change it.
- **Artboard height** — drag the dashed fold line (or type a height in the Artboard panel, shown when
  nothing is selected) to set the screen height each breakpoint previews; widths stay fixed at 1440 /
  810 / 390 so each artboard is a true breakpoint. A page that scrolls inside a box (an app shell, like
  hashnode.com) offers *Show all of it*, which raises the screen height until the whole page shows.
- **Adding things (the toolbar, like Figma's)** — Move (V), Hand (H / hold Space), Frame (F), Rectangle
  (R), Ellipse (O), Line (L), Arrow (⇧L), Pen (P: click points, double-click / Enter to finish), Pencil
  (⇧P: freehand), Text (T: click to type, drag for a fixed width) and Image (I). Drawn things are placed
  inside the container under the pointer (it becomes their positioning box, only when that can't move
  anything already positioned in it); lines and drawings are SVG paths with an editable stroke. *Insert*
  adds ready-made widgets into the page's flow after the selection (heading, paragraph, button, link,
  image, video from a YouTube / Vimeo link or a file, divider, spacer, your own HTML). Images also
  drop in straight from Finder / Explorer onto an artboard (they land where they're dropped) or paste
  with ⌘V (a screenshot, an image copied in another app); *Replace image…* swaps an existing one.
- **Animate** — a section in the properties panel (and *Animate* in the right-click menu) gives any
  layer motion: as it **scrolls into view** or on **page load** (fade, slide up / down / left / right,
  zoom in / out, pop, blur in, flip up, rotate in, wipe, reveal, text word by word), **while
  scrolling** (tied to the scroll position), on **hover** (lift, grow, press in, tilt, dim, shadow,
  **magnetic** — pulled toward the pointer, **3D tilt** — turned toward it) or
  in a **loop** (float, pulse, spin, bounce, wiggle, sway, fade in and out), with duration, delay,
  easing (smooth, spring…), distance, a stagger so a row's items come in one after another, and
  *play every time it scrolls into view*. *Play* previews it on every artboard. Like every edit it is
  per breakpoint (e.g. *Off on Phone*). It is stored as `--slm-*` properties in the edit stylesheet
  and compiled to plain CSS (keyframes composed onto the element's own transform, so a site's
  transforms are never replaced; `prefers-reduced-motion` respected). Only *scroll into view* and
  word-by-word need a script: a ~1 KB trigger shipped with the HTML, React and Next.js exports.
  Without it everything plays on load, so nothing is ever left hidden.
- **Several layers at once** — ⇧-click (canvas or Layers) adds or removes a layer; dragging a box on
  empty space selects the outermost layers wholly inside it (⇧ adds); ⌘A selects everything next to the
  selection; Esc keeps just the first. Selected together, they move together (drag one, or the arrow
  keys), align to the box around them all (left / centre / right / top / middle / bottom, ⌥A H D W V S),
  space evenly across or down (⌃⌥H / ⌃⌥V), group or frame into one container (⌘G / ⌥⌘G, when they
  share one), duplicate, hide and delete together; any style changed in the panel applies to all.
- **Resizing** — drag the selection's edges or corners (⇧ keeps proportions, ⌥ from the centre). On text
  the side edges set its width and a corner scales the text itself (font size), like Canva.
- **Right-click menu (like Figma's)** — copy / cut / paste after / inside / to replace (a copied layer
  keeps its styles and pastes into another project too; HTML from other apps pastes cleaned), copy as
  HTML / CSS / React, select layer (everything under the pointer), select parent, move to page (site
  projects), bring to front / forward / backward / send to back, group / frame (⌘G / ⌥⌘G) and ungroup,
  add / remove auto layout (flex) and its options, grid layout, copy / paste style, reset changes,
  show / hide, lock / unlock, rename, flip, delete — each with Figma's shortcut.
- **Inspect tab** — the selected layer's code: your changes as CSS (exactly as the exports write them,
  breakpoints in their media queries), its HTML as exported, how it looks now as CSS, and React (JSX).
- **Smaller touches** — pinch or ⌘-scroll zooms around the pointer, also over the artboards; page colours
  as one-click swatches under every colour field; a CSS Grid section (columns, rows, gaps); **?** lists
  every shortcut. Everything above is saved in the page or its edit stylesheet, so every export carries it.
- **Made to be found** — one icon set across the panel and Studio (drawn for StyleLift, 24 px grid);
  layer types, breakpoints and section headings each have an icon; element actions are labelled tiles;
  text alignment and layout direction are picture choices; every icon button has a tooltip with its
  shortcut; each layer row has a show / hide eye for the breakpoint being edited.

### Animations, carried over as code
- **Entrance animations** — Framer appear data → `@keyframes` (springs as CSS `linear()`).
- **GSAP motion** — each GSAP animation on the page is recorded before it is fast-forwarded: where it
  starts (progress 0) and ends, its duration, its place in its timeline plus its stagger step, its
  easing (its own, the timeline's `defaults`, or GSAP's), and whether a scroll trigger starts it.
  The copy replays it with CSS: intros on load, scroll-triggered entrances when they come into view
  (a ~1 KB trigger shipped with every export; without it they simply play on load), endless loops
  (marquees, floating) forever. Animations GSAP creates while scrolling (`ScrollTrigger.batch`) are
  recorded too: the capture asks the recorder again after every scroll step and before the copy.
  Scrubbed timelines (tied to the scroll position) go through the scroll sampling below. An intro
  that finished before the capture started is gone from GSAP and can't be recorded.
- **Tickers moved by a script** — long strips sliding sideways inside a narrower box are timed while
  on screen during the scroll pass and looped with CSS over one repeat of their content.
- **The trigger decides "in view" by layout position** (no transforms, no clipping), so entrances
  held at their start inside a mask (text lines rising behind `overflow: hidden`) still start.
- **Intros** — *Replay the intro* (on by default) reloads the page once with a recorder attached from
  its first moment, so the opening animation (hero text rising, a loader lifting, logos fading in) is
  seen even though it finished long before the click. With GSAP loaded globally its root timeline keeps
  finished animations and the GSAP recorder reads them exactly; otherwise each element's most hidden /
  offset look and when it moved to where it rests are watched (for a class-triggered CSS transition, its
  own transition timing) and replayed on load.
- **Webflow Interactions** are converted from the page's own interaction data (`Webflow.require("ix2")`):
  hover in / out → `:hover` CSS with Webflow's timings and easings, only on the breakpoints the
  interaction runs on; page load / scroll into view → entrances; while scrolling / page scroll →
  keyframes on the scroll position.
- **Reveals set off by a class on a section** (an in-view observer, Locomotive's `is-inview`): the
  section's children are followed from that class change, the class is kept in the copy and the
  children replay their reveal. A reveal (changes once or twice, then rests) is no longer mistaken for
  scroll-linked motion (which changes at stop after stop).
- **Copies that scroll** — a scroll lock left on the page when it was captured (a paused smooth
  scroller's `lenis-stopped`, a dialog's `overflow: hidden`, `no-scroll` / `menu-open` classes) is lifted,
  and a page whose own CSS blocks native scrolling because a script scrolls it (`html { overflow:
  hidden }` + Lenis) gets native scrolling back in the copy.
- **Scroll reveals** — every element revealed while StyleLift scrolls the live page is replayed. When
  its own timing is known it plays over that time as it comes into view: a script's tween is timed
  from its frames (duration, the delay after the trigger — the stagger of letters, words, cards — and
  the curve's shape picks the easing); a reveal set off by a class or style uses its CSS transition
  (duration, per-element delay, timing function). Otherwise it is scrubbed on a CSS view timeline
  (`animation-timeline: view()`), anchored to the outermost clipping wrapper so reveals inside
  `overflow: hidden` boxes still progress. An element whose own class starts its transition (AOS's
  `aos-animate`, an `in-view` class) is looked at again once the transition ran, so it is kept shown.
- **Content that switches as you scroll** — the active item of a list lighting up, posters or
  captions taking turns: anything that changed while scrolling is sampled at every stop; one that
  turns on and off again while on screen is replayed on the scroll position.
- **Progress variables** — a script setting a variable on a section (`--progress`, `--x`) moves its
  children through CSS without touching them; their look is followed with it. And the variable itself is
  replayed: sampled at every stop of the scroll pass (from its value at the top), registered with
  `@property` (number / length / percentage / angle — only when the site's own CSS never gives it a value of
  another kind) and played on the page's scroll timeline, so everything the site's CSS draws from it follows
  exactly (apple.com's local nav sliding in on `--progress`). Only what follows the position: numbers in one
  unit, at least three values, back at the top where it began, never changing at rest.
- **Pointer effects run by scripts** — the pointer is moved inside each hoverable element: a part
  that shifts toward it is **magnetic** (its share of the pointer's offset is measured), one that
  turns in 3D is **tilted** (its angle measured); then it is moved across the page: a small element
  fixed to the screen that travels with it is a **cursor follower** (offset and lag measured). The
  copy's trigger script sets `--slm-*` values from the real pointer and CSS moves things, so the
  elements' own transforms and Studio edits are kept; Studio shows each under *Animate* with its
  strength / angle / catch-up (editable) and *Off*. With a real pointer and motion allowed only.
- **The site's bar** — scroll-tied motion in a fixed / sticky header (a logo shrinking, a progress
  line) is replayed; its menus' states never become reveals.
- **Parallax / scroll-scrubbed motion** — transforms sampled at each scroll step (including the
  starting position) are replayed on the page's scroll timeline (`scroll(root)`), matching the live
  offsets within fractions of a pixel. Only values that never change while the page is still and that
  move in one direction count — timer-driven loops and letter scrambles are excluded.
- **Reveals scrubbed by the scroll** — one that the site eases over a long stretch of scrolling (apple.com's
  hardware shots sliding together) is replayed over its own measured stretch (`--sl-rr`), not the usual
  "done a third of a screen after it comes in". A measured entrance delay is its place in the stagger of
  the block it came in with (the first of a block starts at once); an intro's delay counted from page load
  is never carried to content below the first screen.
- **Sharper images** — a 2x / 3x file the capture's screen picked (a `<picture>` source, a srcset) is
  written by its real width and the size it was shown at (`…_2x.jpg 1964w`, `sizes="982px"`), so it keeps
  its size on every screen (a bare "2x" makes a normal screen take the plain src as the 1x version: the
  same file at twice the size).
- **Apple's own fonts** — SF Pro / SF Compact / SF Mono / New York files are refused to other sites (they
  are licensed to Apple's pages only) and are not worked around: the copy's font stacks fall back to the
  system font right after them — SF itself on a Mac, iPhone or iPad. Apple's private icon glyphs (a few
  chevrons) show a stand-in character elsewhere.
- **Image-reveal curtains** — overlays that retract to uncover a photo are kept open and replayed
  from their covering state. Masks the scroll pass never saw open (empty, opaque, absolutely
  positioned blocks over an image that are built to animate) are recognised and opened too.
- **Text effects** — letters / words parked in their hidden "in view" state are shown and replay
  their entrance on scroll; script-built `<div>` word wrappers inside a `<p>` (SplitText, SplitType)
  are renamed so the HTML parser keeps the paragraph intact.
- **Counters, carousels, tickers** — timer-driven widgets are copied in a resting moment (the
  capture waits out running Web Animations, and a digit strip that rolled after scrolling keeps
  its value instead of being mistaken for a reveal). A slideshow is kept as one set: once any of its
  slides is seen changing with the page at rest, its whole block (titles, pictures, progress bars)
  stays as it is at that moment, so no two slides ever show at once.
- **Intro exits** — a tagline or loader word the intro shows and then takes away again stays hidden
  in the copy, however long the intro runs: after the page-start reload the panel waits until nothing has
  appeared or gone away for 1.5 s (bounded), and the exits are decided when the capture starts its scroll
  pass (the page's own scrolling while it loads doesn't end the watch).
- **The site's own one-shot CSS animations further down** (a gradient swiping across a headline, set off
  by a class added as it came into view) are held at their first frame and play when they come into view
  — in the copy that class is there from the start, so they would otherwise finish at page load.
- **Reveals always end shown** — one shown by a class on its block (apple.com's `staggered-start` →
  `staggered-end`) whose block kept its "before" class keeps its shown look written on itself.
- **Pictures filled only when they come near** (apple.com's `data-lazy`: a 1×1 placeholder until its
  script names the file) that a long page's quick scroll stops passed too fast are visited again after
  the pass (nearby ones together, bounded), so the copy has the real file.
- **Widgets the site's scripts ran** (no site-specific code — standard markup only):
  **tabs** (`role="tablist"` whose tabs name their panels) switch their panels in the site's own
  selected look, learned from the page (the selected tab and panel against the others: classes such
  as `current` / `is-active`, ARIA states, inline stacking), with arrow-key navigation; galleries whose
  panels sit side by side scroll to them, and their dots follow the visitor's own scrolling.
  **Previous / Next arrows** (told by their label, class — `slick-next`, `swiper-button-prev`,
  `paddlenav-arrow-next` — or glyph; layout classes like `text-left` don't count) are paired with what
  they move: a scroll strip scrolls to the next item, a slider track in a clipped frame moves by one
  slide, and the arrow at an end turns off. **Video play / pause buttons** work, and the wrappers whose
  `playing` / `paused` / `ended` classes the site's CSS reads (start and end frames over a video)
  follow the video.
- **Classes set past a scroll position** — classes the page puts on `<html>`, `<body>` or its fixed
  bars as you scroll (a local nav appearing, a header turning solid) are recorded at every stop and
  set again at the same positions. Not recorded: a class still there back at the top (a "loaded"
  flag), or one that follows the scroll direction (a header hiding on the way down).
- **Your own 3D model in place of a scene** (Studio → a live scene's layer → *Replace with your 3D model…*):
  a .glb (or a self-contained .gltf) becomes a `<model-viewer>` that keeps the layer's place, classes and
  size, with the scene's picture inside as its poster. Google's model-viewer (Apache-2.0, pinned 4.0.0, from
  a CDN — not bundled) shows it turnable with the pointer, optionally spinning (*Spin on its own*, *Let
  visitors turn it*), in Preview and in the HTML / React / Next.js / Elementor exports; in projects the model
  is a real file (`assets/models/…`, `public/assets/models/…`). *Replace with an image…* and *Use the
  picture instead* are there too.
- **Play live on the canvas** (your own 3D models) — Studio's artboards run no scripts (so editing stays safe);
  a model of yours can still be seen running there: a small frame over its spot in each artboard (Studio's
  sandboxed preview page, showing only that model). Nothing is added to the page; clicks pass through to the
  artboard; hold Alt (⌥) to turn the model with the mouse. (The site's own live scenes are seen running in
  Preview: running a whole site inside Studio next to its artboards needs more memory than an 8 GB Mac has.)
- **Readable exports** — the code is laid out to be read and worked on, without changing what renders:
  the HTML is indented by nesting (only whitespace already between tags is re-laid, and only where the
  live page's CSS collapses whitespace — so nothing moves); stylesheets have one declaration per line and
  nested rules indented; StyleLift's own trigger script ships readable (named, indented, with a header
  saying what it does) rather than minified; React / Next.js components, pages and helpers are laid out by
  Prettier (MIT — its JSX parser is Babel's; loaded only when such an export is made, bounded in time,
  a file it can't parse is kept as generated). Licence: `licenses/prettier.txt` in the extension.
- **Rive and Lottie, playing for real** — when the page names the animation file (lottie-web's
  registry, Webflow's Lottie / Rive elements, `<lottie-player>`, `data-rive-url` and similar), the
  copy loads the open-source runtime (lottie-web 5.12.2 / @rive-app/canvas 2.21.6, MIT, from a CDN)
  and plays the original file; React and Next.js exports start it after rendering. The captured
  frame stays as the fallback (offline, or a custom-coded Rive canvas that names no file).
- **Live 3D scenes in the editable exports** (*Keep 3D scenes live*, on by default) — a WebGL scene is
  drawn by the site's own code (its Three.js scene, shaders, models, mouse logic), which can't be
  rewritten as anything else; so the HTML, React and Next.js projects (from the panel and from Studio)
  keep each one **running from the site's own files**: the page-start reload notes which canvases get a
  WebGL / WebGPU context (or are handed to a worker), lists every file the page loads and keeps its
  original HTML; the export carries those files (`_3d/`), a service worker that serves them **only** to
  the scenes' frames (`sl-island-sw.js`), and a loader (`sl-islands.js`) that lays each scene's frame —
  the site's page with everything but that canvas hidden — exactly over its place in your page and
  scrolls it with the page. Whatever engine the site uses (Three.js, Babylon.js, React Three Fiber, OGL,
  PlayCanvas, Spline, raw WebGL) its own code runs, so models, shaders and interactions are the site's.
  The pointer behaves as on the site: where nothing of your page covers the scene it goes straight in
  (drag to rotate with pointer capture, clicking objects, trackpad pinch); where your content covers it,
  your content gets the click and the scene's page still feels the pointer moving (mouse-follow effects);
  the pointer used on the scene also moves through your page (its own effects); the wheel and keys over
  the scene scroll your page with the scene in step. On touch screens the page keeps its scrolling over
  a scene (taps are passed on). Moved or resized in Studio, the scene follows its stand-in (scaled,
  the pointer mapped into it). Studio's artboards show the scene's picture (dashed outline; *Use the
  picture instead* turns it off); its Preview runs the real scene at the private `.test` address.
  Limits: needs a web server at the site's root (a page opened from disk shows the pictures); the
  single-file and Elementor exports keep pictures; up to 3 scenes per page; it runs the site's actual
  code — only for sites you own or may copy. `npm run test:islands` checks it end to end.
- **3D pictures** — where a scene isn't kept live it keeps a picture (or, when it changes as you
  scroll, recorded frames that switch with the scroll position). Canvases are snapshot once their scene stops travelling; scenes drawn once that
  the page can't read back are screenshotted by the panel (only the canvas, transparent background),
  including canvases taller than the screen (shot in strips and stitched) and ones in fixed headers.
  Fixed overlays keep their at-the-top look. Background videos started by script autoplay muted.
- **Pinned sections** (GSAP ScrollTrigger `pin`) — a section held on screen while you scroll through
  it (often a gallery sliding sideways) is held the same way in the copy: GSAP's own start / end when
  the page exposes GSAP, otherwise the spacer GSAP wraps it in (its top and padding). The copy keeps the
  spacer and moves the section down by exactly what is scrolled over that stretch (a scroll timeline),
  which also works inside `overflow: hidden` wrappers where `position: sticky` would not; the motion
  inside it is sampled like any other scrubbed motion. Pins made by smooth-scroll wrappers (transform
  pins) are left to that sampling.
- **Hover effects run by scripts** — CSS `:hover` comes along with the stylesheets; effects a script
  plays when the pointer comes over something (GSAP zooming a picture on `mouseenter`, a class added on
  hover, a line drawn in by an `onmouseenter` handler) are recorded: each hoverable element (the ones
  the page listens to, noted from the start by *Replay the intro*, plus links, buttons and cards with
  parts) is sent the pointer-over events — they run the page's handlers, not its CSS — what changed in
  it is read once it settles, with how long it took, then the pointer-out events are sent and every
  style and class is put back exactly. The copy gets `:hover` rules with that look (only where there's
  a real pointer), played by the site's own CSS transition when a class did it, else one as long as the
  script's tween. Things that change by themselves (tickers, carousels) and changes outside the hovered
  element (cursor followers) are left out; Webflow hovers come from Webflow's own data instead.
- **Heroes built as a `<header>`** — a full-screen hero in a `<header>` element (its big words moving as you
  scroll) is content, not the site's bar: only a header fixed / sticky to the screen or shorter than half
  of it counts as navigation (kept as it looks at the top).
- **Words that light up as you scroll** — one of a row of words / letters that each change with the
  scroll counts as scroll-linked with two changes, when a stop caught it part way.
- **Pinned scroll stories** — inside a sticky section, steps that switch on and off as you scroll
  are sampled at every stop and replayed on the page's scroll timeline (a step that turns on and
  stays on keeps the ordinary reveal treatment).
- **Content a stylesheet holds back** — large blocks kept at `opacity: 0` by a rule that waits for
  a class (e.g. `.fl-anim section` until `.fl-in`) are shown and replay their entrance, even when
  the site never added the class during the capture.
- How the scroll pass is paced: steps of 45% of the viewport (anything up to ~55% of the screen is
  fully in view at some stop), at least ~0.3 s per stop, longer while the page is still changing or
  animating on screen; nonstop loops are ignored. On very long or heavy pages each stop gets a
  share of the time left, and the pass always reaches the bottom. A reveal is only replayed if the
  page has enough scroll left below it to finish.
- Browsers without scroll timelines show every element in its final / centred state.

### Live mirror — the real 3D scene and every interaction
**Live mirror (.zip)** (Get source code → This page) packages the site's *own* page, code and files,
so 3D scenes (three.js, React Three Fiber, Spline, raw WebGL), Rive, physics, smooth scrolling,
cursor effects and every interaction run exactly as on the original — not a picture of them.

- **How** — the panel reloads the page with a recorder attached, scrolls it like the normal
  capture so it loads its models, textures, WebAssembly and chunks, then downloads the page's
  original HTML plus every file it loaded (analytics and ad trackers left out). Files are stored
  **byte for byte**: the site's code is never edited (rewriting URLs inside code breaks code that
  parses them — Framer's `new URL(src)` — and integrity hashes).
- **Opening it — no install** — every mirror opens on any host that serves plain files: unzip it and
  drag the folder onto **Netlify Drop** (app.netlify.com/drop) for an https link in seconds, or upload
  it to Cloudflare Pages, GitHub Pages, Vercel or any web host. The service worker does all the
  serving from `mirror-manifest.json` (pages, query-string files, other hosts' files, file types, the
  "not in this mirror" page); `index.html` / `404.html` install it on a first visit, so links straight
  to deep pages work too. `npm run test:mirror-static` proves it on a plain file server, offline.
- **Serving** — `node server.mjs` (no dependencies) serves it with the right types (wasm, glb,
  ktx2, riv…), URLs with query strings, byte ranges for video, and client-side routes. A service
  worker (`site/sl-mirror-sw.js`) answers each request for one of the site's URLs, or a CDN's, with
  the stored copy *under the original URL*, so module imports and CSS `url()`s resolve as on the
  real site — including URLs the code builds at run time. A file that wasn't captured goes to the
  internet as before; offline, an image or video falls back to another stored size of the file.
  The first visit in a browser shows a one-second loader that installs the worker.
- **Verified** with the internet cut off (every domain but localhost unreachable): kivoagentic.ai
  (three.js voxel sphere, morphing as you scroll), deltacafes.com (Rive drawings, background video,
  Nuxt), dennypratama.com (scroll-driven WebGL object, Lenis), vertical.framer.media (Framer) — the
  site's own scenes render and react to the mouse and scroll; only trackers fail.
- **What doesn't come along** — anything the site's servers compute live (logins, carts,
  checkout, search, forms, live data); files the page never loaded during the capture (e.g. behind a
  click); browsers without service workers (Firefox private windows) fetch CDN files online.
- **Permission** — the mirror contains the site's actual code and assets: mirror only sites you
  own or have permission to copy. The README inside each zip says so.
- **Whole site** — under *Whole site*, **Live mirror (.zip)** visits every page (links + sitemap,
  same limits as the other site exports) in the capture window with the recorder attached. Each
  page keeps its own original HTML at its own path; scripts, models and media are shared. Links that
  spell out the site's own domain (`https://site.com/about`, common on WordPress / Shopify) stay
  inside the mirror — handled only when the site's own router didn't take the click.
- **Menu first, and honest about the rest** — with a page limit, the pages the start page links to
  (the menu: collections, about, configurators…) are visited before the sitemap's long product
  lists. An address that wasn't mirrored shows a clear "This page isn't in the mirror" page (404)
  with a link to it on the real site and the list of mirrored pages — never another page in its
  place. (An app whose HTML is an empty shell that routes in the browser still gets its shell.)
- **Make it yours** — the site's code stays untouched (that's what keeps it working); every page
  also loads `site/stylelift-custom.css` (last, so your rules win) and `site/stylelift-custom.js`
  (after the site's scripts). Restyle the whole mirror from those two files; edit page HTML
  (`site/**/index.html`) directly for text, images and links. For a fully restructured, editable
  codebase use the React / Next.js / HTML exports or the Studio instead.
- **Sites that guard their domain** — code that sends visitors back to the real domain when it isn't
  on it (vercel.com does) is held inside the mirror: a redirect back to the same page is cancelled,
  any other navigation to the site's domain opens the mirror's copy (Navigation API; link clicks are
  also caught for browsers without it).
- **Assets the code loads by name** — scripts and data files are scanned for model / texture / video
  / shader paths (`/assets/scene.glb`, `./env.hdr`, `videos/reel.mp4`) and those files are fetched
  too, so a part of a 3D scene the capture never reached still works offline. When a site's code
  picks its asset host by hostname (a CDN in production, local paths elsewhere — lusion.co does),
  `server.mjs` serves the local path from the copy saved from the CDN.
- **What else the engine handles** (each found on a real site, fixed as a general rule):
  webpack builds (Wix, Create React App, Gatsby) name their on-demand chunks from tables in the code
  — `id + "." + {id:"hash"}[id] + ".chunk.min.js"` under the build's public path — and those chunks
  are rebuilt and downloaded (Next.js's newer `static/immutable/chunks/` too); background workers a
  site starts from its full address run from the mirror's copy; the page's HTML is taken from what
  the browser itself received (a bot check that let the browser in can't refuse a second request);
  a page's own scripts and stylesheets are retried until they arrive, and a mirror still missing
  them is reported as INCOMPLETE instead of "downloaded"; GraphQL / live-data endpoints and
  marketing trackers (Attentive, Klaviyo analytics, …) are left out.
- **Any address** — the mirror doesn't depend on being at localhost: `npm run test:mirror-live`
  serves every mirror under another domain (`my-site.test`) by default, as a deployment would.
  Deployed, it needs https for the service worker (any modern host gives that).
- **Watch it run** — `node scripts/record-mirror.mjs <mirror folder> out.mp4 [--domain name]`
  records the mirror in a real GPU Chrome with the internet cut off: the cursor sweeps the first
  screen, then it scrolls smoothly to the bottom.
- **On-demand code** — bundles list the chunks they load later (popups, players, other routes):
  Vite / Nuxt / Astro / Framer `"./chunk.js"` and Next.js `static/chunks/…`. Those are downloaded
  too (up to 1,200), so a section never opened during the capture still works in the mirror.
- Tests: `scripts/verify-mirror.mjs` (`npm test`, 61 checks — layout, byte-for-byte files, the
  worker, loader, ranges, on-demand chunks, path safety, the server run for real);
  `npm run test:e2e` clicks the button, runs the mirror's `server.mjs` and checks the site's code
  runs from it without one request to the original site, including a URL built at run time;
  `npm run test:mirror-live [url …] [--pages N]` mirrors real sites (default: the four above), runs
  each mirror in Chrome with the internet cut off under another domain, fails if any file of the
  mirror doesn't load, the mirror throws new errors or shows fewer scene canvases — and with
  `--pages`, if any page of the mirror shows a different page — and writes a side-by-side report.html.

### Preview and publish — no unzipping, no server
After an export, the **Your export** card in the panel keeps it ready:

- **Preview** opens it in a new tab at a private address (`https://<site>.stylelift.test` — `.test` is
  reserved and never reaches the internet). Every request the tab makes is answered from the export held
  in the panel, through Chrome's debugger, before it leaves the browser: nothing is uploaded and nothing
  is installed. A Live mirror is answered exactly as its service worker answers on a real host (pages,
  query-string files, CDN files with CORS, byte ranges for video, the "not in this mirror" page), so the
  preview shows what publishing will show; whole-site mirrors navigate between their pages. HTML exports
  preview as static files. React / Next.js projects need a build first (use the Studio, or Vercel).
- **Your styles** (Live mirror): edit `stylelift-custom.css` in the card and *Apply* — the preview reloads
  with it, and Download again / Publish include it.
- **Publish to Netlify / Vercel** uploads the export to the user's own account and returns an https link;
  publishing again updates the same site / project (only changed files are uploaded). Vercel also builds
  React (Vite) and Next.js exports. **Push to GitHub** commits the files to a repository in the user's
  account (created on first push, private by default; a new commit on top after that).
- **Connecting** — Settings → Publishing takes a personal access token per service (*Save and test*).
  Tokens stay in `chrome.storage.local` and go only to `api.netlify.com`, `api.vercel.com` and
  `api.github.com`; there is no StyleLift server.
- Tests: `npm run test:preview` (how each request is answered, from a real mirror and an HTML export),
  `npm run test:publish` (the three clients against mock APIs: digests, updates, rate limits, lost uploads,
  refused tokens), and `npm run test:e2e` clicks Preview in the real extension and checks the site's code
  runs from the export without one request to the original site.

### Report a problem
The flag button in the panel's top bar (and a *Report this problem* link on every error) opens a short
report: the site address, the button clicked, what happened, a note, StyleLift and browser versions and
the panel log — all shown before sending, with the address and the log optional. *Send by email* opens
the user's own email app addressed to support (the full text is also copied, in case a mail app shortens
it); *Copy report* works without one. Nothing is sent by StyleLift itself. The support address is a build
setting, not code: put `VITE_SUPPORT_EMAIL=<address>` in `.env.local` next to `package.json`, then
`npm run build`. Tests: `npm run test:report`.

### Send to WordPress (Elementor)
Capture a page, click **Send to WordPress**, tick the sections you want, and they arrive in your
WordPress site as an Elementor template (Templates → Saved Templates) or a draft page.

- **The plugin** — `wordpress-plugin/stylelift-importer/` (GPL-2.0-or-later, as WordPress plugins
  are). `npm run build` zips it into the extension; Settings → WordPress links the zip. Install it
  under Plugins → Add New → Upload. It adds `GET /wp-json/stylelift/v1/status` and
  `POST /wp-json/stylelift/v1/import`, and a Tools → StyleLift Importer screen.
- **Connecting** — create an Application Password (Users → Profile), then enter the site address,
  username and that password in Settings → WordPress and click *Save and test connection*. The
  password stays in this browser and is sent only to that site.
- **What arrives** — each section becomes an Elementor container holding an HTML widget, plus one
  container with the page's styles. *Keep these styles from changing the rest of the site* scopes
  the CSS to a wrapper (page-level `html`/`body`/`:root` rules map onto it), so the theme's header
  and other content are untouched. *Copy images into the Media Library* downloads up to 60 images
  and points the markup at the copies.
- **Safety** — imports need the `unfiltered_html` capability (Administrators and Editors on single
  sites), the rule WordPress applies to raw HTML in its own editors. The plugin strips scripts,
  inline event handlers, `javascript:` links, `<base>`, `srcdoc` and embedded objects on the server.
- **Limits** — sections arrive as HTML widgets (faithful, editable as HTML), not converted into
  native Elementor widgets. Scroll animations need the page styles container imported too. The
  plugin strips scripts, so entrances arrive without the scroll-in trigger and play on load (a
  downloaded Elementor .json imported by hand keeps it).
- Tests: `npm test` runs `scripts/verify-wordpress.mjs` (scoping, section picker, PHP sanitizer and
  image import, `php -l`); `npm run test:e2e` drives the real panel against a mock WordPress.

### Responsive layouts built by JavaScript
Framer (and similar builders) often server-render only the layout for the width the page was
loaded at. StyleLift re-captures at tablet and phone widths (viewport emulation) and merges the
missing `.ssr-variant` layouts — plus only the CSS rules for classes those layouts introduce — into
the desktop capture. A layout that is still missing falls back to the one available instead of a
blank page. Known gap: components that swap to a different *component* variant with JavaScript at a
width (e.g. a Framer navigation that becomes a menu button on phones) still show their desktop
variant at that width.

### DeepSeek enrichment (optional)
Add a key in **Settings (⚙)**. Then:
- **Polish with DeepSeek** (page mode) fills DESIGN.md with evocative color names, grounded
  roles (justified by `usedOn`/`sampleSelectors`), font substitutes, and DO/DON'T guidance.
- **Explain with DeepSeek** (component mode) narrates the architecture and replication steps.

In both cases the background worker sanitizes the response against the measured data: any
color/font/value the model invents is dropped. The key is stored in `chrome.storage.local`
and only ever sent from the background worker to `api.deepseek.com`.

---

## Install & run (load unpacked)

```bash
npm install
npm run build     # tsc --noEmit && vite build  → output in dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the **`dist/`** folder
4. Click the **StyleLift** toolbar icon to open the side panel
5. Open any normal website tab → **Extract from page** or **Inspect a component**

After code changes: `npm run build`, then hit **↻** on the StyleLift card. If permissions
changed, accept the prompt.

> Use `npm run dev` for a watching build.

---

## Architecture

```
src/
  shared/types.ts          Token + blueprint + messaging contracts
  extractor/
    extract.ts             Self-contained page → DesignTokens (injected via executeScript)
    inspect.ts             Self-contained interactive picker → ComponentBlueprint
    capture.ts             Self-contained page capture engine → faithful static HTML (+ stats)
    settle.ts              Main-world helper: fast-forward WAAPI / GSAP animations before capture
    visual-editor.ts       In-page visual editor + override stylesheet
    edit.ts                Edit helpers
  panel/
    index.html / panel.css
    panel.ts               Side-panel controller (page + component modes, dynamic tabs)
    render.ts              Deterministic page renderers (the 4 tabs)
    component.ts           Deterministic component renderers (the 5 tabs)
    markdown.ts            Tiny markdown → HTML for the doc previews
    crawl.ts               Same-origin site crawl (links + sitemap, BFS, budgets) — pure logic
    project.ts             Captured HTML → HTML / React / multi-page site projects (real files)
    offline.ts             Captured HTML → single self-contained file (data URIs)
    elementor.ts           Captured HTML → Elementor template JSON
    jsx.ts / zip.ts        HTML → JSX converter, dependency-free ZIP writer
  background/
    service-worker.ts      Owns DeepSeek calls (Polish + Explain); opens the side panel
  options/                 Settings page (API key + model)
public/manifest.json       MV3 manifest (copied to dist/)
public/icons/              Generated icons
```

- **No bundled content script.** Both extractors are *self-contained functions* injected on
  demand with `chrome.scripting.executeScript({ func })`, so the panel and extraction logic
  share types but the injected code closes over nothing but page globals.
- **Permissions:** `activeTab`, `scripting`, `sidePanel`, `downloads`, `storage`, `debugger`,
  and broad `host_permissions` (`http://*/*`, `https://*/*`). Broad host access is required
  because the side panel persists across tab switches/navigations, where the momentary
  `activeTab` grant does not apply; the `https://*` entry also covers the worker's `fetch` to
  DeepSeek. `downloads` saves every export: a long export outlives the click that started it,
  and Chrome then blocks a page's further downloads ("This site is attempting to download
  multiple files"); the downloads API isn't subject to that.
- Restricted pages (`chrome://`, the Web Store, `view-source:`) can't be inspected — a
  browser rule no extension can bypass; the panel shows a clear message.

---

## Tests

All tests run the **real shipped code** (bundled with esbuild), no mocks of the logic.

```bash
npm test            # jsdom: token pipeline (48 checks) + component inspector (38 checks)
npm run test:tokens
npm run test:component
npm run test:site                                  # jsdom: crawl + site project + Elementor (40 checks)
npm run test:studio                                # jsdom: Studio model — ids, breakpoint CSS, export (16 checks)
node scripts/verify-variants.mjs                   # jsdom: responsive layout merge (10 checks)
npm run test:live              [url …]            # real headless Chrome: page extraction
npm run test:live-capture      [--no-real] [url …] # real headless Chrome: capture engine (synthetic page
                                                   #   + framer.com, gsap.com, webflow.com by default)
node scripts/verify-live-component.mjs [url] [sel] # real headless Chrome: component picker
npm run test:e2e                                   # loads dist/ into Chrome for Testing and clicks through
                                                   #   the real side panel: HTML project, Elementor, site crawl
```

- `scripts/verify-frameworks.mjs` (`npm run test:frameworks`) is the end-to-end proof for the
  code exports: it captures a real site, generates the React and Next.js projects with the shipped
  builders, runs the **real** `vite build` and `next build` (static export), serves the output and
  pixel-compares it with the capture, top of page and further down. Needs
  `FW_NODE_MODULES=/path/to/node_modules` with react, react-dom, vite, @vitejs/plugin-react and
  next. Verified: vertical.framer.media, framer.com, linear.app, tailwindcss.com, Wikipedia and
  lfs.org.uk — 12/12 builds pass, 99.8–100 % identical to the capture, zero runtime errors.
- `scripts/verify-e2e.mjs` needs Chromium / Chrome for Testing (`npx @puppeteer/browsers install
  chrome@stable`, or `CHROME=/path/to/binary`) — Google Chrome ≥ 137 no longer accepts
  `--load-extension`. It opens the built side panel as a tab, drives the buttons, and inspects the
  downloaded zips/JSON.
- `scripts/verify-live-capture.mjs` and `scripts/verify-fidelity.mjs` inject `capturePage` and
  `settleAnimations` **from their source text only**, exactly like
  `chrome.scripting.executeScript({ func })`, so a helper accidentally referenced from module
  scope fails the tests instead of failing silently in the shipped extension.
- `scripts/verify-site.mjs` checks URL normalization, link + sitemap discovery, the bounded BFS
  crawl (stub capture), the multi-page project builder (per-page folders, shared assets, rewritten
  internal links, localized scripts) and the Elementor template shape.
- `scripts/verify-live-capture.mjs` serves a synthetic page (lazy images, IntersectionObserver
  appear-animation, CSSOM-only rules, adopted stylesheets, shadow root, canvas, form state,
  same-origin iframe) and asserts every capture feature precisely, then captures real Framer, GSAP
  and Webflow home pages and checks: no scripts left, ≥80 % of images loaded, every `<img>` has an
  absolute `src`, styles serialized once, no editor/tracking frames.

- `scripts/verify.mjs` builds a synthetic page and asserts color normalization, CSS‑var
  mapping, the type scale, radii/shadow parsing, video/asset categorization, all four page
  renderers, and the enrichment merge.
- `scripts/verify-component.mjs` builds an animated card, drives the **real** picker by
  dispatching a click, and asserts technique detection, animations/transitions/keyframes,
  `:hover` trigger matching, scoped tokens, cleaned HTML, and all component renderers.
- The `*-live*` scripts launch the system Chrome over the DevTools Protocol and run the exact
  injected functions against real URLs (verified on stripe.com, tailwindcss.com, clerk.com).

---

## Fidelity

Each release runs `npm run test:fidelity` against 18 real sites covering the main site stacks:
Shopify (allbirds.com), Next.js (vercel.com, stripe.com), Nuxt (nuxt.com), Angular (angular.dev),
Lit (lit.dev), Shoelace (web-components), Tailwind docs, three.js, Wikipedia, GitHub, Apple, BBC,
Notion, Framer (framer.com), Webflow (webflow.com), GSAP (gsap.com), WordPress (lfs.org.uk). Per
site it screenshots the live page before capture, runs the capture, opens the captured HTML,
screenshots that, and reports the percentage of pixels that match. A diff image is saved per site.

Current baseline: **17 of 18 sites pass at ≥ 85 % visual fidelity**, and 14 of 18 exceed 95 %. The
one site below bar — angular.dev — relies on a WebGL shader background in its hero that needs the
page's shader scripts to render. "Keep scripts" plus an online connection restores it.

## Known limits
- Cross‑origin `<iframe>` embeds (YouTube/Vimeo players) stay as live embeds; cross‑origin
  `<canvas>` (tainted) can't be read.
- Captures are **static**: JS‑driven *interactions* (menus, carousels, hover effects written in
  JS) need *Keep scripts* and an online connection, or the **Live mirror**, which runs the site's
  own code; CSS animations/transitions always travel.
- Whole‑site capture follows same‑origin links only (no auth‑gated pages unless you're logged in
  in that browser) and runs sequentially — budget roughly 5–10 s per page.
- The Elementor export reproduces the page inside HTML widgets; it does not convert markup into
  native Elementor widgets.
- Firefox/Safari are not supported.
- Very heavy pages (wix.com: ~35 MB, 8 WebGL scenes) can keep the panel busy for minutes while an
  export is packaged — a known performance item to profile on a faster machine.
- A Live mirror runs on another address, and a page can't fake its own address: code that checks the
  hostname itself (Stripe's link builder, Wix's page router) can lose that one feature in a mirror,
  while the page, its content and its animations still run. Redirects back to the real domain ARE
  caught (see "Sites that guard their domain").
- Timer-driven widgets (rotating heroes, carousels, testimonial sliders) are copied at one moment:
  the copy shows one slide, not the rotation.
- Steps of a pinned scroll story are replayed only if they changed while StyleLift scrolled the
  page; a site whose steps only follow real wheel input (or a very slow 3D page) keeps its first
  step.
- WebGL drawings that can't be read back (Rive, scenes drawn once) are filled in by the panel's
  screenshot step, so they need the extension (the headless test harness shows them blank).

## Licensing note (for distribution)
StyleLift's capture engine was written from scratch. Techniques were studied from
[SingleFile](https://github.com/gildas-lormeau/SingleFile) (AGPL‑3.0) and the Elementor template
format from [Elementor](https://github.com/elementor/elementor) (GPL‑3.0), but **no code from
either project is included** — bundling AGPL/GPL code into a paid, closed‑source extension would
require releasing StyleLift under the same license (or a commercial license from the authors).
[Website‑Code‑Extractor](https://github.com/lyfe691/Website-Code-Extractor) is MIT.
The WordPress plugin in `wordpress-plugin/` is a separate program licensed GPL‑2.0‑or‑later, like
WordPress plugins generally; the extension talks to it only over its REST API.
