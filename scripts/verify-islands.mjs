// Live 3D in an editable export ("islands"), end to end without the extension's UI:
//   a "site" with a real WebGL scene (its code in its own file, following the mouse and the scroll) is captured
//   the way the extension does (page-start recorder → capture), mirrored (its own files), and exported as an
//   editable page whose scene stays live — then opened from ANOTHER address, as a host would serve it:
//   the scene draws, the stand-in picture steps aside, the pointer over the page's own content reaches the
//   scene, scrolling keeps it in step, and the page's own files are never served from the site's copy.
//   node scripts/verify-islands.mjs
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const od = mkdtempSync(join(tmpdir(), "sl-islands-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts", intro: "src/extractor/intro-recorder.ts", mirror: "src/panel/mirror.ts", islands: "src/panel/islands.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const { capturePage } = await import(pathToFileURL(join(od, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(od, "settle.js")));
const { introRecorderSource } = await import(pathToFileURL(join(od, "intro.js")));
const { buildLiveMirror } = await import(pathToFileURL(join(od, "mirror.js")));
const { islandFiles, addIslandTag, hasIslands } = await import(pathToFileURL(join(od, "islands.js")));

// ── the site: a WebGL scene drawn by its own code (app.js), colour from the pointer and the scroll ───────
const SITE = {
  "/": `<!doctype html><html><head><meta charset="utf-8"><title>3D site</title><style>body{margin:0;font:18px sans-serif;color:#fff} #bg{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block} main{position:relative;z-index:1;pointer-events:none} main h1,main p{pointer-events:auto;display:inline-block} section{height:900px;padding:60px}</style></head><body>
<canvas id="bg"></canvas><main><section><h1 id="title">A 3D page</h1><p>Text over the scene.</p></section><section><p>More</p></section><section><p>End</p></section></main>
<script src="/js/app.js"></script></body></html>`,
  "/js/app.js": `(function(){ var c = document.getElementById("bg"); var gl = c.getContext("webgl", { preserveDrawingBuffer: true });
  var st = window.__state = { mx: -1, my: -1, sy: 0, frames: 0, got: 0, canvasDown: 0, winDown: 0, drag: 0, captured: false };
  addEventListener("mousemove", function (e) { st.mx = e.clientX; st.my = e.clientY; st.got++; });
  addEventListener("pointerdown", function () { st.winDown++; });
  // an object on the canvas: dragged with pointer capture, the way orbit controls rotate a model
  c.addEventListener("pointerdown", function (e) { st.canvasDown++; try { c.setPointerCapture(e.pointerId); st.captured = c.hasPointerCapture(e.pointerId); } catch (x) { st.captured = "error: " + x.message; } });
  c.addEventListener("pointermove", function (e) { if (e.buttons & 1) st.drag++; });
  addEventListener("scroll", function () { st.sy = scrollY; });
  var f = function () { c.width = innerWidth; c.height = innerHeight; gl.viewport(0, 0, c.width, c.height);
    gl.clearColor((st.mx < 0 ? 0.2 : st.mx / innerWidth), 0.3 + 0.4 * Math.min(1, scrollY / 1800), (Date.now() % 2000) / 2000, 1); gl.clear(gl.COLOR_BUFFER_BIT); st.frames++; requestAnimationFrame(f); };
  requestAnimationFrame(f); })();`,
  // a file at the same path as one of the export's own: the export's must win for its own pages
  "/assets/data.json": `{"from":"the site"}`,
};
const types = { ".js": "text/javascript", ".json": "application/json", ".html": "text/html", ".css": "text/css", ".png": "image/png" };
const siteSrv = createServer((q, r) => { const p = q.url.split("?")[0]; const body = SITE[p]; if (body === undefined) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": p === "/" ? "text/html" : types[extname(p)] || "application/octet-stream" }); r.end(body); });
await new Promise((r) => siteSrv.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${siteSrv.address().port}/`;

// ── Chrome (software WebGL) ─────────────────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "sl-isl-prof-"));
const port = 9720 + Math.floor(Math.random() * 40);
const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,800", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]);
const cleanup = () => { try { ch.kill("SIGKILL"); } catch {} siteSrv.close(); try { exportSrv?.close(); } catch {} setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch {} }, 500); };
process.on("exit", cleanup);
setTimeout(() => { console.log("✗ verify-islands gave up after 4 minutes"); process.exit(2); }, 240000).unref();
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(150); } }
async function tab(url, atStart) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "eval failed"); return m.result?.result?.value; };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  if (atStart) await send("Page.addScriptToEvaluateOnNewDocument", { source: atStart });
  await send("Page.navigate", { url });
  for (let i = 0; i < 80; i++) { await sleep(150); if ((await ev("document.readyState").catch(() => "")) === "complete") break; }
  return { send, ev, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
let exportSrv = null;
try {
  // ── capture, as the extension does (the page-start recorder notes the WebGL canvas) ──────────────────
  const page = await tab(siteUrl, introRecorderSource() + `\n(() => { window.__slRes = new Set(); try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__slRes.add(e.name); }).observe({ type: "resource", buffered: true }); } catch (e) {} })();`);
  await sleep(1200);
  const capJson = await page.ev(`(async function(){ (${settleAnimations.toString()})(); const r = await (${capturePage.toString()})({ maxScrollMs: 4000 }); return JSON.stringify(r); })()`);
  const r = JSON.parse(capJson);
  const resources = await page.ev(`Array.from(window.__slRes || [])`);
  page.close();
  const d = new JSDOM(r.html).window.document;
  const ph = d.querySelector("[data-sl-island]");
  ok(!!ph && ph.getAttribute("data-sl-island-kind") === "webgl" && ph.getAttribute("data-sl-island-sel") === "#bg" && hasIslands(r.html), `the WebGL canvas is marked as a live scene, its stand-in picture kept (${ph ? ph.outerHTML.replace(/src="[^"]*"/, 'src="…"').slice(0, 160) : "none"})`);
  // ── the site's own files (Live mirror) → the export's islands ──────────────────────────────────────────
  const m = await buildLiveMirror(siteUrl, SITE["/"], resources, { fetchFile: async (u) => { try { const x = await fetch(u); if (!x.ok) return null; return { bytes: new Uint8Array(await x.arrayBuffer()), type: x.headers.get("content-type") || "" }; } catch { return null; } } });
  const files = islandFiles(m, siteUrl);
  ok(!!files["_3d/island.html"] && /sl-island\.js/.test(files["_3d/island.html"]) && !/data-sl-mirror/.test(files["_3d/island.html"]) && Object.keys(files).some((k) => /^_3d\/site\/.*app\.js/.test(k)) && !!files["sl-island-sw.js"] && !!files["sl-islands.js"], `the export carries the site's own files for the scene (${Object.keys(files).length} files: ${Object.keys(files).filter((k) => !/^_3d\/site\//.test(k)).join(", ")})`);
  // the editable page itself + its own file at the same path as one of the site's
  const out = mkdtempSync(join(tmpdir(), "sl-isl-export-"));
  const all = { ...files, "index.html": addIslandTag(r.html.replace("</body>", `<script>fetch(location.origin + "/assets/data.json").then((x) => x.json()).then((j) => { window.__own = j.from; });</script></body>`)), "assets/data.json": `{"from":"the export"}` };
  for (const [k, v] of Object.entries(all)) { const f = join(out, k); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, v); }
  exportSrv = createServer((q, res) => { let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html"; const f = join(out, p); if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f)); });
  await new Promise((res) => exportSrv.listen(0, "127.0.0.1", res));
  // (127.0.0.1 counts as a secure context: service workers run, as on an https host)
  const exUrl = `http://127.0.0.1:${exportSrv.address().port}/`;
  // ── the export, opened from its own address ─────────────────────────────────────────────────────────
  const ex = await tab(exUrl);
  if (process.env.SL_DEBUG) {
    await sleep(5000);
    console.log(await ex.ev(`(async () => { const a = await fetch("/sl-islands.js"); const b = await fetch("/sl-island-sw.js"); let reg = ""; try { await navigator.serviceWorker.register("/sl-island-sw.js", { scope: "/" }); reg = "ok"; } catch (e) { reg = String(e); } return JSON.stringify({ loader: a.status + " " + a.headers.get("content-type"), sw: b.status + " " + b.headers.get("content-type"), reg, phs: document.querySelectorAll("[data-sl-island]").length }); })()`));
    console.log(await ex.ev(`(async () => { const regs = await navigator.serviceWorker.getRegistrations(); const f = document.querySelector("[data-sl-island-box] iframe"); let inner = null; try { inner = f && f.contentDocument ? { url: f.contentWindow.location.href, title: f.contentDocument.title, html: f.contentDocument.documentElement.outerHTML.slice(0, 300), isl: !!f.contentWindow.__slIsland, ready: f.contentWindow.__slIsland && f.contentWindow.__slIsland.ready(), state: f.contentWindow.__state } : null; } catch (e) { inner = String(e); } return JSON.stringify({ secure: isSecureContext, ctrl: !!navigator.serviceWorker.controller, regs: regs.map((r) => (r.active || r.installing || r.waiting || {}).scriptURL), loader: !!document.querySelector("script[data-sl-islands]"), boxes: document.querySelectorAll("[data-sl-island-box]").length, src: f && f.src, op: f && f.style.opacity, inner }, null, 1); })()`));
  }
  let live = null;
  for (let i = 0; i < 60 && !live; i++) { live = await ex.ev(`(() => { const f = document.querySelector("[data-sl-island-box] iframe"); const ph = document.querySelector("[data-sl-island]"); if (!f || f.style.opacity !== "1") return null; const w = f.contentWindow; return { frames: w.__state ? w.__state.frames : -1, ph: getComputedStyle(ph).visibility, on: !!w.document.querySelector("canvas[data-sl-island-on]"), hidden: getComputedStyle(w.document.getElementById("title")).visibility }; })()`).catch(() => null); if (!live) await sleep(400); }
  ok(!!live && live.frames > 5 && live.on && live.ph === "hidden" && live.hidden === "hidden", `the scene runs live from the site's own code, in place of its picture (${JSON.stringify(live)})`);
  await sleep(600);
  const f2 = await ex.ev(`document.querySelector("[data-sl-island-box] iframe").contentWindow.__state.frames`).catch(() => 0);
  ok(f2 > (live?.frames || 0), `…and keeps drawing (${live?.frames} → ${f2} frames)`);
  // the site hiding its canvas (out of play: visibility hidden) leaves the copy's page showing — not a black frame
  const vis = await ex.ev(`(() => { const w = document.querySelector("[data-sl-island-box] iframe").contentWindow; const c = w.document.querySelector("canvas[data-sl-island-on]"); const before = w.getComputedStyle(c).visibility; c.style.visibility = "hidden"; const after = w.getComputedStyle(c).visibility; c.style.visibility = ""; const m = w.document.querySelector("main"); return { before, after, main: w.getComputedStyle(m).visibility, bg: w.getComputedStyle(w.document.body).backgroundColor }; })()`);
  ok(vis.before === "visible" && vis.after === "hidden" && vis.main === "hidden" && /rgba\(0, 0, 0, 0\)|transparent/.test(vis.bg), `the scene shows exactly when the site shows it — the site hiding its canvas hides it in the copy too, the page around stays see-through (${JSON.stringify(vis)})`);
  // the pointer over the page's own text reaches the scene
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 120 });
  await sleep(300);
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 420 });
  await sleep(300);
  const pt = await ex.ev(`(() => { const s = document.querySelector("[data-sl-island-box] iframe").contentWindow.__state; return { mx: s.mx, my: s.my, got: s.got }; })()`);
  ok(pt.mx === 640 && pt.my === 420 && pt.got >= 2, `the pointer over the page reaches the scene (${JSON.stringify(pt)})`);
  // scrolling keeps the scene in step
  await ex.ev(`(scrollTo(0, 900), true)`);
  await sleep(400);
  const sc = await ex.ev(`(() => { const w = document.querySelector("[data-sl-island-box] iframe").contentWindow; return { parent: scrollY, scene: w.scrollY, st: w.__state.sy }; })()`);
  ok(sc.parent === 900 && sc.scene === 900 && sc.st === 900, `scrolling the page scrolls the scene with it (${JSON.stringify(sc)})`);
  const al = await ex.ev(`(() => { const ph = document.querySelector("[data-sl-island]").getBoundingClientRect(); const bx = document.querySelector("[data-sl-island-box]").getBoundingClientRect(); return [ph.left, ph.top, ph.width, ph.height, bx.left, bx.top, bx.width, bx.height].map(Math.round); })()`);
  ok(al[0] === al[4] && al[1] === al[5] && al[2] === al[6] && al[3] === al[7], `…the scene stays exactly over its place, a screen fixed to the window included (${al.join(",")})`);
  // interacting with the scene, exactly as on the site
  await ex.ev(`(scrollTo(0, 0), true)`);
  await sleep(300);
  await ex.ev(`(window.__pm = null, addEventListener("pointermove", (e) => { window.__pm = [e.clientX, e.clientY]; }), true)`);
  const st0 = await ex.ev(`(() => { const s = document.querySelector("[data-sl-island-box] iframe").contentWindow.__state; return { c: s.canvasDown, w: s.winDown }; })()`);
  const empty = { x: 900, y: 600 };
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: empty.x, y: empty.y });
  await ex.send("Input.dispatchMouseEvent", { type: "mousePressed", x: empty.x, y: empty.y, button: "left", buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 5; k++) await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: empty.x - k * 20, y: empty.y - k * 10, buttons: 1 });
  await ex.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: empty.x - 100, y: empty.y - 50, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
  const st1 = await ex.ev(`(() => { const s = document.querySelector("[data-sl-island-box] iframe").contentWindow.__state; return { c: s.canvasDown, w: s.winDown, drag: s.drag, captured: s.captured }; })()`);
  ok(st1.c === st0.c + 1 && st1.w === st0.w + 1 && st1.drag >= 4 && st1.captured === true, `pressing on the scene where nothing covers it reaches the 3D canvas itself, and a drag with pointer capture works — as on the site (${JSON.stringify(st1)})`);
  const pm = await ex.ev(`window.__pm`);
  ok(Array.isArray(pm) && pm[0] === empty.x - 100 && pm[1] === empty.y - 50, `…and the pointer used on the scene still moves through the page itself (its own effects: ${JSON.stringify(pm)})`);
  const tb = await ex.ev(`(() => { const r = document.getElementById("title").getBoundingClientRect(); return [Math.round(r.left + 20), Math.round(r.top + r.height / 2)]; })()`);
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tb[0], y: tb[1] });
  await ex.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tb[0], y: tb[1], button: "left", buttons: 1, clickCount: 1 });
  await ex.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tb[0], y: tb[1], button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
  const st2 = await ex.ev(`(() => { const s = document.querySelector("[data-sl-island-box] iframe").contentWindow.__state; return { c: s.canvasDown, w: s.winDown }; })()`);
  ok(st2.c === st1.c && st2.w === st1.w + 1, `pressing on the page's own text over the scene doesn't reach the 3D canvas, the scene's page still feels it — as on the site (${JSON.stringify(st2)})`);
  await ex.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: empty.x, y: empty.y, deltaX: 0, deltaY: 300 });
  await sleep(500);
  const wy = await ex.ev(`({ page: scrollY, scene: document.querySelector("[data-sl-island-box] iframe").contentWindow.scrollY })`);
  ok(wy.page > 0 && Math.abs(wy.page - wy.scene) <= 1, `the wheel over the scene scrolls the page, the scene in step (${JSON.stringify(wy)})`);
  await ex.ev(`(scrollTo(0, 900), true)`);
  await sleep(300);
  // moved and resized in Studio: the scene follows its stand-in, and the pointer maps into it
  await ex.ev(`(() => { const ph = document.querySelector("[data-sl-island]"); ph.style.setProperty("left", "200px", "important"); ph.style.setProperty("top", "100px", "important"); ph.style.setProperty("width", "600px", "important"); ph.style.setProperty("height", "400px", "important"); ph.style.setProperty("inset", "100px auto auto 200px", "important"); dispatchEvent(new Event("resize")); return true; })()`);
  await sleep(300);
  const mv = await ex.ev(`(() => { const ph = document.querySelector("[data-sl-island]").getBoundingClientRect(); const bx = document.querySelector("[data-sl-island-box]").getBoundingClientRect(); const f = document.querySelector("[data-sl-island-box] iframe"); return { ph: [ph.left, ph.top, ph.width, ph.height].map(Math.round), box: [bx.left, bx.top, bx.width, bx.height].map(Math.round), tf: f.style.transform }; })()`);
  await ex.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 300 });
  await sleep(300);
  const mp = await ex.ev(`(() => { const s = document.querySelector("[data-sl-island-box] iframe").contentWindow.__state; return [s.mx, s.my]; })()`);
  ok(mv.ph.join() === mv.box.join() && /scale\(0\.5, ?0\.5\)/.test(mv.tf) && mp[0] === 600 && mp[1] === 400, `moved and resized (as in Studio): the scene is drawn over its new place, scaled to it, and the pointer lands where it points (${JSON.stringify(mv)}; pointer 500,300 → ${mp.join(",")} in the scene)`);
  // the page's own files are its own
  const own = await ex.ev(`window.__own || ""`);
  ok(own === "the export", `the page's own files are never served from the site's copy (/assets/data.json → ${own})`);
  // pixels: the scene's colour shows on screen where the picture was
  const shot = await ex.send("Page.captureScreenshot", { format: "png", clip: { x: 600, y: 700, width: 4, height: 4, scale: 1 } });
  ok(!!shot.result?.data, "a screenshot of the live scene could be taken");
  ex.close();
} catch (e) {
  failures.push("run: " + e.message);
  console.log("  ✗ ERROR", e.message);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
