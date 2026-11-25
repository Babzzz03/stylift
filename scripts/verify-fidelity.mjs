// Visual-fidelity matrix. For each URL: load it in headless Chrome, run settle +
// capture (the exact shipped functions), screenshot the LIVE page right after
// capture, then open the CAPTURED HTML (served locally; it carries <base>) and
// screenshot it the same way. A third page diffs the two bitmaps in a canvas and
// reports the % of pixels that match (±24/channel). Also reports structural checks.
// Usage: node scripts/verify-fidelity.mjs [--min 85] [url ...]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
// throwaway Chrome profile, removed when the script exits (they are ~70 MB each)
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const CHROME = process.env.CHROME_HEADLESS || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const minIdx = args.indexOf("--min");
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : 85;
const urls = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min" && args[i - 1] !== "--from");
if (!urls.length) urls.push(
  "https://www.allbirds.com",            // Shopify
  "https://vercel.com",                  // Next.js / React
  "https://nuxt.com",                    // Vue / Nuxt
  "https://angular.dev",                 // Angular
  "https://lit.dev",                     // web components / shadow DOM
  "https://shoelace.style",              // shadow DOM component library
  "https://tailwindcss.com",             // Tailwind
  "https://stripe.com",                  // WebGL canvas + heavy CSS
  "https://threejs.org",                 // canvas
  "https://en.wikipedia.org/wiki/Main_Page", // classic server-rendered
  "https://github.com",                  // complex app, web components
  "https://www.apple.com",               // lazy media, video
  "https://www.bbc.com",                 // news, many images
  "https://www.notion.com",              // marketing SPA
  "https://www.framer.com",              // Framer
  "https://webflow.com",                 // Webflow
  "https://gsap.com",                    // GSAP
  "https://lfs.org.uk",                  // WordPress
  "https://www.wix.com",                 // Wix (var()-based font shorthands)
  "https://www.squarespace.com",         // Squarespace
  "https://react.dev",                   // React docs
  "https://svelte.dev",                  // SvelteKit
  "https://linear.app",                  // Next.js + heavy CSS variables
  "https://developer.mozilla.org",       // MDN, web components
  "https://medium.com",                  // Medium
  "https://news.ycombinator.com",        // minimal server-rendered
);
// --from <host>: resume a long matrix run at that site
if (args.includes("--from")) {
  const from = args[args.indexOf("--from") + 1] || "";
  const at = urls.findIndex((u) => u.includes(from));
  if (at > 0) urls.splice(0, at);
}

const outdir = mkdtempSync(join(tmpdir(), "sl-fidelity-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts", fa: "src/extractor/framer-appear.ts", off: "src/panel/offline.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const { capturePage } = await import(pathToFileURL(join(outdir, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(outdir, "settle.js")));
const { applyFramerAppear } = await import(pathToFileURL(join(outdir, "fa.js")));
const { inlineForOffline } = await import(pathToFileURL(join(outdir, "off.js")));
// The fidelity check measures what a customer downloads: the single-file export
// (every asset embedded), built from the capture exactly like the panel does.
const { JSDOM } = await import("jsdom");
const jsdom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = jsdom.window.DOMParser;
globalThis.Node = jsdom.window.Node;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const EXT_MIME = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", mp4: "video/mp4" };
const dataCache = new Map();
const offlineResolvers = {
  fetchText: async (u) => { try { const r = await fetch(u, { headers: { "user-agent": UA } }); return r.ok ? await r.text() : null; } catch { return null; } },
  fetchData: async (u) => {
    if (dataCache.has(u)) return dataCache.get(u);
    let out = null;
    try {
      const r = await fetch(u, { headers: { "user-agent": UA } });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length <= 8_000_000) {
          const ext = (u.split("?")[0].split(".").pop() || "").toLowerCase();
          const type = (r.headers.get("content-type") || EXT_MIME[ext] || "application/octet-stream").split(";")[0];
          out = `data:${type};base64,${buf.toString("base64")}`;
        }
      }
    } catch { /* unreachable */ }
    dataCache.set(u, out);
    return out;
  },
};
// injected exactly like chrome.scripting.executeScript({ func }): source text only
const captureExpr = `(async function(){ const settled = (${settleAnimations.toString()})(); const r = await (${capturePage.toString()})({}); r.settled = settled; r.liveText = (document.body && document.body.innerText || "").replace(/\\s+/g," ").length; return JSON.stringify(r); })()`;

