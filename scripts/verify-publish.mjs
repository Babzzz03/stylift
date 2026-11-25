// Publishing (Netlify, Vercel, GitHub) against a local mock of each provider's REST API: the shipped
// client code (src/shared/publish.ts) runs unchanged with real HTTP. The mocks check what a real API
// checks (digests match the bytes, every file a deploy lists was uploaded, git ids match the content)
// and misbehave on purpose once each: a rate limit, a lost upload, a branch that isn't ready yet.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const od = mkdtempSync(join(tmpdir(), "sl-publish-"));
await build({ entryPoints: { p: "src/shared/publish.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const { publishNetlify, publishVercel, pushGitHub, gitBlobSha, slugName } = await import(pathToFileURL(join(od, "p.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const gitSha = (b) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));
const TOKEN = "good-token";

// ── the mock APIs ──
const st = {
  netlify: { sites: new Map(), deploys: new Map(), stored: new Set(), puts: 0, limitedOnce: false },
  vercel: { stored: new Set(), uploads: 0, deployments: new Map(), loseOnce: true, creates: 0 },
  github: { repos: new Map(), blobs: new Map(), blobPosts: 0, limitedOnce: false, refMissOnce: true },
};
let n = 0;
const id = (p) => `${p}${++n}`;
const srv = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = () => JSON.parse(raw.toString() || "{}");
  const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });

  // Netlify
  if (p.startsWith("/netlify/")) {
    const N = st.netlify, q = p.slice("/netlify".length);
    let m;
    if (req.method === "POST" && q === "/sites") {
      const b = json();
      if (b.name === "taken-name") return send(422, { errors: { subdomain: ["must be unique"] } });
      const s = { id: id("site"), name: b.name || id("random-"), files: {} };
      s.ssl_url = `https://${s.name}.netlify.app`; s.admin_url = `https://app.netlify.com/sites/${s.name}`;
      N.sites.set(s.id, s);
      return send(201, s);
    }
    if (req.method === "GET" && (m = /^\/sites\/([^/]+)$/.exec(q))) return N.sites.has(m[1]) ? send(200, N.sites.get(m[1])) : send(404, { message: "Not Found" });
    if (req.method === "POST" && (m = /^\/sites\/([^/]+)\/deploys$/.exec(q))) {
      const b = json();
      const d = { id: id("dep"), site: m[1], files: b.files, state: "preparing", polls: 0 };
      N.deploys.set(d.id, d);
      return send(200, { id: d.id, state: d.state });
    }
    if (req.method === "GET" && (m = /^\/deploys\/([^/]+)$/.exec(q))) {
      const d = N.deploys.get(m[1]);
      const required = [...new Set(Object.values(d.files))].filter((h) => !N.stored.has(h));
      if (d.state === "preparing") d.state = "prepared";
      else if (!required.length) { d.state = "ready"; N.sites.get(d.site).files = d.files; }
      return send(200, { id: d.id, state: d.state, required, ssl_url: N.sites.get(d.site).ssl_url, error_message: null });
    }
    if (req.method === "PUT" && (m = /^\/deploys\/([^/]+)\/files\/(.+)$/.exec(q))) {
      if (!N.limitedOnce) { N.limitedOnce = true; return send(429, { message: "Rate limited" }, { "retry-after": "1" }); }
      const d = N.deploys.get(m[1]);
      const path = "/" + m[2].split("/").map(decodeURIComponent).join("/");
      if (d.files[path] !== sha1(raw)) return send(422, { message: `digest mismatch for ${path}` });
      N.stored.add(sha1(raw));
      N.puts++;
      return send(200, { id: path });
    }
  }

  // Vercel
  if (p.startsWith("/vercel/")) {
    const V = st.vercel, q = p.slice("/vercel".length);
    let m;
    if (req.method === "POST" && q === "/v2/files") {
      if (req.headers["x-vercel-digest"] !== sha1(raw)) return send(400, { error: { code: "invalid_digest", message: "digest mismatch" } });
      V.stored.add(sha1(raw)); V.uploads++;
      return send(200, {});
    }
    if (req.method === "POST" && q === "/v13/deployments") {
      const b = json();
      V.creates++;
      if (V.loseOnce) { V.loseOnce = false; V.stored.clear(); }
      const missing = b.files.filter((f) => !V.stored.has(f.sha)).map((f) => f.sha);
      if (missing.length) return send(400, { error: { code: "missing_files", message: "Missing files", missing } });
      const d = { id: id("dpl_"), name: b.name, files: b.files, target: b.target, settings: b.projectSettings, team: u.searchParams.get("teamId"), polls: 0 };
      V.deployments.set(d.id, d);
      return send(200, { id: d.id, url: `${b.name}-x7y8.vercel.app`, readyState: "QUEUED" });
    }
    if (req.method === "GET" && (m = /^\/v13\/deployments\/([^/]+)$/.exec(q))) {
      const d = V.deployments.get(m[1]);
      d.polls++;
      return send(200, d.polls < 2 ? { id: d.id, readyState: "BUILDING" } : { id: d.id, readyState: "READY", url: `${d.name}-x7y8.vercel.app`, alias: [`${d.name}-git-main-me.vercel.app`, `${d.name}.vercel.app`] });
    }
  }

  // GitHub
  if (p.startsWith("/github/")) {
    const G = st.github, q = p.slice("/github".length);
    let m;
    if (q === "/user") return send(200, { login: "octo" });
    if (req.method === "GET" && (m = /^\/repos\/octo\/([^/]+)$/.exec(q))) return G.repos.has(m[1]) ? send(200, G.repos.get(m[1]).info) : send(404, { message: "Not Found" });
    if (req.method === "POST" && q === "/user/repos") {
      const b = json();
      const readme = Buffer.from("# new\n");
      G.blobs.set(gitSha(readme), readme);
      const tree = id("tree"), commit = id("commit");
      const r = { info: { full_name: `octo/${b.name}`, html_url: `https://github.com/octo/${b.name}`, default_branch: "main", private: b.private }, trees: new Map([[tree, { "README.md": gitSha(readme) }]]), commits: new Map([[commit, { tree, parents: [] }]]), ref: commit };
      G.repos.set(b.name, r);
      return send(201, r.info);
    }
    const rm = /^\/repos\/octo\/([^/]+)\/git\/(.+)$/.exec(q);
    if (rm) {
      const r = G.repos.get(rm[1]), rest = rm[2];
      if (req.method === "GET" && rest === "ref/heads/main") {
        if (G.refMissOnce) { G.refMissOnce = false; return send(409, { message: "Git Repository is empty." }); }
        return send(200, { object: { sha: r.ref } });
      }
      if (req.method === "GET" && (m = /^commits\/(.+)$/.exec(rest))) return send(200, { sha: m[1], tree: { sha: r.commits.get(m[1]).tree } });
      if (req.method === "GET" && (m = /^trees\/(.+)$/.exec(rest))) return send(200, { truncated: false, tree: Object.entries(r.trees.get(m[1])).map(([path, sha]) => ({ path, type: "blob", sha })) });
      if (req.method === "POST" && rest === "blobs") {
        if (!G.limitedOnce) { G.limitedOnce = true; return send(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "1" }); }
        const b = json();
        const bytes = Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8");
        G.blobs.set(gitSha(bytes), bytes); G.blobPosts++;
        return send(201, { sha: gitSha(bytes) });
      }
      if (req.method === "POST" && rest === "trees") {
        const b = json();
        const t = b.base_tree ? { ...r.trees.get(b.base_tree) } : {};
        for (const e of b.tree) {
          if (e.content !== undefined) { const bytes = Buffer.from(e.content, "utf8"); G.blobs.set(gitSha(bytes), bytes); t[e.path] = gitSha(bytes); }
          else { if (!G.blobs.has(e.sha)) return send(422, { message: `unknown blob ${e.sha}` }); t[e.path] = e.sha; }
        }
        const tid = id("tree"); r.trees.set(tid, t);
        return send(201, { sha: tid });
      }
      if (req.method === "POST" && rest === "commits") { const b = json(); const c = id("commit"); r.commits.set(c, { tree: b.tree, parents: b.parents, message: b.message }); return send(201, { sha: c }); }
      if (req.method === "PATCH" && rest === "refs/heads/main") { const b = json(); if (!r.commits.get(b.sha).parents.includes(r.ref)) return send(422, { message: "not a fast forward" }); r.ref = b.sha; return send(200, { object: { sha: b.sha } }); }
    }
  }
  send(404, { message: `mock: no route ${req.method} ${p}` });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

