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
const STORY = "config-configpage--default";

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
  // pre-migration nav had role=navigation, post has role=tablist; wait for either
  await page.waitForSelector("nav, [role=tablist]", { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `.cc/shots/configpage-${vp.name}-${LABEL}.png`,
  });
  await ctx.close();
}

if (LABEL === "after") {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(story(STORY));
  await page.waitForSelector('[role="tablist"]');
  await page.waitForTimeout(400);
  const list = page.locator('[role="tablist"]');
  const orientation = await list.getAttribute("data-orientation");
  // keyboard ArrowDown roving + automatic activation
  const tabs = page.locator('[role="tab"]');
  const seq = [];
  await tabs.first().focus();
  seq.push(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
  );
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(80);
    seq.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        return {
          name: el?.textContent?.trim(),
          selected: el?.getAttribute("aria-selected"),
          orientation: el?.getAttribute("data-orientation"),
          outline: getComputedStyle(el).outline,
          boxShadow: getComputedStyle(el).boxShadow.slice(0, 40),
        };
      }),
    );
  }
  const wiring = await page.evaluate(() => {
    const sel = document.querySelector('[role="tab"][aria-selected="true"]');
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      selName: sel?.textContent?.trim(),
      selControls: sel?.getAttribute("aria-controls"),
      panelId: panel?.id,
      panelLabelledBy: panel?.getAttribute("aria-labelledby"),
      panelState: panel?.getAttribute("data-state"),
    };
  });
  results.orientation = orientation;
  results.keyboardSeq = seq;
  results.wiring = wiring;
  results.axe = await runAxe(page);
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
