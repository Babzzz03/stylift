// Verifies: URL normalization + link discovery + sitemap parsing + bounded BFS
// crawl (with a stub capture), the whole-site project builder (per-page folders,
// shared assets, rewritten internal links, scripts), and the Elementor template.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "sl-site-"));
await build({ entryPoints: { crawl: "src/panel/crawl.ts", project: "src/panel/project.ts", elementor: "src/panel/elementor.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
const { normalizeUrl, urlToPagePath, rootPrefix, discoverLinks, parseSitemap, crawlSite } = await import(pathToFileURL(join(outdir, "crawl.js")));
const { buildSiteProject, buildHtmlProject } = await import(pathToFileURL(join(outdir, "project.js")));
const { buildElementorTemplate, findSectionsRoot } = await import(pathToFileURL(join(outdir, "elementor.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

console.log("── url normalization ──");
ok(normalizeUrl("/pricing/?utm=1#top", "https://ex.com/") === "https://ex.com/pricing", "strips query/hash/trailing slash");
ok(normalizeUrl("https://other.com/x", "https://ex.com/") === null, "rejects other hosts");
ok(normalizeUrl("/brochure.pdf", "https://ex.com/") === null && normalizeUrl("/a.jpg", "https://ex.com/") === null, "skips binary/asset URLs");
ok(normalizeUrl("mailto:x@y.z", "https://ex.com/") === null, "rejects non-http");
ok(urlToPagePath("https://ex.com/") === "index.html" && urlToPagePath("https://ex.com/about/") === "about/index.html" && urlToPagePath("https://ex.com/blog/post.html") === "blog/post/index.html", "url → page path");
ok(rootPrefix("index.html") === "" && rootPrefix("a/b/index.html") === "../../", "root prefix by depth");

console.log("── link discovery ──");
const home = `<!doctype html><html><head><base href="https://ex.com/"></head><body>
  <a href="/about">About</a><a href="pricing/">Pricing</a><a href="https://ex.com/about#team">Team</a>
  <a href="https://twitter.com/x">ext</a><a href="mailto:a@b.c">mail</a><a href="/file.zip" download>zip</a><a href="#top">top</a></body></html>`;
const links = discoverLinks(home, "https://ex.com/");
ok(links.length === 2 && links.includes("https://ex.com/about") && links.includes("https://ex.com/pricing"), `same-origin pages discovered + de-duplicated (${links.join(", ")})`);
const sm = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ex.com/</loc></url><url><loc>https://ex.com/blog/</loc></url><url><loc>https://cdn.ex.com/x</loc></url></urlset>`, "https://ex.com");
ok(sm.pages.length === 2 && sm.pages.includes("https://ex.com/blog"), "sitemap urls parsed + filtered to same host");
const smi = parseSitemap(`<sitemapindex><sitemap><loc>https://ex.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`, "https://ex.com");
ok(smi.sitemaps.length === 1, "sitemap index parsed");

console.log("── crawl (stub capture) ──");
const site = {
  "https://ex.com/": home,
  "https://ex.com/about": `<html><body><a href="/">Home</a><a href="/about/team">Team</a><a href="/about/team">dup</a></body></html>`,
  "https://ex.com/pricing": `<html><body><a href="/">Home</a><a href="/deep1">d1</a></body></html>`,
  "https://ex.com/about/team": `<html><body><a href="/deep2">d2</a></body></html>`,
  "https://ex.com/blog": `<html><body>blog</body></html>`,
  "https://ex.com/deep1": `<html><body><a href="/deep3">d3</a></body></html>`,
  "https://ex.com/deep2": `<html><body>x</body></html>`,
  "https://ex.com/deep3": `<html><body>x</body></html>`,
};
const captured = [];
const stub = async (url) => { captured.push(url); if (!site[url]) throw new Error("404"); return { html: site[url], url, title: url, stats: {}, warnings: [] }; };
const progress = [];
const pages = await crawlSite("https://ex.com/?ref=1#x", null, { maxPages: 50, maxDepth: 2, useSitemap: true }, {
  capture: stub, fetchText: async (u) => (u.endsWith("/sitemap.xml") ? `<urlset><url><loc>https://ex.com/blog/</loc></url></urlset>` : null),
  onProgress: (d, q, u) => progress.push(u),
});
const urls = pages.map((p) => p.url);
ok(urls[0] === "https://ex.com/", "start URL normalized + captured first");
ok(urls.includes("https://ex.com/about") && urls.includes("https://ex.com/pricing") && urls.includes("https://ex.com/about/team"), "depth-1 and depth-2 pages captured");
ok(urls.includes("https://ex.com/blog"), "sitemap page captured");
ok(!urls.includes("https://ex.com/deep3"), "depth limit respected (deep3 is depth 3)");
ok(new Set(captured).size === captured.length, "each URL captured once");
ok(pages.every((p) => p.path.endsWith(".html")) && pages.find((p) => p.url === "https://ex.com/about/team").path === "about/team/index.html", "page paths assigned");
ok(progress.length >= pages.length, "progress reported");
const capped = await crawlSite("https://ex.com/", null, { maxPages: 2, maxDepth: 5, useSitemap: false }, { capture: stub });
ok(capped.length === 2, "maxPages cap respected");
// Shopify lists text documents for AI agents in its sitemap (sitemap_agentic_discovery.xml): not pages
const agentic = await crawlSite("https://ex.com/", null, { maxPages: 50, maxDepth: 1, useSitemap: true }, {
  capture: async (url) => (url === "https://ex.com/agents" ? { html: "<html><body><pre># Agent instructions</pre></body></html>", url, title: "", stats: { contentType: "text/markdown" }, warnings: [] } : { html: site[url] || "<html><body>x</body></html>", url, title: url, stats: { contentType: "text/html" }, warnings: [] }),
  fetchText: async (u) => (u.endsWith("/sitemap.xml") ? `<urlset><url><loc>https://ex.com/agents</loc></url><url><loc>https://ex.com/blog</loc></url></urlset>` : null),
});
ok(!agentic.some((p) => p.url === "https://ex.com/agents") && agentic.some((p) => p.url === "https://ex.com/blog"), "a text / Markdown document listed in the sitemap isn't kept as a page");
// a shop: the sitemap lists many products, the home page links its menu; with a page limit the menu comes first
const shopSite = { "https://ex.com/": `<html><body><nav><a href="/collections/jewelry">Jewelry</a><a href="/pages/about">About</a><a href="/products/create-your-own">Create your own</a></nav></body></html>` };
const shop = await crawlSite("https://ex.com/", null, { maxPages: 4, maxDepth: 2, useSitemap: true }, {
  capture: async (url) => ({ html: shopSite[url] || "<html><body>x</body></html>", url, title: url, stats: { contentType: "text/html" }, warnings: [] }),
  fetchText: async (u) => (u.endsWith("/sitemap.xml") ? `<urlset>${Array.from({ length: 40 }, (_, i) => `<url><loc>https://ex.com/products/p${i}</loc></url>`).join("")}</urlset>` : null),
});
ok(["https://ex.com/collections/jewelry", "https://ex.com/pages/about", "https://ex.com/products/create-your-own"].every((u) => shop.some((p) => p.url === u)), `with a page limit, the menu pages come before the sitemap's products (${shop.map((p) => new URL(p.url).pathname).join(", ")})`);
const cancelled = await crawlSite("https://ex.com/", null, { maxPages: 50, maxDepth: 5, useSitemap: false }, { capture: stub, isCancelled: () => true });
ok(cancelled.length === 1, "cancel stops after the current page");

console.log("── site project ──");
const sitePages = [
  { url: "https://ex.com/", path: "index.html", title: "Home", html: `<html><head><base href="https://ex.com/"><style>.a{background:url("https://ex.com/img/bg.png")}</style></head><body><a href="/about#team">About</a><a href="https://ex.com/about/">About2</a><a href="https://other.com/">ext</a><img src="https://ex.com/img/logo.png"><script src="https://ex.com/js/app.js"></script><script type="module" src="https://ex.com/js/m.mjs"></script></body></html>` },
  { url: "https://ex.com/about", path: "about/index.html", title: "About", html: `<html><head><link rel="stylesheet" href="https://ex.com/site.css"></head><body><a href="/">Home</a><img src="https://ex.com/img/logo.png"><video src="https://ex.com/v/clip.mp4"></video></body></html>` },
];
const fetched = [];
const res = { fetchText: async (u) => { fetched.push(u); return u.endsWith("site.css") ? '@font-face{src:url("/fonts/x.woff2")}' : null; }, fetchBytes: async (u) => { fetched.push(u); return new Uint8Array([1, 2, 3]); } };
const proj = await buildSiteProject(sitePages, res, "ex.com");
const paths = Object.keys(proj).sort();
console.log("  files:", paths.join(", "));
ok(paths.includes("index.html") && paths.includes("about/index.html"), "one folder per page");
ok(paths.includes("styles/index.css") && paths.includes("styles/about.css"), "per-page stylesheet");
ok(/href="about\/index\.html#team"/.test(proj["index.html"]) && /href="about\/index\.html"/.test(proj["index.html"]), "internal links rewritten (hash kept, trailing-slash variant matched)");
ok(/href="\.\.\/index\.html"/.test(proj["about/index.html"]), "links from nested page use ../");
ok(/href="https:\/\/other\.com\/"/.test(proj["index.html"]), "external links left absolute");
ok(/<img src="\.\.\/assets\/images\/logo\.png"/.test(proj["about/index.html"]) && /<img src="assets\/images\/logo\.png"/.test(proj["index.html"]), "shared asset referenced with the right depth prefix");
ok(fetched.filter((u) => u.endsWith("logo.png")).length === 1, "shared asset fetched once");
ok(/url\("\.\.\/assets\/images\/bg\.png"\)/.test(proj["styles/index.css"]) && /url\("\.\.\/assets\/fonts\/x\.woff2"\)/.test(proj["styles/about.css"]), "CSS url()s point to ../assets from styles/");
ok(/<script src="assets\/js\/app\.js">/.test(proj["index.html"]) && paths.includes("assets/js/app.js"), "classic script downloaded to assets/js");
ok(/<script type="module" src="https:\/\/ex\.com\/js\/m\.mjs">/.test(proj["index.html"]), "ES module script kept absolute");
ok(/<video src="\.\.\/assets\/media\/clip\.mp4">/.test(proj["about/index.html"]), "video src collected");
ok(!/<base/.test(proj["index.html"]) && /<link rel="stylesheet" href="styles\/index\.css">/.test(proj["index.html"]), "base removed, stylesheet linked");
ok(/## Pages/.test(proj["README.md"]), "README lists pages");
const single = await buildHtmlProject(sitePages[0].html, "https://ex.com/", res, "ex.com");
ok(/<script src="assets\/js\/app\.js">/.test(single["index.html"]), "single-page HTML project also localizes scripts");

console.log("── elementor template ──");
const page = `<!doctype html><html><head><style>.hero{color:red}</style><link rel="stylesheet" href="https://ex.com/x.css"></head><body><div id="__next"><div class="app"><header class="hero">Top</header><section id="s1">One</section><footer>End</footer></div></div><script type="application/ld+json">{}</script></body></html>`;
const t = buildElementorTemplate(page, "Ex");
ok(t.version === "0.4" && t.type === "page" && t.title === "Ex" && Array.isArray(t.content) && typeof t.page_settings === "object", "template envelope (version/type/title/content/page_settings)");
ok(t.content.length === 4, `styles container + 3 sections (${t.content.length})`);
ok(t.content.every((c) => c.elType === "container" && c.elements.length === 1 && c.elements[0].elType === "widget" && c.elements[0].widgetType === "html"), "every section is a container holding an HTML widget");
ok(/\.hero{color:red}/.test(t.content[0].elements[0].settings.html) && /<link rel="stylesheet" href="https:\/\/ex\.com\/x\.css">/.test(t.content[0].elements[0].settings.html), "page CSS + external sheets carried in the first widget");
ok(/<header class="hero">Top<\/header>/.test(t.content[1].elements[0].settings.html) && /<footer>End<\/footer>/.test(t.content[3].elements[0].settings.html), "sections carry their markup");
ok(new Set(t.content.flatMap((c) => [c.id, ...c.elements.map((e) => e.id)])).size === 8 && t.content.every((c) => /^[0-9a-f]{7}$/.test(c.id)), "unique 7-hex element ids");
const doc = new DOMParser().parseFromString(page, "text/html");
ok(findSectionsRoot(doc.body).className === "app", "framework wrapper roots skipped");
ok(JSON.parse(JSON.stringify(t)).content.length === 4, "serializable JSON");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Site crawl / site project / Elementor export verified ✓");
