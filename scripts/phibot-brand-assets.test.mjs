import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  COLORS,
  PNG_SIGNATURE,
  buildBrandAssets,
  encodeIco,
  encodePng,
  hexToRgb,
  isInsideGlyph,
  logoSvg,
  renderGlyph,
  writeBrandAssets,
} from "./phibot-brand-assets.mjs";

test("the glyph covers the ring and the stem but not the counters", () => {
  assert.equal(isInsideGlyph(16, 16), true);
  assert.equal(isInsideGlyph(6, 16), true);
  assert.equal(isInsideGlyph(16, 3), true);
  assert.equal(isInsideGlyph(12, 16), false);
  assert.equal(isInsideGlyph(20, 16), false);
  assert.equal(isInsideGlyph(1, 1), false);
  assert.equal(isInsideGlyph(16, 31), false);
});

test("favicons keep a transparent background", () => {
  const image = renderGlyph(16, { color: COLORS.glyph });
  assert.equal(image.channels, 4);
  assert.equal(image.pixels[3], 0);
  const stemCenter = (8 * 16 + 7) * 4;
  assert.deepEqual([...image.pixels.subarray(stemCenter, stemCenter + 4)], [...hexToRgb(COLORS.glyph), 255]);
});

test("app icons are opaque on the dark background", () => {
  const image = renderGlyph(180, { color: COLORS.appGlyph, background: COLORS.appBackground, scale: 0.7 });
  assert.equal(image.channels, 3);
  assert.deepEqual([...image.pixels.subarray(0, 3)], hexToRgb(COLORS.appBackground));
});

test("encodePng writes a valid PNG whose pixels decode back", () => {
  const image = renderGlyph(16, { color: COLORS.glyph });
  const png = encodePng(image);
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  assert.equal(png[25], 6);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("latin1"), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(raw.length, 16 * (16 * 4 + 1));
  assert.deepEqual(raw.subarray(1, 65), image.pixels.subarray(0, 64));
});

test("encodeIco writes 16, 32 and 48 pixel 32-bit bitmaps", () => {
  const ico = encodeIco([16, 32, 48].map((size) => renderGlyph(size, { color: COLORS.glyph })));
  assert.equal(ico.length, 15086);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
  const firstOffset = ico.readUInt32LE(18);
  assert.equal(firstOffset, 54);
  assert.equal(ico.readUInt32LE(firstOffset), 40);
  assert.equal(ico.readInt32LE(firstOffset + 8), 32);
  assert.equal(ico.readUInt16LE(firstOffset + 14), 32);
});

test("the generated brand files have stable sizes and pixels", () => {
  const summaries = buildBrandAssets().map((asset) => `${asset.name} ${asset.summary}`);
  assert.deepEqual(summaries, [
    "phibot-logo.svg svg 321 bytes",
    "favicon.svg svg 385 bytes",
    "favicon-16x16.png 16x16 rgba pixels:48af151fdde88ff7",
    "favicon-32x32.png 32x32 rgba pixels:24b122e022649d4f",
    "apple-touch-icon.png 180x180 rgb pixels:5d9596007ab53caa",
    "android-chrome-192x192.png 192x192 rgb pixels:b6ce87f521250f29",
    "android-chrome-512x512.png 512x512 rgb pixels:70cf958f754e44fd",
    "favicon.ico 16x16,32x32,48x48 bmp 15086 bytes",
  ]);
});

test("writeBrandAssets writes the eight files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phibot-brand-"));
  try {
    writeBrandAssets(dir);
    assert.deepEqual(readdirSync(dir).sort(), [
      "android-chrome-192x192.png",
      "android-chrome-512x512.png",
      "apple-touch-icon.png",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "favicon.ico",
      "favicon.svg",
      "phibot-logo.svg",
    ]);
    assert.equal(readFileSync(path.join(dir, "phibot-logo.svg"), "utf8"), logoSvg());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
