// One-click publishing of an export: Netlify, Vercel (both give an https link) and GitHub (a repository
// with the files). Each talks to the provider's public REST API with a personal access token the user
// pastes into Settings → Publishing. Tokens stay in chrome.storage.local (this browser only) and are sent
// only to that provider. No StyleLift server is involved.
//
// Every function takes the files as they would go into the zip, a progress callback and (for tests) a
// fetch implementation and an API base, so they run against mock servers in node too.

export type PublishFiles = Record<string, string | Uint8Array>;
export type Progress = (message: string) => void;
type FetchFn = typeof fetch;

export interface PublishSettings {
  netlifyToken: string;
  vercelToken: string;
  vercelTeamId: string;
  githubToken: string;
  githubPrivate: boolean;
}
/** Where an export was published before, so publishing again updates the same site / project / repo. */
export interface PublishTargets {
  netlify?: { siteId: string; url: string; at: number };
  vercel?: { project: string; url: string; at: number };
  github?: { repo: string; url: string; at: number };
}

const KEYS = ["netlifyToken", "vercelToken", "vercelTeamId", "githubToken", "githubPrivate"] as const;
export async function loadPublishSettings(): Promise<PublishSettings> {
  const s = (await chrome.storage.local.get([...KEYS])) as Partial<PublishSettings>;
  return {
    netlifyToken: s.netlifyToken || "",
    vercelToken: s.vercelToken || "",
    vercelTeamId: s.vercelTeamId || "",
    githubToken: s.githubToken || "",
    githubPrivate: s.githubPrivate !== false,
  };
}
export async function savePublishSettings(s: Partial<PublishSettings>): Promise<void> {
  const clean: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(s)) clean[k] = typeof v === "string" ? v.trim() : !!v;
  await chrome.storage.local.set(clean);
}
export async function loadTargets(key: string): Promise<PublishTargets> {
  const s = (await chrome.storage.local.get("publishTargets")) as { publishTargets?: Record<string, PublishTargets> };
  return s.publishTargets?.[key] || {};
}
export async function saveTarget<K extends keyof PublishTargets>(key: string, which: K, value: PublishTargets[K]): Promise<void> {
  const s = (await chrome.storage.local.get("publishTargets")) as { publishTargets?: Record<string, PublishTargets> };
  const all = s.publishTargets || {};
  all[key] = { ...(all[key] || {}), [which]: value };
  await chrome.storage.local.set({ publishTargets: all });
}

export class PublishError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "PublishError";
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
export const bytesOf = (d: string | Uint8Array): Uint8Array => (typeof d === "string" ? enc.encode(d) : d);
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export async function sha1(b: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", b as BufferSource));
}
/** The id git gives a file's content: sha1("blob <size>\0" + bytes). */
export async function gitBlobSha(b: Uint8Array): Promise<string> {
  const head = enc.encode(`blob ${b.length}\0`);
  const all = new Uint8Array(head.length + b.length);
  all.set(head);
  all.set(b, head.length);
  return sha1(all);
}
export function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** A name a provider accepts: lowercase letters, digits and dashes (Vercel also bans "---"). */
export function slugName(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "stylelift-export"
  );
}

