// Export to Figma: the page's copy — the same files an HTML export writes, edits included — opened at the width the
// page was captured at with motion off (every reveal at its final look), measured as Figma layers by the walker
// (extractor/figma-snapshot.ts), and packed with its pictures and the StyleLift plugin for Figma into one .zip.
// In Figma the plugin builds the layers from it (figma-plugin/).
import { figmaSnapshot, type FNode, type FigmaSnapshot } from "../extractor/figma-snapshot";
import { makePreviewResolver, startPreview, typeOfPath, type PreviewFiles } from "./preview";
import { strToU8, type ZipEntry } from "./zip";

export interface FigmaBundle {
  entries: ZipEntry[];
  snap: FigmaSnapshot;
  pictures: number;
  picturesMissing: number;
}
type Say = (text: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Figma takes pictures up to 4096 px a side */
const FIGMA_MAX = 4096;

export async function buildFigmaBundle(
  files: PreviewFiles,
  sourceUrl: string,
  viewport: { width: number; height: number },
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
  say: Say,
): Promise<FigmaBundle> {
  say("Opening the copy to measure it for Figma (a tab opens for a moment — keep it in front)…");
  const session = await startPreview(files, sourceUrl, "index.html", () => {}, {
    media: [{ name: "prefers-reduced-motion", value: "reduce" }],
    viewport,
  });
  const target = { tabId: session.tabId };
  const evaluate = async <T>(expression: string, timeout = 60000): Promise<T> => {
    const r = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "the page's script failed");
    return r.result?.value as T;
  };
  let snap: FigmaSnapshot;
  try {
    // loaded, its fonts in, every picture asked for (lazy ones too: the page is walked top to bottom once)
    for (let i = 0; i < 100; i++) {
      const ready = await evaluate<boolean>("document.readyState === 'complete'").catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    await evaluate(`(async () => {
      document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = "eager"; });
      const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      for (let y = 0; y < H() && y < 60000; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); }
      scrollTo(0, 0);
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]);
      await Promise.race([Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 8000))]);
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`, 90000);
    say("Measuring every layer for Figma…");
    // (the walker is self-contained: its source runs in the page)
    snap = await evaluate<FigmaSnapshot>(`(${figmaSnapshot.toString()})()`, 120000);
    if (!snap?.root) throw new Error("The copy couldn't be measured.");
    snap.url = sourceUrl;
  } finally {
    await session.stop();
    await chrome.tabs.remove(session.tabId).catch(() => {});
  }

  // the pictures: from the export's own files (what the copy showed), the page's data: URLs, or the site
  const resolve = makePreviewResolver(files, session.origin);
  const tiles = new Set<string>();
  const walk = (n: FNode) => {
    for (const f of n.fills || []) if (f.k === "image" && f.fit === "tile") tiles.add(f.img);
    for (const k of n.kids || []) walk(k);
  };
  walk(snap.root);
  const entries: ZipEntry[] = [];
  let missing = 0, done = 0;
  for (const im of snap.images) {
    say(`Packing the pictures for Figma ${++done}/${snap.images.length}…`);
    let bytes: Uint8Array | null = null, type = "";
    try {
      if (im.url.startsWith("data:")) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(im.url);
        if (m) {
          type = m[1];
          bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : strToU8(decodeURIComponent(m[3]));
        }
      } else if (im.url.startsWith(session.origin)) {
        const a = resolve({ url: im.url, method: "GET", headers: {}, resourceType: "Image" });
        if (a.kind === "file" && a.status < 400) { bytes = a.body; type = a.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] || typeOfPath(im.url); }
      }
      if (!bytes && /^https?:/.test(im.url) && !im.url.startsWith(session.origin)) { bytes = await fetchBytes(im.url); type = typeOfPath(im.url); }
      const out = bytes ? await forFigma(bytes, type, im.w, im.h, tiles.has(im.id)) : null;
      if (out) entries.push({ name: `images/${im.id}.${out.ext}`, data: out.data });
      else missing++;
    } catch {
      missing++;
    }
  }
  entries.unshift({ name: "figma.json", data: strToU8(JSON.stringify(snap)) });
  entries.push(...(await pluginFiles()), { name: "README.txt", data: strToU8(readme(snap)) });
  return { entries, snap, pictures: snap.images.length - missing, picturesMissing: missing };
}

