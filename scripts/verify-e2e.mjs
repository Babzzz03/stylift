// End-to-end: loads the BUILT extension (dist/) into a real (headed) Chrome — headless Chrome
// cannot render chrome-extension:// pages — opens the real
// side-panel page, and drives the "Get source code" flow by clicking its buttons —
// page HTML project, Elementor template, and a whole-site crawl of a 3-page local
// site — then unzips and inspects the downloads. Run `npm run build` first.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

// Google Chrome ≥137 ignores --load-extension, so this needs Chromium / Chrome for Testing
// (e.g. `npx @puppeteer/browsers install chrome@stable`). Override with CHROME=/path/to/binary.
import { globSync } from "node:fs";
import { homedir } from "node:os";
// throwaway Chrome profile, removed when the script exits (they are ~70 MB each)
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
const CHROME =
  process.env.CHROME ||
  globSync(join(homedir(), ".cache/puppeteer/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).sort().pop() ||
  "/Applications/Chromium.app/Contents/MacOS/Chromium";
if (!existsSync(CHROME)) { console.error("No Chromium / Chrome for Testing found. Set CHROME=/path/to/binary (Google Chrome ≥137 cannot load unpacked extensions from the command line)."); process.exit(1); }
console.log("Using", CHROME);
const DIST = (process.env.SL_DIST ? join(process.cwd(), process.env.SL_DIST) : join(process.cwd(), "dist"));
if (!existsSync(join(DIST, "manifest.json"))) { console.error("dist/ missing — run npm run build"); process.exit(1); }
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

// ── local 3-page site with lazy + appear content ───────────────────────────────
const site = {
  "/": `<!doctype html><html><head><title>Home</title><style>.hero{background:url(/bg.png)} nav a{margin:4px}</style></head><body>
    <nav><a href="/about">About</a><a href="/pricing/">Pricing</a><a href="https://example.org/x">ext</a></nav>
    <div class="hero" style="height:300px">Hero</div>
    <div id="player-host" style="display:block;width:400px;height:220px"></div>
    <script>{ const r = document.getElementById("player-host").attachShadow({ mode: "open" }); r.innerHTML = '<iframe title="Video player" src="PLAYER_HERE/player" style="width:400px;height:220px;border:0;display:block"></iframe>'; }</script>
    <div id="appear" style="opacity:0;transform:translateY(30px);will-change:transform;height:80px;margin-top:1800px">appears</div>
    <img id="lazy" loading="lazy" src="/logo.png" width="10" height="10">
    <canvas id="gl1" width="64" height="64" style="width:64px;height:64px;display:block"></canvas>
    <script>{ const g = document.getElementById("gl1").getContext("webgl", { preserveDrawingBuffer: false }); if (g) { g.clearColor(0, 0.5, 1, 1); g.clear(g.COLOR_BUFFER_BIT); } }</script>
    <canvas id="gltall" width="40" height="80" style="width:300px;height:1400px;display:block"></canvas>
    <div style="position:fixed;top:4px;right:4px;z-index:9"><canvas id="glfix" width="24" height="24" style="width:24px;height:24px;display:block"></canvas></div>
    <script>{ const t = document.getElementById("gltall").getContext("webgl"); if (t) { t.enable(t.SCISSOR_TEST); t.scissor(0, 40, 40, 40); t.clearColor(1, 0, 0, 1); t.clear(t.COLOR_BUFFER_BIT); t.scissor(0, 0, 40, 40); t.clearColor(0, 0.8, 0, 1); t.clear(t.COLOR_BUFFER_BIT); }
      const f = document.getElementById("glfix").getContext("webgl"); if (f) { f.clearColor(0.6, 0, 0.8, 1); f.clear(f.COLOR_BUFFER_BIT); } }</script>
    <script>new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){e.target.style.opacity="1";e.target.style.transform="none"}}).observe(document.getElementById("appear"));</script>
    <script src="/app.js?v=7"></script>
  </body></html>`,
  "/about": `<!doctype html><html><head><title>About</title></head><body><a href="/">Home</a><a id="abs" href="ORIGIN_HERE/pricing/">Pricing</a><section>About us</section></body></html>`,
  "/pricing/": `<!doctype html><html><head><title>Pricing</title></head><body><a href="/about">About</a><section>Plans</section><iframe title="widget" srcdoc="<script src='/widget/lib.js'></script>"></iframe></body></html>`,
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let siteHits = 0; // requests the original site receives (the live mirror must not need any)
// a "player" on another origin (cross-origin frames are pictured for where they can't run, e.g. Studio)
let playerOrigin = "";
const playerServer = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><html><body style="margin:0;background:rgb(0,170,80);height:100vh"></body></html>`); });
await new Promise((r) => playerServer.listen(0, "127.0.0.1", r));
playerOrigin = `http://127.0.0.1:${playerServer.address().port}`;
const server = createServer((req, res) => {
  siteHits++;
  const u = (req.url || "/").split("?")[0];
  if (u.endsWith(".png")) { res.setHeader("content-type", "image/png"); return res.end(png); }
  // the site's own code: a script file that loads data by relative path and by absolute URL on its own domain
  if (u === "/app.js") {
    res.setHeader("content-type", "text/javascript");
    // like vercel.com: the site's code sends visitors on another domain back to the original
    return res.end(`if (location.host !== "${req.headers.host}") location.href = "http://${req.headers.host}" + location.pathname;
document.documentElement.dataset.app = "ran";
fetch("/data/model.json?rev=2").then((r) => r.json()).then((j) => { document.documentElement.dataset.model = j.name; });
fetch("http://${req.headers.host}/data/abs.json").then((r) => r.json()).then((j) => { document.documentElement.dataset.abs = j.name; });
const host = ["${req.headers.host.split(":")[0]}", "${req.headers.host.split(":")[1]}"].join(":"); // a URL only built at run time
fetch("http://" + host + "/data/built.json").then((r) => r.json()).then((j) => { document.documentElement.dataset.built = j.name; });
try { const w = new Worker("http://${req.headers.host}/worker.js"); w.onmessage = (e) => { document.documentElement.dataset.worker = e.data; }; } catch (e) { document.documentElement.dataset.worker = "error: " + e.name; }`);
  }
  if (u === "/worker.js") { res.setHeader("content-type", "text/javascript"); return res.end(`postMessage("worker-ok");`); } // like wix.com: a worker started from the full address
  if (u === "/widget/lib.js") { res.setHeader("content-type", "text/javascript"); return res.end("window.libLoaded = 1;"); } // loaded inside an inline-HTML iframe
  if (u === "/data/model.json") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ name: "robot-v2" })); }
  if (u === "/data/built.json") { res.setHeader("content-type", "application/json"); res.setHeader("access-control-allow-origin", "*"); return res.end(JSON.stringify({ name: "built-ok" })); }
  if (u === "/data/abs.json") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ name: "abs-ok" })); }
  const body = (site[u] ?? site[u + "/"])?.replace(/ORIGIN_HERE/g, `http://${req.headers.host}`).replace(/PLAYER_HERE/g, playerOrigin); // a link that spells out the domain
  if (!body) { res.statusCode = 404; return res.end("nope"); }
  res.setHeader("content-type", "text/html"); res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ── mock WordPress with the StyleLift Importer plugin's REST routes ────────────
// (checks the application password exactly like WordPress: HTTP Basic auth)
const wpImports = [];
const WP_AUTH = "Basic " + Buffer.from("editor:abcd efgh ijkl mnop qrst uvwx").toString("base64");
const wp = createServer((req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== WP_AUTH) return send(401, { code: "incorrect_password", message: "The provided password is an invalid application password." });
  if (req.method === "GET" && req.url === "/wp-json/stylelift/v1/status") return send(200, { ok: true, site: "Test Site", user: "editor", elementor_active: true, elementor_version: "3.25.0", can_import_html: true, can_create_pages: true, plugin_version: "1.0.0" });
  if (req.method === "POST" && req.url === "/wp-json/stylelift/v1/import") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { try { const j = JSON.parse(body); wpImports.push(j); send(200, { id: 42, target: j.target, edit_url: "http://wp.test/wp-admin/post.php?post=42&action=elementor", view_url: "http://wp.test/?p=42", images_imported: 0, elementor_active: true }); } catch { send(400, { code: "stylelift_json", message: "bad json" }); } });
    return;
  }
  send(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." });
});
await new Promise((r) => wp.listen(0, "127.0.0.1", r));
const wpOrigin = `http://127.0.0.1:${wp.address().port}`;

