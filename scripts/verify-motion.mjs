// Studio motion: --slm-* edits → CSS (entrances, scroll, hover, loops, breakpoints) and the export's
// trigger script, checked as CSS text and then for real in headless Chrome: an exported page whose
// below-the-fold entrance waits until it is scrolled to, word-by-word text, a hover lift built on a
// moved element, a site's own transform kept, and the same page with scripts off (nothing left hidden).
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const od = mkdtempSync(join(tmpdir(), "sl-motion-"));
await build({ entryPoints: { model: "src/studio/model.ts", motion: "src/studio/motion.ts", elementor: "src/panel/elementor.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent", minify: true }); // minified like the shipped extension: the trigger script is copied out of it as text
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const M = await import(pathToFileURL(join(od, "model.js")));
const Mo = await import(pathToFileURL(join(od, "motion.js")));
const El = await import(pathToFileURL(join(od, "elementor.js")));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CSS ─────────────────────────────────────────────────────────────────────
let edits = {};
const put = (id, scope, m) => { for (const [k, v] of Object.entries(Mo.motionToProps(m))) edits = M.setEdit(edits, id, scope, k, v); };
put("2", "base", Mo.defaultMotion("enter", false, "up"));
put("3", "base", { ...Mo.defaultMotion("hover", false, "lift"), dist: 6 });
edits = M.setEdit(edits, "3", "base", "translate", "40px 10px");
put("4", "base", Mo.defaultMotion("loop", false, "spin"));
put("5", "base", Mo.defaultMotion("enter", true, "words"));
put("6", "base", { ...Mo.defaultMotion("enter", false, "fade"), stagger: 100 });
put("7", "base", Mo.defaultMotion("scroll", false, "zoom"));
put("2", "phone", { ...Mo.defaultMotion("enter"), on: "none" });
const css = M.editsToCss(edits);
ok(/@keyframes slm-up \{ from \{ opacity: 0 \} \}/.test(css) && /@keyframes slm-up-t \{ from \{ transform: translateY\(var\(--slm-d, 32px\)\) \} \}/.test(css), "an entrance compiles to keyframes FROM a state back to the element's own styles");
ok(/\[data-sl-id="2"\] \{ animation: slm-up 800ms [^;]+ 0ms backwards, slm-up-t 800ms [^;]+ backwards !important; animation-composition: replace, add !important; \}/.test(css), "…movement composed onto the element's own transform (add), nothing left behind after (backwards)");
ok(/@media \(max-width: 809\.98px\) \{[\s\S]*\[data-sl-id="2"\] \{ animation: none !important; \}/.test(css), "\"None\" on Phone switches the Desktop entrance off there");
ok(/@media \(hover: hover\) \{ \[data-sl-id="3"\]:hover \{ translate: 40px calc\(10px - 6px\) !important;/.test(css), "a hover lift builds on the element's own (moved) position, only where there's a real pointer");
ok(/\[data-sl-id="4"\] \{ --slm-d: 10px; animation: slm-loop-spin 8000ms linear 0ms infinite normal both !important; animation-composition: add !important; \}/.test(css), "a loop runs forever, composed onto the element's transform");
ok(/\[data-sl-id="5"\]\[data-slm-split\] \.slm-w \{ animation: [^}]*calc\(0ms \+ var\(--slm-i, 0\) \* 45ms\)/.test(css) && /\[data-sl-id="5"\]:not\(\[data-slm-split\]\)/.test(css), "word by word: each word waits its turn; unsplit text comes in as one");
ok(/\[data-sl-id="6"\] > :nth-child\(3\) \{ animation-delay: 200ms !important; \}/.test(css), "stagger: children come in one after another (3rd child +200 ms)");
ok(/@supports \(animation-timeline: view\(\)\) \{ \[data-sl-id="7"\] \{ animation: slm-zoom linear backwards, slm-zoom-t linear backwards !important;[^}]*animation-timeline: view\(\), view\(\) !important; animation-range: entry 0% cover 40% !important;/.test(css), "while scrolling: tied to the scroll position where the browser supports it");
ok(/prefers-reduced-motion: no-preference/.test(css) && !/prefers-reduced-motion/.test(M.editsToCss(edits, { motionGuard: false })), "exports respect reduced motion; Studio's artboards always show it");
const r = Mo.readMotion(M.mergedEdits(edits, "2", "phone"));
ok(r && r.on === "none" && Mo.readMotion(M.mergedEdits(edits, "2", "tablet"))?.fx === "up", "breakpoints: Phone reads None, Tablet inherits Desktop's slide");

// export assembly: the trigger script only when something needs it
const page = (body) => new dom.window.DOMParser().parseFromString(`<!doctype html><html><head></head><body>${body}</body></html>`, "text/html");
const withScript = M.buildExportHtml(page(`<div data-sl-id="2">x</div>`), edits);
ok(/<script data-sl-motion-runtime="">(\/\*[\s\S]*?\*\/\s*)?\(function/.test(withScript), "an export with scroll-into-view motion carries the trigger script");
{ const mv = M.buildExportHtml(page(`<model-viewer data-sl-id="9" data-sl-model="Chair.glb" src="data:model/gltf-binary;base64,Z2xURg==" camera-controls=""><img slot="poster" src="x.png"></model-viewer>`), {});
  ok(/<script type="module" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@google\/model-viewer@4\.0\.0\/dist\/model-viewer\.min\.js" data-sl-model-viewer="">/.test(mv) && (mv.match(/data-sl-model-viewer/g) || []).length === 1, "a page with your own 3D model (Studio) loads the model viewer once — in Preview and the single-file export"); }
let hoverOnly = {};
for (const [k, v] of Object.entries(Mo.motionToProps(Mo.defaultMotion("hover")))) hoverOnly = M.setEdit(hoverOnly, "2", "base", k, v);
ok(!/data-sl-motion-runtime/.test(M.buildExportHtml(page(`<div data-sl-id="2">x</div>`), hoverOnly)), "hover / loop only: pure CSS, no script");
{
  // Elementor / WordPress: the same edited page as widgets — the animations' CSS and the trigger script go with it
  const tpl = El.buildElementorTemplate(withScript, "t");
  const widgets = tpl.content.map((c) => c.elements[0].settings.html);
  const last = widgets[widgets.length - 1];
  ok(/@keyframes slm-up/.test(widgets[0]) && /<script data-sl-motion-runtime>[\s\S]*getAnimations/.test(last) && widgets.slice(1, -1).some((h) => /data-sl-id="2"/.test(h)), "Elementor / WordPress export: the animation CSS first, the edited element, the trigger script last");
}

// ── in a real browser ─────────────────────────────────────────────────────────
let ex = {};
const add = (id, m, extra = {}) => { for (const [k, v] of Object.entries({ ...Mo.motionToProps(m), ...extra })) ex = M.setEdit(ex, id, "base", k, v); };
add("10", { ...Mo.defaultMotion("load", false, "up"), dur: 300 });
add("11", { ...Mo.defaultMotion("enter", false, "up"), dur: 300 });
add("12", { ...Mo.defaultMotion("enter", true, "words"), dur: 200, stagger: 20 });
add("13", { ...Mo.defaultMotion("hover", false, "lift"), dur: 50 }, { translate: "30px 0px" });
add("14", { ...Mo.defaultMotion("enter", false, "zoom"), dur: 300 });
add("15", { ...Mo.defaultMotion("loop", false, "pulse") });
add("16", { ...Mo.defaultMotion("hover", false, "magnet"), dur: 60 }, { translate: "20px 0px" });
add("17", { ...Mo.defaultMotion("hover", false, "tilt3d"), dur: 60 });
const html = M.buildExportHtml(page(`
  <style>body{margin:0;font:16px sans-serif} .tall{height:2600px} #c{position:absolute;left:50%;top:200px;transform:translateX(-50%);width:100px;height:40px}</style>
  <div data-sl-id="10" id="a" style="height:60px">Loads</div>
  <div data-sl-id="13" id="h" style="width:80px;height:30px">Hover</div>
  <div data-sl-id="14" id="c">Centred</div>
  <div data-sl-id="15" id="p" style="width:20px;height:20px">L</div>
  <div data-sl-id="16" id="mg" style="position:absolute;left:40px;top:420px;width:200px;height:60px;background:#ddd">Magnet</div>
  <div data-sl-id="17" id="tt" style="position:absolute;left:300px;top:420px;width:200px;height:100px;background:#ddd">Tilt</div>
  <style>[data-sl-pull="p1"] { translate: var(--slm-mx, 0px) var(--slm-my, 0px) !important; transition: translate 60ms linear !important; } [data-sl-cursor] { translate: var(--slm-cx, 0px) var(--slm-cy, 0px) !important; }</style>
  <a id="sm" href="#x" data-sl-magnet="0.4" data-sl-pull="p1" style="position:absolute;left:600px;top:420px;width:120px;height:40px;display:block;background:#333;color:#fff">Site magnet</a>
  <div id="cf" data-sl-cursor='{"k":0.2,"ox":0,"oy":0}' style="position:fixed;left:0;top:0;width:20px;height:20px;background:#000;pointer-events:none"></div>
  <div class="tall"></div>
  <div data-sl-id="11" id="b" style="height:60px">Below the fold</div>
  <p data-sl-id="12" id="w">Three words here</p>
  <div style="height:900px"></div>`), ex);
const noJs = html.replace(/<script data-sl-motion-runtime[\s\S]*?<\/script>/, "");
// widgets the site's scripts ran, as the capture marks them: tabs (the site's own "current" look), a scroll
// strip and a slider track with Previous / Next, a video whose wrapper shows its state through classes
const wHtml = M.buildExportHtml(page(`
  <style>body{margin:0;font:16px sans-serif} .tab.current{font-weight:700} .panel{position:absolute;top:40px;left:0;width:300px;height:100px} .panel.current{z-index:2}
  .strip{width:400px;overflow-x:auto;white-space:nowrap;scroll-behavior:auto} .strip li{display:inline-block;width:300px;height:80px;margin-right:20px;background:#ddd}
  .frame{width:400px;overflow:hidden;margin-top:20px} .track{display:flex;width:max-content} .track div{width:400px;height:60px;flex:none;background:#ccc}
  .ui .start{opacity:1} .ui.playing .start, .ui.ended .start{opacity:0}</style>
  <div style="position:relative;height:160px">
    <ul role="tablist" data-sl-tabs="">
      <li role="presentation" class="tabnav-item current"><a href="#p1" id="t1" role="tab" aria-controls="p1" aria-selected="true" class="tab current">One</a></li>
      <li role="presentation" class="tabnav-item"><a href="#p2" id="t2" role="tab" aria-controls="p2" aria-selected="false" class="tab" tabindex="-1">Two</a></li>
      <li role="presentation" class="tabnav-item"><a href="#p3" id="t3" role="tab" aria-controls="p3" aria-selected="false" class="tab" tabindex="-1">Three</a></li>
    </ul>
    <div id="p1" role="tabpanel" class="panel current" style="z-index: 2; opacity: 1;">P1</div>
    <div id="p2" role="tabpanel" class="panel" aria-hidden="true" style="z-index: 0; opacity: 1;">P2</div>
    <div id="p3" role="tabpanel" class="panel" aria-hidden="true" style="z-index: 0; opacity: 1;">P3</div>
  </div>
  <div class="gal"><ul class="strip" id="st" data-sl-scroller="scroll:1"><li>a</li><li>b</li><li>c</li><li>d</li></ul>
    <button id="sp" aria-label="Previous item" data-sl-paddle="-1:1" disabled>‹</button><button id="sn" aria-label="Next item" data-sl-paddle="1:1">›</button></div>
  <div class="frame" id="fr" data-sl-scroller="track:2"><div class="track" id="tr" style="transform: translate3d(0px, 0px, 0px)"><div>1</div><div>2</div><div>3</div></div></div>
  <button id="tp" class="slick-prev" data-sl-paddle="-1:2">prev</button><button id="tn" class="slick-next" data-sl-paddle="1:2">next</button>
  <div class="ui paused loaded" id="ui" data-sl-media-ui="1"><div class="start" id="sf">start frame</div><video id="vv" muted playsinline data-sl-media-v="1" src="data:video/mp4;base64,"></video></div>
  <button id="pb" aria-label="Play animation" data-sl-media="1">Play</button>
  <style>@keyframes swipe { from { opacity: 0.2; } to { opacity: 1; } } .sw { animation: swipe 600ms ease forwards; }</style>
  <div style="height:2400px"></div><div id="hd" class="sw" data-sl-hold="" style="height:60px">a headline whose gradient swipes in</div><div style="height:900px"></div>`), {});
const srv = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(req.url.startsWith("/nojs") ? noJs : req.url.startsWith("/widgets") ? wHtml : html); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "sl-chrome-"));
const port = 9450 + Math.floor(Math.random() * 40);
const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,800"]);
const done = () => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => rmSync(prof, { recursive: true, force: true }), 500); };
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); up = true; } catch { await sleep(150); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const go = async (u) => { await send("Page.navigate", { url: u }); for (let i = 0; i < 50; i++) { await sleep(100); if ((await ev("document.readyState")) === "complete") break; } };
  await send("Page.enable");
  await go(origin + "/");
  await sleep(120);
  const early = await ev(`({ below: getComputedStyle(b).opacity, split: w.querySelectorAll(".slm-w").length })`);
  ok(early.below === "0", `below the fold, a scroll-into-view entrance waits at its start (opacity ${early.below})`);
  ok(early.split === 3, `word-by-word text split into its words (${early.split})`);
  await sleep(700);
  const top = await ev(`({ a: getComputedStyle(a).opacity, c: getComputedStyle(c).transform, below: getComputedStyle(b).opacity, pulse: p.getAnimations().map((x) => x.playState).join() })`);
  ok(top.a === "1", `a page-load entrance ends fully shown (opacity ${top.a})`);
  ok(/matrix\(1, 0, 0, 1, -50, 0\)/.test(top.c), `a site's own transform is kept after the entrance (${top.c})`);
  ok(top.below === "0", "…the one below the fold is still waiting");
  ok(top.pulse === "running", "a loop keeps running");
  await ev(`(scrollTo(0, b.offsetTop - 300), true)`);
  await sleep(900);
  const after = await ev(`({ b: getComputedStyle(b).opacity, w: [...w.querySelectorAll(".slm-w")].map((s) => getComputedStyle(s).opacity).join() })`);
  ok(after.b === "1", `scrolled to: it plays and ends shown (opacity ${after.b})`);
  ok(after.w === "1,1,1", `the words came in and all show (${after.w})`);
  await ev(`(scrollTo(0, 0), true)`);
  const hb = await ev(`(() => { const r = h.getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10, t0: getComputedStyle(h).translate }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hb.x, y: hb.y });
  await sleep(250);
  const ht = await ev(`getComputedStyle(h).translate`);
  ok(hb.t0 === "30px" && /^30px -6px$/.test(ht), `hover lifts it from where it was moved to (${hb.t0} → ${ht})`);
  // pointer effects (the runtime sets the values from the real pointer; CSS moves things)
  const at = async (sel, dx, dy) => { const c = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0] + dx, y: c[1] + dy }); await sleep(400); };
  await at("#mg", 60, 0);
  const mgT = await ev(`getComputedStyle(mg).translate`);
  const mgX = parseFloat(mgT);
  ok(mgX > 25 && mgX < 32, `Studio "Magnetic": pulled toward the pointer from where it was moved to (${mgT}, ≈ 28.4px)`);
  await at("#tt", 50, 25);
  const ttT = await ev(`getComputedStyle(tt).transform`);
  ok(/^matrix3d\(/.test(ttT), `Studio "3D tilt": tilts toward the pointer (${ttT.slice(0, 60)}…)`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1100, y: 760 }); await sleep(300);
  const back = await ev(`({ m: getComputedStyle(mg).translate, t: getComputedStyle(tt).transform })`);
  const tn = /^matrix3d\(/.test(back.t) ? back.t.slice(9, -1).split(",").map(parseFloat) : [1, 0, 0];
  ok(back.m === "20px" && Math.abs(tn[2]) < 0.001 && Math.abs(tn[6] || 0) < 0.001, `…and both settle back when the pointer leaves (${back.m}; no tilt left: ${back.t.slice(0, 50)}…)`);
  await at("#sm", 50, 0);
  const smT = await ev(`getComputedStyle(sm).translate`);
  ok(Math.abs(parseFloat(smT) - 20) < 3, `a magnetic button from the original site follows the pointer with its recorded strength (${smT}, ≈ 20px)`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 300 }); await sleep(900);
  const cfC = await ev(`(() => { const r = cf.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  ok(Math.abs(cfC[0] - 500) <= 4 && Math.abs(cfC[1] - 300) <= 4, `a cursor follower from the original site catches up with the pointer (${cfC.join(",")} ≈ 500,300)`);
  // scripts off: nothing is left hidden
  await go(origin + "/nojs");
  await sleep(1200);
  const nj = await ev(`({ b: getComputedStyle(b).opacity, w: getComputedStyle(w).opacity, split: w.querySelectorAll(".slm-w").length })`);
  ok(nj.b === "1" && nj.w === "1" && nj.split === 0, `without the script everything simply plays on load and shows (${JSON.stringify(nj)})`);
  // widgets
  ok(/data-sl-motion-runtime/.test(wHtml), "a page with the site's widgets (tabs, gallery arrows, video buttons) carries the trigger script");
  await go(origin + "/widgets");
  await sleep(300);
  const h0 = await ev(`(() => { const a = hd.getAnimations()[0]; return a ? a.playState + " " + Math.round(a.currentTime) + " " + getComputedStyle(hd).opacity : "none"; })()`);
  ok(/^paused 0 0\.2/.test(h0 || ""), `the site's own one-shot animation below the first screen waits at its first frame (${h0})`);
  await ev(`(scrollTo(0, hd.offsetTop - 400), true)`);
  await sleep(1000);
  const h1 = await ev(`(() => { const a = hd.getAnimations()[0]; return (a ? a.playState : "none") + " " + getComputedStyle(hd).opacity; })()`);
  ok(/^finished 1$/.test(h1 || ""), `…and plays when it comes into view (${h1})`);
  await ev(`(scrollTo(0, 0), true)`);
  await sleep(200);
  await ev(`(t3.click(), true)`);
  await sleep(100);
  const tb = await ev(`({ t: [t1, t2, t3].map((x) => x.className + "/" + x.getAttribute("aria-selected") + "/" + x.getAttribute("tabindex")).join(" "), li: [...document.querySelectorAll(".tabnav-item")].map((x) => x.classList.contains("current")).join(), p: [p1, p2, p3].map((x) => x.className + "/" + x.getAttribute("aria-hidden") + "/" + x.style.zIndex).join(" "), hash: location.hash })`);
  ok(tb.t === "tab/false/-1 tab/false/-1 tab current/true/null" && tb.li === "false,false,true" && tb.p === "panel/true/0 panel/true/0 panel current/null/2" && !tb.hash, `a tab shows its panel in the site's own selected look — classes, ARIA, stacking — without jumping (${JSON.stringify(tb)})`);
  await ev(`(t3.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })), true)`);
  const kb = await ev(`[document.activeElement.id, t1.getAttribute("aria-selected")].join()`);
  ok(kb === "t1,true", `arrow keys move along the tabs, wrapping round (${kb})`);
  await ev(`(sn.click(), true)`);
  await sleep(1000);
  const s1 = await ev(`({ x: st.scrollLeft, prev: sp.disabled, next: sn.disabled })`);
  ok(s1.x === 320 && s1.prev === false && s1.next === false, `a gallery's Next scrolls its strip to the next item, and its Previous turns on (${JSON.stringify(s1)})`);
  await ev(`(sn.click(), sn.click(), sn.click(), true)`);
  await sleep(1200);
  const s2 = await ev(`({ x: st.scrollLeft, max: st.scrollWidth - st.clientWidth, next: sn.disabled })`);
  ok(s2.x === s2.max && s2.next === true, `…at the end Next turns off (${JSON.stringify(s2)})`);
  await ev(`(tn.click(), true)`);
  await sleep(800);
  const t1x = await ev(`[tr.style.transform, tp.getAttribute("aria-disabled"), tn.getAttribute("aria-disabled")].join(" | ")`);
  ok(/^translate3d\(-400(\.0)?px, 0px, 0px\) \| false \| false$/.test(t1x), `a slider track in a clipped frame moves by one slide (${t1x})`);
  await ev(`(tn.click(), true)`);
  await sleep(800);
  await ev(`(tn.click(), true)`);
  await sleep(800);
  const t2x = await ev(`[tr.style.transform, tn.getAttribute("aria-disabled")].join(" | ")`);
  ok(/^translate3d\(-800(\.0)?px, 0px, 0px\) \| true$/.test(t2x), `…and stops at its last slide (${t2x})`);
  await ev(`(vv.dispatchEvent(new Event("play")), true)`);
  const ui1 = await ev(`ui.className + " | " + getComputedStyle(sf).opacity`);
  await ev(`(vv.dispatchEvent(new Event("ended")), true)`);
  const ui2 = await ev(`ui.className`);
  ok(ui1 === "ui loaded playing | 0" && ui2 === "ui loaded ended", `a video's wrapper follows it — playing, ended — so the site's CSS shows the right frame (${ui1}; ${ui2})`);
  const pbOk = await ev(`(() => { let played = 0; vv.play = () => { played++; return Promise.resolve(); }; pb.click(); return played; })()`);
  ok(pbOk === 1, "its play button plays it");
  ws.close();
} catch (e) { failures.push("browser: " + e.message); console.log("  ✗ browser:", e.message); }
done();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
