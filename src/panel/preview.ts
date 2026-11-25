// Preview an export in a normal Chrome tab — no deploy, no server, no unzipping. The tab opens at a
// private address (https://<site>.stylelift.test: ".test" is reserved and never reaches the internet)
// and every request it makes is answered from the export's files, held in this panel, through Chrome's
// debugger (the Fetch domain pauses each request before it leaves the browser).
//
// A Live mirror is answered the way its service worker answers on a real host (pages, query-string files,
// other domains' files, the "not in this mirror" page), so the preview shows what publishing it will
// show. Plain HTML exports are served as static files. The resolver below is pure (tested in node); the
// Chrome part only moves bytes.

export type PreviewFiles = Record<string, string | Uint8Array>;
export interface PreviewRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType: string; // CDP Network.ResourceType: "Document", "Script", "Image", …
  /** the frame that made it (live 3D scene frames are answered from the site's own files) */
  frameId?: string;
}
export type PreviewAnswer =
  | { kind: "file"; status: number; headers: [string, string][]; body: Uint8Array }
  | { kind: "continue"; url?: string };

interface Manifest {
  source: string;
  entry: string;
  entryFile: string;
  fallback?: "app" | "missing";
  pages?: { path: string; title: string }[];
  paths: Record<string, string>;
  types?: Record<string, string>;
  hosts?: { site: string[]; ext: string[] };
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", cjs: "text/javascript; charset=utf-8", json: "application/json", map: "application/json",
  webmanifest: "application/manifest+json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", avif: "image/avif", gif: "image/gif", ico: "image/x-icon", bmp: "image/bmp", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject", wasm: "application/wasm", mp4: "video/mp4", m4v: "video/mp4",
  webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac", glb: "model/gltf-binary", gltf: "model/gltf+json", txt: "text/plain; charset=utf-8",
  xml: "application/xml", vtt: "text/vtt", pdf: "application/pdf", md: "text/markdown; charset=utf-8", csv: "text/csv",
};
export const typeOfPath = (p: string): string => TYPES[(p.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase()] || "application/octet-stream";

const enc = new TextEncoder();
const bytesOf = (d: string | Uint8Array) => (typeof d === "string" ? enc.encode(d) : d);
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The private address a preview of this site opens at. */
export function previewOrigin(sourceUrl: string): string {
  let host = "site";
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    /* keep "site" */
  }
  const label = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "site";
  return `https://${label}.stylelift.test`;
}

function siteHostsOf(source: string): string[] {
  const h = new URL(source).host;
  const bare = h.replace(/^www\./, "");
  return [h, bare, "www." + bare];
}

