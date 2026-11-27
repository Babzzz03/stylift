// Figma → StyleLift: a design the StyleLift plugin for Figma saved (.stylelift.zip — design.json and its pictures)
// opened as a Studio project. Each frame is a page, drawn as the web page Figma's layers describe (the same renderer
// the Figma export is checked with): Auto Layout as flexbox, everything else where Figma placed it, text in its runs,
// pictures embedded, vectors inline. From Studio it exports like any capture: HTML, React, Next.js, Elementor.
import type { FigmaSnapshot } from "../extractor/figma-snapshot";
import { renderFigmaHtml } from "../shared/figma-render";
import { unzip } from "../shared/unzip";

export interface DesignPage {
  title: string;
  path: string; // the export's file for it: index.html, about/index.html …
  url: string;
  html: string;
}
export interface ImportedDesign {
  title: string;
  url: string;
  pages: DesignPage[];
  layers: number;
  pictures: number;
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

function dataUrl(bytes: Uint8Array, ext: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${MIME[ext] || "application/octet-stream"};base64,${btoa(bin)}`;
}

export async function importFigmaDesign(file: File): Promise<ImportedDesign> {
  const files = await unzip(new Uint8Array(await file.arrayBuffer()));
  const json = files.get("design.json");
  if (!json) {
    if (files.has("figma.json")) throw new Error("This is a page exported FOR Figma (open it with the StyleLift plugin in Figma). A design from Figma is saved by the plugin's “Figma → StyleLift” tab.");
    throw new Error("No design.json in this .zip — save it from Figma with the StyleLift plugin (Figma → StyleLift).");
  }
  const design = JSON.parse(new TextDecoder().decode(json)) as { v: number; kind: string; file: string; pages: FigmaSnapshot[] };
  if (design.kind !== "figma-design" || !Array.isArray(design.pages)) throw new Error("This .zip isn't a StyleLift design.");
  if (design.v !== 1) throw new Error("This design was saved by a newer StyleLift plugin: update StyleLift.");
  // the pictures, by id (images/<id>.<ext>)
  const pics = new Map<string, string>();
  for (const [name, bytes] of files) {
    const m = /^images\/([^/.]+)\.(\w+)$/.exec(name);
    if (m) pics.set(m[1], dataUrl(bytes, m[2].toLowerCase()));
  }
  const fileSlug = slug(design.file || "figma");
  const used = new Set<string>();
  // the first frame is the home page (index.html); the others each a folder of their own (about/index.html)
  const pages: DesignPage[] = design.pages.map((snap, i) => {
    let dir = i === 0 ? "" : slug(snap.title);
    while (dir && used.has(dir)) dir += "-2";
    used.add(dir);
    const html = renderFigmaHtml(snap, (id) => pics.get(id) || "", { page: true });
    return { title: snap.title || `Page ${i + 1}`, path: dir ? `${dir}/index.html` : "index.html", url: `figma://${fileSlug}/${dir ? dir + "/" : ""}`, html };
  });
  if (!pages.length) throw new Error("The design has no frames.");
  return {
    title: design.pages.length === 1 ? design.pages[0].title : design.file,
    url: pages[0].url,
    pages,
    layers: design.pages.reduce((n, p) => n + (p.stats?.nodes || 0), 0),
    pictures: pics.size,
  };
}
