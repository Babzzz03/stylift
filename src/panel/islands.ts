// Live 3D in the editable exports ("islands"). A page's 3D scenes (WebGL canvases) are drawn by the site's own
// code — its Three.js scene, shaders, models, mouse logic — which can't be rewritten as anything else. So an
// editable export keeps each one running from the site's own files: a frame showing the site's original page
// with everything but that one canvas hidden, laid exactly over the canvas's place in YOUR page, scrolled with
// it and fed its pointer. Everything around it stays your editable HTML / React / Next.js.
//
//   sl-islands.js      in your page: puts a frame over each [data-sl-island] stand-in picture once ready,
//                      keeps it aligned, scrolls it with the page, passes the pointer on (or lets the pointer
//                      straight in where nothing of yours covers the scene: drag to rotate works)
//   sl-island-sw.js    a service worker that serves the site's stored files to the scene frames only (and to
//                      the workers they start) under their original URLs — never to your own pages
//   _3d/…              the site's files from a Live mirror of the page, byte for byte, its page as island.html
//   _3d/sl-island.js   inside a scene frame: only the chosen canvas shows; links don't navigate
//
// It runs the site's actual code (like the Live mirror): only for sites you own or may copy. Needs a web
// server (any static host; the site's root): a page opened from disk keeps the pictures.
import type { MirrorResult } from "./mirror";

export type IslandFiles = Record<string, Uint8Array | string>;
/** Does an exported page have 3D scenes marked to stay live? */
export const hasIslands = (html: string): boolean => /\sdata-sl-island="/.test(html);
/** Starts the islands in a page (from the page's own address: a <base> pointing at the original site — the
 *  capture keeps one for relative links — must not send these requests there). */
export const ISLAND_BOOT = `(function(){if(document.querySelector("script[data-sl-islands-run]"))return;var s=document.createElement("script");s.src=location.origin+"/sl-islands.js";s.setAttribute("data-sl-islands-run","");(document.body||document.documentElement).appendChild(s)})();`;
/** The tag that loads the islands in an HTML page. */
export const ISLAND_TAG = `<script data-sl-anim-runtime="" data-sl-islands="">${ISLAND_BOOT}</script>`; // (React / Next.js run it after rendering, with StyleLift's other scripts)

