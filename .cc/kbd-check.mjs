import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const page = await browser.newPage();
await page.goto(
  "http://localhost:6061/iframe.html?id=agent-capabilities-agentcapabilitiesconfigurator--inline&viewMode=story",
);
await page.waitForSelector('[role="tab"]');
await page.waitForTimeout(400);
const seq = [];
await page.locator('[role="tab"]').first().focus();
seq.push(
  await page.evaluate(() => document.activeElement?.textContent?.trim()),
);
for (let i = 0; i < 6; i++) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(80);
  seq.push(
    await page.evaluate(() => {
      const el = document.activeElement;
      return {
        name: el?.textContent?.trim(),
        selected: el?.getAttribute("aria-selected"),
        outline: getComputedStyle(el).outline,
      };
    }),
  );
}
console.log(JSON.stringify(seq, null, 2));
await browser.close();
