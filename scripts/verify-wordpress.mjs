// Website → WordPress section importer: CSS scoping, section picking, template build
// (extension side) and the WordPress plugin's own logic (PHP, when php is installed).
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const outdir = mkdtempSync(join(tmpdir(), "sl-wp-"));
await build({ entryPoints: { el: "src/panel/elementor.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const { scopeCss, listSections, buildElementorTemplate } = await import(pathToFileURL(join(outdir, "el.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const css = `:root{--brand:#f60} html{font-size:16px} body.dark .hero{color:red} html.js body > main{margin:0} * {box-sizing:border-box} .card, .card:hover{color:blue}
@media (max-width:600px){ body{padding:0} .hero h1{font-size:2rem} } @keyframes pop{from{opacity:0}} @font-face{font-family:X;src:url(x.woff2)} @import url("a.css"); @layer base, theme;
a[title="a,b"]{color:green} .x:is(.a,.b){color:pink}`;
const sc = scopeCss(css, "sl-scope-t");
ok(/\.sl-scope-t\{--brand:#f60\}/.test(sc), ":root custom properties move onto the wrapper");
ok(/\.sl-scope-t\.dark \.hero\{color:red\}/.test(sc), "body classes stay as qualifiers on the wrapper");
ok(/\.sl-scope-t\.js main\{margin:0\}/.test(sc), "html.js body > main → wrapper with html's class");
ok(/\.sl-scope-t \*\s*\{box-sizing/.test(sc), "universal rules stay inside the wrapper");
ok(/\.sl-scope-t \.card, \.sl-scope-t \.card:hover\{/.test(sc), "selector lists are scoped one by one");
ok(/@media \(max-width:600px\)\{[\s\S]*\.sl-scope-t\{padding:0\}[\s\S]*\.sl-scope-t \.hero h1\{/.test(sc), "rules inside @media are scoped");
ok(/@keyframes pop\{from\{opacity:0\}\}/.test(sc) && /@font-face\{font-family:X/.test(sc) && /@import url\("a\.css"\);/.test(sc) && /@layer base, theme;/.test(sc), "keyframes, font faces, imports and layer orders stay global");
ok(/\.sl-scope-t a\[title="a,b"\]\{color:green\}/.test(sc) && /\.sl-scope-t \.x:is\(\.a,\.b\)\{/.test(sc), "commas inside attribute values and :is() are not split");

const page = `<!doctype html><html class="js" style="--gap: 8px; color: red"><head><style>body{margin:0} .hero{color:red}</style></head>
<body class="dark"><main><header><nav>Logo</nav></header><section data-framer-name="Hero"><h1>Build faster</h1></section><section id="pricing"><h2>Plans for every team</h2></section><footer>© 2026</footer></main></body></html>`;
const secs = listSections(page);
ok(secs.length === 4 && /header/.test(secs[0].label) && /^Hero · Build faster$/.test(secs[1].label) && /^pricing · Plans for every team$/.test(secs[2].label) && /footer/.test(secs[3].label), `sections listed with recognisable names (${secs.map((s) => s.label).join(" | ")})`);
const tpl = buildElementorTemplate(page, "Pricing", { only: [2], scoped: true });
const htmls = tpl.content.map((c) => c.elements[0].settings.html);
ok(tpl.content.length === 2 && /Plans for every team/.test(htmls[1]) && !/Build faster/.test(htmls.join("")), "only the chosen section is sent (plus its styles)");
const scope = (htmls[1].match(/class="(sl-scope-[a-z0-9]+) js dark"/) || [])[1];
ok(!!scope && /style="--gap: 8px"/.test(htmls[1]), "section wrapped with the page's html/body classes and custom properties (not other inline styles)");
ok(!!scope && new RegExp(`\\.${scope}\\{margin:0\\}`).test(htmls[0]) && new RegExp(`\\.${scope} \\.hero\\{color:red\\}`).test(htmls[0]), "page CSS scoped to that wrapper");
ok(tpl.type === "section", "template type is section when importing a selection");
const whole = buildElementorTemplate(page, "Whole page");
ok(whole.content.length === 5 && whole.type === "page" && /<style>[\s\S]*body\{margin:0\}/.test(whole.content[0].elements[0].settings.html), "whole-page export unchanged (unscoped, every section)");

// the plugin's PHP logic
const php = spawnSync("php", ["-v"], { encoding: "utf8" });
if (php.status === 0) {
  const r = spawnSync("php", ["wordpress-plugin/tests/unit.php"], { encoding: "utf8" });
  process.stdout.write(r.stdout.split("\n").filter((l) => /✓|✗/.test(l)).map((l) => "  [php]" + l.replace(/^\s+/, " ")).join("\n") + "\n");
  ok(r.status === 0, "WordPress plugin logic (sanitizer, image import)");
  for (const f of ["stylelift-importer.php", "includes/class-stylelift-importer.php", "includes/class-stylelift-sanitizer.php", "includes/class-stylelift-admin.php"]) {
    const l = spawnSync("php", ["-l", `wordpress-plugin/stylelift-importer/${f}`], { encoding: "utf8" });
    ok(l.status === 0, `php -l ${f}`);
  }
} else console.log("  (php not installed: plugin PHP checks skipped)");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("WordPress importer verified ✓");
