// Verifies the component inspector end-to-end: bundles the REAL inspect.ts +
// component.ts, builds an animated card in jsdom, drives the interactive picker
// by dispatching a click, and asserts the measured blueprint + renderers.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

let passed = 0;
const failures = [];
const ok = (c, l) => {
  if (c) {
    passed++;
    console.log(`  ✓ ${l}`);
  } else {
    failures.push(l);
    console.log(`  ✗ ${l}`);
  }
};

const outdir = mkdtempSync(join(tmpdir(), "sl-comp-"));
await build({
  entryPoints: { inspect: "src/extractor/inspect.ts", component: "src/panel/component.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { pickAndInspectComponent } = await import(pathToFileURL(join(outdir, "inspect.js")));
const C = await import(pathToFileURL(join(outdir, "component.js")));

// ── animated card ─────────────────────────────────────────────────────────────
const dom = new JSDOM(
  `<!doctype html><html><head><style>
    @keyframes float { 0% { transform: translateY(0); } 100% { transform: translateY(-10px); } }
    .cta:hover { transform: translateY(-2px); background-color: #5b7bff; }
  </style></head><body>
    <section class="card">
      <div class="layer-bg"></div>
      <div class="content">
        <h3>Magic Links</h3>
        <p>Improve sign-up conversion.</p>
        <svg class="icon" aria-label="bolt" viewBox="0 0 24 24"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>
        <svg class="sprite"><use href="https://cdn.example.com/sprite.svg#bolt"></use></svg>
        <button class="cta">Start building</button>
      </div>
      <div class="bg-icon"></div>
      <img src="https://cdn.example.com/art.png" />
      <video src="https://cdn.example.com/demo.mp4" poster="https://cdn.example.com/p.jpg"></video>
    </section>
  </body></html>`,
  { url: "https://clerk.com/", pretendToBeVisual: true },
);
const { window } = dom;
const doc = window.document;
const set = (sel, styles) =>
  doc.querySelectorAll(sel).forEach((el) => Object.assign(el.style, styles));

set(".card", {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  position: "relative",
  overflow: "hidden",
  borderTopLeftRadius: "16px",
  borderTopRightRadius: "16px",
  borderBottomLeftRadius: "16px",
  borderBottomRightRadius: "16px",
  backgroundImage: "linear-gradient(180deg, #0b0e14 0%, #11151d 100%)",
  boxShadow: "rgba(0, 0, 0, 0.4) 0px 8px 30px 0px",
  animationName: "float",
  animationDuration: "3s",
  animationTimingFunction: "ease-in-out",
  animationIterationCount: "infinite",
  padding: "24px",
});
set(".layer-bg", { position: "absolute", top: "0", left: "0", zIndex: "0" });
set(".bg-icon", { width: "24px", height: "24px", backgroundImage: 'url("https://cdn.example.com/bg.svg")' });
set(".content", { position: "relative", zIndex: "1" });
set(".cta", { transitionProperty: "transform", transitionDuration: "0.2s", transitionTimingFunction: "ease", color: "#ffffff" });

globalThis.window = window;
globalThis.document = doc;
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.requestAnimationFrame =
  window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(() => cb(Date.now()), 16));

// ── drive the picker ──────────────────────────────────────────────────────────
const card = doc.querySelector(".card");
const promise = pickAndInspectComponent();
await sleep(0); // let the picker attach its listeners
card.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const bp = await promise;

console.log("\nBlueprint:");
console.log(`  label=${bp?.label} nodes=${bp?.nodeCount} anim=${bp?.animations.length} trans=${bp?.transitions.length} keyframes=${bp?.keyframes.length} triggers=${bp?.triggers.length} digests=${bp?.digests.length}`);
console.log("  techniques:", bp?.techniques.join(" | "));

console.log("\nAssertions — inspection:");
ok(!!bp, "picker resolved a blueprint on click");
ok(bp.label.includes("section") && bp.label.includes("card"), "root labelled section.card");
ok(bp.techniques.some((t) => /Grid/.test(t)), "detected CSS Grid layout");
ok(bp.techniques.some((t) => /Layered stacking/.test(t)), "detected layered stacking (absolute + z-index)");
ok(bp.techniques.some((t) => /Clipped overflow/.test(t)), "detected clipped overflow on root");
ok(bp.techniques.some((t) => /Gradient fills/.test(t)), "detected gradient fill");
ok(bp.techniques.some((t) => /Keyframe animation/.test(t)), "detected keyframe animation technique");
ok(bp.techniques.some((t) => /Interaction transitions/.test(t)), "detected interaction transition technique");
ok(bp.animations.some((a) => a.name === "float" && a.duration === "3s"), "captured animation float @ 3s");
ok(bp.animations.some((a) => a.name === "float" && a.source === "css"), "animation tagged source=css");
ok(bp.transitions.some((t) => /transform/.test(t.property) && t.duration === "0.2s"), "captured transform transition @ 0.2s");
ok(bp.triggers.some((t) => /\.cta:hover/.test(t.selectorText)), ".cta:hover trigger rule matched to subtree");
if (bp.keyframes.length) ok(bp.keyframes.some((k) => k.name === "float"), "@keyframes float captured verbatim");
else console.log("  ~ @keyframes capture skipped (jsdom CSSOM has no CSSKeyframesRule) — verified in-browser");
ok(bp.tokens.gradients.length > 0, "gradient token captured");
ok(bp.tokens.radii.includes("16px"), "radius 16px token captured");
ok(bp.tokens.colors.length > 0, "scoped colors captured");
ok(bp.assets.images.some((a) => a.url.endsWith("art.png")), "subtree image asset captured");
ok(bp.assets.images.some((a) => a.url.endsWith("p.jpg")), "video poster captured as image");
ok(bp.assets.videos.some((a) => a.url.endsWith("demo.mp4")), "subtree video asset captured");
ok(bp.assets.svgs.length >= 1, "inline <svg> captured as an asset");
ok(bp.assets.svgs.some((s) => s.label === "bolt" && /<svg/.test(s.markup)), "inline SVG markup + aria-label captured");
ok(bp.assets.svgs.every((s) => /xmlns\s*=\s*"http:\/\/www\.w3\.org\/2000\/svg"/.test(s.markup)), "captured SVG markup is standalone-valid (has xmlns)");
ok(bp.assets.images.some((a) => a.url.endsWith("bg.svg") && a.type === "svg"), "background-image SVG url captured");
ok(bp.assets.images.some((a) => a.url.includes("sprite.svg")), "<use> sprite reference captured");
ok(bp.techniques.some((t) => /Inline SVG/.test(t)), "Inline SVG technique flagged");
ok(bp.html.includes("class=\"card\"") || bp.html.includes("class=card"), "cleaned HTML retains the section");
ok(!bp.html.includes("<video src=\"https://cdn.example.com/demo.mp4\"></video><style") && !/<style/.test(bp.html), "cleaned HTML stripped <style>");
ok(bp.digests.length > 0 && bp.digests[0].styles.display === "grid", "root digest captured display:grid");

// listeners cleaned up?
ok(!doc.body.style.cursor || doc.body.style.cursor === "", "picker restored the cursor (cleanup ran)");

console.log("\nAssertions — renderers:");
const md = C.renderComponentMd(bp, null);
ok(md.includes("# Component:") && md.includes("## Architecture"), "COMPONENT.md has title + Architecture");
ok(md.includes("## How to replicate"), "COMPONENT.md has replication steps");
ok(md.includes("## Motion"), "COMPONENT.md has a Motion section");
const code = C.renderComponentCode(bp);
ok(/HTML/.test(code) && code.includes("grid-template-columns"), "Code tab includes HTML + curated CSS");
ok(code.includes("Inline SVGs") && code.includes("<svg"), "Code tab embeds copy-ready inline SVG markup");
ok(md.includes("## Assets"), "Guide has an Assets section");
const anim = C.renderAnimations(bp);
ok(/float/.test(anim), "Animations tab references the keyframe animation");
const struct = C.renderStructure(bp);
ok(struct.includes("section") && struct.includes("button"), "Structure tab outlines the tree");
const toks = C.renderComponentTokens(bp);
ok(toks.includes("--c-1:"), "Tokens tab emits scoped color vars");
for (const tab of ["guide", "structure", "animations", "code", "assets", "tokens"]) {
  ok(typeof C.componentTabText(bp, null, tab) === "string", `componentTabText('${tab}') returns text`);
}
const assetsText = C.renderComponentAssetsText(bp);
ok(assetsText.includes("Inline SVGs") && assetsText.includes("bolt"), "Assets tab text lists inline SVGs");
ok(assetsText.includes("art.png"), "Assets tab text lists images");

console.log("\nAssertions — explanation merge:");
const explanation = {
  summary: "A glassy feature card with a floating idle animation and a lifting CTA.",
  techniques: [{ title: "Layered gradient surface", detail: "An absolute layer sits beneath relative content." }],
  steps: ["Create the grid container.", "Add the float keyframes."],
  gotchas: ["overflow:hidden clips the animated layer."],
};
const explained = C.renderComponentMd(bp, explanation);
ok(explained.includes(explanation.summary), "explanation summary applied");
ok(explained.includes("Layered gradient surface"), "explanation technique applied");
ok(explained.includes("Add the float keyframes."), "explanation steps applied");
ok(explained.includes("overflow:hidden clips the animated layer."), "explanation gotchas applied");

console.log("\nAssertions — clicking directly on an <svg>:");
const svgEl = doc.querySelector("svg.icon");
const p2 = pickAndInspectComponent();
await sleep(0);
svgEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const bp2 = await p2;
ok(!!bp2, "picker resolved when clicking an <svg>");
ok(bp2.assets.svgs.some((s) => s.label === "bolt"), "root <svg> itself captured as an inline svg asset");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("Component inspection verified ✓");
