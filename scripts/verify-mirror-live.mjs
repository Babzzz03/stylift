// Live mirror, on real sites: does the mirror run the site's own 3D / interactions — with the
// internet cut off?
//
//   node scripts/verify-mirror-live.mjs [url …] [--headless] [--spots 0,1400,3000] [--out dir]
//                                       [--domain my-site.test | --localhost] [--pages 12]
// --pages N mirrors the whole site (up to N pages, found like the panel's Whole site mode: links +
// sitemap) and opens every page of the mirror offline: a page must show itself (same title as live).
//
// Per site: opens the live page with the resource recorder installed before load (like the panel),
// moves the mouse and wheel-scrolls to each spot taking screenshots, runs the real settle + capture
// pass (injected from source text, like chrome.scripting.executeScript), downloads every recorded
// file through Chrome's own network stack, builds the mirror with the shipped builder, serves it
// with its own server.mjs, and opens it in a second Chrome where every domain except localhost is
// unreachable. Same mouse + scroll tour, same screenshots.
//
// Fails when: a file that IS in the mirror didn't load, the mirror throws errors the live page
// didn't, or the mirror shows fewer large canvases (3D/WebGL/Rive) than the live page.
// Writes <out>/report.html with live | mirror side by side. Headed (real GPU) by default — software
// WebGL makes many 3D sites fall back to a still.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const HEADLESS = args.includes("--headless");
const SPOTS = (flag("--spots") || "0,1400,3000").split(",").map(Number);
const PAGES = Math.max(1, Number(flag("--pages") || 1)); // >1: whole site (crawl like the panel's Whole site mode)
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-mirror-live-"));
// served under another domain by default, like a deployment (the site's code must not depend on its
// own hostname); --localhost serves it the way `node server.mjs` does on your machine
const HOST = args.includes("--localhost") ? "localhost" : flag("--domain") || "my-site.test";
const urls = args.filter((a, i) => !a.startsWith("--") && !["--spots", "--out", "--domain", "--pages"].includes(args[i - 1]));
if (!urls.length) urls.push("https://www.kivoagentic.ai", "https://deltacafes.com", "https://dennypratama.com/", "https://vertical.framer.media/");
mkdirSync(OUT, { recursive: true });

const od = mkdtempSync(join(tmpdir(), "sl-ml-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts", mirror: "src/panel/mirror.ts", crawl: "src/panel/crawl.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { capturePage } = await import(pathToFileURL(join(od, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(od, "settle.js")));
const { buildSiteMirror } = await import(pathToFileURL(join(od, "mirror.js")));
const { crawlSite } = await import(pathToFileURL(join(od, "crawl.js")));
const capSrc = capturePage.toString();
const setSrc = settleAnimations.toString();
// the same recorder the panel installs (Page.addScriptToEvaluateOnNewDocument) before the page loads
const RECORDER = `(() => { if (window.__slResources) return; let seen = null; try { if (window.top !== window && window.top.__slResources) seen = window.top.__slResources; } catch (e) {} if (!seen) seen = new Set(); window.__slResources = seen; try { performance.setResourceTimingBufferSize(20000); } catch (e) {} try { new PerformanceObserver((l) => { for (const e of l.getEntries()) seen.add(e.name); }).observe({ type: "resource", buffered: true }); } catch (e) {} })();`;
const offline = (mport) => [
  `--host-resolver-rules=${[...(HOST !== "localhost" ? [`MAP ${HOST} 127.0.0.1`] : []), "MAP * ~NOTFOUND", "EXCLUDE localhost"].join(" , ")}`,
  ...(HOST !== "localhost" ? [`--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${mport}`] : []), // stands in for https
];

const kids = [];
const cleanup = () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

async function chrome(port, extra = []) {
  const profile = mkdtempSync(join(tmpdir(), "sl-mlc-"));
  const c = spawn(CHROME, [...(HEADLESS ? ["--headless=new", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", ...extra]);
  kids.push(c);
  for (let i = 0; i < 150; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  return { close: () => { try { c.kill("SIGKILL"); } catch {} setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500); } };
}
async function openTab(port, url, wait = 7000) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const errors = []; const urlOf = new Map(); const fails = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") urlOf.set(m.params.requestId, m.params.request.method === "GET" ? m.params.request.url : "");
    // an embedded player from another service (Vimeo, YouTube) is a page of its own that stays online by design
    if (m.method === "Network.loadingFailed" && !m.params.canceled && m.params.type !== "Document") fails.push({ url: urlOf.get(m.params.requestId), why: m.params.errorText });
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400) fails.push({ url: m.params.response.url, why: String(m.params.response.status) });
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "").split("\n")[0]);
  });
  // a call that gets no answer (machine asleep, renderer gone) fails after 3 minutes instead of hanging the run
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); r({ result: {} }); }, 180000); pending.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "evaluate failed"); return m.result?.result?.value; };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
  await send("Page.navigate", { url }); await sleep(wait);
  return { send, ev, errors, fails, close: () => ws.close() };
}
// visible canvases big enough to be a scene (3D / WebGL / Rive), not icons
const CANVASES = `[...document.querySelectorAll("canvas")].filter(c => { const b = c.getBoundingClientRect(); return b.width >= 200 && b.height >= 150 && getComputedStyle(c).visibility !== "hidden"; }).length`;
// same input for both: mouse moves (cursor-driven scenes), then the wheel (scroll-driven ones)
async function tour(tab, tag, slug) {
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 300 }); await sleep(300);
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1100, y: 600 }); await sleep(900);
  const canvases = await tab.ev(CANVASES);
  const shots = [];
  for (const y of SPOTS) {
    let left = y - (await tab.ev("scrollY"));
    while (Math.abs(left) > 1) { const d = Math.sign(left) * Math.min(Math.abs(left), 300); await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 720, y: 450, deltaX: 0, deltaY: d }); left -= d; await sleep(120); }
    await sleep(1800);
    const shot = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    const file = `${slug}-${tag}-${y}.jpg`;
    writeFileSync(join(OUT, file), Buffer.from(shot.result.data, "base64"));
    shots.push({ y, at: Math.round(await tab.ev("scrollY")), file });
  }
  return { canvases, shots };
}

