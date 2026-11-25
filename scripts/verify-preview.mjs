// Preview without deploying: the answers the preview tab gets for each request, from a real mirror built
// by the shipped builder and from a plain HTML export. (The Chrome side — the debugger pausing requests —
// is covered by verify-e2e.mjs, which clicks Preview in the real extension.)
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const od = mkdtempSync(join(tmpdir(), "sl-preview-"));
await build({ entryPoints: { m: "src/panel/mirror.ts", p: "src/panel/preview.ts", i: "src/panel/islands.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { buildSiteMirror } = await import(pathToFileURL(join(od, "m.js")));
const { makePreviewResolver, previewOrigin, typeOfPath } = await import(pathToFileURL(join(od, "p.js")));
const { islandFiles } = await import(pathToFileURL(join(od, "i.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const text = (a) => (a && a.kind === "file" ? new TextDecoder().decode(a.body) : "");
const header = (a, n) => (a && a.kind === "file" ? (a.headers.find(([k]) => k.toLowerCase() === n.toLowerCase()) || [])[1] : undefined);

// ── a two-page site with a CDN, a query-string image, a model and a video ──
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const video = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const words = "A studio that builds websites people remember. ".repeat(6);
const remote = {
  "https://ex.com/js/app.js": ["text/javascript", `fetch("https://cdn.other.net/data.json")`],
  "https://cdn.other.net/data.json": ["application/json", `{"ok":true}`],
  "https://cdn.other.net/scene.glb": ["model/gltf-binary", png],
  "https://ex.com/img/a.png?v=2": ["image/png", png],
  "https://ex.com/media/reel.mp4": ["video/mp4", video],
};
const m = await buildSiteMirror(
  [
    { url: "https://ex.com/", html: `<!doctype html><html><head><title>Studio home</title></head><body><h1>Home</h1><p>${words}</p><img src="/img/a.png?v=2"><video src="/media/reel.mp4"></video><a href="/about">About</a><script src="/js/app.js"></script></body></html>` },
    { url: "https://ex.com/about", html: `<!doctype html><html><head><title>About the studio</title></head><body><h1>About us</h1><p>${words}</p></body></html>` },
  ],
  Object.keys(remote),
  { fetchFile: async (u) => (remote[u] ? { type: remote[u][0], bytes: typeof remote[u][1] === "string" ? new TextEncoder().encode(remote[u][1]) : remote[u][1] } : null) },
);
const origin = previewOrigin("https://www.ex.com/");
ok(origin === "https://ex-com.stylelift.test", `the preview opens at a private .test address (${origin})`);
const R = makePreviewResolver(m.files, origin);
const get = (url, resourceType = "Other", headers = {}, method = "GET") => R({ url, method, headers, resourceType });

const home = get(origin + "/", "Document");
ok(home.kind === "file" && home.status === 200 && /<title>Studio home<\/title>/.test(text(home)), "the home page is the site's own HTML");
ok(/data-sl-mirror/.test(text(home)) && /stylelift-custom\.css/.test(text(home)), "…with the mirror's guard script and your styles layer, as published");
const about = get(origin + "/about", "Document");
ok(/About the studio/.test(text(about)), "a second page opens at its own address");
const miss = get(origin + "/no-such-page", "Document");
ok(miss.status === 404 && /isn't in the mirror/.test(text(miss)) && /About the studio/.test(text(miss)), "an address that wasn't mirrored shows the \"not in this mirror\" page with the page list");
const js = get(origin + "/js/app.js", "Script");
ok(js.kind === "file" && /cdn\.other\.net\/data\.json/.test(text(js)) && /javascript/.test(header(js, "content-type")), "the site's script, byte for byte, with its type");
const img = get(origin + "/img/a.png?v=2", "Image");
ok(img.kind === "file" && img.body.length === png.length && header(img, "content-type") === "image/png", "a query-string image (?v=2) is answered from its stored file");
const abs = get("https://ex.com/img/a.png?v=2", "Image");
ok(abs.kind === "file" && abs.body.length === png.length, "a file asked for at the site's real address is answered from the mirror");
const cdn = get("https://cdn.other.net/data.json", "Fetch", { Origin: origin });
ok(text(cdn) === `{"ok":true}` && header(cdn, "access-control-allow-origin") === origin && header(cdn, "access-control-allow-credentials") === "true", "a CDN file the code fetches comes from the mirror, readable across domains (CORS)");
const pre = get("https://cdn.other.net/scene.glb", "Preflight", { Origin: origin, "Access-Control-Request-Headers": "x-a" }, "OPTIONS");
ok(pre.status === 204 && header(pre, "access-control-allow-headers") === "x-a", "a CORS preflight for a mirrored file is answered");
const part = get(origin + "/media/reel.mp4", "Media", { Range: "bytes=100-199" });
ok(part.status === 206 && part.body.length === 100 && part.body[0] === 100 && header(part, "content-range") === "bytes 100-199/1000", "a video asks for a byte range and gets exactly those bytes (206)");
const head = get(origin + "/media/reel.mp4", "Media", {}, "HEAD");
ok(head.status === 200 && head.body.length === 0, "HEAD gets the headers without the body");
const gone = get(origin + "/js/not-captured.js", "Script");
ok(gone.kind === "continue" && gone.url === "https://ex.com/js/not-captured.js", "a file that wasn't captured is fetched from the original site, as the published mirror does");
const other = get("https://fonts.example.org/x.woff2", "Font");
ok(other.kind === "continue" && !other.url, "a domain the mirror doesn't know goes online untouched");
const post = get(origin + "/api/form", "XHR", {}, "POST");
ok(post.kind === "continue", "form posts and other writes go online untouched");
ok(get(origin + "/sl-mirror-sw.js", "Script").status === 404, "the mirror's service worker isn't served (the preview answers requests itself)");

// your styles: an edit to the files shows on the next request
m.files["site/stylelift-custom.css"] = "body{background:rgb(1,2,3)}";
ok(text(get(origin + "/stylelift-custom.css", "Stylesheet")) === "body{background:rgb(1,2,3)}", "an edit to stylelift-custom.css is what the next request gets");

// an app that routes in the browser (empty shell): unknown addresses get its shell
const app = await buildSiteMirror([{ url: "https://app.dev/", html: `<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>` }], [], { fetchFile: async () => null });
const A = makePreviewResolver(app.files, previewOrigin("https://app.dev/"));
ok(/<title>App<\/title>/.test(text(A({ url: "https://app-dev.stylelift.test/settings/profile", method: "GET", headers: {}, resourceType: "Document" }))), "an app's own routes get its shell (it routes in the browser)");

// ── a plain HTML export (no manifest): static files ──
const files = { "index.html": "<!doctype html><title>Home</title>", "about/index.html": "<!doctype html><title>About</title>", "styles.css": "body{}", "assets/a.png": png };
const S = makePreviewResolver(files, "https://ex-com.stylelift.test");
const sget = (p, t = "Other") => S({ url: "https://ex-com.stylelift.test" + p, method: "GET", headers: {}, resourceType: t });
ok(/Home/.test(text(sget("/", "Document"))), "HTML export: / is index.html");
ok(/About/.test(text(sget("/about", "Document"))) && /About/.test(text(sget("/about/", "Document"))), "HTML export: a folder's index.html, with or without the slash");
ok(header(sget("/styles.css"), "content-type").startsWith("text/css") && sget("/assets/a.png").body.length === png.length, "HTML export: styles and images with their types");
ok(sget("/nope", "Document").status === 404, "HTML export: a missing page is a 404 page");
ok(typeOfPath("x/scene.glb") === "model/gltf-binary" && typeOfPath("a.wasm") === "application/wasm", "content types for 3D models and WebAssembly");

// ── live 3D scenes in an edited page (Studio's Preview): the scene frames get the site's page and files ──
{
  const scenes = islandFiles(m, "https://ex.com/");
  const files = { "index.html": `<!doctype html><html><body><img data-sl-island="0" src="x.png"><script src="/js/app.js"></script></body></html>`, "js/app.js": "/* the edited page's own app.js */", ...scenes };
  const I = makePreviewResolver(files, "https://ex-com.stylelift.test");
  const page = I({ url: "https://ex-com.stylelift.test/", method: "GET", headers: {}, resourceType: "Document", frameId: "top" });
  const sceneDoc = I({ url: "https://ex-com.stylelift.test/?sl-island=0&sl-sel=%23bg", method: "GET", headers: {}, resourceType: "Document", frameId: "f3d" });
  const fromScene = I({ url: "https://ex-com.stylelift.test/js/app.js", method: "GET", headers: {}, resourceType: "Script", frameId: "f3d" });
  const fromPage = I({ url: "https://ex-com.stylelift.test/js/app.js", method: "GET", headers: {}, resourceType: "Script", frameId: "top" });
  const cdn = I({ url: "https://cdn.other.net/scene.glb", method: "GET", headers: {}, resourceType: "Fetch", frameId: "f3d" });
  ok(/data-sl-island="0"/.test(text(page)) && /sl-island\.js/.test(text(sceneDoc)) && /<h1>Home<\/h1>/.test(text(sceneDoc)), "Studio's preview: your edited page, and the site's own page inside a 3D scene's frame");
  if (process.env.SL_DEBUG) console.log(JSON.stringify({ scene: fromScene.kind === "file" ? text(fromScene).slice(0, 80) : fromScene, page: fromPage.kind === "file" ? text(fromPage).slice(0, 60) : fromPage, cdn: cdn.kind === "file" ? cdn.body.length : cdn, keys: Object.keys(scenes).slice(0, 12) }));
  const sceneJs = I({ url: "https://ex-com.stylelift.test/_3d/sl-island.js", method: "GET", headers: {}, resourceType: "Script", frameId: "f3d" });
  ok(/__slIsland/.test(text(sceneJs)) && /javascript/.test(header(sceneJs, "content-type") || ""), "…the scene frame's own script comes from the export (not the original site)");
  ok(/fetch\("https:\/\/cdn\.other\.net/.test(text(fromScene)) && /edited page's own/.test(text(fromPage)) && cdn.kind === "file" && cdn.body.length === png.length, "…the scene frame gets the site's own files (its CDN's too); your page keeps its own at the same address");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Preview verified ✓");