/** Run `fn` over items, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

interface Call {
  provider: "Netlify" | "Vercel" | "GitHub";
  fetchImpl: FetchFn;
  headers: Record<string, string>;
  onProgress?: Progress;
}
/** One API request with plain-language errors; retries network drops, 5xx and rate limits. */
async function call<T = any>(c: Call, url: string, init: RequestInit & { json?: unknown } = {}, tries = 4): Promise<T> {
  const headers: Record<string, string> = { ...c.headers, ...((init.headers as Record<string, string>) || {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try {
      res = await c.fetchImpl(url, { method: init.method || "GET", headers, body });
    } catch (e) {
      lastErr = e;
      await wait(800 * 3 ** attempt);
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.ok) return data as T;
    const msg = (data && typeof data === "object" && (data.message || data.error?.message || data.error_message || (typeof data.error === "string" ? data.error : ""))) || "";
    const limited = res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(String(msg))) || res.headers.get("x-ratelimit-remaining") === "0";
    if (limited && attempt < tries - 1) {
      const after = Number(res.headers.get("retry-after")) || 0;
      const reset = Number(res.headers.get("x-ratelimit-reset")) || 0;
      const ms = Math.min(120_000, after ? after * 1000 : reset ? Math.max(1000, reset * 1000 - Date.now()) : 60_000);
      c.onProgress?.(`${c.provider} asked StyleLift to slow down — waiting ${Math.round(ms / 1000)} s…`);
      await wait(ms);
      continue;
    }
    if (res.status >= 500 && attempt < tries - 1) {
      await wait(800 * 3 ** attempt);
      continue;
    }
    if (res.status === 401 || (res.status === 403 && !limited)) throw new PublishError(`${c.provider} refused the access token${msg ? ` (${msg})` : ""}. Check it in Settings → Publishing.`, res.status);
    throw new PublishError(`${c.provider}: ${msg || `the request failed (HTTP ${res.status})`}`, res.status);
  }
  throw new PublishError(`Couldn't reach ${c.provider}: ${lastErr instanceof Error ? lastErr.message : "no connection"}. Check your internet connection and try again.`);
}

// ── Netlify ───────────────────────────────────────────────────────────────────
export interface NetlifyOptions {
  token: string;
  /** a site published before (updated in place); a new site is created when it's gone */
  siteId?: string;
  /** a name for a new site (Netlify picks one when it's taken) */
  name?: string;
  api?: string;
}
export interface NetlifyResult {
  siteId: string;
  url: string;
  adminUrl: string;
  uploaded: number;
}
/** Deploys the files as a static site (file digests: only files Netlify doesn't have are uploaded). */
export async function publishNetlify(files: PublishFiles, o: NetlifyOptions, onProgress: Progress = () => {}, fetchImpl: FetchFn = fetch): Promise<NetlifyResult> {
  if (!o.token) throw new PublishError("Add a Netlify access token first: Settings → Publishing.");
  const base = (o.api || "https://api.netlify.com/api/v1").replace(/\/$/, "");
  const c: Call = { provider: "Netlify", fetchImpl, headers: { Authorization: `Bearer ${o.token}` }, onProgress };
  let site: any = null;
  if (o.siteId) {
    try {
      site = await call(c, `${base}/sites/${encodeURIComponent(o.siteId)}`, {}, 2);
    } catch (e) {
      if (!(e instanceof PublishError) || e.status !== 404) throw e;
    }
  }
  if (!site) {
    onProgress("Netlify: creating the site…");
    try {
      site = await call(c, `${base}/sites`, { method: "POST", json: o.name ? { name: o.name } : {} }, 2);
    } catch (e) {
      if (!(e instanceof PublishError) || e.status !== 422) throw e;
      site = await call(c, `${base}/sites`, { method: "POST", json: {} }); // name taken: Netlify picks one
    }
  }
  onProgress("Netlify: checking which files it needs…");
  const digests: Record<string, string> = {};
  const byHash = new Map<string, { path: string; bytes: Uint8Array }>();
  for (const [path, data] of Object.entries(files)) {
    const bytes = bytesOf(data);
    const h = await sha1(bytes);
    digests["/" + path] = h;
    if (!byHash.has(h)) byHash.set(h, { path, bytes });
  }
  let deploy: any = await call(c, `${base}/sites/${site.id}/deploys`, { method: "POST", json: { files: digests, async: true } });
  for (let i = 0; i < 120 && (deploy.state === "new" || deploy.state === "preparing" || !Array.isArray(deploy.required)); i++) {
    if (deploy.state === "error") break;
    await wait(1000);
    deploy = await call(c, `${base}/deploys/${deploy.id}`);
  }
  if (deploy.state === "error") throw new PublishError(`Netlify: ${deploy.error_message || "the deploy failed"}`);
  const required: string[] = Array.isArray(deploy.required) ? deploy.required : [];
  let done = 0;
  await pool(required, 4, async (h) => {
    const f = byHash.get(h);
    if (!f) return;
    await call(c, `${base}/deploys/${deploy.id}/files/${encodePath(f.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: f.bytes as BodyInit,
    });
    onProgress(`Netlify: uploading files ${++done}/${required.length}…`);
  });
  onProgress("Netlify: publishing…");
  for (let i = 0; i < 240 && deploy.state !== "ready"; i++) {
    if (deploy.state === "error") throw new PublishError(`Netlify: ${deploy.error_message || "the deploy failed"}`);
    await wait(i < 10 ? 1000 : 2500);
    deploy = await call(c, `${base}/deploys/${deploy.id}`);
  }
  if (deploy.state !== "ready") throw new PublishError("Netlify is still processing the deploy. It will appear on the site shortly; check app.netlify.com.");
  return {
    siteId: site.id,
    url: site.ssl_url || deploy.ssl_url || site.url || deploy.url,
    adminUrl: site.admin_url || "https://app.netlify.com",
    uploaded: required.length,
  };
}

// ── Vercel ────────────────────────────────────────────────────────────────────
export interface VercelOptions {
  token: string;
  /** the project name (created on first deploy; used again to update it) */
  project: string;
  teamId?: string;
  /** null = plain files, served as they are; "nextjs" / "vite" = Vercel builds the project */
  framework?: string | null;
  api?: string;
}
export interface VercelResult {
  project: string;
  url: string;
  uploaded: number;
}
export async function publishVercel(files: PublishFiles, o: VercelOptions, onProgress: Progress = () => {}, fetchImpl: FetchFn = fetch): Promise<VercelResult> {
  if (!o.token) throw new PublishError("Add a Vercel access token first: Settings → Publishing.");
  const base = (o.api || "https://api.vercel.com").replace(/\/$/, "");
  const team = o.teamId ? `teamId=${encodeURIComponent(o.teamId)}` : "";
  const q = (extra = "") => {
    const parts = [team, extra].filter(Boolean);
    return parts.length ? `?${parts.join("&")}` : "";
  };
  const c: Call = { provider: "Vercel", fetchImpl, headers: { Authorization: `Bearer ${o.token}` }, onProgress };
  const list: { file: string; sha: string; size: number }[] = [];
  const byHash = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    const bytes = bytesOf(data);
    const h = await sha1(bytes);
    list.push({ file: path, sha: h, size: bytes.length });
    byHash.set(h, bytes);
  }
  const upload = async (hashes: string[]) => {
    let done = 0;
    await pool(hashes, 4, async (h) => {
      const bytes = byHash.get(h)!;
      await call(c, `${base}/v2/files${q()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "x-vercel-digest": h },
        body: bytes as BodyInit,
      });
      onProgress(`Vercel: uploading files ${++done}/${hashes.length}…`);
    });
  };
  await upload(Array.from(byHash.keys()));
  const body = {
    name: o.project,
    files: list,
    target: "production",
    projectSettings:
      o.framework
        ? { framework: o.framework }
        : { framework: null, buildCommand: null, installCommand: null, devCommand: null, outputDirectory: null },
  };
  onProgress(o.framework ? "Vercel: building the project (a minute or two)…" : "Vercel: publishing…");
  let d: any;
  try {
    d = await call(c, `${base}/v13/deployments${q("skipAutoDetectionConfirmation=1")}`, { method: "POST", json: body }, 2);
  } catch (e) {
    // files Vercel lost track of: upload them again, once
    if (!(e instanceof PublishError) || !/missing_files|missing files/i.test(e.message)) throw e;
    await upload(Array.from(byHash.keys()));
    d = await call(c, `${base}/v13/deployments${q("skipAutoDetectionConfirmation=1")}`, { method: "POST", json: body }, 2);
  }
  for (let i = 0; i < 300 && !["READY", "ERROR", "CANCELED"].includes(d.readyState); i++) {
    await wait(i < 10 ? 1000 : 3000);
    d = await call(c, `${base}/v13/deployments/${encodeURIComponent(d.id)}${q()}`);
  }
  if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new PublishError(`Vercel: the deploy ${d.readyState === "ERROR" ? "failed" : "was cancelled"}${d.errorMessage ? ` — ${d.errorMessage}` : ""}. Its log is on vercel.com.`);
  if (d.readyState !== "READY") throw new PublishError("Vercel is still building. The link will work once it finishes; check vercel.com.");
  // the project's production address is public; a single deployment's own address may be login-protected
  const aliases: string[] = Array.isArray(d.alias) ? d.alias : [];
  const host = aliases.find((a) => a === `${o.project}.vercel.app`) || aliases.slice().sort((a, b) => a.length - b.length)[0] || d.url;
  return { project: o.project, url: `https://${host}`, uploaded: byHash.size };
}

