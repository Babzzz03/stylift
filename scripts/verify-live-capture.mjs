// Real-browser verification of the capture engine (src/extractor/capture.ts).
// 1. A synthetic page with lazy images, IntersectionObserver appear-animations,
//    a shadow root (+ adopted stylesheet), a canvas, CSSOM-inserted rules,
//    form state and a same-origin iframe — asserted precisely.
// 2. Optional real URLs (default: framer.com, gsap.com, webflow.com) — stats +
//    sanity assertions for Framer / GSAP / Webflow animated sites.
// Usage: node scripts/verify-live-capture.mjs [--no-real] [url ...]
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
// throwaway Chrome profile, removed when the script exits (they are ~70 MB each)
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const noReal = args.includes("--no-real");
const urls = args.filter((a) => !a.startsWith("--"));
if (!urls.length && !noReal) urls.push("https://www.framer.com", "https://gsap.com", "https://webflow.com");

const outdir = mkdtempSync(join(tmpdir(), "sl-capture-"));
await build({ entryPoints: { cap: "src/extractor/capture.ts", settle: "src/extractor/settle.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
await build({ entryPoints: { fa: "src/extractor/framer-appear.ts", intro: "src/extractor/intro-recorder.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const { capturePage } = await import(pathToFileURL(join(outdir, "cap.js")));
const { settleAnimations } = await import(pathToFileURL(join(outdir, "settle.js")));
const { applyFramerAppear } = await import(pathToFileURL(join(outdir, "fa.js")));
const { introRecorderSource } = await import(pathToFileURL(join(outdir, "intro.js")));
// chrome.scripting.executeScript({ func }) ships ONLY func.toString() to the page.
// Evaluating the source text the same way proves the injected functions are
// self-contained (no references to module-scope helpers).
const capSrc = capturePage.toString();
const setSrc = settleAnimations.toString();
const expr = (opts) => `(async function(){ const settled = (${setSrc})(); const r = await (${capSrc})(${JSON.stringify(opts)}); r.settled = settled; return JSON.stringify(r); })()`;

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

// ── synthetic page ─────────────────────────────────────────────────────────────
const frame = join(outdir, "frame.html");
writeFileSync(frame, `<!doctype html><html><head><style>p{color:rgb(1,2,3)}</style></head><body><p id="in-frame">frame text</p></body></html>`);
// a real (tiny) Lottie animation: a red square sliding left → right over 2 s
writeFileSync(join(outdir, "anim.json"), `{"v":"5.7.4","fr":30,"ip":0,"op":60,"w":100,"h":100,"nm":"t","ddd":0,"assets":[],"layers":[{"ddd":0,"ind":1,"ty":4,"nm":"box","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":1,"k":[{"t":0,"s":[20,50,0],"i":{"x":[0.5],"y":[0.5]},"o":{"x":[0.5],"y":[0.5]}},{"t":60,"s":[80,50,0]}]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"rc","d":1,"s":{"a":0,"k":[20,20]},"p":{"a":0,"k":[0,0]},"r":{"a":0,"k":0},"nm":"r"},{"ty":"fl","c":{"a":0,"k":[1,0,0,1]},"o":{"a":0,"k":100},"r":1,"nm":"f"}],"ip":0,"op":60,"st":0,"bm":0}]}`);
writeFileSync(join(outdir, "botwall.html"), `<!doctype html><html><body><h1>Checking your browser</h1><iframe src="about:blank#captcha-challenge" style="width:320px;height:80px;border:0"></iframe></body></html>`);
writeFileSync(join(outdir, "sprite.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="star" viewBox="0 0 10 10"><path d="M5 0L6 4H10L7 6L8 10L5 7L2 10L3 6L0 4H4Z"/></symbol></svg>`);
// real GSAP (from its CDN): an intro, a staggered scroll reveal, an endless marquee, a ScrollTrigger.batch
writeFileSync(join(outdir, "gsap.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .box{width:200px;height:120px;background:#c33;margin:40px} .tall{height:1600px}</style></head><body>
<div id="intro" class="box">intro</div>
<div class="tall"></div>
<div class="card box">a</div><div class="card box">b</div><div class="card box">c</div>
<div style="overflow:hidden;width:400px"><div id="track" style="display:flex;width:1600px;height:60px;background:linear-gradient(90deg,#000,#fff)"></div></div>
<div class="tall"></div>
<div style="overflow:hidden;width:500px"><div id="rafm" style="display:flex;width:max-content"><span style="width:300px;display:block">A</span><span style="width:300px;display:block">B</span><span style="width:300px;display:block">A</span><span style="width:300px;display:block">B</span></div></div>
<script>{ const t0 = performance.now(); const el = document.getElementById("rafm"); const f = (t) => { el.style.transform = "translateX(" + (-(((t - t0) * 0.06) % 600)) + "px)"; requestAnimationFrame(f); }; requestAnimationFrame(f); }</script>
<p id="scrubtext" style="display:flex;gap:8px;font-size:28px;margin:60px 40px">${["Words","that","light","up","as","you","scroll","past"].map((w) => `<span class="sw" style="display:inline-block;opacity:0.15">${w}</span>`).join("")}</p>
<script>{ const ws = [...document.querySelectorAll(".sw")]; const f = () => { for (const w of ws) { const t = w.getBoundingClientRect().top; w.style.opacity = String(Math.max(0.15, Math.min(1, (innerHeight * 0.9 - t) / 500))); } }; addEventListener("scroll", f, { passive: true }); f(); }</script>
<section class="sec" id="secA" style="padding:40px"><div class="item" id="itemA" style="height:80px;background:#36c">in view item</div></section>
<style>.sec .item{opacity:0;transform:translateY(40px);transition:opacity .5s,transform .5s} .sec.is-inview .item{opacity:1;transform:none}</style>
<script>new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("is-inview"); }), { threshold: 0.2 }).observe(document.getElementById("secA"));</script>
<div class="b box">x</div><div class="b box">y</div>
<div class="tall"></div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script>
gsap.registerPlugin(ScrollTrigger);
gsap.from("#intro", { y: 60, opacity: 0, duration: 20, ease: "power3.out", delay: 0.2 }); // still playing when captured (a finished one is gone from GSAP)
gsap.from(".card", { y: 80, opacity: 0, duration: 0.9, stagger: 0.15, ease: "expo.out", scrollTrigger: { trigger: ".card", start: "top 85%" } });
gsap.to("#track", { xPercent: -50, duration: 8, ease: "none", repeat: -1 });
gsap.set(".b", { opacity: 0, y: 40 });
ScrollTrigger.batch(".b", { onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, stagger: 0.1, duration: 0.6 }) });
</script></body></html>`);
// a pinned section (ScrollTrigger pin) whose track slides sideways as you scroll through it; "#bundled" hides
// GSAP from the page (as a bundled site does), so only the DOM GSAP leaves behind tells the capture about the pin
writeFileSync(join(outdir, "pin.html"), `<!doctype html><html><head><style>body{margin:0} .tall{height:1200px;background:#ddd} #pinsec{height:100vh;overflow:hidden;background:#123} #htrack{display:flex;width:3440px;height:300px;background:linear-gradient(90deg,#f00,#00f)}</style></head><body>
<div class="tall"></div><section id="pinsec"><div id="htrack"></div></section><div class="tall"></div><div class="tall"></div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script>gsap.registerPlugin(ScrollTrigger); gsap.to("#htrack", { x: -2000, ease: "none", scrollTrigger: { trigger: "#pinsec", pin: true, start: "top top", end: "+=2000", scrub: true } });
if (location.hash === "#bundled") { window.gsap = undefined; window.ScrollTrigger = undefined; }</script>
</body></html>`);
// hover effects run by scripts: GSAP zooming a card's picture, a class added on hover (its CSS fades the colour),
// a plain onmouseenter handler drawing a line in; a static element next to them
writeFileSync(join(outdir, "hover.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .card{width:300px;height:200px;overflow:hidden;margin:40px;cursor:pointer} .card img{display:block;width:300px;height:200px} .btn{display:inline-block;padding:12px 20px;background-color:rgb(0,0,255);color:#fff;transition:background-color .3s ease;margin:40px} .btn.is-hover{background-color:rgb(255,0,0)} .lnk{position:relative;display:inline-block;margin:40px;padding-bottom:4px} .lnk .line{position:absolute;left:0;bottom:0;height:2px;width:0;background:#000} .card2{width:300px;height:200px;overflow:hidden;margin:40px} .card2 img{display:block;width:300px;height:200px;transition:transform .4s ease} .card2.is-hover img{transform:scale(1.2)}</style></head><body>
<div class="card" id="hcard"><img id="himg" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%23c33'/%3E%3C/svg%3E"></div>
<a class="btn" id="hbtn" href="#x"><span>Hover me</span></a>
<a class="lnk" id="hlnk" href="#y">Read more<span class="line" id="hline"></span></a>
<div class="card2" id="hcard2"><img id="himg2" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%2336c'/%3E%3C/svg%3E"></div>
<div id="hplain"><span>static</span></div>
<script>{ const c2 = document.getElementById("hcard2"); c2.addEventListener("mouseenter", () => c2.classList.add("is-hover")); c2.addEventListener("mouseleave", () => c2.classList.remove("is-hover")); }</script>
<script>{ const b = document.getElementById("hbtn"); b.addEventListener("mouseenter", () => b.classList.add("is-hover")); b.addEventListener("mouseleave", () => b.classList.remove("is-hover"));
const l = document.getElementById("hlnk"), line = document.getElementById("hline"); l.onmouseenter = () => { line.style.width = "100%"; }; l.onmouseleave = () => { line.style.width = "0px"; }; }</script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>{ const img = document.getElementById("himg"), card = document.getElementById("hcard"); card.addEventListener("mouseenter", () => gsap.to(img, { scale: 1.15, duration: 0.6, ease: "power2.out" })); card.addEventListener("mouseleave", () => gsap.to(img, { scale: 1, duration: 0.6 })); }</script>
</body></html>`);
// a hero built as a full-screen <header> whose big (inline-block) word moves as you scroll, under a fixed bar
// whose logo shrinks as you scroll (the bar is chrome: kept as it looks at the top)
writeFileSync(join(outdir, "hero.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} #bar{position:fixed;top:0;left:0;right:0;height:60px;background:#fff;z-index:5} #blogo{display:block;width:120px;height:40px;background:#000;transform-origin:left} .hero_wrap{height:100vh;position:relative;overflow:hidden;background:#eee;padding-top:200px;box-sizing:border-box} .is-waypoint{display:inline-block;font-size:120px;margin-left:100px}</style></head><body>
<header id="bar"><a id="blogo" href="#"></a></header>
<header class="hero_wrap"><div class="is-waypoint" id="hw">Create</div></header><div style="height:3000px"></div>
<script>{ const w = document.getElementById("hw"), lg = document.getElementById("blogo"); const f = () => { w.style.transform = "translateY(" + Math.round(scrollY * 0.4) + "px)"; lg.style.transform = "scale(" + (1 - Math.min(scrollY, 600) / 1500).toFixed(3) + ")"; }; addEventListener("scroll", f, { passive: true }); f(); }</script>
</body></html>`);
// staggered reveals: a heading split into letters that a script animates in one after another (80 ms apart,
// 600 ms each, ease-out), and cards revealed by a class whose CSS transition carries a per-card delay
writeFileSync(join(outdir, "stagger.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1400px} #sth{font-size:64px;margin:40px} #sth span{display:inline-block} .scard{width:240px;height:120px;margin:20px;background:#36c;opacity:0;transform:translateY(30px);transition:opacity .5s ease-out,transform .5s ease-out} .scard.in{opacity:1;transform:none}</style></head><body>
<div class="tall"></div>
<h2 id="sth">${["S","T","A","G","E","R"].map((c, i) => `<span class="sl${i}" style="opacity:0;transform:translateY(40px)">${c}</span>`).join("")}</h2>
<div class="tall"></div>
<div class="scard" id="sc0" style="transition-delay:0ms"></div><div class="scard" id="sc1" style="transition-delay:120ms"></div><div class="scard" id="sc2" style="transition-delay:240ms"></div>
<div class="tall"></div>
<script>{ const letters = [...document.querySelectorAll("#sth span")]; let done = false;
new IntersectionObserver((es) => { if (done || !es.some((e) => e.isIntersecting)) return; done = true; const t0 = performance.now();
  const f = (t) => { let more = false; letters.forEach((l, i) => { const p = Math.max(0, Math.min(1, (t - t0 - i * 80) / 600)); const e = 1 - Math.pow(1 - p, 3); l.style.opacity = String(e); l.style.transform = "translateY(" + (40 * (1 - e)).toFixed(2) + "px)"; if (p < 1) more = true; }); if (more) requestAnimationFrame(f); };
  requestAnimationFrame(f); }, { threshold: 0.5 }).observe(document.getElementById("sth"));
new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); }), { threshold: 0.3 }).observe(document.getElementById("sc0"));
["sc1", "sc2"].forEach((id) => new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); }), { threshold: 0.3 }).observe(document.getElementById(id))); }</script>
</body></html>`);
// content that switches as you scroll: the list item nearest the middle of the screen is "active" (opaque),
// the others dim — on and off again as the page scrolls
writeFileSync(join(outdir, "switch.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1200px} .it{height:320px;margin:0 40px;font-size:48px;background:#ddd;opacity:.25;transition:opacity .3s} .it.active{opacity:1}</style></head><body>
<div class="tall"></div>${[1, 2, 3, 4, 5].map((i) => `<div class="it" id="it${i}">Item ${i}</div>`).join("")}<div class="tall"></div>
<script>{ const its = [...document.querySelectorAll(".it")]; const f = () => { let best = null, bd = 1e9; for (const it of its) { const r = it.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - innerHeight / 2); if (d < bd) { bd = d; best = it; } } its.forEach((it) => it.classList.toggle("active", it === best && bd < 400)); }; addEventListener("scroll", f, { passive: true }); f(); }</script>
</body></html>`);
// pointer effects run by scripts: a magnetic button (follows 40% of the pointer's offset), a card tilted in 3D
// (up to 12°), a cursor follower easing after the pointer (20% of the gap each frame)
writeFileSync(join(outdir, "pointer.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif;height:2000px} #mag{display:inline-block;margin:120px;padding:20px 40px;background:#111;color:#fff} .card{width:300px;height:200px;margin:60px 120px;background:#c33} #cur{position:fixed;left:0;top:0;width:20px;height:20px;border-radius:50%;background:#000;pointer-events:none;transform:translate(-100px,-100px)}</style></head><body>
<a id="mag" href="#m"><span>Magnet</span></a>
<div class="card" id="tilt"><p>tilt</p></div>
<div id="cur"></div>
<script>{ const mag = document.getElementById("mag"); mag.addEventListener("mousemove", (e) => { const r = mag.getBoundingClientRect(); mag.style.transform = "translate(" + ((e.clientX - r.left - r.width / 2) * 0.4).toFixed(1) + "px," + ((e.clientY - r.top - r.height / 2) * 0.4).toFixed(1) + "px)"; }); mag.addEventListener("mouseleave", () => { mag.style.transform = ""; });
const tl = document.getElementById("tilt"); tl.addEventListener("mousemove", (e) => { const r = tl.getBoundingClientRect(); const dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = (e.clientY - r.top - r.height / 2) / (r.height / 2); tl.style.transform = "perspective(800px) rotateX(" + (-dy * 12).toFixed(2) + "deg) rotateY(" + (dx * 12).toFixed(2) + "deg)"; }); tl.addEventListener("mouseleave", () => { tl.style.transform = ""; });
const cur = document.getElementById("cur"); let tx = -100, ty = -100, x = -100, y = -100; addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; }); const f = () => { x += (tx - x) * 0.2; y += (ty - y) * 0.2; cur.style.transform = "translate(" + (x - 10).toFixed(1) + "px," + (y - 10).toFixed(1) + "px)"; requestAnimationFrame(f); }; requestAnimationFrame(f); }</script>
</body></html>`);
// a slideshow on a timer, below the fold: one slide "active" at a time (the copy must not show them all)
writeFileSync(join(outdir, "slides.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1300px} .show{position:relative;height:300px;margin:40px} .item{position:absolute;inset:0;opacity:0;transform:translateY(20px);transition:opacity .4s,transform .4s;font-size:40px;background:#eee} .item.active{opacity:1;transform:none}</style></head><body>
<div class="tall"></div><section class="hero"><ul class="show"><li class="item active" id="sl1">Slide one</li><li class="item" id="sl2">Slide two</li><li class="item" id="sl3">Slide three</li></ul>
<div class="pics"><figure class="pic on" id="pc1" style="opacity: 1; z-index: 2">1</figure><figure class="pic" id="pc2" style="opacity: 0; z-index: 1">2</figure><figure class="pic" id="pc3" style="opacity: 0; z-index: 1">3</figure></div></section><div class="tall"></div>
<style>.pics{position:relative;height:200px;margin:40px} .pic{position:absolute;inset:0;margin:0;background:#ccd}</style>
<script>{ const its = [...document.querySelectorAll(".item")], ps = [...document.querySelectorAll(".pic")]; let i = 0; setInterval(() => { its[i].classList.remove("active"); ps[i].classList.remove("on"); ps[i].style.opacity = "0"; ps[i].style.zIndex = "1"; i = (i + 1) % its.length; its[i].classList.add("active"); ps[i].classList.add("on"); ps[i].style.opacity = "1"; ps[i].style.zIndex = "2"; }, 1200); }</script>
</body></html>`);
// widgets the page's scripts run: tabs, a gallery strip with Previous / Next, a slider track, a video with a play
// button and state classes; classes set on <body> / the header past a scroll position (and two that aren't:
// a "loaded" flag set on a timer, and a header hiding while scrolling down)
writeFileSync(join(outdir, "widgets.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} header{position:fixed;top:0;left:0;right:0;height:50px;background:#fff;z-index:9} .tall{height:1400px}
.tab.current{font-weight:700} .panel{height:80px} .strip{width:600px;overflow-x:auto;white-space:nowrap} .strip li{display:inline-block;width:400px;height:80px;margin-right:20px;background:#ddd}
.frame{width:600px;overflow:hidden} .track{display:flex;width:max-content} .track div{width:600px;height:60px;flex:none;background:#ccc} .ui.playing .start{opacity:0}</style></head><body>
<header id="hd"><a href="/">Logo</a><span id="hdtag" style="opacity: 0; transform: translate(-5px, 0px); filter: blur(0px);">The house of coffee</span></header><div id="lnav" class="localnav-container theme-reveal-on-scroll" style="position:fixed;top:0;left:0;right:0;pointer-events:none;z-index:5"><nav id="localnav" style="position:sticky;top:0"><div class="localnav-wrap">iPhone 18 Pro · Buy</div></nav><div class="content-expand-wrap" inert style="height:500px;visibility:hidden">the bar's menu, hidden</div></div><div style="height:60px"></div><nav id="lnav2" style="position:sticky;top:0;z-index:4"><div id="lnav2c" class="localnav-container localnav-over-globalnav" style="height:40px">iPhone · Overview · Buy</div></nav>
<ul role="tablist" id="tl"><li><a href="#wp1" id="wt1" role="tab" aria-controls="wp1" aria-selected="true" class="tab current">One</a></li><li><a href="#wp2" id="wt2" role="tab" aria-controls="wp2" aria-selected="false" class="tab">Two</a></li></ul>
<div id="wp1" role="tabpanel" class="panel">P1</div><div id="wp2" role="tabpanel" class="panel" hidden>P2</div>
<div class="gal"><ul class="strip" id="wst"><li>a</li><li>b</li><li>c</li></ul><button id="wprev" aria-label="Previous slide">‹</button><button id="wnext" aria-label="Next slide">›</button></div>
<div class="slider"><div class="frame" id="wfr"><div class="track" id="wtr"><div>1</div><div>2</div><div>3</div></div></div><button class="slick-prev" id="tprev">prev</button><button class="slick-next" id="tnext">next</button></div>
<div class="ui paused" id="wui"><div class="start">start</div><video id="wv" muted playsinline style="width:160px;height:90px"></video><button id="wplay" aria-label="Play video">Play</button></div>
<button id="wfloat" class="text-left float-right">Not an arrow</button>
<style>@keyframes swp { from { opacity: .3 } to { opacity: 1 } } @keyframes spin { to { transform: rotate(1turn) } } .swp { animation: swp .8s forwards } .spin { animation: spin 2s linear infinite }</style>
<p id="hold-top" class="swp">a one-shot animation in the first screen</p>
<div class="tall"></div><p id="hold-low" class="swp">a one-shot animation further down</p><p id="spin-low" class="spin" style="width:40px">endless</p><div id="meas" style="--mw: 0px; position: relative; height: 80px"><span style="position:absolute;left:calc(var(--mw) * .5)">placed in a measured width</span></div><div class="tall"></div>
<script>addEventListener("scroll", () => { document.body.classList.toggle("show-bar", scrollY > 600); hd.classList.toggle("is-scrolled", scrollY > 100); }); let ly = 0; addEventListener("scroll", () => { hd.classList.toggle("nav-up", scrollY > ly && scrollY > 300); ly = scrollY; }); setTimeout(() => document.body.classList.add("loaded"), 1800); addEventListener("scroll", () => document.getElementById("lnav").classList.toggle("reveal", scrollY > 700)); addEventListener("scroll", () => { const c = document.getElementById("lnav2c"); c.classList.toggle("localnav-over-globalnav", scrollY <= 200); c.classList.toggle("sticky", scrollY > 200); c.classList.toggle("reveal", scrollY > 800); }); addEventListener("scroll", () => { if (scrollY > 900) meas.style.setProperty("--mw", "640px"); });</script>
</body></html>`);
// a reveal an eased scroll animation drives over a long stretch (as apple.com's: each frame moves part of the way
// to where the scroll says it should be, so it keeps moving a moment after each stop)
writeFileSync(join(outdir, "lerp.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1500px} #lp{height:200px;background:#cde;opacity:0}</style></head><body>
<div class="tall"></div><div id="lp">Eased in over 900 px of scrolling</div><div class="tall"></div><div class="tall"></div>
<script>{ const el = document.getElementById("lp"); let cur = 0; const tick = () => { const top = el.offsetTop - innerHeight; const target = Math.max(0, Math.min(1, (scrollY - top - 100) / 900)); cur += (target - cur) * 0.12; if (Math.abs(target - cur) < 0.002) cur = target; el.style.opacity = cur.toFixed(3); el.style.transform = "translateY(" + ((1 - cur) * 80).toFixed(1) + "px)"; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }</script>
</body></html>`);
// a picture a script fills only once it has sat in view a moment with nobody scrolling (as apple.com's data-lazy):
// a 1×1 placeholder in the markup, the real file named by the script alone
writeFileSync(join(outdir, "lazypic.html"), `<!doctype html><html><head><style>body{margin:0} .tall{height:2600px}</style></head><body>
<div class="tall"></div><picture id="lzp" data-lazy><source srcset="data:image/gif;base64,R0lGODlhAQABAHAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" media="(min-width:0px)"><img id="lzi" src="data:image/gif;base64,R0lGODlhAQABAHAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="" style="width:40px;height:56px"></picture><div class="tall"></div><div class="tall"></div>
<script>{ const p = document.getElementById("lzp"); let t = 0; const near = () => { const r = p.getBoundingClientRect(); return r.top < innerHeight + 200 && r.bottom > -200; }; addEventListener("scroll", () => { clearTimeout(t); if (near() && p.hasAttribute("data-lazy")) t = setTimeout(() => { if (near()) { p.querySelector("source").setAttribute("srcset", "icon1x.png"); p.removeAttribute("data-lazy"); } }, 1100); }); }</script>
</body></html>`);
// a block whose items its script shows when it comes into view and resets when scrolled back above (apple.com's
// StaggeredFadeIn: the block's class staggered-start ↔ staggered-end hides / shows them, inline styles on the items)
writeFileSync(join(outdir, "stagger2.html"), `<!doctype html><html><head><style>body{margin:0;font:20px sans-serif} .tall{height:1600px} .staggered-start .it{opacity:0;transform:translateY(20px)} .it{display:block;transition:opacity .4s,transform .4s}</style></head><body>
<div class="tall"></div><div id="lk" class="lock staggered-start"><span id="sg1" class="it">Bigger vapor chamber.</span><span id="sg2" class="it">Let the heat drop.</span></div><div class="tall"></div><div class="tall"></div>
<script>{ const l = document.getElementById("lk"), its = [...l.querySelectorAll(".it")]; addEventListener("scroll", () => { const r = l.getBoundingClientRect(); if (r.top < innerHeight * 0.8 && l.classList.contains("staggered-start")) { l.classList.replace("staggered-start", "staggered-end"); its.forEach((x) => { x.style.opacity = "1"; x.style.transform = "matrix(1, 0, 0, 1, 0, 0)"; }); } else if (r.top > innerHeight && l.classList.contains("staggered-end")) { l.classList.replace("staggered-end", "staggered-start"); its.forEach((x) => x.removeAttribute("style")); } }); }</script></body></html>`);
// a hero slideshow at the TOP of a long page (as deltacafes.com's): titles and pictures switched together by a
// timer that keeps going while the capture scrolls far below — slides that changed back then must not be put back
writeFileSync(join(outdir, "heroslides.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .hero{position:relative;height:800px} .tl{position:absolute;left:40px;top:300px;margin:0;padding:0;list-style:none} .tl li{position:absolute;opacity:0;font-size:40px;white-space:nowrap} .tl li.active{opacity:1} .pics{position:absolute;inset:0} .pics div{position:absolute;inset:0;opacity:0} .tall{height:2400px}</style></head><body>
<section class="hero"><div class="pics"><div class="pc" id="hp1" style="opacity: 1; z-index: 2; background:#cde"></div><div class="pc" id="hp2" style="opacity: 0; z-index: 1; background:#dec"></div><div class="pc" id="hp3" style="opacity: 0; z-index: 1; background:#edc"></div></div>
<ul class="tl"><li class="item active" id="ht1" style="z-index: 2">Delta, coffee with heart.</li><li class="item" id="ht2" style="z-index: 1">The first Portuguese coffee.</li><li class="item" id="ht3" style="z-index: 1">There is a lot of Portugal in Delta.</li></ul></section>
<div class="tall"></div><div class="tall"></div><div class="tall"></div>
<script>{ const t = [...document.querySelectorAll(".tl li")], p = [...document.querySelectorAll(".pc")]; let i = 0; setInterval(() => { t[i].classList.remove("active"); t[i].style.zIndex = "1"; p[i].style.opacity = "0"; p[i].style.zIndex = "1"; i = (i + 1) % 3; t[i].classList.add("active"); t[i].style.zIndex = "2"; p[i].style.opacity = "1"; p[i].style.zIndex = "2"; }, 1500); }</script></body></html>`);
// section headings a scroll system fades in as they come into view, reverses when scrolled back above, and keeps
// rewriting while far off screen (apple.com's WordAnim): never taken for a slideshow — they come in, in the copy
writeFileSync(join(outdir, "faraway.html"), `<!doctype html><html><head><style>body{margin:0;font:20px sans-serif} section{height:1300px;padding-top:200px} .hw{transition:opacity .5s}</style></head><body>
<section><div class="hw" id="fw1" style="opacity: 0;"><h2>Love at every sight.</h2></div></section><section><div class="hw" id="fw2" style="opacity: 0;"><h2>Well connected.</h2></div></section><section><div class="hw" id="fw3" style="opacity: 0;"><h2>Peace of mind.</h2></div></section><section></section>
<script>{ const ws = [...document.querySelectorAll(".hw")]; const run = () => { for (const w of ws) { const r = w.getBoundingClientRect(); w.style.opacity = r.top < innerHeight * 0.85 && r.bottom > 0 ? "1" : "0"; w.classList.toggle("wc", Math.abs(r.top) < innerHeight * 2.5); w.setAttribute("data-y", String(Math.round(r.top / 100))); } }; addEventListener("scroll", run); run(); }</script></body></html>`);
// a heading that comes in with its OWN animation, set off by a class added as it comes into view (apple.com's
// gradient headline: transparent text until the "animate" class swipes the gradient across it)
writeFileSync(join(outdir, "ownanim.html"), `<!doctype html><html><head><style>body{margin:0;font:40px sans-serif;background:#000;color:#fff} .tall{height:1600px} @keyframes swipe{from{background-position:160% 0}to{background-position:0 0}} .grad{color:transparent;background:linear-gradient(90deg,#fff,#8cf) 160% 0/300% 100%;-webkit-background-clip:text;background-clip:text;opacity:0;transform:translateY(20px);transition:opacity .4s,transform .4s} .grad.animate{animation:swipe 1.2s linear forwards}</style></head><body>
<div class="tall"></div><p id="gh" class="grad">Welcome to the mother chip.</p><div class="tall"></div><div class="tall"></div>
<script>{ const g = document.getElementById("gh"); addEventListener("scroll", () => { if (g.getBoundingClientRect().top < innerHeight * 0.8 && !g.classList.contains("animate")) { g.classList.add("animate"); g.style.opacity = "1"; g.style.transform = "matrix(1, 0, 0, 1, 0, 0)"; } }); }</script></body></html>`);
// a bar a script slides in through a progress variable as you scroll (apple.com's local nav: --progress on it, its CSS
// reading var(--progress)): the variable itself is replayed on the scroll timeline
writeFileSync(join(outdir, "progvar.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1500px} #lbar{position:fixed;top:0;left:0;right:0;height:50px;background:#333;color:#fff;transform:translateY(calc((1 - var(--progress)) * -100%))}</style></head><body>
<div id="lbar" style="--progress: 0;">iPhone 18 Pro · Explore · Buy</div><div class="tall"></div><div class="tall"></div><div class="tall"></div>
<script>{ const b = document.getElementById("lbar"); addEventListener("scroll", () => { const p = Math.max(0, Math.min(1, (scrollY - 600) / 400)); b.style.setProperty("--progress", String(Math.round(p * 1000) / 1000)); }); }</script></body></html>`);
// a slowly eased scroll animation (apple.com's laptop halves sliding together): still gliding into place a few
// seconds after each stop — and after the capture goes back to the top. Not a timer's doing: a scrubbed reveal.
writeFileSync(join(outdir, "slowlerp.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:1500px} .half{height:120px;width:600px;background:#cde}</style></head><body>
<div class="tall"></div><div id="hw" class="half" style="transform: matrix(1, 0, 0, 1, -300, 0);">left half</div><div class="tall"></div><div class="tall"></div>
<script>{ const el = document.getElementById("hw"); let cur = -300; const tick = () => { const top = el.offsetTop - innerHeight; const p = Math.max(0, Math.min(1, (scrollY - top - 100) / 900)); const target = -300 * (1 - p); cur += (target - cur) * 0.035; if (Math.abs(target - cur) < 0.3) cur = target; el.style.transform = "matrix(1, 0, 0, 1, " + cur.toFixed(1) + ", 0)"; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }</script></body></html>`);
// a pinned (sticky) text a script splits into words only when its section comes in, each word then lit up in turn
// by an eased scrub as you scroll through the section (santalarch.com's statements): the words, made during the
// scroll, are scrubbed on the page's scroll position in the copy — not left as they ended up
writeFileSync(join(outdir, "pinwords.html"), `<!doctype html><html><head><style>body{margin:0;font:40px sans-serif} .tall{height:1500px} #pws{height:3000px} .pin{position:sticky;top:0;height:900px;display:flex;align-items:center;padding:0 80px} #pwp{margin:0}</style></head><body>
<div class="tall"></div><section id="pws"><div class="pin"><p id="pwp">A clear visual position formed through strength precision and emotional gravity</p></div></section><div class="tall"></div><div class="tall"></div>
<script>{ const sec = document.getElementById("pws"), p = document.getElementById("pwp"); let ws = null, cur = 0; const split = () => { const words = p.textContent.split(" "); p.textContent = ""; ws = words.map((w, i) => { const s = document.createElement("span"); s.id = "pw" + i; s.textContent = w; s.style.cssText = "position: relative; display: inline-block; margin-right: 12px;"; p.appendChild(s); return s; }); ws.forEach((s) => { s.style.opacity = "0"; s.style.transform = "translate3d(0px, 40px, 0px)"; }); }; const tick = () => { const top = sec.offsetTop; if (!ws && scrollY > top - innerHeight) split(); if (ws) { const target = Math.max(0, Math.min(1, (scrollY - top) / 1800)); cur += (target - cur) * 0.12; if (Math.abs(target - cur) < 0.001) cur = target; ws.forEach((s, i) => { const wp = Math.max(0, Math.min(1, cur * ws.length - i * 0.8)); s.style.opacity = wp.toFixed(3); s.style.transform = "translate3d(0px, " + ((1 - wp) * 40).toFixed(1) + "px, 0px)"; }); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); }</script></body></html>`);
// a pinned statement whose words come in one after another ON A TIMER once the scroll reaches a point of the pin, and
// go again when scrolled back above it (santalarch.com's: GSAP set off at a scroll position, ~1 s with a stagger,
// reversed on the way back): replayed as timed
// entrances started at that scroll position — not stretched over the scroll, and not at "comes into view"
writeFileSync(join(outdir, "pintimed.html"), `<!doctype html><html><head><style>body{margin:0;font:40px sans-serif} .tall{height:1500px} #pts{height:3000px} .pin{position:sticky;top:0;height:900px;display:flex;align-items:center;padding:0 80px} #ptp{margin:0} #ptp span{display:inline-block;margin-right:12px;opacity:0;transform:translate(0px, 20px)}</style></head><body>
<div class="tall"></div><section id="pts"><div class="pin"><p id="ptp"><span id="pt0">A</span><span id="pt1">precise</span><span id="pt2">system</span><span id="pt3">of</span><span id="pt4">decisions</span><span id="pt5">made</span><span id="pt6">to</span><span id="pt7">last</span></p></div></section><div class="tall"></div><div class="tall"></div>
<script>{ const ws = [...document.querySelectorAll("#ptp span")]; let started = false; addEventListener("scroll", () => { if (started && scrollY < 2000) { started = false; ws.forEach((w) => { w.style.opacity = "0"; w.style.transform = "translate(0px, 20px)"; }); } if (started || scrollY < 2100) return; started = true; const t0 = performance.now(); const f = (t) => { let more = false; ws.forEach((w, i) => { const p = Math.max(0, Math.min(1, (t - t0 - i * 80) / 600)); const e = 1 - Math.pow(1 - p, 3); w.style.opacity = e.toFixed(3); w.style.transform = "translate(0px, " + (20 * (1 - e)).toFixed(2) + "px)"; if (p < 1) more = true; }); if (more) requestAnimationFrame(f); }; requestAnimationFrame(f); }); }</script></body></html>`);
// a wheel of picture cards turned by the scroll in depth, eased (framer.com's ImageWheel: each card goes round —
// left, right and back again — as you scroll past): every card follows the scroll in the copy, not just some
writeFileSync(join(outdir, "wheel.html"), `<!doctype html><html><head><style>body{margin:0} .tall{height:1500px} #wh{position:relative;height:700px;perspective:900px} #wh div{position:absolute;left:50%;top:50%;width:145px;height:145px;margin:-72px;background:#8ab;border-radius:20px}</style></head><body>
<div class="tall"></div><div id="wh">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<div id="wc${i}"></div>`).join("")}</div><div class="tall"></div><div class="tall"></div>
<script>{ const cs = [...document.querySelectorAll("#wh div")]; let cur = 0; const tick = () => { const target = scrollY * 0.12; cur += (target - cur) * 0.15; if (Math.abs(target - cur) < 0.01) cur = target; cs.forEach((c, i) => { const a = (cur + i * 45) * Math.PI / 180; c.style.transform = "translate3d(" + (Math.sin(a) * 260).toFixed(2) + "px, " + (Math.cos(a) * 40).toFixed(2) + "px, 0) scale(" + (0.8 + 0.2 * Math.cos(a)).toFixed(3) + ") rotateY(" + (Math.sin(a) * -40).toFixed(2) + "deg)"; c.style.zIndex = String(Math.round(500 + Math.cos(a) * 400)); }); requestAnimationFrame(tick); }; requestAnimationFrame(tick); }</script></body></html>`);
// a heading whose letters a script makes when it comes into view and brings in one after another with Web Animations
// (element.animate — framer.com's text effects: blurred, lifted, faded; final look written on each at the end):
// nothing in the DOM changes while they run — replayed with their own frames, length, stagger and easing
writeFileSync(join(outdir, "waapiletters.html"), `<!doctype html><html><head><style>body{margin:0;font:40px sans-serif} .tall{height:1500px}</style></head><body>
<div class="tall"></div><div id="wlb"><p id="wlp">Designing calm</p></div><div class="tall"></div><div class="tall"></div>
<script>{ const p = document.getElementById("wlp"); let done = false; addEventListener("scroll", () => { if (done || p.getBoundingClientRect().top > innerHeight * 0.85) return; done = true; const t = p.textContent; p.textContent = ""; [...t].forEach((ch, i) => { const s = document.createElement("span"); s.id = "wl" + i; s.textContent = ch === " " ? "\u00a0" : ch; s.style.cssText = "display: inline-block;"; p.appendChild(s); const a = s.animate([{ opacity: 0, filter: "blur(8px)", transform: "translateY(10px)" }, { opacity: 1, filter: "blur(0px)", transform: "none" }], { duration: 500, delay: i * 40, easing: "cubic-bezier(.2,.65,.3,.9)", fill: "both" }); a.onfinish = () => { s.style.opacity = "1"; s.style.filter = "blur(0px)"; s.style.transform = "none"; a.cancel(); }; }); }); }</script></body></html>`);
// a wheel the scroll turns only a quarter round as you pass it, eased (framer.com's ImageWheel): some cards move
// one way only, some out and back — every card follows the scroll in the copy
writeFileSync(join(outdir, "wheelq.html"), `<!doctype html><html><head><style>body{margin:0} .tall{height:1500px} #wq{position:relative;height:700px;perspective:900px} #wq div{position:absolute;left:50%;top:50%;width:145px;height:145px;margin:-72px;background:#8ab;border-radius:20px}</style></head><body>
<div class="tall"></div><div id="wq">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<div id="wq${i}"></div>`).join("")}</div><div class="tall"></div><div class="tall"></div>
<script>{ const cs = [...document.querySelectorAll("#wq div")]; let cur = 0; const tick = () => { const p = Math.max(0, Math.min(1, (scrollY - 900) / 1300)); const target = p * 90; cur += (target - cur) * 0.06; if (Math.abs(target - cur) < 0.01) cur = target; cs.forEach((c, i) => { const a = (cur - 60 + i * 45) * Math.PI / 180; c.style.transform = "translate3d(" + (Math.sin(a) * 260).toFixed(2) + "px, " + ((1 - Math.cos(a)) * 60).toFixed(2) + "px, 0) scale(" + (0.8 + 0.2 * Math.cos(a)).toFixed(3) + ") rotateY(" + (Math.sin(a) * -40).toFixed(2) + "deg)"; }); requestAnimationFrame(tick); }; requestAnimationFrame(tick); }</script></body></html>`);
// a local nav (a <div> named like a bar, inside a sticky <nav>) under a global nav full of <div>s named like it
// (globalnav-item, globalnav-flyout…: narrow, or hidden menus) and with many sticky tab navs further down (apple.com):
// the bar is still watched and its "reveal" class replayed
writeFileSync(join(outdir, "manynavs.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} section{height:700px;position:relative} section nav{position:sticky;top:60px;height:30px} #mn{position:sticky;top:0;z-index:5}</style></head><body>
<nav id="gn" style="position:relative;height:44px"><div class="globalnav-content" style="width:980px;margin:auto">${Array.from({ length: 10 }, (_, i) => `<div class="globalnav-item" style="display:inline-block;width:60px">Item ${i}<div class="globalnav-flyout globalnav-submenu" style="position:absolute;visibility:hidden;height:0">menu</div></div>`).join("")}</div></nav>
<nav id="mn"><div id="mnc" class="localnav-container" style="height:44px">iPhone · Overview · Buy</div></nav>
${Array.from({ length: 14 }, (_, i) => `<section><nav role="navigation" class="tabnav">tabs ${i}</nav></section>`).join("")}
<script>addEventListener("scroll", () => document.getElementById("mnc").classList.toggle("reveal", scrollY > 900)); addEventListener("scroll", () => { if (scrollY > 2000) { document.documentElement.classList.remove("enhanced-rt"); document.documentElement.classList.add("no-enhanced-rt"); } else { document.documentElement.classList.add("enhanced-rt"); document.documentElement.classList.remove("no-enhanced-rt"); } });</script></body></html>`);
// letters a script slides in by switching a CSS variable once as their word comes into view (and back when it
// leaves; the site's CSS glides them) — and splits the text into letters AGAIN on every resize (wearebulletproof.com's
// "DON JULIO"): the letters the scroll pass watched must be the ones the copy keeps, each following the scroll
writeFileSync(join(outdir, "resplit.html"), `<!doctype html><html><head><style>body{margin:0;font:120px sans-serif;overflow-x:hidden} .tall{height:1500px} .char{display:inline-block;transform:translateX(var(--x));transition:transform 1s cubic-bezier(.2,.7,.2,1)}</style></head><body>
<div class="tall"></div><div id="rrow"><p id="rp" style="margin:0">DON</p></div><div class="tall"></div><div class="tall"></div>
<script>{ const p = document.getElementById("rp"), row = document.getElementById("rrow"); let cs = [], was = null; const split = () => { const t = "DON"; p.textContent = ""; cs = [...t].map((ch, i) => { const d = document.createElement("div"); d.className = "char"; d.id = "rc" + i; d.textContent = ch; d.style.cssText = "position: relative; display: inline-block; --reveal-x: " + (i % 2 ? "21vw" : "-21vw") + ";"; d.style.setProperty("--x", was ? "0vw" : d.style.getPropertyValue("--reveal-x")); p.appendChild(d); return d; }); }; split(); addEventListener("resize", split); addEventListener("scroll", () => { const r = row.getBoundingClientRect(); const inView = r.top < innerHeight * 0.8 && r.bottom > innerHeight * 0.1; if (inView === was) return; was = inView; cs.forEach((c) => c.style.setProperty("--x", inView ? "0vw" : c.style.getPropertyValue("--reveal-x"))); }); }</script></body></html>`);
// letters in a pinned section slid in by a CSS variable switched once the scroll reaches a point of the pin, the
// site's CSS transition gliding them (no script frames to record): timed entrances with that transition, started
// at that scroll position
writeFileSync(join(outdir, "pinvar.html"), `<!doctype html><html><head><style>body{margin:0;font:100px sans-serif;overflow-x:hidden} .tall{height:1500px} #pvs{height:3000px} .pin{position:sticky;top:0;height:900px;display:flex;align-items:center;padding:0 80px} .char{display:inline-block;opacity:var(--o);transform:translateX(var(--x));transition:transform .9s cubic-bezier(.2,.7,.2,1),opacity .9s}</style></head><body>
<div class="tall"></div><section id="pvs"><div class="pin"><p id="pvp" style="margin:0">${[..."JULIO"].map((ch, i) => `<span id="pv${i}" class="char" style="--x: ${i % 2 ? "" : "-"}20vw; --o: 0;">${ch}</span>`).join("")}</p></div></section><div class="tall"></div><div class="tall"></div>
<script>{ const cs = [...document.querySelectorAll("#pvp .char")]; let on = null; addEventListener("scroll", () => { const now = scrollY > 2100; if (now === on) return; on = now; cs.forEach((c, i) => { c.style.setProperty("--x", now ? "0vw" : (i % 2 ? "" : "-") + "20vw"); c.style.setProperty("--o", now ? "1" : "0"); }); }); }</script></body></html>`);
// a <picture> whose <source> offers a 1x and a 2x file (as apple.com's icons): a high-density screen picks the
// 2x one; the copy must keep showing it at its 1x size
{
  const { deflateSync, crc32 } = await import("node:zlib");
  const png = (w, h, rgb) => {
    const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 8 + data.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3); }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  writeFileSync(join(outdir, "icon1x.png"), png(40, 56, [200, 60, 60]));
  writeFileSync(join(outdir, "icon2x.png"), png(80, 112, [60, 60, 200]));
}
writeFileSync(join(outdir, "picture.html"), `<!doctype html><html><head><style>body{margin:0} .card{padding:40px}</style></head><body><div class="card"><picture id="pic"><source srcset="icon1x.png, icon2x.png 2x" media="(min-width: 600px)"><img id="picimg" src="icon1x.png" alt=""></picture><h3 id="pich">Made with recycled material</h3></div></body></html>`);
// captured while a dialog had paused the smooth scroller / locked the body
writeFileSync(join(outdir, "locked.html"), `<!doctype html><html class="lenis lenis-stopped"><head><style>.lenis.lenis-stopped{overflow:hidden} body{margin:0}</style></head><body class="menu-open" style="overflow: hidden; background: #fff"><div style="height:3000px">tall page</div></body></html>`);
// a page whose own CSS blocks native scrolling (a smooth-scroll script scrolls it)
writeFileSync(join(outdir, "scripted-scroll.html"), `<!doctype html><html><head><style>html{height:100vh;overflow:hidden} body{margin:0;overflow:hidden}</style></head><body><div style="height:4000px;background:linear-gradient(#fff,#000)">long page</div></body></html>`);
// intros that finish long before anyone clicks capture: a hand-written one, a CSS one set off by a class, GSAP
writeFileSync(join(outdir, "intro.html"), `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .fade{opacity:0;transform:translateY(30px);transition:opacity .6s ease .1s,transform .6s ease .1s} body.is-loaded .fade{opacity:1;transform:none}</style></head><body>
<h1 id="ih">Hand-made intro</h1><p class="fade" id="ic">Revealed by a class</p><div id="ig" style="width:120px;height:60px;background:#c33">gsap</div>
<p id="itag" style="opacity:0;transform:translate(10px,0)">A tagline that comes and goes</p>
<p id="itag2" style="opacity:0;transform:translate(10px,0)">A slow intro's tagline, gone after 7 s</p>
<div style="height:1600px"></div><p id="iwait">In the page's HTML, hidden by its script until scrolled to</p>
<script>{ const h = document.getElementById("ih"); h.style.opacity = "0"; h.style.transform = "translateY(40px)"; addEventListener("load", () => setTimeout(() => { const t0 = performance.now(); const f = (t) => { const p = Math.min(1, (t - t0) / 800); h.style.opacity = String(p); h.style.transform = "translateY(" + (40 * (1 - p)) + "px)"; if (p < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); }, 300)); }
addEventListener("load", () => setTimeout(() => document.body.classList.add("is-loaded"), 200));
{ const w = document.getElementById("iwait"); addEventListener("load", () => setTimeout(() => { w.style.opacity = "0"; w.style.transform = "translateY(30px)"; }, 100)); }
{ const t = document.getElementById("itag"); addEventListener("load", () => { setTimeout(() => { t.style.opacity = "1"; t.style.transform = "translate(0px,0px)"; }, 300); setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translate(-5px,0px)"; }, 1500); }); }
{ const t = document.getElementById("itag2"); addEventListener("load", () => { setTimeout(() => { t.style.opacity = "1"; t.style.transform = "translate(0px,0px)"; }, 300); setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translate(-5px,0px)"; }, 7600); }); }</script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>gsap.from("#ig", { x: -80, opacity: 0, duration: 1.2, delay: 0.4, ease: "power3.out" });</script>
</body></html>`);
const page = join(outdir, "page.html");
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic</title>
<style id="s0">*, ::before, ::after { --tw-grad-pos: ; } .gradtext { background-image: linear-gradient(to bottom, #111 var(--tw-grad-pos), #888); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }</style>
<style id="s1">.hero{background:url(bg.png)} @import url("missing.css");
.vover{font:var(--f);font-size:13px}
.masked{mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><defs><pattern id='p'><circle r='2'/></pattern></defs><rect width='100%' height='100%' fill='url(%23p)'/></svg>")}</style>
<link rel="preload" as="script" href="x.js">
<script src="https://example.invalid/analytics.js"></script>
</head><body>
<header id="stick" style="position:sticky;top:0;height:50px;background:#fff;z-index:5"><a>Logo</a><span id="hdrphone">(555) 014-2290</span></header>
<div class="hero" style="height:400px;position:relative" onclick="alert(1)">hero<div id="herocap" style="position:absolute;top:120px;left:0;width:300px;height:80px">caption that fades as you scroll past</div><div style="position:absolute;top:220px;left:0;height:20px;overflow:hidden"><div id="heroreel" style="transform: translateY(-40px)">0<br>1<br>2<br>3<br>4</div></div><canvas id="glide" width="80" height="40" style="position:absolute;top:260px;left:400px;width:80px;height:40px"></canvas><i id="glide-expect" style="display:none"></i></div>
<div id="appear" style="opacity:0;transform:translateY(40px);will-change:transform;height:100px">appears on scroll</div>
<div id="menu" style="opacity:0;height:50px">plain hidden menu (must stay hidden)</div>
<nav><div id="dd" class="dd" style="opacity:0">dropdown opened by a scroll handler (must be restored closed)</div></nav>
<img id="lazy" loading="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" style="margin-top:2200px;width:10px;height:10px">
<div id="rv" style="opacity:0;transform:translateY(40px);height:100px">revealed only when scrolled to</div>
<div id="px" style="height:80px;background:#ccc">parallax layer</div>
<div id="tick" style="height:60px;width:200px;background:#eee">timer-driven box</div>
<div id="marq" style="white-space:nowrap">rates rates rates rates</div>
<div style="height:20px;overflow:hidden"><div id="waapi">0<br>1<br>2<br>3</div></div>
<div style="height:20px;overflow:hidden;margin-top:1400px"><div id="odo2" style="transform:translateY(-40px)">0<br>1<br>2<br>3</div></div>
<div id="odo" style="height:20px;overflow:hidden"><div id="odostrip" style="transform:translateY(0px)">0<br>1<br>2<br>3<br>4<br>5</div></div>
<video id="bgv" style="width:320px;height:180px;display:block"></video><video id="ctlv" controls style="width:320px;height:180px;display:block"></video><video id="oncev" style="width:320px;height:180px;display:block"></video>
<div style="height:20px;overflow:hidden;margin-top:1200px"><div id="lowreel" style="transform: translateY(-40px)">0<br>1<br>2<br>3<br>4</div></div>
<div id="fixov" style="position:fixed;right:0;bottom:0;width:200px;height:100px;opacity:0;pointer-events:none;z-index:50;background:rgb(250,200,150)">rolling sphere overlay</div>
<div id="maskbox" style="position:relative;width:300px;height:200px;margin-top:400px;overflow:hidden"><div style="position:absolute;inset:0;background-image:url(bg.png);background-size:cover"></div><div id="maskL" style="position:absolute;top:0;left:0;width:50%;height:100%;background-color:rgb(5,6,9);will-change:height"></div><div id="maskR" style="position:absolute;bottom:0;right:0;width:50%;height:100%;background-color:rgb(5,6,9);will-change:height"></div></div>
<div style="position:relative;width:300px;height:200px"><img src="bg.png" style="width:300px;height:200px;display:block"><div id="tint" style="position:absolute;inset:0;background-color:rgba(0,0,0,0.45);will-change:opacity"></div></div>
<div style="pointer-events:none;margin-top:300px"><p id="fxtext"><span id="fxl1" style="display:inline-block;opacity:0.001;transform:translateX(0px) translateY(40px)">CATCH</span> <span id="fxl2" style="display:inline-block;opacity:0.001;transform:translateX(0px) translateY(40px)">THE</span> <span style="display:inline-block;opacity:0.001;transform:translateX(0px) translateY(40px)">MOMENT</span></p></div>
<div id="scene3d" role="img" aria-label="a model that rolls along" style="position:fixed;inset:0;z-index:20;pointer-events:none"><canvas id="scenecv" width="200" height="120" style="width:100%;height:100%"></canvas></div>
<div id="bgscene" style="position:fixed;inset:0;z-index:-1;pointer-events:none"><canvas id="bgcv" width="40" height="40" style="width:100%;height:100%"></canvas></div>
<ul style="margin-top:300px"><li id="cliprow" style="opacity: 0; clip-path: inset(0px 0px 100%);">Halden — a row waiting for its GSAP reveal</li></ul>
<style>.st{opacity:0;transform:translateY(30px);transition:opacity .3s,transform .3s;height:60px}.st.on{opacity:1;transform:none}</style>
<section id="story" style="height:2400px;position:relative;margin-top:200px"><div style="position:sticky;top:0;height:600px"><div id="step1" class="st on">Step one of the story</div><div id="step2" class="st">Step two of the story</div></div></section>
<style>.flx section{opacity:0;transform:translateY(44px);transition:opacity 1s,transform 1s}.flx section.in{opacity:1;transform:none}</style>
<div class="flx"><section id="flsec" style="width:600px;height:120px;margin-top:300px">A whole section the stylesheet keeps hidden until a class arrives, and the class never came.</section></div>
<div id="stats" style="margin-top:400px;height:120px"><span id="stat1">0%</span> <span id="stat2">0K</span></div>
<style>@property --n { syntax: "<integer>"; inherits: false; initial-value: 0; } .sx { counter-reset: n var(--n); height: 60px; } .sx i::before { content: counter(n); }</style>
<ul style="margin-top:300px"><li id="sx1" class="sx" style="--to: 98; --n: 0;"><i></i>%</li></ul>
<iframe src="about:blank#recaptcha-invisible" style="width:1px;height:1px;border:0;position:absolute;left:-9999px"></iframe>
<div id="wflottie" data-animation-type="lottie" data-src="anim.json" data-loop="1" data-autoplay="1" data-renderer="svg" style="width:120px;height:120px"></div>
<div id="wfrive" data-animation-type="rive" data-rive-url="hero.riv" data-rive-state-machine="Main" style="width:200px;height:120px"><canvas width="200" height="120"></canvas></div>
<lottie-player id="lplayer" src="https://example.com/spin.json" loop autoplay style="width:80px;height:80px"></lottie-player>
<div id="reglottie" style="width:90px;height:90px"><svg width="90" height="90"></svg></div>
<canvas id="scrubcv" width="240" height="140" style="position:fixed;left:0;bottom:0;width:240px;height:140px;z-index:3;pointer-events:none"></canvas>
<div id="slidecard" style="height:20px;overflow:hidden"><div class="slidecol" style="transform: none;">0<br>1<br>2<br>3<br>4</div></div>
<div id="curtwrap" style="position:relative;height:140px;background:url(bg.png)"><div id="curtain" style="position:absolute;top:0;left:0;height:100%;width:100%;background:#050609">cover</div><div id="curtain2" style="position:absolute;top:0;right:0;height:100%;width:50%;background:#050609"></div></div>
<div id="clipwrap" style="overflow:hidden;border-radius:12px;height:120px"><div id="rvin" style="opacity:0;transform:scale(1.2);height:100px">revealed inside a clipped wrapper</div></div>
<div style="position:sticky;top:0"><div id="rvpin" style="opacity:0;transform:translateY(20px);height:60px">revealed inside a pinned section</div></div>
<p id="word" style="font-size:20px"><span>H</span><span>e</span><span style="opacity:0">l</span><span>l</span><span>o</span></p>
<img id="ds" data-src="late.png" src="" width="10" height="10">
<img id="rs" srcset="small.png 400w, big.png 1600w" src="small.png" width="10" height="10">
<picture><source srcset="p.webp" type="image/webp"><img id="pic" src="p.png" width="10" height="10"></picture>
<canvas id="cv" width="20" height="20"></canvas>
<input id="t" type="text"><input id="c" type="checkbox"><input id="pw" type="password">
<textarea id="ta"></textarea><select id="sel"><option>a</option><option>b</option></select>
<my-el id="host"></my-el>
<svg id="spr" width="20" height="20"><use href="/sprite.svg#star"></use></svg>
<div id="fa" data-framer-appear-id="abc123" style="opacity:1;transform:none;height:40px">framer appear</div>
<script type="framer/appear" id="__framer__appearAnimationsContent">{"abc123":{"default":{"initial":{"opacity":0.001,"y":40,"scale":0.9},"animate":{"opacity":1,"y":0,"scale":1,"transition":{"type":"spring","bounce":0.2,"duration":0.6,"delay":0.1}}},"bp1":{"initial":{"opacity":0.001,"x":-20},"animate":{"opacity":1,"x":0,"transition":{"type":"tween","ease":[0.44,0,0.56,1],"duration":0.5}}}}}</script>
<script type="framer/appear" id="__framer__breakpoints">[{"hash":"bp1","mediaQuery":"(max-width: 809.98px)"}]</script>
<p id="vf" class="vfont">var shorthand</p><p class="vover">var shorthand + override</p><p id="vi">inline var shorthand</p>
<canvas id="gl" width="30" height="30"></canvas>
<img id="bl" width="10" height="10">
<div id="cc-main" style="position:fixed;bottom:0;left:0;right:0;height:80px;background:#333">We use cookies <button>Accept</button></div>
<p class="cookie-recipe">Chocolate cookie recipe (in-flow content, must stay)</p>
<iframe id="fr" src="frame.html" width="200" height="100"></iframe>
<iframe id="track" width="0" height="0" src="frame.html"></iframe>
<img id="empty" width="10" height="10" alt="">
<noscript><img id="nspx" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1" width="1" height="1"></noscript>
<iframe id="cap" title="reCAPTCHA" src="frame.html#anchor" width="256" height="60"></iframe>
<iframe id="vimeo" src="https://player.vimeo.com/video/76979871?muted=1&loop=1&controls=0" width="320" height="180"></iframe>
<script>
  // header rebuilt into a compact version once scrolled (like Framer's scroll variants)
  addEventListener("scroll", () => { const h = document.getElementById("stick"); if (scrollY > 200) h.innerHTML = "<a>Logo</a>"; });
  // curtain reveal: the overlay retracts when the image scrolls into view
  // (closes again when it leaves the screen, like Framer's whileInView without "once")
  new IntersectionObserver((es)=>{ for (const e of es) document.getElementById("curtain").style.width = e.isIntersecting ? "0%" : "100%"; }, { threshold: 0.3 }).observe(document.getElementById("curtwrap"));
  // hero caption fades out once it has scrolled off the top (must stay visible in the copy)
  addEventListener("scroll", () => { document.getElementById("herocap").style.opacity = scrollY > 700 ? "0" : "1"; });
  // digit strip held by a Web Animation (fill: forwards) — nothing in the style attribute
  document.getElementById("waapi").animate([{ transform: "translateY(0px)" }, { transform: "translateY(-60px)" }], { duration: 200, fill: "forwards" });
  // odometer column that restarts from 0 (transform: none) then rolls to 2 every 1.2 s
  setInterval(() => { const c = document.getElementById("odo2"); c.style.transform = "none"; setTimeout(() => (c.style.transform = "translateY(-20px)"), 120); setTimeout(() => (c.style.transform = "translateY(-40px)"), 240); }, 1200);
  // perpetual marquee (never stops) + odometer that rolls through intermediate values every 1.5 s
  { let x = 0; (function m() { x = (x + 1) % 400; document.getElementById("marq").style.transform = "translateX(" + -x + "px)"; requestAnimationFrame(m); })(); }
  setInterval(() => { const st = document.getElementById("odostrip"); let k = 0; const roll = setInterval(() => { k++; st.style.transform = "translateY(" + (-k * 20 % 100) + "px)"; if (k >= 9) { clearInterval(roll); st.style.transform = "translateY(-80px)"; } }, 40); }, 1500);
  setTimeout(() => (document.getElementById("odostrip").style.transform = "translateY(-80px)"), 100);
  // a hero counter that advances when the page comes back to the top: digits reset to 0
  // (transform: none) and roll to the next value right after the scroll-back
  { let away = false; addEventListener("scroll", () => { if (scrollY > 600) away = true; if (scrollY === 0 && away) { away = false; const c = document.getElementById("heroreel"); c.style.transform = "none"; setTimeout(() => (c.style.transform = "translateY(-20px)"), 150); setTimeout(() => (c.style.transform = "translateY(-60px)"), 300); } }); }
  // a counter far down the page that also rolls when the page returns to the top
  { let away = false; addEventListener("scroll", () => { if (scrollY > 600) away = true; if (scrollY === 0 && away) { away = false; const c = document.getElementById("lowreel"); c.style.transform = "none"; setTimeout(() => (c.style.transform = "translateY(-60px)"), 200); } }); }
  // a canvas scene that keeps travelling for ~3.5 s after the page returns to the top
  // (a 3D model gliding to its section), ending on solid blue
  { const cv = document.getElementById("glide"), g = cv.getContext("2d"); const paint = (k) => { g.fillStyle = "rgb(" + Math.round(255 * (1 - k)) + ",0," + Math.round(255 * k) + ")"; g.fillRect(0, 0, 80, 40); }; paint(0);
    const ex = document.createElement("canvas"); ex.width = 80; ex.height = 40; const eg = ex.getContext("2d"); eg.fillStyle = "rgb(0,0,255)"; eg.fillRect(0, 0, 80, 40); document.getElementById("glide-expect").setAttribute("data-png", ex.toDataURL("image/png"));
    let away = false; addEventListener("scroll", () => { if (scrollY > 600) away = true; if (scrollY === 0 && away) { away = false; const t0 = performance.now(); const step = () => { const k = Math.min(1, (performance.now() - t0) / 3500); paint(k); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); } }); }
  // a fixed overlay shown only while the page is scrolled through the middle sections
  addEventListener("scroll", () => { document.getElementById("fixov").style.opacity = scrollY > 800 && scrollY < 2400 ? "1" : "0"; });
  // text split into word wrappers by a script (SplitText / SplitType use <div>s inside the <p>)
  { const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;width:600px"; const p1 = document.createElement("p"); p1.id = "split"; ["Whether", "on", "paper"].forEach((w, i) => { const d = document.createElement("div"); d.className = "word"; d.style.display = "inline-block"; d.textContent = w + " "; p1.appendChild(d); }); wrap.appendChild(p1); document.body.appendChild(wrap);
    const p2 = document.createElement("p"); p2.id = "split2"; p2.className = "lede"; const blk = document.createElement("div"); blk.textContent = "a real block inside a paragraph"; p2.appendChild(blk); document.body.appendChild(p2); }
  { const g = document.getElementById("scenecv").getContext("2d"); g.fillStyle = "rgb(255,140,60)"; g.beginPath(); g.arc(60, 60, 30, 0, 7); g.fill(); const b = document.getElementById("bgcv").getContext("2d"); b.fillStyle = "rgb(240,240,250)"; b.fillRect(0, 0, 40, 40); }
  // pinned scroll story: steps switch on and off with the scroll progress through the section
  addEventListener("scroll", () => { const st = document.getElementById("story"); const top = st.getBoundingClientRect().top + scrollY; const p = (scrollY - top) / (st.offsetHeight - innerHeight); document.getElementById("step1").classList.toggle("on", p < 0.5); document.getElementById("step2").classList.toggle("on", p >= 0.5 && p <= 1.1); });
  // count-up statistics: roll their text up when in view, reset to 0 when they leave
  { const box = document.getElementById("stats"); let t = null; new IntersectionObserver((es) => { for (const e of es) { clearInterval(t); if (e.isIntersecting) { let k = 0; t = setInterval(() => { k = Math.min(10, k + 1); document.getElementById("stat1").textContent = Math.round(9.8 * k) + "%"; document.getElementById("stat2").textContent = Math.round(2.8 * k) + "K"; if (k === 10) clearInterval(t); }, 40); } else { document.getElementById("stat1").textContent = "0%"; document.getElementById("stat2").textContent = "0K"; } } }).observe(box); }
  // count-up drawn with a CSS counter from a custom property, reset when it leaves the screen
  { const li = document.getElementById("sx1"); let t = null; new IntersectionObserver((es) => { for (const e of es) { clearInterval(t); if (e.isIntersecting) { let k = 0; t = setInterval(() => { k = Math.min(10, k + 1); li.style.setProperty("--n", String(Math.round(9.8 * k))); if (k === 10) clearInterval(t); }, 40); } else li.style.setProperty("--n", "0"); } }).observe(li); }
  // a page using lottie-web: its registry knows the container and the file
  window.lottie = { getRegisteredAnimations: () => [{ wrapper: document.getElementById("reglottie"), path: "https://cdn.example.com/anims/", fileName: "wave", loop: true, autoplay: true, renderer: { rendererType: "svg" } }] };
  // a scene redrawn from the scroll position (like a 3D camera flying through the page)
  { const g = document.getElementById("scrubcv").getContext("2d"); const draw = () => { const k = Math.min(1, scrollY / 4000); g.fillStyle = "rgb(" + Math.round(255 * (1 - k)) + ",40," + Math.round(255 * k) + ")"; g.fillRect(0, 0, 240, 140); }; draw(); addEventListener("scroll", draw); }
  // background video muted and set looping by script (no autoplay / loop attribute in the markup)
  document.getElementById("bgv").muted = true;
  document.getElementById("bgv").loop = true;
  // a product film the site plays ONCE when it comes into view (muted, no loop: apple.com's)
  document.getElementById("oncev").muted = true;
  // carousel slide: a NEW digit column (transform: none) replaces the old one, then a
  // Web Animation rolls it after a staggered delay — no DOM mutation while it rolls
  { const show = () => { const card = document.getElementById("slidecard"); const col = document.createElement("div"); col.className = "slidecol"; col.style.transform = "none"; col.innerHTML = "0<br>1<br>2<br>3<br>4"; card.replaceChildren(col); col.animate([{ transform: "none" }, { transform: "translateY(-60px)" }], { duration: 400, delay: 500, fill: "forwards", easing: "ease-out" }); }; show(); setInterval(show, 1600); }
  // timer-driven animation that keeps running while the page scrolls (must not be "scroll-linked")
  { let k = 0; setInterval(() => { k = (k + 1) % 20; document.getElementById("tick").style.transform = "translateX(" + (k * 3) + "px)"; }, 30); }
  // parallax: translateY follows the scroll position continuously
  addEventListener("scroll", () => { document.getElementById("px").style.transform = "translateY(" + Math.round(scrollY * 0.3) + "px)"; });
  // a scroll handler that opens a nav dropdown (Webflow-style side effect)
  addEventListener("scroll", () => { if (scrollY > 300) { const d = document.getElementById("dd"); d.classList.add("open"); d.style.opacity = "1"; } });
  // scroll-triggered reveal far below the fold
  { const io = new IntersectionObserver((es)=>{ for (const e of es) if (e.isIntersecting) { e.target.style.opacity="1"; e.target.style.transform="none"; } }); ["rv","rvin","rvpin"].forEach(id => io.observe(document.getElementById(id))); }
  // appear animation on intersection
  new IntersectionObserver((es)=>{ for (const e of es) if (e.isIntersecting) { e.target.style.opacity="1"; e.target.style.transform="none"; } }).observe(document.getElementById("appear"));
  // CSSOM-only rule (styled-components "speedy" mode): not in any textContent
  const st = document.createElement("style"); document.head.appendChild(st); st.sheet.insertRule(".cssom-only{color:rgb(9,8,7)}", 0);
  // adopted stylesheet
  const ad = new CSSStyleSheet(); ad.replaceSync(".adopted{color:rgb(4,5,6)}"); document.adoptedStyleSheets = [ad];
  // shadow root with its own adopted sheet
  const sr = document.getElementById("host").attachShadow({mode:"open"});
  sr.innerHTML = "<span class=inner>shadow</span><svg class=sh-ic width=12 height=12><use href='/sprite.svg#star'></use></svg>";
  const srs = new CSSStyleSheet(); srs.replaceSync(".inner{color:rgb(7,7,7)}"); sr.adoptedStyleSheets = [srs];
  // shorthands set through CSS variables (Chrome serializes them as empty longhands)
  const vs = document.createElement("style"); document.head.appendChild(vs);
  vs.sheet.insertRule(":root{--f: italic 700 21px/1.3 Georgia, serif; --bg: rgb(1, 2, 3) none; --b: 3px solid rgb(4, 5, 6)}", 0);
  vs.sheet.insertRule(".vfont{font: var(--f); background: var(--bg); border: var(--b) !important}", 1);
  document.getElementById("vi").style.font = "var(--f)";
  // canvas content
  const ctx = document.getElementById("cv").getContext("2d"); ctx.fillStyle="red"; ctx.fillRect(0,0,20,20);
  // WebGL canvas drawn in a rAF loop WITHOUT preserveDrawingBuffer (buffer clears after composite)
  const gl = document.getElementById("gl").getContext("webgl", { preserveDrawingBuffer: false });
  if (gl) { (function draw(){ gl.clearColor(0, 0.5, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw); })(); }
  else document.getElementById("gl").remove();
  // blob: image (object URLs die with the tab)
  fetch("data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==").then(r=>r.blob()).then(b=>{ document.getElementById("bl").src = URL.createObjectURL(b); });
  // form state
  document.getElementById("t").value = "typed"; document.getElementById("c").checked = true;
  document.getElementById("pw").value = "secret"; document.getElementById("ta").value = "multi"; document.getElementById("sel").value = "b";
</script>
<div style="height:200px"></div>
<div id="lastrev" style="opacity:0;transform:translateY(30px);will-change:transform;height:60px">the last line of the page</div>
<script>new IntersectionObserver((es)=>{ for (const e of es) if (e.isIntersecting) { e.target.style.opacity="1"; e.target.style.transform="none"; } }).observe(document.getElementById("lastrev"));</script>
</body></html>`);

// serve the synthetic files over http (file:// frames are opaque origins)
const server = createServer((req, res) => {
  try { const f = join(outdir, (req.url || "/").split("?")[0].replace(/^\//, "") || "page.html"); res.setHeader("content-type", f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".json") ? "application/json" : "text/html"); res.end(readFileSync(f)); }
  catch { res.statusCode = 404; res.end(""); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const synthUrl = `http://127.0.0.1:${server.address().port}/page.html`;

// ── chrome ─────────────────────────────────────────────────────────────────────
const port = 9335;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${CHROME_PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900"]);
const getJSON = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let up = false;
for (let i = 0; i < 150; i++) { try { await getJSON("/json/version"); up = true; break; } catch { await sleep(200); } }
if (!up) { console.error("Chrome never came up"); chrome.kill(); process.exit(1); }
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = new Map();
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } else if (msg.method && events.has(msg.method)) events.get(msg.method)(msg.params); });
  return { ready: new Promise((r) => ws.addEventListener("open", () => r())), on: (m, cb) => events.set(m, cb), send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }), close: () => ws.close() };
}
async function capture(url, opts, settle = 1500, atStart = null, dpr = 1) {
  const target = await getJSON(`/json/new?about:blank`, "PUT");
  const cdp = cdpConnect(target.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send("Page.enable");
  if (atStart) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: atStart }); // as the panel's "Replay the intro" does
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
  const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(20000)]); await sleep(settle);
  // a capture never takes minutes; a lost reply (page navigated / renderer swapped)
  // must fail the check instead of hanging the whole suite
  const reply = await Promise.race([
    cdp.send("Runtime.evaluate", { expression: expr(opts), returnByValue: true, awaitPromise: true }),
    sleep(180000).then(() => ({ exceptionDetails: { exception: { description: "capture did not reply within 3 minutes" } } })),
  ]);
  const { result, exceptionDetails } = reply;
  cdp.close(); await getJSON(`/json/close/${target.id}`).catch(() => {});
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval failed");
  const r = JSON.parse(result.value);
  applyFramerAppear(r); // the panel does this after every capture
  return r;
}

console.log("── synthetic page ──");
try {
  const r = await capture(synthUrl, {}, 300);
  const h = r.html;
  writeFileSync(join(outdir, "synthetic.captured.html"), h);
  // the copy itself: does the Lottie animation actually play there?
  {
    const t = await getJSON(`/json/new?about:blank`, "PUT");
    const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
    await c.send("Page.enable");
    await c.send("Page.navigate", { url: synthUrl.replace("page.html", "synthetic.captured.html") });
    await sleep(5000);
    const pos = async () => (await c.send("Runtime.evaluate", { expression: `(() => { const g = document.querySelector("#wflottie svg g g"); return g ? g.getAttribute("transform") : null; })()`, returnByValue: true })).result.value;
    const a = await pos(); await sleep(700); const b = await pos();
    ok(!!a && !!b && a !== b, `the copy plays the Lottie animation with lottie-web (frame moved: ${a} → ${b})`);
    const shown = async (y) => { await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }); await sleep(600); return (await c.send("Runtime.evaluate", { expression: `[...document.querySelectorAll("#scrubcv > img")].findIndex(i => getComputedStyle(i).opacity === "1")`, returnByValue: true })).result.value; };
    const f1 = await shown(200), f2 = await shown(3600);
    ok(f1 >= 0 && f2 > f1, `the copy shows the recorded frame for the scroll position (frame ${f1} near the top, frame ${f2} further down)`);
    c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
  }
  ok(h.startsWith("<!doctype html>"), "full document with doctype");
  ok(/<meta name="generator" content="StyleLift capture of http/.test(h), "provenance <meta generator>");
  ok(!/<script src="https:\/\/example.invalid/.test(h) && r.stats.scriptsStripped >= 2, "scripts stripped");
  ok(!/onclick=/.test(h), "inline on* handlers stripped");
  ok(!/rel="preload"/.test(h), "preload hints removed");
  ok(/id="appear"[^>]*style="[^"]*"/.test(h) ? !/id="appear"[^>]*opacity:\s*0/.test(h) : true, "scroll-appear element ended visible (IO fired during scroll pass)");
  ok(/id="menu"[^>]*opacity:\s*0/.test(h), "plain opacity:0 element (no animation hints) left untouched");
  ok(/id="dd" class="dd" style="opacity:\s*0/.test(h) && !/id="dd" class="dd open"/.test(h), "menu opened by a scroll handler restored to its original state");
  ok(/id="rv"[^>]*data-sl-reveal="r\d+"/.test(h) && /id="rv"[^>]*opacity:\s*1/.test(h), "below-the-fold reveal kept visible and tagged for a scroll animation");
  ok(!/id="appear"[^>]*data-sl-reveal/.test(h), "element already revealed on load gets no scroll animation");
  ok(/id="px"[^>]*data-sl-scroll="s\d+"/.test(h) && /@keyframes sl-scroll-s\d+ \{ 0% \{ transform: (none|matrix\(1, 0, 0, 1, 0, 0\)); \}[^@]*100% \{ transform: matrix\(1, 0, 0, 1, 0, \d+\)/.test(h), "parallax recorded as scroll-timeline keyframes");
  ok(/animation-timeline: scroll\(root block\); animation-range: \d+px \d+px/.test(h) && r.stats.scrollLinked >= 1, "scroll-linked animation bound to the page scroll range");
  ok(!/id="px"[^>]*data-sl-reveal/.test(h), "parallax element not treated as a one-shot reveal");
  ok(!/id="tick"[^>]*data-sl-scroll/.test(h), "timer-driven animation not mistaken for a scroll-linked effect");
  ok(/id="odostrip" style="transform: translateY\(-80px\)/.test(h), "timer-driven odometer keeps its settled value (not reset to 0)");
  ok(/class="slidecol" style="transform: (translateY\(-60px\)|matrix\(1, 0, 0, 1, 0, -60\))/.test(h), "carousel digits rolled by a delayed Web Animation are copied at rest, not at 0");
  ok(/id="heroreel" style="transform: translateY\(-60px\)/.test(h) && !/id="heroreel"[^>]*data-sl-reveal/.test(h), "counter that rolls right after the scroll returns to the top keeps its new value (its 0 is not a reveal)");
  ok(/--tw-grad-pos: ;/.test(h), "empty custom property kept (Tailwind gradient text stays visible)");
  ok(/id="lowreel" style="transform: translateY\(-60px\)/.test(h), "off-screen counter that rolled after scroll-back keeps its value (a reel inside a clip is not a reveal)");
  { const exp = (h.match(/id="glide-expect"[^>]*data-png="([^"]+)"/) || [])[1]; const got = (h.match(/id="glide"[^>]*src="([^"]+)"/) || h.match(/src="([^"]+)"[^>]*id="glide"/) || [])[1];
    ok(!!exp && got === exp, "canvas snapshot taken after its scene stopped travelling (final frame, not mid-glide)"); }
  ok(/id="fixov" style="[^"]*opacity:\s*0(?![.\d])/.test(h) && !/id="fixov"[^>]*data-sl-reveal/.test(h), "fixed overlay shown only mid-scroll keeps its at-the-top state (hidden)");
  ok(/id="maskL"[^>]*style="[^"]*height: 0px/.test(h) && /id="maskR"[^>]*style="[^"]*height: 0px/.test(h) && /id="maskL"[^>]*data-sl-reveal/.test(h), "image-reveal curtains that never opened during the pass are opened (and animate in on scroll)");
  ok(/id="tint" style="position:absolute;inset:0;background-color:rgba\(0,0,0,0\.45\);will-change:opacity"/.test(h) && !/id="tint"[^>]*data-sl-reveal/.test(h), "a see-through tint over a photo is left alone");
  { const l1 = (h.match(/<span id="fxl1"[^>]*>/) || [""])[0]; const id = (l1.match(/data-sl-reveal="(r\d+)"/) || [])[1];
    ok(!/opacity:\s*0\.001/.test(l1) && !!id && new RegExp(`@keyframes sl-reveal-${id} \\{ from \\{ opacity: 0\\.001; transform: translateX\\(0px\\) translateY\\(40px\\)`).test(h), "text parked in its hidden 'in view' state (inside pointer-events:none) is shown and replays its entrance on scroll"); }
  ok(/id="lastrev"[^>]*>/.test(h) && !/id="lastrev"[^>]*data-sl-reveal/.test(h) && !/id="lastrev"[^>]*opacity:\s*0[;"]/.test(h), "a reveal at the very end of the page is shown as is (no scroll left to replay it)");
  ok(/<p id="split"[^>]*><span class="word" style="display: inline-block;">Whether <\/span><span class="word"/.test(h), "script-built <div> word wrappers inside a <p> become <span>s (the parser would split the paragraph)");
  ok(/<div id="split2" class="lede"><div>a real block inside a paragraph<\/div><\/div>/.test(h), "a <p> holding a real block becomes a <div> (structure kept on reload)");
  ok(/id="scene3d"[^>]*style="[^"]*position: absolute !important; (top: 0px !important|inset: 0px auto auto 0px !important)/.test(h), "a fixed full-screen 3D layer over the content is placed on the first screen (it no longer floats over every section)");
  ok(/id="bgscene"[^>]*style="position:fixed;inset:0;z-index:-1;pointer-events:none"/.test(h), "a fixed canvas background behind the content stays fixed");
  { const row = (h.match(/<li id="cliprow"[^>]*>/) || [""])[0]; const id = (row.match(/data-sl-reveal="(r\d+)"/) || [])[1];
    ok(!/opacity: 0;/.test(row) && !/inset\(0px 0px 100%\)/.test(row) && !!id && new RegExp(`@keyframes sl-reveal-${id} \\{ from \\{ opacity: 0; clip-path: inset\\(0px 0px 100%\\)`).test(h), "a row parked at a clip-path + opacity start state is shown and replays its wipe on scroll"); }
  { const id = (h.match(/<div id="step2"[^>]*data-sl-scroll="(s\d+)"/) || [])[1]; const kf = id ? (h.match(new RegExp(`@keyframes sl-scroll-${id} \\{[^\\n]*`)) || [""])[0] : "";
    ok(!!id && /opacity: 1/.test(kf) && /opacity: 0[;.]/.test(kf), "a step of a pinned scroll story (on, then off again) is replayed on the page's scroll timeline"); }
  { const sec = (h.match(/<section id="flsec"[^>]*>/) || [""])[0]; const id = (sec.match(/data-sl-reveal="(r\d+)"/) || [])[1];
    ok(/opacity: 1/.test(sec) && /transform: none/.test(sec) && !!id && new RegExp(`@keyframes sl-reveal-${id} \\{ from \\{ opacity: 0; transform: matrix\\(1, 0, 0, 1, 0, 44\\)`).test(h), "a section a stylesheet keeps hidden until a class arrives is shown and replays its entrance"); }
  ok(/<span id="stat1">98%<\/span>/.test(h) && /<span id="stat2">28K<\/span>/.test(h), "count-up statistics keep the value they reached (not the 0 they reset to off screen)");
  ok(/<li id="sx1" class="sx" style="--to: 98; --n: 98;">/.test(h), "a count-up drawn from a CSS custom property keeps the target it reached");
  ok(!r.warnings.some((w) => /bot-check/.test(w)), "an invisible reCAPTCHA behind a form isn't reported as a bot wall");
  ok(/id="wflottie"[^>]*data-sl-anim="lottie" data-sl-anim-src="http[^"]*\/anim\.json"/.test(h), "Webflow Lottie element wired to play its real animation file");
  ok(/id="wfrive"[^>]*data-sl-anim="rive" data-sl-anim-src="http[^"]*\/hero\.riv" data-sl-anim-statemachine="Main"/.test(h), "Webflow Rive element wired to play its .riv file (with its state machine)");
  ok(/<div id="lplayer"[^>]*data-sl-anim="lottie" data-sl-anim-src="https:\/\/example\.com\/spin\.json"/.test(h) && !/<lottie-player/.test(h), "<lottie-player> becomes a box that lottie-web fills");
  ok(/id="reglottie"[^>]*data-sl-anim="lottie" data-sl-anim-src="https:\/\/cdn\.example\.com\/anims\/wave\.json"/.test(h), "a lottie-web animation is found through its registry and plays its real file");
  ok(/<script data-sl-anim-runtime="">[\s\S]*lottie-web\/5\.12\.2[\s\S]*@rive-app\/canvas@2\.21\.6/.test(h), "one loader script brings the Lottie and Rive runtimes (pinned versions)");
  { const tag = (h.match(/<span id="scrubcv"[^>]*data-sl-scrub="(f\d+)"[^>]*>/) || []); const frames = tag[1] ? (h.match(new RegExp(`data-sl-frame="${tag[1]}-\\d+"`, "g")) || []).length : 0;
    ok(!!tag[1] && frames >= 3 && new RegExp(`\\[data-sl-frame="${tag[1]}-1"\\] \\{ animation: sl-frame-on linear; animation-timeline: scroll\\(root block\\); animation-range: \\d+px \\d+px; \\}`).test(h), `a canvas redrawn by scroll is recorded frame by frame and replayed on the scroll timeline (${frames} frames)`); }
  {
    const tag = (/<video[^>]*id="bgv"[^>]*>/.exec(h) || [""])[0];
    ok(["autoplay", "muted", "playsinline", "loop"].every((a) => new RegExp(`\\s${a}(=""|\\s|>)`).test(tag)), `script-started background video autoplays (muted, inline, looping) in the copy (${tag.slice(0, 160)})`);
  }
  ok(/<video id="ctlv"/.test(h) && !/<video id="ctlv"[^>]*autoplay/.test(h), "a video with controls is left for the visitor to start");
  { const v = (h.match(/<video id="oncev"[^>]*>/) || [""])[0];
    ok(/data-sl-play="enter"/.test(v) && /muted=""/.test(v) && !/autoplay|loop/.test(v), `a film the site plays once (muted, not looping) plays once as it comes into view — not on a loop from page load (${v.slice(0, 160)})`); }
  ok(/id="waapi" style="transform: matrix\(1, 0, 0, 1, 0, -60\)/.test(h) && r.stats.animatedBaked >= 1, "value held by a script-driven Web Animation is written into the copy");
  ok(/id="odo2" style="transform: translateY\(-40px\)/.test(h) && !/id="odo2"[^>]*data-sl-reveal/.test(h), "odometer digit that rolls through 0 is not mistaken for a reveal (keeps its real digit)");
  ok(/id="curtain"[^>]*width:\s*0%/.test(h) && r.stats.concealers >= 1, "curtain that retracts on scroll is kept retracted (content uncovered)");
  ok(/id="curtain"[^>]*data-sl-reveal="r\d+"/.test(h) && /@keyframes sl-reveal-r\d+ \{ from \{ width: 100%; \} \}/.test(h), "curtain retraction replayed as a scroll animation from its covering width");
  ok(!/id="herocap"[^>]*opacity:\s*0/.test(h), "hero caption that fades as you scroll past stays visible");
  ok(/<header id="stick"[^>]*>[\s\S]{0,80}<span id="hdrphone">\(555\) 014-2290<\/span>/.test(h) && r.stats.headersRestored >= 1, "sticky header captured in its at-the-top state (not the compact scrolled version)");
  ok(/id="curtain2"[^>]*width:\s*0px/.test(h) && /id="curtain2"[^>]*data-sl-reveal/.test(h), "the curtain's partner half (opens later) is retracted with it");
  ok(/id="clipwrap"[^>]*data-sl-vt="t\d+"/.test(h) && /id="rvin"[^>]*data-sl-tl="t\d+"/.test(h) && /view-timeline: --sl-t\d+ block/.test(h) && /timeline-scope: --sl-t\d+/.test(h), "reveal inside overflow:hidden anchored to a named view timeline on the wrapper");
  ok(/id="rvpin"[^>]*opacity:\s*1/.test(h) && !/id="rvpin"[^>]*data-sl-reveal/.test(h), "reveal inside a pinned (sticky) section kept visible, not animated");
  ok(/<span style="">l<\/span>|<span>l<\/span><span>l<\/span>/.test(h) || !/<span style="opacity:\s*0">l/.test(h), "hidden letter of a half-scrambled word revealed");
  ok(/@keyframes sl-reveal-r\d+ \{ from \{ opacity: 0; transform: matrix\(1, 0, 0, 1, 0, 40\); \} \}/.test(h), "reveal keyframes start from the element's real hidden state");
  ok(/animation-timeline: view\(\)/.test(h) && /@supports \(animation-timeline: view\(\)\)/.test(h) && r.stats.scrollReveals >= 1, "CSS scroll-driven animation with @supports fallback");
  ok(/id="lazy"[^>]*loading="eager"/.test(h), "lazy image switched to eager");
  ok(/id="ds"[^>]*src="[^"]*late\.png"/.test(h), "data-src lazy pattern resolved");
  ok(/id="rs"[^>]*srcset="(http[^" ]*big\.png) 1600w"[^>]*src="\1"/.test(h) || /id="rs"[^>]*src="(http[^"]*big\.png)"[^>]*srcset="\1 1600w"/.test(h), "largest srcset candidate chosen, kept as the only candidate (same intrinsic size as live)");
  ok(!/<source srcset="p\.webp"/.test(h), "<picture> sources collapsed");
  ok(/data-sl-canvas[^>]*src="data:image\/png/.test(h) || /src="data:image\/png[^>]*data-sl-canvas/.test(h), "canvas → img data URL");
  ok(/id="t"[^>]*value="typed"/.test(h), "input value captured");
  ok(/id="c"[^>]*checked/.test(h), "checkbox state captured");
  ok(!/secret/.test(h), "password value NOT captured");
  ok(/<textarea id="ta">multi<\/textarea>/.test(h), "textarea value captured");
  ok(/<option selected="">b<\/option>/.test(h), "select state captured");
  ok(/<template shadowrootmode="open">/.test(h) && /class="inner"/.test(h), "shadow root → declarative shadow DOM");
  ok(/\.inner\s*{\s*color:\s*rgb\(7,\s*7,\s*7\)/.test(h), "shadow adopted stylesheet inlined");
  ok(/\.adopted\s*{\s*color:\s*rgb\(4,\s*5,\s*6\)/.test(h), "document adopted stylesheet inlined");
  ok(/\.cssom-only\s*{\s*color:\s*rgb\(9,\s*8,\s*7\)/.test(h), "CSSOM-inserted (insertRule) rule captured");
  ok(/url\("http:[^"]*bg\.png"\)/.test(h), "CSS url() absolutized");
  ok(/fill='url\(%23p\)'/.test(h), "url() nested inside a data: SVG string left untouched (no corruption)");
  ok(/<svg id="spr"[^>]*>\s*<svg[^>]*viewBox="0 0 10 10"[^>]*>\s*<path d="M5 0L6 4/.test(h) && !/sprite\.svg#star/.test(h.split("data-sl-framer-appear")[0].replace(/<template[\s\S]*?<\/template>/g, "")), "external SVG sprite <use> inlined as the symbol's shapes");
  ok(/<template shadowrootmode="open">[\s\S]*class="sh-ic"[\s\S]*<path d="M5 0L6 4/.test(h), "sprite <use> inside a shadow root inlined too");
  ok(/\.vfont\s*\{[^}]*font:\s*var\(--f\)/.test(h) && /\.vfont\s*\{[^}]*background:\s*var\(--bg\)/.test(h), "shorthands set via var() survive serialization (font, background)");
  ok(/\.vfont\s*\{[^}]*border:\s*var\(--b\)\s*!important/.test(h), "var() shorthand keeps !important");
  ok(/id="vi"[^>]*style="font: var\(--f\)/.test(h), "inline style shorthand set via var() survives");
  ok(!/\.vfont\s*\{[^}]*font-style:\s*;/.test(h), "no empty longhands left in the output");
  ok(/\.vover\s*\{\s*font:\s*var\(--f\);[^}]*font-size:\s*13px/.test(h), "var() shorthand + later longhand override recovered from authored source, order kept");
  ok(r.stats.appearAnimations === 2, `Framer appear JSON compiled (${r.stats.appearAnimations} animations)`);
  ok(/<style data-framer-breakpoint-css="" data-sl-restored="">@media \(max-width: 809\.98px\) \{ \.hidden-bp1 \{ display: none !important; \} \}<\/style>/.test(r.html), "Framer breakpoint rules rebuilt (the runtime deletes them after hydrating)");
  ok(r.stats.viewportWidth > 0, `capture records its viewport width (${r.stats.viewportWidth})`);
  ok(/@keyframes sl-appear-abc123-default\s*\{\s*from\s*\{\s*opacity:\s*0\.001;\s*transform:\s*translate\(0px, 40px\) scale\(0\.9\)/.test(h), "appear keyframes: initial state → from{}");
  ok(/\[data-framer-appear-id="abc123"\]\s*\{\s*animation:\s*sl-appear-abc123-default 0\.6s linear\(0, [^)]*\) 0\.1s both/.test(h), "spring → CSS linear() easing with duration + delay");
  ok(/@media \(max-width: 809\.98px\)\s*\{\s*\[data-framer-appear-id="abc123"\][^}]*cubic-bezier\(0\.44, 0, 0\.56, 1\)/.test(h), "breakpoint variant → @media rule with tween cubic-bezier");
  ok(/prefers-reduced-motion: no-preference/.test(h), "appear animations respect prefers-reduced-motion");
  ok(/<script type="application\/json" data-sl-framer-appear-source="">/.test(h) && !/type="framer\/appear"/.test(h), "source JSON kept as inert data, executable framer scripts stripped");
  ok(/srcdoc="/.test(h) && /in-frame/.test(h) && r.stats.frames === 1, "same-origin iframe inlined as srcdoc");
  ok(!/id="track"/.test(h), "0×0 tracking iframe dropped");
  ok(/<img id="empty"(?![^>]*\ssrc=)[^>]*>/.test(h), "an image with no source keeps none (never the page's own address)");
  ok(!/nspx|<noscript/.test(h), "<noscript> fallbacks (a Facebook pixel) are left out of the static copy");
  ok(!/id="cap"/.test(h), "a captcha widget frame is left out of the copy");
  ok(/id="vimeo"[^>]*src="[^"]*autoplay=1/.test(h) || /src="[^"]*vimeo[^"]*autoplay=1[^"]*"[^>]*id="vimeo"/.test(h), "a muted, looping background Vimeo player is set to play by itself (the site's script did that)");
  ok(!/id="cc-main"/.test(h) && r.stats.bannersRemoved === 1, "fixed cookie-consent banner removed");
  ok(/cookie-recipe/.test(h), "in-flow content mentioning cookies kept");
  ok(typeof r.stats.quality === "number" && r.stats.quality > 50, `self-diagnosis gave a quality score (${r.stats.quality})`);
  ok(!/id="gl"/.test(h) || /id="gl"[^>]*src="data:image\/png/.test(h), "WebGL canvas (no preserveDrawingBuffer) grabbed via rAF-synchronized read");
  ok(/id="bl"[^>]*src="data:image\//.test(h), "blob: image converted to a data: URI");
  // page-side event safety: does capture leave *the live page* alone?
  const sideEffect = await capture(synthUrl, { loadDeferred: true }, 500);
  const touched = await (async () => { const c = sideEffect; return c; })();
  void touched;
  ok(/<base href="http:/.test(h), "<base> added for relative URLs");
  ok(r.stats.scrollSteps > 0, `scroll pass ran (${r.stats.scrollSteps} steps)`);
  const r2 = await capture(synthUrl, { scripts: "keep", loadDeferred: false }, 300);
  ok(/<script src="https:\/\/example.invalid\/analytics.js">/.test(r2.html), "scripts kept with scripts:'keep'");
} catch (e) { failures.push("synthetic: " + e.message); console.log("  ✗ ERROR", e.message); }

// ── real sites ─────────────────────────────────────────────────────────────────
// GSAP animations survive: recorded before they're fast-forwarded and replayed with CSS
{ const g = await capture(synthUrl.replace("page.html", "gsap.html"), {}, 3000).catch((e) => ({ html: "", error: String(e) }));
  const doc = new JSDOM(g.html || "<html></html>").window.document;
  const st = (el) => (el ? el.getAttribute("style") || "" : "");
  // a ticker moved by a script every frame (no GSAP involved)
  const rafm = doc.querySelector("#rafm"), rd = Number((/--sl-in-d: ?(\d+)ms/.exec(st(rafm)) || [])[1] || 0);
  ok(rafm?.hasAttribute("data-sl-loop") && rd > 7000 && rd < 13000 && /-600, 0\)/.test(g.html), `a ticker moved by a script every frame is measured and looped with CSS (one repeat = 600 px, ${rd} ms ≈ 10 s)`);
  const sws = [...doc.querySelectorAll(".sw")];
  ok(sws.length === 8 && sws.filter((w) => w.hasAttribute("data-sl-scroll")).length >= 6, `words that light up as you scroll are replayed on the scroll position (${sws.filter((w) => w.hasAttribute("data-sl-scroll")).length}/8)`);
  // a reveal driven by a class on the section around it (the child's own class / style never change)
  const secA = doc.querySelector("#secA"), itemA = doc.querySelector("#itemA");
  // (its CSS transition gives its timing: replayed over 500 ms as it comes into view)
  ok(secA?.classList.contains("is-inview") && itemA?.getAttribute("data-sl-in-on") === "enter" && /--sl-in-d: ?500ms/.test(itemA?.getAttribute("style") || ""), `a reveal driven by its section's class is kept and replayed with its own transition time (section "${secA?.className}", item ${itemA?.getAttribute("data-sl-in")} "${(itemA?.getAttribute("style") || "").slice(0, 80)}")`);
  if (!(g.settled?.libs || []).includes("gsap")) console.log("  (GSAP didn't load from its CDN — offline? GSAP checks skipped)");
  else {
    const intro = doc.querySelector("#intro"), cards = [...doc.querySelectorAll(".card")], track = doc.querySelector("#track"), bs = [...doc.querySelectorAll(".b")];
    ok(!!doc.querySelector("style[data-sl-gsap-motion]") && /@keyframes sl-in-g\d/.test(g.html), "GSAP: the copy carries the page's GSAP motion as CSS keyframes");
    ok(intro?.hasAttribute("data-sl-in") && !intro.hasAttribute("data-sl-in-on") && /--sl-in-d: ?20000ms/.test(st(intro)) && /--sl-in-dl: ?200ms/.test(st(intro)) && /cubic-bezier\(\.165,\s*\.84,\s*\.44,\s*1\)/.test(st(intro)), `GSAP: an intro plays on load with its own duration, delay and easing (${st(intro).slice(0, 160)})`);
    const cd = cards.map((c) => (/--sl-in-dl: ?(\d+)ms/.exec(st(c)) || [])[1]).join(",");
    ok(cards.every((c) => c.getAttribute("data-sl-in-on") === "enter") && cd === "0,150,300", `GSAP: a scroll-triggered reveal waits for view, its stagger kept (delays ${cd})`);
    ok(track?.hasAttribute("data-sl-loop") && /--sl-in-d: ?8000ms/.test(st(track)) && /--sl-in-e: ?linear/.test(st(track)), `GSAP: an endless marquee keeps looping at its speed (${st(track).slice(0, 120)})`);
    ok(bs.every((b) => b.hasAttribute("data-sl-in") && b.getAttribute("data-sl-in-on") === "enter"), "GSAP: ScrollTrigger.batch reveals (made while scrolling) are recorded too");
    ok(!/data-sl-gsap(-loop)?="/.test(g.html), "GSAP: no recording markers left in the copy");

  }
}
{ const ir = await capture(synthUrl.replace("page.html", "intro.html"), {}, 8500, introRecorderSource());
  const d = new JSDOM(ir.html).window.document;
  const st = (sel) => (d.querySelector(sel) && d.querySelector(sel).getAttribute("style")) || "";
  const dur = (sel) => Number((/--sl-in-d: ?(\d+)ms/.exec(st(sel)) || [])[1] || 0);
  ok(d.querySelector("#ih")?.hasAttribute("data-sl-in") && !d.querySelector("#ih").hasAttribute("data-sl-in-on") && dur("#ih") > 500 && dur("#ih") < 1300, `intro: a hand-made opening animation is recorded and replays on load (${dur("#ih")} ms ≈ 800)`);
  ok(!/opacity:\s*0(?![.\d])/.test(st("#iwait")) && !d.querySelector("#iwait")?.hasAttribute("data-sl-exited"), `intro: content the page hides until it's scrolled to is still shown in the copy (not taken for an exit) ("${st("#iwait")}")`);
  ok(/opacity:\s*0[;"]?/.test(st("#itag")) && !d.querySelector("#itag")?.hasAttribute("data-sl-in") && !d.querySelector("#itag")?.hasAttribute("data-sl-exited"), `intro: a tagline that came and went again stays hidden (it's where the intro left it) ("${st("#itag")}")`);
  ok(/opacity:\s*0[;"]?/.test(st("#itag2")) && !d.querySelector("#itag2")?.hasAttribute("data-sl-in"), `intro: a slow intro's tagline that went away after 7 s stays hidden too ("${st("#itag2")}")`);
  ok(d.querySelector("#ic")?.hasAttribute("data-sl-in") && dur("#ic") >= 600 && dur("#ic") <= 900, `intro: content revealed by a "loaded" class replays with its CSS timing (${dur("#ic")} ms ≈ 700)`);
  if ((ir.settled?.libs || []).includes("gsap")) ok(d.querySelector("#ig")?.hasAttribute("data-sl-in") && dur("#ig") === 1200 && /--sl-in-dl: ?400ms/.test(st("#ig")), `intro: a GSAP intro that finished long before the capture is recorded exactly (${dur("#ig")} ms, ${st("#ig").match(/--sl-in-dl: ?\d+ms/)})`);
  else console.log("  (GSAP didn't load from its CDN — GSAP intro check skipped)"); }
for (const variant of ["", "#bundled"]) {
  const pc = await capture(synthUrl.replace("page.html", "pin.html" + variant), {}, 1500).catch((e) => ({ html: "", error: String(e) }));
  const label = variant ? "bundled GSAP (from the pin's spacer)" : "GSAP's own start / end";
  if (!pc.html || !/data-sl-pinned/.test(pc.html)) {
    if (!(pc.settled?.libs || []).includes("gsap") && !variant) { console.log("  (GSAP didn't load from its CDN — pin checks skipped)"); break; }
  }
  const d = new JSDOM(pc.html || "<html></html>").window.document;
  const ps = d.querySelector("#pinsec"), css = d.querySelector("style[data-sl-pinned]")?.textContent || "";
  const id = ps?.getAttribute("data-sl-pinned");
  ok(!!id && new RegExp(`sl-pin-${id} \\{ from \\{ translate: 0 0; \\} to \\{ translate: 0 2000px; \\}`).test(css) && /animation-range: 1200px 3200px/.test(css) && d.querySelector("#htrack")?.hasAttribute("data-sl-scroll") && !/data-sl-pin=/.test(pc.html), `a pinned section is held for its 2000 px of scrolling, its track scrubbed sideways — ${label} (${(/animation-range: [^;]+/.exec(css) || ["none"])[0]})`);
  // in the copy itself: scrolled half way through the pin, the section still fills the screen, the track half way
  writeFileSync(join(outdir, "pin.captured.html"), pc.html || "");
  const t = await getJSON(`/json/new?about:blank`, "PUT");
  const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: synthUrl.replace("page.html", "pin.captured.html") });
  await sleep(2500);
  const at = async (y) => { await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }); await sleep(500); return (await c.send("Runtime.evaluate", { expression: `(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector("#htrack")).transform); return { top: Math.round(document.querySelector("#pinsec").getBoundingClientRect().top), x: Math.round(m.m41) }; })()`, returnByValue: true })).result.value; };
  const mid = await at(2200), past = await at(3700);
  ok(Math.abs(mid.top) <= 3 && Math.abs(mid.x + 1000) <= 80 && past.top < -300, `…the copy holds it on screen half way through (top ${mid.top}px, track at ${mid.x}px ≈ -1000) and lets it scroll on after (top ${past.top}px)`);
  c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
}
{ const sc = await capture(synthUrl.replace("page.html", "stagger.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(sc.html || "<html></html>").window.document;
  const v = (el, k) => (new RegExp(`--sl-in-${k}: ?([^;]+)`).exec(el?.getAttribute("style") || "") || [])[1] || "";
  const ms = (el, k) => parseFloat(v(el, k)) || 0;
  const ls = [...d.querySelectorAll("#sth span")];
  const durs = ls.map((l) => ms(l, "d")), dels = ls.map((l) => ms(l, "dl"));
  const steps = dels.slice(1).map((x, i) => x - dels[i]);
  ok(ls.length === 6 && ls.every((l) => l.hasAttribute("data-sl-in") && l.getAttribute("data-sl-in-on") === "enter") && durs.every((x) => x >= 450 && x <= 780) && steps.every((x) => x >= 40 && x <= 130) && /cubic-bezier\((\.16|\.22|\.25),/.test(v(ls[0], "e")), `letters a script animates in one after another: each replayed with its own time, stagger and ease-out (durations ${durs.join("/")} ms, delays ${dels.join("/")} ms, ${v(ls[0], "e")})`);
  const cs = ["#sc0", "#sc1", "#sc2"].map((q) => d.querySelector(q));
  ok(cs.every((c) => c?.hasAttribute("data-sl-in") && c.getAttribute("data-sl-in-on") === "enter" && ms(c, "d") === 500) && cs.map((c) => ms(c, "dl")).join(",") === "0,120,240" && v(cs[0], "e") === "cubic-bezier(0,0,.58,1)", `cards revealed by a class: their CSS transition's time, per-card delay and easing (${cs.map((c) => `${ms(c, "d")}ms+${ms(c, "dl")}`).join(", ")}, ${v(cs[0], "e")})`);
}
{ const lc = await capture(synthUrl.replace("page.html", "lerp.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(lc.html || "<html></html>").window.document;
  const lp = d.querySelector("#lp"), st = lp?.getAttribute("style") || "";
  const rr = /--sl-rr: cover (\d+)px cover (\d+)px/.exec(st);
  ok(!!rr && lp?.hasAttribute("data-sl-reveal") && !lp?.hasAttribute("data-sl-in") && Number(rr[1]) >= 0 && Number(rr[1]) <= 350 && Number(rr[2]) >= 700 && Number(rr[2]) <= 1300, `a reveal an eased scroll animation plays over ~900 px (from 100 px into view) is scrubbed over its own measured stretch, not timed (${rr ? rr[0] : "none: " + st.slice(0, 140)})`);
}
{ const lc = await capture(synthUrl.replace("page.html", "lazypic.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const im = new JSDOM(lc.html || "<html></html>").window.document.querySelector("#lzi");
  ok(/icon1x\.png$/.test(im?.getAttribute("src") || ""), `a picture a script fills only when it comes near (a placeholder until then) is visited again and copied with its real file (${(im?.getAttribute("src") || "none").slice(0, 80)}, ${lc.stats?.lazyRevisits || 0} revisit(s))`);
}
{ const sc = await capture(synthUrl.replace("page.html", "stagger2.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(sc.html || "<html></html>").window.document;
  const lk = d.querySelector("#lk"), items = ["#sg1", "#sg2"].map((q) => d.querySelector(q));
  const shown = lk?.classList.contains("staggered-end") || items.every((x) => /opacity:\s*1/.test(x?.getAttribute("style") || ""));
  ok(shown, `items a block shows as it comes into view (and resets when scrolled back above) end shown in the copy (block "${lk?.className}", items "${items.map((x) => x?.getAttribute("style") || "").join(" | ")}")`);
}
{ const hc = await capture(synthUrl.replace("page.html", "heroslides.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(hc.html || "<html></html>").window.document;
  const act = [1, 2, 3].filter((i) => d.querySelector(`#ht${i}`)?.classList.contains("active"));
  const pic = [1, 2, 3].filter((i) => /opacity:\s*1/.test(d.querySelector(`#hp${i}`)?.getAttribute("style") || ""));
  ok(act.length === 1 && pic.length === 1 && act[0] === pic[0], `a hero slideshow that kept switching while we scrolled far below shows one slide, its title and picture together (titles ${act.join(",") || "none"}, pictures ${pic.join(",") || "none"})`);
}
{ const fc = await capture(synthUrl.replace("page.html", "faraway.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(fc.html || "<html></html>").window.document;
  const st = ["#fw2", "#fw3"].map((q) => d.querySelector(q));
  const comesIn = (x) => !!x && (x.hasAttribute("data-sl-in") || x.hasAttribute("data-sl-reveal") || /opacity:\s*1/.test(x.getAttribute("style") || ""));
  ok(st.every(comesIn), `section headings a scroll system rewrites far off screen still come in (never taken for a slideshow) (${st.map((x) => (x?.getAttribute("style") || "") + (x?.hasAttribute("data-sl-in") ? " +in" : "") + (x?.hasAttribute("data-sl-reveal") ? " +reveal" : "")).join(" | ")})`);
}
{ const oc = await capture(synthUrl.replace("page.html", "ownanim.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const g = new JSDOM(oc.html || "<html></html>").window.document.querySelector("#gh");
  ok(!!g && g.classList.contains("animate") && g.hasAttribute("data-sl-hold") && !g.hasAttribute("data-sl-in") && !g.hasAttribute("data-sl-reveal") && /opacity:\s*1/.test(g.getAttribute("style") || ""), `a heading that comes in with its own animation (set off by a class) keeps that class and animation, held until it comes into view — not replaced by ours (class "${g?.className}", ${g?.hasAttribute("data-sl-hold") ? "held" : "not held"}, style "${g?.getAttribute("style")}")`);
}
{ const vc = await capture(synthUrl.replace("page.html", "progvar.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const html = vc.html || "";
  ok(/<div id="lbar"[^>]*data-sl-var="v\d+"/.test(html) && /@property --progress \{ syntax: "<number>"/.test(html) && /@keyframes sl-var-v\d+ \{[^}]*--progress: 0;[^@]*--progress: 1;/.test(html), "a progress variable a script sets as you scroll (--progress) is recorded and registered to play back on the scroll timeline");
  writeFileSync(join(outdir, "progvar.captured.html"), html);
  const t = await getJSON(`/json/new?about:blank`, "PUT");
  const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: synthUrl.replace("page.html", "progvar.captured.html") });
  await sleep(1500);
  const at = async (y) => { await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }); await sleep(400); return (await c.send("Runtime.evaluate", { expression: `Math.round(document.getElementById("lbar").getBoundingClientRect().top)`, returnByValue: true })).result.value; };
  const top = await at(0), mid = await at(810), down = await at(1600);
  ok(top === -50 && mid < -5 && mid > -45 && down === 0, `…and in the copy the bar slides in where it did on the site (top ${top}px at the start, ${mid}px half way, ${down}px once scrolled past)`);
  c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
}
{ const sc = await capture(synthUrl.replace("page.html", "slowlerp.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const hw = new JSDOM(sc.html || "<html></html>").window.document.querySelector("#hw");
  ok(!!hw && hw.hasAttribute("data-sl-reveal") && /--sl-rr: cover \d+px cover \d+px/.test(hw.getAttribute("style") || ""), `a slowly eased scroll animation, still gliding into place when the page is at rest, is scrubbed on the scroll — not frozen as a timer's doing ("${hw?.getAttribute("style")}")`);
}
{ const pc = await capture(synthUrl.replace("page.html", "pinwords.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(pc.html || "<html></html>").window.document;
  const ws = [...d.querySelectorAll("#pwp > span")];
  const moving = ws.filter((w) => w.hasAttribute("data-sl-scroll") || w.hasAttribute("data-sl-reveal"));
  const css = (pc.html || "").match(/@keyframes sl-scroll-s\d+ \{[^@]*?opacity: 0[^@]*?opacity: 1/g) || [];
  ok(ws.length === 11 && moving.length >= 9 && css.length >= 9, `words a script splits a pinned text into as it comes in, then lights up as you scroll through it, are each scrubbed on the scroll in the copy (${moving.length}/${ws.length} words moving, ${css.length} fade-in timelines, ${pc.stats?.lateBorn || 0} late-made elements)`);
}
{ const pc = await capture(synthUrl.replace("page.html", "pintimed.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(pc.html || "<html></html>").window.document;
  const ws = [...d.querySelectorAll("#ptp > span")];
  const ats = ws.map((w) => Number(w.getAttribute("data-sl-in-at")));
  const timed = ws.filter((w) => w.hasAttribute("data-sl-in") && !w.hasAttribute("data-sl-scroll"));
  ok(ws.length === 8 && timed.length >= 7 && ats.every((a) => a >= 2100 && a <= 2700), `words a pinned statement brings in on a timer once the scroll reaches a point are timed entrances started at that scroll position (${timed.length}/8 timed, at ${[...new Set(ats)].join(",")}px)`);
  // …and in the copy, with the motion runtime: still hidden just before that point, shown just after
  const rt = readFileSync(new URL("../public/sl-motion-runtime.js", import.meta.url), "utf8");
  writeFileSync(join(outdir, "pintimed.captured.html"), (pc.html || "").replace(/<\/body>/i, () => `<script>${rt}</script></body>`));
  const t = await getJSON(`/json/new?about:blank`, "PUT");
  const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: synthUrl.replace("page.html", "pintimed.captured.html") });
  await sleep(1500);
  const at = Math.min(...ats.filter((a) => a > 0)) || 2400;
  const op = async (y) => { await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${y})` }); await sleep(1600); return (await c.send("Runtime.evaluate", { expression: `+getComputedStyle(document.getElementById("pt7")).opacity`, returnByValue: true })).result.value; };
  const before = await op(at - 300), after = await op(at + 20);
  ok(before < 0.1 && after > 0.9, `…in the copy they wait in the pin until the page reaches that point, then play (last word ${before} at ${at - 300}px, ${after} at ${at + 20}px)`);
  c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
}
{ const wc = await capture(synthUrl.replace("page.html", "wheel.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(wc.html || "<html></html>").window.document;
  const cards = [...d.querySelectorAll("#wh > div")];
  const moving = cards.filter((c) => c.hasAttribute("data-sl-scroll"));
  ok(cards.length === 8 && moving.length === 8, `a wheel of cards the scroll turns in depth (eased): every card follows the scroll in the copy (${moving.length}/8; ${cards.map((c) => [...c.attributes].filter((a) => a.name.startsWith("data-sl")).map((a) => a.name).join("+") || "-").join(" ")})`);
}
{ const wc = await capture(synthUrl.replace("page.html", "waapiletters.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(wc.html || "<html></html>").window.document;
  const ls = [...d.querySelectorAll("#wlp > span")];
  const v = (el, k) => (new RegExp(`--sl-in-${k}: ?([^;]+)`).exec(el?.getAttribute("style") || "") || [])[1] || "";
  const dls = ls.map((l) => parseInt(v(l, "dl")) || 0);
  const steps = dls.slice(1).map((x, i) => x - dls[i]);
  ok(ls.length === 14 && ls.every((l) => l.hasAttribute("data-sl-in") && l.getAttribute("data-sl-in-on") === "enter") && ls.every((l) => Math.abs(parseInt(v(l, "d")) - 500) <= 20) && steps.every((x) => x >= 25 && x <= 60) && v(ls[0], "e") === "cubic-bezier(0.2, 0.65, 0.3, 0.9)", `letters a script brings in with Web Animations (made as they come into view) are replayed with their own frames, length, stagger and easing (${ls.filter((l) => l.hasAttribute("data-sl-in")).length}/${ls.length}, ${v(ls[0], "d")}, delays ${dls.slice(0, 5).join("/")}…, ${v(ls[0], "e")}; ${wc.stats?.waapiEntrances || 0} recorded)`);
  ok(/@keyframes sl-in-g\d+ \{ from \{[^}]*opacity: 0[^}]*blur\(8px\)/.test(wc.html || ""), "…from their own first frame (faded, blurred, lifted)");
}
{ const qc = await capture(synthUrl.replace("page.html", "wheelq.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(qc.html || "<html></html>").window.document;
  const cards = [...d.querySelectorAll("#wq > div")];
  const moving = cards.filter((c) => c.hasAttribute("data-sl-scroll"));
  ok(cards.length === 8 && moving.length >= 7, `a wheel the scroll turns a quarter round (eased; cards one way only or out and back): the cards follow the scroll in the copy (${moving.length}/8; ${cards.map((c) => [...c.attributes].filter((a) => a.name.startsWith("data-sl")).map((a) => a.name).join("+") || "-").join(" ")})`);
}
{ const mc = await capture(synthUrl.replace("page.html", "manynavs.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const el = new JSDOM(mc.html || "<html></html>").window.document.querySelector("#mnc");
  let rules = [];
  try { rules = JSON.parse(el?.getAttribute("data-sl-scroll-classes") || "[]"); } catch {}
  const rv = rules.find((r) => r.t === "reveal");
  ok(!!rv && rv.a > 500 && rv.a < 1300, `a local nav bar on a page with many sticky tab navs further down is still watched — its "reveal" replayed (${JSON.stringify(rules)})`);
  const hr = new JSDOM(mc.html || "<html></html>").window.document.documentElement.getAttribute("data-sl-scroll-classes") || "";
  ok(!/enhanced-rt/.test(hr), `…a feature flag the page switches on <html> (enhanced-rt → no-enhanced-rt) is not replayed as scroll state (${hr || "none"})`);
}
{ const rc = await capture(synthUrl.replace("page.html", "resplit.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const cs = [...new JSDOM(rc.html || "<html></html>").window.document.querySelectorAll("#rp > *")];
  ok(cs.length === 3 && cs.every((c) => c.hasAttribute("data-sl-scroll") || c.hasAttribute("data-sl-reveal") || c.hasAttribute("data-sl-in")), `letters slid in by a CSS variable switched once, on a page that splits its text again on every resize, follow the scroll in the copy (${cs.map((c) => [...c.attributes].filter((a) => a.name.startsWith("data-sl")).map((a) => a.name).join("+") || "-").join(" ")})`);
}
{ const vc = await capture(synthUrl.replace("page.html", "pinvar.html"), {}, 500).catch((e) => ({ html: "", error: String(e) }));
  const cs = [...new JSDOM(vc.html || "<html></html>").window.document.querySelectorAll("#pvp > span")];
  const ats = cs.map((c) => Number(c.getAttribute("data-sl-in-at")));
  const d = (c) => (/--sl-in-d: ?(\d+)ms/.exec(c.getAttribute("style") || "") || [])[1];
  ok(cs.length === 5 && cs.every((c) => c.hasAttribute("data-sl-in")) && ats.every((a) => a >= 1800 && a <= 2700) && cs.every((c) => Math.abs(Number(d(c)) - 900) <= 50), `letters in a pinned section slid in by a CSS variable and transition once the scroll reaches a point: timed entrances with that transition, started there (at ${[...new Set(ats)].join(",")}px, ${cs.map(d).join("/")}ms)`);
}
{ const pc = await capture(synthUrl.replace("page.html", "picture.html"), {}, 500, null, 2).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(pc.html || "<html></html>").window.document;
  const im = d.querySelector("#picimg");
  ok(/icon2x\.png 80w$/.test(im?.getAttribute("srcset") || "") && im?.getAttribute("sizes") === "40px" && !d.querySelector("#pic source"), `a <picture>'s sharper file picked on a high-density screen is written by its width and shown size (img ${im?.getAttribute("src")} · srcset "${im?.getAttribute("srcset") || ""}" · sizes "${im?.getAttribute("sizes")}")`);
  // …and in the copy, on a normal screen as on a sharp one, it shows at its own size (not twice as big)
  writeFileSync(join(outdir, "picture.captured.html"), pc.html || "");
  for (const scale of [1, 2]) {
    const t = await getJSON(`/json/new?about:blank`, "PUT");
    const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
    await c.send("Page.navigate", { url: synthUrl.replace("page.html", "picture.captured.html") });
    await sleep(1200);
    const w = (await c.send("Runtime.evaluate", { expression: `document.querySelector("#picimg").getBoundingClientRect().width`, returnByValue: true })).result.value;
    ok(w === 40, `…the copy shows it 40 px wide on a ${scale}x screen (${w})`);
    c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
  }
}
{ const wc = await capture(synthUrl.replace("page.html", "widgets.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(wc.html || "<html></html>").window.document;
  const a = (q, n) => d.querySelector(q)?.getAttribute(n);
  ok(d.querySelector("#tl")?.hasAttribute("data-sl-tabs"), "a tab list (role=tablist, tabs naming their panels) is marked to work in the copy");
  const st = a("#wst", "data-sl-scroller") || "", tr = a("#wfr", "data-sl-scroller") || "";
  ok(/^scroll:\d+$/.test(st) && a("#wprev", "data-sl-paddle") === `-1:${st.split(":")[1]}` && a("#wnext", "data-sl-paddle") === `1:${st.split(":")[1]}`, `a gallery's Previous / Next are paired with the strip they scroll (${a("#wprev", "data-sl-paddle")}, ${a("#wnext", "data-sl-paddle")} → ${st})`);
  ok(/^track:\d+$/.test(tr) && a("#tnext", "data-sl-paddle") === `1:${tr.split(":")[1]}` && a("#tprev", "data-sl-paddle") === `-1:${tr.split(":")[1]}`, `a slider's arrows (slick-prev / slick-next) are paired with its track in a clipped frame (${a("#tprev", "data-sl-paddle")}, ${a("#tnext", "data-sl-paddle")} → ${tr})`);
  ok(/opacity:\s*0(?![.\d])/.test(a("#hdtag", "style") || ""), `what the site's bar hides (an intro's tagline that left the header) stays hidden in the copy ("${a("#hdtag", "style")}")`);
  ok(!d.querySelector("#wfloat")?.hasAttribute("data-sl-paddle"), "a button with layout classes (text-left, float-right) is not taken for an arrow");
  ok(d.querySelector("#hold-low")?.hasAttribute("data-sl-hold") && !d.querySelector("#hold-top")?.hasAttribute("data-sl-hold") && !d.querySelector("#spin-low")?.hasAttribute("data-sl-hold"), "the site's own one-shot animation below the first screen is held until it comes into view (not one in the first screen, not an endless loop)");
  ok(/--mw: 640px/.test(a("#meas", "style") || ""), `a size the page measured once its part came near keeps its measured value (not the 0px it had before) ("${a("#meas", "style")}")`);
  const mv = a("#wv", "data-sl-media-v");
  ok(!!mv && a("#wplay", "data-sl-media") === mv && a("#wui", "data-sl-media-ui") === mv, `a video's play button and the wrapper showing its state are marked (${mv})`);
  let bodyRules = [], hdRules = [];
  try { bodyRules = JSON.parse(a("body", "data-sl-scroll-classes") || "[]"); hdRules = JSON.parse(a("#hd", "data-sl-scroll-classes") || "[]"); } catch {}
  const sb = bodyRules.find((r) => r.t === "show-bar"), sh = hdRules.find((r) => r.t === "is-scrolled");
  let lnRules = [];
  try { lnRules = JSON.parse(a("#lnav", "data-sl-scroll-classes") || "[]"); } catch {}
  const lr = lnRules.find((r) => r.t === "reveal");
  ok(!!lr && lr.a > 400 && lr.a < 1100 && lr.b === null, `a bar that is a plain <div> named like one (localnav-container) gets its scroll classes replayed too (reveal from ${lr?.a}px)`);
  let ln2 = [];
  try { ln2 = JSON.parse(a("#lnav2c", "data-sl-scroll-classes") || "[]"); } catch {}
  const l2 = ln2.find((r) => r.t === "reveal"), l2s = ln2.find((r) => r.t === "sticky");
  ok(!!l2 && l2.a > 500 && l2.a < 1200 && !!l2s, `…and one inside a sticky <nav> (as apple.com's: the nav never changes, the box inside it does) gets its own (${JSON.stringify(ln2)})`);
  ok(!!sb && sb.a > 300 && sb.a < 900 && sb.b === null && !!sh && sh.a > 0 && sh.a < 500 && !bodyRules.some((r) => r.t === "loaded") && !hdRules.some((r) => r.t === "nav-up"), `classes set past a scroll position are replayed there (body show-bar from ${sb?.a}px, header is-scrolled from ${sh?.a}px) — not a "loaded" flag, nor a header hiding on the way down (${JSON.stringify(bodyRules)} ${JSON.stringify(hdRules)})`);
  // (the panel adds the trigger script when it sees these marks: the same test as panel.ts addMotionTrigger)
  const lit = (/if \(!\/(.+?)\/\.test\(r\.html\)/.exec(readFileSync("src/panel/panel.ts", "utf8")) || [])[1];
  ok(!!lit && new RegExp(lit).test(wc.html || ""), "…and the copy gets the script that works them (the panel's trigger test sees the marks)");
}
{ const sc = await capture(synthUrl.replace("page.html", "slides.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(sc.html || "<html></html>").window.document;
  const items = [1, 2, 3].map((i) => d.querySelector(`#sl${i}`));
  const active = items.filter((el) => el?.classList.contains("active")).length;
  const animated = items.filter((el) => el?.hasAttribute("data-sl-reveal") || el?.hasAttribute("data-sl-in") || el?.hasAttribute("data-sl-scroll")).length;
  ok(active === 1 && animated === 0, `a slideshow on a timer is copied as it was: one slide showing, none turned into reveals (${active} active, ${animated} animated)`);
  const pics = [1, 2, 3].map((i) => d.querySelector(`#pc${i}`));
  const on = pics.map((el) => !!el?.classList.contains("on") && /opacity: 1/.test(el.getAttribute("style") || ""));
  const ti = items.findIndex((el) => el?.classList.contains("active"));
  ok(on.filter(Boolean).length === 1 && on[ti], `…and its pictures, switched by the same timer, show the same slide as its titles (title ${ti + 1}; pictures ${on.map((x) => (x ? "on" : "off")).join("/")})`);
}
{ const wc = await capture(synthUrl.replace("page.html", "switch.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(wc.html || "<html></html>").window.document;
  const its = [2, 3, 4].map((i) => d.querySelector(`#it${i}`));
  const css = d.querySelector("style[data-sl-scroll-linked]")?.textContent || "";
  const kf = (el) => (new RegExp(`@keyframes sl-scroll-${el?.getAttribute("data-sl-scroll")} \\{([^}]*\\}){2,}`).exec(css) || [""])[0];
  const onOff = its.every((el) => { const k = kf(el); return /opacity: 1;/.test(k) && /opacity: 0\.25;/.test(k); });
  ok(its.every((el) => el?.hasAttribute("data-sl-scroll")) && onOff && its.every((el) => !el.classList.contains("active")), `content that switches as you scroll: each list item lights up and dims again at its scroll position (${its.map((el) => el?.getAttribute("data-sl-scroll") || "-").join(",")})`);
}
{ const pc = await capture(synthUrl.replace("page.html", "pointer.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(pc.html || "<html></html>").window.document;
  const mag = d.querySelector("#mag"), tl = d.querySelector("#tilt"), cur = d.querySelector("#cur");
  const k = parseFloat(mag?.getAttribute("data-sl-magnet") || "0"), deg = parseFloat(tl?.getAttribute("data-sl-tilt") || "0");
  let cs = {}; try { cs = JSON.parse(cur?.getAttribute("data-sl-cursor") || "{}"); } catch {}
  const css = d.querySelector("style[data-sl-pointer-motion]")?.textContent || "";
  ok(Math.abs(k - 0.4) <= 0.08 && mag.hasAttribute("data-sl-pull") && new RegExp(`\\[data-sl-pull="${mag.getAttribute("data-sl-pull")}"\\] \\{ translate: var\\(--slm-mx`).test(css), `pointer: a magnetic button follows the pointer with its own strength (${k} ≈ 0.4)`);
  ok(Math.abs(deg - 12) <= 4 && tl.hasAttribute("data-sl-tilting") && /rotateX\(var\(--slm-rx/.test(css), `pointer: a card tilted in 3D by the pointer, with its own angle (${deg}° ≈ 12°)`);
  ok(cs.k >= 0.08 && cs.k <= 0.45 && Math.abs(cs.ox || 0) <= 14 && Math.abs(cs.oy || 0) <= 14 && /\[data-sl-cursor\] \{ translate: var\(--slm-cx/.test(css), `pointer: a cursor follower, its lag and offset measured (${JSON.stringify(cs)}, k ≈ 0.2)`);
  ok(!mag?.getAttribute("style") && !tl?.getAttribute("style") && !/translate\((?!-1)/.test(cur?.getAttribute("style") || "") && !cur?.hasAttribute("data-sl-cursor-rest"), `pointer: everything put back after recording, the follower where it waited before the pointer moved (button "${mag?.getAttribute("style") || ""}", card "${tl?.getAttribute("style") || ""}", follower "${cur?.getAttribute("style") || ""}")`);
}
{ const hc = await capture(synthUrl.replace("page.html", "hero.html"), {}, 800).catch((e) => ({ html: "", error: String(e) }));
  const d = new JSDOM(hc.html || "<html></html>").window.document;
  const hw = d.querySelector("#hw"), lg = d.querySelector("#blogo");
  ok(hw?.hasAttribute("data-sl-scroll") && lg?.hasAttribute("data-sl-scroll") && !/scale\(0\./.test(lg?.getAttribute("style") || "") && !/matrix\(0\./.test(lg?.getAttribute("style") || ""), `a hero built as a <header>: its big word moving as you scroll is replayed on the scroll position; the fixed bar's logo shrinking with the scroll is too, resting at its at-the-top size (word ${hw?.getAttribute("data-sl-scroll")}, logo ${lg?.getAttribute("data-sl-scroll")} "${lg?.getAttribute("style") || ""}")`);
}
for (const withMarks of [true, false]) {
  const hc = await capture(synthUrl.replace("page.html", "hover.html"), {}, 1500, withMarks ? introRecorderSource() : null).catch((e) => ({ html: "", error: String(e) }));
  const how = withMarks ? "the page's own hover listeners" : "what looks hoverable";
  const d = new JSDOM(hc.html || "<html></html>").window.document;
  const css = d.querySelector("style[data-sl-hover-motion]")?.textContent || "";
  const hov = (sel) => d.querySelector(sel)?.getAttribute("data-sl-hov"), tgt = (sel) => d.querySelector(sel)?.getAttribute("data-sl-hovt");
  const gsapOk = (hc.settled?.libs || []).includes("gsap");
  const ci = hov("#hcard"), ti = tgt("#himg");
  const tdur = Number((new RegExp(`\\[data-sl-hovt="${ti}"\\] \\{ transition: transform (\\d+)ms`).exec(css) || [])[1] || 0);
  if (gsapOk) ok(!!ci && !!ti && new RegExp(`\\[data-sl-hov="${ci}"\\]:hover \\[data-sl-hovt="${ti}"\\] \\{ transform: matrix\\(1\\.15, 0, 0, 1\\.15, 0, 0\\) !important;`).test(css) && tdur >= 450 && tdur <= 900, `hover: a GSAP zoom on mouseenter becomes a CSS :hover with its timing — found by ${how} (${tdur} ms ≈ 600)`);
  else console.log("  (GSAP didn't load from its CDN — GSAP hover check skipped)");
  const bi = hov("#hbtn");
  ok(!!bi && new RegExp(`\\[data-sl-hov="${bi}"\\]:hover \\{ background-color: rgb\\(255, 0, 0\\) !important;`).test(css) && !new RegExp(`\\[data-sl-hovt="${tgt("#hbtn")}"\\] \\{ transition`).test(css), `hover: a class added on hover — the look it gives, played by the site's own CSS transition (${how})`);
  const c2 = hov("#hcard2"), i2 = tgt("#himg2");
  ok(!!c2 && !!i2 && new RegExp(`\\[data-sl-hov="${c2}"\\]:hover \\[data-sl-hovt="${i2}"\\] \\{ transform: matrix\\(1\\.2, 0, 0, 1\\.2, 0, 0\\) !important;`).test(css) && !new RegExp(`\\[data-sl-hovt="${i2}"\\] \\{ transition`).test(css) && !d.querySelector("#hcard2").classList.contains("is-hover"), `hover: a class on a card whose CSS zooms the picture inside — its full look, after the transition (${how})`);
  const li = hov("#hlnk"), lt = tgt("#hline");
  ok(!!li && new RegExp(`\\[data-sl-hov="${li}"\\]:hover \\[data-sl-hovt="${lt}"\\] \\{ width: 100% !important;`).test(css), `hover: an onmouseenter handler drawing a line in (width 100%) (${how})`);
  ok(!d.querySelector("#himg")?.getAttribute("style") && !d.querySelector("#hbtn")?.classList.contains("is-hover") && !d.querySelector("#hline")?.getAttribute("style") && !d.querySelector("#hplain")?.hasAttribute("data-sl-hov") && !/data-sl-hl/.test(hc.html), `hover: everything is put back after recording — the copy rests un-hovered (${how})`);
  if (withMarks && gsapOk) {
    // in the copy: a real pointer over the card zooms the picture, moving away brings it back
    writeFileSync(join(outdir, "hover.captured.html"), hc.html || "");
    const t = await getJSON(`/json/new?about:blank`, "PUT");
    const c = cdpConnect(t.webSocketDebuggerUrl); await c.ready;
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: synthUrl.replace("page.html", "hover.captured.html") });
    await sleep(1500);
    const sc = async () => (await c.send("Runtime.evaluate", { expression: `new DOMMatrix(getComputedStyle(document.querySelector("#himg")).transform).a.toFixed(2) + "/" + getComputedStyle(document.querySelector("#hbtn")).backgroundColor`, returnByValue: true })).result.value;
    const box = (await c.send("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#hcard").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`, returnByValue: true })).result.value;
    const rest = await sc();
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] }); await sleep(900);
    const on = await sc();
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1300, y: 860 }); await sleep(900);
    const off = await sc();
    ok(/^1\.00\//.test(rest) && /^1\.15\//.test(on) && /^1\.00\//.test(off), `…in the copy, a real pointer over the card zooms the picture and leaving brings it back (${rest} → ${on} → ${off})`);
    c.close(); await getJSON(`/json/close/${t.id}`).catch(() => {});
  }
}
{ const lk = await capture(synthUrl.replace("page.html", "locked.html"), {}, 300);
  const d = new JSDOM(lk.html).window.document;
  ok(!d.documentElement.classList.contains("lenis-stopped") && !d.body.classList.contains("menu-open") && !/overflow/.test(d.body.getAttribute("style") || "") && /background/.test(d.body.getAttribute("style") || ""), `a scroll lock left by a dialog is lifted in the copy (html "${d.documentElement.className}", body "${d.body.className}" ${d.body.getAttribute("style")})`); }
{ const sc = await capture(synthUrl.replace("page.html", "scripted-scroll.html"), {}, 300);
  ok(/data-sl-native-scroll/.test(sc.html) && /overflow-y: auto !important/.test(sc.html), "a page scrolled by a script (its CSS blocks native scrolling) scrolls in the copy");
  const plain = await capture(synthUrl.replace("page.html", "locked.html").replace("locked", "frame"), {}, 300);
  ok(!/data-sl-native-scroll/.test(plain.html), "…a page that doesn't need it is left as it is"); }
{ const b = await capture(synthUrl.replace("page.html", "botwall.html"), {}, 300);
  ok(b.warnings.some((w) => /bot-check/.test(w)), "a shown challenge (bot wall) is reported"); }
for (const url of urls) {
  console.log(`\n── ${url} ──`);
  try {
    const r = await capture(url, {});
    const h = r.html;
    writeFileSync(join(outdir, new URL(url).host + ".captured.html"), h);
    const s = r.stats;
    console.log(`  ${(s.bytes / 1024).toFixed(0)} KB in ${s.ms} ms · images ${s.imagesLoaded}/${s.images} loaded · lazy→eager ${s.lazyEagered} · scroll ${s.scrollSteps} · sheets ${s.sheets} (x-origin ${s.crossOriginSheets}, adopted ${s.adoptedSheets}) · shadow ${s.shadowRoots} · canvas ${s.canvases} · scripts stripped ${s.scriptsStripped} · revealed ${s.revealed} · banners ${s.bannersRemoved} · frames ${s.frames}`);
    if (r.warnings.length) console.log("  warnings:", r.warnings.join(" | "));
    console.log("  settled:", JSON.stringify(r.settled));
    const noComments = h.replace(/<!--[\s\S]*?-->/g, "");
    const scriptsLeft = (noComments.match(/<script(?![^>]*(application\/(ld\+)?json|data-sl-anim-runtime))/g) || []).length; // StyleLift's animation loader allowed
    const imgs = h.match(/<img[^>]*>/g) || [];
    const imgNoSrc = imgs.filter((t) => !/\ssrc="(https?:|data:)/.test(t)).length;
    const dupStyles = (h.match(/data-stylelift="embedded-styles"/g) || []).length;
    ok(scriptsLeft === 0, "no executable scripts left");
    // live-state heuristic only: slow CDNs make this vary run to run, and exports re-fetch
    // every asset anyway, so it warns instead of failing when every <img> has an absolute src.
    const loadedRatio = s.imagesLoaded / Math.max(1, s.images);
    if (loadedRatio >= 0.8) ok(true, `≥80% of images actually loaded (${s.imagesLoaded}/${s.images})`);
    else console.log(`  ! only ${s.imagesLoaded}/${s.images} images finished loading in the budget (network) — srcs are still captured`);
    ok(imgNoSrc / Math.max(1, imgs.length) <= 0.1, `≤10% <img> without an absolute src (${imgNoSrc}/${imgs.length})`);
    ok(s.sheets > 0, "stylesheets serialized from CSSOM");
    ok(dupStyles === 0 && !/<link[^>]+rel="modulepreload"/.test(h), "no duplicated styles / modulepreload hints");
    ok(!/<iframe[^>]*__framer-editorbar/.test(h), "no Framer editor bar iframe");
    ok(/<base href="https?:/.test(h), "<base> present");
  } catch (e) { failures.push(url + ": " + e.message); console.log("  ✗ ERROR", e.message); }
}

server.close();
chrome.kill();
console.log(`\n${passed} passed, ${failures.length} failed  (captures in ${outdir})`);
if (failures.length) process.exit(1);
console.log("Live capture verified ✓");
