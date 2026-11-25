// Downloads asset bytes for the exports. Successes are remembered (the same image is often referenced
// many times); failures are NOT — an image CDN that briefly refuses a burst ("too many requests") must
// get a real retry, not the remembered failure.
export function makeByteFetcher(
  limit = 25_000_000,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): (url: string) => Promise<Uint8Array | null> {
  const ok = new Map<string, Uint8Array>();
  const inflight = new Map<string, Promise<Uint8Array | null>>();
  return (url: string) => {
    const hit = ok.get(url);
    if (hit) return Promise.resolve(hit);
    const running = inflight.get(url);
    if (running) return running;
    const p = (async () => {
      try {
        const r = await fetchImpl(url);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        if (buf.byteLength > limit) return null;
        const bytes = new Uint8Array(buf);
        ok.set(url, bytes);
        return bytes;
      } catch {
        return null;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, p);
    return p;
  };
}
