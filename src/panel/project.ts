// Turn a page snapshot into a proper EDITABLE PROJECT (folders + separate files
// + binary assets), instead of one giant dumped file. Used by the HTML-project
// and React-project zip exports. Resolvers are injected for testability.

import { addModelViewerTag, extractModels, hasModels } from "../shared/model-viewer";
import { formatCss } from "../shared/format-css";
import { collectCssUrls, rewriteCssUrlsWith, safeCss } from "./css-url";
import { retargetSrcset } from "../shared/srcset";

export interface ProjectResolvers {
  fetchText(url: string): Promise<string | null>; // stylesheet text
  fetchBytes(url: string): Promise<Uint8Array | null>; // binary asset
}
export type FileMap = Record<string, string | Uint8Array>;

export function absUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
function kindOf(url: string): "images" | "fonts" | "media" | "js" {
  const ext = (url.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return "fonts";
  if (/^(mp4|webm|mov|m4v|ogv|m3u8|mpd|mp3|wav|ogg)$/.test(ext)) return "media";
  if (/^(m?js|cjs)$/.test(ext)) return "js";
  return "images";
}
function baseName(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  let name = (clean.split("/").pop() || "asset").replace(/[^\w.-]/g, "_");
  if (!name || name === "_") name = "asset";
  return name;
}

// Shared asset collector: fetches each referenced asset once, stores it under
// assets/<kind>/<name>, and hands back the project-relative path.
/** Asset URLs that could not be downloaded (left as live URLs), per FileMap. */
export const missingAssets = new WeakMap<FileMap, Set<string>>();
/** List, in the README, the files that couldn't be downloaded (they stay pointed at the original site). */
export function noteMissing(files: FileMap): FileMap {
  const failed = missingAssets.get(files);
  if (!failed?.size || typeof files["README.md"] !== "string") return files;
  files["README.md"] +=
    `\n## Files that couldn't be downloaded\n\nThese ${failed.size} file(s) still load from the original site (the server refused or the connection dropped). ` +
    "Export again to retry, or download them yourself into the project:\n\n" +
    Array.from(failed).slice(0, 200).map((u) => `- ${u}`).join("\n") + "\n";
  return files;
}

export function makeCollector(files: FileMap, r: ProjectResolvers, assetDir: string) {
  const map = new Map<string, string>(); // absUrl -> project path
  const used = new Set<string>();
  const failed = new Set<string>();
  missingAssets.set(files, failed);
  const fetchWithRetry = async (abs: string): Promise<Uint8Array | null> => {
    // CDNs throttle bursts of requests ("too many requests"); a growing backoff recovers almost all of them
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = await r.fetchBytes(abs);
      if (bytes) return bytes;
      if (attempt < 3) await new Promise((res) => setTimeout(res, 500 * 3 ** attempt)); // 0.5 s, 1.5 s, 4.5 s
    }
    return null;
  };
  // several files at once (one after another, a page naming hundreds of images — every size of every picture
  // in its stylesheets — took many minutes); the same file asked for twice at once is fetched once
  const pending = new Map<string, Promise<string | null>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (active >= 8) await new Promise<void>((res) => waiting.push(res));
    active++;
  };
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  const fetchLimited = async (abs: string) => {
    await slot();
    try {
      return await fetchWithRetry(abs);
    } finally {
      release();
    }
  };
  return function collect(url: string, base: string): Promise<string | null> {
    if (!url || url.startsWith("data:") || url.startsWith("#")) return Promise.resolve(null);
    const abs = absUrl(url, base);
    if (map.has(abs)) return Promise.resolve(map.get(abs)!);
    if (failed.has(abs)) return Promise.resolve(null);
    const inflight = pending.get(abs);
    if (inflight) return inflight;
    const job = collectOne(abs).finally(() => pending.delete(abs));
    pending.set(abs, job);
    return job;
  };
  async function collectOne(abs: string): Promise<string | null> {
    const bytes = await fetchLimited(abs);
    if (!bytes) {
      if (/^https?:/i.test(abs)) failed.add(abs);
      return null;
    }
    const kind = kindOf(abs);
    let name = baseName(abs);
    if (!/\.[a-z0-9]+$/i.test(name)) name += kind === "fonts" ? ".woff2" : kind === "media" ? ".mp4" : kind === "js" ? ".js" : ".png";
    let path = `${assetDir}/${kind}/${name}`;
    let i = 1;
    while (used.has(path)) path = `${assetDir}/${kind}/${i++}-${name}`;
    used.add(path);
    map.set(abs, path);
    files[path] = bytes;
    return path;
  }
}

async function rewriteCssUrls(
  css: string,
  cssBase: string,
  collect: (url: string, base: string) => Promise<string | null>,
  refPrefix: string,
): Promise<string> {
  const resolved = new Map<string, string>(); // original url text -> project ref
  await Promise.all(
    collectCssUrls(css).map(async (u) => {
      const path = await collect(u, cssBase);
      if (path) resolved.set(u, refPrefix + path);
    }),
  );
  return rewriteCssUrlsWith(css, (u) => resolved.get(u.trim()) ?? null);
}