/** Add the island loader to an HTML page that has 3D scenes. */
export function addIslandTag(html: string): string {
  if (!hasIslands(html) || /data-sl-islands/.test(html)) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${ISLAND_TAG}</body>`) : html + ISLAND_TAG;
}

/** The files that keep the 3D scenes live, from a Live mirror of the same page. `prefix` puts them in a folder
 *  of the project (Next.js / Vite: "public/"); they are served from the site's root. */
export function islandFiles(m: MirrorResult, pageUrl: string, prefix = ""): IslandFiles {
  const raw = m.files["mirror-manifest.json"];
  const man = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as {
    source: string;
    entryFile: string;
    paths: Record<string, string>;
    types: Record<string, string>;
    hosts: { site: string[]; ext: string[] };
  };
  const out: IslandFiles = {};
  // the site's own files and those from other domains (CDNs: models, textures, libraries)
  for (const [k, v] of Object.entries(m.files)) if (k.startsWith("site/") || k.startsWith("_ext/")) out[`${prefix}_3d/${k}`] = v;
  const entry = m.files[man.entryFile];
  const page = typeof entry === "string" ? entry : entry ? new TextDecoder().decode(entry) : "";
  // the site's page as a scene frame: the mirror's opener swapped for the scene script, first thing in <head>
  const island = page.replace(/<script data-sl-mirror>[\s\S]*?<\/script>/, `<script src="/_3d/sl-island.js"></script>`);
  out[`${prefix}_3d/island.html`] = /sl-island\.js/.test(island) ? island : island.replace(/<head[^>]*>/i, (h) => `${h}<script src="/_3d/sl-island.js"></script>`);
  out[`${prefix}_3d/mirror-manifest.json`] = JSON.stringify(man);
  out[`${prefix}_3d/sl-island.js`] = sceneScript(man.hosts.site, man.hosts.ext);
  let origin = "";
  try {
    origin = new URL(man.source || pageUrl).origin;
  } catch {
    origin = "";
  }
  out[`${prefix}sl-island-sw.js`] = islandWorker(origin, man.hosts.site, man.hosts.ext);
  let path = "/";
  try {
    const u = new URL(pageUrl);
    path = u.pathname + u.search;
  } catch {
    path = "/";
  }
  out[`${prefix}sl-islands.js`] = loaderScript(path);
  return out;
}

// ── inside a scene frame ──────────────────────────────────────────────────────────────────────────────
function sceneScript(site: string[], ext: string[]): string {
  return `// StyleLift live 3D: this is the site's own page, running its own code. Only one of its 3D scenes shows.
(function () {
  var q = new URLSearchParams(location.search);
  var sel = q.get("sl-sel") || "", idx = parseInt(q.get("sl-island") || "0", 10) || 0;
  // the canvas's own attributes (as the capture saw them — on its stand-in picture): its file, id, data-…, classes.
  // What finds it: a page built by a framework (Vue, React) is laid out differently while it loads, so the path
  // to it may point elsewhere and "the Nth canvas" may be another one (a menu's icon)
  var want = {};
  try { want = JSON.parse(q.get("sl-attrs") || "{}") || {}; } catch (e) { want = {}; }
  var wantKeys = Object.keys(want);
  var weight = function (k) { return k === "class" ? 1 : k === "id" || /^data-/.test(k) ? 3 : 1; };
  var full = 0;
  for (var wk = 0; wk < wantKeys.length; wk++) full += weight(wantKeys[wk]);
  var score = function (c) {
    var n = 0;
    for (var k = 0; k < wantKeys.length; k++) {
      var a = wantKeys[k], v = c.getAttribute(a);
      if (v === null) continue;
      if (a === "class") {
        var mine = String(want[a]).split(/\s+/).filter(Boolean), have = " " + v + " ", hit = 0;
        for (var t = 0; t < mine.length; t++) if (have.indexOf(" " + mine[t] + " ") >= 0) hit++;
        n += mine.length ? hit / mine.length : 0;
      } else if (v === want[a]) n += weight(a);
    }
    return n;
  };
  var targetScore = -1;
  var st = document.createElement("style");
  // everything but the scene and the boxes around it is hidden; those boxes keep no paint of their own; the
  // scene itself shows exactly when the site shows it (a site hiding its canvas while it's out of play — a
  // visibility: hidden — leaves the page under it showing, not a black frame)
  st.textContent = "html,body{background:transparent!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}" +
    "body *:not([data-sl-island-path]):not([data-sl-island-on]){visibility:hidden!important}body *{pointer-events:none!important}[data-sl-island-on]{pointer-events:auto!important}" +
    "[data-sl-island-path]{background:transparent!important;box-shadow:none!important;border-color:transparent!important;outline-color:transparent!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;backdrop-filter:none!important}" +
    "[data-sl-island-path]::before,[data-sl-island-path]::after{visibility:hidden!important}" +
    "html.lenis-stopped,html.lenis-stopped body{overflow:auto!important}";
  document.documentElement.appendChild(st);
  var target = null, foundAt = 0;
  // the boxes the scene sits in (re-marked whenever the page moves things)
  var path = function () {
    if (!target) return;
    for (var a = target.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (!a.hasAttribute("data-sl-island-path")) a.setAttribute("data-sl-island-path", "");
  };
  var find = function () {
    // found, and as good a match as can be (or nothing to match by): kept
    if (target && target.isConnected && (!full || targetScore >= full)) { path(); return; }
    var c = null, best = -1;
    var all = document.getElementsByTagName("canvas");
    // the canvas whose own attributes match best — one distinctive attribute (its file, id, a data-…) at least
    if (full) for (var i = 0; i < all.length; i++) { var sc = score(all[i]); if (sc > best) { best = sc; c = all[i]; } }
    if (best < Math.min(3, full)) {
      c = null;
      try { c = sel ? document.querySelector(sel) : null; } catch (e) { c = null; }
      if (!c || c.localName !== "canvas") c = all[idx] || null;
      best = c && full ? score(c) : 0;
    }
    if (!c || (target && target.isConnected && c === target)) { if (target) path(); return; }
    if (target && target.isConnected && best <= targetScore) { path(); return; }
    if (target) { target.removeAttribute("data-sl-island-on"); [].forEach.call(document.querySelectorAll("[data-sl-island-path]"), function (x) { x.removeAttribute("data-sl-island-path"); }); }
    target = c; targetScore = best; foundAt = Date.now(); c.setAttribute("data-sl-island-on", ""); path();
  };
  new MutationObserver(find).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", find);
  // workers must come from this address: one started from the site's full URL gets this copy's file
  var S = ${JSON.stringify(site)}, E = ${JSON.stringify(ext)};
  ["Worker", "SharedWorker"].forEach(function (n) {
    var W = window[n]; if (!W) return;
    var P = function (u, o) {
      try { var x = new URL(String(u), location.href);
        if (x.host !== location.host && /^https?:$/.test(x.protocol)) { var to = S.indexOf(x.host) >= 0 ? x.pathname + x.search : E.indexOf(x.host) >= 0 ? "/_ext/" + x.host + x.pathname + x.search : null; if (to) u = to; } } catch (e) {}
      return new W(u, o);
    };
    P.prototype = W.prototype;
    try { Object.defineProperty(window, n, { value: P, writable: true, configurable: true }); } catch (e) { window[n] = P; }
  });
  // nothing inside the scene navigates away; the wheel scrolls YOUR page (unless the scene used it, e.g. to zoom)
  addEventListener("click", function (e) { var a = e.target && e.target.closest && e.target.closest("a[href]"); if (a) e.preventDefault(); }, true);
  addEventListener("wheel", function (e) { if (e.defaultPrevented) return; e.preventDefault(); try { parent.scrollBy(e.deltaX, e.deltaY); } catch (x) {} }, { passive: false });
  // scrolled from inside (keys, focus): the page follows. Never when the page itself set the position (this page
  // may be shorter for a moment, while loading: answering that would pull the page back up)
  var synced = 0;
  addEventListener("scroll", function () { if (Date.now() - synced < 250) return; try { if (Math.abs(parent.scrollY - scrollY) > 1 || Math.abs(parent.scrollX - scrollX) > 1) parent.scrollTo(scrollX, scrollY); } catch (x) {} }, { passive: true });
  // the pointer used on the scene itself also moves through YOUR page (its own effects: a cursor follower…)
  ["pointermove", "pointerdown", "pointerup", "mousemove", "mousedown", "mouseup", "click"].forEach(function (t) {
    addEventListener(t, function (e) { if (e.__slFwd) return; try { parent.__slIslandBack && parent.__slIslandBack(window, t, e.clientX, e.clientY, e.buttons, e.button); } catch (x) {} }, { passive: true, capture: true });
  });
  // the page passes its pointer on (where something of its own covers the scene)
  window.__slIsland = {
    sync: function (x, y) { synced = Date.now(); scrollTo(x, y); },
    // running: its canvas is there and has had a moment to draw (or the whole page has loaded) — a site
    // whose page never finishes loading (a stream, a long poll) still counts
    ready: function () { find(); return !!target && (document.readyState === "complete" || Date.now() - foundAt > 3000); },
    // from the page: where something of the page covers the scene (or outside it) — on the site that pointer
    // would have been over other content: the page's listeners (window, document) feel it, the canvas doesn't
    pointer: function (type, x, y, buttons, button) {
      var t = document.documentElement;
      var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, buttons: buttons, button: button, view: window };
      try {
        var ev = type.indexOf("pointer") === 0 ? new PointerEvent(type, Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true })) : new MouseEvent(type, init);
        ev.__slFwd = true;
        t.dispatchEvent(ev);
      } catch (e) {}
    }
  };
  // From StyleLift Studio's canvas ("Play live"), where this frame is on another origin: asked by its parent to
  // be at a scroll position, it answers where its scene is drawn and whether it runs (only its parent is heard).
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || e.source !== parent || parent === window || d.type !== "sl-island-ask") return;
    if (typeof d.y === "number" && Math.abs(scrollY - d.y) > 0.5) window.__slIsland.sync(d.x || 0, d.y);
    find();
    var r = target ? target.getBoundingClientRect() : null;
    parent.postMessage({ type: "sl-island-state", key: d.key, ready: window.__slIsland.ready(), rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null }, "*");
  });
})();
`;
}

// ── the service worker: the site's files, for the scene frames only ────────────────────────────────────
function islandWorker(origin: string, site: string[], ext: string[]): string {
  return `// StyleLift live 3D: serves the site's own stored files to the 3D scene frames (and the workers they start),
