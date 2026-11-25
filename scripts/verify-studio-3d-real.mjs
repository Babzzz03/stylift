// Studio on a REAL 3D site (from the round trip's harness): Edit in Studio keeps the live 3D scene, an
// edit on the artboard, export the HTML project from Studio, served: the scene runs live and the edit is there.
//   SL_DIST=dist-test node scripts/verify-studio-3d-real.mjs [url]
// (Adapted from the motion round trip, through the REAL extension: a page animated with GSAP (from its CDN) and a ticker
// moved by a script → Edit in Studio → the site's animations show in the Animate panel and play on the
// artboard → edit a heading's text and one recorded animation's duration on the artboards → Studio's
// Preview runs the same code (trigger script, the edited timing, the edited text) → the HTML and
// Next.js exports from Studio carry every edit and every animation.
//   SL_DIST=dist-test node scripts/verify-motion-roundtrip.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, globSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const CHROME = process.env.CHROME || globSync(join(homedir(), ".cache/puppeteer/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).sort().pop();
const DIST = join(process.cwd(), process.env.SL_DIST || "dist");
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

// ── a real 3D site ───────────────────────────────────────────────────────────────────────────────────
const SITE = process.argv[2] || "https://crl-2026.webflow.io/";
const origin = SITE.replace(/\/$/, "");
const server = { close() {} };

