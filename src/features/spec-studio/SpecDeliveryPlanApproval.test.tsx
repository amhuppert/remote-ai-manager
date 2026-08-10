// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";

import SpecDeliveryPlanApproval from "./SpecDeliveryPlanApproval";
import {
  reviewView,
  type ReviewViewOverrides,
} from "./delivery-plan-review.fixtures";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

const STALE_REFUSAL =
  "delivery plan attempt attempt-dpa-1 carries compiled definition hash sha256:compiled-3, not sha256:compiled-2. Nothing was approved. Re-read the candidate and sign off the bytes that exist now.";

function renderApproval(
  overrides: ReviewViewOverrides = {},
  respond: "ok" | "stale" = "ok",
): { calls: Recorded[]; review: DeliveryPlanReviewView } {
  const calls: Recorded[] = [];
  const review = reviewView(overrides);
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (respond === "stale") {
        return Response.json({ error: STALE_REFUSAL }, { status: 409 });
      }
      // The act answers with the plan mutation view — the plan view plus what
      // the write moved. The panel re-reads rather than rendering it, but the
      // response still has to parse.
      const { criteria: _criteria, comments: _comments, ...plan } = review;
      return Response.json({
        ...plan,
        previousHealth: null,
        invalidatedApproval: null,
        legacyImport: null,
        executionStartAdmission: null,
      });
    },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SpecDeliveryPlanApproval projectName="command-center" review={review} />
    </QueryClientProvider>,
  );
  return { calls, review };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpecDeliveryPlanApproval", () => {
  it("displays the exact candidate identity the act would bind", () => {
    renderApproval();

    const panel = screen.getByRole("region", { name: "Plan sign-off" });
    expect(within(panel).getByText("sha256:compiled-2")).toBeVisible();
    expect(within(panel).getByText("sha256:plan-2")).toBeVisible();
    expect(within(panel).getByText("candidate-2")).toBeVisible();
  });

  it("lists the selected-criterion count and the disposition summary", () => {
    renderApproval();

    const panel = screen.getByRole("region", { name: "Plan sign-off" });
    expect(within(panel).getByText("Selected criteria: 1")).toBeVisible();
    expect(within(panel).getByText("pending reaffirmation 1")).toBeVisible();
    expect(within(panel).getByText("delivered elsewhere 1")).toBeVisible();
  });

  it("posts the displayed candidate identity to the production sign-off route", async () => {
    const user = userEvent.setup();
    const { calls } = renderApproval();

    await user.click(
      screen.getByRole("button", { name: "Sign off this candidate" }),
    );

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      url: "/api/specs/command-center/native-sdd/actions/plan-sign-off",
      method: "POST",
      body: {
        candidateId: "candidate-2",
        planHash: "sha256:plan-2",
        compiledDefinitionHash: "sha256:compiled-2",
      },
    });
  });

  /**
   * The refusal is the whole point of binding the identity: a candidate that
   * moved under the panel must be named, old hash and new, rather than
   * silently approved.
   */
  it("shows the server refusal naming both hashes when the candidate moved", async () => {
    const user = userEvent.setup();
    renderApproval({}, "stale");

    await user.click(
      screen.getByRole("button", { name: "Sign off this candidate" }),
    );

    const message = await screen.findByText(/sha256:compiled-3/);
    expect(message).toBeVisible();
    expect(message.textContent).toContain("sha256:compiled-2");
  });

  it("offers nothing to approve while the attempt has frozen nothing", () => {
    renderApproval({
      attempt: {
        status: "draft",
        proposedSnapshotId: null,
        planHash: null,
        compiledDefinitionHash: null,
        candidateId: null,
      },
    });

    expect(screen.queryByRole("region", { name: "Plan sign-off" })).toBeNull();
  });

  it("says the bytes are approved once an approval binds them", () => {
    renderApproval({
      attempt: { status: "approved" },
      approval: {
        candidateId: "candidate-2",
        planHash: "sha256:plan-2",
        compiledDefinitionHash: "sha256:compiled-2",
        snapshotId: "snapshot-2",
        approvedAt: "2026-08-08T10:00:00.000Z",
        approvedBy: { kind: "human" },
      },
    });

    expect(screen.getByText(/This candidate is signed off/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  /**
   * After a reopen and a re-propose the stored approval names bytes that no
   * longer exist. Showing old against new is what tells a reviewer they are
   * approving something different this time.
   */
  it("shows the superseded approval's hash against the candidate now on offer", () => {
    renderApproval({
      approval: {
        candidateId: "candidate-1",
        planHash: "sha256:plan-1",
        compiledDefinitionHash: "sha256:compiled-1",
        snapshotId: "snapshot-1",
        approvedAt: "2026-08-08T08:00:00.000Z",
        approvedBy: { kind: "human" },
      },
    });

    const panel = screen.getByRole("region", { name: "Plan sign-off" });
    expect(within(panel).getByText("sha256:compiled-1")).toBeVisible();
    expect(within(panel).getByText("sha256:compiled-2")).toBeVisible();
    expect(
      within(panel).getByRole("button", { name: "Sign off this candidate" }),
    ).toBeVisible();
  });
});
