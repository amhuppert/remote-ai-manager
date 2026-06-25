import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(
  "http://localhost:6061/iframe.html?id=session-commithistory--multiple-commits&viewMode=story",
);
await page.getByText("Add session validation layer").waitFor();
await page.waitForTimeout(400);
const info = await page.evaluate(() => {
  const badges = [...document.querySelectorAll("span")].filter((s) =>
    /^[a-z0-9]{7}$/.test(s.textContent?.trim() ?? ""),
  );
  const rows = badges.map((b) => Math.round(b.getBoundingClientRect().top));
  // inspect any heading wrapper around the trigger
  const heading = document.querySelector("h1,h2,h3,h4,h5,h6");
  let headingInfo = null;
  if (heading) {
    const cs = getComputedStyle(heading);
    headingInfo = {
      tag: heading.tagName,
      display: cs.display,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      className: heading.className,
    };
  }
  return {
    badgeTops: rows,
    deltas: rows.slice(1).map((v, i) => v - rows[i]),
    headingInfo,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
