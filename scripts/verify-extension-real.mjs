// Real sites, through the REAL extension — the way a customer uses it.
//
//   node scripts/verify-extension-real.mjs [url …] [--pages 6] [--out dir] [--no-site]
//
// Loads the built extension (dist/) into Chrome for Testing, opens each site, opens the side panel and
// clicks its own buttons: This page → HTML (.zip), Next.js (.zip), Live mirror (.zip); Whole site
// (Max pages = --pages) → Live mirror (.zip). Every download is unzipped and checked. Every mirror is
// served with its own server.mjs and opened in a GPU Chrome with the internet cut off, at another domain:
// each page must show itself, none of the mirror's own files may fail, no new errors.
// Writes <out>/report.html (results, timings, screenshots). Run `npm run build` first.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, globSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const PAGES = Number(flag("--pages") || 6);
// --only html,next,live,site — run just these buttons (a heavy site on a small machine)
const ONLY = (flag("--only") || "html,next,studio,live,site").split(",").map((x) => x.trim());
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-ext-real-"));
const urls = args.filter((a, i) => !a.startsWith("--") && !["--pages", "--out", "--only", "--studio-eval"].includes(args[i - 1]));
if (!urls.length) urls.push("https://saul-rhand-main.webflow.io/", "https://www.kivoagentic.ai/", "https://coutumes.com/");
mkdirSync(OUT, { recursive: true });

