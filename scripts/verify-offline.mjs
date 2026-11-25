// Verifies the offline inliner: external stylesheet inlining + asset → data: URI
// embedding, using stub resolvers (no network).
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "sl-offline-"));
await build({ entryPoints: { offline: "src/panel/offline.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
const { inlineForOffline, inlineStylesheetLinks, inlineFontFaces } = await import(pathToFileURL(join(outdir, "offline.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const html = `<!doctype html><html><head>
  <link rel="stylesheet" href="/styles/site.css">
  <style>.hero{background:url("/img/bg.png")}</style>
</head><body>
  <img src="/img/logo.png" srcset="/img/logo@2x.png 2x">
  <img id="kept" src="https://cdn.example.com/hero.png" srcset="https://cdn.example.com/hero.png 400w" sizes="200px">
  <div style="background-image:url('/img/tile.svg')"></div>
</body></html>`;

const resolvers = {
  fetchText: async (url) =>
    url.includes("site.css") ? '@font-face{font-family:X;src:url("/fonts/x.woff2")}' : null,
  fetchData: async (url) => "data:application/octet-stream;base64,AAA#" + url.split("/").pop(),
};

const out = await inlineForOffline(html, "https://example.com/page", resolvers);

ok(!/<link[^>]+stylesheet/i.test(out), "external <link> stylesheet inlined (no link tag left)");
ok(out.includes("@font-face") && out.includes("data:application/octet-stream;base64,AAA#x.woff2"), "font url() inside the linked CSS embedded as data URI");
ok(out.includes("data:application/octet-stream;base64,AAA#bg.png"), "CSS background url() embedded");
ok(/<img[^>]+src="data:application\/octet-stream;base64,AAA#logo.png"/.test(out), "img src embedded as data URI");
ok(!/srcset="\/img\/logo@2x/.test(out) && !/srcset="data:[^"]* 2x"/.test(out), "a srcset naming other files is removed once src is inlined");
ok(/id="kept"[^>]*srcset="data:application\/octet-stream;base64,AAA#hero\.png 400w"/.test(out) && /id="kept"[^>]*sizes="200px"/.test(out), "a capture's one-file srcset moves with the inlined image (keeps its intrinsic size)");
ok(out.includes("AAA#tile.svg"), "inline style url() embedded");
ok(out.startsWith("<!doctype html>"), "output is a full HTML document");

const linksOnly = await inlineStylesheetLinks(`<html><head><link rel="stylesheet" href="https://cdn.ex.com/a.css" media="screen"></head><body><img src="/img/x.png"></body></html>`, "https://ex.com/p", async (u) => (u === "https://cdn.ex.com/a.css" ? ".a{background:url(bg.png)}" : null));
ok(/<style data-sl-href="https:\/\/cdn\.ex\.com\/a\.css" media="screen">\.a\{background:url\("https:\/\/cdn\.ex\.com\/bg\.png"\)\}<\/style>/.test(linksOnly), "links-only inliner embeds CDN CSS with absolutized url()s + media");
ok(/<img src="\/img\/x\.png">/.test(linksOnly), "links-only inliner leaves assets untouched");

// a "stylesheet" URL that answers with an HTML page must never be embedded
const trap = await inlineForOffline(`<html><head><link rel="stylesheet" href="/login-wall.css"><link rel="stylesheet" href="/real.css"></head><body><p>ok</p></body></html>`, "https://ex.com/", {
  fetchText: async (u) => (u.endsWith("login-wall.css") ? "<!DOCTYPE html><html><head><style>x{}</style><script src=evil.js></script></head><body>Sign in</body></html>" : ".a{color:red} /* </style><script>alert(1)</script> */"),
  fetchData: async () => null,
});
const trapDoc = new dom.window.DOMParser().parseFromString(trap, "text/html");
ok(trapDoc.querySelectorAll("script").length === 0 && !/Sign in/.test(trapDoc.body.textContent) && !/evil\.js/.test(trap), "HTML returned for a stylesheet URL is not embedded (no script break-out)");
ok(/<link rel="stylesheet" href="\/login-wall\.css">/.test(trap) && /\.a\{color:red\}/.test(trap) && /<\\\/style>/.test(trap), "real CSS embedded with '</style' neutralised; the bad link is left as a link");

// Studio's Preview: only the fonts embedded (a private-origin page can't load them across origins)
{
  const asked = [];
  const page = `<style>@font-face{font-family:A;src:url("https://site.test/f/a.woff2") format("woff2"),url(https://site.test/f/a.woff) format("woff")} .hero{background:url(https://site.test/bg.png)}</style><style>@font-face{font-family:B;src:url(/f/b.woff2)}</style><img src="https://site.test/x.png">`;
  const out = await inlineFontFaces(page, "https://site.test/page", async (u) => (asked.push(u), u.endsWith(".woff") ? null : "data:font/woff2;base64,AAAA"));
  ok(/src:url\("data:font\/woff2;base64,AAAA"\) format\("woff2"\),url\(https:\/\/site\.test\/f\/a\.woff\)/.test(out) && /src:url\("?data:font\/woff2;base64,AAAA"?\)\}/.test(out), "preview fonts: each @font-face file embedded (relative ones resolved), one that couldn't be fetched stays linked");
  ok(/url\(https:\/\/site\.test\/bg\.png\)/.test(out) && /<img src="https:\/\/site\.test\/x\.png">/.test(out) && asked.length === 3 && asked.includes("https://site.test/f/b.woff2"), `preview fonts: images and backgrounds stay linked, nothing else fetched (${asked.join(", ")})`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Offline export verified ✓");
