// Dev tool: one local page through the capture (built from source) in headless Chrome at 1440×900 — prints the
// chosen elements' opening tags (and optionally the copy's StyleLift <style> blocks) and the stats.
//   node scripts/capture-page.mjs <page.html | https://…> id1,id2 [--css] [--out copy.html] [--sel "css selector"] [--n 6]
// (a URL is opened as it is — the site itself, without the extension's page-start recorder or live 3D)
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [PAGE, IDS = ""] = args.filter((a, i) => !a.startsWith("--") && !["--out", "--sel", "--n"].includes(args[i - 1]));
const REMOTE = /^https?:\/\//.test(PAGE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = mkdtempSync(join(tmpdir(), "sl-cp-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts" }, outdir: out, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const { capturePage } = await import(pathToFileURL(join(out, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(out, "settle.js")));
const expr = `(async function(){ (${settleAnimations.toString()})(); const r = await (${capturePage.toString()})({}); return JSON.stringify({ html: r.html, stats: r.stats }); })()`;
const page = REMOTE ? "" : readFileSync(PAGE, "utf8");
const srv = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(page); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const prof = mkdtempSync(join(tmpdir(), "sl-cp-p-"));
const port = 9500 + Math.floor(Math.random() * 40);
const ch = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1440,900", "about:blank"]);
const done = (c) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); process.exit(c); }, 300); };
try {
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: REMOTE ? PAGE : `http://127.0.0.1:${srv.address().port}/` });
  await sleep(REMOTE ? 9000 : 1500);
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 600000 });
  const v = JSON.parse(r.result.result.value);
  for (const i of IDS.split(",").filter(Boolean)) console.log((new RegExp(`<[a-z]+[^>]* id="${i}"[^>]*>`).exec(v.html) || ["none " + i])[0].slice(0, 300));
  if (flag("--sel")) {
    const { JSDOM } = await import("jsdom");
    const d = new JSDOM(v.html).window.document;
    for (const el of [...d.querySelectorAll(flag("--sel"))].slice(0, Number(flag("--n") || 6))) console.log(el.outerHTML.replace(/>[\s\S]*$/, ">").slice(0, 400) + " '" + (el.textContent || "").trim().slice(0, 20) + "'");
  }
  if (args.includes("--css")) for (const m of v.html.matchAll(/<style data-sl-[^>]*>[\s\S]*?<\/style>/g)) console.log(m[0].slice(0, 1200));
  if (flag("--out")) writeFileSync(flag("--out"), v.html);
  console.log(JSON.stringify(v.stats));
  done(0);
} catch (e) { console.log("✗", e.message); done(1); }
