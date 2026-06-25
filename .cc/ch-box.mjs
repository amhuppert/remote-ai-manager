import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    "/Users/alex/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-x64/chrome-headless-shell",
});
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(
  "http://localhost:6061/iframe.html?id=session-commithistory--single-commit&viewMode=story",
);
await page.getByText("Add session validation layer").waitFor();
await page.waitForTimeout(400);
const info = await page.evaluate(() => {
  const badge = [...document.querySelectorAll("span")].find(
    (s) => s.textContent?.trim() === "a1b2c3d",
  );
  // climb to the grid element (the clickable header: div in before, button in after)
  let grid = badge;
  while (grid && getComputedStyle(grid).display !== "grid")
    grid = grid.parentElement;
  const gcs = grid ? getComputedStyle(grid) : null;
  const gridBox = grid?.getBoundingClientRect();
  const parent = grid?.parentElement;
  const pcs = parent ? getComputedStyle(parent) : null;
  return {
    gridTag: grid?.tagName,
    gridHeight: gridBox ? Math.round(gridBox.height) : null,
    gridPadTop: gcs?.paddingTop,
    gridPadBottom: gcs?.paddingBottom,
    gridFontSize: gcs?.fontSize,
    gridLineHeight: gcs?.lineHeight,
    gridRowGap: gcs?.rowGap,
    gridTemplateRows: gcs?.gridTemplateRows,
    parentTag: parent?.tagName,
    parentDisplay: pcs?.display,
    parentHeight: parent
      ? Math.round(parent.getBoundingClientRect().height)
      : null,
    parentAlignItems: pcs?.alignItems,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
