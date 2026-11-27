// Export to Figma — accuracy. Each test page is screenshotted, measured as Figma layers (the shipped walker), drawn
// back from those layers the way Figma will draw them (Auto Layout frames by their own rules), screenshotted again,
// and the two compared pixel by pixel: overall, and on the "ink" (every pixel that isn't page background in either).
// Plus checks on what the layers say (Auto Layout found, text runs, pictures, vectors, effects).
//   node scripts/verify-figma.mjs [url …] [--out dir]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const urls = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-figma-"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failures.push(m); console.log("  ✗ " + m); } };

// the shipped code, bundled
const bdir = mkdtempSync(join(tmpdir(), "sl-figma-b-"));
await build({ entryPoints: { snap: "src/extractor/figma-snapshot.ts", render: "src/shared/figma-render.ts" }, outdir: bdir, bundle: true, format: "esm", platform: "neutral", target: "es2021", logLevel: "silent" });
const { figmaSnapshot } = await import(pathToFileURL(join(bdir, "snap.js")));
const { renderFigmaHtml } = await import(pathToFileURL(join(bdir, "render.js")));
// …and the plugin for Figma, as shipped, run against a stand-in for Figma's API (scripts/figma-emulator.js)
const plugin = await build({ entryPoints: ["figma-plugin/src/code.ts"], bundle: true, format: "iife", target: "es2017", write: false, logLevel: "silent" });
// …and the extension's own packing of the pictures (PNG / JPEG / GIF, at most 4096 px), as the bundle gets them
const prep = await build({ stdin: { contents: `import { forFigma } from "./src/panel/figma-export.ts"; window.slPrepare = forFigma;`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "iife", target: "es2021", write: false, logLevel: "silent" });

// ── test pages ───────────────────────────────────────────────────────────────
const png = (w, h, f) => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set(f(x, y), y * (w * 3 + 1) + 1 + x * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const files = new Map();
files.set("/photo.png", png(320, 200, (x, y) => [Math.round((x / 320) * 220), Math.round((y / 200) * 180) + 40, 160]));
files.set("/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect x="2" y="2" width="36" height="36" rx="10" fill="#6a5cff"/><path d="M50 30V10h8a6 6 0 0 1 0 12h-8" fill="none" stroke="#1d2433" stroke-width="4"/><circle cx="96" cy="20" r="14" fill="#ffcf3f" onclick="alert(1)"/><script>alert(1)</script></svg>`);
files.set("/tile.png", png(16, 16, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [230, 230, 240] : [200, 205, 225]));
// --web-fonts: the pages in Google Fonts (Inter, Lora) — what a cloud Figma has too, for a check in real Figma
const WEB_FONTS = args.includes("--web-fonts");
const css = WEB_FONTS
  ? `@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,700;1,400&family=Lora:ital@0;1&display=block'); body{margin:0;font-family:Inter,sans-serif;color:#1d2433;background:#f6f7fb} *{box-sizing:border-box}`
  : `body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1d2433;background:#f6f7fb} *{box-sizing:border-box}`;
// (the tiled card has no border: CSS tiles from inside the border, Figma from the layer's corner and can't shift a
// tile — a bordered tiled box is a pixel off in Figma, a limit of Figma, not of the measuring)
files.set("/cards.html", `<!doctype html><html><head><style>${css}
.wrap{padding:40px;display:flex;gap:24px;align-items:flex-start}
.card{width:300px;background:#fff;border:1px solid #dfe3ee;border-radius:16px;box-shadow:0 6px 18px rgba(20,30,60,.12);overflow:hidden}
.card .top{height:120px;background:linear-gradient(135deg,#6a5cff,#33c3ff)}
.card .body{padding:20px;display:flex;flex-direction:column;gap:10px}
.card h3{margin:0;font-size:20px;line-height:26px}
.card p{margin:0;font-size:14px;line-height:21px;color:#545e73}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:999px;background:#1d2433;color:#fff;font-size:14px;font-weight:700;align-self:flex-start}
.pic{width:100%;height:120px;object-fit:cover;display:block}
.row{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#eef1f8}
</style></head><body><div class="wrap">
<div class="card"><div class="top"></div><div class="body"><h3>Gradient card</h3><p>Some <b>bold</b> and <a href="#">linked</a> words, then <em>italic</em> ones.</p><span class="btn">Get started</span></div></div>
<div class="card"><img class="pic" src="photo.png" alt=""><div class="body"><h3>Picture card</h3><p>A picture filling its box (cover), with rounded corners from the card.</p></div><div class="row"><span>Left</span><span>Right</span></div></div>
<div class="card" style="background:url(tile.png) repeat;border:none"><div class="body"><h3>Tiled</h3><p>A repeating picture behind the text.</p></div></div>
</div></body></html>`);
files.set("/type.html", `<!doctype html><html><head><style>${css}
section{padding:48px 80px;max-width:1100px}
h1{font-size:56px;line-height:60px;letter-spacing:-1.5px;margin:0 0 16px}
.eyebrow{text-transform:uppercase;letter-spacing:3px;font-size:12px;font-weight:700;color:#6a5cff}
.center{text-align:center;font-size:18px;line-height:28px;margin:24px 0}
.grad{font-size:44px;font-weight:700;background:linear-gradient(90deg,#ff5f6d,#ffc371);-webkit-background-clip:text;background-clip:text;color:transparent;margin:0}
.serif{font-family:${WEB_FONTS ? "Lora" : "Georgia"},serif;font-style:italic;font-size:22px}
.under{text-decoration:underline}
</style></head><body><section>
<div class="eyebrow">New release</div>
<h1>Typography that<br>lands exactly</h1>
<p class="center">Centred copy that wraps over more than one line, so the width the text layer gets matters: too narrow and Figma would wrap it differently from the page.</p>
<p class="grad">Gradient headline</p>
<p class="serif">A serif line in italics, with an <span class="under">underlined phrase</span> inside.</p>
</section></body></html>`);
files.set("/deco.html", `<!doctype html><html><head><style>${css}
.stage{position:relative;height:420px;margin:40px;background:#fff;border-radius:20px;overflow:hidden;border:2px dashed #c9cfdf}
.badge{position:absolute;left:60px;top:50px;width:160px;height:56px;background:#ffcf3f;border-radius:12px;transform:rotate(-8deg);display:flex;align-items:center;justify-content:center;font-weight:700}
.ghost{position:absolute;left:260px;top:40px;width:200px;height:140px;background:#33c3ff;opacity:.45;border-radius:24px}
.over{position:absolute;left:340px;top:90px;width:200px;height:140px;background:#6a5cff;border-radius:24px;z-index:2;box-shadow:inset 0 0 0 6px rgba(255,255,255,.5)}
.under2{position:absolute;left:300px;top:120px;width:200px;height:140px;background:#ff5f6d;border-radius:24px;z-index:1}
.clip{position:absolute;left:600px;top:40px;width:180px;height:180px;border-radius:50%;overflow:hidden}
.clip img{width:320px;height:200px;display:block}
.icons{position:absolute;left:60px;top:260px;display:flex;gap:18px;color:#e2366b}
.field{position:absolute;left:60px;top:330px;width:320px;height:44px;border:1px solid #c9cfdf;border-radius:8px;padding:0 14px;font-size:15px;background:#fbfcff}
.anchored{position:absolute;left:820px;top:40px;width:140px;height:180px;object-fit:cover;object-position:0% 0%;display:block}
.stretched{position:absolute;left:990px;top:40px;width:260px;height:90px;display:block}
.logo{position:absolute;left:600px;top:300px;width:180px;height:60px}
.quote{position:absolute;left:820px;top:300px;font-size:20px;margin:0}
.quote::before{content:"\\201C";font-size:44px;line-height:20px;color:#e2366b;vertical-align:-14px;margin-right:4px}
.quote span{position:relative}
.quote span::after{content:"";position:absolute;left:0;right:0;bottom:-6px;height:3px;background:#6a5cff;border-radius:2px}
.shade{position:absolute;left:820px;top:350px;width:240px;height:60px;background:#33c3ff;color:#fff;font-weight:700;padding:10px}
.shade::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.55))}
.topbg{position:absolute;left:990px;top:160px;width:260px;height:120px;background:url(photo.png) right bottom/cover no-repeat}
</style></head><body><div class="stage">
<div class="badge">Rotated</div><div class="ghost"></div><div class="over"></div><div class="under2"></div>
<div class="clip"><img src="photo.png" alt=""></div>
<div class="icons"><svg width="32" height="32" viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" fill="currentColor"/></svg><svg width="32" height="32" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5"/></svg></div>
<input class="field" placeholder="Your email address">
<img class="anchored" src="photo.png" alt=""><img class="stretched" src="photo.png" alt=""><div class="topbg"></div><img class="logo" src="logo.svg" alt=""><p class="quote">Quoted, <span>underlined</span></p><div class="shade">Under a shade</div>
</div></body></html>`);
files.set("/plugin/code.js", plugin.outputFiles[0].text);
files.set("/prepare.js", prep.outputFiles[0].text);
files.set("/figma-emulator.js", readFileSync("scripts/figma-emulator.js", "utf8"));
files.set("/plugin.html", `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style><script src="/figma-emulator.js"></script><script src="/prepare.js"></script></head><body></body></html>`);
const T = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf" };
const srv = createServer((q, res) => {
  const p = decodeURIComponent((q.url || "/").split("?")[0]);
  const f = files.get(p);
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": T[extname(p)] || "application/octet-stream" });
  res.end(f);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const local = (p) => `http://127.0.0.1:${srv.address().port}${p}`;

// ── browser ──────────────────────────────────────────────────────────────────
const prof = mkdtempSync(join(tmpdir(), "sl-figma-p-"));
const port = 9820 + Math.floor(Math.random() * 40);
const ch = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1440,900", "--hide-scrollbars", "--mute-audio", "about:blank"]);
const finish = (code) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); rmSync(bdir, { recursive: true, force: true }); process.exit(code); }, 300); };
setTimeout(() => { console.log("✗ timed out"); finish(2); }, 15 * 60000);
// a crash must not leave its browser running (a page with WebGL in a forgotten headless Chrome burns CPU for hours)
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.log(`✗ stopped: ${e && e.message ? e.message : e}`); finish(2); });
for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
async function openTab(url, wait = 1500, height = 900, media = null) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
  if (media) await send("Emulation.setEmulatedMedia", { features: media });
  await send("Page.navigate", { url });
  await sleep(wait);
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
  const shot = async (h) => (await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1440, height: h, scale: 1 }, captureBeyondViewport: true })).result.data;
  return { ev, shot, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
async function diff(a, b) {
  files.set("/diff.html", `<!doctype html><canvas id=x></canvas><script>
    window.result = (async () => {
      const load = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + d; });
      const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      const cv = document.getElementById("x"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0); const A = ctx.getImageData(0, 0, w, h).data;
      ctx.drawImage(ib, 0, 0); const B = ctx.getImageData(0, 0, w, h).data;
      const bg = [A[0], A[1], A[2]];
      let same = 0, total = 0, ink = 0, inkSame = 0; const out = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4; total++;
        const d = Math.max(Math.abs(A[o]-B[o]), Math.abs(A[o+1]-B[o+1]), Math.abs(A[o+2]-B[o+2]));
        const isInk = Math.max(Math.abs(A[o]-bg[0]), Math.abs(A[o+1]-bg[1]), Math.abs(A[o+2]-bg[2])) > 12 || Math.max(Math.abs(B[o]-bg[0]), Math.abs(B[o+1]-bg[1]), Math.abs(B[o+2]-bg[2])) > 12;
        if (isInk) ink++;
        if (d <= 24) { same++; if (isInk) inkSame++; out.data[o]=A[o]*0.25+190; out.data[o+1]=A[o+1]*0.25+190; out.data[o+2]=A[o+2]*0.25+190; } else { out.data[o]=220; out.data[o+1]=30; out.data[o+2]=30; }
        out.data[o+3]=255;
      }
      ctx.putImageData(out, 0, 0);
      return JSON.stringify({ pct: +(100 * same / total).toFixed(2), ink: +(100 * inkSame / Math.max(1, ink)).toFixed(2), diff: cv.toDataURL("image/jpeg", 0.7).split(",")[1] });
    })();
  </script>`);
  const t = await openTab(local("/diff.html"), 300);
  const r = JSON.parse(await t.ev("window.result"));
  await t.close();
  return r;
}

const SNAP = `(${figmaSnapshot.toString()})()`;
// the page's @font-face rules with their files served from here (no cross-origin font rules to trip over)
let fontN = 0;
async function localFonts(faces) {
  const blocks = [];
  for (const f of faces) {
    if (f.css) blocks.push({ css: f.css, base: f.base });
    else if (f.href) {
      try {
        const text = await (await fetch(f.href)).text();
        for (const m of text.match(/@font-face\s*{[^}]*}/g) || []) blocks.push({ css: m, base: f.href });
      } catch { /* a sheet that won't load */ }
    }
  }
  const out = [];
  for (const b of blocks.slice(0, 60)) {
    let css = b.css;
    for (const m of [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]) {
      try {
        const u = new URL(m[1], b.base).href;
        if (u.startsWith("data:")) continue;
        const r = await fetch(u);
        if (!r.ok) continue;
        const path = `/fonts/f${++fontN}${extname(new URL(u).pathname) || ".woff2"}`;
        files.set(path, Buffer.from(await r.arrayBuffer()));
        css = css.split(m[0]).join(`url("${path}")`);
      } catch { /* a font file that won't load */ }
    }
    out.push(css);
  }
  return out.join("\n");
}
async function measure(url, name, expect) {
  console.log(`\n▶ ${name}`);
  // a real site: as the extension measures a page for Figma — motion off (every reveal at its final look), loaded,
  // past its preloader, walked top to bottom once (lazy pictures, in-view reveals) and back at the top
  const real = !!expect;
  const page = await openTab(url, real ? 600 : 1800, 900, real ? [{ name: "prefers-reduced-motion", value: "reduce" }] : null);
  if (real) {
    for (let i = 0; i < 100; i++) { if (await page.ev("document.readyState === 'complete' && !!document.body").catch(() => false)) break; await sleep(200); }
    await sleep(5000);
    await page.ev(`(async () => { document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = "eager"; }); const H = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight); for (let y = 0; y < H() && y < 30000; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); } scrollTo(0, 0); await document.fonts.ready; await new Promise((r) => setTimeout(r, 2500)); return true; })()`).catch(() => {});
  }
  await page.ev("document.fonts.ready.then(() => true)").catch(() => {});
  const H = Math.min(4000, await page.ev("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"));
  const live = await page.shot(H);
  const snap = await page.ev(SNAP);
  // (the test draws the layers with the page's own web fonts — in Figma they're the designer's installed fonts — so
  // what's compared is where things are, not which fonts this computer has)
  const faces = await page.ev(`(() => { const out = []; for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { if (sh.href) out.push({ href: sh.href }); continue; } const base = sh.href || location.href; for (const r of rules) { if (r instanceof CSSFontFaceRule) out.push({ css: r.cssText, base }); else if (r instanceof CSSImportRule) out.push({ href: new URL(r.href, base).href }); } } return out; })()`).catch(() => []);
  await page.close();
  const fontCss = await localFonts(faces || []);
  writeFileSync(join(OUT, `${name}.figma.json`), JSON.stringify(snap, null, 1));
  // pictures: their own URLs (the plugin gets the bytes in the bundle)
  const imgUrl = new Map(snap.images.map((i) => [i.id, i.url]));
  const html = renderFigmaHtml(snap, (id) => imgUrl.get(id) || "").replace("</head>", () => `<style>${fontCss}</style></head>`);
  files.set(`/${name}.figma.html`, html);
  writeFileSync(join(OUT, `${name}.figma.html`), html);
  const back = await openTab(local(`/${name}.figma.html`), 1500, 900);
  const drawn = await back.shot(H);
  await back.close();
  const d = await diff(live, drawn);
  writeFileSync(join(OUT, `${name}.page.png`), Buffer.from(live, "base64"));
  writeFileSync(join(OUT, `${name}.figma.png`), Buffer.from(drawn, "base64"));
  writeFileSync(join(OUT, `${name}.diff.jpg`), Buffer.from(d.diff, "base64"));
  console.log(`  layers ${snap.stats.nodes} · text ${snap.stats.texts} · pictures ${snap.stats.images} · vectors ${snap.stats.svgs} · Auto Layout ${snap.stats.autoLayout} · fonts ${snap.fonts.length} · colours ${snap.colors.length}`);
  ok(d.ink >= (expect?.ink ?? 97) && d.pct >= (expect?.pct ?? 99), `${name}: drawn back from its Figma layers, it matches the page — ${d.pct}% of pixels, ${d.ink}% of the ink`);
  // the plugin builds the layers (Figma's API stood in for); they are drawn as Figma draws them
  // (the pictures as the bundle carries them: bytes, here served from this test's own address)
  const local2 = { ...snap, images: [] };
  for (const im of snap.images) {
    if (!/^https?:/.test(im.url) || im.url.startsWith(local("/"))) { local2.images.push(im); continue; }
    try {
      const r = await fetch(im.url);
      if (!r.ok) continue;
      const path = `/img/${name}-${im.id}`;
      files.set(path, Buffer.from(await r.arrayBuffer()));
      local2.images.push({ ...im, url: local(path) });
    } catch { /* a picture that won't download: left out, as the bundle would */ }
  }
  files.set(`/${name}.snap.json`, JSON.stringify(local2));
  files.set(`/${name}.plugin.html`, files.get("/plugin.html").replace("</head>", () => `<style>${fontCss}</style></head>`));
  const fp = await openTab(local(`/${name}.plugin.html`), 400, 900);
  // (the fonts the page used, as a designer's Figma would have them, plus Figma's own Inter)
  const STY = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"];
  const fams = new Set(["Inter", "Arial", "Helvetica", "Georgia", "Times New Roman", ...snap.fonts.map((f) => f.family)]);
  const fonts = [...fams].flatMap((family) => STY.flatMap((st) => [{ family, style: st }, { family, style: st === "Regular" ? "Italic" : `${st} Italic` }]));
  let built;
  try {
    built = await fp.ev(`(async () => { const s = await (await fetch(${JSON.stringify(`/${name}.snap.json`)})).json(); const r = await runPlugin(s, { fonts: ${JSON.stringify(fonts)} }); await document.fonts.ready; await new Promise((r) => setTimeout(r, 400)); return r; })()`);
  } catch (e) {
    built = { error: String(e.message || e) };
  }
  const drawnP = await fp.shot(H);
  await fp.close();
  writeFileSync(join(OUT, `${name}.plugin.png`), Buffer.from(drawnP, "base64"));
  if (built.error) { ok(false, `${name}: the plugin built its layers — it stopped: ${built.error}`); return snap; }
  const dp = await diff(live, drawnP);
  writeFileSync(join(OUT, `${name}.plugin-diff.jpg`), Buffer.from(dp.diff, "base64"));
  console.log(`  plugin: ${built.layers} layers · ${built.images} pictures · ${built.svgs} vectors · ${built.variables} colour variables · ${built.styles} text styles${built.missingFonts.length ? ` · missing fonts ${built.missingFonts.join(", ")}` : ""}`);
  ok(dp.ink >= (expect?.ink ?? 97) && dp.pct >= (expect?.pct ?? 99), `${name}: the layers the plugin builds in Figma match the page — ${dp.pct}% of pixels, ${dp.ink}% of the ink`);
  ok(built.layers >= snap.stats.nodes * 0.98 && built.rootX === 0, `${name}: every layer built (${built.layers} of ${snap.stats.nodes}), the page at the canvas's origin on an empty page`);
  return snap;
}

