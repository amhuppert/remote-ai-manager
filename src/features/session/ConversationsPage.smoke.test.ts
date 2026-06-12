// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, ConsoleMessage, Page } from "playwright";

const smokeUrl = process.env["CC_SMOKE_URL"];
const shouldRun = typeof smokeUrl === "string" && smokeUrl.length > 0;

// CC_SMOKE_URL must point at a conversations-page URL with a selected
// conversation, e.g. http://localhost:3001/conversations?c=<conversationId>.
// Skipped unless the env var is set so regular `bun run test` runs stay fast
// and offline.
//
// Fixture limitations: this smoke covers the page shell, prompt editor,
// virtualized list, layout switcher, debug toggle, scroll, and console-error
// budget. ConversationBanners (FinishedBanner / ErrorBanner / fork banners),
// TypingIndicator, and the collab swimlane only render under specific machine
// states (completed/errored conversation, assistant turn in progress, live
// collab session). The generic CC_SMOKE_URL fixture cannot guarantee those
// states, so they are intentionally not asserted here — drive them through a
// dedicated fixture or live conversation if regression coverage is needed.
describe.skipIf(!shouldRun)("ConversationsPage Playwright smoke", () => {
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err: Error) => consoleErrors.push(err.message));
    await page.goto(smokeUrl!, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-page="detail"]', { timeout: 15_000 });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("renders the conversations page shell", async () => {
    const shell = await page.locator('[data-page="detail"]').count();
    expect(shell).toBe(1);
  });

  it("renders without console errors", () => {
    expect(consoleErrors).toEqual([]);
  });

  it("shows the prompt editor and accepts typed text", async () => {
    const editor = page.locator(
      '[contenteditable="true"], textarea, [role="textbox"]',
    );
    await editor.first().waitFor({ state: "visible", timeout: 5_000 });
    await editor.first().click();
    await page.keyboard.type("smoke-test prompt");
    const value = await editor.first().evaluate((el: Element) => {
      if (el instanceof HTMLTextAreaElement) return el.value;
      return el.textContent ?? "";
    });
    expect(value).toContain("smoke-test prompt");
  });

  it("renders the virtualized message list", async () => {
    const list = page.locator(
      '[data-testid="virtuoso-item-list"], [data-virtuoso-scroller="true"], div[data-testid^="virtuoso"]',
    );
    const count = await list.count();
    expect(count).toBeGreaterThan(0);
  });

  it("exposes the layout switcher and toggles state", async () => {
    const layoutButtons = page.locator(".layout-switcher .layout-btn");
    const count = await layoutButtons.count();
    expect(count).toBeGreaterThan(0);
    await layoutButtons.first().click();
    await page.waitForTimeout(200);
    const stillShellPresent = await page
      .locator('[data-page="detail"]')
      .count();
    expect(stillShellPresent).toBe(1);
  });

  it("exposes the debug toggle", async () => {
    const debugToggle = page.locator(
      'button:has-text("Debug"), [data-testid*="debug"]',
    );
    const count = await debugToggle.count();
    expect(count).toBeGreaterThan(0);
  });

  it("scrolls the message list without losing the shell", async () => {
    const scrollable = page
      .locator('[data-virtuoso-scroller="true"], main')
      .first();
    await scrollable.evaluate((el: Element) => {
      const scrollable = el as HTMLElement;
      scrollable.scrollTop = 400;
    });
    await page.waitForTimeout(200);
    const shellAfterScroll = await page.locator('[data-page="detail"]').count();
    expect(shellAfterScroll).toBe(1);
  });
});