/** A picture as Figma takes it: PNG, JPEG or GIF, at most 4096 px a side — and no bigger than twice the size it's shown
 *  at (a tiled picture keeps its own size: Figma tiles at it). */
export async function forFigma(bytes: Uint8Array, type: string, w: number, h: number, tile: boolean): Promise<{ data: Uint8Array; ext: string } | null> {
  const kind = sniff(bytes) || (/svg/.test(type) ? "svg" : "");
  if (!kind) return null;
  let src: ImageBitmap | HTMLImageElement;
  let nw: number, nh: number;
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: kind === "svg" ? "image/svg+xml" : type || `image/${kind}` });
  if (kind === "svg") {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      src = img;
      // (a vector picture: drawn crisp at twice its shown size)
      const k = Math.min(2, FIGMA_MAX / Math.max(w || img.naturalWidth || 100, h || img.naturalHeight || 100));
      nw = Math.max(1, Math.round((w || img.naturalWidth || 100) * k));
      nh = Math.max(1, Math.round((h || img.naturalHeight || 100) * k));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } else {
    src = await createImageBitmap(blob);
    nw = src.width;
    nh = src.height;
  }
  const need = tile ? 1 : Math.max(w ? (2 * w) / nw : 1, h ? (2 * h) / nh : 1);
  const scale = Math.min(1, FIGMA_MAX / nw, FIGMA_MAX / nh, Math.max(need, 64 / Math.max(nw, nh)));
  if (kind !== "svg" && (kind === "png" || kind === "jpeg" || kind === "gif") && scale >= 1) return { data: bytes, ext: kind === "jpeg" ? "jpg" : kind };
  const cw = Math.max(1, Math.round(nw * (kind === "svg" ? 1 : scale))), chh = Math.max(1, Math.round(nh * (kind === "svg" ? 1 : scale)));
  const cv = new OffscreenCanvas(cw, chh);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, cw, chh);
  const asJpeg = kind === "jpeg";
  const out = await cv.convertToBlob(asJpeg ? { type: "image/jpeg", quality: 0.9 } : { type: "image/png" });
  return { data: new Uint8Array(await out.arrayBuffer()), ext: asJpeg ? "jpg" : "png" };
}

export function sniff(b: Uint8Array): "png" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "bmp" | "" {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "avif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return "";
}

/** the plugin itself, so the first import needs nothing else */
async function pluginFiles(): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const p of ["manifest.json", "dist/code.js", "dist/ui.html"]) {
    try {
      const r = await fetch(chrome.runtime.getURL(`figma-plugin/${p}`));
      if (r.ok) out.push({ name: `figma-plugin/${p}`, data: new Uint8Array(await r.arrayBuffer()) });
    } catch {
      /* a build without the plugin: the bundle still opens in an installed one */
    }
  }
  return out;
}

function readme(snap: FigmaSnapshot): string {
  const fonts = Array.from(new Set(snap.fonts.map((f) => f.family))).filter((f) => !/^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-.*)$/.test(f));
  return [
    `${snap.title || snap.url} — for Figma, exported by StyleLift`,
    "",
    "Open it in Figma:",
    "  1. The first time only: unzip this file, then in the Figma desktop app choose",
    "     Plugins → Development → Import plugin from manifest… and pick figma-plugin/manifest.json.",
    "  2. In any Figma design file: Plugins → Development → StyleLift, and choose this .zip.",
    "     The page is built as layers beside what's on the canvas already: frames, text you can edit,",
    "     pictures, vector icons, Auto Layout where the page's own layout gives it, the colours as",
    "     variables and the type as text styles.",
    "",
    `The page: ${snap.width} × ${snap.height} px, ${snap.stats.nodes} layers (${snap.stats.texts} texts, ${snap.stats.images} pictures, ${snap.stats.svgs} vectors, ${snap.stats.autoLayout} Auto Layout frames).`,
    fonts.length ? `Its fonts: ${fonts.join(", ")}. Install them on this computer before importing to see the page's own type — Figma shows Inter for any it doesn't have.` : "",
    "",
    "figma.json is what the plugin reads; images/ holds the pictures.",
    "",
  ].join("\n");
}
