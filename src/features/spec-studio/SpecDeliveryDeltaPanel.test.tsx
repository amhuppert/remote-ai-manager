// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryDeltaProjection } from "@/lib/specs/delivery-delta";

import userEvent from "@testing-library/user-event";
import { specElementReaderDetailFixture } from "./SpecElementReader.fixtures";

import SpecDeliveryDeltaPanel from "./SpecDeliveryDeltaPanel";

function projection(
  overrides: Partial<DeliveryDeltaProjection> = {},
): DeliveryDeltaProjection {
  return {
    specSlug: "native-sdd",
    current: { revisionId: "rev-3", revisionNumber: 3 },
    base: { revisionId: "rev-2", revisionNumber: 2 },
    comparedExecution: {
      executionId: "exec-new",
      workflowExecutionId: "workflow-exec-new",
      revisionId: "rev-2",
      state: "delivered",
      deliveredAt: "2026-08-04T00:00:00.000Z",
    },
    elements: [
      {
        elementId: "req-1",
        kind: "requirement",
        handle: "R1",
        class: "amended",
        baseHash: "req-1-h1",
        currentHash: "req-1-h2",
      },
    ],
    criteria: [
      {
        criterionElementId: "crit-1",
        handle: "R1.1",
        class: "hard_stale",
        priorDisposition: "in_scope",
        freshness: {
          grade: "hard_stale",
          basis: [
            {
              elementId: "crit-1",
              kind: "criterion",
              handle: "R1.1",
              reason: "criterion_text",
              baseHash: "c1",
              currentHash: "c2",
            },
          ],
        },
      },
    ],
    advisories: [
      {
        criterionElementId: "crit-1",
        handle: "R1.1",
        code: "delivered_elsewhere_refused",
        freshness: "hard_stale",
        priorDisposition: "in_scope",
        message:
          "R1.1 changed since the delivery that proved it, so re-prove it.",
      },
    ],
    counts: {
      elements: { added: 0, amended: 1, unchanged: 0, removed: 0 },
      criteria: {
        delivered_and_fresh: 0,
        soft_stale: 0,
        hard_stale: 1,
        never_delivered: 0,
        deferred: 0,
        waived: 0,
      },
    },
    ...overrides,
  };
}

function renderPanel(body: DeliveryDeltaProjection | "error"): {
  requested: string[];
} {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    return body === "error"
      ? Response.json({ error: "boom" }, { status: 500 })
      : Response.json(body);
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SpecDeliveryDeltaPanel
        detail={specElementReaderDetailFixture()}
        projectName="command-center"
        slug="native-sdd"
      />
    </QueryClientProvider>,
  );
  return { requested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpecDeliveryDeltaPanel", () => {
  it("reads the projection from the production delta route", async () => {
    const { requested } = renderPanel(projection());

    await waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    expect(requested[0]).toBe("/api/specs/command-center/native-sdd/delta");
  });

  it("shows the delivery baseline and readable server classifications", async () => {
    renderPanel(projection());

    expect(
      await screen.findByText(/Compared with delivered revision 2/),
    ).toBeVisible();
    expect(screen.getByText("Needs revalidation")).toBeVisible();
    expect(screen.getByText("Delivered & fresh")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /Spec changes/ }));
    expect(screen.getByText("Amended")).toBeVisible();
  });

  it("surfaces the carry-forward advisory with its remedy", async () => {
    renderPanel(projection());

    await userEvent.click(await screen.findByText(/Carry-forward advisories/));
    expect(
      await screen.findByText(
        "R1.1 changed since the delivery that proved it, so re-prove it.",
      ),
    ).toBeVisible();
  });

  it("says plainly when nothing has delivered yet", async () => {
    renderPanel(
      projection({ base: null, comparedExecution: null, advisories: [] }),
    );

    expect(await screen.findByText(/No delivered execution yet/)).toBeVisible();
  });

  it("offers retry when the projection cannot be read", async () => {
    renderPanel("error");

    expect(
      await screen.findByText(/The delivery delta could not be read/),
    ).toBeVisible();
  });
});
