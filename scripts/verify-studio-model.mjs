// StyleLift Studio model: ids, per-breakpoint edits → CSS, inheritance, layer names, export assembly.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "sl-studio-"));
await build({ entryPoints: { model: "src/studio/model.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const M = await import(pathToFileURL(join(outdir, "model.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const doc = new dom.window.DOMParser().parseFromString(`<!doctype html><html><head><style>.x{}</style></head><body>
  <header><nav aria-label="Primary"><a href="/a">About us</a></nav></header>
  <main><section data-framer-name="Hero"><h1>Build fast</h1><img src="a.png" alt="Logo"><div><span>x</span></div></section></main>
  <script>bad()</script></body></html>`, "text/html");
const max = M.assignIds(doc);
ok(max >= 8 && doc.querySelectorAll("[data-sl-id]").length === max, `every body element gets an id (${max})`);
ok(!doc.querySelector("script[data-sl-id]") && !doc.querySelector("head [data-sl-id]"), "scripts and head are left alone");
const before = doc.body.innerHTML;
M.assignIds(doc);
ok(doc.body.innerHTML === before, "ids are stable when assigned again");

const hero = doc.querySelector("[data-framer-name=Hero]");
const h1 = doc.querySelector("h1");
const idHero = hero.getAttribute("data-sl-id"), idH1 = h1.getAttribute("data-sl-id");
ok(M.layerName(hero) === "Hero" && M.layerName(doc.querySelector("nav")) === "Primary", "layer names from Framer layer names / aria-label");
ok(M.layerName(h1) === "Build fast" && M.layerKind(h1) === "text", "text layers named by their words");
ok(M.layerName(doc.querySelector("img")) === "Logo" && M.layerKind(doc.querySelector("img")) === "image", "images named by alt");
ok(M.layerName(doc.querySelector("a")) === "About us" && M.layerKind(doc.querySelector("a")) === "link", "links named by text");
ok(M.layerName(doc.querySelector("header")) === "Header" && M.layerKind(doc.querySelector("main")) === "section", "landmarks");

let e = {};
e = M.setEdit(e, idH1, "base", "color", "rgb(255, 0, 0)");
e = M.setEdit(e, idH1, "tablet", "fontSize", "40px");
e = M.setEdit(e, idH1, "phone", "fontSize", "28px");
e = M.setEdit(e, idHero, "phone", "display", "none");
const css = M.editsToCss(e);
ok(/\[data-sl-id="\d+"\] \{ color: rgb\(255, 0, 0\) !important; \}/.test(css), "desktop edits are unconditional, !important beats inline styles");
ok(css.indexOf("max-width: 1199.98px") < css.indexOf("max-width: 809.98px") && /font-size: 40px/.test(css) && /font-size: 28px/.test(css), "tablet then phone media blocks (phone wins below 810 px)");
ok(M.effectiveEdit(e, idH1, "phone", "color") === "rgb(255, 0, 0)" && M.effectiveEdit(e, idH1, "phone", "fontSize") === "28px" && M.effectiveEdit(e, idH1, "tablet", "fontSize") === "40px", "phone inherits desktop, overrides its own");
e = M.setEdit(e, idHero, "phone", "display", "");
ok(!e[idHero], "clearing the last value removes the element's entry");

h1.setAttribute("data-sl-sel", ""); h1.setAttribute("contenteditable", "true");
const out = M.buildExportHtml(doc, e);
ok(out.startsWith("<!doctype html>") && /<style data-stylelift="studio-edits">[\s\S]*font-size: 28px/.test(out), "export adds the edit stylesheet");
const idsLeft = (out.match(/<[a-z][^>]* data-sl-id="\d+"/g) || []); // element attributes only (CSS rules mention the id too)
ok(idsLeft.length === 1 && new RegExp(`<h1 data-sl-id="${idH1}">`).test(out), "export keeps ids only on edited elements");
ok(!/data-sl-sel|contenteditable/.test(out), "editor-only attributes stripped");
ok(M.toHex("rgb(59, 130, 246)") === "#3b82f6" && M.toHex("#abcdef") === "#abcdef", "colour helper");

ok(M.resolveViewportUnits("height:100vh;min-height:calc(100dvh - 40px);w:50vmin;top:-12.5vh", 1440, 900) === "height:900px;min-height:calc(900px - 40px);w:450px;top:-112.5px", "viewport units resolved against the breakpoint screen (vh, dvh, vmin, negatives)");
const vhPage = M.resolveViewportUnitsInHtml('<style>.hero{height:100vh}</style><div style="height: 50svh">The 100vh club</div>', 390, 844);
ok(/\.hero\{height:844px\}/.test(vhPage) && /height: 422px/.test(vhPage) && /The 100vh club/.test(vhPage), "only CSS is rewritten — page text mentioning '100vh' is untouched");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Studio model verified ✓");
