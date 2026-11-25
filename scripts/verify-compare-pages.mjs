// A site next to its HTML export, section by section: for each of the export's section headings (h1 / h2),
// both pages are scrolled so that heading sits at the same place, and screenshotted (1440 × 900, a normal
// Chrome). Pairs written to <out>/NN-site.png and NN-export.png, to look at side by side.
//   node scripts/verify-compare-pages.mjs <site url> <unzipped HTML export folder> --out <dir> [--max 8]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [SITE, DIR] = args.filter((a, i) => !a.startsWith("--") && !["--out", "--max"].includes(args[i - 1]));
const OUT = flag("--out") || mkdtempSync(join(tmpdir(), "sl-cmp-"));
const MAX = Number(flag("--max") || 8);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".mp4": "video/mp4", ".webm": "video/webm" };
const srv = createServer((q, res) => {
  let p = decodeURIComponent(q.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const f = join(DIR, p);
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": T[extname(f).toLowerCase()] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const EXPORT = `http://127.0.0.1:${srv.address().port}/`;
// the section headings: read from the export as it shows (visible, not in the menu / header / footer)
let anchors = [];
const HEADS = `(() => { const out = []; for (const h of document.querySelectorAll("h1, h2")) { if (h.closest("nav, header, footer, [aria-hidden='true'], [role='navigation'], [role='dialog']")) continue; const r = h.getBoundingClientRect(); const c = getComputedStyle(h); if (r.width < 40 || r.height < 12 || c.display === "none") continue; /* (not by opacity: headings wait unseen for their entrance until scrolled to) */ const t = (h.textContent || "").replace(/\\s+/g, " ").trim(); if (t.length >= 6 && t.length <= 90 && !out.includes(t)) out.push(t); } return out; })()`;

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "sl-cmp-prof-"));
const port = 9900 + Math.floor(Math.random() * 40);
const ch = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,960", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "about:blank"]);
const finish = (code) => { try { ch.kill("SIGKILL"); } catch {} srv.close(); setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(code); }, 400); };
setTimeout(() => { console.log("✗ gave up after 10 minutes"); finish(2); }, 600000).unref();
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
async function tab(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => r({ error: "timeout" }), 60000); pend.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await fetch(`http://127.0.0.1:${port}/json/activate/${t.id}`);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  for (let i = 0; i < 150; i++) { await sleep(200); if ((await ev("document.readyState").catch(() => "")) === "complete") break; }
  return { send, ev, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
async function shoot(t, label) {
  await sleep(4000);
  // dismiss a cookie banner (the copy removes them)
  await t.ev(`(() => { const b = [...document.querySelectorAll("button, a")].find((x) => /^(accept|allow|agree|ok|got it|accept all)/i.test((x.textContent || "").trim())); if (b) b.click(); return !!b; })()`).catch(() => false);
  const r = await t.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `00-${label}.png`), Buffer.from(r.result?.data || "", "base64"));
  for (let i = 0; i < anchors.length; i++) {
    const found = await t.ev(`(() => { const want = ${JSON.stringify(anchors[i])}.toLowerCase(); const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase(); const el = [...document.querySelectorAll("h1, h2")].find((h) => norm(h.textContent) === want) || [...document.querySelectorAll("h1, h2, h3, p, div")].find((h) => h.children.length < 4 && norm(h.textContent) === want); if (!el) return false; scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 120)); return true; })()`);
    await sleep(2200);
    const s = await t.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${String(i + 1).padStart(2, "0")}-${label}.png`), Buffer.from(s.result?.data || "", "base64"));
    if (!found) console.log(`  ${label}: section ${i + 1} not found`);
  }
}
try {
  const ex = await tab(EXPORT);
  await sleep(4000);
  anchors = ((await ex.ev(HEADS)) || []).slice(0, MAX);
  console.log(`▶ ${SITE}\n  sections: ${anchors.map((a) => JSON.stringify(a.slice(0, 40))).join(", ")}`);
  await shoot(ex, "export");
  ex.close();
  const live = await tab(SITE);
  await sleep(5000);
  await shoot(live, "site");
  live.close();
  console.log(`  pairs in ${OUT}`);
  finish(0);
} catch (e) {
  console.log("  ✗ ERROR", e.message);
  finish(1);
}