let failed = 0;
const rows = [];
let port = 9600 + Math.floor(Math.random() * 300);
for (const url of urls) {
  const slug = new URL(url).hostname.replace(/^www\./, "").replace(/[^\w.-]/g, "_");
  console.log(`\n▶ ${url}`);
  const problems = [];
  let liveB = null, mirB = null, srv = null;
  try {
    // 1. the live site
    liveB = await chrome(++port);
    const live = await openTab(port, url);
    const liveTour = await tour(live, "live", slug);
    await live.ev("scrollTo(0, 0)"); await sleep(500);
    // 2. download through Chrome's network stack (as the extension does), retrying dropped connections
    const frameId = (await live.send("Page.getFrameTree")).result.frameTree.frame.id;
    const chromeFetch = async (u) => {
      let res;
      for (let i = 0; i < 4; i++) {
        res = (await live.send("Network.loadNetworkResource", { frameId, url: u, options: { disableCache: false, includeCredentials: true } })).result?.resource;
        if ((res?.success && res.httpStatusCode !== 429 && !(res.httpStatusCode >= 500)) || (!res?.success && !res?.netError)) break;
        await sleep(2500);
      }
      if (!res?.success || !res.stream || (res.httpStatusCode && res.httpStatusCode >= 400)) return null;
      const parts = [];
      for (;;) { const c = (await live.send("IO.read", { handle: res.stream, size: 1 << 20 })).result; if (!c) break; parts.push(Buffer.from(c.data, c.base64Encoded ? "base64" : "utf8")); if (c.eof) break; }
      await live.send("IO.close", { handle: res.stream });
      const h = res.headers || {};
      return { bytes: new Uint8Array(Buffer.concat(parts)), type: h["content-type"] || h["Content-Type"] || "" };
    };
    // the capture pass on the page in the tab (scrolls it so lazy files load), its files, its HTML
    const resources = new Set();
    const originals = [];
    const captureHere = async (pageUrl) => {
      const r = JSON.parse(await live.ev(`(async function(){ (${setSrc})(); const r = await (${capSrc})({}); return JSON.stringify({ html: r.html, url: r.url, title: r.title, stats: r.stats, warnings: r.warnings }); })()`));
      // the page's list + every iframe it can reach (same reader as the panel)
      for (const u of (await live.ev(`(() => { const out = new Set(window.__slResources || []); const walk = (w, d) => { if (d > 4) return; for (let i = 0; i < w.frames.length; i++) { try { const f = w.frames[i]; for (const e of f.performance.getEntriesByType("resource")) out.add(e.name); if (f.__slResources) for (const u of f.__slResources) out.add(u); walk(f, d + 1); } catch (e) {} } }; walk(window, 0); return Array.from(out); })()`)) || []) resources.add(u);
      const got = await chromeFetch(pageUrl);
      if (got) originals.push({ url: pageUrl, html: new TextDecoder().decode(got.bytes), title: (await live.ev("document.title")) || r.title || "" });
      return r;
    };
    if (PAGES <= 1) await captureHere(url);
    else {
      const crawled = await crawlSite(url, null, { maxPages: PAGES, maxDepth: 3, useSitemap: true }, {
        capture: async (u) => {
          await live.send("Page.navigate", { url: u });
          await sleep(6500);
          const shot = await live.send("Page.captureScreenshot", { format: "jpeg", quality: 55 });
          const liveShot = `${slug}-p${originals.length}-live.jpg`;
          writeFileSync(join(OUT, liveShot), Buffer.from(shot.result.data, "base64"));
          const before = originals.length;
          const r = await captureHere(u);
          if (originals.length > before) originals[originals.length - 1].liveShot = liveShot;
          console.log(`  page ${originals.length}: ${u} — "${(originals[originals.length - 1]?.title || "").slice(0, 60)}"`);
          return r;
        },
        fetchText: async (u) => { const x = await chromeFetch(u); return x ? new TextDecoder().decode(x.bytes) : null; },
      });
      // only what the crawler kept as pages (not text / Markdown documents it visited)
      const keep = new Set(crawled.map((p) => p.url));
      for (let i = originals.length - 1; i >= 0; i--) if (!keep.has(originals[i].url)) { console.log(`  (not a page: ${originals[i].url})`); originals.splice(i, 1); }
    }
    if (!originals.length) throw new Error("couldn't download the page's HTML");
    const m = await buildSiteMirror(originals, Array.from(resources), { fetchFile: (u) => chromeFetch(u).catch(() => null) });
    live.close(); liveB.close(); liveB = null;
    const dir = join(OUT, slug);
    rmSync(dir, { recursive: true, force: true });
    for (const [p, d] of Object.entries(m.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
    console.log(`  recorded ${resources.size} files on ${originals.length} page(s) · mirror ${m.count} files, ${(m.bytes / 1e6).toFixed(1)} MB · ${m.missing.length} couldn't be downloaded`);
    // 3. serve it with its own server.mjs; open it with the internet cut off
    const mport = 4600 + Math.floor(Math.random() * 300);
    srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(mport) } });
    kids.push(srv);
    await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
    mirB = await chrome(++port, offline(mport));
    const mir = await openTab(port, `http://${HOST}:${mport}${m.entryPath}`);
    const mirTour = await tour(mir, "mirror", slug);
    const sw = await mir.ev("!!navigator.serviceWorker && !!navigator.serviceWorker.controller");
    // whole site: every page of the mirror must show itself (not fall back to the home page)
    const pageRows = [];
    if (originals.length > 1) {
      for (let i = 0; i < originals.length; i++) {
        const u = new URL(originals[i].url);
        await mir.send("Page.navigate", { url: `http://${HOST}:${mport}${u.pathname}${u.search}` });
        await sleep(5500);
        const shot = await mir.send("Page.captureScreenshot", { format: "jpeg", quality: 55 });
        writeFileSync(join(OUT, `${slug}-m${i}-mirror.jpg`), Buffer.from(shot.result.data, "base64"));
        const title = (await mir.ev("document.title")) || "";
        const same = title.trim() === originals[i].title.trim() || (!!title && originals[i].title.includes(title.slice(0, 24)));
        pageRows.push({ path: u.pathname + u.search, live: originals[i].title, mirror: title, same, liveShot: originals[i].liveShot || "", mirrorShot: `${slug}-m${i}-mirror.jpg` });
        console.log(`  ${same ? "✓" : "✗"} ${u.pathname}${u.search} — mirror shows "${title.slice(0, 60)}"`);
      }
      const wrong = pageRows.filter((r) => !r.same);
      if (wrong.length) problems.push(`${wrong.length} page(s) of the mirror don't show themselves: ${wrong.slice(0, 4).map((r) => `${r.path} → "${r.mirror.slice(0, 40)}"`).join(" | ")}`);
    }
    // 4. verdict
    const manifest = JSON.parse(readFileSync(join(dir, "mirror-manifest.json"), "utf8")).paths;
    const site = new URL(url);
    const inMirror = (u) => { try { const x = new URL(u); const k = x.host === `${HOST}:${mport}` || x.host.replace(/^www\./, "") === site.host.replace(/^www\./, "") ? x.pathname + x.search : `/_ext/${x.host}${x.pathname}${x.search}`; return !!manifest[k]; } catch { return false; } };
    // tab icons are fetched by the browser itself, not part of the page's content
    const broken = mir.fails.filter((f) => f.url && inMirror(f.url) && !/favicon|apple-touch-icon|\.ico(\?|$)/i.test(f.url));
    const outside = mir.fails.filter((f) => f.url && !inMirror(f.url) && !/favicon/.test(f.url));
    // with the internet cut off, analytics calls fail and their code throws "Failed to fetch": that's the
    // test cutting the network (counted above), not the mirror
    const newErrors = mir.errors.filter((e) => !live.errors.includes(e) && !/Failed to fetch|NetworkError|Load failed|net::ERR_/i.test(e));
    if (!sw) problems.push("service worker not controlling the page");
    if (m.missingEssential?.length) problems.push(`incomplete mirror: ${m.missingEssential.length} of the pages' own scripts / stylesheets couldn't be downloaded (${m.missingEssential.slice(0, 2).join(" | ").slice(0, 160)})`);
    if (broken.length) problems.push(`${broken.length} file(s) in the mirror didn't load: ${broken.slice(0, 3).map((f) => f.url.slice(0, 90) + " " + f.why).join(" | ")}`);
    if (newErrors.length) problems.push(`mirror threw ${newErrors.length} error(s) the live page didn't: ${newErrors.slice(0, 3).join(" | ").slice(0, 300)}`);
    if (mirTour.canvases < liveTour.canvases) problems.push(`fewer scene canvases in the mirror (${mirTour.canvases} vs ${liveTour.canvases} live)`);
    console.log(`  served at http://${HOST}:${mport} · scene canvases: live ${liveTour.canvases} · mirror ${mirTour.canvases} · service worker ${sw ? "on" : "OFF"}`);
    console.log(`  offline: ${mir.fails.length} failed request(s) — ${broken.length} of the mirror's own files, ${outside.length} not captured (trackers, editor bars, files never loaded)`);
    for (const f of outside.slice(0, 5)) console.log(`    · ${f.url.slice(0, 120)} (${f.why})`);
    rows.push({ url, slug, m, liveTour, mirTour, outside, problems, pageRows });
    mir.close();
  } catch (e) {
    problems.push("ERROR " + (e instanceof Error ? e.message : String(e)));
    rows.push({ url, slug, problems });
  } finally {
    liveB?.close(); mirB?.close(); try { srv?.kill(); } catch {}
  }
  if (problems.length) { failed++; for (const p of problems) console.log(`  ✗ ${p}`); }
  else console.log("  ✓ the site's own code runs from the mirror with the internet cut off");
}