function missingPage(m: Manifest, u: URL): string {
  const src = new URL(m.source);
  const original = src.origin + u.pathname + u.search;
  const pages = m.pages || [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not in this mirror</title>
<style>body{margin:0;background:#f7f6f3;color:#17171a;font:16px/1.55 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:72px 20px}p{color:#62626b}
code{background:#fff;border:1px solid #e2e0da;border-radius:6px;padding:2px 6px;word-break:break-all}a.b{display:inline-block;margin:8px 8px 32px 0;padding:10px 16px;border-radius:999px;border:1px solid #e2e0da;color:#17171a;text-decoration:none;background:#fff}
ul{list-style:none;padding:0;border-top:1px solid #e2e0da}li a{display:block;padding:12px 0;border-bottom:1px solid #e2e0da;color:#17171a;text-decoration:none}</style></head><body><main>
<h1>This page isn't in the mirror</h1><p><code>${esc(original)}</code> wasn't one of the ${pages.length} page(s) StyleLift mirrored from ${esc(src.host)}.</p>
<a class="b" href="${esc(original)}">Open it on ${esc(src.host)}</a><a class="b" href="${esc(m.entry || "/")}">Mirror's home page</a>
${pages.length ? "<ul>" + pages.slice(0, 300).map((p) => `<li><a href="${esc(p.path)}">${esc(p.title)}</a></li>`).join("") + "</ul>" : ""}</main></body></html>`;
}
const notFoundPage = (path: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:72px auto;padding:0 20px;color:#333}</style></head><body><h1>Not in this export</h1><p><code>${esc(path)}</code> isn't one of the exported files.</p><p><a href="/">Back to the home page</a></p></body></html>`;

/** Bytes for a request, honouring a Range header (videos ask for pieces). */
function answerBytes(all: Uint8Array, type: string, range: string | undefined, extra: [string, string][]): PreviewAnswer {
  const headers: [string, string][] = [["Content-Type", type], ["Accept-Ranges", "bytes"], ["Cache-Control", "no-store"], ...extra];
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && all.length) {
    let start = m[1] ? Number(m[1]) : Math.max(0, all.length - Number(m[2] || 0));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), all.length - 1) : all.length - 1;
    if (start >= all.length || start > end) return { kind: "file", status: 416, headers: [["Content-Range", `bytes */${all.length}`], ...extra], body: new Uint8Array(0) };
    start = Math.max(0, start);
    end = Math.max(start, end);
    return { kind: "file", status: 206, headers: [...headers, ["Content-Range", `bytes ${start}-${end}/${all.length}`]], body: all.subarray(start, end + 1) };
  }
  return { kind: "file", status: 200, headers, body: all };
}

/** How each request of the preview tab is answered. Re-reads `files` on every call, so edits show on reload. */
export function makePreviewResolver(files: PreviewFiles, origin: string): (req: PreviewRequest) => PreviewAnswer {
  const own = new URL(origin).host;
  const mf = files["mirror-manifest.json"];
  const manifest: Manifest | null = mf ? JSON.parse(typeof mf === "string" ? mf : new TextDecoder().decode(mf)) : null;
  let site: string[] = [], ext = new Set<string>();
  const byPath: Record<string, string> = {};
  if (manifest) {
    site = manifest.hosts?.site || siteHostsOf(manifest.source);
    ext = new Set(manifest.hosts?.ext || Object.keys(manifest.paths).map((k) => /^\/_ext\/([^/]+)\//.exec(k)?.[1]).filter((h): h is string => !!h));
    for (const [k, f] of Object.entries(manifest.paths)) {
      const x = /^\/_ext\/[^/]+(\/.*)$/.exec(k);
      if (x && !(x[1] in byPath)) byPath[x[1]] = f;
    }
  }
  const html = (status: number, body: string): PreviewAnswer => ({ kind: "file", status, headers: [["Content-Type", "text/html; charset=utf-8"], ["Cache-Control", "no-store"]], body: enc.encode(body) });
  // live 3D scenes in an editable export (islands.ts): their frames get the site's page and files, the way
  // the export's /sl-island-sw.js serves them on a real host (service workers are off in the preview)
  const imf = files["_3d/mirror-manifest.json"];
  const island: Manifest | null = imf ? JSON.parse(typeof imf === "string" ? imf : new TextDecoder().decode(imf)) : null;
  const islandFrames = new Set<string>();
  const iByPath: Record<string, string> = {};
  if (island) for (const [k, f] of Object.entries(island.paths)) { const x = /^\/_ext\/[^/]+(\/.*)$/.exec(k); if (x && !(x[1] in iByPath)) iByPath[x[1]] = f; }
  const sceneAnswer = (req: PreviewRequest, u: URL, same: boolean, h: Record<string, string>, cors: [string, string][]): PreviewAnswer | null => {
    if (!island) return null;
    if (req.resourceType === "Document") {
      if (!same || !u.searchParams.has("sl-island") || !("_3d/island.html" in files)) return null;
      if (req.frameId) islandFrames.add(req.frameId);
      return { kind: "file", status: 200, headers: [["Content-Type", "text/html; charset=utf-8"], ["Cache-Control", "no-store"]], body: bytesOf(files["_3d/island.html"]) };
    }
    // the scenes' own files (their script, page, manifest), as the export serves them
    if (same && u.pathname.startsWith("/_3d/") && !u.pathname.startsWith("/_3d/site/") && !u.pathname.startsWith("/_3d/_ext/")) {
      const k = decodeURIComponent(u.pathname.slice(1));
      if (k in files) return answerBytes(bytesOf(files[k]), typeOfPath(k), h.range, cors);
    }
    if (!req.frameId || !islandFrames.has(req.frameId)) return null;
    const isite = island.hosts?.site || [], iext = new Set(island.hosts?.ext || []);
    const key = same || isite.includes(u.host) ? u.pathname + u.search : iext.has(u.host) ? `/_ext/${u.host}${u.pathname}${u.search}` : null;
    if (key === null) return { kind: "continue" };
    const f = island.paths[key] || (same || isite.includes(u.host) ? island.paths[u.pathname] || iByPath[key] || iByPath[u.pathname] : null);
    if (!f || !(`_3d/${f}` in files)) return same ? { kind: "continue", url: new URL(island.source).origin + u.pathname + u.search } : { kind: "continue" };
    return answerBytes(bytesOf(files[`_3d/${f}`]), island.types?.[f] || typeOfPath(f), h.range, cors);
  };

  return (req) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return { kind: "continue" };
    }
    if (!/^https?:$/.test(u.protocol)) return { kind: "continue" };
    const same = u.host === own;
    const h = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    // a file answered for another domain: the page's code reads it like the original CDN's (CORS)
    const cors: [string, string][] = same
      ? []
      : [["Access-Control-Allow-Origin", h.origin || origin], ["Access-Control-Allow-Credentials", "true"], ["Cross-Origin-Resource-Policy", "cross-origin"], ["Timing-Allow-Origin", "*"], ["Vary", "Origin"]];
    const method = (req.method || "GET").toUpperCase();
    const isDoc = req.resourceType === "Document";
    const scene = sceneAnswer(req, u, same, h, cors);
    if (scene) return scene;

    // what stored file answers this request (null = not in the export)
    let file: string | null = null;
    let type = "";
    if (manifest) {
      if (isDoc) {
        if (!same) return { kind: "continue" };
        const p = manifest.paths;
        file = p[u.pathname + u.search] || p[u.pathname] || p[u.pathname.replace(/\/$/, "")] || p[u.pathname + "/"] || null;
        if (file && !/\.html?$/i.test(file)) file = null;
        if (!file && manifest.fallback !== "missing") file = manifest.entryFile;
        if (!file || !(file in files)) return html(404, missingPage(manifest, u));
      } else {
        if (same && (u.pathname === "/sl-mirror-sw.js" || u.pathname === "/mirror-manifest.json")) return html(404, "");
        const key = same || site.includes(u.host) ? u.pathname + u.search : ext.has(u.host) ? `/_ext/${u.host}${u.pathname}${u.search}` : null;
        if (key === null) return { kind: "continue" };
        file = manifest.paths[key] || (same || site.includes(u.host) ? manifest.paths[u.pathname] || byPath[key] || byPath[u.pathname] : null) || null;
        if (!file || !(file in files)) {
          // not in the mirror: online, from the original site (as the mirror's service worker does)
          if (same) return { kind: "continue", url: new URL(manifest.source).origin + u.pathname + u.search };
          return { kind: "continue" };
        }
      }
      type = manifest.types?.[file] || typeOfPath(file);
    } else {
      if (!same) return { kind: "continue" };
      let p = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      const tries = [p, p ? `${p.replace(/\/$/, "")}/index.html` : "index.html", `${p}.html`];
      file = tries.find((t) => t in files) || null;
      if (!file) return isDoc ? html(404, notFoundPage(u.pathname)) : { kind: "file", status: 404, headers: [["Content-Type", "text/plain"]], body: new Uint8Array(0) };
      type = typeOfPath(file);
    }
    if (method === "OPTIONS") {
      return {
        kind: "file",
        status: 204,
        headers: [...cors, ["Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"], ["Access-Control-Allow-Headers", h["access-control-request-headers"] || "*"], ["Access-Control-Max-Age", "600"]],
        body: new Uint8Array(0),
      };
    }
    if (method !== "GET" && method !== "HEAD") return { kind: "continue" };
    const a = answerBytes(bytesOf(files[file]), type, h.range, cors);
    if (method === "HEAD" && a.kind === "file") a.body = new Uint8Array(0);
    return a;
  };
}

// ── the Chrome side ───────────────────────────────────────────────────────────
// Runs before any of the page's code: the preview answers requests itself, so a service worker (the
// mirror's, or the site's own) must not take over — it would try to reach the private address for real.
const PREVIEW_GUARD = `(function(){try{var P=window.ServiceWorkerContainer&&ServiceWorkerContainer.prototype;if(P)P.register=function(){return Promise.reject(new DOMException("Service workers are off in the StyleLift preview","SecurityError"))}}catch(e){}})();`;

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}

export interface PreviewSession {
  tabId: number;
  origin: string;
  url: string;
  /** reload the preview tab (after an edit to the files) */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

/** Opens the preview tab. `files` is read on every request, so edits to it show after reload(). */
export async function startPreview(files: PreviewFiles, sourceUrl: string, entry: string, onEnd: () => void): Promise<PreviewSession> {
  const origin = previewOrigin(sourceUrl);
  const resolve = makePreviewResolver(files, origin); // reads files[…] per request: edits show on reload
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const tabId = tab.id!;
  const target = { tabId };
  const send = <T = unknown>(method: string, params?: object) => chrome.debugger.sendCommand(target, method, params) as Promise<T>;
  let ended = false;
  const onEvent = (src: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (src.tabId !== tabId || method !== "Fetch.requestPaused") return;
    const p = params as { requestId: string; request: { url: string; method: string; headers: Record<string, string> }; resourceType: string; frameId?: string };
    let a: PreviewAnswer;
    try {
      a = resolve({ url: p.request.url, method: p.request.method, headers: p.request.headers, resourceType: p.resourceType, frameId: p.frameId });
    } catch {
      a = { kind: "continue" };
    }
    if (a.kind === "file") {
      send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: a.status,
        responseHeaders: a.headers.map(([name, value]) => ({ name, value })),
        body: base64(a.body),
      }).catch(() => send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }).catch(() => {}));
    } else {
      send("Fetch.continueRequest", a.url ? { requestId: p.requestId, url: a.url } : { requestId: p.requestId }).catch(() =>
        send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}),
      );
    }
  };
  const end = () => {
    if (ended) return;
    ended = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    onEnd();
  };
  const onDetach = (src: chrome.debugger.Debuggee) => {
    if (src.tabId === tabId) end();
  };
  const onRemoved = (id: number) => {
    if (id === tabId) end();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  chrome.tabs.onRemoved.addListener(onRemoved);
  try {
    await chrome.debugger.attach(target, "1.3");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PREVIEW_GUARD });
    const url = origin + (entry.startsWith("/") ? entry : "/" + entry);
    await send("Page.navigate", { url });
    return {
      tabId,
      origin,
      url,
      reload: async () => {
        if (!ended) await send("Page.reload", { ignoreCache: true });
      },
      stop: async () => {
        if (ended) return;
        try {
          await chrome.debugger.detach(target);
        } catch {
          /* already gone */
        }
        end();
      },
    };
  } catch (e) {
    end();
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* not attached */
    }
    throw e;
  }
}

