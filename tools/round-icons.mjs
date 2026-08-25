/**
 * Give the application icons rounded corners.
 *
 * Written out rather than pulled in: the project has no runtime dependencies
 * and no build-time image library either, and a PNG is a handful of chunks
 * around a zlib stream, which Node already has. Decoding, masking and
 * re-encoding is under two hundred lines and keeps `npm install` at five
 * dev dependencies.
 *
 * Run with: node tools/round-icons.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, which every PNG chunk carries. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks = [];
  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

/** Undo one scanline filter. The five types are the whole of PNG filtering. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const dest = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dest[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bpp ? prior[x - bpp] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      dest[x] = value & 0xff;
    }
  }
  return out;
}

function decode(file) {
  const chunks = readChunks(readFileSync(file));
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8) throw new Error(`only 8-bit channels are handled, got ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not handled');
  if (colorType !== 6 && colorType !== 2) throw new Error(`unhandled colour type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const flat = unfilter(inflateSync(idat), width, height, bpp);

  // Normalise to RGBA so the mask only has to deal with one layout.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = flat[i * bpp];
    rgba[i * 4 + 1] = flat[i * bpp + 1];
    rgba[i * 4 + 2] = flat[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? flat[i * bpp + 3] : 255;
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encode({ width, height, rgba }) {
  const stride = width * 4;
  // Filter type 0 on every line: the images are small and this keeps the
  // encoder to something that can be read in one sitting.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Coverage of a squircle at one pixel, sampled to soften the edge.
 *
 * A superellipse rather than a circular-arc rounded rectangle: |x|^n + |y|^n
 * = 1 is the shape Apple and Google both use for app icons, and next to a
 * plain rounded rectangle it reads as smoother where the straight edge meets
 * the corner. Four-by-four supersampling because a hard alpha cut on a
 * diagonal is exactly where jaggies show.
 */
function squircleCoverage(x, y, size, inset, exponent) {
  const half = (size - inset * 2) / 2;
  const cx = size / 2, cy = size / 2;
  const samples = 4;
  let inside = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples - cx;
      const py = y + (sy + 0.5) / samples - cy;
      const u = Math.abs(px) / half;
      const v = Math.abs(py) / half;
      if (u ** exponent + v ** exponent <= 1) inside++;
    }
  }
  return inside / (samples * samples);
}

function round(file, { inset = 0, exponent = 4 } = {}) {
  const image = decode(file);
  const { width, height, rgba } = image;
  if (width !== height) throw new Error(`${file} is ${width}x${height}; icons should be square`);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coverage = squircleCoverage(x, y, width, inset, exponent);
      const i = (y * width + x) * 4 + 3;
      rgba[i] = Math.round(rgba[i] * coverage);
    }
  }
  writeFileSync(file, encode(image));
  return `${file}: ${width}x${width}, inset ${inset}px`;
}

const jobs = [
  // The desktop icon. macOS masks nothing for you — whatever shape the file
  // has is the shape on the dock, which is why a square one looks wrong next
  // to everything else there.
  ['build/icon.png', { inset: 0, exponent: 4.2 }],
  ['public/icon-512.png', { inset: 0, exponent: 4.2 }],
  ['public/icon-192.png', { inset: 0, exponent: 4.2 }],
  // Deliberately not the maskable one: the spec says it must be full-bleed
  // so the platform can crop it to whatever shape it likes. Rounding it here
  // would round it twice and clip the artwork.
];

for (const [file, opts] of jobs) console.log(round(file, opts));
