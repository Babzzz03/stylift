// "Report a problem": the text the user reviews, the mailto link their email app opens, and the opt-outs.
// (A placeholder address is used here; the real one comes from VITE_SUPPORT_EMAIL at build time.)
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const od = mkdtempSync(join(tmpdir(), "sl-report-"));
await build({ entryPoints: { r: "src/shared/report.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const { reportText, reportMailto, browserLabel, SUPPORT_EMAIL } = await import(pathToFileURL(join(od, "r.js")));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const base = { site: "https://lusion.co/projects", action: "Live mirror (.zip)", outcome: "Live mirror downloaded, but INCOMPLETE: 2 of the page's own scripts…", note: "The 3D scene is missing.", log: ["→ https://lusion.co/", "  ✓ 812 files loaded"], includeSite: true, includeLog: true, version: "0.2.0", browser: "Chrome 142 · macOS" };
const t = reportText(base);
ok(/Site: https:\/\/lusion\.co\/projects/.test(t) && /What I clicked: Live mirror \(\.zip\)/.test(t) && /INCOMPLETE/.test(t) && /3D scene is missing/.test(t) && /812 files loaded/.test(t), "the report holds the site, the button, what happened, the note and the log");
const quiet = reportText({ ...base, includeSite: false, includeLog: false });
ok(!/lusion/.test(quiet) && /Site: \(left out\)/.test(quiet) && !/Panel log/.test(quiet), "leaving out the site address and the log removes both");
const m = reportMailto(base, "support@example.com");
ok(m.href.startsWith("mailto:support@example.com?subject=") && decodeURIComponent(m.href.split("subject=")[1].split("&")[0]) === "StyleLift problem on lusion.co — Live mirror (.zip)" && !m.shortened, "the email goes to support, with a subject naming the site and the button");
ok(decodeURIComponent(m.href.split("&body=")[1]) === t, "the email body is exactly the report the user reviewed");
const long = reportMailto({ ...base, log: Array.from({ length: 40 }, (_, i) => `  line ${i} ${"x".repeat(80)}`) }, "support@example.com");
ok(long.shortened && decodeURIComponent(long.href.split("&body=")[1]).length < 2000 && /copied to the clipboard/.test(decodeURIComponent(long.href)), "a long report is shortened for the mail app, pointing to the full copy on the clipboard");
ok(browserLabel("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", "MacIntel") === "Chrome 142 · macOS" && /^Edge 140 · Windows$/.test(browserLabel("… Chrome/140.0 Safari/537.36 Edg/140.0", "Win32")), "browser and system named plainly");
ok(typeof SUPPORT_EMAIL === "string", "the support address comes from the build setting (empty here)");
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Report a problem verified ✓");
