// End-to-end verification of the deterministic pipeline (no browser, no API key).
//
// 1. Bundle the REAL source (extractor + renderers) with esbuild.
// 2. Build a synthetic page in jsdom with known colors, fonts, radii, shadows,
//    spacing, CSS variables, @font-face and assets.
// 3. Run extractDesignTokens() against it and assert the measured tokens.
// 4. Run all four renderers + the markdown converter and assert their output.
//
// Exits non-zero on any failed assertion.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ── tiny assertion harness ────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

// ── 1. bundle the real modules ────────────────────────────────────────────────
const outdir = mkdtempSync(join(tmpdir(), "stylelift-verify-"));
await build({
  entryPoints: {
    extract: "src/extractor/extract.ts",
    render: "src/panel/render.ts",
    markdown: "src/panel/markdown.ts",
  },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { extractDesignTokens } = await import(pathToFileURL(join(outdir, "extract.js")));
const render = await import(pathToFileURL(join(outdir, "render.js")));
const { markdownToHtml } = await import(pathToFileURL(join(outdir, "markdown.js")));

// ── 2. synthetic page ─────────────────────────────────────────────────────────
const html = `<!doctype html><html><head>
  <style>
    :root { --color-brand: #6e8bff; --color-ink: #11141a; --space-md: 16px; }
    @font-face { font-family: "Waldenburg"; font-weight: 300; font-style: normal;
      src: url("https://cdn.example.com/waldenburg-300.woff2") format("woff2"); }
  </style></head>
  <body>
    <h1>Display heading</h1>
    <p class="lede">Body paragraph one.</p>
    <p>Body paragraph two.</p>
    <button class="cta">Action</button>
    <div class="card">Card surface</div>
    <svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>
    <img src="https://cdn.example.com/hero.png" />
    <img src="data:image/png;base64,${"A".repeat(240)}" />
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    <span class="bgemoji" style="background-image:url('data:image/webp;base64,${"B".repeat(200)}')"></span>
    <video src="https://cdn.example.com/promo.mp4" poster="https://cdn.example.com/poster.jpg"></video>
    <video><source src="https://cdn.example.com/clip.webm" type="video/webm" /></video>
    <picture><source srcset="https://cdn.example.com/wide.avif" /></picture>
  </body></html>`;

const dom = new JSDOM(html, { url: "https://example.com/landing", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

// Apply inline styles so jsdom's getComputedStyle returns concrete values.
function css(sel, styles) {
  for (const el of doc.querySelectorAll(sel)) Object.assign(el.style, styles);
}
// CSS variables on :root (also inline so getPropertyValue resolves them in jsdom)
doc.documentElement.style.setProperty("--color-brand", "#6e8bff");
doc.documentElement.style.setProperty("--color-ink", "#11141a");
doc.documentElement.style.setProperty("--space-md", "16px");

css("body", { backgroundColor: "rgb(253, 252, 252)", color: "rgb(17, 20, 26)", fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: "400", lineHeight: "1.5", margin: "16px" });
css("h1", { fontFamily: "Waldenburg, serif", fontSize: "32px", fontWeight: "300", lineHeight: "1.1", letterSpacing: "-0.02em", color: "rgb(17, 20, 26)" });
css("p", { fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: "400", color: "rgb(17, 20, 26)", marginBottom: "16px", marginTop: "-12px" });
// Set the radius longhands explicitly: jsdom does not expand the `border-radius`
// shorthand into corners the way real browsers' getComputedStyle always does.
css(".cta", { backgroundColor: "#6e8bff", color: "#ffffff", borderTopLeftRadius: "9999px", borderTopRightRadius: "9999px", borderBottomRightRadius: "9999px", borderBottomLeftRadius: "9999px", padding: "8px", fontFamily: "Inter, sans-serif", fontSize: "13px", boxShadow: "rgba(0, 0, 0, 0.04) 0px 1px 0px 0px" });
css(".card", { backgroundColor: "rgb(253, 252, 252)", borderTopLeftRadius: "8px", borderTopRightRadius: "8px", borderBottomRightRadius: "8px", borderBottomLeftRadius: "8px", borderTopColor: "rgb(42, 47, 58)", borderTopStyle: "solid", borderTopWidth: "1px", padding: "16px", boxShadow: "rgba(0, 0, 0, 0.08) 0px 4px 12px 0px" });
// SVG fill
const path = doc.querySelector("path");
path.style.fill = "rgb(110, 139, 255)";

// install globals the extractor reads at call time
globalThis.window = window;
globalThis.document = doc;
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
if (!globalThis.performance?.getEntriesByType) {
  globalThis.performance = { getEntriesByType: () => [] };
}

// ── 3. run the extractor ──────────────────────────────────────────────────────
const tokens = extractDesignTokens();
console.log("\nExtractor output:");
console.log(`  colors=${tokens.colors.length} families=${tokens.typography.families.length} radii=${tokens.radii.length} shadows=${tokens.shadows.length} spacing=${tokens.spacing.length} cssVars=${Object.keys(tokens.cssVariables).length} fontFaces=${tokens.typography.fontFaces.length}`);

console.log("\nAssertions — extraction:");
const hexes = tokens.colors.map((c) => c.value);
ok(tokens.meta.url === "https://example.com/landing", "meta.url is the page URL");
ok(/^\d{4}-\d{2}-\d{2}T/.test(tokens.meta.extractedAt), "meta.extractedAt is an ISO timestamp");
ok(hexes.includes("#fdfcfc"), "rgb(253,252,252) normalized to #fdfcfc");
ok(hexes.includes("#6e8bff"), "brand #6e8bff captured");
ok(hexes.includes("#11141a"), "ink #11141a captured");
ok(tokens.colors.every((c) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(c.value)), "every color is normalized lowercase hex");
ok(tokens.colors.every((c) => c.count > 0), "every color has a usage count");
const brand = tokens.colors.find((c) => c.value === "#6e8bff");
ok(brand && brand.cssVar === "--color-brand", "brand color mapped back to --color-brand");
ok(tokens.colors[0].count >= tokens.colors[tokens.colors.length - 1].count, "colors sorted by frequency (desc)");
const svgFill = tokens.colors.find((c) => c.usedOn.fill);
ok(!!svgFill, "SVG fill color recorded under usedOn.fill");

ok("--color-brand" in tokens.cssVariables, ":root custom property --color-brand captured");
ok(tokens.cssVariables["--space-md"] === "16px", "non-color CSS var --space-md captured verbatim");

const fams = tokens.typography.families.map((f) => f.family);
ok(fams.includes("Inter"), "Inter family detected");
ok(fams.includes("Waldenburg"), "Waldenburg family detected");
const inter = tokens.typography.families.find((f) => f.family === "Inter");
ok(inter && inter.likelyRole === "body", "highest-count family (Inter) tagged body");
const wald = tokens.typography.families.find((f) => f.family === "Waldenburg");
ok(wald && wald.weights.includes(300), "Waldenburg weight 300 recorded");
ok(tokens.typography.scale.some((s) => s.size === "32px"), "32px display step present in type scale");
// mirror the extractor's NaN→0 size parsing (jsdom yields the keyword "medium" for unset sizes)
const scalePx = tokens.typography.scale.map((s) => parseFloat(s.size) || 0);
ok(scalePx.length > 0 && scalePx[0] === Math.max(...scalePx), "type scale sorted large→small (largest first)");

ok(tokens.radii.some((r) => r.value === "9999px"), "pill radius 9999px captured");
ok(tokens.radii.some((r) => r.value === "8px"), "card radius 8px captured");
ok(!tokens.radii.some((r) => r.value === "0px"), "zero radii excluded");

ok(tokens.spacing.some((s) => s.value === "16px"), "16px spacing captured");
ok(tokens.spacing.every((s) => s.value !== "0px"), "zero spacing excluded");
ok(tokens.spacing.every((s) => s.value[0] !== "-"), "negative spacing (margin hacks) excluded");

const softShadow = tokens.shadows.find((s) => s.opacity === 0.04);
ok(!!softShadow, "shadow opacity 0.04 parsed from rgba alpha");
const bigShadow = tokens.shadows.find((s) => s.blur === 12 && s.spread === 0);
ok(!!bigShadow, "shadow blur=12 spread=0 parsed from offsets");

ok(tokens.assets.images.some((a) => a.url.endsWith("hero.png") && a.type === "png"), "hero.png catalogued as an image asset");
ok(tokens.assets.videos.some((a) => a.url.endsWith("promo.mp4") && a.type === "mp4"), "promo.mp4 catalogued as a video asset");
ok(tokens.assets.videos.some((a) => a.url.endsWith("clip.webm")), "<video><source> webm catalogued as a video asset");
ok(tokens.assets.images.some((a) => a.url.endsWith("poster.jpg")), "<video> poster catalogued as an image asset");
ok(tokens.assets.images.some((a) => a.inline && a.type === "png" && a.bytes > 80), "inline data: PNG captured with mime type + decoded size");
ok(tokens.assets.images.some((a) => a.inline && a.type === "webp"), "CSS background-image data: URI captured (emoji/icon sprite path)");
ok(!tokens.assets.images.some((a) => a.url.includes("R0lGOD")), "tiny inline tracking pixel/spacer excluded");
ok(tokens.assets.images.some((a) => a.url.endsWith("wide.avif")), "<picture><source> avif catalogued as an image asset");
ok(!tokens.assets.videos.some((a) => a.url.endsWith(".avif") || a.url.endsWith(".png")), "images are not miscategorized as videos");

// @font-face: jsdom exposes family/weight but not src/format (real browsers do both).
const ff = tokens.typography.fontFaces.find((f) => f.family === "Waldenburg");
ok(!!ff && ff.weight === 300, "@font-face Waldenburg (weight 300) parsed from stylesheet");
if (ff && ff.format) ok(/woff2/.test(ff.format), "@font-face woff2 format parsed");
else console.log("  ~ @font-face src/format empty (jsdom CSSOM gap) — exercised against a real browser separately");

// ── 4. renderers ──────────────────────────────────────────────────────────────
console.log("\nAssertions — renderers (no LLM):");
const cssOut = render.renderCssVariables(tokens, "compact");
ok(cssOut.startsWith(":root {") && cssOut.includes("--color-brand: #6e8bff;"), "CSS Variables tab emits :root with the var");
ok(cssOut.includes("--radius-1:") && cssOut.includes("--spacing-1:"), "CSS Variables tab includes radius + spacing scales");

const twOut = render.renderTailwind(tokens, "extended");
ok(twOut.startsWith("@theme {") && twOut.includes("--color-"), "Tailwind v4 tab emits @theme color tokens");
ok(twOut.includes('--font-inter: "Inter";'), "Tailwind v4 tab emits font token");

const dtOut = render.renderDesignTokensJson(tokens, "compact");
const parsed = JSON.parse(dtOut);
ok(parsed.color && Object.values(parsed.color)[0].$type === "color", "Design Tokens tab is valid W3C JSON ($type:color)");
ok(parsed.fontFamily && Object.keys(parsed.fontFamily).length > 0, "Design Tokens tab includes fontFamily group");

const mdOut = render.renderDesignMd(tokens, null, "compact");
ok(mdOut.includes("| Name | Value | Token | Role |"), "DESIGN.md has the Colors table header");
ok(mdOut.includes("`#6e8bff`"), "DESIGN.md Colors table lists a measured value");
ok(mdOut.includes("## Typography") && mdOut.includes("### Inter"), "DESIGN.md has Typography section per font");
ok(mdOut.includes("**Do**") && mdOut.includes("**Don't**"), "DESIGN.md has DO/DON'T guidelines (heuristic, pre-polish)");

const htmlOut = markdownToHtml(mdOut);
ok(htmlOut.includes("<table>") && htmlOut.includes("<th>Name</th>"), "markdown→HTML renders the colors table");
ok(htmlOut.includes('class="swatch" style="background:#6e8bff"'), "markdown→HTML renders a color swatch for hex values");

// ── 5. enrichment merge (simulated DeepSeek output) ───────────────────────────
console.log("\nAssertions — enrichment merge:");
const enrichment = {
  theme: "Quiet parchment, electric ink.",
  colors: [{ value: "#6e8bff", name: "Electric Periwinkle", role: "Primary action accent" }],
  fonts: [{ family: "Inter", role: "Body & UI", substitutes: ["Inter", "Public Sans"] }],
  do: ["Reserve Electric Periwinkle for primary actions."],
  dont: ["Don't tint large surfaces with the accent."],
};
const polished = render.renderDesignMd(tokens, enrichment, "compact");
ok(polished.includes("> Quiet parchment, electric ink."), "enrichment theme tagline applied");
ok(polished.includes("Electric Periwinkle"), "enrichment color name applied");
ok(polished.includes("Reserve Electric Periwinkle for primary actions."), "enrichment DO applied");
ok(polished.includes("Public Sans"), "enrichment font substitute applied");

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("All deterministic-pipeline checks passed ✓");
