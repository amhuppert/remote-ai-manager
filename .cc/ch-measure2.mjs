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
  // Each commit row's outermost item div contains the hash badge text.
  const msgs = [
    "Add session validation layer",
    "Refactor state management",
    "Fix race condition",
    "Initial session scaffolding",
  ];
  const rowTops = msgs.map((m) => {
    const el = [...document.querySelectorAll("span")].find((s) =>
      s.textContent?.includes(m),
    );
    return el ? Math.round(el.getBoundingClientRect().top) : null;
  });
  // Look for Radix Accordion.Header (h3) inside the list
  const h3s = [...document.querySelectorAll("h3")];
  const headerInfo = h3s.slice(0, 1).map((h) => {
    const cs = getComputedStyle(h);
    return {
      tag: h.tagName,
      display: cs.display,
      mt: cs.marginTop,
      mb: cs.marginBottom,
      h: Math.round(h.getBoundingClientRect().height),
      cls: h.className,
    };
  });
  // Any heading element wrapping a commit button?
  const btn = document.querySelector(
    "button[aria-expanded], [data-state] button, .group\\/commit-header",
  );
  let wrapperChain = [];
  if (btn) {
    let p = btn.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      const cs = getComputedStyle(p);
      wrapperChain.push({
        tag: p.tagName,
        display: cs.display,
        mt: cs.marginTop,
        mb: cs.marginBottom,
      });
      p = p.parentElement;
    }
  }
  return {
    rowTops,
    rowPitch: rowTops.slice(1).map((v, i) => v - rowTops[i]),
    h3Count: h3s.length,
    headerInfo,
    wrapperChain,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
