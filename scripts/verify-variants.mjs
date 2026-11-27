// Responsive-variant merge (Framer ssr-variant): add tablet/phone layouts captured at
// narrower widths, carry their CSS, never duplicate, and un-hide lone variants.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "sl-var-"));
await build({ entryPoints: { v: "src/panel/variants.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const { mergeVariantCaptures, unhideLoneVariants, needsVariantCapture, needsWholeLayout, addWholeLayout, ensureBreakpointRules } = await import(pathToFileURL(join(outdir, "v.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const page = (variants, css = "") => `<!doctype html><html><head><style>.base{}</style>${css}</head><body><div id="main" data-framer-hydrate-v2="{}"><main data-framer-name="Main">${variants}</main></div></body></html>`;

const desktop = page(`<div class="ssr-variant hidden-tab hidden-ph"><section data-framer-name="Hero">Desktop hero</section></div>`);
const tablet = page(`<div class="ssr-variant hidden-desk hidden-ph"><section data-framer-name="Hero" class="tablet-only">Tablet hero</section></div>`, `<style>.base{display:none}.tablet-only{color:red}@media (max-width:900px){.tablet-only{font-size:3px}.base{opacity:0}}@font-face{font-family:T;src:url(t.woff2)}</style>`);
const phone = page(`<div class="ssr-variant hidden-desk hidden-tab"><section data-framer-name="Hero" class="phone-only">Phone hero</section></div>`, `<style>.phone-only{color:blue}</style>`);
ok(needsVariantCapture(desktop) && !needsVariantCapture("<div class='x'></div>"), "detects Framer responsive variants");
const m = mergeVariantCaptures(desktop, [tablet, phone]);
const d = new dom.window.DOMParser().parseFromString(m.html, "text/html");
const vs = [...d.querySelectorAll("main > .ssr-variant")];
ok(m.added === 2 && vs.length === 3, `tablet + phone variants added beside the desktop one (${vs.length})`);
ok(vs.map((v) => v.textContent.trim()).join("|") === "Desktop hero|Tablet hero|Phone hero", "in Framer's order");
ok(/\.tablet-only\{color:red\}/.test(m.html) && /\.phone-only/.test(m.html) && m.styles === 2, "CSS only the narrower layouts use is carried over");
ok(!/\.base\{display:none\}/.test(m.html) && !/\.base\{opacity:0\}/.test(m.html), "rules for desktop selectors are NOT carried over (no overriding the desktop layout)");
ok(/@media \(max-width:900px\)\{\.tablet-only\{font-size:3px\}\s*\}/.test(m.html) && /@font-face\{font-family:T/.test(m.html), "media-scoped rules filtered inside their @media; new fonts kept");
const again = mergeVariantCaptures(m.html, [tablet, phone]);
ok(again.added === 0 && (again.html.match(/ssr-variant/g) || []).length === 3, "never duplicates a variant that's already there");
// the parent component carries a per-width variant class in each capture
const navD = `<!doctype html><html><head></head><body><div id="main" data-framer-hydrate-v2="{}"><nav class="framer-abc-container framer-v-desk" data-framer-name="Navigation"><div class="ssr-variant hidden-tab hidden-ph"><a>WORK ABOUT</a></div></nav></div></body></html>`;
const navP = navD.replace("framer-v-desk", "framer-v-phone").replace('class="ssr-variant hidden-tab hidden-ph"><a>WORK ABOUT</a>', 'class="ssr-variant hidden-desk hidden-tab"><a>MENU</a>');
const nm = mergeVariantCaptures(navD, [navP]);
ok(nm.added === 1 && /WORK ABOUT[\s\S]*MENU/.test(nm.html), "variant matched even though the parent's per-width variant class differs");
// after hydrating at a narrow width, some sites drop the hidden-* classes
const hydrated = page(`<div class="ssr-variant"><section data-framer-name="Hero">Phone hero, unrestricted</section></div>`);
const hm = mergeVariantCaptures(desktop, [hydrated]);
ok(hm.added === 0 && !/unrestricted/.test(hm.html), "an unrestricted section (no hidden-* classes) is never merged — it would show at every width");

// one variant for desktop+tablet; the tablet capture hydrates a tablet-only twin
const dt = page(`<div class="ssr-variant hidden-ph"><section data-framer-name="Card">Wide card</section></div>`);
const tTwin = page(`<div class="ssr-variant hidden-desk hidden-ph"><section data-framer-name="Card">Wide card</section></div>`);
const pCard = page(`<div class="ssr-variant hidden-desk hidden-tab"><section data-framer-name="Card">Phone card</section></div>`);
const tw = mergeVariantCaptures(dt, [tTwin, pCard]);
ok(tw.added === 1 && (tw.html.match(/Wide card/g) || []).length === 1 && /Phone card/.test(tw.html), "a tablet-only twin of a desktop+tablet variant is not added (no double section at tablet width)");

// Framer deletes its breakpoint style after hydrating: rebuild the hidden-* rules
// from which variants each width rendered
const bp = ensureBreakpointRules(m.html, [{ width: 1440, html: desktop }, { width: 810, html: tablet }, { width: 390, html: phone }]);
ok(bp.rules === 3 && /@media \(min-width: 1200px\) \{ \.hidden-desk \{ display: none !important; \} \}/.test(bp.html) && /@media \(min-width: 810px\) and \(max-width: 1199\.98px\) \{ \.hidden-tab \{/.test(bp.html) && /@media \(max-width: 809\.98px\) \{ \.hidden-ph \{/.test(bp.html), "breakpoint rules inferred: each class hides only at its own width");
const bpDom = new JSDOM(bp.html, { pretendToBeVisual: true });
ok(bpDom.window.document.querySelectorAll("style[data-sl-inferred]").length === 1 && bpDom.window.document.head.lastElementChild.hasAttribute("data-sl-inferred"), "rules added once, in <head>");
ok(ensureBreakpointRules(bp.html, [{ width: 1440, html: desktop }, { width: 810, html: tablet }]).rules === 0, "existing rules are not duplicated");
const withRules = m.html.replace("</head>", "<style>@media (min-width:1200px){.hidden-desk{display:none!important}}@media (max-width:1199px){.hidden-tab{display:none!important}}@media (max-width:809px){.hidden-ph{display:none!important}}</style></head>");
ok(ensureBreakpointRules(withRules, [{ width: 1440, html: desktop }, { width: 390, html: phone }]).rules === 0, "pages that kept Framer's own rules are left alone");
ok(ensureBreakpointRules(m.html, [{ width: 1440, html: desktop }]).rules === 0, "a single width infers nothing");
const u = unhideLoneVariants(desktop);
ok(u.unhidden === 1 && !/hidden-tab/.test(u.html), "a lone variant is shown at every width (no blank tablet/phone)");
const u2 = unhideLoneVariants(m.html);
ok(u2.unhidden === 0 && /hidden-tab/.test(u2.html), "complete variant groups keep their breakpoint classes");

// whole per-width layouts (component variants swapped with JavaScript)
const dPage = `<!doctype html><html><head><style>.framer-nav{color:red}</style><style data-sl-scroll-reveal="1">@keyframes sl-reveal-r1 { from { opacity: 0; } }\n[data-sl-reveal="r1"] { animation: sl-reveal-r1 linear both; }</style></head><body><div id="main"><nav class="framer-nav framer-v-desk">WORK ABOUT</nav><h1 data-sl-reveal="r1">Desktop title</h1></div></body></html>`;
const pPage = `<!doctype html><html><head><style>.framer-nav{color:red}</style><style>.framer-v-menu{width:40px}.framer-v-hero-phone{font-size:20px}.framer-nav{color:blue}</style><style data-sl-scroll-reveal="1">@keyframes sl-reveal-r1 { from { opacity: 0.2; } }\n[data-sl-reveal="r1"] { animation: sl-reveal-r1 linear both; }</style></head><body><div id="main"><nav class="framer-nav framer-v-menu">☰</nav><h1 class="framer-v-hero-phone" data-sl-reveal="r1">Phone title</h1></div><script>x()</script></body></html>`;
ok(needsWholeLayout(dPage, pPage) && !needsWholeLayout(dPage, dPage), "detects component variants swapped at the narrower width");
const wl = addWholeLayout(dPage, pPage, "phone");
const wd = new dom.window.DOMParser().parseFromString(wl.html, "text/html");
const lay = wd.querySelector('[data-sl-layout="phone"]');
ok(!!lay && lay.parentElement === wd.body && /Phone title/.test(lay.textContent) && /☰/.test(lay.textContent) && !lay.querySelector("script"), "phone page kept as its own layout (no scripts)");
ok(/Desktop title/.test(wd.body.textContent) && wd.querySelector("body > #main") !== null, "desktop content untouched");
ok(/\.framer-v-menu\{width:40px\}/.test(wl.html) && !/\.framer-nav\{color:blue\}/.test(wl.html), "phone-only component CSS carried; shared selectors not overridden");
ok(/@keyframes sl-reveal-pr1 \{ from \{ opacity: 0\.2; \} \}/.test(wl.html) && /data-sl-reveal="pr1"/.test(wl.html) && /@keyframes sl-reveal-r1 \{ from \{ opacity: 0; \} \}/.test(wl.html), "phone animations renamed — no collision with desktop ones");
ok(/@media \(max-width: 809\.98px\) \{\s*body > :not\(\[data-sl-layout\]\):not\(script\):not\(style\) \{ display: none !important; \}\s*\[data-sl-layout="phone"\] \{ display: contents !important; \}/.test(wl.html), "phone layout shown only below 810 px, desktop content hidden there");
const wl2 = addWholeLayout(wl.html, pPage, "phone");
const wd2 = new dom.window.DOMParser().parseFromString(wl2.html, "text/html");
ok(wd2.querySelectorAll('[data-sl-layout="phone"]').length === 1 && wd2.querySelectorAll("style[data-sl-layouts-switch]").length === 1 && wd2.querySelectorAll('style[data-sl-layout-css="phone"]').length === 1, "re-adding replaces instead of duplicating");

// Each capture numbers its animations from 1: a tablet layout's sl-scroll-s1 must not replace the desktop's (the
// desktop hero of monodrift.framer.website slid by the tablet's numbers) — and the tablet layout keeps its own motion
{
  const motionCss = (x) => `<style data-sl-scroll-motion>@media (prefers-reduced-motion: no-preference) { @keyframes sl-scroll-s1 { 0% { transform: matrix(1, 0, 0, 1, ${x}, 0); } 100% { transform: matrix(1, 0, 0, 1, -500, 0); } } [data-sl-scroll="s1"] { animation: sl-scroll-s1 linear both; animation-timeline: scroll(root block); } @keyframes sl-in-g1 { from { opacity: ${x ? 0 : 0.5}; } } [data-sl-in="g1"] { animation: sl-in-g1 600ms both; } }</style>`;
  const deskM = page(`<div class="ssr-variant hidden-tab hidden-ph"><section data-framer-name="Hero" data-sl-scroll="s1"><h1 data-sl-in="g1">Desk</h1></section></div>`, motionCss(0));
  const tabM = page(`<div class="ssr-variant hidden-desk hidden-ph"><section data-framer-name="Hero" class="tab-hero" data-sl-scroll="s1"><h1 data-sl-in="g1">Tab</h1></section></div>`, motionCss(-80) + `<style>.tab-hero{color:red}</style>`);
  const mm = mergeVariantCaptures(deskM, [tabM]);
  const css = (mm.html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join("\n");
  const defs = css.match(/@keyframes sl-scroll-s1 \{[^}]*\}/g) || [];
  ok(defs.length === 1 && /matrix\(1, 0, 0, 1, 0, 0\)/.test(defs[0]) && (css.match(/@keyframes sl-in-g1 \{/g) || []).length === 1, `the desktop keeps its own animations (sl-scroll-s1 defined ${defs.length}×, starting at ${(/matrix\([^)]*\)/.exec(defs[0] || "") || [""])[0]})`);
  const md = new dom.window.DOMParser().parseFromString(mm.html, "text/html");
  const tabEl = md.querySelector(".tab-hero"), tabH = tabEl?.querySelector("h1");
  const sid = tabEl?.getAttribute("data-sl-scroll"), gid = tabH?.getAttribute("data-sl-in");
  ok(!!sid && sid !== "s1" && !!gid && gid !== "g1" && new RegExp(`@keyframes sl-scroll-${sid}\\s*\\{[^}]*-80`).test(css) && css.includes(`[data-sl-scroll="${sid}"]`) && css.includes(`[data-sl-in="${gid}"]`), `…and the tablet layout keeps its own, renamed apart, with their rules (${sid}, ${gid})`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Responsive variant merge verified ✓");
