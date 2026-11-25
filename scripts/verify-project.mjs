// Verifies the zip writer + project builders produce a clean, editable multi-file
// structure with assets as real files and rewritten relative references.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "sl-project-"));
await build({
  entryPoints: { project: "src/panel/project.ts", zip: "src/panel/zip.ts", rp: "src/panel/react-project.ts", fb: "src/shared/fetch-bytes.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
const { buildHtmlProject, makeCollector, systemFontFallback } = await import(pathToFileURL(join(outdir, "project.js")));
const { buildReactViteProject, buildNextProject, buildNextSiteProject, routeOf } = await import(pathToFileURL(join(outdir, "rp.js")));
const { zipSync, strToU8 } = await import(pathToFileURL(join(outdir, "zip.js")));
const { makeByteFetcher } = await import(pathToFileURL(join(outdir, "fb.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const html = `<!doctype html><html><head>
  <link rel="stylesheet" href="/site.css">
  <style>.hero{background:url("/img/bg.png")}
  .masked{mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='url(%23p)'/></svg>")}</style>
</head><body><h1 class="hero">Hello</h1><img src="/img/logo.png"><svg><use xlink:href="/icons/sprite.svg#star"></use></svg></body></html>`;

const resolvers = {
  fetchText: async (u) => (u.includes("site.css") ? '.x{src:url("/fonts/x.woff2")}' : null),
  fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
};

// ── HTML project ──
const htmlProj = await buildHtmlProject(html, "https://ex.com/page", resolvers, "ex.com");
const hpaths = Object.keys(htmlProj).sort();
console.log("  HTML project files:", hpaths.join(", "));
ok(hpaths.includes("index.html") && hpaths.includes("styles.css") && hpaths.includes("README.md"), "HTML project has index.html + styles.css + README");
ok(hpaths.some((p) => p.startsWith("assets/images/")), "images saved under assets/images/");
ok(hpaths.some((p) => p.startsWith("assets/fonts/")), "fonts saved under assets/fonts/");
ok(/<link[^>]+href="\.\/styles\.css"/.test(htmlProj["index.html"]), "index.html links ./styles.css");
ok(!/<style|<link[^>]+site\.css/.test(htmlProj["index.html"]), "inline <style> + external css folded into styles.css");
ok(/url\("assets\/(images|fonts)\//.test(htmlProj["styles.css"]), "CSS url() rewritten to project asset paths");
ok(/fill='url\(%23p\)'/.test(htmlProj["styles.css"]), "url() nested in a data: SVG string not rewritten by the project builder");
ok(/<img[^>]+src="assets\/images\//.test(htmlProj["index.html"]), "img src rewritten to assets/images/");
ok(htmlProj["assets/images/logo.png"] instanceof Uint8Array, "asset stored as real binary file");
ok(/<use href="assets\/images\/sprite\.svg#star"/.test(htmlProj["index.html"]) && "assets/images/sprite.svg" in htmlProj, "external SVG sprite downloaded + <use> rewritten with fragment kept");

// ── React (Vite) + Next.js projects: real component structure ──
const page = `<!doctype html><html lang="fr" class="dark theme-x" data-theme="night"><head><title>Ex Home</title>
<meta name="description" content="An example"><link rel="icon" href="/favicon.png">
<style>.hero{background:url("/img/bg.png")} body>header{color:red}</style></head>
<body class="antialiased"><div id="__next"><div class="app">
  <header class="site-header"><nav aria-label="Primary"><a href="/pricing">Pricing</a><a href="https://other.com/">x</a></nav></header>
  <section data-framer-name="Hero" class="hero"><h1>Build fast</h1><img src="/img/logo.png"><img id="big" src="https://ex.com/img/hero.webp" srcset="https://ex.com/img/hero.webp 3840w" sizes="100vw"><p>Lots of words here to make this section meaningful.</p></section>
  <section class="items-center flex border-b"><h2>Customer Stories</h2><p>Quotes and logos and more words for a real section.</p></section>
  <div class="framer-abc123"></div>
  <footer><p>© Ex</p></footer>
</div></div></body></html>`;
const rv = await buildReactViteProject(page, "https://ex.com/", resolvers, "ex.com");
const rpaths = Object.keys(rv).sort();
console.log("  React (Vite) files:", rpaths.filter((p) => !p.startsWith("public/")).join(", "));
ok(["package.json", "vite.config.js", "index.html", "src/main.jsx", "src/App.jsx", "src/styles/global.css", "README.md", ".gitignore"].every((p) => rpaths.includes(p)), "Vite scaffolding present");
ok(rpaths.includes("src/components/Hero.jsx") && rpaths.includes("src/components/Footer.jsx"), "sections named from the page (Framer layer name, landmark)");
ok(rpaths.includes("src/components/CustomerStories.jsx"), "utility-class section named from its heading, not 'ItemsCenter'");
ok(rpaths.includes("src/components/Header.jsx") || rpaths.includes("src/components/SiteHeader.jsx"), "header component");
ok(!rpaths.some((p) => /Framer|Abc123|Section\d/.test(p)), "tiny empty div inlined, not a component file");
ok(/<div id="__next">[\s\S]*<div className="app">[\s\S]*<Hero \/>/.test(rv["src/App.jsx"]), "wrapper chain kept in App.jsx so selectors still match");
ok(/<div className="framer-abc123" \/>/.test(rv["src/App.jsx"]), "inlined element rendered in place");
const vn = await buildReactViteProject(`<html><body><div id="main"><div data-framer-name="Desktop"><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a></nav></div><section data-framer-name="Pricing"><h2>Plans</h2><p>Words for a real section here.</p></section><div id="__framer-badge-container"><div data-framer-name="Light"><a href="https://framer.com">Made in Framer</a></div></div></div></body></html>`, "https://ex.com/", resolvers, "ex.com");
const vnames = Object.keys(vn).filter((p) => p.startsWith("src/components/")).map((p) => p.split("/").pop().replace(".jsx", ""));
ok(vnames.includes("Header") && vnames.includes("Pricing") && !vnames.includes("Desktop") && !vnames.includes("Light"), `Framer variant names ("Desktop", "Light") not used as component names (${vnames.join(", ")})`);
ok(/<html lang="fr" class="dark theme-x" data-theme="night">/.test(rv["index.html"]) && /<body class="antialiased">/.test(rv["index.html"]), "html/body attributes preserved in index.html");
ok(/createRoot\(document\.body\)/.test(rv["src/main.jsx"]), "mounted into <body> (no extra #root wrapper)");
ok(/href="https:\/\/ex\.com\/pricing"/.test(rv["src/components/Header.jsx"] || rv["src/components/SiteHeader.jsx"] || ""), "same-site links made absolute in a single-page export");
ok(/url\("\/assets\/images\/bg\.png"\)/.test(rv["src/styles/global.css"]) && rv["public/assets/images/bg.png"] instanceof Uint8Array, "CSS assets in public/assets, referenced from web root");
ok(/src="\/assets\/images\/logo\.png"/.test(rv["src/components/Hero.jsx"]), "img src points at /assets/…");
ok(JSON.parse(rv["package.json"]).dependencies.react && JSON.parse(rv["package.json"]).devDependencies.vite, "package.json deps");

{ const img = ((rv["src/components/Hero.jsx"].match(/<img\s+id="big"[^>]*>/) || [""])[0]).replace(/\s+/g, " ");
  ok(/srcSet="\/assets\/images\/[^" ]+ 3840w"/.test(img) && /src="\/assets\/images\//.test(img) && !/\/public\//.test(img), `a capture's one-file srcset points at the same served file as src (${img.slice(0, 160)})`); }
// live Rive / Lottie: the capture's loader travels into both project types
{ const animPage = page.replace("</body>", `<script data-sl-anim-runtime="">(function(){ window.__slAnimRan = true; })();</script></body>`).replace('<footer>', '<div data-sl-anim="lottie" data-sl-anim-src="https://ex.com/a.json"></div><footer>');
  const ra = await buildReactViteProject(animPage, "https://ex.com/", resolvers, "ex.com");
  ok(/export default function playAnimations\(\) \{[\s\S]*__slAnimRan/.test(ra["src/sl-animations.js"] || "") && /import playAnimations from "\.\/sl-animations"/.test(ra["src/main.jsx"]) && /requestAnimationFrame\(\(\) => playAnimations\(\)\)/.test(ra["src/main.jsx"]), "React project plays the page's Rive / Lottie animations after it renders");
  const na = await buildNextProject(animPage, "https://ex.com/", resolvers, "ex.com");
  ok(/"use client"[\s\S]*useEffect\(\(\) => \{[\s\S]*__slAnimRan/.test(na["components/SlAnimations.jsx"] || "") && /<SlAnimations \/>/.test(na["app/layout.jsx"]) && /import SlAnimations from "@\/components\/SlAnimations"/.test(na["app/layout.jsx"]), "Next.js project plays them from a client component in the root layout");
  ok(!rv["src/sl-animations.js"] && !/playAnimations/.test(rv["src/main.jsx"]), "pages without animations get no loader"); }
const nx = await buildNextProject(page, "https://ex.com/", resolvers, "ex.com");
const npaths = Object.keys(nx).sort();
console.log("  Next.js files:", npaths.filter((p) => !p.startsWith("public/")).join(", "));
ok(["package.json", "next.config.mjs", "jsconfig.json", "app/layout.jsx", "app/page.jsx", "app/globals.css", "README.md"].every((p) => npaths.includes(p)), "Next.js App Router scaffolding present");
ok(npaths.includes("components/Hero.jsx") && npaths.includes("components/CustomerStories.jsx"), "components/ folder with named sections");
ok(/import "\.\/globals\.css"/.test(nx["app/layout.jsx"]) && /title: "Ex Home"/.test(nx["app/layout.jsx"]) && /description: "An example"/.test(nx["app/layout.jsx"]), "layout imports CSS and exports metadata");
ok(/<html lang="fr" className="dark theme-x" data-theme="night"/.test(nx["app/layout.jsx"]) && /<body className="antialiased"/.test(nx["app/layout.jsx"]), "html/body attributes as JSX in the root layout");
ok(/import Hero from "@\/components\/Hero"/.test(nx["app/page.jsx"]), "page imports components via @/ alias");
ok(!/"use client"/.test(nx["components/Hero.jsx"]), "plain sections stay Server Components");
ok(/NEXT_OUTPUT === "export"/.test(nx["next.config.mjs"]) && JSON.parse(nx["package.json"]).scripts.export, "static export supported");

// shadow DOM section → client component + runtime
const shadowPage = `<html><body><main><section><h2>Widget area</h2><my-card><template shadowrootmode="open"><b>inside</b></template><span>light</span></my-card><p>More text in this section.</p></section></main></body></html>`;
const sp = await buildNextProject(shadowPage, "https://ex.com/", resolvers, "ex.com");
const shadowComp = Object.entries(sp).find(([p, v]) => /^components\/.+\.jsx$/.test(p) && /shadow\(/.test(String(v)));
ok(!!shadowComp && /^"use client";/.test(String(shadowComp[1])) && /import \{ shadow \} from "@\/components\/sl-runtime"/.test(String(shadowComp[1])) && "components/sl-runtime.js" in sp, "shadow-DOM section becomes a client component using the runtime");

// Next.js site: one route per page, links rewritten to routes
ok(routeOf("https://ex.com/") === "" && routeOf("https://ex.com/About/Team/") === "about/team" && routeOf("https://ex.com/api") === "api-page", "route mapping (case, trailing slash, reserved names)");
const site = await buildNextSiteProject([
  { url: "https://ex.com/", title: "Home", html: page },
  { url: "https://ex.com/pricing", title: "Pricing", html: `<html><head><title>Pricing</title></head><body><main><section><h1>Plans</h1><a href="/">Back home</a><p>Words words words words.</p></section></main></body></html>` },
], resolvers, "ex.com");
const spaths = Object.keys(site).sort();
console.log("  Next.js site files:", spaths.filter((p) => !p.startsWith("public/")).join(", "));
ok(spaths.includes("app/page.jsx") && spaths.includes("app/pricing/page.jsx") && spaths.includes("app/pricing/page.css"), "one route + stylesheet per page");
ok(spaths.some((p) => p.startsWith("components/Home/")) && spaths.some((p) => p.startsWith("components/Pricing/")), "components grouped per page");
ok(/href="\/pricing\/"/.test(Object.entries(site).filter(([p]) => p.startsWith("components/Home/")).map(([, v]) => v).join("")), "internal link rewritten to the exported route");
ok(/title: "Pricing"/.test(site["app/pricing/page.jsx"]), "per-route metadata");

// ── zip writer ──
const zip = zipSync([
  { name: "index.html", data: strToU8("<h1>hi</h1>") },
  { name: "assets/a.bin", data: new Uint8Array([1, 2, 3]) },
]);
ok(zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04, "zip starts with PK local-file signature");
ok(zip.length > 60, "zip has central directory + EOCD");
// EOCD signature near the end
let foundEocd = false;
for (let i = zip.length - 22; i >= 0; i--) {
  if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) { foundEocd = true; break; }
}
ok(foundEocd, "zip ends with a valid EOCD record");

// an image CDN that says "429 Too Many Requests" to a burst, then serves the file: the export must
// really retry (a remembered failure turned every throttled image into "couldn't be downloaded")
{
  let calls = 0;
  const fetcher = makeByteFetcher(25_000_000, async () => { calls++; return calls <= 2 ? new Response("slow down", { status: 429 }) : new Response(new Uint8Array([137, 80, 78, 71])); });
  const a = await fetcher("https://cdn.ex.com/img/a,fit=scale-down"), b = await fetcher("https://cdn.ex.com/img/a,fit=scale-down"), c = await fetcher("https://cdn.ex.com/img/a,fit=scale-down");
  const d = await fetcher("https://cdn.ex.com/img/a,fit=scale-down");
  ok(a === null && b === null && c && c.length === 4 && d === c && calls === 3, `a throttled download is fetched again on retry; a success is reused (${calls} requests)`);
  let n = 0;
  const flaky = makeByteFetcher(25_000_000, async () => (++n <= 2 ? new Response("", { status: 429 }) : new Response(new Uint8Array([71, 73, 70]))));
  const files = await buildNextProject(`<html><head></head><body><section><img src="https://cdn.ex.com/cdn-cgi/imagedelivery/x/f=auto,fit=scale-down"></section></body></html>`, "https://ex.com/", { fetchText: async () => null, fetchBytes: flaky }, "ex.com");
  const imgs = Object.keys(files).filter((k) => /^public\/assets\/images\//.test(k));
  ok(imgs.length === 1 && !/still loaded from the original site/.test(String(files["README.md"] || "")), `a Next.js export recovers images the CDN refused twice (${imgs.join(", ")})`);
}

// the asset collector: several downloads at once (a page naming hundreds of images took minutes one by one),
// never more than 8, the same file fetched once even when asked for twice at the same moment
{
  let active = 0, peak = 0;
  const fetched = new Map();
  const files = {};
  const collect = makeCollector(files, {
    fetchText: async () => null,
    fetchBytes: async (u) => { active++; peak = Math.max(peak, active); fetched.set(u, (fetched.get(u) || 0) + 1); await new Promise((r) => setTimeout(r, 30)); active--; return new Uint8Array([1, 2, 3]); },
  }, "assets");
  const urls = Array.from({ length: 30 }, (_, i) => `https://ex.com/img/p${i % 25}.png`); // 5 asked twice
  const t0 = Date.now();
  const paths = await Promise.all(urls.map((u) => collect(u, "https://ex.com/")));
  const ms = Date.now() - t0;
  ok(peak > 1 && peak <= 8 && [...fetched.values()].every((n) => n === 1) && fetched.size === 25 && new Set(paths).size === 25 && paths.every(Boolean) && ms < 25 * 30, `assets download several at once (peak ${peak}, at most 8), each file once, each its own path (${fetched.size} files in ${ms} ms)`);
}

// Apple's own typefaces, refused to other pages: their stacks fall back to the system font (SF on Apple devices)
{
  const css = `@font-face{font-family:"SF Pro Display";src:url("https://www.apple.com/wss/fonts/sf-pro-display.woff2") format("woff2")}
@font-face{font-family:"Brand";src:url("https://ex.com/brand.woff2")}
@font-face{font-family:"SF Pro Text";src:url("assets/fonts/sf-pro-text.woff2")}
h1{font-family:"SF Pro Display","SF Pro Icons","Helvetica Neue",Helvetica,Arial,sans-serif}
p{font-family:"SF Pro Text","Helvetica Neue",sans-serif}
.b{font-family:Brand,Georgia,serif}`;
  const out = systemFontFallback(css);
  ok(/@font-face\{font-family:"SF Pro Display";src/.test(out) && /h1\{font-family:"SF Pro Display", system-ui, -apple-system,"SF Pro Icons","Helvetica Neue"/.test(out) && /p\{font-family:"SF Pro Text","Helvetica Neue",sans-serif\}/.test(out) && /\.b\{font-family:Brand,Georgia,serif\}/.test(out), "Apple's refused SF fonts fall back to the system font (SF on Apple devices); downloaded ones, other brands' fonts and the @font-face rules themselves are left as they are");
}

// your own 3D model (Studio replaced a scene with a .glb): a real file in every project, the viewer's script loaded
{
  const glb = "Z2xURgIAAAA="; // "glTF" + version 2
  const page = `<html><head></head><body><section><model-viewer data-sl-id="5" data-sl-model="Chair.glb" src="data:model/gltf-binary;base64,${glb}" camera-controls="" auto-rotate="" style="display: block; aspect-ratio: 4 / 3;"><img slot="poster" src="https://ex.com/scene.png" alt=""></model-viewer></section></body></html>`;
  const none = { fetchText: async () => null, fetchBytes: async () => null };
  const h = await buildHtmlProject(page, "https://ex.com/", none, "ex.com");
  const bytes = h["assets/models/chair.glb"];
  ok(bytes instanceof Uint8Array && String.fromCharCode(...bytes.slice(0, 4)) === "glTF" && /<model-viewer[^>]*src="assets\/models\/chair\.glb"/.test(h["index.html"]) && /<script type="module" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@google\/model-viewer@4\.0\.0\/dist\/model-viewer\.min\.js"/.test(h["index.html"]) && !/base64,Z2xURg/.test(h["index.html"]), "HTML export: your 3D model is a real file (assets/models/chair.glb) and the viewer's script is loaded");
  const rx = await buildReactViteProject(page, "https://ex.com/", none, "ex.com");
  const comp = Object.entries(rx).filter(([k]) => /\.jsx$/.test(k)).map(([, v]) => v).join("\n");
  ok(rx["public/assets/models/chair.glb"] instanceof Uint8Array && /<model-viewer[\s\S]*?src="\/assets\/models\/chair\.glb"/.test(comp) && /model-viewer\.min\.js/.test(rx["index.html"]), "React export: the model in public/, the component pointing at it, the viewer's script in index.html");
  const nx = await buildNextProject(page, "https://ex.com/", none, "ex.com");
  ok(nx["public/assets/models/chair.glb"] instanceof Uint8Array && /model-viewer\.min\.js/.test(nx["app/layout.jsx"]), "Next.js export: the model in public/, the viewer's script in the root layout");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Project export verified ✓");