// under their original URLs. Every other request — your own pages and files — goes to the network as usual.
const P = "/_3d/";
const ORIGIN = ${JSON.stringify(origin)};
const SITE = ${JSON.stringify(site)};
const EXT = new Set(${JSON.stringify(ext)});
const MEDIA = /^(image|video|audio|font|track)$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
let MP = null;
const manifest = () => MP || (MP = fetch(P + "mirror-manifest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
  if (!m) return null;
  m.byPath = {};
  for (const [k, f] of Object.entries(m.paths)) { const x = /^\\/_ext\\/[^/]+(\\/.*)$/.exec(k); if (x && !(x[1] in m.byPath)) m.byPath[x[1]] = f; }
  return m;
}).catch(() => (MP = null)));
async function stored(m, file, headers) {
  const r = await fetch(P + encodeURI(file), { credentials: "same-origin", headers });
  if (!r.ok) return null;
  if (r.status === 206) return r;
  const h = new Headers(r.headers);
  const t = m.types && m.types[file];
  if (t) h.set("content-type", t);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
function variantOf(m, key) { const pre = key.split("?")[0]; const k = Object.keys(m.paths).find((p) => p === pre || p.startsWith(pre + "?")); return k ? m.paths[k] : null; }
// which requests are a scene's: from a scene frame, or a worker it started (its script is one of the site's files)
const scenes = new Set(), plain = new Set();
async function isScene(id) {
  if (!id || plain.has(id)) return false;
  if (scenes.has(id)) return true;
  const c = await self.clients.get(id);
  if (!c) return false;
  let u; try { u = new URL(c.url); } catch { return false; }
  if (u.searchParams.has("sl-island")) { scenes.add(id); return true; }
  if (c.type !== "window") { const m = await manifest(); if (m && (m.paths[u.pathname + u.search] || m.paths[u.pathname])) { scenes.add(id); return true; } }
  plain.add(id);
  return false;
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let u; try { u = new URL(req.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  const same = u.origin === self.location.origin;
  if (req.mode === "navigate") {
    if (!same || !u.searchParams.has("sl-island")) return; // your own pages
    if (e.resultingClientId) scenes.add(e.resultingClientId);
    e.respondWith(fetch(P + "island.html", { cache: "no-cache" }).then((r) => new Response(r.body, { status: r.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })));
    return;
  }
  if (same && (u.pathname === "/sl-island-sw.js" || u.pathname === "/sl-islands.js" || u.pathname.startsWith(P))) return;
  if (!e.clientId || plain.has(e.clientId)) return;
  const range = req.headers.get("range");
  const headers = range ? { range } : {};
  e.respondWith((async () => {
    if (!(await isScene(e.clientId))) return fetch(req);
    const key = same ? u.pathname + u.search : SITE.includes(u.host) ? u.pathname + u.search : EXT.has(u.host) ? "/_ext/" + u.host + u.pathname + u.search : null;
    if (!key) return fetch(req);
    const m = await manifest();
    if (m) {
      const file = m.paths[key] || (same || SITE.includes(u.host) ? m.paths[u.pathname] || m.byPath[key] || m.byPath[u.pathname] : null);
      if (file) { const r = await stored(m, file, headers); if (r) return r; }
    }
    try {
      const r = await fetch(same ? req : req.clone());
      if (r.ok || r.status === 206 || r.type === "opaque" || !same) return r;
    } catch {}
    try { if (same && ORIGIN) return await fetch(ORIGIN + u.pathname + u.search, { mode: "cors", credentials: "omit", headers }); } catch {}
    if (m && MEDIA.test(req.destination)) { const v = variantOf(m, key); if (v) { const r = await stored(m, v, headers); if (r) return r; } }
    return new Response("", { status: 404, statusText: "Not in the copy" });
  })());
});
`;
}

// ── in your page ───────────────────────────────────────────────────────────────────────────────────────
/** The scene canvas's own attributes, kept on its stand-in (the capture copies them over): what the scene frame
 *  finds it by — its file, id, data-…, classes (not the picture's own: src, size, StyleLift's marks, Vue's hashes). */
export function islandAttrs(ph: Element): string {
  const out: Record<string, string> = {};
  for (const a of Array.from(ph.attributes)) {
    if (/^(src|srcset|sizes|alt|style|width|height|loading|decoding|fetchpriority|crossorigin|data-sl-.*|data-v-[0-9a-f]+)$/i.test(a.name)) continue;
    if (a.value.length > 400) continue;
    out[a.name] = a.value;
  }
  return JSON.stringify(out);
}
function loaderScript(path: string): string {
  return `// StyleLift live 3D: each [data-sl-island] picture stands in for one of the site's 3D scenes; this puts the
// real scene (the site's own code, served by /sl-island-sw.js) over it, aligned, scrolled with the page and
// fed its pointer. Without a service worker (a page opened from disk) the pictures stay.
(function () {
  var PATH = ${JSON.stringify(path)};
  // the scene canvas's own attributes, kept on its stand-in: what its frame finds it by (see islandAttrs)
  var islandAttrs = function (ph) {
    var out = {};
    for (var i = 0; i < ph.attributes.length; i++) {
      var a = ph.attributes[i];
      if (/^(src|srcset|sizes|alt|style|width|height|loading|decoding|fetchpriority|crossorigin|data-sl-.*|data-v-[0-9a-f]+)$/i.test(a.name) || a.value.length > 400) continue;
      out[a.name] = a.value;
    }
    return JSON.stringify(out);
  };
  var phs = [].slice.call(document.querySelectorAll("[data-sl-island]"));
  if (!phs.length || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  var list = [];
  // the section a scene plays over: its nearest container taller than the screen (how far up, for the same
  // container in the site's page)
  var section = function (el, doc, vh) {
    for (var a = el.parentElement, d = 1; a && a !== doc.body && a !== doc.documentElement && d < 14; a = a.parentElement, d++) if (a.offsetHeight > vh * 1.2) return { el: a, depth: d };
    return null;
  };
  var islandSection = function (it, depth) {
    try {
      var c = it.w.document.querySelector("[data-sl-island-on]");
      for (var a = c, d = 0; a && d < depth; d++) a = a.parentElement;
      return a && a !== it.w.document.body && a !== it.w.document.documentElement ? a : null;
    } catch (e) { return null; }
  };
  var fine = !!window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches;
  var place = function () {
    for (var i = 0; i < list.length; i++) {
      var it = list[i], ph = it.ph, b = it.box.style, r;
      var fx = ph.getAttribute("data-sl-island-fixed");
      if (fx && it.live) {
        var n = fx.split(",").map(Number);
        b.position = "fixed"; b.left = n[0] + "px"; b.top = n[1] + "px"; b.width = n[2] + "px"; b.height = n[3] + "px";
        r = { left: n[0], top: n[1] };
      } else if (getComputedStyle(ph).position === "fixed") {
        // fixed to the screen (a full-screen scene behind the content): so is its frame
        r = ph.getBoundingClientRect();
        b.position = "fixed"; b.left = r.left + "px"; b.top = r.top + "px"; b.width = r.width + "px"; b.height = r.height + "px";
      } else {
        r = ph.getBoundingClientRect();
        b.position = "absolute"; b.left = ph.offsetLeft + "px"; b.top = ph.offsetTop + "px"; b.width = r.width + "px"; b.height = r.height + "px";
      }
      try {
        var w = it.f.contentWindow, ty = scrollY;
        if (w) {
          // the same progress through the stretch the scene plays over (its section: a pinned story, a tall
          // block) — not the same pixel: your page and the site's may differ a little in height above it
          var ps = it.live ? section(ph, document, innerHeight) : null;
          var is = ps && it.w ? islandSection(it, ps.depth) : null;
          if (ps && is) {
            var pt = ps.el.getBoundingClientRect().top + scrollY, pspan = Math.max(1, ps.el.offsetHeight - innerHeight);
            var it0 = is.getBoundingClientRect().top + w.scrollY, ispan = Math.max(1, is.offsetHeight - w.innerHeight);
            var d0 = scrollY - pt;
            ty = d0 <= 0 ? it0 + d0 : d0 >= pspan ? it0 + ispan + (d0 - pspan) : it0 + (d0 / pspan) * ispan;
          }
          ty = Math.max(0, Math.round(ty));
          if (w.scrollX !== scrollX || Math.abs(w.scrollY - ty) > 0.5) { if (w.__slIsland && w.__slIsland.sync) w.__slIsland.sync(scrollX, ty); else w.scrollTo(scrollX, ty); }
        }
      } catch (e) {}
      // where the scene's canvas sits in its frame → shown exactly over the stand-in (moved or resized in
      // Studio, or a page laid out a little differently): the frame is shifted / scaled to match
      var c = null;
      try { var on = it.live && it.w ? it.w.document.querySelector("[data-sl-island-on]") : null; c = on ? on.getBoundingClientRect() : null; } catch (e) { c = null; }
      var bw = parseFloat(b.width) || 0, bh = parseFloat(b.height) || 0;
      if (c && c.width > 0 && c.height > 0 && bw > 0 && bh > 0) {
        var sx = Math.abs(bw / c.width - 1) < 0.02 ? 1 : bw / c.width, sy = Math.abs(bh / c.height - 1) < 0.02 ? 1 : bh / c.height;
        it.map = { cx: c.left, cy: c.top, sx: sx, sy: sy, bx: r.left, by: r.top };
        it.f.style.transformOrigin = "0 0";
        it.f.style.transform = "translate(" + (-c.left * sx) + "px," + (-c.top * sy) + "px) scale(" + sx + "," + sy + ")";
      } else {
        it.map = null;
        it.f.style.transform = "translate(" + (-r.left) + "px," + (-r.top) + "px)";
      }
    }
  };
  var start = function () {
    phs.forEach(function (ph) {
      var box = document.createElement("div");
      box.setAttribute("data-sl-island-box", "");
      box.setAttribute("aria-hidden", "true");
      var cs = getComputedStyle(ph);
      box.style.cssText = "position:absolute;overflow:hidden;pointer-events:none;margin:0;padding:0;border:0;z-index:" + (cs.zIndex === "auto" ? "auto" : cs.zIndex) + ";border-radius:" + cs.borderRadius;
      var f = document.createElement("iframe");
      f.title = "3D scene";
      f.tabIndex = -1;
      f.setAttribute("allow", "fullscreen; xr-spatial-tracking; accelerometer; gyroscope");
      // a real pointer goes straight into the scene where nothing of the page covers it — as on the site (drag to
      // rotate, click an object, pinch to zoom); on a touch screen the page keeps its scrolling (taps passed on)
      // (it takes the pointer only once its scene runs: an invisible frame still loading must not catch clicks
      // or the wheel meant for the page)
      f.style.cssText = "position:absolute;left:0;top:0;width:100vw;height:100vh;border:0;background:transparent;color-scheme:normal;opacity:0;transition:opacity .4s;pointer-events:none";
      f.src = location.origin + PATH + (PATH.indexOf("?") >= 0 ? "&" : "?") + "sl-island=" + encodeURIComponent(ph.getAttribute("data-sl-island") || "0") + "&sl-sel=" + encodeURIComponent(ph.getAttribute("data-sl-island-sel") || "") + "&sl-attrs=" + encodeURIComponent(islandAttrs(ph));
      box.appendChild(f);
      ph.parentNode.insertBefore(box, ph.nextSibling);
      var it = { ph: ph, box: box, f: f, live: false, w: null, map: null };
      list.push(it);
      // the scene is up: show it, hide the picture (kept for 25 s if it never comes)
      var t0 = Date.now();
      var wait = function () {
        var w = null;
        try { w = f.contentWindow && f.contentWindow.__slIsland ? f.contentWindow : null; } catch (e) { w = null; }
        if (w && w.__slIsland.ready()) {
          setTimeout(function () { it.live = true; it.w = w; f.style.opacity = "1"; f.style.pointerEvents = fine ? "auto" : "none"; ph.style.visibility = "hidden"; place(); }, 900);
          return;
        }
        if (Date.now() - t0 < 25000) setTimeout(wait, 250); else box.remove();
      };
      wait();
    });
    place();
    addEventListener("scroll", place, { passive: true });
    addEventListener("resize", place);
    addEventListener("load", place);
    // the pointer over the page (its content over a scene, or elsewhere) is passed to every scene, as the site's
    // window would have felt it; the pointer on a scene comes back to the page (and to the other scenes)
    var pass = function (e, from) {
      if (e.__slFwd) return;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it.live || it.w === from) continue;
        // into the scene's own coordinates (it may sit elsewhere in its frame, or be scaled)
        var m = it.map, x = e.clientX, y = e.clientY;
        if (m) { x = m.cx + (e.clientX - m.bx) / m.sx; y = m.cy + (e.clientY - m.by) / m.sy; }
        try { it.w.__slIsland.pointer(e.type, x, y, e.buttons, e.button); } catch (x2) {}
      }
    };
    ["pointermove", "pointerdown", "pointerup", "mousemove", "mousedown", "mouseup", "click"].forEach(function (t) { addEventListener(t, function (e) { pass(e, null); }, { passive: true }); });
    window.__slIslandBack = function (w, type, x, y, buttons, button) {
      var it = null;
      for (var i = 0; i < list.length; i++) if (list[i].w === w) it = list[i];
      if (!it) return;
      // from the scene's coordinates to the page's
      var m = it.map, px = x, py = y;
      if (m) { px = m.bx + (x - m.cx) * m.sx; py = m.by + (y - m.cy) * m.sy; }
      var init = { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, screenX: px, screenY: py, buttons: buttons, button: button, view: window };
      try {
        var ev = type.indexOf("pointer") === 0 ? new PointerEvent(type, Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true })) : new MouseEvent(type, init);
        ev.__slFwd = true;
        document.documentElement.dispatchEvent(ev);
        pass({ type: type, clientX: px, clientY: py, buttons: buttons, button: button }, w); // the other scenes
      } catch (x2) {}
    };
  };
  // (from this page's own address: a <base> pointing at the original site must not redirect these)
  navigator.serviceWorker.register(location.origin + "/sl-island-sw.js", { scope: location.origin + "/" }).then(function () { return navigator.serviceWorker.ready; }).then(start).catch(function (e) {
    // StyleLift's preview answers the scenes' requests itself (service workers are off there)
    if (e && /StyleLift preview/.test(String(e.message || e))) start();
  });
})();
`;
}
