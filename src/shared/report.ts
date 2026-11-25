// "Report a problem": a short report about a site that didn't work, sent to StyleLift support by the
// user's OWN email app (a mailto: link). Nothing leaves the browser until they press Send there, they see
// every line first, and they can leave out the site address and the panel log. No StyleLift server.
//
// The support address is set at build time, not written in the code: put VITE_SUPPORT_EMAIL=<address>
// in .env.local (next to package.json) and run npm run build. Without it, the report can only be copied.

export const SUPPORT_EMAIL: string = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUPPORT_EMAIL || "").trim();

export interface ReportInput {
  site: string;
  action: string;
  outcome: string;
  note: string;
  log: string[];
  includeSite: boolean;
  includeLog: boolean;
  version: string;
  browser: string;
}

/** The report as plain text — what the user reads before sending, and what is copied. */
export function reportText(r: ReportInput): string {
  const lines = [
    "StyleLift problem report",
    "",
    `Site: ${r.includeSite ? r.site || "(none)" : "(left out)"}`,
    `What I clicked: ${r.action || "(not recorded)"}`,
    `What happened: ${r.outcome || "(no message)"}`,
    "",
    "My note:",
    r.note.trim() || "(none)",
    "",
    `StyleLift ${r.version} · ${r.browser}`,
  ];
  if (r.includeLog && r.log.length) lines.push("", "Panel log (last lines):", ...r.log.slice(-40));
  return lines.join("\n");
}

// mail apps cut very long mailto links: the body is kept under this, with the full text on the clipboard
const MAX_BODY = 1800;
/** A mailto: link to `to` with the report as its body (shortened if needed). */
export function reportMailto(r: ReportInput, to: string): { href: string; shortened: boolean } {
  let body = reportText(r);
  let shortened = false;
  if (body.length > MAX_BODY) {
    body = body.slice(0, MAX_BODY) + "\n…\n(The full report was copied to the clipboard — paste it here.)";
    shortened = true;
  }
  let host = "";
  try {
    host = r.includeSite && r.site ? new URL(r.site).hostname : "";
  } catch {
    /* not a URL */
  }
  const subject = `StyleLift problem${host ? ` on ${host}` : ""}${r.action ? ` — ${r.action}` : ""}`;
  return { href: `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, shortened };
}

/** "Chrome 142 · macOS" from the browser's user agent. */
export function browserLabel(ua: string, platform: string): string {
  const v = /(?:Chrome|Chromium)\/(\d+)/.exec(ua)?.[1];
  const edge = /Edg\/(\d+)/.exec(ua)?.[1];
  const os = /Mac/i.test(platform) ? "macOS" : /Win/i.test(platform) ? "Windows" : /Linux/i.test(platform) ? "Linux" : /CrOS/.test(ua) ? "ChromeOS" : platform || "unknown OS";
  return `${edge ? `Edge ${edge}` : v ? `Chrome ${v}` : "browser unknown"} · ${os}`;
}