// side-by-side report
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const html = `<!doctype html><meta charset="utf-8"><title>Live mirror check</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#f6f6f4;color:#111}h2{margin:32px 0 4px}.meta{color:#555;margin-bottom:10px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}.pair figure{margin:0}.pair img{width:100%;border:1px solid #ccc;display:block}figcaption{font-size:12px;color:#555;margin-bottom:3px}.bad{color:#b00020}.ok{color:#0a7a3a}</style>
<h1>Live mirror — live site vs mirror (internet cut off, served at ${esc(HOST)})</h1>
${rows.map((r) => `<h2>${esc(r.url)}</h2>
<div class="meta">${r.m ? `${r.m.count} files · ${(r.m.bytes / 1e6).toFixed(1)} MB · scene canvases live ${r.liveTour.canvases} / mirror ${r.mirTour.canvases}` : ""}
${r.problems.length ? r.problems.map((p) => `<div class="bad">✗ ${esc(p)}</div>`).join("") : `<div class="ok">✓ runs from the mirror with the internet cut off</div>`}</div>
${r.pageRows?.length ? `<h3>${r.pageRows.length} pages — top of each page, live | mirror</h3>` + r.pageRows.map((p) => `<div class="pair"><figure><figcaption>LIVE · ${esc(p.path)} · ${esc(p.live)}</figcaption><img src="${p.liveShot}"></figure><figure><figcaption class="${p.same ? "ok" : "bad"}">MIRROR · ${esc(p.path)} · ${esc(p.mirror)}</figcaption><img src="${p.mirrorShot}"></figure></div>`).join("") : ""}
${(r.liveTour?.shots || []).map((s, i) => `<div class="pair"><figure><figcaption>LIVE · scrollY ${s.at}</figcaption><img src="${s.file}"></figure><figure><figcaption>MIRROR · scrollY ${r.mirTour.shots[i]?.at}</figcaption><img src="${r.mirTour.shots[i]?.file}"></figure></div>`).join("")}`).join("")}`;
writeFileSync(join(OUT, "report.html"), html);
console.log(`\nReport: ${join(OUT, "report.html")}`);
console.log(`${urls.length - failed}/${urls.length} sites run from their mirror offline`);
process.exit(failed ? 1 : 0);
