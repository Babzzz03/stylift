// Real-browser proof of live editing: launches system Chrome headless, injects the
// REAL applyOverridesToPage, and confirms the override actually changes computed
// style on the page — and survives the element being re-rendered (replaced).
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const outdir = mkdtempSync(join(tmpdir(), "sl-liveedit-"));
await build({
  entryPoints: { edit: "src/extractor/edit.ts" },
  outdir,
  bundle: true,
  format: "iife",
  globalName: "__SL__",
  platform: "browser",
  logLevel: "silent",
});
const editBundle = readFileSync(join(outdir, "edit.js"), "utf8");

const page = join(outdir, "page.html");
writeFileSync(
  page,
  `<!doctype html><html><head><style>
    .card{ background:#11151d; color:#8a93a6; border-radius:4px; padding:24px; font-size:14px }
  </style></head><body>
    <section id="host"><div class="card">Hello</div></section>
  </body></html>`,
);

const port = 9355;
const userDir = mkdtempSync(join(tmpdir(), "sle-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
]);
chrome.on("error", (e) => { console.error("Chrome launch failed:", e); process.exit(1); });

const http = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let version;
for (let i = 0; i < 50; i++) {
  try { version = await http("/json/version"); if (version) break; } catch { await sleep(200); }
}
if (!version) { console.error("DevTools never came up"); chrome.kill(); process.exit(1); }
console.log("Launched:", version.Browser, "\n");

let WS;
try { ({ WebSocket: WS } = await import("ws")); } catch { WS = globalThis.WebSocket; }
const target = await http(`/json/new?file://${encodeURIComponent(page)}`, "PUT");
const ws = new WS(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
await new Promise((r) => ws.addEventListener("open", () => r()));
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, { resolve }); ws.send(JSON.stringify({ id: mid, method, params })); });
await send("Page.enable");
await send("Page.navigate", { url: `file://${page}` });
await sleep(1200);

const evalJS = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval error");
  return result.value;
};

let failures = 0;
const ok = (c, l) => { console.log(`  ${c ? "✓" : "✗"} ${l}`); if (!c) failures++; };

// define the bundle (exposes __SL__.applyOverridesToPage)
await evalJS(editBundle);

const before = await evalJS(`getComputedStyle(document.querySelector('.card')).backgroundColor`);
console.log("  before:", before);

// apply an override
const css = `.card { background-color: rgb(255, 0, 0) !important; border-radius: 20px !important; }`;
await evalJS(`__SL__.applyOverridesToPage(${JSON.stringify(css)})`);
await sleep(150);
const afterBg = await evalJS(`getComputedStyle(document.querySelector('.card')).backgroundColor`);
const afterRadius = await evalJS(`getComputedStyle(document.querySelector('.card')).borderTopLeftRadius`);
console.log("  after:", afterBg, afterRadius);
ok(afterBg === "rgb(255, 0, 0)", "override changed background-color live");
ok(afterRadius === "20px", "override changed border-radius live");

// simulate a framework re-render: replace the whole subtree with a fresh .card
await evalJS(`document.getElementById('host').innerHTML = '<div class="card">Re-rendered</div>';`);
await sleep(150);
const reBg = await evalJS(`getComputedStyle(document.querySelector('.card')).backgroundColor`);
console.log("  after re-render:", reBg);
ok(reBg === "rgb(255, 0, 0)", "override still applies to the re-rendered element (selector-keyed CSS)");

// page removes our <style> → observer must re-add it
await evalJS(`document.getElementById('__stylelift_overrides__').remove();`);
await evalJS(`document.body.appendChild(document.createElement('span'));`); // trigger mutation
await sleep(150);
const survived = await evalJS(`!!document.getElementById('__stylelift_overrides__')`);
ok(survived, "observer re-attaches the <style> after the page removes it");

// structural ops in a real browser
await evalJS(`document.body.insertAdjacentHTML('beforeend', '<ul id="t"><li class="x">X</li><li class="y">Y</li></ul>')`);
await evalJS(`__SL__.applyStructuralOps([{selector:'#t .x', op:'duplicate'}])`);
const dupCount = await evalJS(`document.querySelectorAll('#t .x').length`);
ok(dupCount === 2, "duplicate works in a real browser");
await evalJS(`__SL__.applyStructuralOps([{selector:'#t .y', op:'delete'}])`);
const yGone = await evalJS(`!document.querySelector('#t .y')`);
ok(yGone, "delete works in a real browser");

chrome.kill();
console.log(failures ? `\n${failures} failure(s).` : "\nLive editing works in a real browser ✓");
process.exit(failures ? 1 : 0);
