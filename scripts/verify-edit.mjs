// Verifies the live-edit pipeline: the pure CSS generator, the element picker,
// and the override applier (including survival when the page removes the tag).
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

const outdir = mkdtempSync(join(tmpdir(), "sl-edit-"));
await build({
  entryPoints: { edit: "src/extractor/edit.ts", overrides: "src/shared/overrides.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { pickElementForEdit, applyOverridesToPage, applyStructuralOps } = await import(pathToFileURL(join(outdir, "edit.js")));
const { overridesToCss, countEdits } = await import(pathToFileURL(join(outdir, "overrides.js")));

// ── 1. pure CSS generator ──────────────────────────────────────────────────────
console.log("Assertions — overridesToCss:");
const overrides = {
  ".card": { props: { color: "#fff", "background-color": "rgb(10,10,10)" }, css: "transform: scale(1.02);" },
  ".cta": { props: { "border-radius": "9999px" } },
  ".empty": { props: {} },
};
const css = overridesToCss(overrides);
ok(css.includes(".card {"), "emits a rule per selector");
ok(css.includes("color: #fff !important;"), "structured props get !important");
ok(css.includes("transform: scale(1.02);"), "raw custom css is appended");
ok(css.includes(".cta {") && css.includes("border-radius: 9999px"), "second selector emitted");
ok(!css.includes(".empty"), "selectors with no props are skipped");
ok(!overridesToCss(overrides, false).includes("!important"), "export form omits !important");
ok(countEdits(overrides) === 4, "countEdits counts props + custom css");

// ── 2. jsdom environment ───────────────────────────────────────────────────────
const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
    <section class="card"><button class="cta">Go</button></section>
  </body></html>`,
  { url: "https://example.com/", pretendToBeVisual: true },
);
const { window } = dom;
const doc = window.document;
doc.querySelector(".cta").style.cssText = "color: rgb(255,255,255); font-size: 13px; border-radius: 4px;";
globalThis.window = window;
globalThis.document = doc;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MutationObserver = window.MutationObserver;
globalThis.CSS = window.CSS && window.CSS.escape ? window.CSS : { escape: (s) => s };

// ── 3. picker returns selector + current values ────────────────────────────────
console.log("\nAssertions — pickElementForEdit:");
const props = ["color", "font-size", "border-radius"];
const cta = doc.querySelector(".cta");
const pick = pickElementForEdit(props);
await sleep(0);
cta.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const target = await pick;
ok(!!target, "picker resolves a target on click");
ok(/button/.test(target.selector) && target.selector.includes(".cta"), "returns a selector for the clicked element");
ok(target.values["font-size"] === "13px", "pre-reads current computed values");
ok(target.values["border-radius"] === "4px", "pre-reads radius value");
ok(!doc.body.style.cursor, "picker cleaned up (cursor restored)");

// ── 4. applyOverridesToPage injects + survives removal ─────────────────────────
console.log("\nAssertions — applyOverridesToPage:");
const cssText = overridesToCss({ ".cta": { props: { color: "#ff0000" } } });
applyOverridesToPage(cssText);
const styleEl = doc.getElementById("__stylelift_overrides__");
ok(!!styleEl, "injects the override <style> element");
ok(styleEl.textContent.includes("color: #ff0000 !important"), "style contains the generated CSS");

// update replaces content, doesn't duplicate
applyOverridesToPage(overridesToCss({ ".cta": { props: { color: "#00ff00" } } }));
ok(doc.querySelectorAll("#__stylelift_overrides__").length === 1, "re-apply reuses one <style> element");
ok(doc.getElementById("__stylelift_overrides__").textContent.includes("#00ff00"), "re-apply updates the CSS");

// page removes the tag → observer re-attaches it
doc.getElementById("__stylelift_overrides__").remove();
ok(!doc.getElementById("__stylelift_overrides__"), "tag removed (simulating a framework re-render)");
doc.documentElement.appendChild(doc.createElement("div")); // trigger a mutation
await sleep(30);
ok(!!doc.getElementById("__stylelift_overrides__"), "observer re-attaches the override <style> after removal");

// ── 5. structural ops ──────────────────────────────────────────────────────────
console.log("\nAssertions — applyStructuralOps:");
const section = doc.querySelector(".card").parentElement; // <section>
doc.body.innerHTML = `<ul id="list"><li class="a">A</li><li class="b">B</li><li class="c">C</li></ul>`;
void section;
// duplicate .b
applyStructuralOps([{ selector: "#list .b", op: "duplicate" }]);
ok(doc.querySelectorAll("#list .b").length === 2, "duplicate clones the element");
// move .a down (swaps with its next sibling)
const firstBefore = doc.querySelector("#list li").className;
applyStructuralOps([{ selector: "#list .a", op: "moveDown" }]);
ok(doc.querySelector("#list li").className !== firstBefore, "moveDown reorders the element");
// delete .c
applyStructuralOps([{ selector: "#list .c", op: "delete" }]);
ok(!doc.querySelector("#list .c"), "delete removes the element");
// missing selector is a no-op (returns 0)
ok(applyStructuralOps([{ selector: ".does-not-exist", op: "delete" }]) === 0, "missing selector applies nothing");
// move at edge is a no-op
const list = doc.getElementById("list");
const firstChild = list.firstElementChild.className;
ok(applyStructuralOps([{ selector: `#list .${firstChild}`, op: "moveUp" }]) === 0, "moveUp at the top edge does nothing");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("Live-edit pipeline verified ✓");
