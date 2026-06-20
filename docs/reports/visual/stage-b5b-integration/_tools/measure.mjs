// Throwaway: measure key region heights of a panel story at mobile width.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const LABEL = process.argv[2] ?? "?";
const ROOT = path.resolve("storybook-static");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (u === "/") u = "/index.html";
  const f = path.join(ROOT, u);
  if (
    !f.startsWith(ROOT) ||
    !fs.existsSync(f) ||
    fs.statSync(f).isDirectory()
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(f)] ?? "application/octet-stream",
  });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
await page.goto(
  `http://localhost:${port}/iframe.html?id=agent-capabilities-agentcapabilitypanel--native-inherited-overridden&viewMode=story`,
  { waitUntil: "networkidle" },
);
await page.waitForTimeout(700);
const m = await page.evaluate(() => {
  const sec =
    document.querySelector("section[data-cascade-kind]") ||
    document.querySelector("section");
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
  const walk = (el, depth) =>
    [...el.children].flatMap((c) => {
      const cls = (c.className || "").toString();
      const drillable =
        cls.includes("bg-bg-void") || /mt-lg/.test(cls) || depth > 0;
      const row = {
        tag: c.tagName,
        h: Math.round(c.getBoundingClientRect().height),
        cls: cls.slice(0, 50),
        depth,
      };
      return [row, ...(drillable && depth >= 0 ? walk(c, depth - 1) : [])];
    });
  return { sectionH: h(sec), tree: sec ? walk(sec, 1) : [] };
});
console.log(`[${LABEL}] sectionH=${m.sectionH}`);
for (const k of m.tree)
  console.log(`  ${"    ".repeat(1 - k.depth)}${k.tag} h=${k.h}  ${k.cls}`);
await browser.close();
server.close();
