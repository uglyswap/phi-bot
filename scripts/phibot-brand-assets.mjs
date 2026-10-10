#!/usr/bin/env node
// Generates the Phi Bot brand files (logo, favicons, app icons) from a single
// geometry: an elliptical ring crossed by a vertical stem, the letter phi.
// Pure Node.js (node:zlib for PNG, raw 32-bit bitmaps for ICO): no image
// library and no system tool, so the output is identical on every machine.
//
// Usage: node scripts/phibot-brand-assets.mjs [--out <dir>]
// Default output directory: phibot/branding (relative to the repository root).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";

// Design grid: 32 x 32 units, the glyph is centered on (16, 16).
export const GRID = 32;
export const RING = { cx: 16, cy: 16, rx: 12, ry: 10, hole: 6 };
export const STEM = { x: 14, y: 2, width: 4, height: 28, radius: 2 };
export const COLORS = {
  glyph: "#8b5cf6",
  glyphOnLight: "#6d28d9",
  glyphOnDark: "#c4b5fd",
  appGlyph: "#a78bfa",
  appBackground: "#18181b",
};
// App icons are opaque and keep the glyph inside the maskable safe zone.
export const APP_ICON_SCALE = 0.7;
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const ICO_SIZES = [16, 32, 48];

const RING_PATH =
  `M${RING.cx - RING.rx} ${RING.cy}a${RING.rx} ${RING.ry} 0 1 0 ${2 * RING.rx} 0` +
  `a${RING.rx} ${RING.ry} 0 1 0 ${-2 * RING.rx} 0Z` +
  `M${RING.cx - RING.hole} ${RING.cy}a${RING.hole} ${RING.hole} 0 1 0 ${2 * RING.hole} 0` +
  `a${RING.hole} ${RING.hole} 0 1 0 ${-2 * RING.hole} 0Z`;
const STEM_RECT =
  `x="${STEM.x}" y="${STEM.y}" width="${STEM.width}" height="${STEM.height}" rx="${STEM.radius}"`;

export function logoSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" role="img" aria-label="Phi Bot">`,
    "  <title>Phi Bot</title>",
    `  <path fill="${COLORS.glyph}" fill-rule="evenodd" d="${RING_PATH}"/>`,
    `  <rect fill="${COLORS.glyph}" ${STEM_RECT}/>`,
    "</svg>",
    "",
  ].join("\n");
}

export function faviconSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}">`,
    "  <style>",
    `    .phi { fill: ${COLORS.glyphOnLight}; }`,
    "    @media (prefers-color-scheme: dark) {",
    `      .phi { fill: ${COLORS.glyphOnDark}; }`,
    "    }",
    "  </style>",
    `  <path class="phi" fill-rule="evenodd" d="${RING_PATH}"/>`,
    `  <rect class="phi" ${STEM_RECT}/>`,
    "</svg>",
    "",
  ].join("\n");
}

// True when the design-grid point (x, y) is inside the glyph (ring or stem).
export function isInsideGlyph(x, y) {
  const dx = x - RING.cx;
  const dy = y - RING.cy;
  const inOuter = (dx * dx) / (RING.rx * RING.rx) + (dy * dy) / (RING.ry * RING.ry) <= 1;
  if (inOuter && dx * dx + dy * dy >= RING.hole * RING.hole) return true;
  if (x < STEM.x || x > STEM.x + STEM.width || y < STEM.y || y > STEM.y + STEM.height) return false;
  const top = STEM.y + STEM.radius;
  const bottom = STEM.y + STEM.height - STEM.radius;
  const nearestY = y < top ? top : y > bottom ? bottom : y;
  const sx = x - (STEM.x + STEM.width / 2);
  const sy = y - nearestY;
  return sx * sx + sy * sy <= STEM.radius * STEM.radius;
}

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Fraction of the pixel (px, py) covered by the glyph, by supersampling.
export function pixelCoverage(px, py, size, scale) {
  const samples = size <= 64 ? 16 : 8;
  const half = GRID / 2;
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const u = ((px + (j + 0.5) / samples) * GRID) / size;
      const v = ((py + (i + 0.5) / samples) * GRID) / size;
      if (isInsideGlyph(half + (u - half) / scale, half + (v - half) / scale)) inside += 1;
    }
  }
  return inside / (samples * samples);
}

