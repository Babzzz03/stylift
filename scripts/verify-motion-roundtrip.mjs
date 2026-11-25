// Motion round trip, through the REAL extension: a page animated with GSAP (from its CDN) and a ticker
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

// ── the animated page ──────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html><head><title>Motion</title><style>body{margin:0;font:16px sans-serif} .card{width:220px;height:120px;background:#c33;margin:30px} .tall{height:1500px}</style></head><body>
<h1 id="hero">Big intro</h1>
<a id="mag" href="#m" style="display:inline-block;margin:40px;padding:20px 40px;background:#111;color:#fff"><span>Magnet</span></a>
<canvas id="scene" width="400" height="300" style="display:block;width:400px;height:300px;margin:20px 40px"></canvas>
<div class="tall"></div>
<h2 id="sth" style="font-size:56px;margin:40px">${["L", "E", "T", "T", "E", "R", "S"].map((c) => `<span style="display:inline-block;opacity:0;transform:translateY(40px)">${c}</span>`).join("")}</h2>
<div class="tall"></div>
<div class="card" id="c1">one</div><div class="card" id="c2">two</div><div class="card" id="c3">three</div>
<div style="overflow:hidden;width:500px"><div id="rafm" style="display:flex;width:max-content"><span style="width:300px;display:block">A</span><span style="width:300px;display:block">B</span><span style="width:300px;display:block">A</span><span style="width:300px;display:block">B</span></div></div>
<div class="tall"></div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script>
gsap.registerPlugin(ScrollTrigger);
gsap.from("#hero", { y: 50, opacity: 0, duration: 30, ease: "power2.out" });
gsap.from(".card", { y: 80, opacity: 0, duration: 0.9, stagger: 0.15, ease: "expo.out", scrollTrigger: { trigger: ".card", start: "top 85%" } });
{ const c = document.getElementById("scene"); const gl = c.getContext("webgl", { preserveDrawingBuffer: true }); window.__frames = 0; window.__mx = -1; addEventListener("mousemove", (e) => { window.__mx = e.clientX; }); const f = () => { gl.clearColor(0.2, 0.5, (Date.now() % 1500) / 1500, 1); gl.clear(gl.COLOR_BUFFER_BIT); window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); }
{ const mag = document.getElementById("mag"); mag.addEventListener("mousemove", (e) => { const r = mag.getBoundingClientRect(); mag.style.transform = "translate(" + ((e.clientX - r.left - r.width / 2) * 0.4).toFixed(1) + "px," + ((e.clientY - r.top - r.height / 2) * 0.4).toFixed(1) + "px)"; }); mag.addEventListener("mouseleave", () => { mag.style.transform = ""; }); }
{ const ls = [...document.querySelectorAll("#sth span")]; let go = false; new IntersectionObserver((es) => { if (go || !es.some((e) => e.isIntersecting)) return; go = true; const t0 = performance.now(); const f = (t) => { let more = false; ls.forEach((l, i) => { const p = Math.max(0, Math.min(1, (t - t0 - i * 80) / 600)); const e = 1 - Math.pow(1 - p, 3); l.style.opacity = String(e); l.style.transform = "translateY(" + (40 * (1 - e)).toFixed(2) + "px)"; if (p < 1) more = true; }); if (more) requestAnimationFrame(f); }; requestAnimationFrame(f); }, { threshold: 0.5 }).observe(document.getElementById("sth")); }
{ const t0 = performance.now(); const el = document.getElementById("rafm"); const f = (t) => { el.style.transform = "translateX(" + (-(((t - t0) * 0.06) % 600)) + "px)"; requestAnimationFrame(f); }; requestAnimationFrame(f); }
</script></body></html>`;
const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

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
const site = await getJSON(`/json/new?${encodeURIComponent(origin + "/")}`, "PUT");
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
  for (let i = 0; i < 80 && !(await s.ev(`!!(window.__studio && window.__studio.S.frames.size === 3 && [...window.__studio.S.frames.values()].every((f) => f.contentDocument && f.contentDocument.querySelector("#c1")))`)); i++) await sleep(250);
  const rec = await s.ev(`(() => { const d = window.__studio.S.doc; const g = (sel) => d.querySelector(sel); return { hero: g("#hero") && g("#hero").getAttribute("data-sl-in"), cards: [...d.querySelectorAll(".card")].map((c) => c.getAttribute("data-sl-in-on")).join(), tick: g("#rafm") && g("#rafm").hasAttribute("data-sl-loop"), runtime: !!d.querySelector("script[data-sl-motion-runtime]") }; })()`);
  if (!rec.hero && !rec.cards) console.log("  (GSAP didn't load from its CDN — offline? the GSAP checks below will fail)");
  ok(rec.hero && rec.cards === "enter,enter,enter" && rec.tick && rec.runtime, `the capture carries the site's motion into Studio (${JSON.stringify(rec)})`);
  // the 3D scene: marked as a live scene in Studio, its files kept with the project
  const sc = await s.ev(`(async () => { const ph = window.__studio.S.doc.querySelector("[data-sl-island]"); const id = window.__studio.S.project.id; const files = await new Promise((res) => { const rq = indexedDB.open("stylelift-studio"); rq.onsuccess = () => { try { const g = rq.result.transaction("scenes", "readonly").objectStore("scenes").get(id); g.onsuccess = () => res(g.result ? Object.keys(g.result.files) : []); g.onerror = () => res([]); } catch (e) { res([]); } }; rq.onerror = () => res([]); }); return { ph: ph ? ph.getAttribute("data-sl-island-sel") : null, files: files.filter((k) => !k.startsWith("_3d/site/") && !k.startsWith("_3d/_ext/")) }; })()`);
  ok(sc.ph === "#scene" && sc.files.includes("_3d/island.html") && sc.files.includes("sl-islands.js") && sc.files.includes("sl-island-sw.js"), `the WebGL scene is kept live in Studio: marked, its own files saved with the project (${JSON.stringify(sc)})`);
  // the letters a script animated in one after another, and the magnetic button: recorded with their timing / strength
  const pfx = await s.ev(`(() => { const d = window.__studio.S.doc; const m = d.querySelector("#mag"); const ls = [...d.querySelectorAll("#sth span")]; const dl = ls.map((l) => Number((/--sl-in-dl: ?(\\d+)/.exec(l.getAttribute("style") || "") || [])[1] || -1)); return { magnet: m && m.getAttribute("data-sl-magnet"), pull: !!(m && (m.hasAttribute("data-sl-pull") || m.querySelector("[data-sl-pull]"))), dl, enter: ls.every((l) => l.getAttribute("data-sl-in-on") === "enter") }; })()`);
  const rising = pfx.dl.length === 7 && pfx.dl.every((x, i) => x >= 0 && (i === 0 || x > pfx.dl[i - 1]));
  ok(Math.abs(parseFloat(pfx.magnet) - 0.4) <= 0.08 && pfx.pull, `the capture records the magnetic button's pull (${pfx.magnet} ≈ 0.4)`);
  ok(pfx.enter && rising, `…and the letters coming in one after another, each with its own delay (${pfx.dl.join("/")} ms)`);
  const magId = await s.ev(`window.__studio.S.doc.querySelector("#mag").getAttribute("data-sl-id")`);
  await s.ev(`(window.__studio.select(${JSON.stringify(magId)}), true)`);
  await sleep(500);
  const mp = await s.ev(`(() => { const sec = [...document.querySelectorAll("#props .sec")].find((x) => x.querySelector("h4 span") && x.querySelector("h4 span").textContent === "Animate"); const heads = sec ? [...sec.querySelectorAll(".site-motion .sm-head span")].map((h) => h.textContent) : []; const i = sec && [...sec.querySelectorAll(".site-motion input[type=number]")][0]; if (i) { i.value = "25"; i.dispatchEvent(new Event("change")); } return { heads, had: i ? true : false }; })()`);
  await sleep(500);
  const mag2 = await s.ev(`window.__studio.S.doc.querySelector("#mag").getAttribute("data-sl-magnet")`);
  ok(mp.heads.some((h) => /Follows the pointer \(magnetic\)/.test(h)) && mag2 === "0.25", `Studio shows the site's pointer effect and its strength can be edited (${mp.heads.join(" | ")}; now ${mag2})`);
  // the Animate panel shows it; it plays on the artboard
  const c1 = await s.ev(`window.__studio.S.doc.querySelector("#c1").getAttribute("data-sl-id")`);
  await s.ev(`(window.__studio.select(${JSON.stringify(c1)}), true)`);
  await sleep(500);
  const anim = await s.ev(`(() => { const sec = [...document.querySelectorAll("#props .sec")].find((x) => x.querySelector("h4 span") && x.querySelector("h4 span").textContent === "Animate"); const box = sec && sec.querySelector(".site-motion"); return { head: box && box.querySelector(".sm-head").textContent, fields: box ? box.querySelectorAll("input[type=number]").length : 0, badge: !!document.querySelector("#layers .row.selected .row-motion") }; })()`);
  ok(/From the original site: Entrance as it scrolls into view/.test(anim.head || "") && anim.fields === 2 && anim.badge, `the site's animation shows in the Animate panel, with its timing (${JSON.stringify(anim)})`);
  // edit: the recorded duration (through the panel field) and the heading's text
  await s.ev(`(() => { const sec = [...document.querySelectorAll("#props .sec")].find((x) => x.querySelector("h4 span") && x.querySelector("h4 span").textContent === "Animate"); const i = sec.querySelector(".site-motion input[type=number]"); i.value = "1500"; i.dispatchEvent(new Event("change")); return true; })()`);
  await sleep(400);
  const hero = await s.ev(`window.__studio.S.doc.querySelector("#hero").getAttribute("data-sl-id")`);
  await s.ev(`(window.__studio.select(${JSON.stringify(hero)}), window.__studio.setText("Edited intro"), true)`);
  await sleep(500);
  const onBoard = await s.ev(`(() => { const d = window.__studio.S.frames.get("base").contentDocument; return { d: getComputedStyle(d.querySelector("#c1")).getPropertyValue("--sl-in-d").trim(), text: d.querySelector("#hero").textContent }; })()`);
  ok(onBoard.d === "1500ms" && onBoard.text === "Edited intro", `the edits show on the artboard (${JSON.stringify(onBoard)})`);
  // ── Studio's Preview: the same code runs ──────────────────────────────────────
  const seen = new Set((await getJSON("/json/list")).map((t) => t.id));
  await s.ev(`document.querySelector("#preview-btn").click()`);
  let pv = null;
  for (let i = 0; i < 40 && !pv; i++) { pv = (await getJSON("/json/list")).find((t) => !seen.has(t.id) && t.type === "page"); if (!pv) await sleep(250); }
  ok(!!pv, "Preview opens a tab");
  if (pv) {
    await fetch(`http://127.0.0.1:${port}/json/activate/${pv.id}`);
    const p = cdp(pv.webSocketDebuggerUrl); await p.ready;
    await sleep(1500);
    const a = await p.ev(`(() => { const c = document.querySelector("#c1"); const an = c.getAnimations().map((x) => x.playState); return { text: document.querySelector("#hero").textContent, d: getComputedStyle(c).getPropertyValue("--sl-in-d").trim(), held: an.join(), tick: document.querySelector("#rafm").getAnimations().length, inline: !!document.querySelector("script[data-sl-motion-runtime]:not([src])"), ext: !!(window.chrome && chrome.runtime && chrome.runtime.id) }; })()`);
    ok(a.text === "Edited intro" && a.d === "1500ms" && /paused/.test(a.held) && a.tick > 0, `Preview runs the same code: edited text and timing, the entrance waiting below the fold, the ticker looping (${JSON.stringify(a)})`);
    ok(a.inline && !a.ext, `…the export's own inline scripts run there, in a sandbox with no access to the extension (inline ${a.inline}, extension APIs ${a.ext})`);
    let live = null;
    for (let i = 0; i < 150 && !(live && live.frames > 5 && live.shown === "1"); i++) { live = await p.ev(`(() => { const f = document.querySelector("[data-sl-island-box] iframe"); if (!f) return null; try { const w = f.contentWindow; return { frames: w.__frames || 0, shown: f.style.opacity, frame: w.location.pathname + w.location.search.slice(0, 20), title: w.document.title, scene: !!w.__slIsland, ready: !!(w.__slIsland && w.__slIsland.ready()) }; } catch (e) { return { err: String(e) }; } })()`).catch(() => null); if (!(live && live.frames > 5 && live.shown === "1")) await sleep(400); }
    ok(live && live.frames > 5 && live.shown === "1", `…the 3D scene runs live in the Preview, from the site's own code (${JSON.stringify(live)})`);
    const mb = await p.ev(`(() => { const r = document.querySelector("#mag").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mb[0] + 50, y: mb[1] });
    await sleep(700);
    const mt = await p.ev(`getComputedStyle(document.querySelector("#mag")).translate`);
    ok(Math.abs(parseFloat(mt) - 12.5) <= 2.5, `…the magnetic button follows the real pointer there, with the strength edited in Studio (${mt} ≈ 12.5px)`);
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1300, y: 700 });
    // scroll until the cards are in view (wheel steps, as a visitor would)
    for (let i = 0; i < 12; i++) {
      const top = await p.ev(`document.querySelector(".card").getBoundingClientRect().top`);
      if (top < 500) break;
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: Math.min(1200, Math.round(top - 300)) });
      await sleep(350);
    }
    await sleep(1600);
    const b = await p.ev(`[...document.querySelectorAll(".card")].map((c) => getComputedStyle(c).opacity + "/" + c.getAnimations().map((x) => x.playState).join("")).join(" ") + " · scrolled to " + Math.round(scrollY) + " · scene at " + (() => { try { return Math.round(document.querySelector("[data-sl-island-box] iframe").contentWindow.scrollY); } catch (e) { return "?"; } })()`);
    ok(!/paused/.test(b), `…scrolled to, the cards play (${b})`);
    p.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${pv.id}`).catch(() => {});
  }
  await fetch(`http://127.0.0.1:${port}/json/activate/${studioT.id}`);
  await sleep(500);
  // ── exports from Studio carry every edit and every animation ──────────────────
  const box = (sel) => s.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (pt) => { await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }); await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 }); await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 }); await sleep(300); };
  const exportAs = async (kind, re) => {
    const before = new Set(readdirSync(downloads));
    await click(await box("#export-btn"));
    await click(await box(`[data-export="${kind}"]`));
    for (let i = 0; i < 240; i++) { const f = readdirSync(downloads).filter((x) => !before.has(x) && re.test(x) && !x.endsWith(".crdownload") && !x.startsWith(".")); if (f.length) { await sleep(500); return f[0]; } await sleep(250); }
    return null;
  };
  const unzip = (f) => { const d = mkdtempSync(join(tmpdir(), "sl-unz-")); execFileSync("unzip", ["-oq", join(downloads, f), "-d", d]); return d; };
  const all = (dir) => readdirSync(dir, { recursive: true }).filter((f) => /\.(html|css|jsx?|mjs)$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const hz = await exportAs("html", /\.html( \(\d+\))?\.zip$/);
  ok(!!hz, "HTML export downloaded from Studio");
  if (hz) {
    const txt = all(unzip(hz));
    ok(/Edited intro/.test(txt), "HTML export: the edited text");
    ok(/--sl-in-d: 1500ms !important/.test(txt), "HTML export: the edited animation timing");
    ok(/@keyframes sl-in-g\d/.test(txt) && /data-sl-in-on="enter"/.test(txt) && /data-sl-loop=/.test(txt), "HTML export: the site's animations (entrances, the ticker loop)");
    ok(/data-sl-motion-runtime/.test(txt) && /offsetTop/.test(txt), "HTML export: the scroll-in trigger script");
    ok(/data-sl-magnet="0\.25"/.test(txt) && /\[data-sl-pull="p\d+"\] \{\s*translate: var\(--slm-mx/.test(txt) && /--slm-mx/.test((txt.match(/<script data-sl-motion-runtime[\s\S]*?<\/script>/) || [""])[0]), "HTML export: the pointer effect with its edited strength, its CSS and the script that drives it");
    // the live 3D scene: served from the export's own address, it runs
    const hdir = unzip(hz);
    ok(["sl-islands.js", "sl-island-sw.js", "_3d/island.html", "_3d/mirror-manifest.json"].every((f) => existsSync(join(hdir, f))) && /data-sl-island="/.test(readFileSync(join(hdir, "index.html"), "utf8")), "HTML export: the 3D scene's own files and its loader");
    const TY = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
    const xs = createServer((q, res) => { let pth = decodeURIComponent(q.url.split("?")[0]); if (pth.endsWith("/")) pth += "index.html"; const f = join(hdir, pth); if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": TY[(f.match(/\.[a-z0-9]+$/i) || [""])[0]] || "application/octet-stream" }); res.end(readFileSync(f)); });
    await new Promise((res) => xs.listen(0, "127.0.0.1", res));
    const xt = await getJSON(`/json/new?${encodeURIComponent(`http://127.0.0.1:${xs.address().port}/`)}`, "PUT");
    const xp = cdp(xt.webSocketDebuggerUrl); await xp.ready;
    let xl = null;
    for (let i = 0; i < 150 && !(xl && xl.frames > 5 && xl.shown === "1"); i++) { await sleep(400); xl = await xp.ev(`(() => { const f = document.querySelector("[data-sl-island-box] iframe"); if (!f) return null; try { const w = f.contentWindow; return { frames: w.__frames || 0, shown: f.style.opacity, scene: !!w.__slIsland, ready: !!(w.__slIsland && w.__slIsland.ready()) }; } catch (e) { return { err: String(e) }; } })()`).catch(() => null); }
    ok(xl && xl.frames > 5 && xl.shown === "1", `HTML export, served from its own address: the 3D scene runs live (${JSON.stringify(xl)})`);
    xp.close(); await fetch(`http://127.0.0.1:${port}/json/close/${xt.id}`).catch(() => {}); xs.close();
  }
  const rz = await exportAs("react", /\.react( \(\d+\))?\.zip$/);
  ok(!!rz, "React (Vite) export downloaded from Studio");
  if (rz) {
    const txt = all(unzip(rz));
    ok(/Edited intro/.test(txt) && /data-sl-magnet="0\.25"/.test(txt) && /data-sl-pull=/.test(txt) && /--slm-mx/.test(txt) && /offsetTop/.test(txt), "React export: the edits, the pointer effect, the animations' CSS and the trigger");
  }
  const ez = await exportAs("elementor", /\.elementor( \(\d+\))?\.json$/);
  ok(!!ez, "Elementor export downloaded from Studio");
  if (ez) {
    let w = [];
    try { w = JSON.parse(readFileSync(join(downloads, ez), "utf8")).content.map((c) => c.elements[0].settings.html); } catch {}
    const joined = w.join("\n");
    ok(/Edited intro/.test(joined) && /data-sl-magnet="0\.25"/.test(joined) && /--sl-in-d: 1500ms/.test(joined) && /<script data-sl-motion-runtime>[\s\S]*--slm-mx/.test(w[w.length - 1] || ""), "Elementor export: the edits, the animations' CSS, the pointer effect and the trigger as its last widget");
  }
  const nz = await exportAs("next", /\.next( \(\d+\))?\.zip$/);
  ok(!!nz, "Next.js export downloaded from Studio");
  if (nz) {
    const txt = all(unzip(nz));
    ok(/Edited intro/.test(txt) && /--sl-in-d: 1500ms !important/.test(txt), "Next.js export: the edited text and timing");
    ok(/@keyframes sl-in-g\d/.test(txt) && /data-sl-in-on="enter"/.test(txt) && /"--sl-in-d"/.test(txt), "Next.js export: the animations and their timing variables in the components");
    ok(/SlAnimations/.test(txt) && /offsetTop/.test(txt), "Next.js export: the trigger runs from the layout (SlAnimations)");
    ok(/data-sl-magnet="0\.25"/.test(txt) && /\[data-sl-pull="p\d+"\]/.test(txt) && /--slm-mx/.test(txt), "Next.js export: the pointer effect, its CSS and the script that drives it");
    const ndir = unzip(nz);
    ok(["public/sl-islands.js", "public/sl-island-sw.js", "public/_3d/island.html"].every((f) => existsSync(join(ndir, f))) && /data-sl-island="/.test(txt) && /sl-islands\.js/.test(txt), "Next.js export: the 3D scene's own files in public/, started from the layout");
  }
  s.close();
} catch (e) {
  failures.push("run: " + e.message);
  console.log("  ✗ ERROR", e.message);
}
panel.close(); sw.close(); server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
