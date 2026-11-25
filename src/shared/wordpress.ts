// WordPress connection for the "Send to WordPress" importer. Talks to the StyleLift
// Importer plugin's REST routes with an Application Password (HTTP Basic auth).
// Credentials stay in chrome.storage.local (this browser only).

export interface WpSettings {
  wpSite: string;
  wpUser: string;
  wpAppPassword: string;
}
export interface WpStatus {
  ok: boolean;
  site: string;
  user: string;
  elementor_active: boolean;
  elementor_version: string | null;
  can_import_html: boolean;
  can_create_pages: boolean;
  plugin_version: string;
}
export interface WpImportResult {
  id: number;
  target: "template" | "page";
  edit_url: string;
  view_url: string;
  images_imported: number;
  elementor_active: boolean;
}

export async function loadWp(): Promise<WpSettings> {
  const s = (await chrome.storage.local.get(["wpSite", "wpUser", "wpAppPassword"])) as Partial<WpSettings>;
  return { wpSite: s.wpSite || "", wpUser: s.wpUser || "", wpAppPassword: s.wpAppPassword || "" };
}
export async function saveWp(s: WpSettings): Promise<void> {
  await chrome.storage.local.set({ wpSite: normalizeSite(s.wpSite), wpUser: s.wpUser.trim(), wpAppPassword: s.wpAppPassword.replace(/\s+/g, " ").trim() });
}
export const wpConfigured = (s: WpSettings) => !!(s.wpSite && s.wpUser && s.wpAppPassword);

export function normalizeSite(site: string): string {
  let s = site.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/+$/, "").replace(/\/wp-admin.*$/, "").replace(/\/wp-json.*$/, "");
  } catch {
    return s.replace(/\/+$/, "");
  }
}

function basic(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return "Basic " + btoa(bin);
}

/** A plain-language reason for a failed request. */
function explain(status: number, body: unknown, site: string): string {
  const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : "";
  const code = body && typeof body === "object" && "code" in body ? String((body as { code: unknown }).code) : "";
  if (status === 401 || code === "incorrect_password" || code === "invalid_username") return "WordPress rejected the username or application password. Create a new application password under Users → Profile.";
  if (status === 404 || code === "rest_no_route") return `The StyleLift Importer plugin isn't active on ${site}. Install it under Plugins → Add New → Upload, then activate it.`;
  if (status === 403) return msg || "Your WordPress account isn't allowed to do this.";
  if (status === 413) return msg || "The import is too large. Send fewer sections at a time.";
  return msg || `WordPress answered with an error (${status}).`;
}

async function wpFetch<T>(s: WpSettings, route: string, init: RequestInit = {}): Promise<T> {
  const site = normalizeSite(s.wpSite);
  const headers = { Authorization: basic(s.wpUser, s.wpAppPassword), Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) };
  // pretty permalinks first; sites without them only answer ?rest_route=
  const urls = [`${site}/wp-json${route}`, `${site}/?rest_route=${encodeURIComponent(route)}`];
  let last: { status: number; body: unknown } | null = null;
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, credentials: "omit" });
    } catch {
      throw new Error(`Couldn't reach ${site}. Check the address and that the site is online.`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: a theme 404 page or a login wall */
    }
    if (res.ok && body !== null) return body as T;
    last = { status: res.status, body };
    if (res.status === 404 && body === null) continue; // try the ?rest_route= form
    break;
  }
  throw new Error(explain(last?.status ?? 0, last?.body, site));
}

export const wpStatus = (s: WpSettings) => wpFetch<WpStatus>(s, "/stylelift/v1/status");

export function wpImport(
  s: WpSettings,
  payload: { title: string; target: "template" | "page"; template_type: "section" | "page"; content: unknown[]; page_settings?: Record<string, unknown>; source_url?: string; sideload?: boolean },
): Promise<WpImportResult> {
  return wpFetch<WpImportResult>(s, "/stylelift/v1/import", { method: "POST", body: JSON.stringify(payload) });
}