// Renders the glyph: RGBA on a transparent background, or RGB on `background`.
export function renderGlyph(size, { color, background = null, scale = 1 }) {
  const channels = background ? 3 : 4;
  const pixels = Buffer.alloc(size * size * channels);
  const fg = hexToRgb(color);
  const bg = background ? hexToRgb(background) : null;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const coverage = pixelCoverage(px, py, size, scale);
      const offset = (py * size + px) * channels;
      if (bg) {
        for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(bg[c] * (1 - coverage) + fg[c] * coverage);
      } else if (coverage > 0) {
        pixels[offset] = fg[0];
        pixels[offset + 1] = fg[1];
        pixels[offset + 2] = fg[2];
        pixels[offset + 3] = Math.round(coverage * 255);
      }
    }
  }
  return { width: size, height: size, channels, pixels };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function encodePng({ width, height, channels, pixels }) {
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// One 32-bit BMP icon entry (BITMAPINFOHEADER, bottom-up BGRA, AND mask).
function encodeIcoBitmap({ width, height, pixels }) {
  const maskRow = Math.ceil(width / 32) * 4;
  const colorSize = width * height * 4;
  const entry = Buffer.alloc(40 + colorSize + maskRow * height);
  entry.writeUInt32LE(40, 0);
  entry.writeInt32LE(width, 4);
  entry.writeInt32LE(height * 2, 8);
  entry.writeUInt16LE(1, 12);
  entry.writeUInt16LE(32, 14);
  entry.writeUInt32LE(colorSize, 20);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = 40 + (row * width + x) * 4;
      entry[dst] = pixels[src + 2];
      entry[dst + 1] = pixels[src + 1];
      entry[dst + 2] = pixels[src];
      entry[dst + 3] = pixels[src + 3];
      if (pixels[src + 3] === 0) entry[40 + colorSize + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return entry;
}

export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = images.map(encodeIcoBitmap);
  let offset = header.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    header[at] = image.width;
    header[at + 1] = image.height;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(entries[index].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += entries[index].length;
  });
  return Buffer.concat([header, ...entries]);
}

function pixelDigest(image) {
  return createHash("sha256").update(image.pixels).digest("hex").slice(0, 16);
}

// Builds every brand file in memory: [{ name, data, summary }].
export function buildBrandAssets() {
  const favicon = (size) => renderGlyph(size, { color: COLORS.glyph });
  const appIcon = (size) =>
    renderGlyph(size, { color: COLORS.appGlyph, background: COLORS.appBackground, scale: APP_ICON_SCALE });
  const assets = [
    { name: "phibot-logo.svg", data: Buffer.from(logoSvg(), "utf8") },
    { name: "favicon.svg", data: Buffer.from(faviconSvg(), "utf8") },
  ].map((asset) => ({ ...asset, summary: `svg ${asset.data.length} bytes` }));
  const pngs = [
    ["favicon-16x16.png", favicon(16)],
    ["favicon-32x32.png", favicon(32)],
    ["apple-touch-icon.png", appIcon(180)],
    ["android-chrome-192x192.png", appIcon(192)],
    ["android-chrome-512x512.png", appIcon(512)],
  ];
  for (const [name, image] of pngs) {
    const kind = image.channels === 4 ? "rgba" : "rgb";
    assets.push({ name, data: encodePng(image), summary: `${image.width}x${image.height} ${kind} pixels:${pixelDigest(image)}` });
  }
  const ico = encodeIco(ICO_SIZES.map(favicon));
  assets.push({ name: "favicon.ico", data: ico, summary: `${ICO_SIZES.map((s) => `${s}x${s}`).join(",")} bmp ${ico.length} bytes` });
  return assets;
}

export function writeBrandAssets(outDir) {
  mkdirSync(outDir, { recursive: true });
  const assets = buildBrandAssets();
  for (const asset of assets) writeFileSync(join(outDir, asset.name), asset.data);
  return assets.map((asset) => `${asset.name} ${asset.summary}`);
}

function main(argv) {
  if (argv.length > 0 && (argv.length !== 2 || argv[0] !== "--out")) {
    console.error("usage: node scripts/phibot-brand-assets.mjs [--out <dir>]");
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = argv.length === 2 ? resolve(argv[1]) : join(repoRoot, "phibot", "branding");
  for (const line of writeBrandAssets(outDir)) console.log(line);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
