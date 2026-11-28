// Studio artboards show the whole page at once and never scroll: each scroll-driven animation must show its element as
// it looks when the page is scrolled to it (src/studio/scroll-hold.ts). A page laid out at its full height (nothing to
// scroll, like an artboard), its scroll animations held by pageScrollInView, and each element's look checked:
//   a panel fixed to the screen that slides away as you scroll → as at the top (monodrift's hero)
//   a section far down that fades in as it's scrolled to → shown (framer.com's feature grid)
//   a headline at the top leaving as you scroll → shown, in place
//   one half way through its scrub at the point it's centred → half way
//   an element's own view() reveal → left alone
//   node scripts/verify-studio-scroll.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else failed++; console.log(`  ${c ? "✓" : "✗"} ${m}`); };

const bdir = mkdtempSync(join(tmpdir(), "sl-sscroll-b-"));
await build({ entryPoints: { hold: "src/studio/scroll-hold.ts" }, outdir: bdir, bundle: true, format: "iife", globalName: "SLHold", platform: "browser", target: "es2021", logLevel: "silent" });
const hold = readFileSync(join(bdir, "hold.js"), "utf8");

const page = `<!doctype html><html><head><style>
html, body { margin: 0; overflow: visible; } body { height: 4000px; position: relative; font: 20px sans-serif; }
.b { position: absolute; left: 100px; width: 300px; height: 100px; background: #c63; }
@keyframes slide { 0% { transform: none; } 100% { transform: translateX(-500px); } }
@keyframes fadein { 0% { opacity: 0; } 100% { opacity: 1; } }
@keyframes leave { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes rise { 0% { transform: translateY(100px); } 100% { transform: translateY(-100px); } }
@keyframes rev { 0% { opacity: 0.2; } 100% { opacity: 1; } }
#hero { position: fixed; top: 0; left: 0; width: 600px; height: 200px; background: #333; animation: slide linear both; animation-timeline: scroll(root block); animation-range: 0px 900px; }
#fade { top: 2500px; animation: fadein linear both; animation-timeline: scroll(root block); animation-range: 1700px 2100px; }
#leave { top: 300px; animation: leave linear both; animation-timeline: scroll(root block); animation-range: 0px 400px; }
#mid { top: 1500px; animation: rise linear both; animation-timeline: scroll(root block); animation-range: 800px 1600px; }
#rev { top: 3200px; animation: rev linear both; animation-timeline: view(); animation-range: entry 0% cover 40%; }
</style></head><body>
<div id="hero">hero</div><div class="b" id="leave">leave</div><div class="b" id="mid">mid</div><div class="b" id="fade">fade</div><div class="b" id="rev">rev</div>
</body></html>`;
const srv = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(page); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const prof = mkdtempSync(join(tmpdir(), "sl-sscroll-p-"));
const port = 9860 + Math.floor(Math.random() * 40);
const ch = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1440,900", "--hide-scrollbars", "about:blank"]);
const finish = (code) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); rmSync(bdir, { recursive: true, force: true }); process.exit(code); }, 300); };
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.log(`✗ stopped: ${e?.message || e}`); finish(2); });
setTimeout(() => { console.log("✗ timeout"); finish(2); }, 120000);
for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((r) => { const k = ++id; pend.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
// laid out at its full height, like an artboard: nothing to scroll
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 4000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${srv.address().port}/` });
await sleep(1500);
await ev(`${hold}; SLHold.pageScrollInView(document, 900); 1`);
await sleep(300);
const look = await ev(`(() => { const g = (q) => getComputedStyle(document.querySelector(q)); const tl = (q) => document.querySelector(q).getAnimations()[0]?.timeline?.constructor?.name; return { hero: g("#hero").transform, fade: +g("#fade").opacity, leave: +g("#leave").opacity, mid: g("#mid").transform, rev: tl("#rev") }; })()`);
const ty = (tf) => { const m = /matrix\(([^)]+)\)/.exec(tf || ""); return m ? m[1].split(",").map(Number) : [1, 0, 0, 1, 0, 0]; };
ok(Math.abs(ty(look.hero)[4]) < 1, `a panel fixed to the screen that slides away as you scroll shows as at the top (${look.hero})`);
ok(look.fade > 0.99, `a section far down that fades in as it's scrolled to shows (opacity ${look.fade})`);
ok(look.leave > 0.99, `a headline at the top that leaves as you scroll shows (opacity ${look.leave})`);
// #mid: top 1500, 100 tall → centred at a scroll of 1100: 3/8 of its 800→1600 range → translateY 100 - 0.375 × 200 = 25
ok(Math.abs(ty(look.mid)[5] - 25) < 3, `one half way through its scrub where it's centred shows that far (${look.mid}, expected translateY 25)`);
ok(look.rev === "ViewTimeline", `an element's own view() reveal is left alone (${look.rev})`);
// placed again once the page settles: a picture loading above it moves it down
await ev(`(() => { const s = document.createElement("div"); s.style.height = "600px"; document.body.prepend(s); document.querySelectorAll(".b").forEach((b) => (b.style.top = parseFloat(getComputedStyle(b).top) + 600 + "px")); SLHold.pageScrollInView(document, 900); return 1; })()`);
await sleep(300);
const mid2 = await ev(`getComputedStyle(document.querySelector("#mid")).transform`);
// now top 2100 → centred at 1700: past its range → translateY -100
ok(Math.abs(ty(mid2)[5] + 100) < 3, `placed again after the page settles and moves it down (${mid2}, expected translateY -100)`);
console.log(`\n${passed} passed, ${failed} failed`);
finish(failed ? 1 : 0);
