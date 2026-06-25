import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const LABEL = process.argv[2] ?? "before";
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await ctx.newPage();
  await page.goto(
    "http://localhost:6061/iframe.html?id=session-commithistory--multiple-commits&viewMode=story",
  );
  await page
    .getByText("Add session validation layer")
    .waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `.cc/shots/commithistory-${vp.name}-${LABEL}.png`,
  });
  await ctx.close();
}
await browser.close();
console.log("captured", LABEL);
