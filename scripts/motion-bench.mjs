// The motion benchmark: a fixed set of award-winning sites, each exported with the real extension and then
// measured — the live page and its copy probed in the same run by motion-coverage.mjs, so the numbers compare.
// One site at a time, waiting for a calm machine. Each run is appended to bench-history.json next to the output
// and compared with the previous one.
//
//   node scripts/motion-bench.mjs --out <dir>.noindex [--dist dist-test] [--sites a,b] [--label "what changed"]
//
// Numbers per site: "same" = the share of elements moving on the live page that also move in the copy (the
// honest one); "count" = how many things move in the copy against the live page. Live award sites vary from run
// to run (load timing, intros, randomness), so a few points either way is noise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

const SITES = [
  "https://www.extrafazant.nl/",
  "https://www.wearebulletproof.com/",
  "https://santalarch.com/",
  "https://sweet-tape.com/",
  "https://preymaker.com/",
  "https://jjettas.com/",
  "https://crl-2026.webflow.io/",
  "https://www.framer.com/",
  "https://gsap.com/",
];
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = opt("--out", null);
if (!OUT) { console.error("usage: node scripts/motion-bench.mjs --out <dir>.noindex [--dist dist-test] [--sites url,url] [--label text]"); process.exit(1); }
const DIST = opt("--dist", "dist-test");
const sites = opt("--sites", "") ? opt("--sites", "").split(",") : SITES;
const label = opt("--label", "");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = async (lim = 8) => { while (loadavg()[1] >= lim) { console.log(`  … waiting for a calm machine (load ${loadavg()[1].toFixed(1)})`); await sleep(20000); } };
const host = (u) => new URL(u).host.replace(/^www\./, "");

const rows = [];
for (const url of sites) {
  const h = host(url);
  console.log(`\n▶ ${url}`);
  const dir = join(OUT, h);
  rmSync(dir, { recursive: true, force: true });
  await calm();
  const t0 = Date.now();
  const ex = spawnSync("caffeinate", ["-i", "node", "scripts/verify-extension-real.mjs", url, "--only", "html", "--no-site", "--out", dir], { env: { ...process.env, SL_DIST: DIST }, encoding: "utf8", timeout: 15 * 60000 });
  writeFileSync(join(dir + ".export.log"), (ex.stdout || "") + (ex.stderr || ""));
  const exported = /✓ This page → HTML/.test(ex.stdout || "");
  console.log(`  export: ${exported ? "ok" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!exported) { rows.push({ url, error: "export failed" }); continue; }
  await calm();
  const pr = spawnSync("caffeinate", ["-i", "node", "scripts/motion-coverage.mjs", url, "--out", dir], { encoding: "utf8", timeout: 30 * 60000 });
  writeFileSync(join(dir + ".motion.log"), (pr.stdout || "") + (pr.stderr || ""));
  let r = null;
  try { r = JSON.parse(readFileSync(join(dir, "motion.json"), "utf8"))[0]; } catch { /* probe failed */ }
  if (!r || r.live?.error || r.html?.error) { rows.push({ url, error: `probe: ${r?.live?.error || r?.html?.error || "no result"}` }); console.log(`  probe failed`); continue; }
  const row = {
    url,
    live: { total: r.live.total, reveals: r.live.reveals, scroll: r.live.scroll, loops: r.live.loops },
    copy: { total: r.html.total, reveals: r.html.reveals, scroll: r.html.scroll, loops: r.html.loops },
    same: r.html.matched ?? null,
    count: r.live.total ? Math.round((100 * Math.min(r.html.total, r.live.total)) / r.live.total) : null,
    libs: r.live.libs || [],
  };
  rows.push(row);
  console.log(`  live ${row.live.total} · copy ${row.copy.total} · same elements moving ${row.same}% · count ${row.count}%`);
}

// history: this run next to the previous one
const histFile = join(OUT, "..", "bench-history.json");
let hist = [];
try { hist = JSON.parse(readFileSync(histFile, "utf8")); } catch { /* first run */ }
const prev = hist[hist.length - 1];
const run = { at: new Date().toISOString(), label, dist: DIST, rows };
hist.push(run);
writeFileSync(histFile, JSON.stringify(hist, null, 2));
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad("site", 28)}${pad("live", 7)}${pad("copy", 7)}${pad("same", 8)}${pad("count", 8)}previous same`);
// (a site whose live probe saw nothing move has no score: left out of the averages)
const ok = rows.filter((r) => !r.error && typeof r.same === "number");
for (const r of rows) {
  const p = prev?.rows?.find((x) => x.url === r.url && !x.error);
  if (r.error) { console.log(`${pad(host(r.url), 28)}${r.error}`); continue; }
  console.log(`${pad(host(r.url), 28)}${pad(r.live.total, 7)}${pad(r.copy.total, 7)}${pad(r.same + "%", 8)}${pad(r.count + "%", 8)}${p ? p.same + "%" : "—"}`);
}
const avg = (f) => (ok.length ? Math.round(ok.reduce((a, r) => a + (f(r) || 0), 0) / ok.length) : 0);
console.log(`${pad("average", 28)}${pad("", 14)}${pad(avg((r) => r.same) + "%", 8)}${pad(avg((r) => r.count) + "%", 8)}${prev ? Math.round(prev.rows.filter((r) => !r.error && typeof r.same === "number").reduce((a, r) => a + r.same, 0) / Math.max(1, prev.rows.filter((r) => !r.error && typeof r.same === "number").length)) + "%" : "—"}`);
console.log(`\nHistory: ${histFile}`);
