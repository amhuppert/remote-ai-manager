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
const STORIES = [
  "agent-capabilities-agentcapabilitiesconfigurator--inline",
  "agent-capabilities-agentcapabilitiesconfigurator--drawer",
];

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
  for (const id of STORIES) {
    await page.goto(story(id));
    await page.waitForSelector('[role="tablist"]', { timeout: 10000 });
    await page.waitForTimeout(400);
    const short = id.split("--")[1];
    await page.screenshot({
      path: `.cc/shots/agentcaps-${short}-${vp.name}-${LABEL}.png`,
    });
  }
  await ctx.close();
}

// Behavior/aria/keyboard checks (after only)
if (LABEL === "after") {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(story(STORIES[0]));
  await page.waitForSelector('[role="tablist"]');
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  const tablistOrientation = await page
    .locator('[role="tablist"]')
    .getAttribute("data-orientation");
  // default selected = MCP Servers
  const selectedBefore = await page.evaluate(() => {
    const sel = document.querySelector('[role="tab"][aria-selected="true"]');
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      selectedName: sel?.textContent?.trim(),
      panelLabelledBy: panel?.getAttribute("aria-labelledby"),
      selId: sel?.id,
      ariaControls: sel?.getAttribute("aria-controls"),
      panelId: panel?.id,
    };
  });
  // ArrowRight roving focus skips the group-label spans
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  const afterArrow = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      name: el?.textContent?.trim(),
      role: el?.getAttribute("role"),
      selected: el?.getAttribute("aria-selected"),
      outline: getComputedStyle(el).outlineColor,
    };
  });
  results.behavior = {
    tabCount,
    tablistOrientation,
    selectedBefore,
    afterArrow,
  };
  results.axeInline = await runAxe(page);
  await page.goto(story(STORIES[1]));
  await page.waitForSelector('[role="tablist"]');
  results.axeDrawer = await runAxe(page);
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
