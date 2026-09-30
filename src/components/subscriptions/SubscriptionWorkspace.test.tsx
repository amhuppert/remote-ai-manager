// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { SubscriptionWorkspace } from "./SubscriptionWorkspace";
import { subscriptionFixture } from "./fixtures";
let api: FetchFixture;
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
  api.json("GET", "/api/subscriptions/inbox", {
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
  });
});
afterEach(() => {
  cleanup();
  api.restore();
  vi.unstubAllGlobals();
});
describe("subscription workspace", () => {
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