// ── GitHub ────────────────────────────────────────────────────────────────────
export interface GitHubOptions {
  token: string;
  /** repository name in the token owner's account (created when it doesn't exist) */
  repo: string;
  private: boolean;
  message?: string;
  description?: string;
  api?: string;
}
export interface GitHubResult {
  repo: string;
  url: string;
  uploaded: number;
}
const INLINE_MAX = 400_000; // text files up to this size go inside the tree request
const INLINE_BATCH = 6_000_000; // inline text per tree request
const utf8 = new TextDecoder("utf-8", { fatal: true });
function asText(d: string | Uint8Array): string | null {
  if (typeof d === "string") return d;
  if (d.length > INLINE_MAX || d.includes(0)) return null;
  try {
    return utf8.decode(d);
  } catch {
    return null;
  }
}
/** Commits the files to a repository in the token owner's account (one commit that replaces its content). */
export async function pushGitHub(files: PublishFiles, o: GitHubOptions, onProgress: Progress = () => {}, fetchImpl: FetchFn = fetch): Promise<GitHubResult> {
  if (!o.token) throw new PublishError("Add a GitHub access token first: Settings → Publishing.");
  const base = (o.api || "https://api.github.com").replace(/\/$/, "");
  const c: Call = {
    provider: "GitHub",
    fetchImpl,
    headers: { Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    onProgress,
  };
  const me = await call<{ login: string }>(c, `${base}/user`);
  const full = `${me.login}/${o.repo}`;
  let repo: any = null;
  try {
    repo = await call(c, `${base}/repos/${full}`, {}, 2);
  } catch (e) {
    if (!(e instanceof PublishError) || e.status !== 404) throw e;
  }
  if (!repo) {
    onProgress(`GitHub: creating ${full}…`);
    repo = await call(c, `${base}/user/repos`, { method: "POST", json: { name: o.repo, private: o.private, auto_init: true, description: o.description || "" } });
  }
  const branch = repo.default_branch || "main";
  // the branch's latest commit (a brand-new repository can take a moment to have one)
  let head: any = null;
  for (let i = 0; i < 8 && !head; i++) {
    try {
      head = await call(c, `${base}/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`, {}, 1);
    } catch (e) {
      if (!(e instanceof PublishError) || (e.status !== 404 && e.status !== 409)) throw e;
      await wait(1000);
    }
  }
  if (!head) throw new PublishError(`GitHub: the repository ${full} has no ${branch} branch yet. Add a first commit on github.com, then push again.`);
  const parent: string = head.object.sha;
  // files already in the repository with the same content are not uploaded again
  const existing = new Map<string, string>();
  try {
    const commit = await call(c, `${base}/repos/${full}/git/commits/${parent}`, {}, 2);
    const tree = await call(c, `${base}/repos/${full}/git/trees/${commit.tree.sha}?recursive=1`, {}, 2);
    if (!tree.truncated) for (const t of tree.tree || []) if (t.type === "blob") existing.set(t.path, t.sha);
  } catch {
    /* compare nothing: upload everything */
  }
  type Entry = { path: string; mode: "100644"; type: "blob"; sha?: string; content?: string };
  const entries: Entry[] = [];
  const binaries = new Map<string, { bytes: Uint8Array; entries: Entry[] }>(); // by git id: identical files go up once
  let reused = 0;
  for (const [path, data] of Object.entries(files)) {
    const bytes = bytesOf(data);
    const sha = await gitBlobSha(bytes);
    const entry: Entry = { path, mode: "100644", type: "blob" };
    entries.push(entry);
    if (existing.get(path) === sha) {
      entry.sha = sha;
      reused++;
      continue;
    }
    const text = asText(data);
    if (text !== null) entry.content = text;
    else {
      const b = binaries.get(sha) || { bytes, entries: [] };
      b.entries.push(entry);
      binaries.set(sha, b);
    }
  }
  let done = 0;
  const uploads = Array.from(binaries.values());
  await pool(uploads, 2, async (b) => {
    const r = await call<{ sha: string }>(c, `${base}/repos/${full}/git/blobs`, { method: "POST", json: { content: base64(b.bytes), encoding: "base64" } }, 6);
    for (const e of b.entries) e.sha = r.sha;
    onProgress(`GitHub: uploading files ${++done}/${uploads.length}…`);
  });
  // the tree, in batches (text goes inline; each batch builds on the last)
  onProgress("GitHub: writing the commit…");
  let treeSha: string | undefined;
  let batch: Entry[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const t = await call<{ sha: string }>(c, `${base}/repos/${full}/git/trees`, { method: "POST", json: treeSha ? { base_tree: treeSha, tree: batch } : { tree: batch } });
    treeSha = t.sha;
    batch = [];
    size = 0;
  };
  for (const e of entries) {
    const s = e.content ? e.content.length : 100;
    if (size + s > INLINE_BATCH) await flush();
    batch.push(e);
    size += s;
  }
  await flush();
  const commit = await call<{ sha: string }>(c, `${base}/repos/${full}/git/commits`, { method: "POST", json: { message: o.message || "Export from StyleLift", tree: treeSha, parents: [parent] } });
  await call(c, `${base}/repos/${full}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", json: { sha: commit.sha, force: false } });
  return { repo: full, url: repo.html_url || `https://github.com/${full}`, uploaded: entries.length - reused };
}

// ── "Save and test" in Settings ──────────────────────────────────────────────
export async function whoAmI(provider: "netlify" | "vercel" | "github", s: PublishSettings, fetchImpl: FetchFn = fetch): Promise<string> {
  if (provider === "netlify") {
    const u = await call<any>({ provider: "Netlify", fetchImpl, headers: { Authorization: `Bearer ${s.netlifyToken}` } }, "https://api.netlify.com/api/v1/user", {}, 2);
    return u.email || u.full_name || u.slug || "your account";
  }
  if (provider === "vercel") {
    const u = await call<any>({ provider: "Vercel", fetchImpl, headers: { Authorization: `Bearer ${s.vercelToken}` } }, "https://api.vercel.com/v2/user", {}, 2);
    return u.user?.username || u.user?.email || "your account";
  }
  const u = await call<any>(
    { provider: "GitHub", fetchImpl, headers: { Authorization: `Bearer ${s.githubToken}`, Accept: "application/vnd.github+json" } },
    "https://api.github.com/user",
    {},
    2,
  );
  return u.login;
}