/** Apple's own typefaces (SF Pro, SF Compact, SF Mono, New York) can't be downloaded — Apple serves them only
 *  to its own pages — but they ARE the system font of every Apple device. Where a page's @font-face for one of
 *  them stayed unresolved (its files still point at the site: refused), its font stacks fall back to the
 *  system font right after it: SF itself on a Mac / iPhone, the platform's own UI font elsewhere — not the
 *  next name in the stack (Helvetica, visibly wider). */
export function systemFontFallback(css: string): string {
  const failed = new Set<string>();
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const fam = (/font-family\s*:\s*(["']?)([^;"']+)\1/i.exec(body) || [])[2]?.trim();
    if (!fam || !/^(SF Pro|SF Compact|SF Mono|New York)\b/i.test(fam)) continue;
    const urls = Array.from(body.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)).map((u) => u[2]);
    if (urls.length && urls.every((u) => /^https?:/i.test(u))) failed.add(fam.toLowerCase());
  }
  if (!failed.size) return css;
  // (the @font-face rules themselves are left alone: their font-family names one face)
  return css.replace(/@font-face\s*\{[^}]*\}|(font-family\s*:\s*)([^;}]+)/gi, (all, head: string | undefined, list: string | undefined) => {
    if (head === undefined || list === undefined || /system-ui/.test(list)) return all;
    const items = list.split(",");
    const at = items.findIndex((it) => failed.has(it.trim().replace(/^["']|["']$/g, "").replace(/\s*!important$/i, "").toLowerCase()));
    if (at < 0) return all;
    items.splice(at + 1, 0, " system-ui", " -apple-system");
    return head + items.join(",");
  });
}

// Collect all CSS (inline <style> + external <link>) into one stylesheet string,
// rewriting its url()s to project asset paths. Returns { css, doc } with <style>/
// <link> removed from the doc.
export async function collectCss(
  doc: Document,
  baseUrl: string,
  r: ProjectResolvers,
  collect: (url: string, base: string) => Promise<string | null>,
  cssRefPrefix: string,
): Promise<string> {
  let css = "";
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = absUrl(link.getAttribute("href") || "", baseUrl);
    const text = safeCss(await r.fetchText(href));
    if (text != null) css += `/* ${href} */\n` + (await rewriteCssUrls(text, href, collect, cssRefPrefix)) + "\n";
    else if (/^https?:/i.test(href)) css += `@import url("${href}"); /* could not be downloaded as CSS — loaded from the site */\n`;
    link.remove();
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    css += (await rewriteCssUrls(style.textContent || "", baseUrl, collect, cssRefPrefix)) + "\n";
    style.remove();
  }
  // laid out to be read: one declaration per line, nested rules indented (meaning untouched)
  return formatCss(systemFontFallback(css.trim()));
}

// Rewrite element asset references (img/src, srcset→src, poster, source) to files.
export async function rewriteElementAssets(
  doc: Document,
  baseUrl: string,
  collect: (url: string, base: string) => Promise<string | null>,
  refPrefix: string,
): Promise<void> {
  // (each group's files are fetched together: the collector runs several at once)
  await Promise.all(
    Array.from(doc.querySelectorAll("img")).map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const p = await collect(src, baseUrl);
      if (p) {
        img.setAttribute("src", refPrefix + p);
        retargetSrcset(img, src, refPrefix + p);
      }
    }),
  );
  await Promise.all(
    Array.from(doc.querySelectorAll("source[src]")).map(async (s) => {
      const src = s.getAttribute("src");
      if (!src) return;
      const p = await collect(src, baseUrl);
      if (p) s.setAttribute("src", refPrefix + p);
    }),
  );
  await Promise.all(
    Array.from(doc.querySelectorAll("[poster]")).map(async (el) => {
      const p = el.getAttribute("poster");
      if (!p) return;
      const path = await collect(p, baseUrl);
      if (path) el.setAttribute("poster", refPrefix + path);
    }),
  );
  // external SVG sprite sheets (<use href="/sprite.svg#icon">) break offline unless downloaded
  for (const u of Array.from(doc.querySelectorAll("use"))) {
    const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
    if (!href || href.startsWith("#") || href.startsWith("data:")) continue;
    const [file, frag] = href.split("#");
    const p = await collect(file, baseUrl);
    if (p) {
      u.removeAttribute("xlink:href");
      u.setAttribute("href", refPrefix + p + (frag ? "#" + frag : ""));
    }
  }
  await Promise.all(
    Array.from(doc.querySelectorAll("video[src], audio[src], embed[src], svg image[href]")).map(async (el) => {
      const src = el.getAttribute("src") || el.getAttribute("href") || "";
      if (!src || src.startsWith("blob:")) return;
      const p = await collect(src, baseUrl);
      if (p) el.setAttribute(el.hasAttribute("src") ? "src" : "href", refPrefix + p);
    }),
  );
  for (const el of Array.from(doc.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]'))) {
    const p = await collect(el.getAttribute("href") || "", baseUrl);
    if (p) el.setAttribute("href", refPrefix + p);
  }
  // classic scripts (if the capture kept them) become local files; ES modules keep
  // their absolute URL since their own relative imports would break otherwise.
  for (const sc of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = sc.getAttribute("src") || "";
    if ((sc.getAttribute("type") || "") === "module") {
      sc.setAttribute("src", absUrl(src, baseUrl));
      continue;
    }
    const p = await collect(src, baseUrl);
    if (p) sc.setAttribute("src", refPrefix + p);
  }
  await Promise.all(
    Array.from(doc.querySelectorAll("[style]")).map(async (el) => {
      const st = el.getAttribute("style") || "";
      if (st.includes("url(")) el.setAttribute("style", await rewriteCssUrls(st, baseUrl, collect, refPrefix));
    }),
  );
}

