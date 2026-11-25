// Real-browser check of the component inspector: launches system Chrome headless,
// injects the REAL bundled picker, fires a trusted mouse click via the DevTools
// Protocol, and prints the measured blueprint + the rendered guide.
//
// Usage: node scripts/verify-live-component.mjs [url] [cssSelector]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] || "https://clerk.com";
const selector = process.argv[3] || ""; // optional; otherwise click viewport center

const outdir = mkdtempSync(join(tmpdir(), "sl-livecomp-"));
await build({
  entryPoints: { inspect: "src/extractor/inspect.ts", component: "src/panel/component.ts" },
  outdir,
  bundle: true,
  format: "iife",
  globalName: "__SL__",
  platform: "browser",
  logLevel: "silent",
});
const inspectBundle = readFileSync(join(outdir, "inspect.js"), "utf8");
await build({
  entryPoints: { component: "src/panel/component.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const C = await import(pathToFileURL(join(outdir, "component.js")));

const port = 9344;
const userDir = mkdtempSync(join(tmpdir(), "slc-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=1280,900",
]);
chrome.on("error", (e) => { console.error("Chrome launch failed:", e); process.exit(1); });

const http = async (path, method = "GET") =>
  (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json();

let version;
for (let i = 0; i < 50; i++) {
  try { version = await http("/json/version"); if (version) break; } catch { await sleep(200); }
}
if (!version) { console.error("DevTools endpoint never came up."); chrome.kill(); process.exit(1); }
console.log("Launched:", version.Browser, "\n");

let WS;
try { ({ WebSocket: WS } = await import("ws")); } catch { WS = globalThis.WebSocket; }
function connect(wsUrl) {
  const ws = new WS(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method && events.has(m.method)) events.get(m.method)(m.params);
  });
  const ready = new Promise((r) => ws.addEventListener("open", () => r()));
  return {
    ready,
    on: (m, cb) => events.set(m, cb),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id; pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
  };
}

const target = await http(`/json/new?${encodeURIComponent(url)}`, "PUT");
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
await cdp.send("Page.navigate", { url });
await Promise.race([loaded, sleep(15000)]);
await sleep(2000);

const evalJS = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval error");
  return result.value;
};

// 1) define the bundle, start the picker, and report the click target's center
const startExpr = `(() => {
  ${inspectBundle};
  window.__slP = __SL__.pickAndInspectComponent();
  const sel = ${JSON.stringify(selector)};
  let el = sel ? document.querySelector(sel) : null;
  if (!el) {
    el = document.elementFromPoint(innerWidth * 0.4, innerHeight * 0.55);
    // climb to a meaningful block so we don't pick a bare text node container
    let hops = 0;
    while (el && el.parentElement && el.getBoundingClientRect().height < 120 && hops < 6) {
      el = el.parentElement; hops++;
    }
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
})()`;
const spot = await evalJS(startExpr);
if (!spot) { console.error("No element found to inspect."); chrome.kill(); process.exit(1); }
console.log(`Clicking ${spot.tag} at (${spot.x},${spot.y}) — ${spot.w}×${spot.h}\n`);

// 2) fire a trusted move + click through CDP so the picker's listeners catch it
const mouse = (type, buttons = 0) => cdp.send("Input.dispatchMouseEvent", {
  type, x: spot.x, y: spot.y, button: type === "mouseMoved" ? "none" : "left",
  buttons, clickCount: type === "mouseMoved" ? 0 : 1,
});
await mouse("mouseMoved");
await sleep(80);
await mouse("mousePressed", 1);
await mouse("mouseReleased", 0);

// 3) await the blueprint (awaitPromise resolves window.__slP, then return by value)
const bp = await evalJS("window.__slP", true);
chrome.kill();

if (!bp) { console.error("✗ Picker resolved null (clicked body/html or extraction failed)."); process.exit(1); }

let failures = 0;
const ok = (c, l) => { console.log(`  ${c ? "✓" : "✗"} ${l}`); if (!c) failures++; };
console.log(`Blueprint: ${bp.label} · ${bp.nodeCount} nodes`);
console.log(`  techniques: ${bp.techniques.join(" | ") || "—"}`);
console.log(`  animations: ${bp.animations.length}  transitions: ${bp.transitions.length}  keyframes: ${bp.keyframes.length}  triggers: ${bp.triggers.length}  digests: ${bp.digests.length}`);
console.log(`  tokens: ${bp.tokens.colors.length} colors / ${bp.tokens.gradients.length} gradients / ${bp.tokens.radii.length} radii`);
console.log(`  assets: ${bp.assets.images.length} images / ${bp.assets.videos.length} videos / ${bp.assets.svgs.length} inline svgs`);
console.log("");
ok(bp.nodeCount >= 1, "captured a subtree");
ok(bp.html.length > 0 && !/<script/i.test(bp.html), "cleaned HTML present, scripts stripped");
ok(bp.digests.length > 0, "produced curated style digests");
ok(typeof C.renderComponentMd(bp, null) === "string", "COMPONENT.md renders");
ok(C.renderComponentCode(bp).includes("HTML"), "Code tab renders");

console.log("\n── COMPONENT.md (first 18 lines) ──");
console.log(C.renderComponentMd(bp, null).split("\n").slice(0, 18).map((l) => "  | " + l).join("\n"));

console.log(failures ? `\n${failures} failure(s).` : "\nLive component inspection succeeded ✓");
process.exit(failures ? 1 : 0);