const all = (n, f, out = []) => { if (f(n)) out.push(n); for (const k of n.kids || []) all(k, f, out); return out; };
if (!urls.length) {
  const cards = await measure(local("/cards.html"), "cards");
  const rows = all(cards.root, (n) => n.layout && n.layout.mode === "row");
  const cols = all(cards.root, (n) => n.layout && n.layout.mode === "col");
  ok(rows.some((n) => n.layout.gap === 24 && n.kids.length === 3), `the row of three cards is an Auto Layout row with its 24 px gap (${rows.map((n) => `${n.n} gap ${n.layout.gap}`).join(", ") || "none"})`);
  ok(cols.some((n) => n.layout.gap === 10 && n.layout.pad[0] === 20), `a card's body is an Auto Layout column: 10 px gap, 20 px padding (${cols.map((n) => `${n.n} ${n.layout.gap}/${n.layout.pad.join(",")}`).join("; ") || "none"})`);
  ok(rows.some((n) => n.layout.main === "between"), "the two ends of a bar are an Auto Layout row with space between");
  const para = all(cards.root, (n) => n.t === "text" && /bold/.test(n.chars || ""))[0];
  ok(!!para && para.runs.some((r) => r.weight === 700) && para.runs.some((r) => r.link) && para.runs.some((r) => r.italic), `a paragraph is ONE text layer with its bold, linked and italic runs (${para ? para.runs.length + " runs" : "none"})`);
  ok(all(cards.root, (n) => (n.fills || []).some((f) => f.k === "linear")).length >= 1 && all(cards.root, (n) => (n.effects || []).some((e) => e.k === "drop")).length >= 3, "gradients and drop shadows are layer fills and effects");
  ok(all(cards.root, (n) => n.t === "image" && n.fit === "fill").length >= 1 && all(cards.root, (n) => (n.fills || []).some((f) => f.k === "image" && f.fit === "tile")).length === 1, "a cover picture fills its layer; a repeating background tiles");
  const type = await measure(local("/type.html"), "type");
  const t = all(type.root, (n) => n.t === "text");
  ok(t.some((n) => n.runs.some((r) => r.textCase === "upper" && r.ls === 3)), "uppercase letter-spaced text keeps its case and spacing");
  ok(t.some((n) => /lands exactly/.test(n.chars) && /\n/.test(n.chars) && n.runs[0].lh === 60 && n.runs[0].ls === -1.5), "a heading keeps its line break, line height and negative tracking");
  ok(t.some((n) => n.align === "center") && t.some((n) => n.runs.some((r) => r.fill && r.fill.k === "linear")), "centred text is centred; gradient text keeps its gradient");
  ok(t.some((n) => n.runs.some((r) => r.deco === "underline") && n.runs.some((r) => r.italic)), "an underlined phrase inside an italic line keeps both");
  const deco = await measure(local("/deco.html"), "deco");
  ok(all(deco.root, (n) => Math.abs((n.rot || 0) + 8) < 0.1).length === 1, "a rotated badge is a rotated layer");
  ok(all(deco.root, (n) => n.op && Math.abs(n.op - 0.45) < 0.01).length === 1, "a see-through layer keeps its opacity");
  ok(all(deco.root, (n) => n.t === "svg" && /fill="rgb\(226, 54, 107\)"|stroke="rgb\(226, 54, 107\)"/.test(n.svg)).length === 2, "icons are vectors in the colour the page gave them (currentColor)");
  const logo = all(deco.root, (n) => n.t === "svg" && /ffcf3f/.test(n.svg))[0];
  ok(!!logo && logo.w === 180 && /width="180"/.test(logo.svg) && !/script|onclick/i.test(logo.svg), `a logo shown as an <img> of an SVG is a vector too, at the size it's shown, with nothing that runs (${logo ? logo.w + "×" + logo.h : "none"})`);
  ok(all(deco.root, (n) => n.clip && n.radius && n.radius[0] === 90).length === 1, "a round crop clips its picture");
  ok(all(deco.root, (n) => n.kids && n.kids.some((k) => k.t === "text" && /email/.test(k.chars))).length === 1, "a field shows its placeholder as text");
  const quote = all(deco.root, (n) => n.t === "text" && /Quoted/.test(n.chars || ""))[0];
  ok(!!quote && quote.chars.startsWith("\u201C") && quote.runs.some((r) => r.size === 44), `a ::before showing a character is text in its place, in its own size (${quote ? JSON.stringify(quote.chars) : "none"})`);
  ok(all(deco.root, (n) => /::after/.test(n.n) && (n.fills || []).some((f) => f.k === "solid")).length === 1 && all(deco.root, (n) => /::before/.test(n.n) && (n.fills || []).some((f) => f.k === "linear")).length === 1, "an ::after underline bar and a ::before shade are layers of their own");
  const crops = all(deco.root, (n) => (n.fit === "crop" && n.xf) || (n.fills || []).some((f) => f.fit === "crop"));
  ok(crops.length === 3, `pictures Figma can't fit by its own modes are cropped exactly: a cover anchored to a corner, a stretched picture, an anchored background (${crops.length})`);
} else {
  for (const u of urls) {
    try { await measure(u, new URL(u).hostname, { ink: 80, pct: 90 }); }
    catch (e) { ok(false, `${new URL(u).hostname}: measured — it stopped: ${e.message || e}`); }
  }
}
console.log(`\n${passed} passed, ${failures.length} failed  (pages, drawn-back pages and diffs in ${OUT})`);
finish(failures.length ? 1 : 0);