// ── chrome with the extension ──────────────────────────────────────────────────
const port = 9336;
const downloads = mkdtempSync(join(tmpdir(), "sl-dl-"));
// the profile's own download folder, as in a real Chrome (CDP's Browser.setDownloadBehavior renames
// files saved through chrome.downloads to random ids, so the exports' names couldn't be checked)
mkdirSync(join(CHROME_PROFILE, "Default"), { recursive: true });
writeFileSync(join(CHROME_PROFILE, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
const HEADLESS = process.argv.includes("--headless");
const chrome = spawn(CHROME, [...(HEADLESS ? ["--headless=new"] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`,
  `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--window-size=1440,900"]);
// a test Chrome left running would hold the debugging port and hang the next run: always end it
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let up = false;
for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); up = true; break; } catch { await sleep(200); } }
if (!up) { console.error("Chrome never came up"); chrome.kill(); process.exit(1); }
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = new Map();
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } else if (msg.method && events.has(msg.method)) events.get(msg.method)(msg.params); });
  return { ready: new Promise((r) => ws.addEventListener("open", () => r())), on: (m, cb) => events.set(m, cb), send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }), close: () => ws.close() };
}
// find OUR extension: Chrome ships component extensions whose worker is also
// ".../background.js", so check each worker's manifest name.
let extId = "";
let sw = null;
for (let i = 0; i < 75 && !extId; i++) {
  const workers = (await getJSON("/json/list")).filter((t) => /^chrome-extension:\/\/[a-p]{32}\//.test(t.url) && t.type === "service_worker");
  for (const w of workers) {
    const c = cdpConnect(w.webSocketDebuggerUrl); await c.ready;
    const r = await c.send("Runtime.evaluate", { expression: `chrome.runtime.getManifest().name`, returnByValue: true }).catch(() => null);
    if (r?.result?.value === "StyleLift") { extId = w.url.split("/")[2]; sw = c; break; }
    c.close();
  }
  if (!extId) await sleep(200);
}
ok(!!extId, `extension loaded (${extId})`);
if (!extId) { console.error("StyleLift did not load — is this a Google Chrome ≥137 binary? Use Chromium / Chrome for Testing."); chrome.kill(); server.close(); process.exit(1); }
const browserWs = (await getJSON("/json/version")).webSocketDebuggerUrl;
const browser = cdpConnect(browserWs); await browser.ready;

// site tab (active), then ask the extension's own service worker to open the panel page
// as a tab (CDP can't navigate chrome-extension:// URLs directly).
const siteTarget = await getJSON(`/json/new?${encodeURIComponent(origin + "/")}`, "PUT");
await sleep(1500);
await sw.send("Runtime.evaluate", { expression: `chrome.tabs.create({ url: chrome.runtime.getURL("src/panel/index.html"), active: false })`, awaitPromise: true });
let panelTarget = null;
for (let i = 0; i < 50 && !panelTarget; i++) { panelTarget = (await getJSON("/json/list")).find((t) => t.url === `chrome-extension://${extId}/src/panel/index.html`); if (!panelTarget) await sleep(200); }
ok(!!panelTarget, "panel page opened as a tab");
const panel = cdpConnect(panelTarget.webSocketDebuggerUrl); await panel.ready;
await panel.send("Runtime.enable");
await sleep(800);
await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); // make the site the active tab
await sleep(300);
const ev = async (expression) => { const { result, exceptionDetails } = await panel.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval failed"); return result.value; };
const click = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error("no " + ${JSON.stringify(sel)}); b.click(); return true; })()`);
const clickText = (text) => ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error("no button " + ${JSON.stringify(text)}); b.click(); return true; })()`);
const status = () => ev(`document.querySelector("#status").textContent`);
async function waitStatus(re, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await status(); if (re.test(s)) return s; if (/error|can't|failed/i.test(s) && !/Capturing|Building|Packaging/.test(s)) return s; await sleep(300); }
  return await status();
}
const newFiles = (before) => readdirSync(downloads).filter((f) => !before.has(f) && !f.endsWith(".crdownload") && !f.startsWith(".")); // Chrome writes a hidden temp file while saving
async function waitDownload(before, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const n = newFiles(before); if (n.length) { await sleep(400); return n; } await sleep(200); }
  // nothing saved: say why (Chrome's own record of the download)
  const rec = await sw.send("Runtime.evaluate", { expression: `new Promise((r) => chrome.downloads.search({ orderBy: ["-startTime"], limit: 3 }, (l) => r(l.map((d) => ({ name: d.filename.split("/").pop(), state: d.state, danger: d.danger, error: d.error, paused: d.paused, bytes: d.bytesReceived })))))`, awaitPromise: true, returnByValue: true }).catch(() => null);
  console.log("  downloads:", JSON.stringify(rec?.result?.value));
  return [];
}
const unzip = (file) => { const dir = mkdtempSync(join(tmpdir(), "sl-unz-")); execFileSync("unzip", ["-oq", join(downloads, file), "-d", dir]); return dir; };