// ── an export: text, a binary, a nested path with a space, and an identical copy ──
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const files = {
  "index.html": "<!doctype html><title>Home</title>",
  "site/about/index.html": "<!doctype html><title>About — ünïcode</title>",
  "_ext/cdn.x.com/fonts/my font.woff2": new Uint8Array([0, 1, 2, 3, 0, 255]),
  "site/img/a.png": new Uint8Array(png),
  "site/img/a-copy.png": new Uint8Array(png),
  "site/app.js": new TextEncoder().encode("console.log('hi')"),
};
const log = [];
const progress = (m) => log.push(m);

try {
  ok(slugName("www.Lusion.co-mirror") === "lusion-co-mirror" && !/---/.test(slugName("a---b")), "names become provider-safe slugs (lusion-co-mirror)");
  ok((await gitBlobSha(new TextEncoder().encode("hello\n"))) === "ce013625030ba8dba906f756967f9e9ca394464a", "git blob ids match git's own (hello → ce0136…)");

  // Netlify
  const n1 = await publishNetlify(files, { token: TOKEN, name: "ex-com-mirror", api: base + "/netlify" }, progress);
  const site = st.netlify.sites.get(n1.siteId);
  ok(n1.url === "https://ex-com-mirror.netlify.app", `Netlify: a new site, its https link returned (${n1.url})`);
  ok(Object.keys(site.files).length === 6 && site.files["/_ext/cdn.x.com/fonts/my font.woff2"] === sha1(Buffer.from(files["_ext/cdn.x.com/fonts/my font.woff2"])), "Netlify: every file listed with its SHA-1, paths with spaces included");
  ok(n1.uploaded === 5 && st.netlify.puts === 5, "Netlify: identical files are uploaded once (6 files, 5 uploads)");
  ok(log.some((l) => /slow down/.test(l)), "Netlify: a rate limit (429) is waited out, then the upload goes on");
  const puts = st.netlify.puts;
  const n2 = await publishNetlify({ ...files, "site/app.js": "console.log('changed')" }, { token: TOKEN, siteId: n1.siteId, api: base + "/netlify" }, progress);
  ok(n2.siteId === n1.siteId && st.netlify.puts - puts === 1, "Netlify: publishing again updates the same site and uploads only the changed file");
  const n3 = await publishNetlify(files, { token: TOKEN, siteId: "deleted-site", name: "taken-name", api: base + "/netlify" }, progress);
  ok(n3.siteId !== n1.siteId && /netlify\.app$/.test(n3.url), "Netlify: a site deleted since, and a name that's taken, still publish (new site, Netlify's name)");

  // Vercel
  const v1 = await publishVercel(files, { token: TOKEN, project: "ex-com-mirror", api: base + "/vercel" }, progress);
  const dep = [...st.vercel.deployments.values()].at(-1);
  ok(v1.url === "https://ex-com-mirror.vercel.app", `Vercel: the project's public production address is returned (${v1.url})`);
  ok(dep.target === "production" && dep.settings.framework === null && dep.files.length === 6, "Vercel: a production deploy of plain files (no build)");
  ok(st.vercel.creates === 2 && st.vercel.uploads === 10, "Vercel: files it lost track of are uploaded again and the deploy retried once");
  await publishVercel(files, { token: TOKEN, project: "ex-com-next", framework: "nextjs", teamId: "team_42", api: base + "/vercel" }, progress);
  const dep2 = [...st.vercel.deployments.values()].at(-1);
  ok(dep2.settings.framework === "nextjs" && dep2.team === "team_42", "Vercel: a Next.js export is built by Vercel (framework nextjs), into the chosen team");

  // GitHub
  const g1 = await pushGitHub(files, { token: TOKEN, repo: "ex-com-mirror", private: true, message: "Export", api: base + "/github" }, progress);
  const repo = st.github.repos.get("ex-com-mirror");
  const head = repo.commits.get(repo.ref);
  const tree = repo.trees.get(head.tree);
  ok(g1.url === "https://github.com/octo/ex-com-mirror" && repo.info.private === true, "GitHub: a new private repository in the token owner's account");
  ok(Object.keys(tree).length === 6 && !tree["README.md"], "GitHub: one commit holding exactly the export's files");
  ok(Object.entries(files).every(([k, v]) => tree[k] === gitSha(Buffer.from(typeof v === "string" ? Buffer.from(v) : v))), "GitHub: every file byte for byte (git ids match), text and binary");
  ok(st.github.blobPosts === 2, "GitHub: text goes inside the tree; only binary files are uploaded as blobs, identical ones once (2)");
  ok(log.some((l) => /GitHub asked StyleLift to slow down/.test(l)), "GitHub: a secondary rate limit is waited out");
  const posts = st.github.blobPosts;
  const ref1 = repo.ref;
  const g2 = await pushGitHub({ ...files, "site/img/new.png": new Uint8Array([9, 9, 0, 9]) }, { token: TOKEN, repo: "ex-com-mirror", private: true, api: base + "/github" }, progress);
  const head2 = repo.commits.get(repo.ref);
  ok(head2.parents[0] === ref1 && st.github.blobPosts - posts === 1 && g2.uploaded === 1, "GitHub: pushing again adds a commit on top, uploading only what changed");

  // a refused token
  let msg = "";
  try { await publishNetlify(files, { token: "wrong", api: base + "/netlify" }, progress); } catch (e) { msg = e.message; }
  ok(/Netlify refused the access token/.test(msg) && /Settings → Publishing/.test(msg), `a refused token says so in plain words (${msg.slice(0, 70)}…)`);
  let empty = "";
  try { await pushGitHub(files, { token: "", repo: "x", private: true, api: base + "/github" }); } catch (e) { empty = e.message; }
  ok(/Add a GitHub access token first/.test(empty), "no token: it says where to add one");
} catch (e) {
  failures.push("publish: " + e.message);
  console.log("  ✗ ERROR", e.stack);
}
srv.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Publishing verified ✓");
