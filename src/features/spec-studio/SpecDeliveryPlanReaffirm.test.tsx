// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryPlanReviewCriterion } from "@/lib/specs/delivery-plan-review";

import { ReaffirmControl } from "./SpecDeliveryPlanReaffirm";
import { reviewView } from "./delivery-plan-review.fixtures";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function softStale(
  overrides: Partial<DeliveryPlanReviewCriterion> = {},
): DeliveryPlanReviewCriterion {
  const base = reviewView().criteria[0];
  if (base === undefined) throw new Error("fixture lost its criteria");
  return { ...base, ...overrides };
}

function renderControl(
  criterion: DeliveryPlanReviewCriterion,
  respond: "ok" | "refused" = "ok",
): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return respond === "ok"
        ? Response.json(reviewView())
        : Response.json(
            {
              error:
                "Reaffirming a soft-stale criterion is a human judgment. A human reaffirms it in Spec Studio.",
            },
            { status: 403 },
          );
    },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReaffirmControl
        projectName="command-center"
        slug="native-sdd"
        criterion={criterion}
      />
    </QueryClientProvider>,
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReaffirmControl", () => {
  it("offers the act on a soft-stale criterion still pending", () => {
    renderControl(softStale());

    expect(screen.getByRole("button", { name: "Reaffirm R2.1" })).toBeVisible();
  });

  it("posts to the production reaffirm route naming the criterion", async () => {
    const user = userEvent.setup();
    const { calls } = renderControl(softStale());

    await user.click(screen.getByRole("button", { name: "Reaffirm R2.1" }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      url: "/api/specs/command-center/native-sdd/actions/plan-reaffirm",
      method: "POST",
      body: { criterionElementId: "c-soft" },
    });
  });

  /**
   * The surface never offers an act the server would refuse: a criterion that
   * is already settled, or one whose class forbids reaffirmation, has no
   * control at all.
   */
  it("offers nothing on a criterion that is not pending reaffirmation", () => {
    renderControl(
      softStale({
        disposition: "reaffirmed",
        effectiveDisposition: "reaffirmed",
      }),
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers nothing on a hard-stale criterion", () => {
    renderControl(
      softStale({
        deliveryClass: "hard_stale",
        disposition: "selected",
        effectiveDisposition: "selected",
      }),
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  /**
   * A reaffirmation whose basis moved reads as pending again, so the act is
   * offered a second time — and the surface says why it came back.
   */
  it("re-offers the act and explains why when the judged basis moved", () => {
    renderControl(
      softStale({
        disposition: "reaffirmed",
        effectiveDisposition: "pending_reaffirmation",
      }),
    );

    expect(screen.getByRole("button", { name: "Reaffirm R2.1" })).toBeVisible();
    expect(
      screen.getByText(/judged a basis that has since moved/),
    ).toBeVisible();
  });

  it("shows the server's refusal, which names where the act is performed", async () => {
    const user = userEvent.setup();
    renderControl(softStale(), "refused");

    await user.click(screen.getByRole("button", { name: "Reaffirm R2.1" }));

    expect(
      await screen.findByText(/human reaffirms it in Spec Studio/),
    ).toBeVisible();
  });
});
