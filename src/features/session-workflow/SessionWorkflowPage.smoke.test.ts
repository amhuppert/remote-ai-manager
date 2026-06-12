// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, ConsoleMessage, Page } from "playwright";

const smokeUrl = process.env["CC_WORKFLOW_SMOKE_URL"];
const shouldRun = typeof smokeUrl === "string" && smokeUrl.length > 0;

// CC_WORKFLOW_SMOKE_URL must point at a SessionWorkflowPage route, e.g.
// http://localhost:3001/projects/<project>/<session>/workflow, AND the linked
// session must have:
//   1. An active graphWorkflowExecution (so `data-page="workflow"` mounts the
//      execution container instead of the "No workflow configured" empty
//      state).
//   2. At least one task whose `lastConversationId` resolves to a transcript
//      with BOTH user-origin AND workflow-origin turns (so badge presence and
//      absence can be asserted on the same fixture).
//
// Skipped unless the env var is set so regular `bun run test` runs stay fast
// and offline. Pattern mirrors src/features/session/ConversationsPage.smoke.test.ts.
describe.skipIf(!shouldRun)(
  "SessionWorkflowPage Playwright smoke (workflow execution view)",
  () => {
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
      await page.waitForSelector('[data-page="workflow"]', {
        timeout: 15_000,
      });
      // Open the first task transcript via the Inspector's "View" affordance.
      // The Inspector lists tasks under `.wb-task-item`; clicking the item
      // surfaces task details which include the view-transcript control.
      const taskItems = page.locator(".wb-task-item-main");
      await taskItems.first().waitFor({ state: "visible", timeout: 10_000 });
      await taskItems.first().click();
      const viewBtn = page.locator(
        '.wb-task-item button:has-text("View"), .wb-task-item button:has-text("Transcript"), .wb-task-item [aria-label*="transcript" i]',
      );
      if ((await viewBtn.count()) > 0) {
        await viewBtn.first().click();
      }
      await page.waitForSelector(".wb-transcript-viewer", { timeout: 10_000 });
      await page.waitForSelector(".panel-body .conversation", {
        timeout: 10_000,
      });
    }, 45_000);

    afterAll(async () => {
      await browser?.close();
    });

    it("mounts the workflow execution shell", async () => {
      const shell = await page.locator('[data-page="workflow"]').count();
      expect(shell).toBe(1);
    });

    it("renders the transcript via the shared ConversationPanel + ConversationVirtuosoList", async () => {
      // `.panel-body` belongs to ConversationPanel; the virtuoso scroller
      // belongs to ConversationVirtuosoList. Both must be present to prove
      // the workflow viewer uses the shared chain (not the deleted
      // IterationTranscriptViewer).
      const panel = await page.locator(".panel-body .conversation").count();
      expect(panel).toBe(1);
      const virtuoso = await page
        .locator(
          '[data-virtuoso-scroller="true"], [data-testid="virtuoso-item-list"]',
        )
        .count();
      expect(virtuoso).toBeGreaterThan(0);
    });

    it("shows the iteration badge on workflow-origin turns and omits it on user-origin turns", async () => {
      const badges = page.locator(".message-iteration-badge");
      await badges.first().waitFor({ state: "visible", timeout: 10_000 });
      const badgeCount = await badges.count();
      expect(badgeCount).toBeGreaterThan(0);

      // Every visible badge must sit inside a non-user (assistant) row. The
      // .message class carries the role: `.message.user` for user-origin
      // turns, `.message.assistant` otherwise.
      const userRowBadgeCount = await page
        .locator(".message.user .message-iteration-badge")
        .count();
      expect(userRowBadgeCount).toBe(0);

      const assistantRowBadgeCount = await page
        .locator(".message.assistant .message-iteration-badge")
        .count();
      expect(assistantRowBadgeCount).toBe(badgeCount);
    });

    it("scrolls the virtualized message list without losing the viewer chrome", async () => {
      const scrollable = page
        .locator('[data-virtuoso-scroller="true"]')
        .first();
      await scrollable.evaluate((el: Element) => {
        (el as HTMLElement).scrollTop = 600;
      });
      await page.waitForTimeout(200);
      const stillMounted = await page.locator(".wb-transcript-viewer").count();
      expect(stillMounted).toBe(1);
      const shellAfterScroll = await page
        .locator('[data-page="workflow"]')
        .count();
      expect(shellAfterScroll).toBe(1);
    });

    it("renders without console errors", () => {
      expect(consoleErrors).toEqual([]);
    });
  },
);