// ── Live scenes on Studio's canvas ("Play live") ─────────────────────────────────────────────────────────
// The same answers as the preview tab gives, for frames INSIDE the current tab (Studio's own page): the debugger
// is attached to this tab, auto-attaches to its frames at the preview origin, and answers only their requests
// (Studio's own requests are left alone). Chrome lets an extension debug its own pages; while it runs, Chrome
// shows its "started debugging this browser" bar.
export interface FrameSession {
  origin: string;
  stop(): Promise<void>;
}
export async function startFrameInterception(files: PreviewFiles, sourceUrl: string, onEnd: () => void): Promise<FrameSession> {
  const origin = previewOrigin(sourceUrl);
  const resolve = makePreviewResolver(files, origin);
  const tab = await chrome.tabs.getCurrent();
  if (!tab || tab.id === undefined) throw new Error("no tab");
  const tabId = tab.id;
  const root: chrome.debugger.Debuggee = { tabId };
  type Session = chrome.debugger.Debuggee & { sessionId?: string };
  const send = <T = unknown>(t: Session, method: string, params?: object) => chrome.debugger.sendCommand(t, method, params) as Promise<T>;
  let ended = false;
  const ours = new Set<string>(); // sessions of frames at the preview origin
  const onEvent = (src: chrome.debugger.Debuggee, method: string, params?: object) => {
    const s = src as Session;
    if (s.tabId !== tabId) return;
    if (method === "Target.attachedToTarget") {
      const p = params as { sessionId: string; targetInfo: { type: string; url: string }; waitingForDebugger: boolean };
      const child: Session = { tabId, sessionId: p.sessionId };
      const mine = p.targetInfo.url.startsWith(origin) || p.targetInfo.type !== "iframe";
      void (async () => {
        try {
          if (mine) {
            ours.add(p.sessionId);
            if (p.targetInfo.type === "iframe") await send(child, "Page.addScriptToEvaluateOnNewDocument", { source: PREVIEW_GUARD }).catch(() => {}); // as in the preview tab
            await send(child, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
            await send(child, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
          }
        } catch {
          /* the frame went away */
        }
        if (p.waitingForDebugger) await send(child, "Runtime.runIfWaitingForDebugger").catch(() => {});
      })();
      return;
    }
    if (method !== "Fetch.requestPaused" || !s.sessionId || !ours.has(s.sessionId)) return;
    const p = params as { requestId: string; request: { url: string; method: string; headers: Record<string, string> }; resourceType: string; frameId?: string };
    let a: PreviewAnswer;
    try {
      a = resolve({ url: p.request.url, method: p.request.method, headers: p.request.headers, resourceType: p.resourceType, frameId: p.frameId });
    } catch {
      a = { kind: "continue" };
    }
    if (a.kind === "file")
      send(s, "Fetch.fulfillRequest", { requestId: p.requestId, responseCode: a.status, responseHeaders: a.headers.map(([name, value]) => ({ name, value })), body: base64(a.body) }).catch(() =>
        send(s, "Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }).catch(() => {}),
      );
    else send(s, "Fetch.continueRequest", a.url ? { requestId: p.requestId, url: a.url } : { requestId: p.requestId }).catch(() => send(s, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}));
  };
  const end = () => {
    if (ended) return;
    ended = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    onEnd();
  };
  const onDetach = (src: chrome.debugger.Debuggee) => {
    if (src.tabId === tabId) end();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  try {
    await chrome.debugger.attach(root, "1.3");
    await send(root, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }, { type: "worker", exclude: false }] });
  } catch (e) {
    end();
    throw e;
  }
  return {
    origin,
    stop: async () => {
      if (ended) return;
      try {
        await chrome.debugger.detach(root);
      } catch {
        /* already gone */
      }
      end();
    },
  };
}
