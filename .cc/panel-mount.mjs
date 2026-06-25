import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const page = await browser.newPage();
await page.goto(
  "http://localhost:6061/iframe.html?id=agent-capabilities-agentcapabilitiesconfigurator--inline&viewMode=story",
);
await page.waitForSelector('[role="tablist"]');
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  return panels.map((p) => ({
    state: p.getAttribute("data-state"),
    hidden: p.hasAttribute("hidden"),
    childCount: p.children.length,
    htmlLen: p.innerHTML.length,
  }));
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
