// Generates simple StyleLift icons (rounded square + diamond mark) as PNGs.
// No image libraries — raw RGBA encoded with zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, draw) {
  const px = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = a;
  };
  const raw = Buffer.alloc(size * size * 4, 0);
  draw(px, size);
  // add filter byte (0) at the start of each scanline
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// palette
const BG = [23, 26, 33]; // panel bg
const ACCENT = [110, 139, 255];

function draw(px, size) {
  const r = size * 0.22; // corner radius
  const cx = size / 2;
  const cy = size / 2;
  const diamondR = size * 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-rect mask
      const dx = Math.max(r - x, x - (size - 1 - r), 0);
      const dy = Math.max(r - y, y - (size - 1 - r), 0);
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) continue;
      // diamond mark
      const man = Math.abs(x - cx) + Math.abs(y - cy);
      if (man <= diamondR) px(x, y, ACCENT[0], ACCENT[1], ACCENT[2], 255);
      else px(x, y, BG[0], BG[1], BG[2], 255);
    }
  }
}

for (const size of [16, 48, 128]) {
  const out = `public/icons/icon-${size}.png`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png(size, draw));
  console.log("wrote", out);
}