// serve captured files
const files = new Map();
const server = createServer((req, res) => {
  const f = files.get((req.url || "/").split("?")[0]);
  if (!f) { res.statusCode = 404; return res.end(""); }
  res.setHeader("content-type", "text/html; charset=utf-8"); res.end(f);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const local = (p) => `http://127.0.0.1:${server.address().port}${p}`;

const port = 9338;
// WebGL sites (three.js / OGL heroes) render nothing without a GL context: headless
// may fall back to software WebGL (Chrome >= 137 requires the opt-in); FID_SWGL=1 forces
// it for 3D-only sites (slow — every page then rasterizes on the CPU); FID_HEADED=1
// uses a real window with the GPU instead.
const gpuFlags = process.env.FID_HEADED ? [] : ["--headless=new", "--enable-unsafe-swiftshader", ...(process.env.FID_SWGL ? ["--use-angle=swiftshader"] : [])];
const chrome = spawn(CHROME, [...gpuFlags, `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"]);
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let up = false; for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); up = true; break; } catch { await sleep(200); } }
if (!up) { console.error("Chrome never came up"); chrome.kill(); process.exit(1); }
function cdp(ws) { const s = new WebSocket(ws); let id = 0; const p = new Map(); const ev = new Map(); s.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const { r, j } = p.get(m.id); p.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); } else if (ev.has(m.method)) ev.get(m.method)(m.params); }); return { ready: new Promise((r) => s.addEventListener("open", () => r())), on: (m, c) => ev.set(m, c), send: (method, params = {}) => new Promise((r, j) => { const i = ++id; p.set(i, { r, j }); s.send(JSON.stringify({ id: i, method, params })); }), close: () => s.close() }; }
async function openTab(url, settle = 3000, loadTimeout = 25000) {
  const t = await getJSON(`/json/new?about:blank`, "PUT"); const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Page.enable"); await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((r) => c.on("Page.loadEventFired", r)); await c.send("Page.navigate", { url }); await Promise.race([loaded, sleep(loadTimeout)]);
  // wait for webfonts + first-viewport images so the pristine shot shows the page a
  // visitor actually sees (not a fallback-font flash the capture would then "mismatch")
  await c.send("Runtime.evaluate", { expression: `Promise.race([ (async () => { try { await document.fonts.ready; } catch {} const imgs = [...document.images].filter(i => !i.complete && i.getBoundingClientRect().top < innerHeight); await Promise.all(imgs.map(i => new Promise(r => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))); })(), new Promise(r => setTimeout(r, 6000)) ])`, awaitPromise: true }).catch(() => {});
  await sleep(settle);
  return { c, close: async () => { c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {}); } };
}
// Drive the page's lazy-load pass before the pristine shot so we compare equal
// states: the captured HTML runs the scroll pass internally, so the live page
// should also have scrolled through once before we photograph it. Then restore
// scroll to 0 and freeze animations.
const WARMUP = `(async () => {
  const docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(240, Math.floor(innerHeight * 0.7));
  let y = 0; const deadline = performance.now() + 4000;
  while (y < docH() - innerHeight && performance.now() < deadline) {
    y += step; scrollTo(0, y); dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 90));
  }
  scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
  try { await document.fonts.ready; } catch {}
  const imgs = [...document.images].filter(i => !i.complete && i.getBoundingClientRect().top < innerHeight);
  await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))), new Promise(r => setTimeout(r, 4000))]);
})()`;
// freeze media AND CSS animations at a deterministic phase so both sides show the
// same frame (a captured page legitimately keeps the site's looping animations —
// e.g. angular.dev's 10s rotating conic-gradient — which would otherwise be
// photographed at different angles and scored as a fidelity loss).
const FREEZE = `(() => {
  document.querySelectorAll("video").forEach(v => { try { v.pause(); v.currentTime = 0; } catch {} });
  let st = document.getElementById("__fidelity_freeze");
  if (!st) { st = document.createElement("style"); st.id = "__fidelity_freeze"; document.documentElement.appendChild(st); }
  st.textContent = "*, *::before, *::after { transition: none !important; caret-color: transparent !important; } [data-sl-reveal], [data-sl-in], [data-sl-in] * { animation: none !important; }";
  try { document.getAnimations().forEach(a => { try { const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null; if (t && t.iterations !== Infinity) a.finish(); else { a.currentTime = 0; a.pause(); } } catch {} }); } catch {}
  scrollTo(0, 0);
})()`;
// The capture removes cookie-consent banners (on purpose); hide them on the live page too,
// or every comparison is penalised for a banner the copy rightly doesn't have.
const HIDE_CONSENT = `(() => { if (document.getElementById("__fid_consent")) return; const st = document.createElement("style"); st.id = "__fid_consent";
  st.textContent = "#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, #onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter, #usercentrics-root, #usercentrics-cmp-ui, .cky-consent-container, .cky-overlay, #cookie-law-info-bar, .cc-window, .cc-banner, #truste-consent-track, .osano-cm-window, #didomi-host, .qc-cmp2-container, #cmpbox, #cmpbox2, #iubenda-cs-banner, .termly-styles-root, #axeptio_overlay { display: none !important; }";
  document.documentElement.appendChild(st);
  // site-made banners: anything pinned to the screen that talks about cookies / consent
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > innerWidth * innerHeight * 0.6) continue;
    if (/cookie|consent|gdpr|privacy preferences/i.test((el.textContent || "").slice(0, 600)) && el.querySelector("button, a, [role=button]")) el.style.setProperty("display", "none", "important");
  } })()`;
const shot = async (c, warmup = false, y = 0) => {
  await c.send("Runtime.evaluate", { expression: HIDE_CONSENT }).catch(() => {});
  if (warmup) await c.send("Runtime.evaluate", { expression: WARMUP, awaitPromise: true }).catch(() => {});
  await c.send("Runtime.evaluate", { expression: FREEZE, awaitPromise: true }).catch(() => {});
  let at = 0;
  if (y) {
    await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }).catch(() => {});
    await sleep(700); // let scroll-triggered reveals on the live page run
    // freeze in place (the top-shot FREEZE scrolls back to 0), then make sure we're at y
    await c.send("Runtime.evaluate", { expression: FREEZE.replace("scrollTo(0, 0);", ""), awaitPromise: true }).catch(() => {});
    at = (await c.send("Runtime.evaluate", { expression: `new Promise((res) => { scrollTo(0, ${y}); let n = 0; const t = () => (Math.abs(scrollY - ${y}) < 2 || ++n > 20) ? res(Math.round(scrollY)) : setTimeout(t, 50); t(); })`, awaitPromise: true, returnByValue: true }).catch(() => ({ result: { value: y } }))).result.value;
  }
  await sleep(350);
  // shoot the visible screen at the real scroll position (captureBeyondViewport renders
  // the whole document into one surface, which comes back blank on very tall pages)
  const data = (await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: at, width: 1440, height: 900, scale: 0.5 }, captureBeyondViewport: false })).data;
  if (y) await c.send("Runtime.evaluate", { expression: "scrollTo(0, 0)" }).catch(() => {});
  return data;
};
// deeper positions down the page (live page: after its reveal ran; capture: reveals
// shown in their final state — the scroll-driven animation is verified separately)
const DEEP = [1350, 2700, 4500, 7200];
const docHeight = async (c) => (await c.send("Runtime.evaluate", { expression: "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)", returnByValue: true })).result.value;
async function diff(a, b, maxShift = 0) {
  const page = `<!doctype html><canvas id=x></canvas><script>
    window.result = (async () => {
      const load = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + d; });
      const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      const cv = document.getElementById("x"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0); const A = ctx.getImageData(0, 0, w, h).data;
      ctx.drawImage(ib, 0, 0); const B = ctx.getImageData(0, 0, w, h).data;
      // deeper positions: content that is right but shifted a few px (an ad slot above
      // grew) should not count as wrong — take the best match over small vertical shifts
      let bestShift = 0;
      if (${maxShift} > 0) {
        let bestScore = -1;
        for (let dy = -${maxShift}; dy <= ${maxShift}; dy += 2) {
          let m = 0, n = 0;
          for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += 3) for (let x = 0; x < w; x += 3) {
            const o = (y * w + x) * 4, o2 = ((y + dy) * w + x) * 4; n++;
            if (Math.max(Math.abs(A[o]-B[o2]), Math.abs(A[o+1]-B[o2+1]), Math.abs(A[o+2]-B[o2+2])) <= 24) m++;
          }
          const sc = m / Math.max(1, n); if (sc > bestScore) { bestScore = sc; bestShift = dy; }
        }
      }
      let same = 0, total = 0; const out = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { const yy = Math.floor(i / w), y2 = yy + bestShift; if (y2 < 0 || y2 >= h) continue; total++; const o = i * 4, o2 = (y2 * w + (i % w)) * 4; const d = Math.max(Math.abs(A[o]-B[o2]), Math.abs(A[o+1]-B[o2+1]), Math.abs(A[o+2]-B[o2+2])); if (d <= 24) { same++; out.data[o]=A[o]*0.25+190; out.data[o+1]=A[o+1]*0.25+190; out.data[o+2]=A[o+2]*0.25+190; } else { out.data[o]=220; out.data[o+1]=30; out.data[o+2]=30; } out.data[o+3]=255; }
      ctx.putImageData(out, 0, 0);
      // a uniform shot (nothing rendered) proves nothing: report it instead of scoring it
      const flat = (D) => { let s = 0, s2 = 0, n = 0; for (let i = 0; i < D.length; i += 4 * 97) { const l = D[i] * 0.3 + D[i + 1] * 0.59 + D[i + 2] * 0.11; s += l; s2 += l * l; n++; } const m = s / n; return Math.sqrt(Math.max(0, s2 / n - m * m)) < 3; };
      return JSON.stringify({ pct: +(100 * same / total).toFixed(1), blankA: flat(A), blankB: flat(B), diff: cv.toDataURL("image/jpeg", 0.6).split(",")[1] });
    })();
  </script>`;
  files.set("/diff.html", page);
  const { c, close } = await openTab(local("/diff.html"), 300);
  const r = await c.send("Runtime.evaluate", { expression: "window.result", awaitPromise: true, returnByValue: true });
  await close();
  return JSON.parse(r.result.value);
}

const rows = [];
for (const url of urls) {
  const host = new URL(url).host;
  process.stdout.write(`── ${url}\n`);
  let live = null;
  try {
    live = await openTab(url, 5000);
    const liveShot = await shot(live.c, true); // visitor view after the same lazy-load pass the capture runs
    let r = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      // a lost reply (renderer swapped, page navigated) must fail this site, not hang the matrix
      const { result, exceptionDetails } = await Promise.race([
        live.c.send("Runtime.evaluate", { expression: captureExpr, returnByValue: true, awaitPromise: true }),
        sleep(240000).then(() => ({ exceptionDetails: { exception: { description: "capture did not reply within 4 minutes" } } })),
      ]);
      if (exceptionDetails) { if (attempt) throw new Error(exceptionDetails.exception?.description || "capture threw"); await sleep(2000); continue; }
      r = JSON.parse(result.value);
      applyFramerAppear(r);
    }
    const capturedHtml = r.html;
    r.html = await inlineForOffline(r.html, r.url, offlineResolvers); // the 1-file export
    const liveAfter = await shot(live.c, false); // side-effect check (no warmup needed, already warm)
    const liveH = await docHeight(live.c);
    const liveDeep = new Map();
    for (const y of DEEP) if (y + 900 <= liveH) liveDeep.set(y, await shot(live.c, false, y));
    await live.close(); live = null;
    const path = `/${host.replace(/[^\w.-]/g, "_")}.html`;
    files.set(path, r.html);
    writeFileSync(join(outdir, host + ".captured.html"), capturedHtml);
    if (args.includes("--keep")) writeFileSync(join(outdir, host + ".single-file.html"), r.html); // up to ~30 MB each
    const cap = await openTab(local(path), 3500);
    const capText = await cap.c.send("Runtime.evaluate", { expression: `(document.body && document.body.innerText || "").replace(/\\s+/g," ").length`, returnByValue: true });
    const capShot = await shot(cap.c);
    const capH = await docHeight(cap.c);
    const capDeep = [];
    for (const y of DEEP) if (y + 900 <= Math.min(capH, liveH)) capDeep.push({ y, data: await shot(cap.c, false, y) });
    await cap.close();
    const d = await diff(liveShot, capShot);
    const intact = await diff(liveShot, liveAfter);
    const deepScores = [];
    const blankDeep = [];
    for (const { y, data } of capDeep) if (liveDeep.has(y)) {
      const dd = await diff(liveDeep.get(y), data, 60);
      if (dd.blankA) { blankDeep.push(y); continue; } // the live page showed nothing there: no measurement
      deepScores.push(dd.pct);
      writeFileSync(join(outdir, `${host}.deep-${y}.diff.jpg`), Buffer.from(dd.diff, "base64"));
      writeFileSync(join(outdir, `${host}.deep-${y}.live.png`), Buffer.from(liveDeep.get(y), "base64"));
      writeFileSync(join(outdir, `${host}.deep-${y}.captured.png`), Buffer.from(data, "base64"));
    }
    const deepAvg = deepScores.length ? +(deepScores.reduce((a, b) => a + b, 0) / deepScores.length).toFixed(1) : 100;
    writeFileSync(join(outdir, host + ".live.png"), Buffer.from(liveShot, "base64"));
    writeFileSync(join(outdir, host + ".captured.png"), Buffer.from(capShot, "base64"));
    writeFileSync(join(outdir, host + ".diff.jpg"), Buffer.from(d.diff, "base64"));
    // markup quoted inside attributes (an ad iframe's srcdoc) isn't part of the page
    const h = r.html.replace(/<!--[\s\S]*?-->/g, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "").replace(/\ssrcdoc="[^"]*"/gi, "");
    const s = r.stats;
    const imgs = h.match(/<img[^>]*>/g) || [];
    const badImg = imgs.filter((t) => !/\ssrc="(https?:|data:)/.test(t)).length;
    const checks = {
      noScripts: !/<script(?![^>]*(application\/(ld\+)?json|data-sl-anim-runtime))/.test(h), // StyleLift's own animation loader is allowed
      imgsAbs: badImg === 0,
      noMarkers: !/data-sl-i=/.test(h),
      sheets: s.sheets + s.crossOriginSheets > 0, // all-CDN sites keep <link>s; exports download them
      text: r.liveText ? capText.result.value / r.liveText : 1,
      base: /<base href="https?:/.test(h),
    };
    const textOk = checks.text >= 0.9;
    if (blankDeep.length) console.log(`   ! live page blank at ${blankDeep.join(", ")} — not scored (it didn't render there in this test browser)`);
    if (d.blankA && d.blankB) console.log("   ! top shots blank on both pages — the site did not render in this browser (WebGL? try FID_SWGL=1)");
    const pass = !(d.blankA && d.blankB) && d.pct >= MIN && deepAvg >= MIN - 5 && intact.pct >= 70 && checks.noScripts && checks.imgsAbs && checks.noMarkers && checks.sheets && checks.text >= 0.7 && checks.base;
    rows.push({ host, pct: d.pct, pass, s, checks });
    console.log(`   fidelity ${d.pct}% · deeper ${deepAvg}% [${deepScores.join(", ")}] · live page intact after capture ${intact.pct}% · text ${(checks.text * 100).toFixed(0)}% · ${(s.bytes / 1024).toFixed(0)} KB · imgs ${s.imagesLoaded}/${s.images} (${badImg} bad src) · sheets ${s.sheets}+${s.crossOriginSheets}x · shadow ${s.shadowRoots} · canvas ${s.canvases} · revealed ${s.revealed} · banners ${s.bannersRemoved} · settled ${JSON.stringify(r.settled.libs)} ${pass ? "✓" : "✗"}${checks.noScripts ? "" : " [scripts left]"}${checks.noMarkers ? "" : " [markers left]"}${checks.sheets ? "" : " [no sheets]"}`);
    if (r.warnings.length) console.log("   warnings:", r.warnings.join(" | "));
  } catch (e) {
    rows.push({ host, pct: 0, pass: false, error: e.message });
    console.log("   ✗ ERROR", e.message);
    if (live) await live.close().catch(() => {});
  } finally {
    // each site's single-file export and downloaded assets can be tens of MB: release them
    // before the next site (34 sites in one process otherwise exhaust the heap)
    for (const k of Array.from(files.keys())) if (k !== "/diff.html") files.delete(k);
    dataCache.clear();
  }
}
server.close(); chrome.kill();
const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} sites ≥ ${MIN}% fidelity with clean structure. Artifacts in ${outdir}`);
if (failed.length) { console.log("Below bar:", failed.map((r) => `${r.host} (${r.pct}%${r.error ? " " + r.error : ""})`).join(", ")); process.exit(1); }
