// Network + download helpers shared by the side panel and the studio. Both are
// extension pages, so fetch() runs with the extension's host permissions and can
// read cross-origin assets the page itself could not.
import { zipSync, strToU8 } from "./zip";
import type { FileMap } from "./project";

export async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
export function makeByteFetcher(limit = 25_000_000) {
  const cache = new Map<string, Uint8Array | null>();
  return async (url: string): Promise<Uint8Array | null> => {
    if (cache.has(url)) return cache.get(url) ?? null;
    let out: Uint8Array | null = null;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength <= limit) out = new Uint8Array(buf);
      }
    } catch {
      /* unreachable */
    }
    cache.set(url, out);
    return out;
  };
}
export function makeDataFetcher(limit = 8_000_000) {
  const cache = new Map<string, string | null>();
  return async (url: string): Promise<string | null> => {
    if (cache.has(url)) return cache.get(url) ?? null;
    let out: string | null = null;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const b = await r.blob();
        if (b.size <= limit)
          out = await new Promise<string>((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.readAsDataURL(b);
          });
      }
    } catch {
      /* unreachable */
    }
    cache.set(url, out);
    return out;
  };
}
/** A name Chrome accepts for a saved file: no path separators, reserved characters or leading dots. */
export function safeFileName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^[.\s]+/, "").trim();
  return n || "stylelift-export";
}
/**
 * Save a file to the user's Downloads. Uses the extension downloads API, because Chrome blocks a
 * page's second automatic download once the click that started a long export has expired ("This
 * site is attempting to download multiple files"); the API is not subject to that. Falls back to a
 * link click where the API isn't available.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const filename = safeFileName(name);
  let revoked = false;
  const revoke = () => {
    if (!revoked) URL.revokeObjectURL(url);
    revoked = true;
  };
  const viaLink = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(revoke, 60_000);
  };
  const dl = (globalThis as { chrome?: typeof chrome }).chrome?.downloads;
  if (!dl?.download) return viaLink();
  try {
    dl.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (id) => {
      if (chrome.runtime.lastError || id === undefined) return viaLink();
      // keep the blob alive until Chrome has read it all
      const done = (d: chrome.downloads.DownloadDelta) => {
        if (d.id !== id || !d.state || d.state.current === "in_progress") return;
        dl.onChanged.removeListener(done);
        revoke();
      };
      dl.onChanged.addListener(done);
      setTimeout(() => {
        dl.onChanged.removeListener(done);
        revoke();
      }, 10 * 60_000);
    });
  } catch {
    viaLink();
  }
}
export function downloadBlob(data: BlobPart, name: string, mime: string): void {
  saveBlob(new Blob([data], { type: mime }), name);
}
export function downloadZip(files: FileMap, name: string): number {
  const entries = Object.entries(files).map(([n, data]) => ({ name: n, data: typeof data === "string" ? strToU8(data) : data }));
  downloadBlob(zipSync(entries) as BlobPart, name, "application/zip");
  return entries.length;
}
