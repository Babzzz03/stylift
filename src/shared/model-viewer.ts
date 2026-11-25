// Your own 3D model in place of a site's scene. Google's <model-viewer> (Apache-2.0 — loaded from a CDN at a pinned
// version, never bundled) shows a .glb / .gltf turnable with the pointer (optionally spinning on its own) in Preview
// and in every export; where scripts don't run (Studio's artboards) the poster inside it — the scene's captured
// picture — stands in. In a project the model is a real file (assets/models/…), not text inside the page.
export const MODEL_VIEWER_SRC = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js";
export const MODEL_VIEWER_TAG = `<script type="module" src="${MODEL_VIEWER_SRC}" data-sl-model-viewer=""></script>`;

/** A page has a model of the user's own in it. */
export const hasModels = (html: string) => /<model-viewer\b[^>]*data-sl-model=/.test(html);

/** The page with the viewer's script in its <head> (once). */
export function addModelViewerTag(html: string): string {
  if (!hasModels(html) || /data-sl-model-viewer/.test(html)) return html;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${MODEL_VIEWER_TAG}</head>`) : MODEL_VIEWER_TAG + html;
}

/** Models kept inside the page (data: addresses) written out as files: returns the page pointing at them and the
 *  files ({ "assets/models/name.glb": bytes }), under `prefix` (React / Next.js: public/, served from the root). */
export function extractModels(html: string, prefix = "", root = ""): { html: string; files: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const out = html.replace(/(<model-viewer\b[^>]*?\ssrc=")(data:model\/(gltf-binary|gltf\+json);base64,([A-Za-z0-9+/=]+))("[^>]*>)/g, (all, head: string, _d: string, kind: string, b64: string, tail: string) => {
    const nameAttr = (/data-sl-model="([^"]*)"/.exec(all) || [])[1] || "model";
    let base = nameAttr.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
    for (let k = 2; used.has(base); k++) base = `${base.replace(/-\d+$/, "")}-${k}`;
    used.add(base);
    const path = `assets/models/${base}.${kind === "gltf-binary" ? "glb" : "gltf"}`;
    const bin = atob(b64); // (browsers and Node 16+)
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    files[prefix + path] = bytes;
    return `${head}${root}${path}${tail}`;
  });
  return { html: out, files };
}
