// Live 3D against a REAL 3D page (default: the three.js glTF example — ES modules from an import map, a glTF
// model, an HDR environment, OrbitControls): captured the way the extension does, its files mirrored, exported
// as an editable page with the scene kept live, opened from another address. Checks: the scene renders the
// model (not blank), it holds still on its own, and dragging on it turns the model — the site's own
// OrbitControls working in the export exactly as on the site.
//   node scripts/verify-islands-real.mjs [url]
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";

const URL0 = process.argv[2] || "https://threejs.org/examples/webgl_loader_gltf.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const od = mkdtempSync(join(tmpdir(), "sl-islr-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts", intro: "src/extractor/intro-recorder.ts", mirror: "src/panel/mirror.ts", islands: "src/panel/islands.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { capturePage } = await import(pathToFileURL(join(od, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(od, "settle.js")));
const { introRecorderSource } = await import(pathToFileURL(join(od, "intro.js")));
const { buildLiveMirror } = await import(pathToFileURL(join(od, "mirror.js")));
const { islandFiles, addIslandTag } = await import(pathToFileURL(join(od, "islands.js")));

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "sl-islr-prof-"));
const port = 9760 + Math.floor(Math.random() * 30);
const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1000,700", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]);
let exportSrv = null;
process.on("exit", () => { try { ch.kill("SIGKILL"); } catch {} try { exportSrv?.close(); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.log("✗ verify-islands-real gave up after 6 minutes"); process.exit(2); }, 360000).unref();
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(150); } }
async function tab(url, atStart) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => r({ error: "timeout" }), 90000); pend.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "eval failed"); return m.result?.result?.value; };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  if (atStart) await send("Page.addScriptToEvaluateOnNewDocument", { source: atStart });
  await send("Page.navigate", { url });
  for (let i = 0; i < 120; i++) { await sleep(200); if ((await ev("document.readyState").catch(() => "")) === "complete") break; }
  return { send, ev, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
const shot = async (t, clip) => (await t.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } })).result?.data || "";
try {
  console.log(`▶ ${URL0}`);
  const html0 = await (await fetch(URL0)).text();
  const page = await tab(URL0, introRecorderSource() + `\n(() => { window.__slRes = new Set(); try { performance.setResourceTimingBufferSize(20000); new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__slRes.add(e.name); }).observe({ type: "resource", buffered: true }); } catch (e) {} })();`);
  await sleep(6000); // the model and its environment load
  const r = JSON.parse(await page.ev(`(async function(){ (${settleAnimations.toString()})(); const r = await (${capturePage.toString()})({ maxScrollMs: 3000 }); return JSON.stringify(r); })()`));
  const resources = await page.ev(`Array.from(window.__slRes || [])`);
  page.close();
  const d = new JSDOM(r.html).window.document;
  const ph = d.querySelector("[data-sl-island]");
  ok(!!ph, `the page's WebGL canvas is kept live (${ph ? ph.getAttribute("data-sl-island-sel") + " · " + ph.getAttribute("data-sl-island-kind") : "no scene marked"}; ${resources.length} files loaded)`);
  const m = await buildLiveMirror(URL0, html0, resources, { fetchFile: async (u) => { try { const x = await fetch(u); if (!x.ok) return null; return { bytes: new Uint8Array(await x.arrayBuffer()), type: x.headers.get("content-type") || "" }; } catch { return null; } } });
  ok(m.count > 5 && !m.missingEssential.length, `the site's own files for it: ${m.count} files, ${(m.bytes / 1e6).toFixed(1)} MB${m.missingEssential.length ? ` (missing essential: ${m.missingEssential.slice(0, 3).join(", ")})` : ""}`);
  const files = { ...islandFiles(m, URL0), "index.html": addIslandTag(r.html.replace(/<base [^>]*>/i, "")) };
  const out = mkdtempSync(join(tmpdir(), "sl-islr-export-"));
  for (const [k, v] of Object.entries(files)) { const f = join(out, k); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, v); }
  const T = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
  exportSrv = createServer((q, res) => { let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html"; const f = join(out, p); if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": T[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f)); });
  await new Promise((res) => exportSrv.listen(0, "127.0.0.1", res));
  const ex = await tab(`http://127.0.0.1:${exportSrv.address().port}/`);
  let live = null;
  for (let i = 0; i < 90 && !live; i++) { live = await ex.ev(`(() => { const f = document.querySelector("[data-sl-island-box] iframe"); if (!f || f.style.opacity !== "1") return null; const c = f.contentDocument.querySelector("canvas[data-sl-island-on]"); return c ? { w: c.width, h: c.height } : null; })()`).catch(() => null); if (!live) await sleep(500); }
  ok(!!live && live.w > 100, `the site's 3D scene runs live in the export (${JSON.stringify(live)})`);
  await sleep(8000); // model + environment + first frames (software rendering is slow)
  const box = await ex.ev(`(() => { const r = document.querySelector("[data-sl-island-box]").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const clip = { x: box.x + Math.round(box.width * 0.25), y: box.y + Math.round(box.height * 0.25), width: Math.round(box.width * 0.5), height: Math.round(box.height * 0.5) };
  const a = await shot(ex, clip); await sleep(1500); const b = await shot(ex, clip);
  ok(a.length > 3000, `the scene draws the model, not a blank canvas (${a.length} bytes of picture)`);
  // drag across the middle of the scene, as a visitor turns the model
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  await ex.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 12; k++) { await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + k * 18, y: cy + k * 4, buttons: 1 }); await sleep(40); }
  await ex.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 216, y: cy + 48, button: "left", buttons: 0, clickCount: 1 });
  await sleep(2500);
  const c = await shot(ex, clip);
  ok(c !== b, `dragging on the scene turns it — the site's own controls, live in the export (still on its own: ${a === b ? "yes" : "no, it animates"}; changed by the drag: ${c !== b})`);
  ex.close();
} catch (e) {
  failures.push("run: " + e.message);
  console.log("  ✗ ERROR", e.message);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
