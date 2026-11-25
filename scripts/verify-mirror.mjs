// Live mirror export: file layout, reference rewriting, and the bundled server (run for real).
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const outdir = mkdtempSync(join(tmpdir(), "sl-mirror-"));
await build({ entryPoints: { m: "src/panel/mirror.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { buildLiveMirror, buildSiteMirror, mirrorPath, assetRefs } = await import(pathToFileURL(join(outdir, "m.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const hosts = new Set(["ex.com", "www.ex.com"]);
ok(mirrorPath("https://www.ex.com/_next/static/chunks/app.js", hosts) === "site/_next/static/chunks/app.js", "the site's files keep their paths");
ok(/^site\/models\/robot__q\w+\.glb$/.test(mirrorPath("https://ex.com/models/robot.glb?v=3", hosts)), "query variants get their own file, keeping the extension");
ok(mirrorPath("https://cdn.other.net/three/r160/three.module.js", hosts) === "_ext/cdn.other.net/three/r160/three.module.js", "other hosts' files go under _ext/<host>/");
ok(/^_ext\/fonts\.googleapis\.com\/css2__q\w+\.css$/.test(mirrorPath("https://fonts.googleapis.com/css2?family=Inter", hosts, "text/css; charset=utf-8")), "a file without an extension gets one from its content type (Google Fonts CSS → .css)");
ok(mirrorPath("https://cdn.jsdelivr.net/npm/vue@2.6.12", hosts, "application/javascript") === "_ext/cdn.jsdelivr.net/npm/vue@2.6.12.js", "\"vue@2.6.12\" isn't mistaken for a file with a \".12\" extension");

const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src https://ex.com">
<link rel="stylesheet" href="/css/site.css"><script src="https://ex.com/js/app.js"></script><script src="https://cdn.other.net/lib.js"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><link rel="icon" href="https://cdn.other.net/brand/icon.png"></head><body><canvas id="scene"></canvas><img src="/img/a.webp"></body></html>`;
const remote = {
  "https://ex.com/css/site.css": ["text/css", "body{background:url(/img/bg.jpg)} @font-face{src:url(../fonts/x.woff2)}"],
  "https://ex.com/js/app.js": ["text/javascript", `fetch("https://ex.com/models/robot.glb?v=3"); import("https://cdn.other.net/lib.js"); const api = "https:\\/\\/ex.com\\/api\\/data"; const __vite__mapDeps = ["./Popup.a1b2c3.js", "./Popup.d4e5f6.css", "./Gone.zzz.js"];`],
  "https://ex.com/js/Popup.a1b2c3.js": ["text/javascript", `export default 1; import("./Deeper.q9.js"); loader.load("/models/later-scene.glb"); fetch("/models/gone.glb");`],
  "https://ex.com/models/later-scene.glb": ["model/gltf-binary", "LATER-GLB"],
  "https://ex.com/js/Popup.d4e5f6.css": ["text/css", ".popup{}"],
  "https://ex.com/js/Deeper.q9.js": ["text/javascript", "export const d = 1;"],
  "https://cdn.other.net/brand/icon.png": ["image/png", "PNG"],
  "https://cdn.other.net/lib.js": ["text/javascript", "export const x = 1;"],
  "https://ex.com/models/robot.glb?v=3": ["model/gltf-binary", "GLB-BYTES"],
  "https://ex.com/img/a.webp": ["image/webp", "WEBP"],
  "https://ex.com/img/bg.jpg": ["image/jpeg", "JPG"],
  "https://ex.com/fonts/x.woff2": ["font/woff2", "WOFF2"],
  "https://ex.com/draco/decoder.wasm": ["application/wasm", "WASM"],
  "https://ex.com/_payload.json": ["application/json", `["https:\\u002F\\u002Fcdn.other.net\\u002Faudio\\u002Fintro.mp3","https:\\u002F\\u002Fex.com\\u002Fapi\\u002Fitems"]`],
  "https://cdn.other.net/audio/intro.mp3": ["audio/mpeg", "0123456789"],
};
const asked = [];
let flaky = 0; // the first request for this file fails, like a dropped connection
const m = await buildLiveMirror("https://ex.com/work/project", html, ["https://analytics.google.com/g/collect?v=2&tid=G-1", "https://www.google.com/ccm/collect?rcb=1", "https://www.google.com/pagead/1p-conversion/1/", "https://ex.com/web-pixels@abc/sandbox/worker.modern.js", "https://ex.com/checkouts/internal/preloads.js?locale=en", "https://www.merchant-center-analytics.goog/mc/collect?v=2", "https://allbirds.attn.tv/d?attn_vid=1", "https://cdn.attn.tv/allbirds/dtag.js", "https://shop.myshopify.com/api/2026-07/graphql.json", "https://ex.com/graphql?op=Products", "https://ex.com/docs/quickstart?_rsc=1qimj0m", "https://ex.com/models/robot.glb?v=3", "https://ex.com/draco/decoder.wasm", "https://ex.com/_payload.json", "https://cdn.other.net/audio/intro.mp3", "https://www.google-analytics.com/g/collect?v=2", "https://ex.com/missing.png"], {
  fetchFile: async (u) => { asked.push(u); if (u === "https://ex.com/img/a.webp" && flaky++ === 0) return null; const r = remote[u]; return r ? { type: r[0], bytes: new TextEncoder().encode(r[1]) } : null; },
});
const f = m.files;
const text = (p) => (typeof f[p] === "string" ? f[p] : new TextDecoder().decode(f[p] || new Uint8Array()));
ok(!!f["site/work/project/index.html"] && /<canvas id="scene">/.test(text("site/work/project/index.html")), "the page comes from its original HTML, at its own path");
ok(!/Content-Security-Policy/.test(text("site/work/project/index.html")), "a CSP meta tag that would block the mirror's origin is removed");
ok(/src="https:\/\/ex\.com\/js\/app\.js"/.test(text("site/work/project/index.html")) && /src="https:\/\/cdn\.other\.net\/lib\.js"/.test(text("site/work/project/index.html")), "the page is its original HTML: scripts keep their real URLs (the worker serves them locally)");
ok(text("site/js/app.js") === remote["https://ex.com/js/app.js"][1], "the site's code is stored byte for byte — never edited (code that parses URLs and integrity hashes keep working)");
ok(text("site/_payload.json") === remote["https://ex.com/_payload.json"][1], "framework data payloads are stored byte for byte too");
const sw = text("sl-mirror-sw.js");
ok(/const ORIGIN = "https:\/\/ex\.com"/.test(sw) && /"www\.ex\.com"/.test(sw) && /"cdn\.other\.net"/.test(sw), "service worker knows the original origin, the site's domains and the mirrored CDNs");
ok(/new Response\(r\.body/.test(sw) && /mirror-manifest\.json/.test(sw) && /variantOf/.test(sw) && /req\.mode === "navigate"/.test(sw), "worker serves pages and files from the manifest under the original URL, falls back to the internet, then to another stored size offline");
ok(/Opening the mirror/.test(text("index.html")) && text("404.html") === text("index.html") && ".nojekyll" in f, "any static host can open it: index.html + 404.html start the mirror, .nojekyll keeps _-folders visible on GitHub Pages");
const head = text("site/work/project/index.html").match(/<head[^>]*>([\s\S]{0,40})/)[1];
ok(/^<script data-sl-mirror>/.test(head) && /sl-mirror-sw\.js/.test(text("site/work/project/index.html")), "the worker is registered first thing in <head>, before the site's code");
ok(!!f["site/img/bg.jpg"] && !!f["site/fonts/x.woff2"], "files referenced only from CSS are downloaded too");
ok(!!f["site/draco/decoder.wasm"] && /^site\/models\/robot__q\w+\.glb$/.test(Object.keys(f).find((k) => /robot/.test(k)) || ""), "WebAssembly and 3D models the page loaded are in the mirror");
ok(!asked.some((u) => /google|collect|web-pixels|preloads|attn\.tv|graphql|_rsc=/.test(u)), "analytics trackers are left out — whole hosts, and tracking paths on hosts that also serve real files (Google beacons, Shopify web pixels, checkout preloads)");
ok(!!f["site/js/Popup.a1b2c3.js"] && !!f["site/js/Popup.d4e5f6.css"] && !!f["site/js/Deeper.q9.js"], "on-demand chunks the bundle lists (never loaded during capture) are downloaded, chunks of chunks too");
ok(!m.missing.some((u) => /Gone|gone\.glb/.test(u)), "a guessed chunk or asset that doesn't exist isn't reported missing");
ok(!!f["site/models/later-scene.glb"], "a 3D model the code loads later (never loaded during the capture) is in the mirror");
ok(/<link rel="icon" href="\/_ext\/cdn\.other\.net\/brand\/icon\.png">/.test(text("site/work/project/index.html")), "tab icon points at its copy (browsers fetch icons outside the service worker)");
ok(!!f["site/img/a.webp"] && !m.missing.includes("https://ex.com/img/a.webp"), "a download that fails once (flaky connection) is retried");
ok(m.missing.includes("https://ex.com/missing.png") && /missing\.png/.test(text("README.md")), "files that couldn't be downloaded are listed in the README");
ok(/permission/i.test(text("README.md")) && /node server\.mjs/.test(text("README.md")), "README explains how to run it and the permission rule");

// names without extensions, and a file + folder with the same name (an npm CDN package and its dist/)
const cdn = {
  "https://cdn.jsdelivr.net/npm/vue-tel-input@5.14.0": ["application/javascript; charset=utf-8", "VTI-JS"],
  "https://cdn.jsdelivr.net/npm/vue-tel-input@5.14.0/dist/vue-tel-input.css": ["text/css; charset=utf-8", ".vti{}"],
  "https://fonts.googleapis.com/css2?family=Inter": ["text/css; charset=utf-8", "@font-face{font-family:Inter}"],
  "https://ex.com/lib/x.js": ["text/javascript", "X"],
  "https://ex.com/lib/x.js/extra.css": ["text/css", ".x{}"],
};
const cm = await buildLiveMirror("https://ex.com/", "<html><head></head><body>x</body></html>", Object.keys(cdn), {
  fetchFile: async (u) => (cdn[u] ? { type: cdn[u][0], bytes: new TextEncoder().encode(cdn[u][1]) } : null),
});
const cpaths = Object.keys(cm.files);
const clash = cpaths.filter((k) => cpaths.some((o) => o.startsWith(k + "/")));
ok(!clash.length && cm.missing.length === 0, `no file shares its name with a folder, nothing lost (${clash.join(", ") || "none"})`);

// a dropping connection: the page's own script fails twice then arrives; its stylesheet never does
let tries = 0;
const flakyM = await buildLiveMirror("https://ex.com/", `<html><head><script type="module" src="/app.mjs"></script><link rel="stylesheet" href="/main.css"></head><body>x</body></html>`, [], {
  fetchFile: async (u) => (u === "https://ex.com/app.mjs" && ++tries > 3 ? { type: "text/javascript", bytes: new TextEncoder().encode("1") } : null),
  retryWaitsMs: [10, 10, 10],
});
ok(!!flakyM.files["site/app.mjs"] && !flakyM.missingEssential.includes("https://ex.com/app.mjs"), "the page's own script is retried until it arrives (dropping connection)");
ok(flakyM.missingEssential.length === 1 && flakyM.missingEssential[0] === "https://ex.com/main.css" && /Incomplete mirror/.test(String(flakyM.files["README.md"])), "a stylesheet that never arrives marks the mirror incomplete (README says so up front)");

// whole site: several pages, each with its own original HTML at its own path, files shared
const sm = await buildSiteMirror(
  [
    { url: "https://ex.com/", html: `<html><head><script src="/js/app.js"></script></head><body><h1>Home</h1><a href="https://ex.com/about/">About</a></body></html>` },
    { url: "https://ex.com/about/", html: `<html><head><script src="/js/app.js"></script></head><body><h1>About us</h1></body></html>` },
    { url: "https://ex.com/about/#team", html: "<html><body>dup</body></html>" },
  ],
  [],
  { fetchFile: async (u) => { const r = remote[u]; return r ? { type: r[0], bytes: new TextEncoder().encode(r[1]) } : null; } },
);
const sf = (p) => (typeof sm.files[p] === "string" ? sm.files[p] : new TextDecoder().decode(sm.files[p] || new Uint8Array()));
ok(sm.pages === 2 && /About us/.test(sf("site/about/index.html")) && /<h1>Home<\/h1>/.test(sf("site/index.html")), "whole site: each page keeps its own original HTML at its own path (duplicates by #hash dropped)");
ok(Object.keys(sm.files).filter((k) => /app\.js$/.test(k)).length === 1 && /Pages \(2\)/.test(sf("README.md")), "whole site: scripts are shared, README lists the pages");
const keeper = sf("site/index.html").match(/<script data-sl-mirror>[\s\S]*?<\/script>/)?.[0] || "";
ok(/"ex\.com"/.test(keeper) && /defaultPrevented/.test(keeper) && /location\.assign/.test(keeper), "links that spell out the site's own domain stay inside the mirror (only clicks the site's router didn't handle)");
ok(/navigation\.addEventListener\("navigate"/.test(keeper) && /e\.preventDefault\(\)/.test(keeper), "navigations the site's code starts towards its own domain (domain checks, redirects) are kept inside the mirror");
ok(/fixIcons/.test(keeper) && /MutationObserver/.test(keeper), "tab icons the site's framework re-points at the original address after loading are kept on the mirror's copies");
ok(/\["Worker","SharedWorker"\]/.test(keeper), "background workers started from the site's full address (wix.com) use the mirror's copy");

// run the bundled server against the mirror
const dir = mkdtempSync(join(tmpdir(), "sl-mirror-run-"));
for (const [p, d] of Object.entries(f)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }
const port = 4300 + Math.floor(Math.random() * 400);
const srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(port) } });
// wait for its "Open http://…" line (a busy machine can take a few seconds to start node)
await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
const get = async (u, accept) => { const r = await fetch(`http://localhost:${port}${u}`, { headers: accept ? { accept } : {} }); return { status: r.status, type: r.headers.get("content-type") || "", body: await r.text() }; };
// a browser navigation (Node's fetch forces sec-fetch-mode: cors, so send it raw)
const raw = (path, headers) => new Promise((res, rej) => { const q = request({ host: "localhost", port, path, headers }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b)); }); q.on("error", rej); q.end(); });
const loader = await raw("/work/project", { accept: "text/html", "sec-fetch-mode": "navigate" });
ok(/sl-mirror-sw\.js/.test(loader) && /location\.reload/.test(loader) && !/<canvas id="scene">/.test(loader), "server: a browser's first visit gets the loader that installs the worker");
const nav = await raw("/work/project", { accept: "text/html", "sec-fetch-mode": "navigate", cookie: "slmirror=1" });
ok(/<canvas id="scene">/.test(nav), "server: once installed (cookie), the real page is served");
const swr = await get("/sl-mirror-sw.js");
ok(swr.status === 200 && /javascript/.test(swr.type), "server: the worker script is served from the root scope");
const part = await fetch(`http://localhost:${port}/_ext/cdn.other.net/audio/intro.mp3`, { headers: { range: "bytes=2-5" } });
ok(part.status === 206 && (await part.text()) === "2345" && part.headers.get("content-range") === "bytes 2-5/10", "server: byte ranges for audio/video (206 Partial Content)");
const viaCdn = await get("/lib.js");
ok(viaCdn.status === 200 && viaCdn.body === "export const x = 1;", "server: a local path the site's code uses when it isn't on its own domain (/lib.js) is served from the copy saved from its CDN (cdn.other.net/lib.js)");
const exact = await get("/models/robot.glb?v=999");
const near = await fetch(`http://localhost:${port}/models/robot.glb?v=999`, { headers: { "x-sl-variant": "1" } });
ok(exact.status === 404 && near.status === 200 && (await near.text()) === "GLB-BYTES", "server: offline, the worker can ask for another stored size of the same file");
const pg = await get("/work/project", "text/html");
ok(pg.status === 200 && /<canvas id="scene">/.test(pg.body) && /text\/html/.test(pg.type), "server: the page opens at its own path");
const glb = await get("/models/robot.glb?v=3");
ok(glb.status === 200 && glb.body === "GLB-BYTES" && /gltf-binary/.test(glb.type), "server: a URL with a query string maps to its stored file, with the 3D model type");
const wasm = await get("/draco/decoder.wasm");
ok(wasm.status === 200 && /application\/wasm/.test(wasm.type), "server: WebAssembly served as application/wasm (needed to stream-compile)");
const ext = await get("/_ext/cdn.other.net/lib.js");
ok(ext.status === 200 && /javascript/.test(ext.type), "server: another host's mirrored script is served");
const route = await get("/work/other-route", "text/html");
ok(route.status === 200 && /<canvas id="scene">/.test(route.body), "server: client-side routes fall back to the page");
const nope = await get("/../../etc/passwd");
ok(nope.status === 404, "server: paths can't escape the mirror folder");
srv.kill();
rmSync(dir, { recursive: true, force: true });

