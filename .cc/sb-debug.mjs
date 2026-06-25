import { chromium } from "playwright";
const b = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const p = await b.newPage();
await p.goto(
  "http://localhost:6061/iframe.html?id=session-specbrowser--features-nav&viewMode=story",
);
await p.waitForTimeout(1500);
const info = await p.evaluate(() => ({
  expBtns: document.querySelectorAll("button[aria-expanded]").length,
  bodyText: document.body.innerText.slice(0, 300),
}));
console.log(JSON.stringify(info, null, 2));
await b.close();
