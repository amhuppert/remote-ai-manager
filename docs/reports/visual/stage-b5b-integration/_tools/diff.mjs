// Throwaway: shift-tolerant structural pixel-diff of before/after PNG pairs.
// A pixel counts as a real difference only if no pixel within a ±RADIUS window
// of the other image matches it within TOL — this discounts sub-pixel text
// anti-aliasing and ≤RADIUS layout shifts, isolating genuine visual changes.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const AFTER = "/tmp/b5b-after";
const BEFORE = "/tmp/b5b-before";
const browser = await chromium.launch();
const page = await browser.newPage();
const files = fs
  .readdirSync(AFTER)
  .filter((f) => f.endsWith(".png"))
  .sort();
let worst = 0;
for (const f of files) {
  const bPath = path.join(BEFORE, f.replace("__after", "__before"));
  if (!fs.existsSync(bPath)) {
    console.log(`${f}: NO BEFORE`);
    continue;
  }
  const aB64 = fs.readFileSync(path.join(AFTER, f)).toString("base64");
  const bB64 = fs.readFileSync(bPath).toString("base64");
  const res = await page.evaluate(
    async ([a, b]) => {
      const load = (src) =>
        new Promise((r) => {
          const i = new Image();
          i.onload = () => r(i);
          i.src = "data:image/png;base64," + src;
        });
      const ia = await load(a),
        ib = await load(b);
      const w = Math.min(ia.width, ib.width),
        h = Math.min(ia.height, ib.height);
      const g = (img) => {
        const c = new OffscreenCanvas(w, h);
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const da = g(ia),
        db = g(ib);
      const TOL = 48,
        R = 2;
      const at = (d, x, y) => {
        const i = (y * w + x) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      let diff = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [ar, ag, ab] = at(da, x, y);
          let ok = false;
          for (let dy = -R; dy <= R && !ok; dy++)
            for (let dx = -R; dx <= R && !ok; dx++) {
              const nx = x + dx,
                ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const [br, bg, bb] = at(db, nx, ny);
              if (
                Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb) <=
                TOL
              )
                ok = true;
            }
          if (!ok) diff++;
        }
      }
      return { diff, total: w * h };
    },
    [aB64, bB64],
  );
  const pct = ((res.diff / res.total) * 100).toFixed(3);
  worst = Math.max(worst, Number(pct));
  console.log(
    `${f.replace("__after.png", "")}: ${pct}% structural (${res.diff}px)`,
  );
}
console.log(`WORST structural: ${worst}%`);
await browser.close();
