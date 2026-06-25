import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(
  "http://localhost:6061/iframe.html?id=agent-capabilities-agentcapabilitiesconfigurator--inline&viewMode=story",
);
await page.waitForSelector('[role="tablist"]');
await page.waitForTimeout(600);
const info = await page.evaluate(() => {
  const list = document.querySelector('[role="tablist"]');
  const tab = document.querySelector('[role="tab"][aria-selected="true"]');
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  return {
    listOrientation: list?.getAttribute("data-orientation"),
    listDataState: list?.outerHTML?.slice(0, 120),
    selTabId: tab?.id,
    selControls: tab?.getAttribute("aria-controls"),
    selState: tab?.getAttribute("data-state"),
    panelCount: panels.length,
    panelInfo: panels.map((p) => ({
      id: p.id,
      labelledby: p.getAttribute("aria-labelledby"),
      state: p.getAttribute("data-state"),
    })),
    bodyText: document.body.innerText.slice(0, 300),
  };
});
console.log(JSON.stringify({ errors: errors.slice(0, 3), info }, null, 2));
await browser.close();
