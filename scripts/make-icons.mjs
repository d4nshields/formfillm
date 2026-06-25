/*
 * Generates formfillm PNG icons with no external dependencies.
 * Draws a teal rounded square with two light "form field" bars and a
 * consent check mark. Run once: `node scripts/make-icons.mjs`.
 * The PNG bytes are committed under icons/ and copied into dist/ at build.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = resolve(root, "icons");
mkdirSync(iconsDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, draw) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const i = (y * size + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  // Add filter byte (0 = none) at the start of each scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, k) => {
      raw[y * (size * 4 + 1) + 1 + k] = v;
    });
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TEAL = [13, 110, 113];
const TEAL_DARK = [8, 76, 78];
const LIGHT = [224, 242, 241];
const CHECK = [125, 226, 209];

function draw(x, y, size) {
  const s = size;
  const r = Math.max(2, Math.round(s * 0.18)); // corner radius
  // Rounded-rect background mask.
  const inCorner = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 > r ** 2;
  let outside = false;
  if (x < r && y < r && inCorner(r, r)) outside = true;
  if (x >= s - r && y < r && inCorner(s - r - 1, r)) outside = true;
  if (x < r && y >= s - r && inCorner(r, s - r - 1)) outside = true;
  if (x >= s - r && y >= s - r && inCorner(s - r - 1, s - r - 1)) outside = true;
  if (outside) return [0, 0, 0, 0];

  const base = y < s / 2 ? TEAL : TEAL_DARK;

  // Two light "form field" bars in the upper area.
  const barH = Math.max(1, Math.round(s * 0.09));
  const bar1Y = Math.round(s * 0.26);
  const bar2Y = Math.round(s * 0.44);
  const barX0 = Math.round(s * 0.22);
  const barX1 = Math.round(s * 0.78);
  const onBar = (by) => y >= by && y < by + barH && x >= barX0 && x <= barX1;
  if (onBar(bar1Y) || onBar(bar2Y)) return [...LIGHT, 255];

  // Consent check mark in the lower area.
  const cx0 = s * 0.3;
  const cy0 = s * 0.72;
  const t = Math.max(1, Math.round(s * 0.07));
  // Short stroke down-right then long stroke up-right.
  const onStroke1 = Math.abs(y - x - (cy0 - cx0)) <= t && x >= cx0 - s * 0.04 && x <= cx0 + s * 0.12;
  const onStroke2 = Math.abs(y + x - (cy0 + s * 0.42)) <= t && x >= cx0 + s * 0.1 && x <= s * 0.74;
  if ((onStroke1 || onStroke2) && y > s * 0.55) return [...CHECK, 255];

  return [...base, 255];
}

for (const size of [16, 48, 128]) {
  const png = encodePng(size, draw);
  writeFileSync(resolve(iconsDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
