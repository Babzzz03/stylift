// A Live mirror on a PLAIN static host — no server.mjs, no StyleLift logic on the server: the way a
// designer shares one by dragging the folder onto Netlify Drop / Cloudflare Pages / GitHub Pages.
// The host here only maps paths to files and answers 404.html for anything missing (like Netlify).
// Opened in headless Chrome with the internet cut off, at another domain.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const od = mkdtempSync(join(tmpdir(), "sl-static-"));
await build({ entryPoints: { m: "src/panel/mirror.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { buildSiteMirror } = await import(pathToFileURL(join(od, "m.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

// ── a small site: own scripts, a query-string image, a CDN stylesheet, data fetched by full address ──
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const words = "A studio that builds websites people remember. ".repeat(6);
const remote = {
  "https://ex.com/js/app.js": ["text/javascript", `document.documentElement.dataset.app = "ran";
fetch("https://ex.com/data/info.json").then((r) => r.json()).then((j) => { document.documentElement.dataset.info = j.name; });`],
  "https://ex.com/data/info.json": ["application/json", JSON.stringify({ name: "info-ok" })],
  "https://ex.com/img/a.png?v=2": ["image/png", png],
  "https://cdn.other.net/style.css": ["text/css", "body { color: rgb(9, 8, 7); }"],
};
const m = await buildSiteMirror(
  [
    { url: "https://ex.com/", html: `<!doctype html><html><head><title>Studio home</title><link rel="stylesheet" href="https://cdn.other.net/style.css"></head><body><h1>Home</h1><p>${words}</p><img id="a" src="/img/a.png?v=2"><a id="about" href="/about">About</a><script src="/js/app.js"></script></body></html>` },
    { url: "https://ex.com/about", html: `<!doctype html><html><head><title>About the studio</title></head><body><h1>About us</h1><p>${words}</p></body></html>` },
  ],
  Object.keys(remote),
  { fetchFile: async (u) => (remote[u] ? { type: remote[u][0], bytes: typeof remote[u][1] === "string" ? new TextEncoder().encode(remote[u][1]) : new Uint8Array(remote[u][1]) } : null) },
);
const dir = mkdtempSync(join(tmpdir(), "sl-static-site-"));
for (const [p, d] of Object.entries(m.files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), d); }

// ── a plain static host: path → file, folders → index.html, anything else → 404.html (like Netlify) ──
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png" };
const host = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = normalize(join(dir, p));
  if (!f.startsWith(dir + sep) && f !== dir) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f) || !statSync(f).isFile()) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(dir, "404.html"))); }
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const port = host.address().port;
const DOMAIN = "my-static.test";
const ORIGIN = `http://${DOMAIN}:${port}`;

async function chrome() {
  const cdp = 9760 + Math.floor(Math.random() * 60);
  const prof = mkdtempSync(join(tmpdir(), "sl-static-chrome-"));
  const c = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdp}`, `--user-data-dir=${prof}`, "--no-first-run",
    `--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1 , MAP * ~NOTFOUND , EXCLUDE localhost`, `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`]);
  for (let i = 0; i < 150; i++) { try { await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json(); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const msg = JSON.parse(e.data); if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => { pend.delete(i); r({}); }, 30000); pend.set(i, (x) => { clearTimeout(to); r(x); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Page.enable");
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await ev(expr).catch(() => null); if (v) return v; await sleep(250); } return v; };
  return { send, ev, until, close: () => { ws.close(); c.kill("SIGKILL"); setTimeout(() => rmSync(prof, { recursive: true, force: true }), 1000); } };
}

try {
  // 1. the folder's home page, first visit: the loader installs the worker, reloads into the site
  const a = await chrome();
  await a.send("Page.navigate", { url: ORIGIN + "/" });
  const title = await a.until(`document.title === "Studio home" && document.title`);
  ok(title === "Studio home", `the home page opens from the loader on a plain static host (${title || "still: " + (await a.ev("document.title"))})`);
  const r = await a.until(`document.documentElement.dataset.info && ({ app: document.documentElement.dataset.app, info: document.documentElement.dataset.info, img: document.getElementById("a").naturalWidth, color: getComputedStyle(document.body).color, sw: !!navigator.serviceWorker.controller })`);
  ok(r?.app === "ran", "the site's own script loads (stored under site/, asked for at its original path)");
  ok(r?.img === 1, "an image whose address has a query string (?v=2) loads from its rewritten file name");
  ok(r?.color === "rgb(9, 8, 7)", "a stylesheet from another domain (the site's CDN) is served from the mirror");
  ok(r?.info === "info-ok", "data the code fetches by the site's full address loads from the mirror");
  ok(r?.sw === true, "the mirror's service worker controls the page");
  // 3. an address that wasn't mirrored says so (never another page in its place)
  await a.send("Page.navigate", { url: ORIGIN + "/no-such-page" });
  const miss = await a.until(`/isn't in the mirror/.test(document.body ? document.body.textContent : "") && document.title`);
  ok(miss === "Not in this mirror", "an address that isn't in the mirror shows the \"not in this mirror\" page");
  a.close();
  // 2. a link straight to a deep page, in a browser that has never opened the mirror (host answers 404.html)
  const b = await chrome();
  await b.send("Page.navigate", { url: ORIGIN + "/about" });
  const about = await b.until(`document.title === "About the studio" && document.title`);
  ok(about === "About the studio" && (await b.ev("location.pathname")) === "/about", `a link straight to a deep page works on a first visit (${about || await b.ev("document.title")})`);
  b.close();
} catch (e) { failures.push("static: " + e.message); console.log("  ✗ ERROR", e.message); }

host.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Live mirror on a plain static host verified ✓");
process.exit(0);
