// Quote-aware CSS url() scanning/rewriting shared by the project and offline
// builders. A naive regex re-matches url() tokens INSIDE a data: URI string
// (e.g. an SVG mask whose <rect fill='url(%23p)'>) and corrupts the outer
// string — this scanner consumes each url(...) token whole, so nested text is
// never touched.

export function rewriteCssUrlsWith(css: string, map: (url: string) => string | null): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const j = css.indexOf("url(", i);
    if (j === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, j);
    if (j > 0 && /[\w-]/.test(css[j - 1])) {
      out += "url(";
      i = j + 4;
      continue;
    }
    let k = j + 4;
    while (k < n && /\s/.test(css[k])) k++;
    const q = css[k] === '"' || css[k] === "'" ? css[k] : "";
    let url = "";
    let end = -1;
    if (q) {
      const close = css.indexOf(q, k + 1);
    if (close === -1) {
        out += css.slice(j);
        break;
      }
      url = css.slice(k + 1, close);
      end = css.indexOf(")", close + 1);
    } else {
      end = css.indexOf(")", k);
      if (end !== -1) url = css.slice(k, end).trim();
    }
    if (end === -1) {
      out += css.slice(j);
      break;
    }
    const mapped = url.includes("\\") ? null : map(url);
    out += mapped === null ? css.slice(j, end + 1) : `url("${mapped}")`;
    i = end + 1;
  }
  return out;
}

/** The distinct rewritable URLs in a stylesheet (data:/blob:/#/empty skipped). */
export function collectCssUrls(css: string): string[] {
  const found = new Set<string>();
  rewriteCssUrlsWith(css, (u) => {
    const v = u.trim();
    if (v && !/^(data:|blob:|#|about:)/i.test(v)) found.add(v);
    return null;
  });
  return Array.from(found);
}

/** A fetched "stylesheet" is sometimes an HTML page (login redirect, 404, bot check).
 *  Embedding that inside <style> lets its "</style>" break out and the whole page
 *  (scripts included) become live markup. Return null for anything that isn't CSS,
 *  and neutralise "</style" sequences in real CSS. */
export function safeCss(text: string | null): string | null {
  if (text == null) return null;
  const head = text.slice(0, 512).trimStart();
  if (/^(<!doctype|<html|<head|<body|<\?xml|<svg)/i.test(head) || (/<(script|div|meta)\b/i.test(head) && !/[{};]/.test(head.slice(0, 200)))) return null;
  return text.replace(/<\/(style)/gi, "<\\/$1");
}
