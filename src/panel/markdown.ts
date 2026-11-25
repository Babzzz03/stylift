// Minimal, dependency-free markdown -> HTML for the DESIGN.md preview.
// Supports: #/##/### headings, > blockquote, GFM tables, - lists,
// `inline code`, **bold**, *em*. All text is HTML-escaped first.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let out = esc(s);
  // inline code, with a color swatch when it wraps a hex value
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    const hex = /^#[0-9a-fA-F]{3,8}$/.test(code)
      ? `<span class="swatch" style="background:${code}"></span>`
      : "";
    return `${hex}<code>${code}</code>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // table: header row followed by a separator row of ---
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      closeList();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const headers = cells(line);
      html.push("<table><thead><tr>");
      for (const h of headers) html.push(`<th>${inline(h)}</th>`);
      html.push("</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html.push("<tr>");
        for (const c of cells(lines[i])) html.push(`<td>${inline(c)}</td>`);
        html.push("</tr>");
        i++;
      }
      html.push("</tbody></table>");
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return html.join("\n");
}