try {
  for (let i = 0; i < 30; i++) { if (await ev(`!!document.querySelector("#source-btn")`)) break; await sleep(300); }
  await click("#source-btn");
  await sleep(300);
  ok(await ev(`!!document.querySelector(".src-scope")`), "source-capture panel rendered");

  // 1. page → HTML project
  let before = new Set(readdirSync(downloads));
  await clickText("HTML (.zip)");
  let st = await waitStatus(/Exported|error/i);
  console.log("  status:", st);
  let files = await waitDownload(before);
  ok(/Exported HTML project: \d+ files/.test(st) && files.some((f) => f.endsWith(".html.zip")), "HTML project zip downloaded");
  if (files.length) {
    const dir = unzip(files.find((f) => f.endsWith(".html.zip")));
    const idx = readFileSync(join(dir, "index.html"), "utf8");
    const css = readFileSync(join(dir, "styles.css"), "utf8");
    ok(/<meta name="generator" content="StyleLift capture of/.test(idx), "index.html produced by the capture engine (injected via chrome.scripting)");
    // (StyleLift's own small scripts — the scroll-in trigger, the Lottie / Rive loader, the live 3D loader — are the copy's)
    ok(!/<script(?![^>]*data-sl-(motion-runtime|anim-runtime|islands))/.test(idx), `scripts stripped (StyleLift's own kept: ${(idx.match(/<script[^>]*>/g) || []).join(" ")})`);
    ok(/id="appear"[^>]*>/.test(idx) && !/id="appear"[^>]*opacity:\s*0/.test(idx), "scroll-appear element captured visible");
    ok(/id="lazy"[^>]*src="assets\/images\/logo\.png"/.test(idx), "lazy image loaded + localized into assets/");
    ok(/url\("assets\/images\/bg\.png"\)/.test(css) && existsSync(join(dir, "assets/images/bg.png")), "CSS background localized");
    ok(/href="styles\.css"|href="\.\/styles\.css"/.test(idx), "stylesheet linked");
  }

  // 1b. page → Next.js and React projects (component structure)
  for (const [label, suffix, must] of [
    ["Next.js (.zip)", ".next.zip", ["app/layout.jsx", "app/page.jsx", "app/globals.css", "package.json", "next.config.mjs"]],
    ["React (.zip)", ".react.zip", ["index.html", "src/main.jsx", "src/App.jsx", "src/styles/global.css", "package.json", "vite.config.js"]],
  ]) {
    before = new Set(readdirSync(downloads));
    await clickText(label);
    st = await waitStatus(/Exported|error/i);
    files = await waitDownload(before);
    const z = files.find((f) => f.endsWith(suffix));
    ok(!!z && /components/.test(st), `${label} downloaded (${st})`);
    if (z) {
      const dir = unzip(z);
      ok(must.every((m) => existsSync(join(dir, m))), `${label}: scaffold files present`);
      const compDir = join(dir, label.startsWith("Next") ? "components" : "src/components");
      const comps = existsSync(compDir) ? readdirSync(compDir).filter((f) => f.endsWith(".jsx")) : [];
      ok(comps.length >= 1, `${label}: section components generated (${comps.join(", ")})`);
      ok(readdirSync(join(dir, "public/assets/images")).length >= 1, `${label}: assets in public/assets/`);
    }
  }

  // 1c. Studio: capture → Edit in Studio → edit on the canvas → export
  {
    await clickText("Edit in Studio");
    st = await waitStatus(/Opened in StyleLift Studio|error/i, 150000);
    ok(/Opened in StyleLift Studio/.test(st), `Edit in Studio opened the studio (${st.slice(0, 80)})`);
    let studioT = null;
    for (let i = 0; i < 50 && !studioT; i++) { studioT = (await getJSON("/json/list")).find((t) => t.url.includes("/src/studio/index.html?id=")); if (!studioT) await sleep(200); }
    ok(!!studioT, "studio tab exists");
    const st2 = cdpConnect(studioT.webSocketDebuggerUrl); await st2.ready;
    const sev = async (expression) => { const { result, exceptionDetails } = await st2.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "studio eval failed"); return result.value; };
    const framesReady = `(() => { const s = window.__studio && window.__studio.S; if (!s || s.frames.size !== 3) return false; return [...s.frames.values()].every(f => f.contentDocument && f.contentDocument.querySelector("[data-sl-id]")); })()`;
    for (let i = 0; i < 60 && !(await sev(framesReady)); i++) await sleep(250);
    ok(await sev(framesReady), "three artboards (Desktop / Tablet / Phone) rendered the page");
    ok(await sev(`document.querySelectorAll("#layers .row").length > 3`), "layers panel lists the page structure");
    // a WebGL canvas drawn once can't be read back by the page: the panel screenshots it
    const glPx = await sev(`new Promise((res) => { const img = window.__studio.S.frames.get("base").contentDocument.querySelector("#gl1"); if (!img || img.localName !== "img") return res("no img"); const done = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0); const d = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data; res([...d].join(",")); }; img.complete ? done() : (img.onload = done); })`);
    { const [r, g, b, a] = String(glPx).split(",").map(Number); ok(r <= 8 && g >= 120 && g <= 136 && b >= 248 && a === 255, `WebGL canvas drawn once comes through as its on-screen pixels (${glPx})`); }
    const px = (sel, fx, fy) => sev(`new Promise((res) => { const img = window.__studio.S.frames.get("base").contentDocument.querySelector(${JSON.stringify(sel)}); if (!img || img.localName !== "img") return res("no img"); const done = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0); const d = g.getImageData(Math.floor(c.width * ${fx}), Math.floor(c.height * ${fy}), 1, 1).data; res([...d].join(",")); }; img.complete ? done() : (img.onload = done); })`);
    const top = String(await px("#gltall", 0.5, 0.25)).split(",").map(Number), bottom = String(await px("#gltall", 0.5, 0.75)).split(",").map(Number);
    ok(top[0] > 240 && top[1] < 20 && bottom[1] > 180 && bottom[0] < 20, `a WebGL canvas taller than the screen is stitched from strips (top ${top.join(",")}, bottom ${bottom.join(",")})`);
    const fx = String(await px("#glfix", 0.5, 0.5)).split(",").map(Number);
    ok(fx[0] > 140 && fx[1] < 20 && fx[2] > 190, `a WebGL icon in a fixed header comes through (${fx.join(",")})`);
    // the player (in a shadow root, from another origin) can't run on an artboard: its picture shows instead
    const pl = await sev(`new Promise((res) => { const d = window.__studio.S.frames.get("base").contentDocument; let f = null; const walk = (r) => { f = f || r.querySelector("iframe[data-sl-poster]"); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); if (!f) return res({ found: false }); const bg = f.ownerDocument.defaultView.getComputedStyle(f).backgroundImage; const m = /url\\("(data:image[^"]+)"\\)/.exec(bg); if (!m || f.getAttribute("src")) return res({ found: true, bg: bg.slice(0, 40), src: f.getAttribute("src") }); const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0); res({ found: true, px: [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].join(","), w: Math.round(f.getBoundingClientRect().width) }); }; img.onerror = () => res({ found: true, bad: true }); img.src = m[1]; })`);
    const pp = String(pl.px || "").split(",").map(Number);
    ok(pl.found && pp[1] > 140 && pp[0] < 40 && pp[2] < 120 && pl.w > 300, `an embedded player inside a shadow root shows its picture on the artboard (${JSON.stringify(pl)})`);
    // select the hero through the Layers panel (a real click)
    await sev(`(() => { const r = [...document.querySelectorAll("#layers .row")].find(r => /^Hero$/.test(r.querySelector(".nm").textContent)); r.click(); return true; })()`);
    ok(await sev(`!!document.querySelector("#props .prop-head") && /Hero/.test(document.querySelector("#props .prop-head strong").textContent)`), "selecting a layer opens its properties");
    ok(await sev(`[...window.__studio.S.frames.values()].every(f => f.contentDocument.querySelector("[data-sl-sel]"))`), "selection highlighted in every artboard");
    // switch to Tablet and set a colour through the Color field
    await sev(`document.querySelector('.scope-tab[data-scope="tablet"]').click(), true`);
    await sev(`(() => { const f = [...document.querySelectorAll("#props .field")].find(f => f.querySelector("label").textContent === "Color"); const i = f.querySelector('input:not([type=color])'); i.value = "rgb(255, 0, 0)"; i.dispatchEvent(new Event("change")); return true; })()`);
    const colors = await sev(`(() => { const S = window.__studio.S; const out = {}; for (const [k, f] of S.frames) { const el = f.contentDocument.querySelector("[data-sl-sel]"); out[k] = f.contentWindow.getComputedStyle(el).color; } return out; })()`);
    ok(colors.tablet === "rgb(255, 0, 0)" && colors.phone === "rgb(255, 0, 0)" && colors.base !== "rgb(255, 0, 0)", `Tablet edit applies to Tablet + Phone, not Desktop (${JSON.stringify(colors)})`);
    // edit the text through the Content box
    await sev(`(() => { const t = [...document.querySelectorAll("#props .sec")].find(s => s.querySelector("h4").textContent === "Content").querySelector("textarea"); t.value = "Hero edited"; t.dispatchEvent(new Event("change")); return true; })()`);
    const texts = await sev(`[...window.__studio.S.frames.values()].map(f => f.contentDocument.querySelector("[data-sl-sel]").textContent)`);
    ok(texts.every((t) => t === "Hero edited"), "text change mirrored into all three artboards");
    await sev(`document.querySelector("#undo-btn").click(), true`); await sleep(400);
    const afterUndo = await sev(`[...window.__studio.S.frames.values()][0].contentDocument.querySelector('[data-sl-id="' + window.__studio.S.sel + '"]').textContent`);
    await sev(`document.querySelector("#redo-btn").click(), true`); await sleep(400);
    const afterRedo = await sev(`[...window.__studio.S.frames.values()][0].contentDocument.querySelector('[data-sl-id="' + window.__studio.S.sel + '"]').textContent`);
    ok(/^Hero/.test(afterUndo) && afterUndo !== "Hero edited" && afterRedo === "Hero edited", `undo / redo (${afterUndo} → ${afterRedo})`);
    await sleep(900); // autosave debounce
    // reload: the project and its edits persist
    await st2.send("Page.reload"); await sleep(1500);
    for (let i = 0; i < 60 && !(await sev(framesReady)); i++) await sleep(250);
    ok(await sev(`(() => { const S = window.__studio.S; return Object.keys(S.edits).length >= 1 && /Hero edited/.test(S.html); })()`), "edits and text survive a reload (saved project)");
    // export Next.js from the studio
    before = new Set(readdirSync(downloads));
    await sev(`document.querySelector("#export-btn").click(), document.querySelector('[data-export="next"]').click(), true`);
    files = await waitDownload(before, 60000);
    const sz = files.find((f) => f.endsWith(".next.zip"));
    ok(!!sz, "Next.js export downloaded from the studio");
    if (sz) {
      const dir = unzip(sz);
      const css = readFileSync(join(dir, "app/globals.css"), "utf8");
      const code = readdirSync(join(dir, "components")).map((f) => readFileSync(join(dir, "components", f), "utf8")).join("") + readFileSync(join(dir, "app/page.jsx"), "utf8");
      ok(/@media \(max-width: 1199\.98px\)[\s\S]*color: rgb\(255, 0, 0\) !important/.test(css), "exported CSS carries the Tablet edit");
      ok(/Hero edited/.test(code) && /data-sl-id="\d+"/.test(code), "exported components carry the edited text and its style hook");
    }
    // exports from Studio go through a REAL click on its Export menu: Chrome blocks a page's second,
    // third… download unless each one follows a click (as a user's always does)
    const studioExport = async (kind) => {
      const box = async (sel) => sev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const click = async (p) => { await st2.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await st2.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 }); await st2.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 }); await sleep(250); };
      await click(await box("#export-btn"));
      await click(await box(`[data-export="${kind}"]`));
    };
    // drag and drop + artboard size — with the real mouse (CDP input), like a user
    {
      const mouse = async (type, x, y, buttons = 0, modifiers = 0) => st2.send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
      const drag = async (a, b, modifiers = 0) => { await mouse("mouseMoved", a.x, a.y, 0, modifiers); await mouse("mousePressed", a.x, a.y, 1, modifiers); for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, 1, modifiers); await sleep(40); } await mouse("mouseReleased", b.x, b.y, 0, modifiers); await sleep(500); };
      ok((await sev(`window.__studio.UI.mode`)) === "free", "dragging moves things freely by default (Free move)");
      await sev(`(window.__studio.setTools({ mode: "reorder" }), true)`);
      await sev(`(window.__studio.select(null), document.querySelector(".canvas").scrollTo(0, 0), true)`);
      await sleep(300);
      // canvas: drag the hero above the navigation
      const heroPt = await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelector(".hero").getBoundingClientRect(); return { x: fr.left + (r.left + r.width * 0.5) * z, y: fr.top + (r.top + r.height * 0.5) * z }; })()`);
      const navPt = await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelector("nav").getBoundingClientRect(); return { x: fr.left + (r.left + r.width * 0.5) * z, y: fr.top + (r.top + r.height * 0.1) * z }; })()`);
      await drag(heroPt, navPt);
      const order = await sev(`[...window.__studio.S.doc.body.children].filter((e) => e.hasAttribute("data-sl-id")).slice(0, 2).map((e) => e.localName + (e.className ? "." + e.className : ""))`);
      ok(order[0] === "div.hero" && order[1] === "nav", `dragging an element on the canvas moves it (${order.join(", ")})`);
      const framesAgree = await sev(`[...window.__studio.S.frames.values()].every((f) => f.contentDocument.body.querySelector("[data-sl-id]").classList.contains("hero"))`);
      ok(framesAgree, "the move shows on every artboard");
      // layers: drag the nav row back above the hero row (HTML drag and drop)
      await sev(`(() => { const rows = [...document.querySelectorAll("#layers .row")]; const nav = rows.find((r) => /^Navigation|^nav/i.test(r.querySelector(".nm").textContent)) || rows.find((r) => r.querySelector(".nm").textContent === "nav"); const hero = rows.find((r) => /^Hero/.test(r.querySelector(".nm").textContent)); const dt = new DataTransfer(); const rr = hero.getBoundingClientRect(); nav.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); hero.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.left + 20, clientY: rr.top + 2 })); hero.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.left + 20, clientY: rr.top + 2 })); nav.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt })); return true; })()`);
      await sleep(400);
      const order2 = await sev(`[...window.__studio.S.doc.body.children].filter((e) => e.hasAttribute("data-sl-id")).slice(0, 2).map((e) => e.localName)`);
      ok(order2[0] === "nav" && order2[1] === "div", `dragging a row in the Layers panel moves the layer (${order2.join(", ")})`);
      // free move: drag the hero 30 px right and 20 px down (⌘ held: no snapping), with the real mouse
      await sev(`(window.__studio.setTools({ mode: "free", snap: true }), document.querySelector(".canvas").scrollTo(0, 0), true)`);
      const z = await sev(`window.__studio.S.zoom`);
      const hp = await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelector(".hero").getBoundingClientRect(); return { x: fr.left + (r.left + r.width * 0.3) * z, y: fr.top + (r.top + r.height * 0.5) * z }; })()`);
      await drag(hp, { x: hp.x + 30, y: hp.y + 20 }, 4);
      const tr = await sev(`(() => { const S = window.__studio.S; const id = S.doc.querySelector(".hero").getAttribute("data-sl-id"); return { sel: S.sel === id, t: (S.edits[id] && S.edits[id].base && S.edits[id].base.translate) || "" }; })()`);
      const [tx, ty] = tr.t.split(" ").map((v) => parseFloat(v));
      ok(tr.sel && Math.abs(tx - 30 / z) <= 2 && Math.abs(ty - 20 / z) <= 2, `Free move: dragging places the element where it's dropped (translate ${tr.t}, expected ≈ ${Math.round(30 / z)}px ${Math.round(20 / z)}px at ${Math.round(z * 100)}% zoom)`);
      const inFrame = await sev(`getComputedStyle(window.__studio.S.frames.get("tablet").contentDocument.querySelector(".hero")).translate`);
      ok(inFrame === tr.t, `the new position shows on the other artboards (Desktop edits apply everywhere: ${inFrame})`);
      // snapping: drag it back near where it started; the snap pulls it onto the page's own edges
      await sev(`document.querySelector("#undo-btn").click(), true`);
      await sleep(400);
      ok(!(await sev(`(() => { const S = window.__studio.S; const id = S.doc.querySelector(".hero").getAttribute("data-sl-id"); return (S.edits[id] && S.edits[id].base && S.edits[id].base.translate) || ""; })()`)), "undo puts it back");
      // arrow keys nudge in Free move
      await sev(`(window.__studio.select(window.__studio.S.doc.querySelector(".hero").getAttribute("data-sl-id")), document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.focus(), true)`);
      for (const key of ["ArrowRight", "ArrowRight", "ArrowDown"]) { await st2.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: key === "ArrowRight" ? 39 : 40 }); await st2.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: key === "ArrowRight" ? 39 : 40 }); }
      await sleep(300);
      ok((await sev(`(() => { const S = window.__studio.S; const id = S.doc.querySelector(".hero").getAttribute("data-sl-id"); return S.edits[id].base.translate; })()`)) === "2px 1px", "arrow keys nudge the selection 1 px at a time");
      // the margin / padding box: set a top margin, see it on the canvas
      await sev(`(() => { const i = document.querySelector(".boxm > .bm-top"); i.value = "24"; i.dispatchEvent(new Event("change")); return true; })()`);
      await sleep(400);
      const mt = await sev(`(() => { const S = window.__studio.S; const id = S.sel; return { edit: S.edits[id].base.marginTop, marks: S.frames.get("base").contentDocument.querySelectorAll("#__sl_box > div").length }; })()`);
      ok(mt.edit === "24px" && mt.marks >= 1, `the box editor sets a margin, drawn on the canvas (${JSON.stringify(mt)})`);
      // ⌥ + hover: the distance to another element
      const navMid = await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelector("nav").getBoundingClientRect(); return { x: fr.left + (r.left + r.width * 0.5) * z, y: fr.top + (r.top + r.height * 0.5) * z }; })()`);
      await mouse("mouseMoved", navMid.x, navMid.y, 0, 1);
      await sleep(300);
      const meas = await sev(`[...window.__studio.S.frames.get("base").contentDocument.querySelectorAll("#__sl_measure > div")].map((d) => d.textContent).filter(Boolean)`);
      ok(meas.length >= 1 && meas.every((t) => /^\d+$/.test(t)), `holding ⌥ over another element shows the distance (${meas.join(", ")} px)`);
      await mouse("mouseMoved", navMid.x, navMid.y + 400, 0, 0);
      // the layout grid
      await sev(`document.querySelector("#grid-btn").click(), true`);
      await sleep(300);
      const cols = await sev(`(() => { const g = document.querySelector('.artboard[data-scope="base"] .ab-grid'); return g.hidden ? -1 : g.children.length; })()`);
      ok(cols === 12, `the layout grid shows 12 columns on Desktop (${cols})`);
      await sev(`document.querySelector("#grid-btn").click(), true`);
      // artboard height: drag the fold line down
      const before = await sev(`window.__studio.sizeOf("base").h`);
      const fold = await sev(`(() => { const r = document.querySelector('.artboard[data-scope="base"] .ab-fold').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 }; })()`);
      await drag(fold, { x: fold.x, y: fold.y + 60 });
      await sleep(600);
      const after = await sev(`({ h: window.__studio.sizeOf("base").h, w: window.__studio.sizeOf("base").w })`);
      ok(Math.abs(after.h - (before + 60 / z)) <= 3 && after.w === 1440, `dragging the fold line sets the artboard's height; the width stays 1440 (${before} → ${after.h} px)`);
      // artboard: type a screen height in the Artboard panel
      await sev(`(() => { window.__studio.select(null); const i = [...document.querySelectorAll(".ab-sec .field")].find((f) => f.querySelector("label").textContent === "Height").querySelector("input"); i.value = "1200"; i.dispatchEvent(new Event("change")); return true; })()`);
      await sleep(800);
      const h = await sev(`({ h: window.__studio.sizeOf("base").h, tag: document.querySelector('.artboard[data-scope="base"] .ab-fold-tag').textContent, f: Number(window.__studio.S.frames.get("base").height) })`);
      ok(h.h === 1200 && h.tag === "1200" && h.f >= 1200, `the Artboard panel sets the screen height (${JSON.stringify(h)})`);
      await sev(`[...document.querySelectorAll(".ab-sec .mini")].find((b) => /Reset/.test(b.textContent)).click(), true`);
      await sleep(600);
      ok((await sev(`JSON.stringify(window.__studio.sizeOf("base"))`)) === JSON.stringify({ w: 1440, h: 900 }), "Reset puts the artboard back to 1440 × 900");
    }

    // the right-click menu, like Figma's — with the real mouse; every change must reach the exported code
    {
      await sev(`(window.__studio.setScope("base"), window.__studio.setTools({ mode: "free" }), document.querySelector(".canvas").scrollTo(0, 0), true)`);
      await sleep(300);
      const at = (sel, n = 0) => sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelectorAll(${JSON.stringify(sel)})[${n}].getBoundingClientRect(); return { x: fr.left + (r.left + r.width * 0.4) * z, y: fr.top + (r.top + r.height * 0.5) * z }; })()`);
      const rclick = async (p) => { await st2.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await st2.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "right", buttons: 2, clickCount: 1 }); await st2.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "right", buttons: 0, clickCount: 1 }); await sleep(250); };
      const pick = (label) => sev(`(() => { const b = [...document.querySelectorAll(".cm .cm-item")].find((x) => x.querySelector(".cm-label").textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
      const heroId = await sev(`window.__studio.S.doc.querySelector(".hero").getAttribute("data-sl-id")`);
      const ed = (prop) => sev(`((window.__studio.S.edits[${JSON.stringify(heroId)}] || {}).base || {})[${JSON.stringify(prop)}] || ""`);
      await rclick(await at(".hero"));
      const labels = await sev(`[...document.querySelectorAll(".cm .cm-item .cm-label")].map((l) => l.textContent)`);
      ok(["Copy", "Paste after", "Select layer", "Bring to front", "Send to back", "Group selection", "Ungroup", "Flip horizontal", "Delete"].every((l) => labels.includes(l)), `right-click opens the menu (${labels.length} actions)`);
      ok(await pick("Bring to front"), "Bring to front runs");
      const zs = await sev(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; const h = d.querySelector(".hero"); return { me: parseInt(getComputedStyle(h).zIndex) || 0, others: Math.max(0, ...[...h.parentElement.children].filter((n) => n !== h).map((n) => parseInt(getComputedStyle(n).zIndex) || 0)) }; })()`);
      ok(zs.me > zs.others && (await ed("zIndex")) === String(zs.me) && (await ed("position")) === "relative", `Bring to front = z-index above every sibling (${zs.me} > ${zs.others})`);
      await rclick(await at(".hero"));
      await pick("Flip horizontal");
      ok((await ed("scale")) === "-1 1", "Flip horizontal = scale -1 1");
      await rclick(await at(".hero"));
      await pick("Copy");
      await rclick(await at(".hero"));
      ok(await pick("Paste after"), "Paste after runs");
      const heroes = await sev(`(() => { const S = window.__studio.S; const h = [...S.doc.querySelectorAll(".hero")]; return { n: h.length, copyZ: h[1] && ((S.edits[h[1].getAttribute("data-sl-id")] || {}).base || {}).zIndex, sel: S.sel === (h[1] && h[1].getAttribute("data-sl-id")) }; })()`);
      ok(heroes.n === 2 && heroes.copyZ === String(zs.me) && heroes.sel, `Copy + Paste makes a copy with its styles, selected (${JSON.stringify(heroes)})`);
      await rclick(await at(".hero", 1));
      await pick("Hide on Desktop");
      ok(await sev(`(() => { const S = window.__studio.S; const h = S.doc.querySelectorAll(".hero")[1]; return S.edits[h.getAttribute("data-sl-id")].base.display === "none"; })()`), "Hide = display: none");
      await rclick(await at(".hero"));
      await pick("Group selection");
      ok(await sev(`window.__studio.S.doc.querySelector(".hero").parentElement.getAttribute("data-name") === "Group"`), "Group selection wraps it in a Group container");
      // rename from the menu: the Layers row becomes a text field
      await rclick(await at(".hero"));
      await pick("Rename");
      await sleep(200);
      await sev(`(() => { const i = document.querySelector("#layers .rename"); i.value = "Hero Banner"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
      ok(await sev(`window.__studio.S.doc.querySelector(".hero").getAttribute("data-name") === "Hero Banner"`), "Rename sets the layer's name");
      // lock: canvas clicks go to what's around it
      const navId = await sev(`window.__studio.S.doc.querySelector("nav").getAttribute("data-sl-id")`);
      await rclick(await at("nav"));
      await pick("Lock");
      const np = await at("nav");
      await st2.send("Input.dispatchMouseEvent", { type: "mousePressed", x: np.x, y: np.y, button: "left", buttons: 1, clickCount: 1 });
      await st2.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: np.x, y: np.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(250);
      ok((await sev(`window.__studio.S.project.locked.includes(${JSON.stringify(navId)})`)) && (await sev(`window.__studio.S.sel`)) !== navId, "a locked layer can't be picked on the canvas");
      await sev(`(window.__studio.toggleLock(${JSON.stringify(navId)}), true)`);
      // keyboard: ⇧H flips it back
      await sev(`(window.__studio.select(${JSON.stringify(heroId)}), document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
      await st2.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "H", code: "KeyH", modifiers: 8, windowsVirtualKeyCode: 72 });
      await st2.send("Input.dispatchKeyEvent", { type: "keyUp", key: "H", code: "KeyH", modifiers: 8, windowsVirtualKeyCode: 72 });
      await sleep(250);
      ok((await ed("scale")) === "", "⇧H flips it back (scale cleared)");
      await st2.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "H", code: "KeyH", modifiers: 8, windowsVirtualKeyCode: 72 });
      await st2.send("Input.dispatchKeyEvent", { type: "keyUp", key: "H", code: "KeyH", modifiers: 8, windowsVirtualKeyCode: 72 });
      await sleep(250);
      // export: every change is in the code
      before = new Set(readdirSync(downloads));
      await studioExport("html");
      files = await waitDownload(before, 60000);
      const hz = files.find((f) => f.endsWith(".html.zip"));
      ok(!!hz, "HTML export downloaded from the studio after the menu actions");
      if (hz) {
        const dir = unzip(hz);
        const html = readFileSync(join(dir, "index.html"), "utf8");
        const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") + html;
        ok(new RegExp(`z-index: ${zs.me} !important`).test(css) && /position: relative !important/.test(css), "export: Bring to front (z-index)");
        ok(/scale: -1 1 !important/.test(css), "export: Flip horizontal (scale)");
        ok(/display: none !important/.test(css), "export: the hidden copy (display: none)");
        ok((html.match(/Hero edited/g) || []).length === 2, "export: the pasted copy is in the page");
        ok(/data-name="Group"[^>]*>\s*<div[^>]*class="hero"[^>]*data-name="Hero Banner"|data-name="Group"[\s\S]{0,200}data-name="Hero Banner"/.test(html), "export: the Group wrapper and the new name");
      }
    }

    // the toolbar: draw a rectangle, a line, a pencil stroke, type text, insert a button — then export
    {
      const key = async (code, k, shift = false) => { await st2.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key: k, modifiers: shift ? 8 : 0 }); await st2.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, modifiers: shift ? 8 : 0 }); await sleep(120); };
      const fpt = (X, Y) => sev(`(() => { const S = window.__studio.S, fr = S.frames.get("base").getBoundingClientRect(), z = S.zoom; return { x: fr.left + ${X} * z, y: fr.top + ${Y} * z }; })()`);
      const m = (type, p, buttons = 0, modifiers = 0) => st2.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, modifiers, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
      const stroke = async (pts) => { await m("mouseMoved", pts[0]); await m("mousePressed", pts[0], 1); for (const p of pts.slice(1)) { await m("mouseMoved", p, 1); await sleep(30); } await m("mouseReleased", pts[pts.length - 1]); await sleep(400); };
      await sev(`(window.__studio.select(null), window.__studio.setScope("base"), document.activeElement && document.activeElement.blur && document.activeElement.blur(), document.querySelector(".canvas").scrollTo(0, 0), true)`);
      ok(await sev(`document.querySelectorAll("#toolbar .tool").length >= 8`), "the toolbar shows its tools");
      const z = await sev(`window.__studio.S.zoom`);
      // rectangle: R, then drag
      await key("KeyR", "r");
      ok((await sev(`document.body.dataset.tool`)) === "rect", "R picks the Rectangle tool");
      const a = await fpt(1000, 120), b = await fpt(1200, 220);
      await stroke([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b]);
      const rect = await sev(`(() => { const S = window.__studio.S; const el = S.doc.querySelector('[data-name="Rectangle"]'); if (!el) return null; const e = S.edits[el.getAttribute("data-sl-id")].base; return { w: parseFloat(e.width), h: parseFloat(e.height), pos: e.position, bg: e.backgroundColor, tool: document.body.dataset.tool, sel: S.sel === el.getAttribute("data-sl-id") }; })()`);
      ok(rect && Math.abs(rect.w - 200) <= 4 && Math.abs(rect.h - 100) <= 4 && rect.pos === "absolute" && rect.bg === "#d9d9d9", `dragging draws a rectangle where it's drawn (${JSON.stringify(rect)})`);
      ok(rect && rect.tool === "move" && rect.sel, "after drawing, the Move tool is back and the new rectangle is selected");
      // resize handles: drag the bottom-right corner
      const hpt = (h) => sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const k = f.contentDocument.querySelector('#__sl_handles [data-sl-handle="${h}"]'); if (!k) return null; const r = k.getBoundingClientRect(); return { x: fr.left + (r.left + r.width / 2) * z, y: fr.top + (r.top + r.height / 2) * z }; })()`);
      await sleep(300);
      const se = await hpt("se");
      ok(!!se, "the selection shows resize handles");
      if (se) {
        await stroke([se, { x: se.x + 15, y: se.y + 10 }, { x: se.x + 30, y: se.y + 20 }]);
        const sz = await sev(`(() => { const S = window.__studio.S; const el = S.doc.querySelector('[data-name="Rectangle"]'); const e = S.edits[el.getAttribute("data-sl-id")].base; return { w: parseFloat(e.width), h: parseFloat(e.height) }; })()`);
        ok(Math.abs(sz.w - (200 + 30 / z)) <= 4 && Math.abs(sz.h - (100 + 20 / z)) <= 4, `dragging a corner resizes it (${Math.round(sz.w)} × ${Math.round(sz.h)})`);
      }
      // line: L, then drag
      await key("KeyL", "l");
      await stroke([await fpt(1000, 300), await fpt(1100, 320), await fpt(1200, 350)]);
      ok(await sev(`!!window.__studio.S.doc.querySelector('svg[data-name="Line"] path[d^="M"]')`), "L + drag draws a line (an SVG path)");
      // pencil: ⇧P, then a freehand stroke
      await key("KeyP", "P", true);
      ok((await sev(`document.body.dataset.tool`)) === "pencil", "⇧P picks the Pencil");
      const pts = []; for (let i = 0; i <= 12; i++) pts.push(await fpt(1000 + i * 15, 420 + Math.sin(i / 2) * 30));
      await stroke(pts);
      ok(await sev(`/Q/.test((window.__studio.S.doc.querySelector('svg[data-name="Drawing"] path') || { getAttribute: () => "" }).getAttribute("d"))`), "the Pencil draws a smooth freehand path");
      // text: T, click, type
      await key("KeyT", "t");
      const tp = await fpt(1000, 520);
      await m("mouseMoved", tp); await m("mousePressed", tp, 1); await m("mouseReleased", tp); await sleep(400);
      await st2.send("Input.insertText", { text: "Hello there" });
      await sleep(200);
      await key("Escape", "Escape");
      await sleep(400);
      ok(await sev(`(window.__studio.S.doc.querySelector('p[data-name="Text"]') || {}).textContent === "Hello there"`), "T + click adds text you type straight away");
      // text: a corner scales the text itself
      await sev(`(window.__studio.select(window.__studio.S.doc.querySelector('p[data-name="Text"]').getAttribute("data-sl-id")), true)`);
      let tse = null;
      for (let i = 0; i < 15 && !tse; i++) { await sleep(200); tse = await hpt("se"); }
      if (tse) {
        await stroke([tse, { x: tse.x + 10, y: tse.y + 5 }, { x: tse.x + 20, y: tse.y + 10 }]);
        const fs = await sev(`(() => { const S = window.__studio.S; const el = S.doc.querySelector('p[data-name="Text"]'); return parseFloat(S.edits[el.getAttribute("data-sl-id")].base.fontSize); })()`);
        ok(fs > 26, `dragging a text's corner makes the text bigger (24 px → ${fs} px)`);
      } else ok(false, "text shows resize handles");
      // insert a button into the page's flow
      await sev(`(window.__studio.select(window.__studio.S.doc.querySelector(".hero").getAttribute("data-sl-id")), window.__studio.insertWidget(window.__studio.WIDGETS.find((w) => w.label === "Button")), true)`);
      await sleep(400);
      ok(await sev(`(() => { const b = window.__studio.S.doc.querySelector('a[data-name="Button"]'); return !!b && b.previousElementSibling && b.previousElementSibling.classList.contains("hero"); })()`), "Insert → Button puts a button in the page's flow, after the selection");
      // pinch (ctrl + wheel) over an artboard zooms the canvas
      const zp = await fpt(700, 300);
      await st2.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: zp.x, y: zp.y, deltaX: 0, deltaY: -50, modifiers: 2 });
      await sleep(300);
      const z2 = await sev(`window.__studio.S.zoom`);
      ok(z2 > z * 1.3, `pinching over an artboard zooms in (${Math.round(z * 100)}% → ${Math.round(z2 * 100)}%)`);
      await sev(`document.querySelector("#zoom-label").click(), true`);
      // Animate: the typed text comes in word by word as it scrolls into view (picked in the panel)
      await sev(`(window.__studio.select(window.__studio.S.doc.querySelector('[data-name="Text"]').getAttribute("data-sl-id")), true)`);
      await sleep(300);
      const animSec = `[...document.querySelectorAll("#props .sec")].find((s) => s.querySelector("h4 span") && s.querySelector("h4 span").textContent === "Animate")`;
      ok(await sev(`!!(${animSec})`), "the properties panel has an Animate section");
      await sev(`(() => { const t = (${animSec}).querySelector("select"); t.value = "enter"; t.dispatchEvent(new Event("change")); return true; })()`);
      await sleep(500);
      const am = await sev(`(() => { const id = window.__studio.S.sel; const sec = ${animSec}; const f = window.__studio.S.frames.get("base").contentDocument.querySelector('[data-sl-id="' + id + '"]'); return { fx: sec.querySelectorAll("select")[1] && sec.querySelectorAll("select")[1].value, on: f.ownerDocument.defaultView.getComputedStyle(f).getPropertyValue("--slm-on").trim(), anims: f.getAnimations({ subtree: true }).map((a) => a.animationName).join(), badge: !!document.querySelector("#layers .row.selected .row-motion") }; })()`);
      ok(am.on === "enter" && am.fx === "words" && /slm-words/.test(am.anims), `Trigger → Scroll into view: a text layer gets "word by word", playing on the artboard (${JSON.stringify(am)})`);
      ok(am.badge, "the layer shows an animation badge in Layers");
      // a loop on the rectangle, and a picture dropped onto the artboard
      await sev(`(window.__studio.setMotion(window.__studio.S.doc.querySelector('[data-name="Rectangle"]').getAttribute("data-sl-id"), { on: "loop", fx: "float", dur: 2800, delay: 0, ease: "inout", dist: 10, stagger: 0, replay: false }), true)`);
      const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBDAYGBgYAP7cH+UH/hIAAAAAASUVORK5CYII=";
      await sev(`(window.__studio.placeImage(window.__studio.S.frames.get("base").contentDocument, "base", 400, 300, ${JSON.stringify(PNG)}, 200, 120), true)`);
      await sleep(400);
      ok(await sev(`window.__studio.S.doc.querySelectorAll('img[data-name="Image"]').length >= 1`), "a dropped picture lands on the artboard as an Image layer");
      // export
      before = new Set(readdirSync(downloads));
      await studioExport("html");
      files = await waitDownload(before, 60000);
      const tz = files.find((f) => /\.html( \(\d+\))?\.zip$/.test(f)); // a second export of the same page is saved as "… (1).zip"
      if (tz) {
        const dir = unzip(tz);
        const html = readFileSync(join(dir, "index.html"), "utf8");
        const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") + html;
        ok(/data-name="Rectangle"/.test(html) && /background-color: #d9d9d9 !important/.test(css) && /position: absolute !important/.test(css), "export: the drawn rectangle, positioned and filled");
        ok(new RegExp(`<iframe[^>]*src="${playerOrigin}/player"[^>]*data-sl-poster`).test(html) || new RegExp(`<iframe[^>]*data-sl-poster[^>]*src="${playerOrigin}/player"`).test(html), "export: the embedded player stays a live embed (its picture behind it)");
        ok(/<svg[^>]*data-name="Line"[\s\S]*?<path d="M/.test(html) && /stroke: #111111 !important/.test(css), "export: the line (SVG path and its stroke)");
        ok(/data-name="Drawing"/.test(html), "export: the pencil drawing");
        ok(/Hello there/.test(html), "export: the typed text");
        ok(/data-name="Button"[^>]*>Get started/.test(html) && /border-radius: 999px !important/.test(css), "export: the inserted button and its style");
        ok(/@keyframes slm-words/.test(css) && /--slm-on: enter !important/.test(css) && /<script data-sl-motion-runtime/.test(html), "export: the word-by-word entrance (keyframes, trigger script)");
        ok(/@keyframes slm-loop-float/.test(css), "export: the rectangle's float loop");
        ok(/<img[^>]*data-name="Image"/.test(html), "export: the dropped picture");
      } else ok(false, `HTML export after drawing (new files: ${JSON.stringify(files)}; studio says: ${await sev(`(document.querySelector("#toast") || {}).textContent || ""`)})`);
      // Inspect: the selected layer's code, exactly as exported
      await sev(`(window.__studio.select(window.__studio.S.doc.querySelector('[data-name="Rectangle"]').getAttribute("data-sl-id")), document.querySelector('#panel-tabs [data-tab="inspect"]').click(), true)`);
      await sleep(400);
      const insp = await sev(`[...document.querySelectorAll("#props pre.code")].map((p) => p.textContent).join("\\n---\\n")`);
      ok(/background-color: #d9d9d9 !important/.test(insp) && /position: absolute !important/.test(insp) && /data-name="Rectangle"/.test(insp), "Inspect shows the selected layer's exported CSS and HTML");
      await sev(`document.querySelector('#panel-tabs [data-tab="design"]').click(), true`);
      // several layers at once: ⇧-click, align, space evenly, move together, nudge, marquee, Esc, group
      {
        const mouse = async (type, x, y, buttons = 0, modifiers = 0) => st2.send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
        const drag = async (a, b, modifiers = 0) => { await mouse("mouseMoved", a.x, a.y, 0, modifiers); await mouse("mousePressed", a.x, a.y, 1, modifiers); for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, 1, modifiers); await sleep(40); } await mouse("mouseReleased", b.x, b.y, 0, modifiers); await sleep(500); };
        // (the rectangle's float loop from the Animate check would keep it moving: off first)
        await sev(`(window.__studio.setMotion(window.__studio.S.doc.querySelector('[data-name="Rectangle"]').getAttribute("data-sl-id"), null), window.__studio.setTools({ mode: "free" }), window.__studio.select(null), document.querySelector(".canvas").scrollTo(0, 0), true)`);
        await sleep(400);
        // three fresh layers of their own (earlier steps grouped, flipped and drew over things): three small
        // pictures dropped side by side on empty space, so they're siblings, apart, and nothing covers them
        const PNG3 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBDAYGBgYAP7cH+UH/hIAAAAAASUVORK5CYII=";
        const before3 = await sev(`[...window.__studio.S.doc.querySelectorAll("[data-sl-id]")].length`);
        for (const [x, y] of [[1150, 620], [1250, 760], [1180, 1080]]) { // (clear of the fold line at 900 px, a Studio control on top)
          await sev(`(window.__studio.placeImage(window.__studio.S.frames.get("base").contentDocument, "base", ${x}, ${y}, ${JSON.stringify(PNG3)}, 90, 60), true)`);
          await sleep(250);
        }
        const names = await sev(`(() => { const S = window.__studio.S; const ids = [...S.doc.querySelectorAll('img[data-name="Image"]')].slice(-3).map((e) => e.getAttribute("data-sl-id")); ids.forEach((id, i) => { S.doc.querySelector('[data-sl-id="' + id + '"]').setAttribute("data-name", "Multi" + (i + 1)); for (const f of S.frames.values()) { const e = f.contentDocument.querySelector('[data-sl-id="' + id + '"]'); if (e) e.setAttribute("data-name", "Multi" + (i + 1)); } }); return ids.map((_, i) => "Multi" + (i + 1)); })()`);
        await sev(`(window.__studio.select(null), true)`);
        await sleep(300);
        const ptOf = (n) => sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom; const r = f.contentDocument.querySelector('[data-name="${n}"]').getBoundingClientRect(); return { x: fr.left + (r.left + r.width / 2) * z, y: fr.top + (r.top + r.height / 2) * z }; })()`);
        const tap = async (p, modifiers = 0) => { await mouse("mouseMoved", p.x, p.y, 0, modifiers); await mouse("mousePressed", p.x, p.y, 1, modifiers); await mouse("mouseReleased", p.x, p.y, 0, modifiers); await sleep(250); };
        const boxes = () => sev(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; return ${JSON.stringify(names)}.map((n) => { const r = d.querySelector('[data-name="' + n + '"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; }); })()`);
        await sev(`document.querySelector(".canvas").scrollTo(0, 0)`);
        // bring the three into view on the canvas (CDP clicks must land inside the window)
        await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), z = S.zoom; const r = f.contentDocument.querySelector('[data-name="${names[0]}"]').getBoundingClientRect(); const c = document.querySelector(".canvas"); const fr = f.getBoundingClientRect(), cr = c.getBoundingClientRect(); c.scrollBy(0, fr.top + r.top * z - cr.top - 120); return true; })()`);
        await sleep(300);
        await sev(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; window.__mlog = []; for (const t of ["mousedown", "click"]) d.addEventListener(t, (e) => window.__mlog.push(t + ":" + ((e.target.getAttribute && e.target.getAttribute("data-name")) || e.target.localName) + (e.shiftKey ? "+shift" : "")), true); document.addEventListener("click", (e) => window.__mlog.push("studio-click:" + (e.target.id || e.target.className || e.target.localName)), true); return true; })()`);
        const pts3 = [];
        for (const n of names) pts3.push(await ptOf(n));
        // (earlier steps can leave a text layer being typed into: end that first, as a user would)
        await sev(`(() => { for (const f of window.__studio.S.frames.values()) { const a = f.contentDocument.activeElement; if (a && a.blur) a.blur(); f.contentDocument.querySelectorAll("[contenteditable='true']").forEach((e) => e.removeAttribute("contenteditable")); } if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.__studio.select(null); return true; })()`);
        await sleep(300);
        const selAfter = [];
        const nowSel = () => sev(`window.__studio.selection().map((id) => window.__studio.S.doc.querySelector('[data-sl-id="' + id + '"]').getAttribute("data-name")).join("+")`);
        await tap(pts3[0]); selAfter.push(await nowSel());
        await tap(pts3[1], 8); selAfter.push(await nowSel());
        await tap(pts3[2], 8); selAfter.push(await nowSel());
        await sleep(200);
        const ms = await sev(`({ n: window.__studio.selection().length, names: window.__studio.selection().map((id) => { const e = window.__studio.S.doc.querySelector('[data-sl-id="' + id + '"]'); return e.getAttribute("data-name") || e.localName; }), head: (document.querySelector("#props .prop-head strong") || {}).textContent, box: window.__studio.S.frames.get("base").contentDocument.querySelectorAll("#__sl_multi > *").length, rows: document.querySelectorAll("#layers .row.selected").length, scope: window.__studio.S.scope })`);
        ok(names.length === 3 && ms.n === 3 && ms.head === "3 layers" && ms.box > 0 && ms.rows === 3, `⇧-click selects several layers (shown together on the canvas, in Layers and the panel: ${JSON.stringify({ picked: names, ...ms, at: pts3.map((p) => [Math.round(p.x), Math.round(p.y)]), win: await sev("[innerWidth, innerHeight]"), log: await sev("window.__mlog"), after: selAfter })})`);
        if (ms.n !== 3) await sev(`(window.__studio.selectMany([...window.__studio.S.doc.querySelectorAll('[data-name^="Multi"]')].map((e) => e.getAttribute("data-sl-id"))), true)`); // carry on with the rest
        const tileAt = (label) => sev(`(() => { const t = [...document.querySelectorAll("#props .tile")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await tap(await tileAt("Left"));
        let b = await boxes();
        ok(Math.max(...b.map((x) => x.l)) - Math.min(...b.map((x) => x.l)) < 1.5, `Align → Left lines up their left edges (${b.map((x) => Math.round(x.l)).join(", ")})`);
        await tap(await tileAt("Space down"));
        b = (await boxes()).sort((p, q) => p.t - q.t);
        const gaps = [b[1].t - (b[0].t + b[0].h), b[2].t - (b[1].t + b[1].h)];
        ok(Math.abs(gaps[0] - gaps[1]) < 2, `Space down spaces them evenly (gaps ${gaps.map((g) => Math.round(g)).join(" / ")} px)`);
        // drag one: all three move by the same amount (⌘: no snapping)
        const before = await boxes();
        const zz = await sev(`window.__studio.S.zoom`);
        const rp = await ptOf(names[0]);
        await drag(rp, { x: rp.x + 40, y: rp.y + 30 }, 4);
        await sleep(300);
        const after = await boxes();
        const moved = after.map((a, i) => [a.l - before[i].l, a.t - before[i].t]);
        ok(moved.every(([dx, dy]) => Math.abs(dx - 40 / zz) < 3 && Math.abs(dy - 30 / zz) < 3) && (await sev(`window.__studio.selection().length`)) === 3, `dragging one moves them all together (${moved.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" · ")})`);
        await sev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
        await st2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 8 });
        await st2.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 8 });
        await sleep(300);
        const nud = (await boxes()).map((a, i) => a.l - after[i].l);
        ok(nud.every((d) => Math.abs(d - 10) < 1), `⇧→ nudges them all 10 px (${nud.map((d) => Math.round(d)).join(", ")})`);
        // marquee: drag a box from empty space; it selects the outermost layers wholly inside it
        await sev(`(window.__studio.select(null), true)`);
        const mq = await sev(`(() => { const S = window.__studio.S, f = S.frames.get("base"), fr = f.getBoundingClientRect(), z = S.zoom, d = f.contentDocument; const rs = ${JSON.stringify(names)}.map((n) => d.querySelector('[data-name="' + n + '"]').getBoundingClientRect()); const L = Math.min(...rs.map((r) => r.left)) - 6, T = Math.min(...rs.map((r) => r.top)) - 6, R = Math.max(...rs.map((r) => r.right)) + 6, B = Math.max(...rs.map((r) => r.bottom)) + 6; return { a: { x: fr.left + 1430 * z, y: fr.top + Math.max(B + 40, 1400) * z }, b: { x: fr.left + L * z, y: fr.top + T * z }, startOnBody: (d.elementFromPoint(1430, Math.max(B + 40, 1400)) || {}).localName, L, T, R: 1430, B: Math.max(B + 40, 1400) }; })()`);
        await drag(mq.a, mq.b);
        await sleep(300);
        const got = await sev(`(() => { const S = window.__studio.S, d = S.frames.get("base").contentDocument; const ids = window.__studio.selection(); const want = ${JSON.stringify(names)}.map((n) => S.doc.querySelector('[data-name="' + n + '"]').getAttribute("data-sl-id")); const inside = ids.every((id) => { const r = d.querySelector('[data-sl-id="' + id + '"]').getBoundingClientRect(); return r.left >= ${mq.L} - 1 && r.top >= ${mq.T} - 1 && r.right <= ${mq.R} + 1 && r.bottom <= ${mq.B} + 1; }); return { n: ids.length, all: want.every((w) => ids.includes(w)), inside }; })()`);
        ok(mq.startOnBody === "body" && got.all && got.inside, `dragging a box on empty space selects what's wholly inside it (${got.n} layers; started on ${mq.startOnBody})`);
        await st2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await sleep(200);
        ok((await sev(`window.__studio.selection().length`)) === 1, "Esc keeps just the first");
        // group the three (they share a container: one wrapper; otherwise a clear message)
        const same = await sev(`(() => { const S = window.__studio.S; const els = ${JSON.stringify(names)}.map((n) => S.doc.querySelector('[data-name="' + n + '"]')); window.__studio.selectMany(els.map((e) => e.getAttribute("data-sl-id"))); return els.every((e) => e.parentElement === els[0].parentElement); })()`);
        await sev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
        await st2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "g", code: "KeyG", windowsVirtualKeyCode: 71, modifiers: 4 });
        await sleep(400);
        const grp = await sev(`(() => { const S = window.__studio.S; const g = S.doc.querySelector('[data-sl-id="' + S.sel + '"]'); return { name: g && g.getAttribute("data-name"), kids: g ? ${JSON.stringify(names)}.filter((n) => g.querySelector(':scope > [data-name="' + n + '"]')).length : 0, toast: (document.querySelector("#toast") || {}).textContent || "" }; })()`);
        ok(same ? grp.name === "Group" && grp.kids === 3 : /same container/.test(grp.toast), `⌘G groups the selection (${same ? `${grp.kids} layers in one Group` : "not in one container: says so"})`);
        if (same) {
          await st2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4 });
          await sleep(400);
          ok(await sev(`!window.__studio.S.doc.querySelector('[data-name="Group"] > [data-name="${names[0]}"]')`), "undo takes the group away again");
        }
        await sev(`(window.__studio.select(null), true)`);
      }
      // ? opens the shortcuts list
      await sev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
      await st2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "?", code: "Slash", text: "?", modifiers: 8 });
      await sleep(300);
      ok(await sev(`!!document.querySelector(".keys-card")`), "? opens the keyboard shortcuts list");
      await sev(`(document.querySelector(".keys-card [data-no]") && document.querySelector(".keys-card [data-no]").click(), true)`);
    }
    st2.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${studioT.id}`).catch(() => {});
    await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); // back to the website tab
    await sleep(400);
  }

  // 2. page → Elementor
  before = new Set(readdirSync(downloads));
  await clickText("Elementor");
  st = await waitStatus(/Exported|error/i);
  files = await waitDownload(before);
  const ej = files.find((f) => f.endsWith(".elementor.json"));
  ok(!!ej, "Elementor json downloaded");
  if (ej) {
    const t = JSON.parse(readFileSync(join(downloads, ej), "utf8"));
    ok(t.version === "0.4" && t.content.length >= 2 && t.content.every((c) => c.elType === "container"), `Elementor template valid (${t.content.length} containers)`);
  }

  // 2b. Send to WordPress: connect, pick one section, send
  await ev(`chrome.storage.local.set({ wpSite: ${JSON.stringify(wpOrigin)}, wpUser: "editor", wpAppPassword: "abcd efgh ijkl mnop qrst uvwx" }).then(() => true)`);
  await clickText("Send to WordPress");
  for (let i = 0; i < 240 && !(await ev(`!!document.querySelector(".wp-picker")`)); i++) await sleep(250);
  const secLabels = await ev(`[...document.querySelectorAll(".wp-picker .wp-sections span")].map(s => s.textContent)`);
  ok(Array.isArray(secLabels) && secLabels.length >= 2, `section picker lists the page's sections (${(secLabels || []).length}: ${(secLabels || []).join(" | ").slice(0, 120)})`);
  const heroIdx = (secLabels || []).findIndex((l) => /Hero/.test(l));
  await clickText("None");
  await sleep(150);
  await ev(`(document.querySelectorAll(".wp-picker .wp-sections input")[${heroIdx}].click(), true)`);
  await sleep(150);
  await clickText("Send 1 section");
  for (let i = 0; i < 120 && !(await ev(`!!document.querySelector(".wp-picker a[href*='action=elementor']") || !!document.querySelector(".wp-picker .wp-error")`)); i++) await sleep(250);
  const sent = wpImports[wpImports.length - 1];
  ok(!!sent && sent.target === "template" && sent.template_type === "section" && Array.isArray(sent.content), "import request sent with the application password, as a section template");
  if (sent) {
    const htmls = sent.content.map((c) => c.elements[0].settings.html);
    const scope = (htmls.join("").match(/class="(sl-scope-[a-z0-9]+)/) || [])[1];
    ok(sent.content.length === 2 && /Hero/.test(htmls[1]) && !/appears/.test(htmls.join("")), "only the picked section was sent (plus its styles)");
    ok(!!scope && new RegExp(`\\.${scope} \\.hero\\{`).test(htmls[0]), "its CSS is scoped so it can't restyle the rest of the WordPress site");
  }
  ok(await ev(`!!document.querySelector(".wp-picker a[href*='action=elementor']")`), "the panel links straight to the new template in Elementor");

  // 3. whole site → site project
  await clickText("Whole site");
  await sleep(200);
  await ev(`(() => { const i = [...document.querySelectorAll(".src-opts input[type=number]")]; i[0].value = "10"; i[0].dispatchEvent(new Event("change")); return true; })()`);
  before = new Set(readdirSync(downloads));
  await clickText("HTML site");
  st = await waitStatus(/Exported|error/i, 120000);
  console.log("  status:", st);
  files = await waitDownload(before);
  const sz = files.find((f) => f.endsWith(".site.zip"));
  ok(/Exported 3 page\(s\)/.test(st) && !!sz, "site project zip downloaded with all 3 pages");
  if (sz) {
    const dir = unzip(sz);
    ok(existsSync(join(dir, "index.html")) && existsSync(join(dir, "about/index.html")) && existsSync(join(dir, "pricing/index.html")), "one folder per crawled page");
    const home = readFileSync(join(dir, "index.html"), "utf8");
    const about = readFileSync(join(dir, "about/index.html"), "utf8");
    ok(/href="about\/index\.html"/.test(home) && /href="pricing\/index\.html"/.test(home), "internal links rewritten on the home page");
    ok(/href="\.\.\/index\.html"/.test(about), "nested page links back with ../");
    ok(/href="https:\/\/example\.org\/x"/.test(home), "external link untouched");
    ok(existsSync(join(dir, "styles/index.css")) && existsSync(join(dir, "styles/about.css")), "per-page stylesheets");
    ok(/<meta name="generator" content="StyleLift capture of/.test(about), "crawled pages captured through the capture window");
  }
  // 4. whole site → Next.js (one route per page)
  before = new Set(readdirSync(downloads));
  const prevStatus = await status(); // the HTML site's "Exported 3 page(s)…" is still showing: wait for the new one
  await clickText("Next.js site");
  st = prevStatus;
  for (const t0 = Date.now(); st === prevStatus && Date.now() - t0 < 120000; ) { await sleep(300); st = await waitStatus(/Exported|error/i, 120000); }
  files = await waitDownload(before, 60000);
  const nz = files.find((f) => f.endsWith(".site.nextjs.zip"));
  ok(/Exported 3 page\(s\)/.test(st) && !!nz, "Next.js site zip downloaded with all 3 pages");
  if (nz) {
    const dir = unzip(nz);
    ok(["app/page.jsx", "app/about/page.jsx", "app/pricing/page.jsx", "app/layout.jsx"].every((f) => existsSync(join(dir, f))), "one Next.js route per crawled page");
    const homeComps = readdirSync(join(dir, "components")).join(",");
    ok(/Home/.test(homeComps) && /About/.test(homeComps) && /Pricing/.test(homeComps), `components grouped per page (${homeComps})`);
    const homeCode = readdirSync(join(dir, "components/Home")).map((f) => readFileSync(join(dir, "components/Home", f), "utf8")).join("") + readFileSync(join(dir, "app/page.jsx"), "utf8");
    ok(/href="\/about\/"/.test(homeCode) && /href="\/pricing\/"/.test(homeCode), "internal links rewritten to Next.js routes");
  }

  // 4b. whole site → Studio: one project, a Pages list, each page edited on its own, exported together
  {
    await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`);
    await sleep(300);
    const seen = new Set((await getJSON("/json/list")).map((t) => t.id));
    await clickText("Edit site in Studio");
    st = await waitStatus(/Opened \d+ pages in StyleLift Studio|error/i, 150000);
    ok(/Opened 3 pages in StyleLift Studio/.test(st), `Edit site in Studio opened all 3 pages (${st.slice(0, 80)})`);
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { t = (await getJSON("/json/list")).find((x) => !seen.has(x.id) && x.url.includes("/src/studio/index.html?id=")); if (!t) await sleep(250); }
    if (t) {
      const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
      const sv = async (e) => { const { result, exceptionDetails } = await c.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "studio eval failed"); return result.value; };
      const frameText = `(() => { const S = window.__studio && window.__studio.S; if (!S || S.frames.size !== 3) return ""; const d = S.frames.get("base").contentDocument; return d && d.body ? d.body.textContent : ""; })()`;
      for (let i = 0; i < 60 && !(await sv(`document.querySelectorAll("#pages .page-row").length === 3 && /Hero/.test(${frameText})`)); i++) await sleep(250);
      const rows = await sv(`[...document.querySelectorAll("#pages .page-row .nm")].map((n) => n.textContent)`);
      ok(rows.length === 3 && rows.join(",") === "Home,About,Pricing", `the Pages list shows every page (${rows.join(", ")})`);
      // open About from the Pages list, change its text
      await sv(`[...document.querySelectorAll("#pages .page-row")].find((r) => /About/.test(r.textContent)).click()`);
      let about = "";
      for (let i = 0; i < 60 && !/About us/.test(about); i++) { await sleep(250); about = await sv(frameText); }
      ok(/About us/.test(about) && !/Hero/.test(about), "clicking a page opens it on the canvas");
      await sv(`(() => { const S = window.__studio.S; const sec = [...S.doc.querySelectorAll("section")].find((x) => /About us/.test(x.textContent)); window.__studio.select(sec.getAttribute("data-sl-id")); window.__studio.setText("About the team"); return true; })()`);
      // back to Home, style the hero; then About again: its edit is still there
      await sv(`[...document.querySelectorAll("#pages .page-row")].find((r) => /Home/.test(r.textContent)).click()`);
      let home = "";
      for (let i = 0; i < 60 && !/Hero/.test(home); i++) { await sleep(250); home = await sv(frameText); }
      await sv(`(() => { const S = window.__studio.S; const h = S.doc.querySelector(".hero"); window.__studio.select(h.getAttribute("data-sl-id")); window.__studio.setStyle("color", "rgb(1, 2, 3)"); return true; })()`);
      await sv(`[...document.querySelectorAll("#pages .page-row")].find((r) => /About/.test(r.textContent)).click()`);
      about = "";
      for (let i = 0; i < 60 && !/About the team/.test(about); i++) { await sleep(250); about = await sv(frameText); }
      ok(/About the team/.test(about), "an edit on one page is kept when you switch pages and come back");
      // export the whole site from Studio
      before = new Set(readdirSync(downloads));
      await sv(`(window.__studio.exportAs("site-html"), true)`);
      files = await waitDownload(before, 120000);
      const zz = files.find((f) => f.endsWith(".studio-site.zip"));
      ok(!!zz, "Studio exports the whole site (HTML site .zip)");
      if (zz) {
        const dir = unzip(zz);
        ok(["index.html", "about/index.html", "pricing/index.html"].every((f) => existsSync(join(dir, f))), "the Studio site export has every page");
        ok(/About the team/.test(readFileSync(join(dir, "about/index.html"), "utf8")), "the About page carries its text edit");
        const homeAll = readFileSync(join(dir, "index.html"), "utf8") + (existsSync(join(dir, "styles/index.css")) ? readFileSync(join(dir, "styles/index.css"), "utf8") : "");
        ok(/rgb\(1, 2, 3\)|#010203/i.test(homeAll), "the Home page carries its style edit");
        ok(/href="about\/index\.html"/.test(readFileSync(join(dir, "index.html"), "utf8")), "links between the pages still work in the Studio export");
      }
      c.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    }
  }

  // 5. Live mirror: the site's real code + files, served locally, so its scripts (3D, interactions) run
  await clickText("This page");
  await sleep(200);
  await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`);
  await sleep(300);
  before = new Set(readdirSync(downloads));
  await clickText("Live mirror");
  st = await waitStatus(/Live mirror downloaded|error/i, 120000);
  console.log("  status:", st);
  files = await waitDownload(before, 60000);
  const mz = files.find((f) => f.endsWith("-live-mirror.zip"));
  ok(/Live mirror downloaded/.test(st) && !!mz, "live mirror zip downloaded");
  if (mz) {
    const dir = unzip(mz);
    const man = existsSync(join(dir, "mirror-manifest.json")) ? JSON.parse(readFileSync(join(dir, "mirror-manifest.json"), "utf8")) : { paths: {} };
    const appFile = man.paths["/app.js?v=7"] || "";
    ok(["server.mjs", "package.json", "README.md", "site/index.html", "site/logo.png", "site/bg.png", appFile].every((f) => f && existsSync(join(dir, f))), `mirror holds the page, its script file (${appFile}), its images and the server`);
    const idx = readFileSync(join(dir, "site/index.html"), "utf8");
    ok(/<script src="\/app\.js\?v=7"><\/script>/.test(idx) && /getContext\("webgl"/.test(idx), "the page keeps its own scripts (original HTML, not the snapshot)");
    ok(!!man.paths["/data/model.json?rev=2"] && !!man.paths["/data/abs.json"], "files the page's code fetched at run time were recorded and downloaded");
    const servedApp = await (await fetch(`${origin}/app.js?v=7`)).text();
    ok(!!appFile && readFileSync(join(dir, appFile), "utf8") === servedApp, "the site's code is stored byte for byte (never edited)");
    ok(existsSync(join(dir, "sl-mirror-sw.js")), "mirror ships its service worker");
    // make it yours: a rule in stylelift-custom.css restyles the running site
    writeFileSync(join(dir, "site/stylelift-custom.css"), readFileSync(join(dir, "site/stylelift-custom.css"), "utf8") + "\n#appear { color: rgb(1, 2, 3); }\n");
    const mport = 4500 + Math.floor(Math.random() * 300);
    const srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(mport) } });
    await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
    const hitsBefore = siteHits;
    const mt = await getJSON(`/json/new?${encodeURIComponent(`http://127.0.0.1:${mport}/`)}`, "PUT");
    const mc = cdpConnect(mt.webSocketDebuggerUrl); await mc.ready;
    let ran = null;
    for (let i = 0; i < 40; i++) {
      const r = await mc.send("Runtime.evaluate", { expression: `({ app: document.documentElement.dataset.app, model: document.documentElement.dataset.model, abs: document.documentElement.dataset.abs, built: document.documentElement.dataset.built, gl: !!document.getElementById("gl1"), sw: !!navigator.serviceWorker.controller })`, returnByValue: true }).catch(() => null);
      ran = r?.result?.value; if (ran?.model && ran?.abs && ran?.built) break; await sleep(250);
    }
    ok(ran?.app === "ran" && ran?.model === "robot-v2" && ran?.abs === "abs-ok" && ran?.gl, `the mirror runs the site's own code and loads its data locally (${JSON.stringify(ran)})`);
    ok(ran?.sw && ran?.built === "built-ok", "the service worker serves a URL the code built at run time from the mirror");
    let worker = null;
    for (let i = 0; i < 20 && !worker; i++) { worker = (await mc.send("Runtime.evaluate", { expression: `document.documentElement.dataset.worker`, returnByValue: true }).catch(() => null))?.result?.value; if (!worker) await sleep(250); }
    ok(worker === "worker-ok", `a background worker the site starts from its full address runs from the mirror (${worker})`);
    const restyled = (await mc.send("Runtime.evaluate", { expression: `getComputedStyle(document.getElementById("appear")).color`, returnByValue: true }).catch(() => null))?.result?.value;
    ok(restyled === "rgb(1, 2, 3)", `a rule added to stylelift-custom.css restyles the running mirror (${restyled})`);
    ok(siteHits === hitsBefore, `the running mirror never calls the original site (${siteHits - hitsBefore} requests)`);
    mc.close(); await fetch(`http://127.0.0.1:${port}/json/close/${mt.id}`).catch(() => {});
    srv.kill();
  }

  // 5b. Preview, no deploy: the panel opens the export in a tab at a private .test address and answers
  // every request from the files it holds (Chrome's debugger), then a style edit shows on reload
  if (mz) {
    const hitsBefore = siteHits;
    const t0 = new Set((await getJSON("/json/list")).map((t) => t.id));
    await clickText("Preview");
    let pt = null;
    for (let i = 0; i < 50 && !pt; i++) { pt = (await getJSON("/json/list")).find((t) => !t0.has(t.id) && t.type === "page" && /stylelift\.test/.test(t.url)); if (!pt) await sleep(200); }
    ok(!!pt && /^https:\/\/127-0-0-1\.stylelift\.test\//.test(pt.url), `Preview opens a tab at a private .test address (${pt && pt.url})`);
    if (pt) {
      const pc = cdpConnect(pt.webSocketDebuggerUrl); await pc.ready;
      const pv = async (e) => (await pc.send("Runtime.evaluate", { expression: e, returnByValue: true }).catch(() => null))?.result?.value;
      await pv(`(() => { const i = new Image(); i.onload = () => { window.__slImg = i.naturalWidth; }; i.onerror = () => { window.__slImg = -1; }; i.src = "/logo.png"; return true; })()`);
      let ran = null;
      for (let i = 0; i < 60; i++) { ran = await pv(`({ app: document.documentElement.dataset.app, model: document.documentElement.dataset.model, abs: document.documentElement.dataset.abs, built: document.documentElement.dataset.built, worker: document.documentElement.dataset.worker, host: location.host, img: window.__slImg })`); if (ran?.model && ran?.abs && ran?.built && ran?.worker && ran?.img) break; await sleep(250); }
      ok(ran?.host === "127-0-0-1.stylelift.test" && ran?.app === "ran" && ran?.model === "robot-v2" && ran?.abs === "abs-ok" && ran?.built === "built-ok", `the preview runs the site's own code and its data from the export (${JSON.stringify(ran)})`);
      ok(ran?.worker === "worker-ok", `a background worker runs in the preview (${ran?.worker})`);
      ok(ran?.img === 1, `an image loads in the preview from the export (${ran?.img}px wide)`);
      ok(siteHits === hitsBefore, `the preview never calls the original site (${siteHits - hitsBefore} requests)`);
      // your styles: edit in the panel, the preview reloads with them
      await ev(`(() => { const d = document.querySelector(".ready-css"); d.open = true; d.querySelector("textarea").value += " #appear { color: rgb(4, 5, 6); }"; return true; })()`);
      await clickText("Apply and reload the preview");
      let col = "";
      for (let i = 0; i < 40 && col !== "rgb(4, 5, 6)"; i++) { await sleep(250); col = await pv(`document.getElementById("appear") ? getComputedStyle(document.getElementById("appear")).color : ""`); }
      ok(col === "rgb(4, 5, 6)", `a style edited in the panel shows in the preview after Apply (${col})`);
      await clickText("Stop preview");
      await sleep(500);
      ok(await ev(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Preview")`), "Stop preview ends it (the Preview button is back)");
      pc.close(); await fetch(`http://127.0.0.1:${port}/json/close/${pt.id}`).catch(() => {});
    }
  }

  // 6. whole site → one live mirror: every page with its own original HTML, files shared
  await clickText("Whole site");
  await sleep(200);
  await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`);
  await sleep(300);
  before = new Set(readdirSync(downloads));
  await ev(`(document.querySelector("#status").textContent = "", true)`); // the page-mode export left its own message
  await clickText("Live mirror");
  st = await waitStatus(/Live mirror downloaded|error/i, 180000);
  console.log("  status:", st);
  files = await waitDownload(before, 60000);
  const smz = files.find((f) => f.endsWith("-site-live-mirror.zip"));
  ok(/Live mirror downloaded \(3 pages/.test(st) && !!smz, "whole-site live mirror zip downloaded with all 3 pages");
  if (smz) {
    const dir = unzip(smz);
    ok(["site/index.html", "site/about/index.html", "site/pricing/index.html", "server.mjs", "sl-mirror-sw.js"].every((f) => existsSync(join(dir, f))), "each page stored at its own path, one server + worker");
    ok(/About us/.test(readFileSync(join(dir, "site/about/index.html"), "utf8")) && /Plans/.test(readFileSync(join(dir, "site/pricing/index.html"), "utf8")), "each page keeps its own original HTML");
    ok(existsSync(join(dir, "site/widget/lib.js")), "a file loaded inside an iframe built from inline HTML (a widget) is in the mirror");
    const mport = 4500 + Math.floor(Math.random() * 300);
    const srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(mport) } });
    await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
    const hitsBefore = siteHits;
    const mt = await getJSON(`/json/new?${encodeURIComponent(`http://127.0.0.1:${mport}/about`)}`, "PUT");
    const mc = cdpConnect(mt.webSocketDebuggerUrl); await mc.ready;
    const val = async (e) => (await mc.send("Runtime.evaluate", { expression: e, returnByValue: true }).catch(() => null))?.result?.value;
    let about = "";
    for (let i = 0; i < 40 && !/About us/.test(about); i++) { about = (await val("document.body ? document.body.textContent : ''")) || ""; await sleep(250); }
    ok(/About us/.test(about), "opening /about in the mirror shows the About page (not the home page)");
    await val(`(document.getElementById("abs").click(), true)`);
    let where = null;
    for (let i = 0; i < 40; i++) { where = await val(`({ host: location.host, path: location.pathname, text: document.body ? document.body.textContent : "" })`); if (where && /Plans/.test(where.text)) break; await sleep(250); }
    ok(where?.host === `127.0.0.1:${mport}` && where?.path === "/pricing/" && /Plans/.test(where?.text || ""), `a link spelling out the site's domain stays inside the mirror (${JSON.stringify(where && { host: where.host, path: where.path })})`);
    ok(siteHits === hitsBefore, `browsing the whole-site mirror never calls the original site (${siteHits - hitsBefore} requests)`);
    mc.close(); await fetch(`http://127.0.0.1:${port}/json/close/${mt.id}`).catch(() => {});
    srv.kill();
  }

  const log = await ev(`document.querySelector(".src-log") ? document.querySelector(".src-log").textContent : ""`);
  console.log("  panel log:\n" + log.split("\n").map((l) => "    " + l).join("\n"));
} catch (e) { failures.push("e2e: " + e.message); console.log("  ✗ ERROR", e.message); }

panel.close(); sw.close(); browser.close(); server.close(); wp.close(); playerServer.close(); chrome.kill("SIGKILL");
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("End-to-end extension flow verified ✓");