const CFT = process.env.CHROME || globSync(join(homedir(), ".cache/puppeteer/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).sort().pop();
const GPU_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!CFT || !existsSync(CFT)) { console.error("Needs Chrome for Testing (npx @puppeteer/browsers install chrome@stable) — Google Chrome ≥137 can't load unpacked extensions."); process.exit(1); }
const DIST = process.env.SL_DIST ? join(process.cwd(), process.env.SL_DIST) : join(process.cwd(), "dist");
if (!existsSync(join(DIST, "manifest.json"))) { console.error("dist/ missing — run npm run build"); process.exit(1); }

const kids = [];
const cleanup = () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.method) for (const l of listeners) l(m.method, m.params); });
  const send = (method, params = {}, ms = 90000) => new Promise((resolve, reject) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, ms); pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready: new Promise((r) => ws.addEventListener("open", () => r())), on: (cb) => listeners.push(cb), send, close: () => ws.close() };
}
const getJSON = async (port, p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
async function waitChrome(port) { for (let i = 0; i < 150; i++) { try { await getJSON(port, "/json/version"); return true; } catch { await sleep(200); } } return false; }

// ── Chrome for Testing with the extension ─────────────────────────────────────
const port = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "sl-ext-prof-"));
// every export lands here: the profile's own download folder, as in a real Chrome (CDP's
// Browser.setDownloadBehavior renames files saved through chrome.downloads to random ids)
const DL = join(OUT, "downloads"); mkdirSync(DL, { recursive: true });
mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true } }));
kids.push(spawn(CFT, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--no-first-run", "--no-default-browser-check", "--window-size=1440,960"]));
process.on("exit", () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
if (!(await waitChrome(port))) { console.error("Chrome never came up"); process.exit(1); }
let extId = "", sw = null;
for (let i = 0; i < 75 && !extId; i++) {
  for (const w of (await getJSON(port, "/json/list")).filter((t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\//.test(t.url))) {
    const c = cdpConnect(w.webSocketDebuggerUrl); await c.ready;
    const r = await c.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }).catch(() => null);
    if (r?.result?.value === "StyleLift") { extId = w.url.split("/")[2]; sw = c; break; }
    c.close();
  }
  if (!extId) await sleep(200);
}
if (!extId) { console.error("StyleLift did not load"); process.exit(1); }
const browser = cdpConnect((await getJSON(port, "/json/version")).webSocketDebuggerUrl); await browser.ready;
console.log(`StyleLift ${extId} loaded in ${CFT.split("/").pop()}`);

// a small machine (8 GB, integrated graphics) freezes — and macOS restarts it — when heavy 3D pages
// pile up: before each site, wait until memory and load have recovered
import { loadavg, cpus } from "node:os";
function availableGB() {
  try {
    const vm = execFileSync("vm_stat").toString();
    const pages = (k) => Number((vm.match(new RegExp(k + ":\\s+(\\d+)")) || [0, 0])[1]);
    return ((pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * 4096) / 1e9;
  } catch { return 99; }
}
// (capped: background work on the computer can hold the load up for hours — the benchmark that runs this has waited
// already, and gives each export 25 minutes in all)
async function waitForCalm(maxMin = 6) {
  const t0 = Date.now(); let said = 0;
  for (;;) {
    const load = loadavg()[0], free = availableGB();
    if ((load < cpus().length * 1.5 && free > 1.5) || Date.now() - t0 > maxMin * 60000) return;
    if (Date.now() - said > 60000) { console.log(`  … letting the machine calm down (load ${load.toFixed(1)}, ${free.toFixed(1)} GB free)`); said = Date.now(); }
    await sleep(10000);
  }
}

// a dropped connection must show up as a pause in the log, not as the engine failing
async function online(u) { try { await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(10000) }); return true; } catch { return false; } }
async function waitOnline(u, maxMin = 45) {
  const t0 = Date.now(); let said = 0;
  while (!(await online(u))) {
    if (Date.now() - said > 60000) { console.log(`  … waiting for the internet (${Math.round((Date.now() - t0) / 60000)} min)`); said = Date.now(); }
    if (Date.now() - t0 > maxMin * 60000) return false;
    await sleep(15000);
  }
  return true;
}

// the exceptions the LIVE page throws on load (to tell the site's own bugs from the mirror's)
async function liveErrors(pageUrl) {
  const lp = 9890 + Math.floor(Math.random() * 60);
  const prof = mkdtempSync(join(tmpdir(), "sl-ext-live-"));
  const c = spawn(GPU_CHROME, ["--headless=new", `--remote-debugging-port=${lp}`, `--user-data-dir=${prof}`, "--no-first-run", "--window-size=1440,900"]); kids.push(c);
  const out = [];
  try {
    await waitChrome(lp);
    const t = await getJSON(lp, "/json/new?about:blank", "PUT");
    const tab = cdpConnect(t.webSocketDebuggerUrl); await tab.ready;
    tab.on((m, p) => { if (m === "Runtime.exceptionThrown") out.push(((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text || "").split("\n")[0]); });
    await tab.send("Page.enable"); await tab.send("Runtime.enable");
    await tab.send("Page.navigate", { url: pageUrl }); await sleep(9000);
    tab.close();
  } catch {} finally { try { c.kill("SIGKILL"); } catch {} setTimeout(() => rmSync(prof, { recursive: true, force: true }), 1500); }
  return out;
}

const rows = [];
let gpuPort = 9810 + Math.floor(Math.random() * 60);
for (const url of urls) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const dl = DL; mkdirSync(join(OUT, host), { recursive: true });
  console.log(`\n▶ ${url}`);
  const row = { url, host, exports: [], mirrors: [], problems: [] };
  rows.push(row);
  if (!(await waitOnline(url))) { row.problems.push("no internet connection for 45 minutes — site skipped"); console.log("  ✗ no internet for 45 min — skipped"); continue; }
  await waitForCalm();
  let siteTarget = null, panelTarget = null, panel = null;
  try {
    // the website, then the panel (opened by the extension itself, like the toolbar button does)
    siteTarget = await getJSON(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
    // the page sees a 1440 × 900 window, the size the copies are checked at (the test window's toolbars and the
    // "debugging this browser" bar would otherwise leave it shorter: sites that measure the window in pixels
    // would be compared at a different size than they were captured)
    if (process.env.SL_VIEWPORT !== "window") {
      try { const st = cdpConnect(siteTarget.webSocketDebuggerUrl); await st.ready; await st.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: Number(process.env.SL_DPR || 1), mobile: false }); /* SL_DPR=2: a Retina screen (the 2x pictures) */ setTimeout(() => { try { st.close(); } catch {} }, 600000); } catch { /* the window's own size */ }
    }
    await sleep(9000);
    await sw.send("Runtime.evaluate", { expression: `chrome.tabs.create({ url: chrome.runtime.getURL("src/panel/index.html"), active: false })`, awaitPromise: true });
    for (let i = 0; i < 50 && !panelTarget; i++) { panelTarget = (await getJSON(port, "/json/list")).find((t) => t.url === `chrome-extension://${extId}/src/panel/index.html`); if (!panelTarget) await sleep(200); }
    panel = cdpConnect(panelTarget.webSocketDebuggerUrl); await panel.ready;
    await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`);
    await sleep(800);
    const ev = async (expression) => { const r = await panel.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 300000); /* a heavy export can keep the panel busy for minutes */ if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result.value; };
    const clickText = (t) => ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(t)})); if (!b) throw new Error("no button " + ${JSON.stringify(t)}); b.click(); return true; })()`);
    const status = () => ev(`document.querySelector("#status").textContent`);
    // waits for the panel to finish, printing its status as it changes (at most every 20 s) so a log
    // that stops moving really means something is stuck
    const waitStatus = async (re, ms) => {
      const t0 = Date.now(); let shown = "", shownAt = 0;
      while (Date.now() - t0 < ms) {
        const s = await status();
        if (re.test(s)) return s;
        // the panel marks failures with its "error" style — whatever the wording
        if (await ev(`document.querySelector("#status").classList.contains("error")`)) { const now = await status(); return re.test(now) ? now : now; } // read it again: it may have just changed
        if (s && s !== shown && Date.now() - shownAt > 20000) { console.log(`      … ${Math.round((Date.now() - t0) / 1000)}s: ${s.slice(0, 120)}`); shown = s; shownAt = Date.now(); }
        await sleep(1000);
      }
      return "(timed out) " + (await status());
    };
    const newFiles = (before) => readdirSync(dl).filter((f) => !before.has(f) && !f.endsWith(".crdownload") && !f.startsWith(".")); // Chrome writes a hidden temp file while saving
    const waitDownload = async (before, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const n = newFiles(before); if (n.length && !readdirSync(dl).some((f) => f.endsWith(".crdownload") || f.startsWith(".com.google."))) { await sleep(800); return n; } await sleep(500); } return []; };
    for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector("#source-btn")`)) break; await sleep(300); }
    await ev(`(document.querySelector("#source-btn").click(), true)`);
    await sleep(500);

    // ── This page: the buttons a customer clicks ──
    const reloadSite = async () => { const c = cdpConnect(siteTarget.webSocketDebuggerUrl); await c.ready; await c.send("Page.reload", {}).catch(() => {}); c.close(); await sleep(9000); };
    const run = async (scope, label, done, ms, retried = false) => {
      await clickText(scope); await sleep(300);
      await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); await sleep(300);
      await ev(`(document.querySelector("#status").textContent = "", true)`);
      const before = new Set(readdirSync(dl));
      const t0 = Date.now();
      await clickText(label);
      const st = await waitStatus(done, ms);
      const files = await waitDownload(before, 180000);
      const secs = Math.round((Date.now() - t0) / 1000);
      const file = files.find((f) => /\.zip$/.test(f)) || files[0] || "";
      const size = file ? statSync(join(dl, file)).size : 0;
      const ok = !!file && done.test(st) && !/INCOMPLETE/.test(st);
      if (!ok && !retried && /didn't load|error page/i.test(st)) {
        console.log(`      … the page didn't load (connection?) — waiting for the internet, reloading, retrying once`);
        await waitOnline(url); await reloadSite();
        return run(scope, label, done, ms, true);
      }
      console.log(`  ${ok ? "✓" : "✗"} ${scope} → ${label}: ${secs}s · ${(size / 1e6).toFixed(1)} MB · ${st.slice(0, 140)}`);
      if (!ok) {
        row.problems.push(`${scope} → ${label}: ${st.slice(0, 200) || "no download"}`);
        // the panel's own log says why
        const plog = (await ev(`document.querySelector(".src-log") ? document.querySelector(".src-log").textContent : ""`).catch(() => "")) || "";
        for (const l of plog.split("\n").map((x) => x.trim()).filter(Boolean).slice(-6)) console.log(`      panel log: ${l.slice(0, 200)}`);
      }
      return { scope, label, secs, size, file, status: st, ok };
    };
    const unzip = (file) => { const d = join(OUT, host, file.replace(/\.zip$/, "")); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); execFileSync("unzip", ["-oq", join(dl, file), "-d", d]); return d; };

    const html = ONLY.includes("html") ? await run("This page", "HTML (.zip)", /Exported HTML project/i, 600000) : null;
    if (html?.ok) { const d = unzip(html.file); const idx = existsSync(join(d, "index.html")) ? readFileSync(join(d, "index.html"), "utf8") : ""; html.check = { index: !!idx, scripts: (idx.match(/<script\b/g) || []).length, assets: existsSync(join(d, "assets")) ? globSync("assets/**/*.*", { cwd: d }).length : 0, css: existsSync(join(d, "styles.css")) }; if (!idx || !html.check.css) row.problems.push("HTML export is missing index.html or styles.css"); }
    if (html) row.exports.push(html);
    // ── Studio: the capture opened in the editor — every image and video must show on the artboard ──
    if (ONLY.includes("studio")) {
      await clickText("This page"); await sleep(300);
      await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); await sleep(300);
      await ev(`(document.querySelector("#status").textContent = "", true)`);
      const seen = new Set((await getJSON(port, "/json/list")).map((t) => t.id));
      const t0 = Date.now();
      await clickText("Edit in Studio");
      const st = await waitStatus(/Opened in StyleLift Studio/i, 600000);
      let stT = null;
      for (let i = 0; i < 60 && !stT; i++) { stT = (await getJSON(port, "/json/list")).find((t) => !seen.has(t.id) && t.url.includes("/src/studio/index.html?id=")); if (!stT) await sleep(500); }
      const studio = { label: "Edit in Studio", ok: false, status: st, secs: 0 };
      if (stT) {
        const sc = cdpConnect(stT.webSocketDebuggerUrl); await sc.ready;
        const sv = async (e) => { const r = await sc.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, 120000); return r.result?.value; };
        for (let i = 0; i < 120; i++) { if (await sv(`!!(window.__studio && window.__studio.S.frames.size === 3 && [...window.__studio.S.frames.values()].every((f) => f.contentDocument && f.contentDocument.querySelector("[data-sl-id]")))`)) break; await sleep(500); }
        await sleep(8000); // images and fonts load into the artboards
        const m = await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; const dq = (sel) => { const out = []; const walk = (r) => { out.push(...r.querySelectorAll(sel)); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); return out; }; const imgs = dq("img").filter((i) => i.getAttribute("src") || i.getAttribute("srcset")); const vids = dq("video"); const r = (el) => el.getBoundingClientRect(); return {
          layers: document.querySelectorAll("#layers .row").length,
          images: imgs.length,
          broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => (i.currentSrc || i.getAttribute("src") || "").slice(0, 140)).slice(0, 8),
          videos: vids.length,
          emptyVideos: vids.filter((v) => r(v).width > 40 && !v.getAttribute("src") && !v.querySelector("source[src]") && !v.getAttribute("poster")).length,
          blankVideos: vids.filter((v) => r(v).width > 40 && v.readyState < 2 && !v.getAttribute("poster")).length,
          blankWhy: vids.filter((v) => r(v).width > 40 && v.readyState < 2 && !v.getAttribute("poster")).slice(0, 3).map((v) => ({ src: (v.currentSrc || v.getAttribute("src") || (v.querySelector("source") || {}).src || "").slice(0, 120), sources: v.querySelectorAll("source").length, preload: v.getAttribute("preload"), autoplay: v.hasAttribute("autoplay"), state: v.readyState, net: v.networkState, err: v.error && v.error.code, size: Math.round(r(v).width) + "x" + Math.round(r(v).height), attrs: [...v.attributes].map((a) => a.name).join(" ").slice(0, 120) })),
          canvases: dq("canvas").length,
          embeds: dq("iframe[src]").length, embedsPictured: dq("iframe[data-sl-poster]").length,
          height: d.documentElement.scrollHeight }; })()`);
        studio.secs = Math.round((Date.now() - t0) / 1000);
        studio.check = m;
        // --studio-eval "<expression>": evaluated in the Desktop artboard's document (`d`) — a diagnostic
        const se = flag("--studio-eval");
        if (se) console.log(`      studio-eval: ${JSON.stringify(await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; const w = d.defaultView; return (${se}); })()`))}`.slice(0, 2000));
        studio.ok = !!m && m.layers > 3 && !m.broken.length && !m.emptyVideos;
        await fetch(`http://127.0.0.1:${port}/json/activate/${stT.id}`); await sleep(1500); // a hidden tab can't be pictured
        const shot = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
        const shotData = shot?.data || shot?.result?.data;
        if (shotData) { mkdirSync(join(OUT, host), { recursive: true }); writeFileSync(join(OUT, host, "studio.jpg"), Buffer.from(shotData, "base64")); }
        // the top of the Desktop artboard at full size (what the first screen of the page looks like there)
        const top = await sv(`(() => { const f = window.__studio.S.frames.get("base"); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, r.width * 2.4) }; })()`);
        if (top && top.w > 10) {
          const z = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 80, clip: { x: top.x, y: top.y, width: top.w, height: top.h, scale: Math.min(4, 1440 / top.w) } }).catch(() => null);
          if (z?.data) writeFileSync(join(OUT, host, "studio-desktop-top.jpg"), Buffer.from(z.data, "base64"));
        }
        // big things that can't be seen on the Desktop artboard (opacity 0 / hidden), with the Animations switch off and on
        const invisible = `(() => { const d = window.__studio.S.frames.get("base").contentDocument; const w = d.defaultView; let n = 0; const ex = []; for (const el of d.body.querySelectorAll("*")) { const r = el.getBoundingClientRect(); if (r.width * r.height < 40000 || r.top > 4000) continue; const c = w.getComputedStyle(el); if (c.opacity === "0" || c.visibility === "hidden") { n++; if (ex.length < 4) ex.push(el.localName + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "") + " " + Math.round(r.width) + "×" + Math.round(r.height) + " anim=" + c.animationName.slice(0, 30)); } } return { n, ex }; })()`;
        const off = await sv(invisible);
        const wasOn = await sv(`document.querySelector("#anim-toggle").checked`);
        if (!wasOn) { await sv(`(() => { const t = document.querySelector("#anim-toggle"); t.checked = true; t.dispatchEvent(new Event("change")); return true; })()`); await sleep(6000); }
        const on = await sv(invisible);
        console.log(`      invisible big elements on the Desktop artboard: ${off?.n} with animations off, ${on?.n} with them on ${JSON.stringify(off?.ex || [])}`);
        // what's at the same spots on the live page and on the artboard (pictures from the screen: are they empty?)
        if (process.argv.includes("--probe")) {
          const desc = `(els) => els.slice(0, 5).map((el) => { const r = el.getBoundingClientRect(); const c = el.ownerDocument.defaultView.getComputedStyle(el); let x = el.localName + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") + " " + Math.round(r.width) + "x" + Math.round(r.height); if (el.localName === "img") { x += " src=" + (el.getAttribute("src") || "").slice(0, 30) + " n=" + el.naturalWidth + "x" + el.naturalHeight; try { const cv = el.ownerDocument.createElement("canvas"); cv.width = 64; cv.height = 64; const g = cv.getContext("2d"); g.drawImage(el, 0, 0, 64, 64); const px = g.getImageData(0, 0, 64, 64).data; let a = 0; for (let i = 3; i < px.length; i += 4) a += px[i] > 8 ? 1 : 0; x += " opaque=" + Math.round(a / 40.96) + "%"; } catch (e) { x += " (unreadable)"; } } if (el.localName === "canvas") x += " canvas " + el.width + "x" + el.height; if (c.opacity !== "1") x += " op=" + c.opacity; if (c.backgroundImage !== "none") x += " bg=" + c.backgroundImage.slice(0, 40); return x; })`;
          const live = cdpConnect(siteTarget.webSocketDebuggerUrl); await live.ready;
          const lv = async (e) => (await live.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, 60000)).result?.value;
          const scrollers = `(() => { const out = []; for (const el of document.querySelectorAll("*")) { const c = getComputedStyle(el); if (!/auto|scroll|hidden|clip/.test(c.overflowY) || el.scrollHeight - el.clientHeight < 200 || el.clientHeight < 300) continue; out.push(el.localName + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") + " " + c.overflowY + " client " + el.clientHeight + " scroll " + el.scrollHeight); if (out.length > 5) break; } return { doc: document.documentElement.scrollHeight, win: innerHeight, out }; })()`;
          console.log(`      live page: ${JSON.stringify(await lv(scrollers))}`);
          const ab = await sv(`(() => { const f = window.__studio.S.frames.get("base"); const d = f.contentDocument; const w = d.defaultView; const out = []; for (const el of d.querySelectorAll("*")) { const c = w.getComputedStyle(el); if (!/auto|scroll|hidden|clip/.test(c.overflowY) || el.scrollHeight - el.clientHeight < 200 || el.clientHeight < 300) continue; out.push(el.localName + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") + " " + c.overflowY + " client " + el.clientHeight + " scroll " + el.scrollHeight); if (out.length > 5) break; } const shots = [...d.querySelectorAll("img")].filter((i) => /^data:image\\/(png|webp)/.test(i.getAttribute("src") || "")).slice(0, 10).map((i) => (${desc})([i])[0] + " at y=" + Math.round(i.getBoundingClientRect().top)); return { frameH: f.height, doc: d.documentElement.scrollHeight, hint: (document.querySelector(".ab-inner") || {}).textContent || "", out, shots }; })()`);
          console.log(`      artboard: ${JSON.stringify(ab, null, 1)}`);
          // every player on the artboard: its box, and the first thing up its parent chain that could hide it
          const players = await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; const w = d.defaultView; const out = []; const walk = (r) => { r.querySelectorAll("iframe").forEach((f) => out.push(f)); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); return out.slice(0, 6).map((f) => { const r = f.getBoundingClientRect(); const chain = []; for (let e = f; e && chain.length < 14; ) { const c = w.getComputedStyle(e); const b = e.getBoundingClientRect(); chain.push(e.localName + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "") + " " + Math.round(b.width) + "x" + Math.round(b.height) + (c.display !== "block" ? " d=" + c.display : "") + (c.opacity !== "1" ? " op=" + c.opacity : "") + (c.visibility !== "visible" ? " vis=" + c.visibility : "") + (c.overflow !== "visible" ? " of=" + c.overflow : "") + (c.position !== "static" ? " pos=" + c.position : "") + (c.transform !== "none" ? " tf=" + c.transform.slice(0, 40) : "") + (c.clipPath !== "none" ? " clip=" + c.clipPath.slice(0, 30) : "") + (c.zIndex !== "auto" ? " z=" + c.zIndex : "") + (c.backgroundColor !== "rgba(0, 0, 0, 0)" ? " bg=" + c.backgroundColor : "") + (c.backgroundImage !== "none" ? " bgi" : "") + (c.isolation !== "auto" ? " iso" : "") + (c.willChange !== "auto" ? " wc=" + c.willChange : "") + (c.mixBlendMode !== "normal" ? " blend=" + c.mixBlendMode : "") + (c.maskImage && c.maskImage !== "none" ? " mask" : "") + (c.filter !== "none" ? " filter=" + c.filter.slice(0, 20) : "")); e = e.parentElement || (e.getRootNode() && e.getRootNode().host) || null; } return { src: (f.getAttribute("src") || "").slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], bg: w.getComputedStyle(f).backgroundImage.slice(0, 30), chain }; }); })()`);
          console.log(`      players: ${JSON.stringify((players || []).slice(0, 2), null, 1)}`);
          const why = await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; let f = null; const walk = (r) => { f = f || r.querySelector("iframe[data-sl-poster]"); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); if (!f) return "no player"; const r = f.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = d.elementFromPoint(cx, cy); const cd = f.contentDocument; return { visible: f.checkVisibility ? f.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) : "n/a", atCentre: top ? top.localName + "." + (typeof top.className === "string" ? top.className.split(" ")[0] : "") + " " + Math.round(top.getBoundingClientRect().width) + "x" + Math.round(top.getBoundingClientRect().height) : null, srcdoc: (f.getAttribute("srcdoc") || "").slice(0, 60), src: f.getAttribute("src"), inner: cd ? cd.readyState + " " + (cd.documentElement ? cd.documentElement.outerHTML.slice(0, 90) : "-") + " bg=" + (cd.documentElement ? cd.defaultView.getComputedStyle(cd.documentElement).backgroundImage.slice(0, 30) : "") : "no contentDocument" }; })()`);
          console.log(`      why: ${JSON.stringify(why)}`);
          const over = await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; const w = d.defaultView; let f = null; const walk = (r) => { f = f || r.querySelector("iframe[data-sl-poster]"); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); if (!f) return []; const r = f.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const out = []; for (const el of d.body.querySelectorAll("*")) { const b = el.getBoundingClientRect(); if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) continue; const c = w.getComputedStyle(el); const painted = c.backgroundColor !== "rgba(0, 0, 0, 0)" || c.backgroundImage !== "none" || el.localName === "img" || el.localName === "svg" || el.localName === "canvas" || el.localName === "video"; if (!painted) continue; out.push(el.localName + "." + (typeof el.className === "string" ? el.className.split(" ")[0] : "") + " " + Math.round(b.width) + "x" + Math.round(b.height) + " pos=" + c.position + " z=" + c.zIndex + " bg=" + c.backgroundColor + (c.backgroundImage !== "none" ? " bgi=" + c.backgroundImage.slice(0, 40) : "") + " op=" + c.opacity + " pe=" + c.pointerEvents); } return out.slice(-12); })()`);
          console.log(`      painted at the player's centre: ${JSON.stringify(over, null, 1)}`);
          const shotTop = async (name) => { await sleep(1200); if (top && top.w > 10) { const z = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: top.x, y: top.y, width: top.w, height: top.w * 0.6, scale: Math.min(3, 1440 / top.w) } }).catch(() => null); if (z?.data) writeFileSync(join(OUT, host, name), Buffer.from(z.data, "base64")); } };
          const posterInfo = await sv(`new Promise((res) => { const d = window.__studio.S.frames.get("base").contentDocument; const w = d.defaultView; const p = d.querySelector(".fig-1mxu7da"); if (!p) return res("no poster layer"); const c = w.getComputedStyle(p); const url = (c.backgroundImage.match(/url\\("([^"]+)"\\)/) || [])[1]; const im = d.createElement("img"); im.onload = () => res({ vis: c.visibility, disp: c.display, op: c.opacity, z: c.zIndex, url: (url || "").slice(0, 60), loaded: im.naturalWidth + "x" + im.naturalHeight }); im.onerror = () => res({ vis: c.visibility, op: c.opacity, url: (url || "").slice(0, 60), loaded: "ERROR" }); im.src = url; d.body.appendChild(im); im.style.display = "none"; })`);
          console.log(`      poster layer: ${JSON.stringify(posterInfo)}`);
          // outline the player and each parent in place (red, then orange, yellow, green, blue, purple)
          const outlined = await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; let f = null; const walk = (r) => { f = f || r.querySelector("iframe[data-sl-poster]"); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); if (!f) return "no player"; const cols = ["red", "orange", "yellow", "lime", "blue", "purple", "cyan"]; const out = []; let e = f; for (let i = 0; i < cols.length && e; i++) { e.style.setProperty("outline", (10 - i) + "px solid " + cols[i], "important"); e.style.setProperty("outline-offset", (-2 * i) + "px", "important"); out.push(cols[i] + "=" + e.localName + "." + (typeof e.className === "string" ? e.className.split(" ")[0] : "")); e = e.parentElement || (e.getRootNode() && e.getRootNode().host) || null; } f.style.setProperty("background", "magenta", "important"); return out; })()`);
          console.log(`      outlined: ${JSON.stringify(outlined)}`);
          await shotTop("outlined.jpg");
          await sv(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; let f = null; const walk = (r) => { f = f || r.querySelector("iframe[data-sl-poster]"); r.querySelectorAll("*").forEach((h) => h.shadowRoot && walk(h.shadowRoot)); }; walk(d); if (f) f.style.cssText += ";position:fixed!important;top:0!important;left:0!important;width:500px!important;height:400px!important;z-index:2147483647!important;outline:12px solid red!important"; return true; })()`);
          await sleep(1500);
          if (top && top.w > 10) {
            const z3 = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: top.x, y: top.y, width: top.w, height: top.w * 0.6, scale: Math.min(4, 1440 / top.w) } }).catch(() => null);
            if (z3?.data) writeFileSync(join(OUT, host, "player-forced.jpg"), Buffer.from(z3.data, "base64"));
          }
          // the page Studio holds, and the same stretches of the live page and of the artboard, side by side
          writeFileSync(join(OUT, host, "studio.html"), (await sv(`window.__studio.S.html`)) || "");
          for (const y of [1400, 2400, 3600, 5000]) {
            await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); await sleep(500);
            await lv(`(scrollTo(0, ${y}), new Promise((r) => setTimeout(r, 1500)))`);
            const ls = await live.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => null);
            if (ls?.data) writeFileSync(join(OUT, host, `live-${y}.jpg`), Buffer.from(ls.data, "base64"));
            await fetch(`http://127.0.0.1:${port}/json/activate/${stT.id}`); await sleep(800);
            const fr = await sv(`(() => { const f = window.__studio.S.frames.get("base"); f.scrollIntoView({ block: "start" }); const st = document.querySelector("#stage") || document.scrollingElement; const r = f.getBoundingClientRect(); const k = r.height / Number(f.height); return { x: r.left, y: r.top + ${y} * k, w: r.width, h: 700 * k, k }; })()`);
            if (fr && fr.w > 10) {
              const as = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: fr.x, y: fr.y, width: fr.w, height: fr.h, scale: Math.min(4, 1440 / fr.w) }, captureBeyondViewport: true }).catch(() => null);
              if (as?.data) writeFileSync(join(OUT, host, `artboard-${y}.jpg`), Buffer.from(as.data, "base64"));
            }
          }
          live.close();
        }
        if (top && top.w > 10) {
          const z2 = await sc.send("Page.captureScreenshot", { format: "jpeg", quality: 80, clip: { x: top.x, y: top.y, width: top.w, height: top.h, scale: Math.min(4, 1440 / top.w) } }).catch(() => null);
          if (z2?.data) writeFileSync(join(OUT, host, "studio-desktop-top-animations.jpg"), Buffer.from(z2.data, "base64"));
        }
        console.log(`  ${studio.ok ? "✓" : "✗"} This page → Edit in Studio: ${studio.secs}s · ${m ? `${m.layers} layers · ${m.images} images (${m.broken.length} broken) · ${m.videos} videos (${m.emptyVideos} without a source, ${m.blankVideos} not showing) · ${m.canvases} canvases · ${m.embeds} embeds (${m.embedsPictured} pictured)` : "no artboards"}`);
        for (const b of (m?.broken || []).slice(0, 4)) console.log(`      broken image: ${b}`);
        for (const v of (m?.blankWhy || [])) console.log(`      video not showing: ${JSON.stringify(v)}`);
        // every frame on the artboard: what it points at and whether it got a picture
        const frames = await sv(`[...window.__studio.S.frames.get("base").contentDocument.querySelectorAll("iframe")].map((f) => { const r = f.getBoundingClientRect(); return (f.getAttribute("src") || (f.hasAttribute("srcdoc") ? "srcdoc" : "-")).slice(0, 70) + " " + Math.round(r.width) + "×" + Math.round(r.height) + (f.hasAttribute("data-sl-poster") ? " PICTURED" : ""); })`);
        for (const fr of (frames || []).slice(0, 12)) console.log(`      frame: ${fr}`);
        const plog = (await ev(`document.querySelector(".src-log") ? document.querySelector(".src-log").textContent : ""`).catch(() => "")) || "";
        for (const l of plog.split("\n").map((x) => x.trim()).filter((x) => /pictured|canvas|player|embed/i.test(x)).slice(-4)) console.log(`      panel log: ${l.slice(0, 160)}`);
        if (!studio.ok) row.problems.push(`Edit in Studio: ${m ? `${m.broken.length} broken images, ${m.emptyVideos} videos without a source` : "the artboards never showed the page"}`);
        sc.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${stT.id}`).catch(() => {});
      } else { console.log(`  ✗ This page → Edit in Studio: ${st.slice(0, 140)}`); row.problems.push(`Edit in Studio: ${st.slice(0, 200)}`); }
      row.exports.push(studio);
      await fetch(`http://127.0.0.1:${port}/json/activate/${siteTarget.id}`); await sleep(300);
    }
    const next = ONLY.includes("next") ? await run("This page", "Next.js (.zip)", /Exported/i, 600000) : null;
    if (next?.ok) { const d = unzip(next.file); next.check = { page: existsSync(join(d, "app/page.jsx")), layout: existsSync(join(d, "app/layout.jsx")), components: existsSync(join(d, "components")) ? readdirSync(join(d, "components")).length : 0 }; if (!next.check.page || !next.check.layout) row.problems.push("Next.js export is missing app/page.jsx or app/layout.jsx"); }
    if (next) row.exports.push(next);
    if (ONLY.includes("live")) {
      const pm = await run("This page", "Live mirror", /Live mirror downloaded/i, 900000);
      row.exports.push(pm);
      if (pm.ok) row.mirrors.push({ kind: "page", dir: unzip(pm.file), exp: pm });
    }

    // ── Whole site ──
    if (!args.includes("--no-site") && ONLY.includes("site")) {
      await clickText("Whole site"); await sleep(300);
      await ev(`(() => { const i = document.querySelectorAll(".src-opts input[type=number]")[0]; i.value = "${PAGES}"; i.dispatchEvent(new Event("change")); i.dispatchEvent(new Event("input")); return true; })()`);
      const sm = await run("Whole site", "Live mirror", /Live mirror downloaded/i, 3600000);
      row.exports.push(sm);
      if (sm.ok) row.mirrors.push({ kind: "site", dir: unzip(sm.file), exp: sm });
    }
    row.log = await ev(`document.querySelector(".src-log") ? document.querySelector(".src-log").textContent : ""`).catch(() => "");
  } catch (e) {
    row.problems.push("ERROR " + (e instanceof Error ? e.message : String(e)));
    console.log("  ✗ ERROR", e instanceof Error ? e.message : e);
  } finally {
    try { panel?.close(); } catch {}
    for (const t of [siteTarget, panelTarget]) if (t) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
  }

  // ── each mirror: its own server, a GPU Chrome with the internet cut off, at another domain ──
  for (const mir of row.mirrors) {
   try {
    await waitForCalm(5);
    const manifest = JSON.parse(readFileSync(join(mir.dir, "mirror-manifest.json"), "utf8"));
    const mport = 4800 + Math.floor(Math.random() * 150);
    const srv = spawn("node", ["server.mjs"], { cwd: mir.dir, env: { ...process.env, PORT: String(mport) } }); kids.push(srv);
    await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
    const DOMAIN = "my-site.test";
    const prof = mkdtempSync(join(tmpdir(), "sl-ext-gpu-"));
    const gp = ++gpuPort;
    const g = spawn(GPU_CHROME, [`--remote-debugging-port=${gp}`, `--user-data-dir=${prof}`, "--no-first-run", "--window-size=1440,900", `--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1 , MAP * ~NOTFOUND , EXCLUDE localhost`, `--unsafely-treat-insecure-origin-as-secure=http://${DOMAIN}:${mport}`]); kids.push(g);
    await waitChrome(gp);
    const t = await getJSON(gp, "/json/new?about:blank", "PUT");
    const tab = cdpConnect(t.webSocketDebuggerUrl); await tab.ready;
    const fails = [], errors = [], urlOf = new Map();
    tab.on((m, p) => {
      if (m === "Network.requestWillBeSent") urlOf.set(p.requestId, p.request.method === "GET" ? p.request.url : "");
      // an embedded player from another service (Vimeo, YouTube) is a page of its own that stays online by design
      if (m === "Network.loadingFailed" && !p.canceled && p.type !== "Document") fails.push(urlOf.get(p.requestId) || "");
      if (m === "Network.responseReceived" && p.response.status >= 400 && p.response.status !== 404) fails.push(p.response.url);
      if (m === "Runtime.exceptionThrown") errors.push(((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text || "").split("\n")[0]);
    });
    await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const tev = async (e) => (await tab.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }).catch(() => null))?.result?.value;
    const inMirror = (u) => { try { const x = new URL(u); const own = x.host === `${DOMAIN}:${mport}` || x.host.replace(/^www\./, "") === host; const k = own ? x.pathname + x.search : `/_ext/${x.host}${x.pathname}${x.search}`; return !!manifest.paths[k]; } catch { return false; } };
    const pages = (manifest.pages && manifest.pages.length ? manifest.pages : [{ path: manifest.entry, title: "" }]).slice(0, 40);
    mir.pages = [];
    const errorsByPage = new Map();
    for (let i = 0; i < pages.length; i++) {
      const errBefore = errors.length;
      await tab.send("Page.navigate", { url: `http://${DOMAIN}:${mport}${pages[i].path}` }).catch(() => {});
      await sleep(i === 0 ? 8000 : 5000); // the first visit installs the worker, then reloads
      const title = (await tev("document.title")) || "";
      const canv = await tev(`[...document.querySelectorAll("canvas")].filter((c) => { const b = c.getBoundingClientRect(); return b.width >= 200 && b.height >= 150; }).length`);
      const shot = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 55 }).catch(() => null);
      const file = `${host}-${mir.kind}-p${i}.jpg`;
      if (shot) writeFileSync(join(OUT, file), Buffer.from(shot.data, "base64"));
      const same = !pages[i].title || title.trim() === pages[i].title.trim();
      mir.pages.push({ path: pages[i].path, title, expected: pages[i].title, same, canvases: canv, shot: file });
      if (errors.length > errBefore) errorsByPage.set(pages[i].path, errors.slice(errBefore));
      console.log(`    ${same ? "✓" : "✗"} ${mir.kind} mirror ${pages[i].path} — "${title.slice(0, 60)}"${canv ? ` · ${canv} scene canvas(es)` : ""}`);
    }
    // tab icons are fetched by the browser itself (often once with the original address while the page
    // loads, before the mirror's script points them at its copy) — not part of the page's content
    const broken = [...new Set(fails.filter((u) => u && inMirror(u) && !/favicon|apple-touch-icon|\.ico(\?|$)/i.test(u)))];
    // an error only counts if the live site doesn't throw it too (sites have their own bugs)
    const newErrors = [];
    for (const [path, errs] of errorsByPage) {
      const own = errs.filter((e) => !/Failed to fetch|NetworkError|Load failed|net::ERR_/i.test(e));
      if (!own.length) continue;
      const liveErrs = await liveErrors(new URL(path, url).href);
      for (const e of own) if (!liveErrs.includes(e) && !newErrors.includes(e)) newErrors.push(e);
    }
    mir.broken = broken; mir.errors = newErrors; mir.files = Object.keys(manifest.paths).length;
    mir.sw = await tev("!!navigator.serviceWorker && !!navigator.serviceWorker.controller");
    if (broken.length) row.problems.push(`${mir.kind} mirror: ${broken.length} of its own files didn't load (${broken.slice(0, 2).join(" | ").slice(0, 160)})`);
    if (mir.pages.some((p) => !p.same)) row.problems.push(`${mir.kind} mirror: ${mir.pages.filter((p) => !p.same).length} page(s) don't show themselves`);
    if (!mir.sw) row.problems.push(`${mir.kind} mirror: service worker not running`);
    console.log(`    ${mir.kind} mirror offline at ${DOMAIN}: ${mir.files} files · ${broken.length} broken · ${newErrors.length} error(s) the live site doesn't have${newErrors.length ? ": " + newErrors.slice(0, 2).join(" | ").slice(0, 160) : ""} · worker ${mir.sw ? "on" : "OFF"}`);
    if (newErrors.length) row.problems.push(`${mir.kind} mirror throws ${newErrors.length} error(s) the live site doesn't: ${newErrors.slice(0, 3).join(" | ").slice(0, 300)}`);
    tab.close(); try { g.kill("SIGKILL"); srv.kill(); } catch {}
    setTimeout(() => rmSync(prof, { recursive: true, force: true }), 1500);
   } catch (e) {
    // an overloaded machine can leave Chrome unresponsive: record it, don't lose the whole run
    row.problems.push(`${mir.kind} mirror check couldn't run: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`    ✗ ${mir.kind} mirror check couldn't run: ${e instanceof Error ? e.message : e}`);
    for (const k of kids.slice(-2)) { try { k.kill("SIGKILL"); } catch {} }
   }
  }
  console.log(row.problems.length ? `  ✗ ${row.problems.length} problem(s)` : "  ✓ every button worked and every mirror runs offline");
}

