import { deflateSync } from "node:zlib";

/**
 * A PNG built byte-for-byte in code, for the image-input acceptance case
 * (spec R16.1, R14.2).
 *
 * The case has to prove the model saw THIS image, which means the image has to
 * have an unambiguous answer and the same bytes on every run. A solid field of
 * one primary colour gives both: any vision model names it the same way, and a
 * fixture generated from fixed inputs hashes identically, so the published
 * digest identifies the exact image the run used.
 *
 * Written here rather than pulled from a dependency because an encoder is a few
 * lines and a committed binary fixture would be an untracked-or-committed
 * decision the evidence rules already answer for raw fixtures.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

export interface SolidColor {
  red: number;
  green: number;
  blue: number;
}

/** An 8-bit RGB PNG of one colour, `size` pixels square. */
export function solidColorPng(size: number, color: SolidColor): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: truecolour
  header.writeUInt8(0, 10); // deflate
  header.writeUInt8(0, 11); // adaptive filtering
  header.writeUInt8(0, 12); // no interlace

  // One filter byte per scanline, then RGB triples.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let row = 0; row < size; row += 1) {
    const start = row * stride;
    raw[start] = 0;
    for (let column = 0; column < size; column += 1) {
      const pixel = start + 1 + column * 3;
      raw[pixel] = color.red;
      raw[pixel + 1] = color.green;
      raw[pixel + 2] = color.blue;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
