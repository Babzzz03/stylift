// Records a video of a live mirror running — the site's real 3D / animations / scroll effects —
// in a real (GPU) Chrome, with the internet cut off so everything shown comes from the mirror.
//
//   node scripts/record-mirror.mjs <mirror folder> <out.mp4> [--seconds 22] [--online] [--domain name] [--path /page]
//
// Serves the folder with its own server.mjs, moves the mouse, then scrolls smoothly from the top to
// the bottom (cursor- and scroll-driven scenes react), and encodes the frames with ffmpeg.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const [dir, out] = args.filter((a, i) => !a.startsWith("--") && !["--seconds", "--domain", "--path"].includes(args[i - 1]));
if (!dir || !out) { console.error("usage: node scripts/record-mirror.mjs <mirror folder> <out.mp4> [--seconds 22] [--online] [--domain name]"); process.exit(1); }
const SECONDS = Number(flag("--seconds") || 22);
const DOMAIN = flag("--domain"); // serve under another hostname, like a deployment would
const PATH = flag("--path"); // a page other than the first one (whole-site mirrors)
const W = 1280, H = 800;
setTimeout(() => { console.error("recording took too long — gave up"); process.exit(2); }, 6 * 60 * 1000).unref(); // hard ceiling

const kids = [];
process.on("exit", () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } });
const port = 4700 + Math.floor(Math.random() * 200);
const srv = spawn("node", ["server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(port) } });
kids.push(srv);
await new Promise((res) => { const t = setTimeout(res, 15000); srv.stdout.on("data", (d) => { if (/Open http/.test(String(d))) { clearTimeout(t); res(); } }); });
const host = DOMAIN || "localhost";
const origin = `http://${host}:${port}`;
const rules = [...(DOMAIN ? [`MAP ${DOMAIN} 127.0.0.1`] : []), ...(args.includes("--online") ? [] : ["MAP * ~NOTFOUND", "EXCLUDE localhost"])];
const cdp = 9850 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "sl-rec-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--window-size=${W},${H + 120}`, "--autoplay-policy=no-user-gesture-required",
  ...(rules.length ? [`--host-resolver-rules=${rules.join(" , ")}`] : []), ...(DOMAIN ? [`--unsafely-treat-insecure-origin-as-secure=${origin}`] : [])]);
kids.push(chrome);
for (let i = 0; i < 150; i++) { try { await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json(); break; } catch { await sleep(200); } }
const t = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const frames = [];
let recording = false;
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Page.screencastFrame") {
    if (recording) frames.push({ data: m.params.data, ts: m.params.metadata.timestamp });
    ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } }));
  }
});
// every call gives up after 20 s, so a sleeping machine or a hung page can't stall the recording
const send = (method, params = {}) => new Promise((r) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); r({}); }, 20000); pending.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const entry = PATH || JSON.parse(readFileSync(join(dir, "mirror-manifest.json"), "utf8")).entry || "/";
await send("Page.navigate", { url: origin + entry });
await sleep(7000); // first-visit loader installs the worker, then the page loads and starts its scenes

await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1024, maxHeight: 640, everyNthFrame: 1 });
recording = true;
const t0 = Date.now();
// 1. the cursor sweeps across the first screen (cursor-driven 3D, hover effects)
for (let i = 0; i <= 60; i++) {
  const a = (i / 60) * Math.PI * 2;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(W / 2 + Math.cos(a) * W * 0.32), y: Math.round(H / 2 + Math.sin(a) * H * 0.28) });
  await sleep(40);
}
await sleep(600);
// 2. smooth wheel scrolling to the bottom over the remaining time (scroll-driven scenes, reveals)
const height = (await ev("document.documentElement.scrollHeight")) || 4000;
const travel = Math.max(0, Math.min(height - H, 14000));
const scrollMs = Math.max(4000, SECONDS * 1000 - (Date.now() - t0) - 2500);
const steps = Math.max(1, Math.round(scrollMs / 60));
for (let i = 0; i < steps; i++) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: W / 2 + Math.round(Math.sin(i / 9) * 120), y: H / 2, deltaX: 0, deltaY: travel / steps });
  await sleep(60);
}
await sleep(2500);
recording = false;
await send("Page.stopScreencast");

// encode: each frame shown for as long as it was on screen
if (frames.length < 2) { console.error("no frames captured"); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), "sl-rec-f-"));
let list = "";
frames.forEach((f, i) => {
  const name = `f${String(i).padStart(5, "0")}.jpg`;
  writeFileSync(join(work, name), Buffer.from(f.data, "base64"));
  const dur = i < frames.length - 1 ? Math.max(0.001, frames[i + 1].ts - f.ts) : 0.5;
  list += `file '${name}'\nduration ${dur.toFixed(4)}\n`;
});
list += `file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'\n`;
writeFileSync(join(work, "list.txt"), list);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-vf", `fps=30,scale=1024:-2,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", out]);
const secs = frames[frames.length - 1].ts - frames[0].ts;
console.log(`${out}: ${frames.length} frames over ${secs.toFixed(1)} s (${(frames.length / secs).toFixed(0)} fps) · served at ${origin}${args.includes("--online") ? "" : " · internet cut off"}`);
rmSync(work, { recursive: true, force: true });
ws.close();
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
process.exit(0);
