// Minimal, dependency-free ZIP writer (STORE method — no compression). Enough to
// package an exported project (HTML/CSS/JSX + binary assets) into a .zip the user
// can unzip and open in VS Code.

export type ZipEntry = { name: string; data: Uint8Array };

export function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The zip as it is written, piece by piece: small headers and each file's own bytes, never copied together — a big
 *  export (100+ MB of models and pictures) held three times over in memory could take the browser down. Build a
 *  Blob from them (the browser may keep a large one on disk). */
export function zipParts(entries: ZipEntry[]): Uint8Array[] {
  return zipBuild(entries);
}

export function zipSync(entries: ZipEntry[]): Uint8Array {
  const parts = zipBuild(entries);
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function zipBuild(entries: ZipEntry[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const concat = (parts: Uint8Array[]) => {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  for (const entry of entries) {
    const name = strToU8(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method = store
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra length
      name,
    ]);
    chunks.push(local, data); // the file's own bytes, as they are (not copied into the header)
    central.push(
      concat([
        u32(0x02014b50), // central dir header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method
        u16(0), // mod time
        u16(0), // mod date
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        name,
      ]),
    );
    offset += local.length + data.length;
  }

  const cd = concat(central);
  const eocd = concat([
    u32(0x06054b50), // end of central dir signature
    u16(0), // disk number
    u16(0), // disk with cd
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset), // cd offset
    u16(0), // comment length
  ]);

  return [...chunks, cd, eocd];
}
