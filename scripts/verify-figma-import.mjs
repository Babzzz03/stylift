// Figma → StyleLift — accuracy. A design the plugin read from Figma (design.json) is drawn as the web pages Studio
// imports (the shipped renderer, page mode), screenshotted, and compared pixel by pixel with Figma's own picture of
// each frame (get_screenshot, 1:1): overall, and on the "ink" (pixels that aren't background in either).
//   node scripts/verify-figma-import.mjs <design.json> <ref1.png,ref2.png,…> [--pics i1=photo,i2=tile] [--out dir]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [DESIGN, REFS = ""] = args.filter((a, i) => !a.startsWith("--") && !["--out", "--pics"].includes(args[i - 1]));
if (!DESIGN) {
  console.log("usage: node scripts/verify-figma-import.mjs <design.json> [ref1.png,ref2.png,…] [--pics id=photo,…] [--out dir]\n(design.json: what the plugin's \"Figma → StyleLift\" tab read from a Figma file)");
  process.exit(2);
}
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-fimp-"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const design = JSON.parse(readFileSync(DESIGN, "utf8"));
const refs = REFS.split(",").filter(Boolean);

const bdir = mkdtempSync(join(tmpdir(), "sl-fimp-b-"));
await build({ entryPoints: { render: "src/shared/figma-render.ts" }, outdir: bdir, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const { renderFigmaHtml } = await import(pathToFileURL(join(bdir, "render.js")));

// the test pages' pictures (the same ones verify-figma serves)
const png = (w, h, f) => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set(f(x, y), y * (w * 3 + 1) + 1 + x * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const files = new Map();
files.set("/photo.png", png(320, 200, (x, y) => [Math.round((x / 320) * 220), Math.round((y / 200) * 180) + 40, 160]));
files.set("/tile.png", png(16, 16, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [230, 230, 240] : [200, 205, 225]));
const pics = Object.fromEntries((flag("--pics") || "").split(",").filter(Boolean).map((kv) => { const [id, name] = kv.split("="); return [id, `/${name}.png`]; }));
const srv = createServer((q, res) => {
  const p = decodeURIComponent((q.url || "/").split("?")[0]);
  const f = files.get(p);
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": p.endsWith(".png") ? "image/png" : "text/html; charset=utf-8" });
  res.end(f);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const local = (p) => `http://127.0.0.1:${srv.address().port}${p}`;

const prof = mkdtempSync(join(tmpdir(), "sl-fimp-p-"));
const port = 9660 + Math.floor(Math.random() * 40);
const ch = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1440,900", "--hide-scrollbars", "about:blank"]);
const finish = (code) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); rmSync(bdir, { recursive: true, force: true }); process.exit(code); }, 300); };
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.log(`✗ stopped: ${e?.message || e}`); finish(2); });
for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }

for (const [i, snap] of design.pages.entries()) {
  const html = renderFigmaHtml(snap, (id) => (pics[id] ? local(pics[id]) : ""), { page: true });
  files.set(`/page${i}.html`, html);
  writeFileSync(join(OUT, `page${i}.html`), html);
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const k = ++id; pend.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: snap.width, height: snap.height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: local(`/page${i}.html`) });
  await sleep(2500);
  await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => 1)", awaitPromise: true });
  const shot = (await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: snap.width, height: snap.height, scale: 1 }, captureBeyondViewport: true })).result.data;
  writeFileSync(join(OUT, `page${i}.png`), Buffer.from(shot, "base64"));
  ws.close();
  console.log(`page ${i} "${snap.title}": ${snap.stats.nodes} layers → ${join(OUT, `page${i}.png`)}${refs[i] ? ` (compare with ${refs[i]})` : ""}`);
}
finish(0);
