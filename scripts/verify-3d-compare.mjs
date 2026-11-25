// Live 3D on a real site: the site itself next to its HTML export (made by the real extension with
// "Keep 3D scenes live" on), in a normal Chrome WITH the graphics card. For each: screenshots at the same
// scroll positions (written to <out>/ to look at), then the pointer moved and dragged over the scene —
// does the 3D react, on the site and in the export?
//   node scripts/verify-3d-compare.mjs <site url> <unzipped HTML export folder> --out <dir>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [SITE, DIR] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-3dcmp-"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".mp4": "video/mp4", ".webm": "video/webm", ".hdr": "application/octet-stream", ".ktx2": "image/ktx2" };
const srv = createServer((q, res) => {
  let p = decodeURIComponent(q.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const f = join(DIR, p);
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": T[extname(f).toLowerCase()] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const EXPORT = `http://127.0.0.1:${srv.address().port}/`;
// the scene compared: the export's first live scene, and on the site the very canvas it stands for
const idxHtml = existsSync(join(DIR, "index.html")) ? readFileSync(join(DIR, "index.html"), "utf8") : "";
const SEL = ((/data-sl-island-sel="([^"]*)"/.exec(idxHtml) || [])[1] || "").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "sl-3dcmp-prof-"));
const port = 9800 + Math.floor(Math.random() * 40);
const ch = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,960", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "about:blank"]);
const finish = (code) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(code); }, 400); };
setTimeout(() => { console.log("✗ gave up after 8 minutes"); finish(2); }, 480000).unref();
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
async function tab(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => r({ error: "timeout" }), 60000); pend.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await fetch(`http://127.0.0.1:${port}/json/activate/${t.id}`);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  for (let i = 0; i < 150; i++) { await sleep(200); if ((await ev("document.readyState").catch(() => "")) === "complete") break; }
  return { send, ev, id: t.id, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
const png = async (t, name, clip) => { const r = await t.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); const d = r.result?.data || ""; if (name) writeFileSync(join(OUT, name), Buffer.from(d, "base64")); return d; };
// the scene's box: the export's island; on the site, its largest WebGL canvas
const SCENE_BOX = `(() => { const b = window.__slCmp || document.querySelector("[data-sl-island-box]") || [...document.querySelectorAll("canvas")].sort((a, c) => c.width * c.height - a.width * a.height)[0]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.round(Math.min(r.width, 1440)), height: Math.round(Math.min(r.height, 900)) }; })()`;
async function interact(t, label) {
  // the scene into view first (the largest one: on the site its canvas, in the export its live frame)
  await t.ev(`(() => { let b = document.querySelector("[data-sl-island-box]"); if (!b) { try { b = document.querySelector(${JSON.stringify(SEL)}); } catch (e) { b = null; } } if (!b) b = [...document.querySelectorAll("canvas")].sort((a, c) => c.width * c.height - a.width * a.height)[0]; if (!b) return false; window.__slCmp = b; const r = b.getBoundingClientRect(); scrollTo(0, Math.max(0, scrollY + r.top - 60)); return true; })()`);
  await sleep(2500);
  await png(t, `${label}-scene.png`);
  const box = await t.ev(SCENE_BOX);
  if (!box || box.width < 50 || box.height < 50) return { box, note: "no scene on screen" };
  const clip = { x: box.x, y: box.y, width: Math.min(box.width, 1440 - box.x), height: Math.min(box.height, 900 - box.y) };
  const a = await png(t, null, clip); await sleep(1200); const b = await png(t, null, clip);
  const cx = clip.x + clip.width / 2, cy = clip.y + clip.height / 2;
  // move across the scene
  for (let k = 0; k <= 10; k++) { await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: clip.x + (clip.width * k) / 10, y: cy + Math.sin(k) * 80 }); await sleep(60); }
  await sleep(800);
  const c = await png(t, `${label}-after-move.png`, clip);
  // drag across the middle
  await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 12; k++) { await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + k * 20, y: cy + k * 6, buttons: 1 }); await sleep(40); }
  await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 240, y: cy + 72, button: "left", buttons: 0, clickCount: 1 });
  await sleep(1200);
  const d = await png(t, `${label}-after-drag.png`, clip);
  return { box, stillOnItsOwn: a === b, changedByMove: c !== b, changedByDrag: d !== c };
}
const report = { site: SITE, export: EXPORT, out: OUT };
try {
  console.log(`▶ ${SITE}\n  export served at ${EXPORT}`);
  const live = await tab(SITE);
  await sleep(9000); // intros, models
  await live.ev(`(() => { const b = [...document.querySelectorAll("button, a")].find((x) => /^(accept|allow|agree|ok|got it|permitir todos|aceitar|accepter|akzeptieren|aceptar)/i.test((x.textContent || "").trim())); if (b) b.click(); return !!b; })()`).catch(() => false);
  await sleep(1000);
  await png(live, "site-top.png");
  report.siteInteract = await interact(live, "site");
  await live.ev(`(scrollTo(0, 0), true)`);
  live.close();
  const ex = await tab(EXPORT);
  let isl = null;
  for (let i = 0; i < 120 && !(isl && isl.live); i++) {
    isl = await ex.ev(`(() => { const fs = [...document.querySelectorAll("[data-sl-island-box] iframe")]; return { scenes: document.querySelectorAll("[data-sl-island]").length, frames: fs.length, live: fs.length > 0 && fs.every((f) => f.style.opacity === "1") }; })()`).catch(() => null);
    if (!(isl && isl.live)) await sleep(500);
  }
  report.islands = isl;
  console.log(`  export scenes: ${JSON.stringify(isl)}`);
  await sleep(4000);
  await png(ex, "export-top.png");
  report.exportInteract = await interact(ex, "export");
  ex.close();
  console.log(`  site:   ${JSON.stringify(report.siteInteract)}`);
  console.log(`  export: ${JSON.stringify(report.exportInteract)}`);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`  screenshots: ${OUT}`);
  finish(0);
} catch (e) {
  console.log("  ✗ ERROR", e.message);
  finish(1);
}
