// Whole-site crawl (panel side). Discovers same-origin pages from captured HTML
// (+ /sitemap.xml), walks them breadth-first with a bounded page/depth budget,
// and hands each URL to an injected `capture` callback. Pure logic — the
// browser plumbing (opening tabs, running capturePage) is passed in, so this
// is testable in jsdom.

import type { CaptureResult, CaptureStats } from "../extractor/capture";

export interface CrawlOptions {
  maxPages: number; // hard cap on captured pages (incl. the start page)
  maxDepth: number; // link depth from the start page
  useSitemap: boolean; // seed the queue from /sitemap.xml
}
export interface CrawlPage {
  url: string; // normalized absolute URL
  path: string; // project-relative file path (index.html, about/index.html …)
  title: string;
  html: string;
  stats: CaptureStats;
  warnings: string[];
}
export interface CrawlHooks {
  capture(url: string): Promise<CaptureResult>;
  fetchText?(url: string): Promise<string | null>;
  onProgress?(done: number, queued: number, url: string): void;
  isCancelled?(): boolean;
}

const SKIP_EXT = /\.(pdf|zip|rar|7z|gz|tgz|dmg|exe|msi|apk|jpe?g|png|gif|webp|svg|avif|ico|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|css|js|mjs|json|xml|txt|csv|rss|atom)$/i;

/** Canonical form used for de-duplication: same-origin, no hash, no query, no trailing slash (except root). */
export function normalizeUrl(href: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const b = new URL(base);
  if (u.host !== b.host) return null;
  u.hash = "";
  u.search = "";
  let p = u.pathname.replace(/\/{2,}/g, "/");
  if (SKIP_EXT.test(p)) return null;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  u.pathname = p || "/";
  return u.href;
}

/** URL → file path inside the exported project. */
export function urlToPagePath(url: string): string {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, "");
  p = p.replace(/\.html?$/i, "");
  if (!p) return "index.html";
  const safe = p
    .split("/")
    .map((s) => s.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "") || "page")
    .join("/");
  return safe + "/index.html";
}

/** Relative prefix to reach the project root from a page path ("" or "../" × depth). */
export function rootPrefix(pagePath: string): string {
  const depth = pagePath.split("/").length - 1;
  return "../".repeat(depth);
}

export function discoverLinks(html: string, pageUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseEl = doc.querySelector("base[href]");
  const base = baseEl ? new URL(baseEl.getAttribute("href") || "", pageUrl).href : pageUrl;
  const out = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") || "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    if (a.getAttribute("download") != null) continue;
    const n = normalizeUrl(href, base);
    if (n) out.add(n);
  }
  return Array.from(out);
}

export function parseSitemap(xml: string, origin: string): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return { pages, sitemaps };
  for (const sm of Array.from(doc.querySelectorAll("sitemap > loc"))) {
    const u = (sm.textContent || "").trim();
    if (u) sitemaps.push(u);
  }
  for (const loc of Array.from(doc.querySelectorAll("url > loc"))) {
    const n = normalizeUrl((loc.textContent || "").trim(), origin);
    if (n) pages.push(n);
  }
  return { pages, sitemaps };
}

export async function crawlSite(
  startUrl: string,
  seed: CaptureResult | null,
  opts: CrawlOptions,
  hooks: CrawlHooks,
): Promise<CrawlPage[]> {
  const start = normalizeUrl(startUrl, startUrl) || startUrl;
  const pages: CrawlPage[] = [];
  const seen = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [];
  const usedPaths = new Set<string>();

  const pagePath = (url: string): string => {
    let p = urlToPagePath(url);
    let i = 2;
    while (usedPaths.has(p)) p = p.replace(/index\.html$/, `index-${i++}.html`);
    usedPaths.add(p);
    return p;
  };
  const enqueue = (urls: string[], depth: number) => {
    for (const u of urls) {
      if (seen.has(u) || seen.size >= opts.maxPages * 4) continue;
      seen.add(u);
      queue.push({ url: u, depth });
    }
  };
  const add = (url: string, r: CaptureResult, depth: number) => {
    // a text / Markdown / JSON document (e.g. instructions for AI agents listed in a sitemap) isn't a page
    const type = r.stats?.contentType;
    if (type && !/html/i.test(type)) return;
    pages.push({ url, path: pagePath(url), title: r.title, html: r.html, stats: r.stats, warnings: r.warnings });
    if (depth < opts.maxDepth) enqueue(discoverLinks(r.html, url), depth + 1);
  };

  // sitemap seeds (depth 1 so their own links are still followed). They queue up AFTER the pages the
  // start page links to: a shop's sitemap lists hundreds of products, and with a page limit those would
  // crowd out the menu (Jewelry, About, Create your own…), which is what people click first.
  const fromSitemap: string[] = [];
  if (opts.useSitemap && hooks.fetchText) {
    try {
      const origin = new URL(start).origin;
      const visited = new Set<string>();
      const walk = async (smUrl: string, hops: number) => {
        if (hops > 2 || visited.has(smUrl)) return;
        visited.add(smUrl);
        const xml = await hooks.fetchText!(smUrl);
        if (!xml) return;
        const { pages: p, sitemaps } = parseSitemap(xml, origin);
        fromSitemap.push(...p);
        for (const s of sitemaps.slice(0, 10)) await walk(s, hops + 1);
      };
      await walk(origin + "/sitemap.xml", 0);
    } catch {
      /* no sitemap */
    }
  }

  // start page
  const first = seed || (await hooks.capture(start));
  add(start, first, 0);
  enqueue(fromSitemap, 1);
  hooks.onProgress?.(pages.length, queue.length, start);

  while (queue.length && pages.length < opts.maxPages) {
    if (hooks.isCancelled?.()) break;
    const { url, depth } = queue.shift()!;
    hooks.onProgress?.(pages.length, queue.length + 1, url);
    try {
      const r = await hooks.capture(url);
      add(url, r, depth);
    } catch (e) {
      pages.push({
        url, path: pagePath(url), title: url, html: "",
        stats: {} as CaptureStats,
        warnings: ["Capture failed: " + (e instanceof Error ? e.message : String(e))],
      });
    }
  }
  return pages.filter((p) => p.html);
}
