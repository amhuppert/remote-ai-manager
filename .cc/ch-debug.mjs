import { chromium } from "playwright";
const b = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.goto(
  "http://localhost:6061/iframe.html?id=session-commithistory--multiple-commits&viewMode=story",
);
await p.waitForTimeout(1500);
const info = await p.evaluate(() => ({
  bodyText: document.body.innerText.slice(0, 400),
  expBtns: document.querySelectorAll("button[aria-expanded]").length,
  allBtns: document.querySelectorAll("button").length,
  firstBtnText: document.querySelector("button")?.textContent?.slice(0, 40),
}));
console.log(JSON.stringify({ errs, info }, null, 2));
await b.close();
