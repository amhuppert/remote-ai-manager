import sharp from "sharp";
const [a, b, out] = process.argv.slice(2);
const ra = await sharp(a)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const rb = await sharp(b)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width, height, channels } = ra.info;
const da = ra.data,
  db = rb.data;
const outBuf = Buffer.alloc(width * height * 4);
for (let p = 0; p < width * height; p++) {
  const i = p * channels;
  const o = p * 4;
  const d =
    Math.abs(da[i] - db[i]) +
    Math.abs(da[i + 1] - db[i + 1]) +
    Math.abs(da[i + 2] - db[i + 2]);
  if (d > 18) {
    outBuf[o] = 255;
    outBuf[o + 1] = 0;
    outBuf[o + 2] = 255;
    outBuf[o + 3] = 255;
  } else {
    // dim the unchanged base for context
    outBuf[o] = da[i] >> 1;
    outBuf[o + 1] = da[i + 1] >> 1;
    outBuf[o + 2] = da[i + 2] >> 1;
    outBuf[o + 3] = 255;
  }
}
await sharp(outBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(out);
console.log("wrote", out);