// your own layer: every page loads stylelift-custom.css last in <head> and stylelift-custom.js at the end
const pg1 = sf("site/index.html"), pg2 = sf("site/about/index.html");
ok([pg1, pg2].every((h) => /fetch\("\/stylelift-custom\.css"/.test(h) && /adoptedStyleSheets/.test(h) && /"\/stylelift-custom\.js"/.test(h) && !/data-sl-custom/.test(h)), "every page loads your stylelift-custom.css (an adopted sheet, after the site's) and stylelift-custom.js (once loaded) — without writing tags into the page's HTML");
{
  // the guard script is valid JavaScript, removes itself, and its "is there anything in this file" test works
  const { Script } = await import("node:vm");
  const code = /<script data-sl-mirror>([\s\S]*?)<\/script>/.exec(pg1)[1];
  let parsed = true;
  try { new Script(code); } catch (e) { parsed = false; console.log("    ", e.message); }
  ok(parsed && /me\.remove\(\)/.test(code), "the mirror's guard script parses and takes itself out of the page once it has run (React sees the site's HTML as sent)");
  const real = new Function("return " + /var real=(function\(t\)\{[^}]*\})/.exec(code)[1])();
  ok(real("/* only a comment */\n") === false && real("// note\n") === false && real("body { color: red }") === true && real("console.log(1)") === true, "an untouched template (comments only) adds nothing to the page; real rules do");
}
ok(/your styles for this mirror/.test(sf("site/stylelift-custom.css")) && /your code for this mirror/.test(sf("site/stylelift-custom.js")) && /## Make it yours/.test(sf("README.md")), "the two files explain themselves; the README says how to restyle");

// Next.js (Turbopack) lists on-demand chunks as "static/immutable/chunks/…" — CSS ones too
{
  const { lazyChunkRefs } = await import(pathToFileURL(join(outdir, "m.js")));
  const r = lazyChunkRefs(`Promise.all(["static/immutable/chunks/0kxz910lms_og.js","static/immutable/chunks/2ee_sdkgjot__.css","static/chunks/app.js"].map(load))`, "https://ex.com/_next/static/immutable/chunks/40p2.js", "https://ex.com/_next/");
  ok(["https://ex.com/_next/static/immutable/chunks/0kxz910lms_og.js", "https://ex.com/_next/static/immutable/chunks/2ee_sdkgjot__.css", "https://ex.com/_next/static/chunks/app.js"].every((u) => r.includes(u)), "Next.js on-demand chunks are found in both layouts (static/chunks and Turbopack's static/immutable/chunks), CSS too");
}

// webpack builds (Wix, CRA, Gatsby): chunk names come from tables — id + "." + {id:"hash"}[id] + ".chunk.min.js"
{
  const { webpackChunkRefs } = await import(pathToFileURL(join(outdir, "m.js")));
  const runtime = `r.p="https://static.cdn.ex.com/dist/";r.u=e=>({123:"vendors-ricos"}[e]||e)+"."+({123:"74b66f59",2570:"b94600a7",2624:"5aa1bb20"})[e]+".chunk.min.js";r.miniCssF=e=>e+"."+({2570:"aa11bb22",9863:"6f11f5af"})[e]+".chunk.min.css";`;
  const w = webpackChunkRefs(runtime, "https://www.ex.com/");
  ok(["https://static.cdn.ex.com/dist/2570.b94600a7.chunk.min.js", "https://static.cdn.ex.com/dist/vendors-ricos.74b66f59.chunk.min.js", "https://static.cdn.ex.com/dist/9863.6f11f5af.chunk.min.css"].every((u) => w.includes(u)), `webpack on-demand chunks are rebuilt from the build's tables — JS, named and CSS chunks, under its public path (${w.length} found)`);
  const auto = webpackChunkRefs(`t.u=e=>e+"."+{11:"0a1b2c3d",12:"0a1b2c3e"}[e]+".js"`, "https://ex.com/static/js/main.abc.js");
  ok(auto.includes("https://ex.com/static/js/11.0a1b2c3d.js"), "…and beside the runtime's own file when the public path isn't spelled out");
  const cra = webpackChunkRefs(`n.p="/";n.u=e=>"static/js/"+e+"."+{11:"0a1b2c3d",12:"9f8e7d6c"}[e]+".chunk.js";n.miniCssF=e=>"static/css/"+e+"."+{11:"55aa66bb"}[e]+".chunk.css"`, "https://ex.com/static/js/main.abc.js");
  ok(["https://ex.com/static/js/11.0a1b2c3d.chunk.js", "https://ex.com/static/css/11.55aa66bb.chunk.css"].every((u) => cra.includes(u)), "…and Create React App's form, with its folder in front (static/js/11.<hash>.chunk.js)");
  ok(webpackChunkRefs(`const colors={1:"ff00aa11",2:"00ff00aa"};`, "https://ex.com/a.js").length === 0, "a table of hex values that isn't a chunk-name expression is ignored");
  const wixForm = webpackChunkRefs(`r.u=e=>(({9794:"siteLocaleService",9980:"3d-viewer"})[e]||e)+"."+({1059:"cf4033c1",9980:"d8459aa9"})[e]+".chunk.min.js";r.g=globalThis;r.p="https://static.cdn.ex.com/dist/";`, "https://www.ex.com/");
  ok(["https://static.cdn.ex.com/dist/1059.cf4033c1.chunk.min.js", "https://static.cdn.ex.com/dist/3d-viewer.d8459aa9.chunk.min.js"].every((u) => wixForm.includes(u)), "…and Wix's form: names table in its own brackets, public path set after the tables");
}

// models / textures / videos the code loads by name (when you reach that part of a 3D scene)
const refs = assetRefs(`const a="/assets/models/scene.glb"; load('./tex/env.hdr?v=2'); const v=\`videos/reel.mp4\`; const n="node_modules/x/y.png"; const p="package.json"; const c="//cdn.x.com/a.png"; const s="https://other.com/b.glb"; const t="/textures/floor.ktx2";`, "https://ex.com/_astro/app.js");
ok(["https://ex.com/assets/models/scene.glb", "https://ex.com/_astro/tex/env.hdr?v=2", "https://ex.com/videos/reel.mp4", "https://ex.com/textures/floor.ktx2"].every((u) => refs.includes(u)), `assets named in code are found: absolute, relative (with ?query), bare paths tried at the site root (${refs.length} found)`);
ok(!refs.some((u) => /node_modules|package\.json|cdn\.x\.com|other\.com/.test(u)), "…but not build paths, bare file names, or other hosts");

// a site of real pages (a shop): an address that wasn't mirrored says so — never shows another page
const words = "Handmade silver jewelry, shipped from Paris. ".repeat(6);
const shopM = await buildSiteMirror(
  [
    { url: "https://shop.ex.com/", html: `<html><head><title>Shop &amp; Co</title></head><body><nav><a href="/products/ring">Ring</a></nav><p>${words}</p></body></html>` },
    { url: "https://shop.ex.com/products/ring", html: `<html><head><title>Signet ring – Shop</title></head><body><p>${words}</p></body></html>` },
  ],
  [],
  { fetchFile: async () => null },
);
const shopMan = JSON.parse(shopM.files["mirror-manifest.json"]);
ok(shopMan.fallback === "missing" && JSON.parse(m.files["mirror-manifest.json"]).fallback === "app", "a site of real pages is told apart from an app whose HTML is an empty shell");
const sdir = mkdtempSync(join(tmpdir(), "sl-mirror-shop-"));
for (const [p, d] of Object.entries(shopM.files)) { mkdirSync(dirname(join(sdir, p)), { recursive: true }); writeFileSync(join(sdir, p), d); }
const sport = port + 2;
const ssrv = spawn("node", ["server.mjs"], { cwd: sdir, env: { ...process.env, PORT: String(sport) } });
await new Promise((res) => { const t = setTimeout(res, 15000); ssrv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
const miss = await fetch(`http://localhost:${sport}/products/create-your-own`, { headers: { accept: "text/html", cookie: "slmirror=1" } });
const missBody = await miss.text();
ok(miss.status === 404 && /This page isn't in the mirror/.test(missBody) && /href="https:\/\/shop\.ex\.com\/products\/create-your-own"/.test(missBody), "an address that wasn't mirrored gets a clear \"not in this mirror\" page (404) with a link to it on the real site");
ok(/Signet ring – Shop/.test(missBody) && /href="\/products\/ring"/.test(missBody) && /Shop &amp; Co/.test(missBody) && !/Handmade silver/.test(missBody), "…listing the pages that are in the mirror (titles escaped), not the home page's content");
const ring = await fetch(`http://localhost:${sport}/products/ring`, { headers: { accept: "text/html", cookie: "slmirror=1" } });
ok(ring.status === 200 && /Signet ring/.test(await ring.text()), "a mirrored page is still served");
ssrv.kill();
rmSync(sdir, { recursive: true, force: true });

// served with the type their own server sent
const cdir = mkdtempSync(join(tmpdir(), "sl-mirror-cdn-"));
for (const [p, d] of Object.entries(cm.files)) { mkdirSync(dirname(join(cdir, p)), { recursive: true }); writeFileSync(join(cdir, p), d); }
const cport = port + 1;
const csrv = spawn("node", ["server.mjs"], { cwd: cdir, env: { ...process.env, PORT: String(cport) } });
await new Promise((res) => { const t = setTimeout(res, 15000); csrv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
const cget = async (u) => { const r = await fetch(`http://localhost:${cport}${u}`); return { type: r.headers.get("content-type") || "", body: await r.text() }; };
const gf = await cget("/_ext/fonts.googleapis.com/css2?family=Inter");
ok(/^text\/css/.test(gf.type) && /Inter/.test(gf.body), `server: Google Fonts CSS served as a stylesheet (${gf.type}) — browsers refuse CSS sent as binary`);
const vti = await cget("/_ext/cdn.jsdelivr.net/npm/vue-tel-input@5.14.0");
const vtc = await cget("/_ext/cdn.jsdelivr.net/npm/vue-tel-input@5.14.0/dist/vue-tel-input.css");
ok(/javascript/.test(vti.type) && vti.body === "VTI-JS" && /^text\/css/.test(vtc.type), "server: an npm package file and its dist/ folder both served, with their own types");
const xj = await cget("/lib/x.js");
const xc = await cget("/lib/x.js/extra.css");
ok(xj.body === "X" && xc.body === ".x{}", "server: a file renamed to avoid a folder clash is still served at its URL");
csrv.kill();
rmSync(cdir, { recursive: true, force: true });

// media only NAMED in code: other languages' files are skipped, and pictures from folders the page never
// used are capped (notion.com's bundle names 140 MB of other pages' media); the page's own folders aren't
{
  const { pathLanguage } = await import(pathToFileURL(join(outdir, "m.js")));
  ok(pathLanguage("https://ex.com/pages/mobile/fr-FR.gif") === "fr" && pathLanguage("https://ex.com/img/ja-JP/a.png") === "ja" && pathLanguage("https://ex.com/img/hero.png") === null, "a file's language is read from its path (fr-FR.gif, /ja-JP/)");
  const big = new Uint8Array(1_000_000);
  const names = ["/static/pages/mobile/fr-FR.gif", "/static/pages/mobile/en-US.gif"];
  for (let i = 0; i < 40; i++) names.push(`/static/pages/other-${i}.png`);
  for (let i = 0; i < 12; i++) names.push(`/static/home/shot-${i}.png`);
  names.push("/static/scene/model.glb");
  const code = `const files = [${names.map((n) => JSON.stringify(n)).join(",")}];`;
  const fetched = [];
  const qm = await buildLiveMirror("https://ex.com/", `<html lang="en-US"><head><script src="/app.js"></script></head><body>x</body></html>`, ["https://ex.com/app.js", "https://ex.com/static/home/hero.png"], {
    fetchFile: async (u) => { fetched.push(u); if (u.endsWith("/app.js")) return { bytes: new TextEncoder().encode(code), type: "text/javascript" }; return { bytes: big, type: u.endsWith(".glb") ? "model/gltf-binary" : u.endsWith(".gif") ? "image/gif" : "image/png" }; },
    retryWaitsMs: [1],
  });
  const has = (p) => fetched.some((u) => u.endsWith(p));
  ok(!has("/fr-FR.gif") && has("/en-US.gif"), "a file for another language (fr-FR on an English page) isn't fetched; the page's own language is");
  const others = fetched.filter((u) => /\/static\/pages\/other-/.test(u)).length;
  ok(others >= 22 && others <= 31, `pictures only named in code, from folders the page never used, stop at the budget (${others} of 40 MB; up to 6 were already on their way)`);
  ok(names.filter((n) => n.startsWith("/static/home/")).every((n) => has(n)) && has("/static/scene/model.glb"), "pictures from a folder the page loaded from, and 3D models, are always fetched");
  void qm;
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Live mirror verified ✓");