// ── Whole-site project: one folder per page, shared assets/, per-page CSS ───────
export interface SitePage {
  url: string;
  path: string; // index.html | about/index.html …
  title: string;
  html: string;
}
function rootPrefixOf(pagePath: string): string {
  return "../".repeat(pagePath.split("/").length - 1);
}
function cssNameOf(pagePath: string): string {
  const base = pagePath.replace(/\/?index\.html$/, "").replace(/\.html$/, "");
  return (base ? base.replace(/\//g, "__") : "index") + ".css";
}
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    const norm = (u: URL) => u.host + u.pathname.replace(/\/+$/, "").replace(/\.html?$/, "");
    return norm(x) === norm(y);
  } catch {
    return false;
  }
}

export async function buildSiteProject(pages: SitePage[], r: ProjectResolvers, host: string): Promise<FileMap> {
  const files: FileMap = {};
  const collect = makeCollector(files, r, "assets");
  const list = pages.map((p) => `- ${p.path}  ←  ${p.url}`).join("\n");

  for (const page of pages) {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const prefix = rootPrefixOf(page.path);
    const cssName = cssNameOf(page.path);
    const css = await collectCss(doc, page.url, r, collect, "../"); // styles/<x>.css → ../assets/…
    await rewriteElementAssets(doc, page.url, collect, prefix);

    // internal links → local pages
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") || "";
      if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
      let target: URL;
      try {
        target = new URL(href, page.url);
      } catch {
        continue;
      }
      const hit = pages.find((p) => samePage(p.url, target.href));
      if (hit) a.setAttribute("href", prefix + hit.path + (target.hash || ""));
      else a.setAttribute("href", target.href);
    }
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", `${prefix}styles/${cssName}`);
    (doc.head || doc.documentElement).appendChild(link);
    doc.querySelectorAll("base").forEach((b) => b.remove());

    files[`styles/${cssName}`] = css;
    files[page.path] = "<!doctype html>\n" + doc.documentElement.outerHTML;
  }
  files["README.md"] =
    `# ${host} — site exported by StyleLift\n\n${pages.length} page(s), static HTML with your edits baked in.\n\n` +
    "```\nindex.html          home page\n<path>/index.html   other pages (internal links are rewritten to them)\nstyles/             one stylesheet per page\nassets/             images, fonts, media, scripts (shared, de-duplicated)\n```\n\n" +
    "Open `index.html` in a browser (or serve the folder with any static server) and click through.\n\n## Pages\n" + list + "\n";
  return noteMissing(files);
}

// ── HTML project: index.html + styles.css + assets/ ─────────────────────────────
export async function buildHtmlProject(
  html: string,
  baseUrl: string,
  r: ProjectResolvers,
  host: string,
): Promise<FileMap> {
  const files: FileMap = {};
  const collect = makeCollector(files, r, "assets");
  // your own 3D models (Studio): the viewer's script, and each model a real file
  if (hasModels(html)) {
    const ex = extractModels(addModelViewerTag(html));
    html = ex.html;
    Object.assign(files, ex.files);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");

  const css = await collectCss(doc, baseUrl, r, collect, ""); // refs relative to root
  await rewriteElementAssets(doc, baseUrl, collect, "");

  // link the single stylesheet
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", "./styles.css");
  (doc.head || doc.documentElement).appendChild(link);
  // drop the offline <base> if present (we use relative paths now)
  doc.querySelectorAll("base").forEach((b) => b.remove());

  files["styles.css"] = css;
  files["index.html"] = "<!doctype html>\n" + doc.documentElement.outerHTML;
  files["README.md"] =
    `# ${host} — exported by StyleLift\n\n` +
    "Static HTML project with your edits baked in.\n\n" +
    "```\nindex.html      markup\nstyles.css      all styles + your overrides\nassets/         images, fonts, media\n```\n\n" +
    "Open `index.html` in a browser, or edit any file in your code editor.\n";
  return noteMissing(files);
}

// The React (Vite) and Next.js builders live in ./react-project (component-split output).
