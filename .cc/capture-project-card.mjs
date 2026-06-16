// Parity capture for the ProjectCard pilot slice.
// Usage: node .cc/capture-project-card.mjs <before|after> [port]
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

// Playwright 1.58 pins build 1208 but only 1223 is installed here; point at it.
const executablePath = `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell`;

const phase = process.argv[2];
const port = process.argv[3] ?? "6017";
if (phase !== "before" && phase !== "after") {
  console.error("phase must be 'before' or 'after'");
  process.exit(1);
}

const outDir = "docs/reports/visual/project-card";
await mkdir(outDir, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

// story id -> label
const STORIES = [
  ["projects-projectcard--idle", "idle"],
  ["projects-projectcard--with-sessions", "with-sessions"],
  ["projects-projectcard--active", "active"],
  ["projects-projectcard--pinned", "pinned"],
  ["projects-projectcard--pinned-active", "pinned-active"],
  ["projects-projectcard--archived", "archived"],
  ["projects-projectcard--missing", "missing"],
];

// states to also capture under :hover (desktop only — hover visuals are
// viewport-independent except the pin button touch size).
const HOVER = new Set(["idle", "active", "pinned-active"]);

// Screenshot a padded clip around the card so box-shadow / ::before glow that
// bleeds outside the border is captured (an element crop would clip them).
const PAD = 32;
async function clipFor(page, vp) {
  const card = page.locator("#storybook-root > *").first();
  const box = await card.boundingBox();
  if (!box) return undefined;
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  return {
    x,
    y,
    width: Math.min(vp.width - x, box.width + PAD * 2),
    height: Math.min(vp.height - y, box.height + PAD * 2),
  };
}

const browser = await chromium.launch({ executablePath });
const results = [];
try {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    for (const [id, label] of STORIES) {
      const url = `http://localhost:${port}/iframe.html?id=${id}&viewMode=story`;
      await page.goto(url, { waitUntil: "networkidle" });
      // The card is the only block in the story; wait for its first child.
      await page.waitForSelector("#storybook-root *", { timeout: 15000 });
      await page.waitForTimeout(250);
      const file = `${outDir}/${phase}-${label}-${vpName}.png`;
      await page.screenshot({ path: file, clip: await clipFor(page, vp) });
      results.push(file);

      if (vpName === "desktop" && HOVER.has(label)) {
        const card = page.locator("#storybook-root > *").first();
        await card.hover();
        await page.waitForTimeout(350); // transitions are 0.2s
        const hfile = `${outDir}/${phase}-${label}-desktop-hover.png`;
        await page.screenshot({ path: hfile, clip: await clipFor(page, vp) });
        results.push(hfile);
        // move pointer away to reset for next story
        await page.mouse.move(0, 0);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`captured ${results.length} screenshots:`);
for (const r of results) console.log("  " + r);
