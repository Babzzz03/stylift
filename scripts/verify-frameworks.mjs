// Real framework build test. For each URL:
//   capture (shipped capture functions, injected by source text) →
//   generate React (Vite) and Next.js projects with the shipped builders →
//   run the REAL `vite build` and `next build` (static export) →
//   serve the output, screenshot it, and pixel-compare against the capture.
// Needs a node_modules with react, react-dom, vite, @vitejs/plugin-react, next:
//   FW_NODE_MODULES=/path/to/node_modules node scripts/verify-frameworks.mjs [--keep] [url ...]
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
// throwaway Chrome profile, removed when the script exits (they are ~70 MB each)
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const NM = process.env.FW_NODE_MODULES;
if (!NM || !existsSync(join(NM, "next")) || !existsSync(join(NM, "vite"))) {
  console.error("Set FW_NODE_MODULES to a node_modules containing react, react-dom, next, vite, @vitejs/plugin-react.");
  process.exit(2);
}
const CHROME = process.env.CHROME_HEADLESS || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const urls = args.filter((a) => !a.startsWith("--"));
if (!urls.length) urls.push("https://vertical.framer.media/");
const MIN = 90;

const outdir = mkdtempSync(join(tmpdir(), "sl-fw-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts", fa: "src/extractor/framer-appear.ts", rp: "src/panel/react-project.ts", pj: "src/panel/project.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
const { capturePage } = await import(pathToFileURL(join(outdir, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(outdir, "settle.js")));
const { applyFramerAppear } = await import(pathToFileURL(join(outdir, "fa.js")));
const { buildReactViteProject, buildNextProject } = await import(pathToFileURL(join(outdir, "rp.js")));
const captureExpr = `(async function(){ (${settleAnimations.toString()})(); return JSON.stringify(await (${capturePage.toString()})({})); })()`;

// ── static servers ─────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".json": "application/json", ".ico": "image/x-icon", ".txt": "text/plain" };
function serveDir(root) {
  const srv = createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    let f = join(root, p);
    try { if (statSync(f).isDirectory()) f = join(f, "index.html"); } catch { if (existsSync(f + ".html")) f += ".html"; }
    if (!existsSync(f)) { res.statusCode = 404; return res.end("404"); }
    res.setHeader("content-type", MIME[extname(f).toLowerCase()] || "application/octet-stream");
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

// ── chrome ─────────────────────────────────────────────────────────────────────
const port = 9341;
// WebGL sites need a GL context: allow software WebGL, and FW_SWGL=1 forces it (slow, for 3D sites)
const glFlags = ["--enable-unsafe-swiftshader", ...(process.env.FW_SWGL ? ["--use-angle=swiftshader"] : [])];
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`, "--no-first-run", ...glFlags, "--window-size=1440,900", "--hide-scrollbars"]);
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let up = false; for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); up = true; break; } catch { await sleep(200); } }
if (!up) { console.error("Chrome never came up"); process.exit(1); }
function cdp(ws) { const s = new WebSocket(ws); let id = 0; const p = new Map(); const ev = new Map(); s.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const { r, j } = p.get(m.id); p.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); } else if (ev.has(m.method)) ev.get(m.method)(m.params); }); return { ready: new Promise((r) => s.addEventListener("open", () => r())), on: (m, c) => ev.set(m, c), send: (method, params = {}) => new Promise((r, j) => { const i = ++id; p.set(i, { r, j }); s.send(JSON.stringify({ id: i, method, params })); }), close: () => s.close() }; }
async function openTab(url, settle = 3000) {
  const t = await getJSON(`/json/new?about:blank`, "PUT"); const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const errors = []; c.on("Runtime.exceptionThrown", (e) => errors.push(e.exceptionDetails?.exception?.description?.split("\n")[0] || "exception"));
  const loaded = new Promise((r) => c.on("Page.loadEventFired", r)); await c.send("Page.navigate", { url }); await Promise.race([loaded, sleep(25000)]);
  await c.send("Runtime.evaluate", { expression: `Promise.race([(async()=>{try{await document.fonts.ready}catch{}; const imgs=[...document.images].filter(i=>!i.complete&&i.getBoundingClientRect().top<innerHeight); await Promise.all(imgs.map(i=>new Promise(r=>{i.addEventListener("load",r,{once:true});i.addEventListener("error",r,{once:true})})))})(), new Promise(r=>setTimeout(r,6000))])`, awaitPromise: true }).catch(() => {});
  await sleep(settle);
  return { c, errors, close: async () => { c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {}); } };
}
const FREEZE = `(() => { document.querySelectorAll("video").forEach(v => { try { v.pause(); v.currentTime = 0; } catch {} }); const st = document.createElement("style"); st.textContent = "*,*::before,*::after{transition:none!important;caret-color:transparent!important}"; document.documentElement.appendChild(st); try { document.getAnimations().forEach(a => { try { const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null; if (t && t.iterations !== Infinity) a.finish(); else { a.currentTime = 0; a.pause(); } } catch {} }); } catch {} scrollTo(0,0); })()`;
async function shot(c, y = 0) {
  await c.send("Runtime.evaluate", { expression: FREEZE }).catch(() => {});
  if (y) { await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }); }
  await sleep(500);
  return (await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y, width: 1440, height: 900, scale: 0.5 }, captureBeyondViewport: true })).data;
}
let diffSrv = null;
async function diff(a, b) {
  const page = `<!doctype html><canvas id=x></canvas><script>window.result=(async()=>{const load=d=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src="data:image/png;base64,"+d});const[ia,ib]=await Promise.all([load(${JSON.stringify(a)}),load(${JSON.stringify(b)})]);const w=Math.min(ia.width,ib.width),h=Math.min(ia.height,ib.height);const cv=document.getElementById("x");cv.width=w;cv.height=h;const ctx=cv.getContext("2d",{willReadFrequently:true});ctx.drawImage(ia,0,0);const A=ctx.getImageData(0,0,w,h).data;ctx.drawImage(ib,0,0);const B=ctx.getImageData(0,0,w,h).data;let s=0;for(let i=0;i<w*h;i++){const o=i*4;if(Math.max(Math.abs(A[o]-B[o]),Math.abs(A[o+1]-B[o+1]),Math.abs(A[o+2]-B[o+2]))<=24)s++}return (100*s/(w*h)).toFixed(1)})()</script>`;
  const d = mkdtempSync(join(tmpdir(), "sl-diff-")); writeFileSync(join(d, "index.html"), page);
  diffSrv?.close(); diffSrv = await serveDir(d);
  const { c, close } = await openTab(diffSrv.url + "/", 200);
  const r = await c.send("Runtime.evaluate", { expression: "window.result", awaitPromise: true, returnByValue: true });
  await close(); return Number(r.result.value);
}

// ── project helpers ───────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const resolvers = {
  fetchText: async (u) => { try { const r = await fetch(u, { headers: { "user-agent": UA } }); return r.ok ? await r.text() : null; } catch { return null; } },
  fetchBytes: async (u) => { try { const r = await fetch(u, { headers: { "user-agent": UA } }); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return b.byteLength <= 25_000_000 ? b : null; } catch { return null; } },
};
// Projects are written next to the toolchain's node_modules (no symlink): Next's
// Turbopack refuses a node_modules symlinked from outside the project root.
const BUILD_ROOT = join(dirname(NM), ".sl-fw-builds", String(Date.now()));
// builds are ~100 MB each (.next, dist, assets); keep them only with --keep
if (!args.includes("--keep")) process.on("exit", () => { try { rmSync(BUILD_ROOT, { recursive: true, force: true }); } catch {} });
function writeProject(files, dir) {
  for (const [p, data] of Object.entries(files)) { const f = join(dir, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); }
}
function run(cmd, args, cwd, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cmd, ...args], { cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env }, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, ms: Date.now() - t0, out: (r.stdout || "") + (r.stderr || "") };
}
const tree = (files) => {
  const paths = Object.keys(files).filter((p) => !p.startsWith("public/assets/")).sort();
  const assets = Object.keys(files).filter((p) => p.startsWith("public/assets/"));
  return paths.join("\n      ") + `\n      public/assets/ (${assets.length} files)`;
};

let failures = 0;
for (const url of urls) {
  const host = new URL(url).host;
  console.log(`\n══ ${url}`);
  try {
    const live = await openTab(url, 4000);
    const { result, exceptionDetails } = await live.c.send("Runtime.evaluate", { expression: captureExpr, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "capture threw");
    await live.close();
    const r = JSON.parse(result.value);
    applyFramerAppear(r);
    if (r.stats.quality === 0) throw new Error("captured the browser's error page — site did not load: " + r.warnings.join(" | "));
    console.log(`  captured ${(r.html.length / 1024).toFixed(0)} KB · ${r.stats.appearAnimations || 0} Framer appear animations compiled · quality ${r.stats.quality}`);

    // reference: the captured HTML itself
    const capDir = join(outdir, host, "capture"); mkdirSync(capDir, { recursive: true }); writeFileSync(join(capDir, "index.html"), r.html);
    const capSrv = await serveDir(capDir);
    const capTab = await openTab(capSrv.url + "/", 3500);
    const refShots = [await shot(capTab.c, 0), await shot(capTab.c, 1800)];
    await capTab.close(); capSrv.close();

    for (const kind of ["react", "next"]) {
      const files = kind === "react" ? await buildReactViteProject(r.html, r.url, resolvers, host) : await buildNextProject(r.html, r.url, resolvers, host);
      const dir = join(BUILD_ROOT, host, kind); mkdirSync(dir, { recursive: true }); writeProject(files, dir);
      const comps = Object.keys(files).filter((p) => /components\/.+\.jsx$/.test(p)).map((p) => p.replace(/^(src\/)?components\//, "").replace(".jsx", ""));
      const assets = Object.keys(files).filter((p) => p.startsWith("public/assets/")).length;
      const missing = (String(files["README.md"]).match(/Assets still loaded from the original site \((\d+)\)/) || [, "0"])[1];
      console.log(`  ── ${kind === "react" ? "React (Vite)" : "Next.js"}: ${Object.keys(files).length} files · ${assets} assets downloaded, ${missing} left remote · ${comps.length} components: ${comps.join(", ")}`);
      if (Number(missing) > assets) { failures++; console.log(`  ✗ most assets failed to download (${missing} remote vs ${assets} local)`); }
      if (kind === "next") console.log(`      ${tree(files)}`);
      const b = kind === "react" ? run(join(NM, "vite/bin/vite.js"), ["build", "--logLevel", "warn"], dir) : run(join(NM, "next/dist/bin/next"), ["build"], dir, { NEXT_OUTPUT: "export" });
      if (!b.ok) { failures++; console.log(`  ✗ ${kind} build FAILED in ${(b.ms / 1000).toFixed(1)}s\n${b.out.split("\n").filter((l) => /error|Error|failed/i.test(l)).slice(0, 12).join("\n")}`); continue; }
      console.log(`  ✓ ${kind} build passed in ${(b.ms / 1000).toFixed(1)}s`);
      const outRoot = join(dir, kind === "react" ? "dist" : "out");
      const srv = await serveDir(outRoot);
      const tab = await openTab(srv.url + "/", 3500);
      const shots = [await shot(tab.c, 0), await shot(tab.c, 1800)];
      const errs = tab.errors.slice(); await tab.close(); srv.close();
      writeFileSync(join(outdir, host, `${kind}.png`), Buffer.from(shots[0], "base64"));
      const scores = [await diff(refShots[0], shots[0]), await diff(refShots[1], shots[1])];
      const pass = Math.min(...scores) >= MIN && errs.length === 0;
      if (!pass) failures++;
      console.log(`  ${pass ? "✓" : "✗"} ${kind} output vs capture: top ${scores[0]}% · further down ${scores[1]}% · runtime errors ${errs.length}${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
    }
    writeFileSync(join(outdir, host, "capture.png"), Buffer.from(refShots[0], "base64"));
  } catch (e) { failures++; console.log("  ✗ ERROR", e.message); }
}
diffSrv?.close(); chrome.kill();
console.log(`\n${failures ? failures + " failure(s)" : "All framework builds verified ✓"} — screenshots in ${outdir}, projects in ${BUILD_ROOT}`);
process.exit(failures ? 1 : 0);
