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
const STORY = "session-specbrowser--features-nav";
const waitText = "Browser Notifications";

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
  await page
    .getByText(waitText, { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `.cc/shots/specbrowser-${vp.name}-${LABEL}.png`,
  });
  await ctx.close();
}

if (LABEL === "after") {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(story(STORY));
  await page.waitForSelector("button[aria-expanded]");
  await page.waitForTimeout(400);
  const groups = page.locator("button[aria-expanded]");
  const groupCount = await groups.count();
  const firstAria0 = await groups.first().getAttribute("aria-expanded");
  // expand first group (Accordion toggles on click)
  await groups.first().click();
  await page.waitForTimeout(300);
  const firstAria1 = await groups.first().getAttribute("aria-expanded");
  const region = await page.evaluate(() => {
    const open = document.querySelector('button[aria-expanded="true"]');
    const cid = open?.getAttribute("aria-controls");
    const reg = cid ? document.getElementById(cid) : null;
    return {
      controls: cid,
      role: reg?.getAttribute("role"),
      state: reg?.getAttribute("data-state"),
    };
  });
  // single-open: expand second collapses first
  let secondAria = null,
    firstAfterSecond = null;
  if (groupCount > 1) {
    await groups.nth(1).click();
    await page.waitForTimeout(300);
    secondAria = await groups.nth(1).getAttribute("aria-expanded");
    firstAfterSecond = await groups.first().getAttribute("aria-expanded");
  }
  // keyboard: focus first, Enter toggles + cyan ring
  await groups.first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const kb = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      expanded: el?.getAttribute("aria-expanded"),
      outline: getComputedStyle(el).outline,
    };
  });
  // verify FLAT: the accordion container has no card border (parity to steering list)
  const flat = await page.evaluate(() => {
    const open = document.querySelector("button[aria-expanded]");
    // climb to the accordion root (the [data-orientation] from Radix Accordion.Root)
    let root = open;
    while (root && !root.hasAttribute("data-orientation"))
      root = root.parentElement;
    if (!root) return null;
    const cs = getComputedStyle(root);
    return {
      tag: root.tagName,
      borderWidth: cs.borderWidth,
      borderRadius: cs.borderRadius,
      display: cs.display,
    };
  });
  results.groupCount = groupCount;
  results.firstAria0 = firstAria0;
  results.firstAria1 = firstAria1;
  results.region = region;
  results.secondAria = secondAria;
  results.firstAfterSecond = firstAfterSecond;
  results.keyboardEnter = kb;
  results.flatRoot = flat;
  // axe collapsed + expanded
  await page.goto(story(STORY));
  await page.waitForSelector("button[aria-expanded]");
  await page.waitForTimeout(300);
  results.axeCollapsed = await runAxe(page);
  await page.locator("button[aria-expanded]").first().click();
  await page.waitForTimeout(300);
  results.axeExpanded = await runAxe(page);
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
