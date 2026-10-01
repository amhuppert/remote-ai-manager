// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithQuery, createTestQueryClient } from "@/test/component-mocks";
import { subscriptionKeys } from "@/lib/subscriptions/query-keys";
import type { InboxOverview } from "@/lib/subscriptions/controls-schemas";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { SubscriptionWorkspace } from "./SubscriptionWorkspace";
import { subscriptionFixture } from "./fixtures";
let api: FetchFixture;
let inboxData: InboxOverview;
const row = subscriptionFixture();
const counts = { following: 1, active: 0, paused: 0, pending: 1, attention: 0 };
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  api = installFetchFixture();
  api.json("GET", "/api/subscriptions/overview", {
    items: [row],
    total: 1,
    limit: 20,
    offset: 0,
    counts,
  });
  api.json(
    "GET",
    "/api/projects/command-center/sessions/Notifications/conversations/conversation-1/inbox/preferences",
    { hintsEnabled: true },
  );
  inboxData = {
    items: [
      {
        delivery: {
          id: "delivery-1",
          subscriptionId: row.subscription.id,
          recipient: row.subscription.recipient,
          source: row.subscription.source,
          fact: {
            occurrenceId: "revision-2",
            eventKind: "notepad-content-revised",
            category: "revision",
            sourceTitle: row.sourceTitle,
            summary: "Product decisions updated",
            occurredAt: "2026-09-30T12:00:00.000Z",
            revision: "2",
            outcome: null,
            retrievalHandle: "cctl notepad get notepad-1",
            actorConversationId: null,
          },
          recordedAt: "2026-09-30T12:00:00.000Z",
          state: "pending",
          attemptId: null,
          attemptCount: 0,
          queuedAt: null,
          acceptedAt: null,
          finishedAt: null,
          lastError: null,
        },
        owner: row.owner,
        sourceHref: null,
        readAt: null,
        wakeBatchId: null,
      },
    ],
    total: 1,
    limit: 20,
    offset: 0,
    counts: { pending: 1, accepted: 0, issues: 0, unread: 1 },
  };
  api.json("GET", "/api/subscriptions/inbox", inboxData);
});
afterEach(() => {
  cleanup();
  api.restore();
  vi.unstubAllGlobals();
});
describe("subscription workspace", () => {
  it.each(["retry", "dismiss"] as const)(
    "lets the operator %s an unresolved passive receipt without recording acceptance or a human read",
    async (action) => {
      const item = inboxData.items[0];
      if (!item) throw new Error("Expected inbox fixture");
      const delivery = item.delivery;
      delivery.state = "uncertain";
      delivery.lastError = "Acceptance unknown";
      api.json(
        "PATCH",
        "/api/projects/command-center/sessions/Notifications/conversations/conversation-1/inbox/delivery-1/read",
        {
          delivery: {
            ...delivery,
            state: action === "retry" ? "pending" : "superseded",
          },
        },
      );
      renderWithQuery(<SubscriptionWorkspace target={row.owner.target} />);
      await screen.findByText(row.sourceTitle);
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Inbox" }), {
        button: 0,
        ctrlKey: false,
      });
      await screen.findByText("Product decisions updated");
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "retry" ? "Retry delivery" : "Dismiss delivery",
        }),
      );
      await waitFor(() =>
        expect(api.requestsTo("PATCH", /\/read$/)[0]?.jsonBody).toEqual({
          action,
        }),
      );
      expect(delivery.acceptedAt).toBeNull();
      expect(item.readAt).toBeNull();
    },
  );
  it("scrolls the mobile inspector into view when reopening the same selection from Inbox", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    renderWithQuery(
      <SubscriptionWorkspace
        target={row.owner.target}
        initialSelected={row.subscription.id}
      />,
    );
    await screen.findByRole("button", { name: "Pause delivery" });
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: /View delivery history/ }),
    );
    await screen.findByText("Product decisions updated");
    fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    scroll.mockRestore();
  });
  it("returns to the last available page when a filtered list shrinks", async () => {
    let total = 25;
    api.reply("GET", "/api/subscriptions/overview", (request) => ({
      json: {
        items: Number(request.searchParams.get("offset")) >= total ? [] : [row],
        total,
        limit: 20,
        offset: Number(request.searchParams.get("offset")),
        counts,
      },
    }));
    const client = createTestQueryClient();
    renderWithQuery(
      <SubscriptionWorkspace target={row.owner.target} />,
      client,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("21–25 of 25");
    total = 5;
    await client.invalidateQueries({ queryKey: subscriptionKeys.all });
    await screen.findByText("1–5 of 5");
    expect(
      api
        .requestsTo("GET", "/api/subscriptions/overview")
        .at(-1)
        ?.searchParams.get("offset"),
    ).toBe("0");
    expect(screen.queryByText("Nothing following here yet")).toBeNull();
  });
  it("keeps the Pending metric's search when opening its inbox", async () => {
    renderWithQuery(<SubscriptionWorkspace target={row.owner.target} />);
    await screen.findByText(row.sourceTitle);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search subscriptions" }),
      { target: { value: "Vision" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Pending/ }));
    await screen.findByText("Product decisions updated");
    expect(
      api
        .requestsTo("GET", "/api/subscriptions/inbox")
        .at(-1)
        ?.searchParams.get("q"),
    ).toBe("Vision");
  });
  it("browses inbox without acknowledgment and marks only the human read receipt on request", async () => {
    api.json(
      "PATCH",
      "/api/projects/command-center/sessions/Notifications/conversations/conversation-1/inbox/delivery-1/read",
      { readAt: "2026-09-30T15:00:00.000Z" },
    );
    renderWithQuery(<SubscriptionWorkspace target={row.owner.target} />);
    await screen.findByText(row.sourceTitle);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Inbox" }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByText("Product decisions updated");
    expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() =>
      expect(api.requestsTo("PATCH", /\/read$/)[0]?.jsonBody).toEqual({
        read: true,
      }),
    );
    expect(
      api.requests.some((request) => request.pathname.includes("acknowledge")),
    ).toBe(false);
  });
  it("applies pause to the selected conversation and leaves failures visible", async () => {
    api.reply(
      "PATCH",
      "/api/projects/command-center/sessions/Notifications/conversations/conversation-1/subscriptions/subscription-1",
      {
        status: 409,
        json: { error: "Delivery has started; review the queue message." },
      },
    );
    renderWithQuery(
      <SubscriptionWorkspace
        target={row.owner.target}
        initialSelected={row.subscription.id}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Pause delivery" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Delivery has started",
    );
    expect(
      api.requestsTo("PATCH", /\/subscriptions\/subscription-1$/)[0]?.jsonBody,
    ).toEqual({ action: "pause" });
  });
});
