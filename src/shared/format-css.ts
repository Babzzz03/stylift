// Readable CSS for exports: one declaration per line, rules and at-rules indented by nesting, a blank line
// between top-level blocks, long selector lists one selector per line. Only whitespace OUTSIDE strings, url()
// and other parentheses, and comments is touched — values, data: URIs and custom properties come out exactly
// as they went in (it never changes what the CSS means). Fast enough for megabytes (one pass, no parser).
export function formatCss(css: string, indent = "  "): string {
  const out: string[] = [];
  let line = "";
  let depth = 0;
  let paren = 0;
  let quote = "";
  let i = 0;
  const n = css.length;
  const pad = () => indent.repeat(Math.max(0, depth));
  const flush = () => {
    const t = line.trim();
    if (t) out.push(pad() + t);
    line = "";
  };
  // a selector list: one per line when long (commas outside parentheses only)
  const head = (t: string) => {
    if (t.length <= 80 || t.startsWith("@")) return pad() + t;
    const parts: string[] = [];
    let cur = "", p = 0, q = "";
    for (const ch of t) {
      if (q) { cur += ch; if (ch === q) q = ""; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") p++;
      else if (ch === ")" || ch === "]") p--;
      if (ch === "," && p === 0) { parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    return parts.map((s, k) => pad() + s + (k < parts.length - 1 ? "," : "")).join("\n");
  };
  while (i < n) {
    const ch = css[i];
    if (quote) {
      line += ch;
      if (ch === "\\" && i + 1 < n) { line += css[i + 1]; i += 2; continue; }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; line += ch; i++; continue; }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      if (paren > 0) line += css.slice(i, stop);
      else {
        flush();
        out.push(pad() + css.slice(i, stop).trim());
      }
      i = stop;
      continue;
    }
    if (paren > 0) {
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
      line += ch;
      i++;
      continue;
    }
    if (ch === "(") { paren++; line += ch; i++; continue; }
    if (ch === "{") {
      const t = line.trim();
      line = "";
      if (depth === 0 && out.length && out[out.length - 1] !== "") out.push("");
      out.push(head(t) + " {");
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      flush();
      depth = Math.max(0, depth - 1);
      out.push(pad() + "}");
      i++;
      continue;
    }
    if (ch === ";") {
      line += ";";
      flush();
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      if (line && !/\s$/.test(line)) line += " ";
      i++;
      continue;
    }
    if (ch === " " && /\s$/.test(line)) { i++; continue; }
    line += ch;
    i++;
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