// ── Chrome with the extension ─────────────────────────────────────────────────
const downloads = mkdtempSync(join(tmpdir(), "sl-dl-"));
mkdirSync(join(PROFILE, "Default"), { recursive: true });
writeFileSync(join(PROFILE, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
const port = 9360 + Math.floor(Math.random() * 30);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"]);
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); break; } catch { await sleep(200); } }
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result.value; };
  return { ready: new Promise((r) => ws.addEventListener("open", r)), send, ev, close: () => ws.close() };
}
let sw = null, extId = "";
for (let i = 0; i < 75 && !sw; i++) {
  for (const w of (await getJSON("/json/list")).filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
    const c = cdp(w.webSocketDebuggerUrl); await c.ready;
    if ((await c.ev("chrome.runtime.getManifest().name").catch(() => "")) === "StyleLift") { sw = c; extId = w.url.split("/")[2]; break; }
    c.close();
  }
  if (!sw) await sleep(200);
}
ok(!!sw, "extension loaded");
const site = await getJSON(`/json/new?${encodeURIComponent(SITE)}`, "PUT");
{ const st = cdp(site.webSocketDebuggerUrl); await st.ready; await st.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {}); }
await sleep(2500);
await sw.ev(`chrome.tabs.create({ url: chrome.runtime.getURL("src/panel/index.html"), active: false })`);
let panelT = null;
for (let i = 0; i < 50 && !panelT; i++) { panelT = (await getJSON("/json/list")).find((t) => t.url === `chrome-extension://${extId}/src/panel/index.html`); if (!panelT) await sleep(200); }
const panel = cdp(panelT.webSocketDebuggerUrl); await panel.ready;
await sleep(800);
await fetch(`http://127.0.0.1:${port}/json/activate/${site.id}`);
await sleep(300);
const status = () => panel.ev(`document.querySelector("#status").textContent`);
async function waitStatus(re, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await status(); if (re.test(s)) return s; await sleep(400); } return status(); }
const clickText = (t) => panel.ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(t)})); if (!b) throw new Error("no button " + ${JSON.stringify(t)}); b.click(); return true; })()`);

try {
  for (let i = 0; i < 30 && !(await panel.ev(`!!document.querySelector("#source-btn")`)); i++) await sleep(300);
  await panel.ev(`document.querySelector("#source-btn").click()`);
  await sleep(400);
  // ── capture → Studio ────────────────────────────────────────────────────────
  await clickText("Edit in Studio");
  const st = await waitStatus(/Opened in StyleLift Studio|error|failed/i, 240000);
  ok(/Opened in StyleLift Studio/.test(st), `Edit in Studio (${st.slice(0, 70)})`);
  let studioT = null;
  for (let i = 0; i < 60 && !studioT; i++) { studioT = (await getJSON("/json/list")).find((t) => t.url.includes("/src/studio/index.html?id=")); if (!studioT) await sleep(250); }
  const s = cdp(studioT.webSocketDebuggerUrl); await s.ready;
  for (let i = 0; i < 120 && !(await s.ev(`!!(window.__studio && window.__studio.S.doc && window.__studio.S.frames.size === 3)`).catch(() => false)); i++) await sleep(500);
  await sleep(2000);
  // the scene kept live, its files with the project
  const sc = await s.ev(`(async () => { const ph = window.__studio.S.doc.querySelector("[data-sl-island]"); const id = window.__studio.S.project.id; const files = await new Promise((res) => { const rq = indexedDB.open("stylelift-studio"); rq.onsuccess = () => { try { const g = rq.result.transaction("scenes", "readonly").objectStore("scenes").get(id); g.onsuccess = () => res(g.result ? Object.keys(g.result.files).length : 0); g.onerror = () => res(0); } catch (e) { res(0); } }; rq.onerror = () => res(0); }); return { sel: ph ? ph.getAttribute("data-sl-island-sel") : null, files }; })()`);
  ok(!!sc.sel && sc.files > 3, `Studio keeps the site's 3D scene live: marked, ${sc.files} of the site's files saved with the project (${sc.sel})`);
  // "Play live on the canvas" for the site's scenes is switched off in Studio (it froze this machine twice): only
  // with SL_TEST_PLAY_LIVE=1, on a machine with the memory for a second copy of the site
  if (process.env.SL_TEST_PLAY_LIVE === "1") {
    const phId = await s.ev(`(() => { const ph = window.__studio.S.doc.querySelector("[data-sl-island]"); return ph ? ph.getAttribute("data-sl-id") : null; })()`);
    if (phId) await s.ev(`(window.__studio.select(${JSON.stringify(phId)}), true)`);
    await sleep(800);
    const pressed = await s.ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => /Play live on the canvas/.test(b.textContent)); if (!b) return false; b.click(); return true; })()`);
    let lv = null;
    for (let i = 0; i < 90 && !(lv && lv.on); i++) { await sleep(500); lv = await s.ev(`(() => { const o = [...document.querySelectorAll(".sl-live-ov iframe")]; const b = document.querySelector(".sl-live-ov"); const r = b && b.getBoundingClientRect(); return { n: o.length, on: o.some((f) => f.style.opacity === "1"), box: r ? [Math.round(r.width), Math.round(r.height)].join("x") : null, t: o[0] && o[0].style.transform }; })()`).catch(() => null); }
    ok(!!phId && pressed && lv && lv.on && lv.n >= 1, `"Play live on the canvas": the site's scene runs over its spot on the artboards (${JSON.stringify(lv)})`);
    const stopped = await s.ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => /Stop playing on the canvas/.test(b.textContent)); if (!b) return false; b.click(); return true; })()`);
    await sleep(1500);
    const left = await s.ev(`document.querySelectorAll(".sl-live-ov").length`);
    ok(stopped && left === 0, `…and stops (the overlay gone, the artboard as it was) (${left} left)`);
  }
  // an edit: the first visible heading's text
  const hid = await s.ev(`(() => { const d = window.__studio.S.doc; const h = [...d.querySelectorAll("h1, h2, h3")].find((e) => (e.textContent || "").trim().length > 2); return h ? h.getAttribute("data-sl-id") : null; })()`);
  ok(!!hid, `a heading to edit (${hid})`);
  if (hid) { await s.ev(`(window.__studio.select(${JSON.stringify(hid)}), window.__studio.setText("Edited in StyleLift Studio"), true)`); await sleep(600); }
  // export the HTML project from Studio
  const box = (sel) => s.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (pt) => { await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }); await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 }); await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 }); await sleep(300); };
  const before = new Set(readdirSync(downloads));
  await click(await box("#export-btn"));
  await click(await box(`[data-export="html"]`));
  let hz = null;
  for (let i = 0; i < 600 && !hz; i++) { const f = readdirSync(downloads).filter((x) => !before.has(x) && /\.html( \(\d+\))?\.zip$/.test(x) && !x.startsWith(".")); if (f.length) { await sleep(1000); hz = f[0]; } else await sleep(500); }
  ok(!!hz, "HTML project exported from Studio");
  if (hz) {
    const dir = mkdtempSync(join(tmpdir(), "sl-s3d-")); execFileSync("unzip", ["-oq", join(downloads, hz), "-d", dir]);
    const idx = readFileSync(join(dir, "index.html"), "utf8");
    ok(/Edited in StyleLift Studio/.test(idx) && /data-sl-island="/.test(idx) && existsSync(join(dir, "sl-islands.js")) && existsSync(join(dir, "_3d/island.html")), "the export carries the edit and the live scene's own files");
    const TY = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".mp4": "video/mp4" };
    const xs = createServer((q, res) => { let pth = decodeURIComponent(q.url.split("?")[0]); if (pth.endsWith("/")) pth += "index.html"; const f = join(dir, pth); if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": TY[(f.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase()] || "application/octet-stream" }); res.end(readFileSync(f)); });
    await new Promise((res) => xs.listen(0, "127.0.0.1", res));
    const xt = await getJSON(`/json/new?${encodeURIComponent(`http://127.0.0.1:${xs.address().port}/`)}`, "PUT");
    const xp = cdp(xt.webSocketDebuggerUrl); await xp.ready;
    await xp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    let xl = null;
    for (let i = 0; i < 120 && !(xl && xl.live); i++) { await sleep(500); xl = await xp.ev(`(() => { const f = document.querySelector("[data-sl-island-box] iframe"); const edited = [...document.querySelectorAll("h1, h2, h3")].some((h) => /Edited in StyleLift Studio/.test(h.textContent)); if (!f) return { edited }; try { const w = f.contentWindow; return { edited, live: f.style.opacity === "1", ready: !!(w.__slIsland && w.__slIsland.ready()) }; } catch (e) { return { edited, err: String(e) }; } })()`).catch(() => null); }
    ok(xl && xl.live && xl.edited, `served from its own address: the site's 3D scene runs live next to the edited heading (${JSON.stringify(xl)})`);
    const shot = await xp.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot?.data) { writeFileSync(join(process.env.SL_OUT || tmpdir(), "studio-3d-export.png"), Buffer.from(shot.data, "base64")); console.log(`  (screenshot: ${join(process.env.SL_OUT || tmpdir(), "studio-3d-export.png")})`); }
    xp.close(); await fetch(`http://127.0.0.1:${port}/json/close/${xt.id}`).catch(() => {}); xs.close();
  }
  s.close();
} catch (e) {
  failures.push("run: " + e.message);
  console.log("  ✗ ERROR", e.message);
}
panel.close(); sw.close(); server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
