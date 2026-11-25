// Live mirror export: the site's own page, code and files, so 3D scenes, WebGL, Rive,
// physics and every interaction run exactly as on the original.
//
// It starts from the page's ORIGINAL HTML (as its server sends it) — not StyleLift's
// snapshot, which the site's code would trip over — and downloads every file the page
// loaded while StyleLift scrolled it (scripts, chunks, WebAssembly, 3D models, textures,
// fonts, data). Files are stored byte for byte: the site's code is never edited (editing
// URLs inside code breaks code that parses them, e.g. `new URL(src)`, and integrity hashes).
// Instead a service worker answers every request for an original URL — the site's own
// domain or a CDN — with the stored copy, under the original URL, so module imports and
// CSS url()s resolve exactly as on the real site. A small server (server.mjs) serves it all
// with the right types and installs the worker before the site's code runs.
//
// It runs the site's actual code: mirror only sites you own or have permission to copy.

import { collectCssUrls } from "./css-url";

export interface MirrorResolvers {
  /** bytes + content type of a URL (null when it can't be fetched) */
  fetchFile(url: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  /** pauses before re-trying essential files (tests shorten them) */
  retryWaitsMs?: number[];
  /** files not to store (a live 3D scene's copy leaves out the page's own pictures and videos) */
  skip?: (url: string) => boolean;
}
export interface MirrorResult {
  files: Record<string, Uint8Array | string>;
  /** URLs the page used that could not be downloaded (they stay pointed at the original) */
  missing: string[];
  /** missing files the pages can't work without: their own scripts and stylesheets */
  missingEssential: string[];
  /** files stored */
  count: number;
  bytes: number;
  entryPath: string;
  /** pages stored with their own original HTML */
  pages: number;
}
/** One page of the site: its URL and its ORIGINAL HTML (as the server sends it). */
export interface MirrorPage {
  url: string;
  html: string;
}

// trackers / ads: pointless in a mirror (and they would report fake visits)
const SKIP_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|facebook\.com|connect\.facebook\.net|hotjar\.com|segment\.(io|com)|clarity\.ms|mixpanel\.com|intercom\.io|hs-analytics\.net|hs-scripts\.com|sentry\.io|plausible\.io|fullstory\.com|tiktok\.com|linkedin\.com|bing\.com|cookiebot\.com|onetrust\.com|cookielaw\.org|usercentrics\.eu|analytics\.google\.com|merchant-center-analytics\.goog|attn\.tv|attentivemobile\.com)$/i;
// tracking and live-data endpoints on hosts that also serve real files (www.google.com serves reCAPTCHA; a
// shop's own domain serves its pages): analytics beacons, ad conversion pings, Shopify's web-pixel sandboxes,
// checkout preloads, GraphQL APIs (live data — one saved answer is meaningless), and Next.js router
// prefetches (?_rsc=: they need special request headers — fetched plainly they come back as whole HTML
// pages, 1–2 MB each, the wrong content; without them Next.js simply loads the page normally)
const SKIP_URL = /\/(?:g|j|r|mc)\/collect\b|\/ccm\/collect|\/pagead\/|\/rmkt\/|\/web-pixels@|\/\.well-known\/shopify\/monorail|\/checkouts\/internal\/preloads|\/api\/collect\b|\/graphql(?:\.json)?(?:[/?]|$)|[?&]_rsc=/i;
const MAX_FILE = 60_000_000;
const MAX_LAZY = 1200; // on-demand chunks + assets named in code, fetched beyond what the page loaded
const MAX_TOTAL = 500_000_000;
// pictures / videos only NAMED in code (not loaded by the page), from folders the page never loaded
// anything from: other pages' and other languages' media (notion.com's bundle names 140 MB of them).
// Models, textures, WebAssembly and code are never capped; nor is media from folders the page used.
const QUIET_MEDIA_MAX = 25_000_000;
const QUIET_MEDIA = /\.(png|jpe?g|webp|avif|gif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a)$/i;
const dirOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname.replace(/[^/]*$/, "");
  } catch {
    return "";
  }
};
/** "fr-FR" / "ja-JP" in a file's path: the language it is for (null when it names none). */
export function pathLanguage(u: string): string | null {
  try {
    const m = /(?:^|[/_.-])([a-z]{2})-([A-Z]{2})(?=[/_.-]|$)/.exec(new URL(u).pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const safeSeg = (s: string) => s.replace(/[^\w.\-@+=~]/g, "_").slice(0, 120) || "_";

// a file name "has an extension" only if it ends in a real file type — "vue-tel-input@5.14.0" doesn't
const KNOWN_EXT = /\.(m?js|cjs|css|json|html?|svg|png|jpe?g|webp|avif|gif|ico|bmp|woff2?|ttf|otf|eot|wasm|mp4|webm|mov|m4v|mp3|wav|ogg|oga|m4a|aac|flac|glb|gltf|bin|hdr|exr|ktx2|basis|drc|riv|lottie|xml|txt|map|webmanifest|pdf|usdz|splinecode|obj|fbx|mtl|csv|vtt|zip)$/i;
const TYPE_EXT: [RegExp, string][] = [
  [/javascript|ecmascript/i, ".js"], [/text\/css/i, ".css"], [/json/i, ".json"], [/html/i, ".html"], [/svg/i, ".svg"],
  [/png/i, ".png"], [/jpe?g/i, ".jpg"], [/webp/i, ".webp"], [/avif/i, ".avif"], [/gif/i, ".gif"], [/icon/i, ".ico"],
  [/woff2/i, ".woff2"], [/woff/i, ".woff"], [/ttf|truetype/i, ".ttf"], [/otf|opentype/i, ".otf"], [/wasm/i, ".wasm"],
  [/mp4/i, ".mp4"], [/webm/i, ".webm"], [/mpeg|mp3/i, ".mp3"], [/ogg/i, ".ogg"], [/gltf-binary/i, ".glb"], [/gltf/i, ".gltf"],
  [/xml/i, ".xml"], [/text\/plain/i, ".txt"], [/text\/vtt/i, ".vtt"],
];
const extForType = (type: string) => TYPE_EXT.find(([re]) => re.test(type))?.[1] || ".bin";

/** Where a URL's file lives inside the mirror. A name without a real extension gets one from the
 *  file's content type (Google Fonts' /css2?family=…, npm CDN package files), so it is served
 *  right and can't collide with a folder of the same name. */
export function mirrorPath(url: string, siteHosts: Set<string>, type = ""): string {
  const u = new URL(url);
  const same = siteHosts.has(u.host);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index" + (type ? extForType(type) : ".html");
  const segs = p.split("/").filter(Boolean).map(safeSeg);
  if (!segs.length) segs.push("index" + (type ? extForType(type) : ".html"));
  let last = segs.pop()!;
  const known = last.match(KNOWN_EXT)?.[0] || "";
  const ext = known || (type ? extForType(type) : "");
  const stem = known ? last.slice(0, -known.length) : last;
  // query variants of one path (?v=2, /_next/image?url=…) each get their own file
  last = `${stem}${u.search ? `__q${hash(u.search)}` : ""}${ext}`;
  segs.push(last);
  return (same ? "site/" : `_ext/${safeSeg(u.host)}/`) + segs.join("/");
}

/** The URL a mirrored file is requested at from inside the mirror. */
function localUrl(url: string, siteHosts: Set<string>): string {
  const u = new URL(url);
  return siteHosts.has(u.host) ? u.pathname + u.search : `/_ext/${u.host}${u.pathname}${u.search}`;
}

function siteHostsOf(pageUrl: string): Set<string> {
  const h = new URL(pageUrl).host;
  const bare = h.replace(/^www\./, "");
  return new Set([h, bare, "www." + bare]);
}

/** On-demand chunks a bundle names: "./x.js" / "../x.css" (Vite, Nuxt, Astro, Framer) next to the
 *  file, and Next.js "static/chunks/…" under /_next/. */
export function lazyChunkRefs(code: string, fileUrl: string, nextBase: string | null): string[] {
  const out = new Set<string>();
  const add = (p: string, base: string) => {
    try {
      const u = new URL(p, base);
      if (u.host === new URL(fileUrl).host || (nextBase && u.href.startsWith(nextBase))) out.add(u.href);
    } catch {
      /* not a URL */
    }
  };
  for (const m of code.matchAll(/["'`](\.\.?\/[\w\-./@~]+?\.(?:m?js|css))["'`]/g)) add(m[1], fileUrl);
  // Next.js: "static/chunks/…", "static/css/…", and Turbopack's "static/immutable/chunks/…"
  if (nextBase) for (const m of code.matchAll(/["'`](static\/(?:immutable\/)?(?:chunks|css|media)\/[\w\-./@~[\]]+?\.(?:js|css|woff2?))["'`]/g)) add(m[1], nextBase);
  return Array.from(out);
}

// 3D / media / data files a site's code loads by name when you reach that part of the page
const ASSET_EXT = "glb|gltf|ktx2|basis|drc|hdr|exr|bin|riv|lottie|wasm|mp4|webm|mov|m4v|mp3|ogg|wav|m4a|png|jpe?g|webp|avif|gif|svg|json|glsl|frag|vert|woff2?|ttf|otf|splinecode|usdz|obj|fbx|mtl";
const ASSET_RE = new RegExp(`["'\`]((?:\\.{1,2}\\/|\\/)?[\\w\\-.@~%]+(?:\\/[\\w\\-.@~%]+)+\\.(?:${ASSET_EXT})|(?:\\.{1,2}\\/|\\/)[\\w\\-.@~%]+\\.(?:${ASSET_EXT}))(\\?[^"'\`\\s]{0,80})?["'\`]`, "gi");
/** Asset files a script or data file names — "/assets/models/scene.glb", "./textures/env.hdr",
 *  "videos/reel.mp4" — on the site's own host: tried at the site's root and beside the file. */
export function assetRefs(code: string, fileUrl: string): string[] {
  const out = new Set<string>();
  const file = new URL(fileUrl);
  for (const m of code.matchAll(ASSET_RE)) {
    const p = m[1] + (m[2] || "");
    if (/node_modules|\/src\/|webpack|^\/\/|\.\.\/\.\.\/\.\./.test(p)) continue; // build paths, protocol-relative, deep climbs
    const bases = p.startsWith("/") || p.startsWith(".") ? [fileUrl] : [file.origin + "/", fileUrl];
    for (const b of bases) {
      try {
        const u = new URL(p, b);
        if (u.host === file.host) out.add(u.href);
      } catch {
        /* not a URL */
      }
    }
  }
  return Array.from(out);
}

/** The files a page can't work without: its own scripts, module preloads and stylesheets. */
function essentialUrls(html: string, pageUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.querySelector("base[href]")?.getAttribute("href");
  const baseUrl = base ? new URL(base, pageUrl).href : pageUrl;
  const out: string[] = [];
  const add = (v: string | null) => {
    if (!v) return;
    try {
      const u = new URL(v.trim(), baseUrl);
      u.hash = "";
      if (/^https?:$/.test(u.protocol)) out.push(u.href);
    } catch {
      /* not a URL */
    }
  };
  doc.querySelectorAll("script[src]").forEach((e) => add(e.getAttribute("src")));
  doc.querySelectorAll("link[href]").forEach((e) => { if (/stylesheet|modulepreload/i.test(e.getAttribute("rel") || "")) add(e.getAttribute("href")); });
  return out;
}

/** On-demand chunks of a webpack build (Wix, Create React App, Gatsby, Angular…): the file names are made at
 *  run time from tables in the code — `id + "." + {2570:"b94600a7",…}[id] + ".chunk.min.js"`, optionally with
 *  a names table `({123:"vendors-x",…}[id]||id)` — under the build's public path `.p="https://cdn…/dist/"`
 *  (or, when it isn't spelled out, beside the file holding the runtime). */
export function webpackChunkRefs(code: string, fileUrl: string): string[] {
  const out = new Set<string>();
  const hashMap = /\(?\{((?:"?\d+"?:"[0-9a-f]{6,32}",?)+)\}\)?\[(\w+)\]\+"([^"]{0,40}\.(?:js|css))"/g;
  for (const m of code.matchAll(hashMap)) {
    const at = m.index ?? 0;
    const before = code.slice(Math.max(0, at - 60000), at);
    // public path: the `.p="…"` nearest the table, before or after it (webpack's __webpack_require__.p;
    // Wix sets it a little after the tables)
    const from = Math.max(0, at - 60000);
    const pubs = Array.from(code.slice(from, at + 60000).matchAll(/\.p\s*=\s*"((?:https?:)?\/\/[^"]*|\/[^"]*)"/g));
    let base = new URL(".", fileUrl).href;
    if (pubs.length) {
      const nearest = pubs.reduce((a, b) => (Math.abs(from + (b.index ?? 0) - at) < Math.abs(from + (a.index ?? 0) - at) ? b : a));
      try {
        base = new URL(nearest[1], fileUrl).href;
      } catch {
        /* keep the file's folder */
      }
    }
    // what comes before the hash: an optional folder ("static/js/"+) and the id, or a names table
    // ({123:"vendors-x",…}[e]||e) — then +"."+
    const tail = before.slice(-20000);
    const names: Record<string, string> = {};
    let prefix = "";
    const nm = tail.match(/(?:"([\w./-]*)"\+)?\(\(?\{((?:"?\d+"?:"[\w.~-]+",?)+)\}\)?\[\w+\]\|\|\w+\)\+"\."\+\(?$/);
    if (nm) {
      prefix = nm[1] || "";
      for (const e of nm[2].matchAll(/"?(\d+)"?:"([^"]+)"/g)) names[e[1]] = e[2];
    } else {
      const plain = tail.match(/(?:"([\w./-]*)"\+)?\w+\+"\."\+\(?$/);
      if (!plain) continue; // a table of hashes that isn't a chunk-name expression
      prefix = plain[1] || "";
    }
    for (const e of m[1].matchAll(/"?(\d+)"?:"([0-9a-f]+)"/g)) {
      try {
        out.add(new URL(`${prefix}${names[e[1]] || e[1]}.${e[2]}${m[3]}`, base).href);
      } catch {
        /* not a URL */
      }
    }
  }
  return Array.from(out);
}

/** Every URL the original HTML references directly (scripts, styles, images, preloads). */
function htmlUrls(html: string, pageUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.querySelector("base[href]")?.getAttribute("href");
  const baseUrl = base ? new URL(base, pageUrl).href : pageUrl;
  const out = new Set<string>();
  const add = (v: string | null) => {
    if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v.trim())) return;
    try {
      out.add(new URL(v.trim(), baseUrl).href);
    } catch {
      /* not a URL */
    }
  };
  doc.querySelectorAll("script[src]").forEach((e) => add(e.getAttribute("src")));
  doc.querySelectorAll("link[href]").forEach((e) => {
    if (/stylesheet|preload|modulepreload|icon|manifest|prefetch/i.test(e.getAttribute("rel") || "")) add(e.getAttribute("href"));
  });
  doc.querySelectorAll("img[src], source[src], video[src], audio[src], video[poster], image[href]").forEach((e) => {
    add(e.getAttribute("src"));
    add(e.getAttribute("poster"));
    add(e.getAttribute("href"));
  });
  doc.querySelectorAll("img[srcset], source[srcset]").forEach((e) => {
    for (const part of (e.getAttribute("srcset") || "").split(/,\s+/)) add(part.trim().split(/\s+/)[0]);
  });
  doc.querySelectorAll("style").forEach((s) => collectCssUrls(s.textContent || "").forEach((u) => add(u)));
  return Array.from(out);
}

/** One page → mirror. */
export function buildLiveMirror(
  pageUrl: string,
  originalHtml: string,
  resources: string[],
  r: MirrorResolvers,
  onProgress?: (done: number, total: number) => void,
): Promise<MirrorResult> {
  return buildSiteMirror([{ url: pageUrl, html: originalHtml }], resources, r, onProgress);
}

/** Several pages of one site → one mirror (the first page is the entry). Each page keeps its own
 *  original HTML at its own path; scripts, chunks, models and media are shared. */
export async function buildSiteMirror(
  sitePages: MirrorPage[],
  resources: string[],
  r: MirrorResolvers,
  onProgress?: (done: number, total: number) => void,
): Promise<MirrorResult> {
  if (!sitePages.length) throw new Error("No pages to mirror.");
  const siteHosts = siteHostsOf(sitePages[0].url);
  const page = new URL(sitePages[0].url);
  page.hash = "";
  // one entry per path (the first one wins)
  const pages: { url: URL; html: string }[] = [];
  for (const p of sitePages) {
    const u = new URL(p.url);
    u.hash = "";
    if (!pages.some((q) => q.url.pathname === u.pathname)) pages.push({ url: u, html: p.html });
  }
  const queue: string[] = [];
  const seen = new Set<string>(pages.map((p) => p.url.href));
  const want = (u: string) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || SKIP_HOST.test(url.hostname) || SKIP_URL.test(url.pathname + url.search)) return;
    url.hash = "";
    if (seen.has(url.href) || r.skip?.(url.href)) return;
    seen.add(url.href);
    queue.push(url.href);
  };
  resources.forEach(want);
  for (const p of pages) htmlUrls(p.html, p.url.href).forEach(want);

  const files: Record<string, Uint8Array | string> = {};
  const mirrored = new Map<string, string>(); // original URL → URL inside the mirror
  const manifest: Record<string, string> = {}; // URL inside the mirror → stored file
  const types: Record<string, string> = {}; // stored file → content type from its server
  const missing: string[] = [];
  const quiet = new Set<string>(); // guessed on-demand chunks: a 404 there isn't "missing"
  const loadedDirs = new Set(resources.map(dirOf)); // folders the page really loaded files from
  let quietMediaBytes = 0;
  const pageLang = (/<html\b[^>]*\blang=["']?([a-zA-Z]{2})/i.exec(pages[0].html)?.[1] || "").toLowerCase();
  const code: { url: string; bytes: Uint8Array }[] = [];
  let bytes = 0, done = 0;

  // fetch with a small pool; CSS discovered on the way adds its own url()s
  const worker = async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      let quietMedia = false;
      if (quiet.has(url)) {
        try {
          quietMedia = QUIET_MEDIA.test(new URL(url).pathname) && !loadedDirs.has(dirOf(url));
        } catch {
          /* not a URL */
        }
        if (quietMedia && quietMediaBytes >= QUIET_MEDIA_MAX) {
          done++;
          continue; // over the budget for media only named in code
        }
      }
      const got = bytes < MAX_TOTAL ? await r.fetchFile(url) : null;
      if (got && quietMedia) quietMediaBytes += got.bytes.length;
      done++;
      onProgress?.(done, done + queue.length);
      if (!got || got.bytes.length > MAX_FILE) {
        if (!quiet.has(url)) missing.push(url);
        continue;
      }
      const path = mirrorPath(url, siteHosts, got.type);
      mirrored.set(url, localUrl(url, siteHosts));
      manifest[localUrl(url, siteHosts)] = path;
      if (got.type) types[path] = got.type; // served back with the type its server sent
      bytes += got.bytes.length;
      files[path] = got.bytes; // byte for byte — never edited
      if (/javascript|ecmascript|json/i.test(got.type) || /\.(m?js|json)$/i.test(new URL(url).pathname)) code.push({ url, bytes: got.bytes });
      if (/css/i.test(got.type) || /\.css$/i.test(new URL(url).pathname)) {
        for (const ref of collectCssUrls(new TextDecoder().decode(got.bytes))) {
          try {
            want(new URL(ref, url).href);
          } catch {
            /* skip */
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  // a flaky connection drops some downloads: give each failed file one more try, gently
  if (missing.length && bytes < MAX_TOTAL) {
    queue.push(...missing.splice(0));
    await new Promise((res) => setTimeout(res, 1500));
    await Promise.all(Array.from({ length: 3 }, worker));
  }
  // the pages' own scripts and stylesheets: without them a mirror has no design and no 3D. On a
  // dropping connection keep trying them, with growing pauses, before giving up
  const essential = new Set(pages.flatMap((p) => essentialUrls(p.html, p.url.href)).filter((u) => !SKIP_HOST.test(new URL(u).hostname)));
  for (const wait of r.retryWaitsMs || [3000, 8000, 20000]) {
    const again = missing.filter((u) => essential.has(u));
    if (!again.length) break;
    for (const u of again) missing.splice(missing.indexOf(u), 1);
    await new Promise((res) => setTimeout(res, wait));
    queue.push(...again);
    await Promise.all(Array.from({ length: 2 }, worker));
  }
  // code the page only loads on demand (other routes, popups, players): bundlers list those chunks in
  // the code itself — Vite / Nuxt / Astro as "./chunk.js" beside the importer, Next.js as
  // "static/chunks/…" under /_next/ — so fetch them too (quietly: a wrong guess just 404s)
  const nextBase = Array.from(seen).some((u) => /\/_next\/static\//.test(u)) ? new URL("/_next/", page.href).href : null;
  let lazyCount = 0;
  // the pages' own HTML lists chunks too: Next.js's RSC payload, a webpack runtime written inline (Wix)
  for (const pg of pages) {
    const fromNext = nextBase ? lazyChunkRefs(pg.html, pg.url.href, nextBase).filter((r) => r.startsWith(nextBase)) : [];
    for (const ref of [...fromNext, ...webpackChunkRefs(pg.html, pg.url.href)]) {
      if (lazyCount >= MAX_LAZY || seen.has(ref)) continue;
      quiet.add(ref);
      lazyCount++;
      want(ref);
    }
  }
  for (let round = 0, scanned = 0; round < 3 && lazyCount < MAX_LAZY && bytes < MAX_TOTAL; round++) {
    const batch = code.slice(scanned);
    scanned = code.length;
    for (const c of batch) {
      const text = new TextDecoder().decode(c.bytes);
      // on-demand code, plus the models / textures / videos the code loads by name
      for (const ref of [...lazyChunkRefs(text, c.url, nextBase), ...webpackChunkRefs(text, c.url), ...assetRefs(text, c.url)]) {
        if (lazyCount >= MAX_LAZY || seen.has(ref)) continue;
        const lang = pageLang ? pathLanguage(ref) : null;
        if (lang && lang !== pageLang) continue; // another language's version of a file
        quiet.add(ref);
        lazyCount++;
        want(ref);
      }
    }
    if (!queue.length) break;
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  const extHosts = Array.from(new Set(Array.from(mirrored.keys()).map((u) => new URL(u).host).filter((h) => !siteHosts.has(h))));
  files["sl-mirror-sw.js"] = swScript(page.origin, Array.from(siteHosts), extHosts);
  manifest["/sl-mirror-sw.js"] = "sl-mirror-sw.js";
  const head = headScript(Array.from(siteHosts), extHosts);
  let entryFile = "";
  for (const pg of pages) {
    // each page: its original HTML. A CSP meta tag would block the local origin, and an absolute
    // <base> would send relative URLs back to the original site.
    let html = pg.html;
    html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
    html = html.replace(/<base\s+href=["']https?:\/\/[^"']+["'][^>]*>/gi, "");
    // tab icons are fetched by the browser itself, outside the service worker: point them at the copy
    html = html.replace(/<link\b[^>]*\brel=["']?(?:shortcut icon|icon|apple-touch-icon|mask-icon)["']?[^>]*>/gi, (tag) =>
      tag.replace(/\bhref=(["'])([^"']+)\1/i, (all, q: string, href: string) => {
        try {
          const local = mirrored.get(new URL(href.replace(/&amp;/g, "&"), pg.url.href).href);
          return local ? `href=${q}${local}${q}` : all;
        } catch {
          return all;
        }
      }),
    );
    // first thing in <head>: the service worker + link keeper, before any of the site's code
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + head) : head + html;
    // your own layer: a stylesheet loaded last (it wins over the site's) and a script run after the site's
    // (your layer — stylelift-custom.css / .js — is loaded by that script, not written into the page:
    // frameworks that hydrate the whole document (Remix, React Router, Next.js) treat extra tags as a
    // mismatch and rebuild the page — shopify.com's React error #418)
    // /work/project → site/work/project/index.html (served at its own path)
    const file = ["site", ...decodeURIComponent(pg.url.pathname).split("/").filter(Boolean).map(safeSeg), "index.html"].join("/");
    files[file] = html;
    manifest[pg.url.pathname + pg.url.search] = file;
    manifest[pg.url.pathname] = file;
    if (!entryFile) entryFile = file;
  }
  const entryLocal = page.pathname + page.search;
  files["site/stylelift-custom.css"] = CUSTOM_CSS;
  files["site/stylelift-custom.js"] = CUSTOM_JS;
  manifest["/stylelift-custom.css"] = "site/stylelift-custom.css";
  manifest["/stylelift-custom.js"] = "site/stylelift-custom.js";
  types["site/stylelift-custom.css"] = "text/css; charset=utf-8";
  types["site/stylelift-custom.js"] = "text/javascript; charset=utf-8";

  // a file and a folder can't share a name (unzip / disk): rename the file, keep its URL
  const dirs = new Set<string>();
  for (const k of Object.keys(files)) { const parts = k.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
  for (const k of Object.keys(files)) {
    if (!dirs.has(k)) continue;
    const to = `${k}__file`;
    files[to] = files[k];
    delete files[k];
    if (types[k]) { types[to] = types[k]; delete types[k]; }
    for (const [u, f] of Object.entries(manifest)) if (f === k) manifest[u] = to;
  }
  // pages (for the "not in this mirror" page) and how to answer an address that wasn't mirrored: an app
  // that routes in the browser (its HTML is an empty shell) gets its shell; a site of real pages
  // (Shopify, WordPress, Webflow, Framer…) gets an honest "not in this mirror" page — never another page
  const parsed = pages.map((p) => ({ p, doc: new DOMParser().parseFromString(p.html, "text/html") }));
  const pageList = parsed.map(({ p, doc }) => ({ path: p.url.pathname + p.url.search, title: (doc.title || "").trim() || p.url.pathname }));
  const shell = parsed[0].doc;
  shell.querySelectorAll("script, style, noscript, template").forEach((e) => e.remove());
  const fallback = (shell.body?.textContent || "").replace(/\s+/g, " ").trim().length < 120 ? "app" : "missing";
  files["mirror-manifest.json"] = JSON.stringify({ source: page.href, entry: entryLocal, entryFile, fallback, pages: pageList, hosts: { site: Array.from(siteHosts), ext: extHosts }, paths: manifest, types }, null, 1);
  // open on any static host (Netlify Drop, Cloudflare Pages, GitHub Pages…): the loader is the folder's
  // index page and its 404 page; .nojekyll keeps GitHub Pages from hiding folders that start with "_"
  files["index.html"] = bootstrapHtml(entryLocal);
  files["404.html"] = bootstrapHtml(entryLocal);
  files[".nojekyll"] = "";
  files["server.mjs"] = SERVER_JS;
  files["package.json"] = JSON.stringify({ name: `${safeSeg(page.host)}-mirror`, private: true, type: "module", scripts: { start: "node server.mjs" } }, null, 2) + "\n";
  files["README.md"] = readme(page.href, Object.keys(manifest).length, missing, pages.map((p) => p.url.pathname), missing.filter((u) => essential.has(u)));
  const missingEssential = missing.filter((u) => essential.has(u));
  return { files, missing, missingEssential, count: Object.keys(manifest).length, bytes, entryPath: entryLocal, pages: pages.length };
}

function readme(source: string, count: number, missing: string[], paths: string[], essential: string[] = []): string {
  return (
    `# Live mirror of ${source}\n\n` +
    (essential.length
      ? `> **Incomplete mirror:** ${essential.length} of the site's own scripts / stylesheets couldn't be downloaded (connection dropped?).\n` +
        `> Without them the pages won't look or work right offline. Export the mirror again on a stable connection.\n>\n` +
        essential.slice(0, 30).map((u) => `> - ${u}`).join("\n") + "\n\n"
      : "") +
    `The site's own ${paths.length > 1 ? "pages" : "page"}, code and files (${count} files), captured by StyleLift, so 3D scenes, WebGL,\n` +
    `animations and interactions run exactly like the original.\n\n` +
    (paths.length > 1 ? `## Pages (${paths.length})\n\n${paths.slice(0, 200).map((p) => `- ${p}`).join("\n")}\n\nOther addresses open the first page (client-side routes still work).\n\n` : "") +
    "## Open it — no install\n\n" +
    "1. Unzip this file.\n" +
    "2. Go to https://app.netlify.com/drop and drag the unzipped folder onto the page.\n" +
    "3. Netlify gives you an https link a few seconds later: open it, or send it to anyone. (Free; sign in with a\n" +
    "   free Netlify account to keep the link online.)\n\n" +
    "Any web host that serves plain files works the same way — Cloudflare Pages (upload the folder), GitHub Pages,\n" +
    "Vercel, or your own hosting: upload everything in this folder, including the files that start with a dot.\n" +
    "Double-clicking index.html on your computer doesn't work: browsers only run a mirror over https or localhost.\n\n" +
    "## Run it on your computer (developers)\n\n```\nnode server.mjs        # or: npm start\n```\n\nThen open the address it prints (http://localhost:4173 by default; `PORT=8080 node server.mjs` to change).\n\n" +
    "## Make it yours\n\nThe site's code is left exactly as it was (that's what keeps it working). Restyle it from two files\n" +
    "that every page loads: `site/stylelift-custom.css` (after the site's own styles, so your rules win) and\n" +
    "`site/stylelift-custom.js` (after the site's own scripts). The pages' HTML (`site/**/index.html`) can be\n" +
    "edited directly too — text, images, links. Publishing a restyled copy of someone else's site still needs\n" +
    "their permission.\n\n" +
    "## How it works\n\nThe site's files are stored byte for byte — its code is never edited. A service worker\n" +
    "(`site/sl-mirror-sw.js`) answers every request for one of the site's URLs, or a CDN's, with the stored copy, so the\n" +
    "code runs exactly as on the original. The first time a browser opens the mirror, `server.mjs` shows a one-second\n" +
    "loader that installs the worker. Browsers without service workers (e.g. Firefox private windows) load those files\n" +
    "from the original servers instead, so they need the internet.\n\n" +
    "## How it opens anywhere\n\nThe service worker (`sl-mirror-sw.js`) does all the serving: it reads `mirror-manifest.json` and answers\n" +
    "every request — pages too — with the stored file, under the original address, with the right file type. `index.html`\n" +
    "and `404.html` are a one-second loader that installs it on the first visit, so a plain static host is enough.\n\n" +
    "## What doesn't come along\n\n" +
    "- Anything the site's servers compute live: logins, carts, checkout, search, forms, live data. Requests the\n" +
    "  page made during the capture were saved as files; new ones go to the original site and may be refused.\n" +
    "- Files the page never loaded while StyleLift scrolled it (for example a section only shown after a click).\n" +
    "- Analytics and ad scripts are left out on purpose.\n\n" +
    (missing.length ? `## Files that couldn't be downloaded (${missing.length})\n\n${missing.slice(0, 60).map((m) => `- ${m}`).join("\n")}\n\n` : "") +
    "## Permission\n\nThis mirror contains the site's actual code and assets. Use it for sites you own or have permission to copy.\n"
  );
}

// Your own layer on top of the site's untouched code. The stylesheet is the last one in <head>, so at
// equal specificity your rules win; the script runs after the site's own (defer).
const CUSTOM_CSS = `/* stylelift-custom.css — your styles for this mirror.
 *
 * Loaded on every page, after the site's own stylesheets, so your rules win at equal specificity.
 * The site's code is left exactly as it was; change the look here instead. Refresh to see edits.
 *
 * Examples:
 *   :root { --brand: #0f766e; }
 *   body { font-family: "Inter", system-ui, sans-serif; }
 *   header, nav { background: #111 !important; }    <- add !important when the site's rule is more specific
 *   .hero h1 { letter-spacing: -0.02em; }
 *
 * Tip: right-click → Inspect on the live mirror to find the class names to target.
 */
`;
const CUSTOM_JS = `// stylelift-custom.js — your code for this mirror. Runs on every page after the site's own scripts.
// Change text, swap images, add or hide elements. Pages that build themselves with JavaScript may
// render after this runs: wait for what you need, e.g.
//
//   const when = (sel, fn) => { const el = document.querySelector(sel); if (el) return fn(el);
//     new MutationObserver((_, o) => { const e = document.querySelector(sel); if (e) { o.disconnect(); fn(e); } })
//       .observe(document.documentElement, { childList: true, subtree: true }); };
//   when("h1", (h) => (h.textContent = "My headline"));
`;

// First thing in each page's <head>: registers the mirror's service worker before any of the site's
// code runs (and keeps the site's own worker, if it has one, from replacing it); and keeps links that
// spell out the site's own domain inside the mirror — only when the site's router didn't handle the
// click itself (the listener runs last, on window, and skips handled clicks).
function headScript(siteHosts: string[], extHosts: string[] = []): string {
  return (
    `<script data-sl-mirror>(function(){var me=document.currentScript;try{var c=navigator.serviceWorker;if(c&&window.isSecureContext){var r=c.register.bind(c);` +
    `r("/sl-mirror-sw.js",{scope:"/"}).catch(function(){});c.register=function(u,o){return String(u).indexOf("sl-mirror-sw")>=0?r(u,o):c.ready}}}catch(e){}` +
    `var S=${JSON.stringify(siteHosts)};window.addEventListener("click",function(e){try{if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;` +
    `var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var u=new URL(a.href,location.href);` +
    `if(u.host===location.host||S.indexOf(u.host)<0||!/^https?:$/.test(u.protocol))return;e.preventDefault();var to=u.pathname+u.search+u.hash;` +
    `if(a.target==="_blank")window.open(to,"_blank");else location.assign(to)}catch(x){}});` +
    // any navigation the page's code starts towards the site's own domain (location.href = …, a
    // "you're not on our domain" check, a meta refresh): a redirect back to the same page is
    // cancelled (stay), anything else opens the mirror's copy of that page
    `if(window.navigation)navigation.addEventListener("navigate",function(e){try{var u=new URL(e.destination.url);` +
    `if(u.host===location.host||S.indexOf(u.host)<0||!/^https?:$/.test(u.protocol)||!e.cancelable)return;e.preventDefault();` +
    `if(u.pathname+u.search===location.pathname+location.search)return;var to=u.pathname+u.search+u.hash;setTimeout(function(){location.assign(to)},0)}catch(x){}});` +
    // tab icons: the browser fetches them itself (no service worker), and frameworks re-render <head> with
    // the original addresses after loading — keep icon links on the mirror's copies
    `var E=${JSON.stringify(extHosts)};function fixIcons(){try{document.querySelectorAll("link[rel~=icon],link[rel~=apple-touch-icon],link[rel~=mask-icon]").forEach(function(l){var h=l.getAttribute("href");if(!h)return;var u=new URL(h,location.href);` +
    `var to=S.indexOf(u.host)>=0?u.pathname+u.search:E.indexOf(u.host)>=0?"/_ext/"+u.host+u.pathname+u.search:null;if(to&&h!==to)l.setAttribute("href",to)})}catch(x){}}` +
    `new MutationObserver(fixIcons).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["href"]});document.addEventListener("DOMContentLoaded",fixIcons);` +
    // background workers must come from the page's own address: a site that starts one from its full
    // https://site.com/… (or CDN) URL gets the mirror's copy instead of a SecurityError
    `["Worker","SharedWorker"].forEach(function(n){var W=window[n];if(!W)return;var P=function(u,o){try{var x=new URL(String(u),location.href);` +
    `if(x.host!==location.host&&/^https?:$/.test(x.protocol)){var to=S.indexOf(x.host)>=0?x.pathname+x.search:E.indexOf(x.host)>=0?"/_ext/"+x.host+x.pathname+x.search:null;if(to)u=to}}catch(e){}` +
    `return new W(u,o)};P.prototype=W.prototype;try{Object.defineProperty(window,n,{value:P,writable:true,configurable:true})}catch(e){window[n]=P}});` +
    // your layer, kept out of the page's own HTML: styles as an adopted sheet (after the site's, so they
    // win), code once the page has loaded — and nothing at all while the files are still the templates
    `var real=function(t){return /[^\\s]/.test(String(t||"").replace(/\\/\\*[\\s\\S]*?\\*\\//g,"").replace(/^\\s*\\/\\/.*$/gm,""))};` +
    `try{fetch("/stylelift-custom.css",{cache:"no-cache"}).then(function(r){return r.ok?r.text():""}).then(function(t){if(!real(t))return;try{var s=new CSSStyleSheet();s.replaceSync(t);document.adoptedStyleSheets=document.adoptedStyleSheets.concat(s)}catch(e){var st=document.createElement("style");st.textContent=t;document.documentElement.appendChild(st)}}).catch(function(){})}catch(e){}` +
    `addEventListener("load",function(){try{fetch("/stylelift-custom.js",{cache:"no-cache"}).then(function(r){return r.ok?r.text():""}).then(function(t){if(!real(t))return;var s=document.createElement("script");s.src="/stylelift-custom.js";document.documentElement.appendChild(s)}).catch(function(){})}catch(e){}});` +
    // the page's HTML goes back to exactly what the site sent before any of its code looks at it
    `if(me)me.remove()})();</script>`
  );
}

/** The service worker. It does all the serving, so a mirror runs on ANY host that serves plain files
 *  (Netlify Drop, Cloudflare Pages, GitHub Pages, S3 …) as well as on its own server.mjs: it loads the
 *  mirror's manifest and answers every request — page loads too — with the stored file, under the
 *  ORIGINAL URL (a fresh Response, so module imports and CSS url()s resolve as on the real site), with
 *  the content type the site's server sent. A file that isn't in the mirror goes to the internet;
 *  offline, an image or video falls back to another stored size of the same file. */
function swScript(origin: string, siteHosts: string[], extHosts: string[]): string {
  return `// StyleLift live mirror: serves the site's pages and files from this mirror, under their original URLs.
const ORIGIN = ${JSON.stringify(origin)};
const SITE = ${JSON.stringify(siteHosts)};
const EXT = new Set(${JSON.stringify(extHosts)});
const MEDIA = /^(image|video|audio|font|track)$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
let MP = null;
const manifest = () => MP || (MP = fetch("/mirror-manifest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
  if (!m) return null;
  m.byPath = {}; // /assets/x.webp → the copy saved from cdn.site.com/assets/x.webp (code that picks its host by hostname)
  for (const [k, f] of Object.entries(m.paths)) { const x = /^\\/_ext\\/[^/]+(\\/.*)$/.exec(k); if (x && !(x[1] in m.byPath)) m.byPath[x[1]] = f; }
  return m;
}).catch(() => (MP = null)));
// the stored file, as a fresh Response (no URL of its own → the request's URL is used), right type
async function stored(m, file, headers) {
  const r = await fetch("/" + encodeURI(file), { credentials: "same-origin", headers });
  if (!r.ok) return null;
  if (r.status === 206) return r;
  const h = new Headers(r.headers);
  const t = m.types && m.types[file];
  if (t) h.set("content-type", t);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
function variantOf(m, key) { const pre = key.split("?")[0]; const k = Object.keys(m.paths).find((p) => p === pre || p.startsWith(pre + "?")); return k ? m.paths[k] : null; }
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function missing(m, u) {
  const src = new URL(m.source), original = src.origin + u.pathname + u.search, pages = m.pages || [];
  return \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not in this mirror</title>
<style>:root{--bg:#f7f6f3;--fg:#17171a;--mu:#62626b;--li:#e2e0da;--ca:#fff}@media(prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ecebe8;--mu:#9a9aa3;--li:#2b2b30;--ca:#1c1c20}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:72px 20px}p{color:var(--mu)}
code{background:var(--ca);border:1px solid var(--li);border-radius:6px;padding:2px 6px;word-break:break-all}a.b{display:inline-block;margin:8px 8px 32px 0;padding:10px 16px;border-radius:999px;border:1px solid var(--li);color:var(--fg);text-decoration:none;background:var(--ca)}
ul{list-style:none;padding:0;border-top:1px solid var(--li)}li a{display:block;padding:12px 0;border-bottom:1px solid var(--li);color:var(--fg);text-decoration:none}</style></head><body><main>
<h1>This page isn't in the mirror</h1><p><code>\${esc(original)}</code> wasn't one of the \${pages.length} page(s) StyleLift mirrored from \${esc(src.host)}.</p>
<a class="b" href="\${esc(original)}">Open it on \${esc(src.host)}</a><a class="b" href="\${esc(m.entry || "/")}">Mirror's home page</a>
\${pages.length ? "<ul>" + pages.slice(0, 300).map((p) => \`<li><a href="\${esc(p.path)}">\${esc(p.title)}</a></li>\`).join("") + "</ul>" : ""}</main></body></html>\`;
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let u; try { u = new URL(req.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  const range = req.headers.get("range");
  const headers = range ? { range } : {};
  const same = u.origin === self.location.origin;
  if (same && (u.pathname === "/sl-mirror-sw.js" || u.pathname === "/mirror-manifest.json")) return;
  // a page load: the stored page, an app's shell, or "not in this mirror"
  if (req.mode === "navigate") {
    if (!same) return;
    e.respondWith((async () => {
      const m = await manifest();
      if (!m) return fetch(req);
      const file = m.paths[u.pathname + u.search] || m.paths[u.pathname] || m.paths[u.pathname.replace(/\\/$/, "")] || m.paths[u.pathname + "/"];
      if (file && /\\.html?$/i.test(file)) { const r = await stored(m, file, {}); if (r) return r; }
      if (m.fallback !== "missing") { const r = await stored(m, m.entryFile, {}); if (r) return r; }
      return new Response(missing(m, u), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    })());
    return;
  }
  const key = same ? u.pathname + u.search : SITE.includes(u.host) ? u.pathname + u.search : EXT.has(u.host) ? "/_ext/" + u.host + u.pathname + u.search : null;
  if (!key) return;
  e.respondWith((async () => {
    const m = await manifest();
    if (m) {
      const file = m.paths[key] || (same || SITE.includes(u.host) ? m.paths[u.pathname] || m.byPath[key] || m.byPath[u.pathname] : null);
      if (file) { const r = await stored(m, file, headers); if (r) return r; }
    }
    // not in the mirror: the request itself (a host with the file), then the original site
    try {
      const r = await fetch(same ? req : req.clone());
      if (r.ok || r.status === 206 || r.type === "opaque" || !same) return r;
    } catch {}
    try { if (same) return await fetch(ORIGIN + u.pathname + u.search, { mode: req.mode === "same-origin" || req.mode === "navigate" ? "cors" : req.mode, credentials: "omit", headers }); } catch {}
    // offline: another stored size of the same image / video / font
    if (m && MEDIA.test(req.destination)) { const v = variantOf(m, key); if (v) { const r = await stored(m, v, headers); if (r) return r; } }
    const wantsJson = /json/i.test(req.headers.get("accept") || "") || /\\.json$/i.test(u.pathname) || req.destination === "";
    return wantsJson && req.destination === ""
      ? new Response("{}", { status: 404, statusText: "Not in the mirror", headers: { "content-type": "application/json" } })
      : new Response("", { status: 404, statusText: "Not in the mirror" });
  })());
});
`;
}

// Opens a mirror on a plain static host: installs the service worker, then reloads into the site. The
// same file is the host's 404 page, so a link straight to a deep page works too.
function bootstrapHtml(entry: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening…</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#fff;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#aaa}}#m{max-width:520px;padding:24px;text-align:center}</style></head>
<body><div id="m">Opening the mirror…</div><script>
(function () {
  var ENTRY = ${JSON.stringify(entry)}, c = navigator.serviceWorker, say = function (t) { document.getElementById("m").textContent = t; };
  if (!c) return say("This browser can't open the mirror here: it needs service workers (any current Chrome, Edge, Firefox or Safari — not a private window).");
  if (!window.isSecureContext) return say("Open this mirror over https (every static host does) or on localhost — browsers only allow it there.");
  var tried = sessionStorage.getItem("sl-mirror-boot");
  c.register("/sl-mirror-sw.js", { scope: "/" }).then(function () { return c.ready; }).then(function () {
    var go = function () {
      if (tried === location.href) return say("The mirror couldn't start on this host. Make sure every file of the folder was uploaded, including sl-mirror-sw.js and mirror-manifest.json.");
      sessionStorage.setItem("sl-mirror-boot", location.href);
      if (location.pathname === "/" && ENTRY !== "/") location.replace(ENTRY); else location.reload();
    };
    if (c.controller) go(); else c.addEventListener("controllerchange", go, { once: true });
  }).catch(function (e) { say("The mirror couldn't start: " + e.message); });
})();
</script></body></html>`;
}

// Plain Node (no dependencies): serves the mirror with correct content types.
const SERVER_JS = `// Serves this mirror: node server.mjs  (PORT=8080 node server.mjs to change the port)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "mirror-manifest.json"), "utf8"));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".hdr": "image/vnd.radiance", ".exr": "image/x-exr",
  ".ktx2": "image/ktx2", ".basis": "application/octet-stream", ".drc": "application/octet-stream", ".riv": "application/octet-stream", ".lottie": "application/zip",
};
const typeOf = (file) => (manifest.types && manifest.types[file]) || TYPES[extname(file.replace(/__q\\w+(?=\\.|$)/, "")).toLowerCase()] || "application/octet-stream";
const inside = (p) => { const n = normalize(join(root, p)); return n.startsWith(root.endsWith(sep) ? root : root + sep) ? n : null; };
async function isFile(p) { try { return (await stat(p)).isFile(); } catch { return false; } }

// a site whose code picks its asset host by hostname (a CDN in production, local paths anywhere else)
// asks the mirror for /assets/x.webp while the copy was saved from cdn.site.com/assets/x.webp
const extByPath = {};
for (const [k, f] of Object.entries(manifest.paths)) { const m = /^\\/_ext\\/[^/]+(\\/.*)$/.exec(k); if (m && !(m[1] in extByPath)) extByPath[m[1]] = f; }

async function resolve(url, wantsHtml, anyVariant) {
  const u = new URL(url, "http://mirror");
  const mapped = manifest.paths[u.pathname + u.search] || manifest.paths[u.pathname];
  if (mapped) return mapped;
  if (anyVariant) { const k = Object.keys(manifest.paths).find((k) => k.startsWith(u.pathname + "?")); if (k) return manifest.paths[k]; }
  let p = decodeURIComponent(u.pathname);
  const candidates = p.startsWith("/_ext/") ? [p.slice(1)] : ["site" + p, "site" + p + (p.endsWith("/") ? "index.html" : "/index.html"), p.slice(1)];
  for (const c of candidates) { const f = inside(c); if (f && (await isFile(f))) return c; }
  if (!p.startsWith("/_ext/")) { const alt = extByPath[u.pathname + u.search] || extByPath[u.pathname]; if (alt) return alt; }
  if (!wantsHtml) return null;
  return manifest.fallback === "missing" ? MISSING : manifest.entryFile; // an app's own routes → its shell
}

// First visit in a browser: a tiny page installs the mirror's service worker, then reloads, so the
// site's code runs under it from its very first request (URLs it builds at run time stay local).
const LOADER = \`<!doctype html><meta charset="utf-8"><title>Loading…</title><script>
(function () {
  var done = false;
  function go() {
    if (done) return; done = true;
    document.cookie = "slmirror=1; path=/; max-age=31536000; samesite=lax";
    if (document.cookie.indexOf("slmirror=1") < 0) location.replace(location.pathname + (location.search ? location.search + "&" : "?") + "__slmirror=1" + location.hash);
    else location.reload();
  }
  var c = navigator.serviceWorker;
  if (!c || !window.isSecureContext) return go();
  setTimeout(go, 4000);
  c.register("/sl-mirror-sw.js", { scope: "/" }).then(function () {
    if (c.controller) return go();
    c.addEventListener("controllerchange", go);
  }).catch(go);
})();
</script>\`;

// an address that isn't in the mirror: say so (never show another page in its place)
const MISSING = Symbol("missing");
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function missingPage(url) {
  const src = new URL(manifest.source);
  const pages = manifest.pages || [];
  const original = src.origin + new URL(url, "http://mirror").pathname + new URL(url, "http://mirror").search;
  return \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not in this mirror</title><style>
:root{--bg:#f7f6f3;--fg:#17171a;--muted:#62626b;--line:#e2e0da;--card:#fff;--accent:#17171a;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ecebe8;--muted:#9a9aa3;--line:#2b2b30;--card:#1c1c20;--accent:#ecebe8;--accent-fg:#141416}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:72px 20px}h1{font-size:28px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
p{color:var(--muted);margin:0 0 20px}code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 6px;font-size:14px;color:var(--fg);word-break:break-all}
.row{display:flex;flex-wrap:wrap;gap:10px;margin:28px 0 40px}.btn{display:inline-block;padding:10px 16px;border-radius:999px;text-decoration:none;border:1px solid var(--line);color:var(--fg);background:var(--card)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}li a{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line);color:var(--fg);text-decoration:none}
li a span{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}li a:hover{opacity:.7}
</style></head><body><main>
<h1>This page isn't in the mirror</h1>
<p><code>\${esc(original)}</code> wasn't one of the \${pages.length} page\${pages.length === 1 ? "" : "s"} StyleLift mirrored from \${esc(src.host)}. To include it, mirror the site again with a higher page limit (Get source code → Whole site → Max pages).</p>
<div class="row"><a class="btn primary" href="\${esc(original)}">Open it on \${esc(src.host)}</a><a class="btn" href="\${esc(manifest.entry || "/")}">Mirror's home page</a></div>
\${pages.length ? \`<h2>Pages in this mirror</h2><ul>\${pages.slice(0, 300).map((p) => \`<li><a href="\${esc(p.path)}">\${esc(p.title)}<span>\${esc(p.path)}</span></a></li>\`).join("")}</ul>\` : ""}
</main></body></html>\`;
}

const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    const navigate = req.headers["sec-fetch-mode"] ? req.headers["sec-fetch-mode"] === "navigate" : /text\\/html/.test(req.headers.accept || "");
    const rel = await resolve(url, navigate || /text\\/html/.test(req.headers.accept || ""), req.headers["x-sl-variant"] === "1");
    if (rel === MISSING) { res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(missingPage(url)); }
    const file = rel && inside(rel);
    if (!file || !(await isFile(file))) {
      // data the code asks for that isn't in the mirror: an empty JSON answer (code that parses it without
      // checking the status gets {} instead of a crash); anything else: an empty 404
      const data = /json/i.test(req.headers.accept || "") || (req.headers["sec-fetch-dest"] === "empty" && !/\\.(js|mjs|css|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|mp4|webm|glb|wasm)(\\?|$)/i.test(url));
      res.writeHead(404, data ? { "content-type": "application/json" } : {});
      return res.end(data ? "{}" : "");
    }
    if (navigate && /\\.html?$/.test(rel) && !/(^|;\\s*)slmirror=1/.test(req.headers.cookie || "") && !/__slmirror=1/.test(url)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(LOADER);
    }
    const data = await readFile(file);
    const head = { "content-type": typeOf(rel), "access-control-allow-origin": "*", "cache-control": "no-cache", "accept-ranges": "bytes" };
    // byte ranges: video/audio seeking (Safari won't play video without them)
    const m = /^bytes=(\\d*)-(\\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, data.length - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      if (start > end || start >= data.length) { res.writeHead(416, { "content-range": \`bytes */\${data.length}\` }); return res.end(); }
      res.writeHead(206, { ...head, "content-range": \`bytes \${start}-\${end}/\${data.length}\`, "content-length": end - start + 1 });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { ...head, "content-length": data.length });
    res.end(data);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}).listen(port, () => console.log(\`Mirror of \${manifest.source}\\nOpen http://localhost:\${port}\${manifest.entry}\`));
`;
