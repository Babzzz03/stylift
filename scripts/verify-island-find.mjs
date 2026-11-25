// The live-scene frame finds ITS canvas: by the canvas's own attributes (its file, id, data-…, classes), even when
// the page is laid out differently as it loads (the recorded path misses) and another canvas comes first (a menu's
// icon) — and when the scene canvas only appears later, the frame moves to it.
//   node scripts/verify-island-find.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const od = mkdtempSync(join(tmpdir(), "sl-if-"));
await build({ entryPoints: { islands: "src/panel/islands.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const { islandFiles, islandAttrs } = await import(pathToFileURL(join(od, "islands.js")));
// the scene script exactly as an export ships it
const manifest = { source: "https://site.test/", entryFile: "site/index.html", paths: {}, types: {}, hosts: { site: ["site.test"], ext: [] } };
const files = islandFiles({ files: { "mirror-manifest.json": JSON.stringify(manifest), "site/index.html": "<html><head></head><body></body></html>" } }, "https://site.test/", "");
const script = files["_3d/sl-island.js"];
const pages = {
  // the icon first, the scene canvas second; the recorded path points nowhere, the recorded index (0) at the icon
  "/a": `<!doctype html><html><body><nav><canvas class="canvas contain icon" data-file="/rives/icon-audio.riv" width="40" height="40"></canvas></nav><main><section><div class="center"><canvas class="canvas contain animation" data-file="/files/cycle.riv" width="1440" height="542"></canvas></div></section></main><script>${script}</script></body></html>`,
  // the scene canvas appears later (a framework mounting it): the frame moves to it
  "/b": `<!doctype html><html><body><nav><canvas class="canvas contain icon" data-file="/rives/icon-audio.riv" width="40" height="40"></canvas></nav><main id="m"></main><script>${script}</script><script>setTimeout(function(){ var c = document.createElement("canvas"); c.className = "canvas contain animation"; c.setAttribute("data-file", "/files/cycle.riv"); document.getElementById("m").appendChild(c); }, 600);</script></body></html>`,
};
const srv = createServer((q, res) => { const p = q.url.split("?")[0]; res.setHeader("content-type", "text/html"); res.end(pages[p] || ""); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
// what the stand-in picture carries (the canvas's attributes, copied by the capture)
const { JSDOM } = await import("jsdom");
const ph = new JSDOM(`<img class="canvas contain animation" data-file="/files/cycle.riv" width="1440" height="542" src="x.png" data-sl-island="0" data-sl-island-sel="body > div:nth-of-type(2) > canvas" data-v-3878b3ae="">`).window.document.querySelector("img");
const attrs = islandAttrs(ph);
ok(attrs === JSON.stringify({ class: "canvas contain animation", "data-file": "/files/cycle.riv" }), `the stand-in's own attributes (not its picture, size, StyleLift's marks or Vue's hashes) name the canvas (${attrs})`);
const qs = `?sl-island=0&sl-sel=${encodeURIComponent("body > div:nth-of-type(2) > canvas")}&sl-attrs=${encodeURIComponent(attrs)}`;
const prof = mkdtempSync(join(tmpdir(), "sl-if-p-"));
const port = 9100 + Math.floor(Math.random() * 40);
const ch = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "about:blank"]);
try {
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  const on = `(() => { const c = document.querySelector("canvas[data-sl-island-on]"); return c ? c.getAttribute("data-file") : null; })()`;
  await send("Page.navigate", { url: base + "/a" + qs }); await sleep(800);
  ok((await ev(on)) === "/files/cycle.riv", `the scene's own canvas is found though the recorded path misses and a menu icon comes first (${await ev(on)})`);
  await send("Page.navigate", { url: base + "/b" + qs }); await sleep(300);
  const early = await ev(on);
  await sleep(1000);
  const late = await ev(on);
  ok(late === "/files/cycle.riv" && (await ev(`document.querySelectorAll("canvas[data-sl-island-on]").length`)) === 1, `…and when it only appears later, the frame moves to it from the icon it had first (${early} → ${late})`);
  ws.close();
} catch (e) { failures.push(e.message); console.log("  ✗", e.message); }
try { ch.kill("SIGKILL"); } catch {}
srv.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); rmSync(od, { recursive: true, force: true }); }, 300);
console.log(`\n${passed} passed, ${failures.length} failed`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 400);
