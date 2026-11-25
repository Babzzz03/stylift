// Package the WordPress plugin as a zip WordPress can install (Plugins → Add New →
// Upload), into public/ so the extension ships it and Settings can offer it.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "wordpress-plugin";
const out = join(process.cwd(), "public", "stylelift-importer.zip");
if (existsSync(out)) rmSync(out);
const r = spawnSync("zip", ["-r", "-q", "-X", out, "stylelift-importer", "-x", "*.DS_Store"], { cwd: root, encoding: "utf8" });
if (r.status !== 0) {
  console.error("Could not build the WordPress plugin zip:", r.stderr || r.error);
  process.exit(1);
}
console.log(`WordPress plugin → public/stylelift-importer.zip (${(statSync(out).size / 1024).toFixed(1)} KB)`);
