import { chromium } from "playwright";

const BASE = "http://localhost:6061";
const LABEL = process.argv[2] ?? "after";
const story = (id) => `${BASE}/iframe.html?id=${id}&viewMode=story`;
const AXE_CDN = "https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js";

async function runAxe(page) {
  await page.addScriptTag({ url: AXE_CDN });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
  });
}

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];
const STORY = "session-commithistory--multiple-commits";

const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const results = {};
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await ctx.newPage();
  await page.goto(story(STORY));
  await page.waitForSelector("button[aria-expanded]", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `.cc/shots/commithistory-${vp.name}-${LABEL}.png`,
  });
  await ctx.close();
}

if (LABEL === "after") {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const diffRequests = [];
  page.on("request", (req) => {
    if (/\/commits\/.+\/diff/.test(req.url())) diffRequests.push(req.url());
  });
  await page.goto(story(STORY));
  await page.waitForSelector("button[aria-expanded]");
  await page.waitForTimeout(600);

  const beforeExpand = diffRequests.length;
  // expand the first commit (Accordion toggles on click)
  const headers = page.locator("button[aria-expanded]");
  const headerCount = await headers.count();
  const firstAriaBefore = await headers.first().getAttribute("aria-expanded");
  await headers.first().click();
  await page.waitForTimeout(500);
  const afterFirstExpand = diffRequests.length;
  const firstAriaAfter = await headers.first().getAttribute("aria-expanded");
  const region = await page.evaluate(() => {
    const open = document.querySelector('button[aria-expanded="true"]');
    const cid = open?.getAttribute("aria-controls");
    const reg = cid ? document.getElementById(cid) : null;
    return {
      controls: cid,
      regionRole: reg?.getAttribute("role"),
      regionState: reg?.getAttribute("data-state"),
    };
  });
  // single-open: expand second, first collapses
  await headers.nth(1).click();
  await page.waitForTimeout(400);
  const secondAriaAfter = await headers.nth(1).getAttribute("aria-expanded");
  const firstAriaAfterSecond = await headers
    .first()
    .getAttribute("aria-expanded");

  // keyboard: focus first, Enter toggles + cyan ring
  await headers.first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const kb = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      expanded: el?.getAttribute("aria-expanded"),
      outline: getComputedStyle(el).outline,
    };
  });

  results.lazy = {
    headerCount,
    firstAriaBefore,
    diffRequestsBeforeAnyExpand: beforeExpand,
    diffRequestsAfterFirstExpand: afterFirstExpand,
    firstAriaAfterClick: firstAriaAfter,
    region,
    secondAriaAfter,
    firstAriaAfterSecond,
    keyboardEnter: kb,
    diffUrls: diffRequests,
  };
  await page.goto(story(STORY));
  await page.waitForSelector("button[aria-expanded]");
  await page.waitForTimeout(300);
  results.axeCollapsed = await runAxe(page);
  // axe with one expanded
  await page.locator("button[aria-expanded]").first().click();
  await page.waitForTimeout(400);
  results.axeExpanded = await runAxe(page);
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
