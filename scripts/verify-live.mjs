// Real-browser verification: launches the system Chrome headless, navigates to a
// live URL, injects the REAL bundled extractor (exactly what the extension ships),
// and runs the deterministic renderers on genuine getComputedStyle output.
//
// Usage: node scripts/verify-live.mjs [url ...]
// No puppeteer — drives Chrome over the DevTools Protocol via raw WebSocket.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
// throwaway Chrome profile, removed when the script exits (they are ~70 MB each)
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), "sl-chrome-"));
process.on("exit", () => { try { rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const urls = process.argv.slice(2);
if (!urls.length) urls.push("https://stripe.com", "https://tailwindcss.com");

// ── bundle the extractor to a single self-contained expression ────────────────
const outdir = mkdtempSync(join(tmpdir(), "stylelift-live-"));
await build({
  entryPoints: { extract: "src/extractor/extract.ts" },
  outdir,
  bundle: true,
  format: "iife",
  globalName: "__SL__",
  platform: "browser",
  logLevel: "silent",
});
const extractorBundle = readFileSync(join(outdir, "extract.js"), "utf8");
// Expression that runs the extractor and returns JSON-serializable tokens.
const evalExpression = `(function(){ ${extractorBundle}; return JSON.stringify(__SL__.extractDesignTokens()); })()`;

// renderers (run in node, on the real tokens)
await build({
  entryPoints: { render: "src/panel/render.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const render = await import(pathToFileURL(join(outdir, "render.js")));

// ── launch headless Chrome with a remote debugging port ───────────────────────
const port = 9333;
const userDir = CHROME_PROFILE;
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
]);
chrome.on("error", (e) => {
  console.error("Failed to launch Chrome:", e);
  process.exit(1);
});

async function getJSON(path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return res.json();
}

// wait for the DevTools endpoint to come up
let version;
for (let i = 0; i < 50; i++) {
  try {
    version = await getJSON("/json/version");
    if (version) break;
  } catch {
    await sleep(200);
  }
}
if (!version) {
  console.error("Chrome DevTools endpoint never came up.");
  chrome.kill();
  process.exit(1);
}
console.log("Launched:", version.Browser, "\n");

// ── minimal CDP-over-WebSocket client ─────────────────────────────────────────
let WS;
try {
  ({ WebSocket: WS } = await import("ws"));
} catch {
  WS = globalThis.WebSocket; // Node 22 has a global WebSocket
}

function cdpConnect(wsUrl) {
  const ws = new WS(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method)(msg.params);
    }
  });
  const ready = new Promise((res) => ws.addEventListener("open", () => res()));
  return {
    ready,
    on: (method, cb) => events.set(method, cb),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function extractFromUrl(url) {
  // open a fresh tab via the new-tab HTTP endpoint
  const target = await getJSON(`/json/new?${encodeURIComponent(url)}`, "PUT");
  const cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  const loaded = new Promise((res) => cdp.on("Page.loadEventFired", res));
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(1500); // let late styles/fonts settle

  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: evalExpression,
    returnByValue: true,
    awaitPromise: false,
  });
  cdp.close();
  await getJSON(`/json/close/${target.id}`).catch(() => {});
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval failed");
  return JSON.parse(result.value);
}

// ── run against each URL ──────────────────────────────────────────────────────
let failures = 0;
for (const url of urls) {
  console.log(`══ ${url} ══`);
  try {
    const t = await extractFromUrl(url);
    const topColors = t.colors.slice(0, 6).map((c) => `${c.value}×${c.count}`).join("  ");
    console.log(`  colors: ${t.colors.length}  |  ${topColors}`);
    console.log(`  fonts: ${t.typography.families.map((f) => `${f.family}(${f.likelyRole})`).join(", ") || "—"}`);
    console.log(`  radii: ${t.radii.slice(0, 5).map((r) => r.value).join(", ") || "—"}`);
    console.log(`  shadows: ${t.shadows.length}  spacing: ${t.spacing.length}  cssVars: ${Object.keys(t.cssVariables).length}  fontFaces: ${t.typography.fontFaces.length}`);
    const inlineN = t.assets.images.filter((i) => i.inline).length;
    console.log(`  assets: ${t.assets.fonts.length} fonts / ${t.assets.images.length} images (${inlineN} inline data:) / ${t.assets.videos.length} videos / ${t.assets.models.length} models`);

    // sanity assertions on a real page
    const checks = [
      [t.colors.length > 3, "extracted multiple colors"],
      [t.colors.every((c) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(c.value)), "all colors normalized to hex"],
      [t.typography.families.length > 0, "found at least one font family"],
      [t.colors[0].count >= t.colors[t.colors.length - 1].count, "colors sorted by frequency"],
      [typeof render.renderDesignMd(t, null, "compact") === "string", "DESIGN.md renders"],
      [render.renderTailwind(t, "compact").startsWith("@theme {"), "Tailwind tab renders"],
      [(() => { try { JSON.parse(render.renderDesignTokensJson(t, "compact")); return true; } catch { return false; } })(), "Design Tokens JSON is valid"],
    ];
    for (const [cond, label] of checks) {
      console.log(`    ${cond ? "✓" : "✗"} ${label}`);
      if (!cond) failures++;
    }
    // show a slice of the real DESIGN.md
    const md = render.renderDesignMd(t, null, "compact");
    console.log("\n  ── DESIGN.md (first 14 lines) ──");
    console.log(md.split("\n").slice(0, 14).map((l) => "  | " + l).join("\n"));
    console.log("");
  } catch (e) {
    failures++;
    console.log("  ✗ ERROR:", e.message, "\n");
  }
}

chrome.kill();
console.log(failures ? `\n${failures} failure(s).` : "\nLive extraction succeeded on all URLs ✓");
process.exit(failures ? 1 : 0);
