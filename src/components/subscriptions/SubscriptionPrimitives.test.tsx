// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import type { SubscriptionView } from "@/lib/subscriptions/controls-schemas";
import { SubscriptionRows } from "./SubscriptionPrimitives";
import { subscriptionFixture } from "./fixtures";
import { SubscriptionDetail } from "./SubscriptionDetail";

const at = "2026-10-01T12:00:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function expiredFiniteFollow(): SubscriptionView {
  const row = subscriptionFixture();
  return {
    ...row,
    subscription: {
      ...row.subscription,
      source: { kind: "validation", id: "completed-run" },
      expiresAt: at,
    },
    pendingCount: 0,
    wait: {
      id: "wait-1",
      subscriptionId: row.subscription.id,
      state: "cancelled",
      outcome: "source_terminal",
      expiresAt: at,
      deliveryId: "delivery-1",
      batchId: null,
      createdAt: row.subscription.createdAt,
      updatedAt: at,
      finishedAt: at,
      lastError: null,
    },
  };
}

function renderRow(row: SubscriptionView) {
  render(
    <SubscriptionRows items={[row]} selectedId={null} onSelect={() => {}} />,
  );
}

it("shows a consumed passive finite source with a cancelled wait as expired history", () => {
  renderRow(expiredFiniteFollow());
  expect(screen.getByText("Expired")).toBeInTheDocument();
  expect(screen.queryByText("Following")).not.toBeInTheDocument();
  expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
});

it("does not call a settled result delivered without a matching accepted batch", () => {
  const row = expiredFiniteFollow();
  if (!row.wait) throw Error("Missing wait fixture");
  row.wait = { ...row.wait, state: "settled", batchId: "cancelled-batch" };
  row.batch = {
    id: "cancelled-batch",
    state: "cancelled",
    createdAt: at,
    finishedAt: at,
    lastError: null,
  };
  renderRow(row);
  expect(screen.getByText("Expired")).toBeInTheDocument();
  expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
});

it("keeps delivered history when the settled wait has its accepted batch receipt", () => {
  const row = expiredFiniteFollow();
  if (!row.wait) throw Error("Missing wait fixture");
  row.wait = { ...row.wait, state: "settled", batchId: "accepted-batch" };
  row.batch = {
    id: "accepted-batch",
    state: "accepted",
    createdAt: at,
    finishedAt: at,
    lastError: null,
  };
  renderRow(row);
  expect(screen.getByText("Delivered")).toBeInTheDocument();
  expect(screen.queryByText("Expired")).not.toBeInTheDocument();
});

it("shows the follow expiry separately from a cancelled wait's later deadline", () => {
  const row = expiredFiniteFollow();
  if (!row.wait) throw Error("Missing wait fixture");
  const deadline = "2026-10-02T12:00:00.000Z";
  row.wait = { ...row.wait, expiresAt: deadline };
  renderWithQuery(
    <SubscriptionDetail row={row} onInbox={() => {}} onClose={() => {}} />,
  );
  expect(screen.getByText("Lifetime").nextElementSibling).toHaveTextContent(
    new Date(at).toLocaleString(),
  );
  expect(
    screen.getByText("Prior wait deadline").nextElementSibling,
  ).toHaveTextContent(new Date(deadline).toLocaleString());
});

it.each(["Paused", "Source missing"] as const)(
  "preserves %s over passive expiry",
  (label) => {
    const row = expiredFiniteFollow();
    row.subscription = {
      ...row.subscription,
      ...(label === "Paused" ? { pausedAt: at } : { missingAt: at }),
    };
    renderRow(row);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
  },
);

it("tells a follow that wakes its recipient apart from a passive one, in the list and the detail", () => {
  const base = subscriptionFixture();
  const waking: SubscriptionView = {
    ...base,
    subscription: { ...base.subscription, source: { kind: "run", id: "run-1" }, wakes: true },
  };
  renderRow(waking);
  expect(screen.getByText("Wakes")).toBeInTheDocument();
  expect(screen.queryByText("Passive")).not.toBeInTheDocument();
  cleanup();

  renderWithQuery(<SubscriptionDetail row={waking} onInbox={() => {}} onClose={() => {}} />);
  expect(screen.getByText("Delivery").nextElementSibling).toHaveTextContent(
    "Starts a turn at the next safe boundary for each new update.",
  );
});