// ── report ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
writeFileSync(join(OUT, "report.html"), `<!doctype html><meta charset="utf-8"><title>StyleLift on real sites</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#f6f6f4;color:#111}table{border-collapse:collapse;margin:8px 0 16px}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left;background:#fff}.bad{color:#b00020}.ok{color:#0a7a3a}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.grid img{width:100%;border:1px solid #ccc}figcaption{font-size:12px;color:#555}</style>
<h1>StyleLift — the real extension on real sites</h1>
${rows.map((r) => `<h2>${esc(r.url)}</h2>
${r.problems.length ? r.problems.map((p) => `<div class="bad">✗ ${esc(p)}</div>`).join("") : `<div class="ok">✓ every button worked and every mirror runs offline</div>`}
${(r.notes || []).map((n) => `<div>• ${esc(n)}</div>`).join("")}
<table><tr><th>Button</th><th>Time</th><th>Download</th><th>Panel said</th><th>Checks</th></tr>${r.exports.map((e) => `<tr><td>${esc(e.scope)} → ${esc(e.label)}</td><td>${e.secs}s</td><td>${esc(e.file)} (${(e.size / 1e6).toFixed(1)} MB)</td><td class="${e.ok ? "ok" : "bad"}">${esc(e.status)}</td><td>${esc(JSON.stringify(e.check || ""))}</td></tr>`).join("")}</table>
${r.mirrors.map((m) => `<h3>${m.kind === "site" ? "Whole-site" : "Page"} mirror — ${m.files} files, ${m.broken?.length || 0} broken, opened offline at my-site.test</h3><div class="grid">${(m.pages || []).map((p) => `<figure><figcaption class="${p.same ? "ok" : "bad"}">${esc(p.path)} — ${esc(p.title)}</figcaption><img src="${p.shot}"></figure>`).join("")}</div>`).join("")}`).join("")}`);
console.log(`\nReport: ${join(OUT, "report.html")}`);
const bad = rows.filter((r) => r.problems.length).length;
console.log(`${rows.length - bad}/${rows.length} sites: every button worked and every mirror runs offline`);
process.exit(bad ? 1 : 0);
