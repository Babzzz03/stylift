// Screenshots of the editors as a user sees them, from the BUILT extension (dist/) in Chrome for Testing:
// the side panel's Visual editor with an element selected, the Get source code panel, and Studio (layers,
// properties of a flex row and of a text block, the Export menu, a tooltip, the projects page).
//
//   npm run build && node scripts/shoot-editors.mjs [outDir]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, globSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = process.argv[2] || join(process.cwd(), "editor-shots");
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || globSync(join(homedir(), ".cache/puppeteer/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).sort().pop();
const DIST = (process.env.SL_DIST ? join(process.cwd(), process.env.SL_DIST) : join(process.cwd(), "dist"));
if (!CHROME || !existsSync(join(DIST, "manifest.json"))) { console.error("Needs Chrome for Testing and a built dist/ (npm run build)."); process.exit(1); }
const PROFILE = mkdtempSync(join(tmpdir(), "sl-shoot-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const page = `<!doctype html><html><head><title>Northwind Studio</title><style>
body{margin:0;font:16px/1.6 system-ui;color:#1d1d1f} nav{display:flex;gap:24px;align-items:center;justify-content:space-between;padding:20px 48px;border-bottom:1px solid #eee}
nav .links{display:flex;gap:20px} .hero{padding:96px 48px;background:#f4f1ea} h1{font-size:56px;line-height:1.05;margin:0 0 16px;max-width:760px}
.hero p{max-width:560px;color:#555} .cta{display:inline-block;margin-top:20px;padding:12px 22px;border-radius:99px;background:#111;color:#fff;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:64px 48px} .card{border:1px solid #eee;border-radius:16px;overflow:hidden} .card img{width:100%;height:180px;object-fit:cover;background:#ddd;display:block} .card h3{margin:16px 20px 4px} .card p{margin:0 20px 20px;color:#666}
</style></head><body>
<nav><strong>Northwind</strong><div class="links"><a href="/work">Work</a><a href="/about">About</a><a href="/contact">Contact</a></div></nav>
<section class="hero"><h1>We design calm, fast websites for ambitious teams.</h1><p>Strategy, design and build — one small studio, from the first sketch to launch day.</p><a class="cta" href="/contact">Start a project</a></section>
<section class="grid"><article class="card"><img src="/a.png" alt=""><h3>Harbor Coffee</h3><p>A shop that sells out every Friday.</p></article><article class="card"><img src="/a.png" alt=""><h3>Fieldnotes</h3><p>A journal app with 40k writers.</p></article><article class="card"><img src="/a.png" alt=""><h3>Lumen Health</h3><p>Booking that takes one minute.</p></article></section>
</body></html>`;
// an app shell like hashnode.com: one screen tall, the content scrolls inside a box
const shell = `<!doctype html><html><head><title>Shell app</title><style>html,body{height:100%;margin:0;font:16px/1.6 system-ui;background:#0b1020;color:#e8eaf2}
.app{display:flex;height:100vh}.side{width:64px;background:#05070f}.main{flex:1;overflow:auto;padding:40px}.block{height:420px;margin:0 0 24px;border-radius:16px;background:#1b2340;display:grid;place-items:center;font-size:28px}</style></head>
<body><div class="app"><aside class="side"></aside><main class="main"><h1>Shell app</h1><div class="block">One</div><div class="block">Two</div><div class="block">Three</div><div class="block">Four</div><div class="block">Five</div></main></div></body></html>`;
const server = createServer((req, res) => { if (req.url.startsWith("/app")) { res.setHeader("content-type", "text/html"); return res.end(shell); } if (req.url.endsWith(".png")) { res.setHeader("content-type", "image/png"); return res.end(png); } res.setHeader("content-type", "text/html"); res.end(page); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const port = 9420 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", "--window-size=1440,920", "--force-device-scale-factor=1"]);
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); break; } catch { await sleep(200); } }
function cdp(ws) {
  const s = new WebSocket(ws); let id = 0; const pend = new Map();
  s.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); s.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ready: new Promise((r) => s.addEventListener("open", r)), send, ev, close: () => s.close() };
}
let sw = null, extId = "";
for (let i = 0; i < 75 && !extId; i++) {
  for (const w of (await getJSON("/json/list")).filter((t) => t.type === "service_worker" && /^chrome-extension:/.test(t.url))) {
    const c = cdp(w.webSocketDebuggerUrl); await c.ready;
    if ((await c.ev("chrome.runtime.getManifest().name")) === "StyleLift") { sw = c; extId = w.url.split("/")[2]; break; }
    c.close();
  }
  if (!extId) await sleep(200);
}
if (!extId) { console.error("StyleLift didn't load"); process.exit(1); }
const site = await getJSON(`/json/new?${encodeURIComponent(origin + "/")}`, "PUT");
await sleep(1500);
await sw.ev(`chrome.tabs.create({ url: chrome.runtime.getURL("src/panel/index.html"), active: false })`);
let pt = null;
for (let i = 0; i < 50 && !pt; i++) { pt = (await getJSON("/json/list")).find((t) => t.url.endsWith("/src/panel/index.html")); if (!pt) await sleep(200); }
const panel = cdp(pt.webSocketDebuggerUrl); await panel.ready;
await panel.send("Page.enable");
await panel.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 1100, deviceScaleFactor: 2, mobile: false });
await fetch(`http://127.0.0.1:${port}/json/activate/${site.id}`);
await sleep(600);
const shot = async (c, name, clip) => { const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64")); console.log("  ✓", name); };
const clickText = (c, t) => c.ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(t)})); if (b) b.click(); return !!b; })()`);

// 1. side panel: Visual editor with an element selected (picked through the panel's Layers tree)
await panel.ev(`document.querySelector("#edit-btn").click()`);
await sleep(500);
await clickText(panel, "Start editor");
await sleep(1500);
await panel.ev(`document.querySelector(".layers-head") && document.querySelector(".layers-head").click()`);
await sleep(1200);
await panel.ev(`(() => { const n = [...document.querySelectorAll(".layer-name")].find((b) => /hero|section/i.test(b.textContent)) || document.querySelectorAll(".layer-name")[1]; if (n) n.click(); return !!n; })()`);
await sleep(1500);
await panel.ev(`window.scrollTo(0, 0)`);
await shot(panel, "panel-visual-editor.png");

// 2. side panel: Get source code
await panel.ev(`document.querySelector("#source-btn").click()`);
await sleep(600);
await shot(panel, "panel-source.png");

// 3. Studio
await fetch(`http://127.0.0.1:${port}/json/activate/${site.id}`);
await sleep(300);
await clickText(panel, "Edit in Studio");
let st = null;
for (let i = 0; i < 100 && !st; i++) { st = (await getJSON("/json/list")).find((t) => t.url.includes("/src/studio/index.html?id=")); if (!st) await sleep(250); }
const studio = cdp(st.webSocketDebuggerUrl); await studio.ready;
await studio.send("Page.enable");
await studio.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 80; i++) { if (await studio.ev(`!!(window.__studio && window.__studio.S.frames.size === 3 && document.querySelectorAll("#layers .row").length > 3)`)) break; await sleep(250); }
await sleep(1200);
await studio.ev(`(() => { const S = window.__studio.S; const nav = S.doc.querySelector("nav"); window.__studio.select(nav.getAttribute("data-sl-id")); return true; })()`);
await sleep(800);
await shot(studio, "studio-flex-row.png");
await studio.ev(`(() => { const S = window.__studio.S; const h = S.doc.querySelector("h1"); window.__studio.select(h.getAttribute("data-sl-id")); document.querySelector(".right").scrollTop = 0; return true; })()`);
await sleep(800);
await shot(studio, "studio-text.png");
await studio.ev(`document.querySelector(".right").scrollTop = 99999`);
await sleep(300);
await shot(studio, "studio-text-lower.png");
await studio.ev(`document.querySelector("#export-btn").click()`);
await sleep(400);
await shot(studio, "studio-export-menu.png");
await studio.ev(`document.body.click()`);
// a tooltip: hover the Duplicate tile
const tileBox = await studio.ev(`(() => { document.querySelector(".right").scrollTop = 0; const b = [...document.querySelectorAll(".tile")].find((t) => /Duplicate/.test(t.textContent)).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
await sleep(200);
await studio.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tileBox.x, y: tileBox.y });
await sleep(900);
await shot(studio, "studio-tooltip.png", { x: 1040, y: 48, width: 400, height: 300 });
// the alignment tools: layout grid on, a free move in progress (guides + position), then ⌥ distances
await studio.ev(`(window.__studio.setTools({ mode: "free", grid: true, snap: true }), window.__studio.select(null), document.querySelector(".canvas").scrollTo(0, 0), true)`);
await sleep(500);
const cardPt = (i, fx, fy) => studio.ev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelectorAll(".card")[${i}].getBoundingClientRect(); return { x: fr.left + (r.left + r.width * ${fx}) * z, y: fr.top + (r.top + r.height * ${fy}) * z }; })()`);
const c1 = await cardPt(1, 0.5, 0.5);
const mm = (type, x, y, buttons, modifiers = 0) => studio.send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
await mm("mouseMoved", c1.x, c1.y, 0); await mm("mousePressed", c1.x, c1.y, 1);
for (let i = 1; i <= 10; i++) { await mm("mouseMoved", c1.x + 6 * i, c1.y + 9 * i, 1); await sleep(40); }
await sleep(300);
await shot(studio, "studio-free-move.png");
await mm("mouseReleased", c1.x + 60, c1.y + 90, 0);
await sleep(600);
await shot(studio, "studio-free-moved.png");
// ⌥ over the first card: distances
const c0 = await cardPt(0, 0.5, 0.5);
await mm("mouseMoved", c0.x, c0.y, 0, 1);
await sleep(400);
await shot(studio, "studio-measure.png", { x: 248, y: 48, width: 700, height: 420 });
await mm("mouseMoved", c0.x, c0.y + 600, 0, 0);
// the box editor on the hero heading
await studio.ev(`(() => { const S = window.__studio.S; const h = S.doc.querySelector(".hero"); window.__studio.select(h.getAttribute("data-sl-id")); const sec = [...document.querySelectorAll("#props .sec")].find((x) => /Spacing/.test(x.querySelector("h4").textContent)); document.querySelector(".right").scrollTop = sec.offsetTop - 60; return true; })()`);
await sleep(600);
await shot(studio, "studio-box-editor.png");
await studio.ev(`(window.__studio.setTools({ grid: false }), true)`);

// a hidden layer + the layer row eye
await studio.ev(`(() => { const S = window.__studio.S; const c = S.doc.querySelectorAll(".card")[1]; window.__studio.select(c.getAttribute("data-sl-id")); return true; })()`);
await sleep(300);
await studio.ev(`[...document.querySelectorAll(".tile")].find((t) => /Hide/.test(t.textContent)).click()`);
await sleep(600);
await shot(studio, "studio-hidden-layer.png", { x: 0, y: 0, width: 520, height: 600 });
// 4. Studio projects page
await studio.ev(`document.querySelector("#home-btn").click()`);
await sleep(1500);
await shot(studio, "studio-projects.png", { x: 0, y: 0, width: 1440, height: 420 });

// 5. Report a problem (panel)
await panel.ev(`document.querySelector("#report-btn").click()`);
await sleep(600);
await panel.ev(`document.querySelector(".sheet textarea").value = "The 3D scene is missing in the Live mirror."`);
await panel.ev(`document.querySelector(".sheet details").open = true`);
await sleep(300);
await shot(panel, "panel-report.png");
await panel.ev(`document.querySelector(".sheet [data-close]").click()`);

// 6. a whole site in Studio: Pages list
await panel.ev(`document.querySelector("#source-btn").click()`);
await sleep(300);
await clickText(panel, "Whole site");
await sleep(300);
await panel.ev(`(() => { const n = [...document.querySelectorAll(".src-opts input[type=number]")][0]; n.value = "4"; n.dispatchEvent(new Event("change")); return true; })()`);
await fetch(`http://127.0.0.1:${port}/json/activate/${site.id}`);
await sleep(300);
const seenT = new Set((await getJSON("/json/list")).map((t) => t.id));
await clickText(panel, "Edit site in Studio");
let st2 = null;
for (let i = 0; i < 400 && !st2; i++) { st2 = (await getJSON("/json/list")).find((t) => !seenT.has(t.id) && t.url.includes("/src/studio/index.html?id=")); if (!st2) await sleep(300); }
if (st2) {
  const s2 = cdp(st2.webSocketDebuggerUrl); await s2.ready;
  await s2.send("Page.enable");
  await s2.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 80; i++) { if (await s2.ev(`document.querySelectorAll("#pages .page-row").length > 1 && document.querySelectorAll("#layers .row").length > 3`)) break; await sleep(250); }
  await s2.ev(`document.querySelectorAll("#pages .page-row")[1].click()`);
  await sleep(1800);
  await shot(s2, "studio-site-pages.png");
  await s2.ev(`document.querySelector("#export-btn").click()`);
  await sleep(400);
  await shot(s2, "studio-site-export-menu.png", { x: 1040, y: 0, width: 400, height: 520 });
  s2.close();
}

// 7. an app shell: the fold line, the "scrolls inside a box" hint, then the whole page; a drag in progress
const siteC = cdp(site.webSocketDebuggerUrl); await siteC.ready;
await siteC.send("Page.navigate", { url: origin + "/app" });
await sleep(1800);
siteC.close();
await fetch(`http://127.0.0.1:${port}/json/activate/${site.id}`);
await sleep(300);
await panel.ev(`document.querySelector("#source-btn").click()`);
await sleep(300);
await clickText(panel, "This page");
await sleep(300);
const seen3 = new Set((await getJSON("/json/list")).map((t) => t.id));
await clickText(panel, "Edit in Studio");
let st3 = null;
for (let i = 0; i < 100 && !st3; i++) { st3 = (await getJSON("/json/list")).find((t) => !seen3.has(t.id) && t.url.includes("/src/studio/index.html?id=")); if (!st3) await sleep(250); }
if (st3) {
  const s3 = cdp(st3.webSocketDebuggerUrl); await s3.ready;
  await s3.send("Page.enable");
  await s3.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 80; i++) { if (await s3.ev(`!!(window.__studio && window.__studio.S.frames.size === 3 && document.querySelectorAll("#layers .row").length > 3)`)) break; await sleep(250); }
  await sleep(2000);
  await shot(s3, "studio-shell-before.png");
  for (let i = 0; i < 4; i++) { await s3.ev(`document.querySelector("#zoom-out").click()`); await sleep(150); }
  await sleep(500);
  await shot(s3, "studio-shell-zoomed-out.png", { x: 248, y: 48, width: 912, height: 420 });
  await s3.ev(`document.querySelector("#zoom-label").click()`); // fit again
  await sleep(500);
  await s3.ev(`(() => { const b = document.querySelector('.artboard[data-scope="base"] .ab-inner'); if (b && !b.hidden) b.click(); return !!b && !b.hidden; })()`);
  await sleep(2200);
  await s3.ev(`window.__studio.select(null)`);
  await sleep(300);
  await shot(s3, "studio-shell-after.png");
  // a drag in progress: block "Four" over block "Two"
  const p = (sel, fy) => s3.ev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = [...f.contentDocument.querySelectorAll(".block")].find((b) => b.textContent === ${JSON.stringify(sel)}).getBoundingClientRect(); return { x: fr.left + (r.left + r.width / 2) * z, y: fr.top + (r.top + r.height * ${fy}) * z }; })()`);
  const a = await p("Four", 0.5), b = await p("Two", 0.1);
  const m = (type, x, y, buttons) => s3.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  await m("mouseMoved", a.x, a.y, 0); await m("mousePressed", a.x, a.y, 1);
  for (let i = 1; i <= 8; i++) { await m("mouseMoved", a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, 1); await sleep(40); }
  await sleep(300);
  await shot(s3, "studio-drag.png", { x: 240, y: 40, width: 920, height: 620 });
  await m("mouseReleased", b.x, b.y, 0);
  await sleep(700);
  await shot(s3, "studio-after-drop.png");
  s3.close();
}

studio.close(); panel.close(); sw.close(); server.close(); chrome.kill("SIGKILL");
console.log("Screenshots in", OUT);
process.exit(0);
