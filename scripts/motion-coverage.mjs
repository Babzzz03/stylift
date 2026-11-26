// Motion coverage: how much of a site's animation survives an export.
//
//   node scripts/motion-coverage.mjs <url …> --out <dir>    (dir = a verify-extension-real --out folder)
//
// For each site: open the LIVE page and the exported HTML (found in <dir>/<host>/*.html/index.html, made by
// `verify-extension-real --only html`), scroll each with real mouse-wheel input (smooth-scroll libraries
// such as Lenis ignore scrollTo), and count the elements that move:
//   reveals  — change once or twice as they come into view, then rest (fade / slide in)
//   scroll   — keep changing while scrolling (parallax, scrubbed timelines)
//   loops    — change with no scrolling at all (marquees, tickers, pulsing)
// "Change" = computed opacity / transform / translate / scale / rotate / clip-path / filter.
// Also lists the animation libraries the live page runs. Writes <dir>/motion.json and prints a table.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const OUT = flag("--out");
const BEFORE = flag("--before"); // optional: an earlier run's folder, to compare its export too
const urls = args.filter((a, i) => /^https?:\/\//.test(a) && args[i - 1] !== "--out" && args[i - 1] !== "--before");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");

// ── a static server for an export folder ─────────────────────────────────────
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".mp4": "video/mp4", ".webm": "video/webm" };
function serve(dir) {
  const srv = createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const f = normalize(join(dir, p));
    if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", TYPES[extname(f).toLowerCase()] || "application/octet-stream");
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

// ── Chrome ────────────────────────────────────────────────────────────────────
async function withChrome(fn) {
  const prof = mkdtempSync(join(tmpdir(), "sl-motion-"));
  const port = 9500 + Math.floor(Math.random() * 90);
  const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"]);
  // never outlive a hung page: Chrome goes with this script, and the whole run has a ceiling
  const killChrome = () => { try { ch.kill("SIGKILL"); } catch {} };
  process.on("exit", killChrome);
  const watchdog = setTimeout(() => { console.log(`\n✗ motion-coverage gave up after ${WATCHDOG_MIN} minutes (a page stopped responding)`); process.exit(2); }, WATCHDOG_MIN * 60000);
  watchdog.unref();
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(150); } }
    return await fn(port);
  } finally {
    try { ch.kill("SIGKILL"); } catch {}
    setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch {} }, 800);
  }
}
const WATCHDOG_MIN = 25; // the whole run
const PROBE_MS = 4 * 60000; // one page
async function openTab(port, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(20000) })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await Promise.race([new Promise((r) => ws.addEventListener("open", r)), sleep(20000).then(() => { throw new Error("DevTools socket did not open"); })]);
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => { pend.delete(i); r({ error: "timeout" }); }, 20000); pend.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // a copy's live 3D scenes stay pictures here: each would load the whole original site again (several heavy
  // WebGL pages rendered without a graphics card swamp the machine), and this measures page motion, not 3D
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) await send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){try{var P=window.ServiceWorkerContainer&&ServiceWorkerContainer.prototype;if(P)P.register=function(){return Promise.reject(new Error("no service workers while measuring"))}}catch(e){}})();` });
  await send("Page.navigate", { url });
  for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev("document.readyState")) === "complete") break; }
  return { send, ev, close: () => { try { ws.close(); } catch {} fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}

// ── the probe (runs in the page) ──────────────────────────────────────────────
const SAMPLER = `(() => {
  if (window.__mp) return true;
  const key = new WeakMap(); let next = 0; const seen = new Map(); const els = new Map();
  const sig = (el) => el.localName + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).filter((c) => !/^(is-|w--|active|visible|in-view|aos-)/.test(c)).slice(0, 2).join(".") : "") + "|" + (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 24);
  const state = (c) => [c.opacity, c.transform, c.translate, c.scale, c.rotate, c.clipPath, c.filter].join("|");
  window.__mp = {
    sample(tag) {
      const H = innerHeight, all = document.body ? document.body.getElementsByTagName("*") : [];
      let n = 0;
      for (let i = 0; i < all.length && n < 7000; i++) {
        const el = all[i];
        if (/^(script|style|link|meta|br|path|g|defs|use|source|noscript|template|tspan|stop|lineargradient|radialgradient|clippath|mask)$/i.test(el.localName)) continue;
        const r = el.getBoundingClientRect();
        // watched from a little below the screen: its look before it arrives is known (a reveal tied to the
        // scroll position can finish between two readings)
        if (r.bottom < -40 || r.top > H * 1.6 || r.width < 6 || r.height < 6) continue;
        n++;
        let id = key.get(el); if (id === undefined) { id = next++; key.set(el, id); els.set(id, el); }
        const s = state(getComputedStyle(el)); const rec = seen.get(id);
        if (!rec) { seen.set(id, { s, n: 0, tags: {} }); continue; }
        if (rec.s !== s) { rec.n++; rec.tags[tag] = (rec.tags[tag] || 0) + 1; rec.s = s; }
      }
      return n;
    },
    report() {
      let reveals = 0, scroll = 0, loops = 0;
      for (const r of seen.values()) {
        if (!r.n) continue;
        if (r.tags.idle) loops++;
        else if (r.n >= 3) scroll++;
        else reveals++;
      }
      const movers = [];
      for (const [id, r] of seen) if (r.n) movers.push((r.tags.idle ? "loop " : r.n >= 3 ? "scroll " : "reveal ") + sig(els.get(id)));
      return { reveals, scroll, loops, total: reveals + scroll + loops, tracked: seen.size, movers };
    },
  };
  return true;
})()`;
const LIBS = `(() => { const d = document, w = window, h = d.documentElement; const out = [];
  if (w.gsap || w.TweenMax || w.TweenLite) out.push("GSAP" + (w.ScrollTrigger || (w.gsap && w.gsap.plugins && w.gsap.plugins.scrollTrigger) ? "+ScrollTrigger" : ""));
  if (w.lenis || w.Lenis || h.classList.contains("lenis") || h.classList.contains("lenis-smooth")) out.push("Lenis");
  if (h.classList.contains("has-scroll-smooth") || d.querySelector("[data-scroll-container]")) out.push("Locomotive");
  if (d.querySelector("[data-framer-appear-id], [data-framer-name]")) out.push("Framer");
  if (w.Webflow || h.hasAttribute("data-wf-page")) out.push("Webflow");
  if (d.querySelector("[data-aos]")) out.push("AOS");
  if (w.Swiper || d.querySelector(".swiper")) out.push("Swiper");
  if (w.THREE || [...d.querySelectorAll("canvas")].some((c) => { try { return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } })) out.push("WebGL");
  if (w.lottie || w.bodymovin || d.querySelector("lottie-player, dotlottie-player")) out.push("Lottie");
  if (w.barba) out.push("Barba");
  if (d.getAnimations) { const a = d.getAnimations(); if (a.length) out.push(a.length + " CSS/WAAPI animations"); }
  return out; })()`;
// one page, with a deadline: a page that stops answering (its main thread stuck) ends the probe, not the run
function probe(port, url) {
  let timer;
  const tab = {};
  return Promise.race([probeOnce(port, url, tab), new Promise((_, no) => { timer = setTimeout(() => { tab.t?.close(); no(new Error(`no answer within ${PROBE_MS / 60000} minutes`)); }, PROBE_MS); })]).finally(() => clearTimeout(timer));
}
async function probeOnce(port, url, tab) {
  const t = (tab.t = await openTab(port, url));
  const t0 = Date.now();
  try {
    // watched from early on, left alone, until ~11 s: an intro — quick (a copy plays it as soon as its styles apply)
    // or late (after a site's preloader) — counts on both pages alike
    await sleep(1200);
    await t.ev(SAMPLER);
    await t.ev(`__mp.sample("idle0")`);
    for (let i = 0; i < 8; i++) {
      await sleep(1200);
      await t.ev(`__mp.sample("idle")`);
    }
    const libs = (await t.ev(LIBS)) || [];
    // scroll with the wheel, like a person; stop at the bottom. Nothing under the pointer reacts to it meanwhile
    // (pointer-events off everywhere — a work list sliding under it would show its hover posters, counted as scroll
    // motion on one page and not the other); the wheel still scrolls the page and reaches its scroll scripts
    await t.ev(`(() => { const s = document.createElement("style"); s.textContent = "*, *::before, *::after { pointer-events: none !important; }"; (document.head || document.documentElement).appendChild(s); return 1; })()`);
    await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 450 });
    let lastY = -1, still = 0;
    for (let i = 0; i < 90 && still < 4 && Date.now() - t0 < PROBE_MS - 30000; i++) {
      await t.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 2, y: 450, deltaX: 0, deltaY: 320 });
      await sleep(320);
      await t.ev(`__mp.sample("scroll")`);
      const y = await t.ev(`Math.round(scrollY + (document.scrollingElement ? 0 : 0))`);
      still = y === lastY ? still + 1 : 0;
      lastY = y;
    }
    const rep = await t.ev(`__mp.report()`);
    const height = await t.ev(`document.documentElement.scrollHeight`);
    return { ...rep, libs, scrolledTo: lastY, height };
  } finally {
    t.close();
  }
}

// ── run ───────────────────────────────────────────────────────────────────────
const findExport = (host, root = OUT) => {
  const base = root ? join(root, host) : null;
  if (!base || !existsSync(base)) return null;
  for (const d of readdirSync(base)) if (/\.html$/.test(d) && existsSync(join(base, d, "index.html"))) return join(base, d);
  return null;
};
const rows = [];
await withChrome(async (port) => {
  for (const url of urls) {
    const host = hostOf(url);
    console.log(`\n▶ ${url}`);
    const live = await probe(port, url).catch((e) => ({ error: String(e) }));
    const brief = (x) => JSON.stringify(x && { ...x, movers: undefined });
    console.log(`  live:   ${brief(live)}`);
    const dir = findExport(host);
    let html = null;
    if (dir) {
      const srv = await serve(dir);
      html = await probe(port, `http://127.0.0.1:${srv.address().port}/`).catch((e) => ({ error: String(e) }));
      srv.close();
      console.log(`  export: ${brief(html)}`);
      // what moves on the live page but not in the export (by tag, classes and text)
      // the kind (reveal / scroll / loop) aside: a reveal replayed on the scroll position still moves; and a <div> or a
      // <span> alike — the copy writes a script's <div> words inside a <p> as <span>s (the parser would split the <p>)
      const strip = (m) => m.replace(/^\w+ /, "").replace(/^(div|span)(?=[.|])/, "box");
      const got = new Set((html?.movers || []).map(strip));
      const missing = (live?.movers || []).filter((m) => !got.has(strip(m)));
      const kinds = {};
      for (const m of missing) { const k = m.split(" ")[0]; kinds[k] = (kinds[k] || 0) + 1; }
      console.log(`  missing in the export: ${missing.length} ${JSON.stringify(kinds)}`);
      if (html && live?.movers?.length) html.matched = Math.round((100 * (live.movers.length - missing.length)) / live.movers.length);
      for (const m of missing.slice(0, 18)) console.log(`    · ${m}`);
    } else console.log("  export: (no HTML export found — run verify-extension-real --only html first)");
    let before = null;
    const bdir = BEFORE ? findExport(host, BEFORE) : null;
    if (bdir) {
      const srv = await serve(bdir);
      before = await probe(port, `http://127.0.0.1:${srv.address().port}/`).catch((e) => ({ error: String(e) }));
      srv.close();
      console.log(`  before: ${brief(before)}`);
    }
    rows.push({ url, live, html, before });
  }
});
console.log("\nsite                          live (reveal/scroll/loop)   before                      after (reveal/scroll/loop)   kept before → after   same elements moving");
for (const r of rows) {
  const f = (x) => (x && !x.error ? `${String(x.total).padStart(3)} (${x.reveals}/${x.scroll}/${x.loops})` : "  —");
  const pct = (x) => (r.live?.total && x && x.total !== undefined ? Math.round((100 * Math.min(x.total, r.live.total)) / r.live.total) + "%" : "—");
  console.log(`${hostOf(r.url).padEnd(30)}${f(r.live).padEnd(28)}${f(r.before).padEnd(28)}${f(r.html).padEnd(29)}${pct(r.before)} → ${pct(r.html)}   ${r.html?.matched !== undefined ? r.html.matched + "%" : "—"}   ${(r.live?.libs || []).join(", ")}`);
}
if (OUT) writeFileSync(join(OUT, "motion.json"), JSON.stringify(rows, null, 2));
