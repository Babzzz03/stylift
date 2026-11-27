// Builds the StyleLift plugin for Figma (figma-plugin/): the builder (code.js, run in Figma's sandbox) and its
// window (ui.html, one file with its script inline, as Figma wants). A copy goes to public/figma-plugin/ so every
// Figma bundle the extension exports carries the plugin too (import it once from its manifest).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "figma-plugin");
const dist = join(dir, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// (Figma's sandbox: plain ES2017 is the safe ground)
const common = { bundle: true, format: "iife", target: "es2017", minify: true, legalComments: "none", logLevel: "warning" };
await build({ ...common, entryPoints: [join(dir, "src/code.ts")], outfile: join(dist, "code.js") });
const ui = await build({ ...common, entryPoints: [join(dir, "src/ui.ts")], write: false, target: "es2020" });
const script = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(join(dir, "src/ui.html"), "utf8").replace("/*UI_SCRIPT*/", () => script);
writeFileSync(join(dist, "ui.html"), html);

const pub = join(root, "public/figma-plugin");
rmSync(pub, { recursive: true, force: true });
mkdirSync(join(pub, "dist"), { recursive: true });
cpSync(join(dir, "manifest.json"), join(pub, "manifest.json"));
cpSync(join(dist, "code.js"), join(pub, "dist/code.js"));
cpSync(join(dist, "ui.html"), join(pub, "dist/ui.html"));
console.log(`Figma plugin built: code.js ${(readFileSync(join(dist, "code.js")).length / 1024).toFixed(1)} KB, ui.html ${(html.length / 1024).toFixed(1)} KB`);
