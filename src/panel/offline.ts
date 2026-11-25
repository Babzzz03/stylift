// Turn a page snapshot into a TRULY self-contained, single-file HTML: external
// stylesheets are inlined, and every referenced asset (images, fonts, background
// images, posters) is fetched and embedded as a data: URI. Runs in the panel
// (DOMParser + fetch with the extension's host permissions, so cross-origin reads
// are allowed). Resolvers are injected for testability.

import { collectCssUrls, rewriteCssUrlsWith, safeCss } from "./css-url";
import { retargetSrcset } from "../shared/srcset";

export interface OfflineResolvers {
  fetchText(url: string): Promise<string | null>; // stylesheet text
  fetchData(url: string): Promise<string | null>; // binary → data: URI
}

function abs(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

async function inlineCssUrls(
  css: string,
  base: string,
  r: OfflineResolvers,
): Promise<string> {
  const resolved = new Map<string, string>(); // original url text -> data: URI
  for (const u of collectCssUrls(css)) {
    const data = await r.fetchData(abs(u, base));
    if (data) resolved.set(u, data);
  }
  return rewriteCssUrlsWith(css, (u) => resolved.get(u.trim()) ?? null);
}

/** Inline only the remaining external stylesheets (cross-origin CDN CSS the capture
 *  could not read from the CSSOM). Assets stay linked. Used by the raw HTML export. */
export async function inlineStylesheetLinks(
  html: string,
  baseUrl: string,
  fetchText: (url: string) => Promise<string | null>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = abs(link.getAttribute("href") || "", baseUrl);
    const css = safeCss(await fetchText(href));
    if (css == null) continue;
    const style = doc.createElement("style");
    style.setAttribute("data-sl-href", href);
    if (link.getAttribute("media")) style.setAttribute("media", link.getAttribute("media") || "");
    style.textContent = rewriteCssUrlsWith(css, (u) => {
      const v = u.trim();
      return !v || /^(data:|blob:|#|about:)/i.test(v) ? null : abs(v, href);
    });
    link.replaceWith(style);
  }
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

export async function inlineForOffline(
  html: string,
  baseUrl: string,
  r: OfflineResolvers,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 1. inline external stylesheets (carry their own base for relative url()s)
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = abs(link.getAttribute("href") || "", baseUrl);
    const css = safeCss(await r.fetchText(href));
    if (css == null) continue;
    const style = doc.createElement("style");
    style.setAttribute("data-sl-base", href);
    style.textContent = css;
    link.replaceWith(style);
  }

  // 2. resolve url()s inside every <style> block
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const base = style.getAttribute("data-sl-base") || baseUrl;
    style.textContent = await inlineCssUrls(style.textContent || "", base, r);
    style.removeAttribute("data-sl-base");
  }

  // 3. images
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:")) {
      const d = await r.fetchData(abs(src, baseUrl));
      if (d) {
        img.setAttribute("src", d);
        retargetSrcset(img, src, d);
      }
    }
  }
  // 4. <source> + poster
  for (const s of Array.from(doc.querySelectorAll("source[src]"))) {
    const src = s.getAttribute("src");
    if (src && !src.startsWith("data:")) {
      const d = await r.fetchData(abs(src, baseUrl));
      if (d) s.setAttribute("src", d);
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[poster]"))) {
    const p = el.getAttribute("poster");
    if (p && !p.startsWith("data:")) {
      const d = await r.fetchData(abs(p, baseUrl));
      if (d) el.setAttribute("poster", d);
    }
  }
  // 5. inline style="… url(…) …"
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const st = el.getAttribute("style") || "";
    if (st.includes("url(")) el.setAttribute("style", await inlineCssUrls(st, baseUrl, r));
  }

  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

/** Embed only the page's web fonts (the url()s in its @font-face rules) as data: URIs. For a preview page
 *  with its own private origin: fonts load with CORS, so one served from the site's domain without CORS
 *  headers would not load there. Everything else stays linked, and the page is not re-serialised. */
export async function inlineFontFaces(
  html: string,
  baseUrl: string,
  fetchData: (url: string) => Promise<string | null>,
  maxFonts = 60,
): Promise<string> {
  const FACE = /@font-face\s*\{[^}]*\}/gi;
  const urls = new Set<string>();
  for (const b of html.match(FACE) || []) for (const u of collectCssUrls(b)) if (!/^(data:|blob:|#)/i.test(u.trim())) urls.add(u.trim());
  const got = new Map<string, string>();
  await Promise.all(
    Array.from(urls)
      .slice(0, maxFonts)
      .map(async (u) => {
        const d = await fetchData(abs(u, baseUrl));
        if (d) got.set(u, d);
      }),
  );
  if (!got.size) return html;
  return html.replace(FACE, (b) => rewriteCssUrlsWith(b, (u) => got.get(u.trim()) ?? null));
}
