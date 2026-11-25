// Live site vs a finished mirror, side by side — no rebuilding.
//
//   node scripts/compare-mirror.mjs <liveUrl> <mirrorDir> [--spots 0,900,1800] [--path /] [--out file.jpg]
//
// Opens the live page (online) and the mirror (its own server.mjs, internet cut off, another domain) in a
// real GPU Chrome, one after the other. Each waits until the page has SETTLED — no new files for 4 s
// (heavy 3D sites run a loading screen first), capped at 90 s — then gets the same tour: the cursor sweeps
// the first screen, then the wheel scrolls to each spot. Screenshots are combined into one image
// (live | mirror per spot) and a JSON summary is printed (load time, canvases, scroll height).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [liveUrl, dir] = args.filter((a, i) => !a.startsWith("--") && !["--spots", "--path", "--out"].includes(args[i - 1]));
if (!liveUrl || !dir) { console.error("usage: node scripts/compare-mirror.mjs <liveUrl> <mirrorDir> [--spots 0,900] [--path /] [--out file.jpg]"); process.exit(1); }
const SPOTS = (flag("--spots") || "0,900,1800,2700").split(",").map(Number);
const PATH = flag("--path") || new URL(liveUrl).pathname;
const OUT = flag("--out") || join(dir, "..", `${new URL(liveUrl).hostname}-compare.jpg`);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DOMAIN = "my-site.test";

const kids = [];
process.on("exit", () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

async function session(url, extra, tag) {
  const port = 9660 + Math.floor(Math.random() * 60);
  const prof = mkdtempSync(join(tmpdir(), "sl-cmp-"));
  const c = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,960", "--autoplay-policy=no-user-gesture-required", ...extra]);
  kids.push(c);
  for (let i = 0; i < 150; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const to = setTimeout(() => { pend.delete(i); r({}); }, 30000); pend.set(i, (m) => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await send("Page.navigate", { url });
  // settled = no new resources for 4 s (after at least 6 s), capped at 90 s
  let count = -1, stableSince = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(1000);
    const n = (await ev(`performance.getEntriesByType("resource").length`)) ?? -1;
    if (n !== count) { count = n; stableSince = Date.now(); }
    if (Date.now() - t0 > 6000 && Date.now() - stableSince > 4000) break;
  }
  const loadMs = Date.now() - t0;
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(720 + Math.cos(a) * 420), y: Math.round(450 + Math.sin(a) * 250) }); await sleep(35); }
  await sleep(800);
  const shots = [];
  for (const y of SPOTS) {
    let left = y - ((await ev("scrollY")) || 0);
    while (Math.abs(left) > 1) { const d = Math.sign(left) * Math.min(Math.abs(left), 200); await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 720, y: 450, deltaX: 0, deltaY: d }); left -= d; await sleep(90); }
    await sleep(2200);
    const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 65 });
    const file = `${tag}-${y}.jpg`; // tag = a path prefix in a temp folder
    if (s.result) writeFileSync(file, Buffer.from(s.result.data, "base64"));
    shots.push({ y, at: Math.round((await ev("scrollY")) || 0), file });
  }
  const info = await ev(`({ title: document.title, canvases: [...document.querySelectorAll("canvas")].filter((c) => { const b = c.getBoundingClientRect(); return b.width >= 200 && b.height >= 150; }).length, height: document.documentElement.scrollHeight, url: location.href })`);
  try { c.kill("SIGKILL"); } catch {}
  setTimeout(() => rmSync(prof, { recursive: true, force: true }), 1500);
  return { loadMs, shots, ...info };
}

const tmp = mkdtempSync(join(tmpdir(), "sl-cmp-shots-"));
const live = await session(liveUrl, [], join(tmp, "live"));
const mport = 4900 + Math.floor(Math.random() * 90);
const srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(mport) } }); kids.push(srv);
await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
const mirror = await session(`http://${DOMAIN}:${mport}${PATH}`, [`--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1 , MAP * ~NOTFOUND , EXCLUDE localhost`, `--unsafely-treat-insecure-origin-as-secure=http://${DOMAIN}:${mport}`], join(tmp, "mirror"));
const pairs = live.shots.map((s, i) => [s.file, mirror.shots[i]?.file, s.at, mirror.shots[i]?.at]);
const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
pairs = json.loads(sys.argv[1]); out = sys.argv[2]
try: font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
except Exception: font = None
W, H = 720, 450; rows = []
for a, b, ya, yb in pairs:
    t = Image.new("RGB", (W * 2 + 12, H + 32), "white")
    try: t.paste(Image.open(a).resize((W, H)), (0, 32))
    except Exception: pass
    try: t.paste(Image.open(b).resize((W, H)), (W + 12, 32))
    except Exception: pass
    d = ImageDraw.Draw(t); d.text((8, 6), f"LIVE  scrollY {ya}", fill="black", font=font); d.text((W + 20, 6), f"MIRROR (offline, other domain)  scrollY {yb}", fill=(10, 122, 58), font=font)
    rows.append(t)
o = Image.new("RGB", (rows[0].width, sum(r.height for r in rows)), "white"); y = 0
for r in rows: o.paste(r, (0, y)); y += r.height
o.save(out, quality=72)
`;
execFileSync("python3", ["-c", py, JSON.stringify(pairs), OUT]);
const strip = (s) => ({ loadSeconds: Math.round(s.loadMs / 100) / 10, title: s.title, canvases: s.canvases, scrollHeight: s.height, url: s.url });
console.log(JSON.stringify({ live: strip(live), mirror: strip(mirror), image: OUT }, null, 1));
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
