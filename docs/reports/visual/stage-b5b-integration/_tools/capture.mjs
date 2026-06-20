// Throwaway B-5b parity capture: serves ./storybook-static and screenshots each
// agent-capability story at desktop + mobile. Usage: node scripts/_b5b-capture.mjs <state> <outDir>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const STATE = process.argv[2] ?? "after";
const OUT = process.argv[3] ?? `/tmp/b5b-${STATE}`;
const ROOT = path.resolve("storybook-static");

const STORIES = [
  "agent-capabilities-agentcapabilitiesconfigurator--inline",
  "agent-capabilities-agentcapabilitiesconfigurator--drawer",
  "agent-capabilities-agentcapabilitypanel--native-inherited-overridden",
  "agent-capabilities-agentcapabilitypanel--parent-stale-pending-failed-diagnostic",
  "agent-capabilities-agentcapabilitypanel--unavailable-codex-plugins",
  "agent-capabilities-agentcapabilitypanel--plugin-provided-rows",
  "agent-capabilities-agentcapabilitypanel--interactive-regression",
  "agent-capabilities-agentcapabilitypanel--error-rendering",
  "agent-capabilities-agentcapabilitypanel--five-panels-overview",
  "agent-capabilities-mcpcapabilitypanelcontainer--server-rows",
  "agent-capabilities-mcpcapabilitypanelcontainer--expanded-tools",
];

// Per-story post-load actions (revision-stable selectors): expand a seeded MCP
// server row to reveal its tool rows. The chevron carries no accessible name,
// so target it via the row's data-server-id + aria-expanded.
const POST_LOAD = {
  "agent-capabilities-mcpcapabilitypanelcontainer--expanded-tools": async (
    page,
  ) => {
    await page.click(
      '[data-server-id="chrome-devtools"] button[aria-expanded]',
    );
    await page.waitForTimeout(300);
  },
};

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

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
  let url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (url === "/") url = "/index.html";
  const file = path.join(ROOT, url);
  if (
    !file.startsWith(ROOT) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  for (const id of STORIES) {
    await page.goto(
      `http://localhost:${port}/iframe.html?id=${id}&viewMode=story`,
      { waitUntil: "networkidle" },
    );
    await page.waitForTimeout(700);
    if (POST_LOAD[id]) await POST_LOAD[id](page);
    const out = path.join(OUT, `${id}__${vp.name}__${STATE}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`captured ${path.basename(out)}`);
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`DONE ${STATE} -> ${OUT}`);
