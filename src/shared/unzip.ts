// Reads a .zip in the plugin's window: StyleLift writes its bundles uncompressed (STORE); a bundle someone re-zipped
// (Finder, Windows) is deflated — the browser's own DecompressionStream inflates it.
export type Unzipped = Map<string, Uint8Array>;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export async function unzip(buf: Uint8Array): Promise<Unzipped> {
  // the end of the central directory: the last signature within the final 64 KB (a comment may follow it)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This isn't a .zip file.");
  const count = u16(buf, eocd + 10);
  let at = u32(buf, eocd + 16);
  const out: Unzipped = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(buf, at) !== 0x02014b50) throw new Error("The .zip is damaged (its file list doesn't read).");
    const method = u16(buf, at + 10);
    const size = u32(buf, at + 20);
    const nameLen = u16(buf, at + 28), extraLen = u16(buf, at + 30), commentLen = u16(buf, at + 32);
    const local = u32(buf, at + 42);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflate(raw));
    else throw new Error(`“${name}” is packed in a way this plugin can't read (method ${method}).`);
  }
  return out;
}
