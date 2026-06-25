import sharp from "sharp";

const [a, b] = process.argv.slice(2);
const ra = await sharp(a)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const rb = await sharp(b)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
  console.log(
    JSON.stringify({ error: "dimension mismatch", a: ra.info, b: rb.info }),
  );
  process.exit(1);
}
const { width, height, channels } = ra.info;
const da = ra.data,
  db = rb.data;
let diffPixels = 0;
let minX = width,
  minY = height,
  maxX = 0,
  maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    if (
      Math.abs(da[i] - db[i]) > 6 ||
      Math.abs(da[i + 1] - db[i + 1]) > 6 ||
      Math.abs(da[i + 2] - db[i + 2]) > 6
    ) {
      diffPixels++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(
  JSON.stringify(
    {
      width,
      height,
      totalPixels: width * height,
      diffPixels,
      pctDiff: ((diffPixels / (width * height)) * 100).toFixed(4),
      bbox: diffPixels
        ? { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
        : null,
    },
    null,
    2,
  ),
);
