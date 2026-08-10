// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import SpecDeliveryPlanReview from "./SpecDeliveryPlanReview";
import { executionViewFixture } from "./SpecControls.fixtures";
import { reviewView } from "./delivery-plan-review.fixtures";

function renderReview(body: DeliveryPlanReviewView | "error"): {
  requested: string[];
} {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    return body === "error"
      ? Response.json(
          {
            error:
              "This spec has no delivery plan attempt. Open one with cctl spec plan open native-sdd.",
          },
          { status: 404 },
        )
      : Response.json(body);
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SpecDeliveryPlanReview projectName="command-center" slug="native-sdd" />
    </QueryClientProvider>,
  );
  return { requested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpecDeliveryPlanReview", () => {
  it("reads the attempt from the production review route", async () => {
    const { requested } = renderReview(reviewView());

    await waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    expect(requested[0]).toBe(
      "/api/specs/command-center/native-sdd/plan/review",
    );
  });

  it("renders a proposed attempt as a frozen candidate", async () => {
    renderReview(reviewView());

    expect(await screen.findByText("Proposed")).toBeVisible();
    expect(
      screen.getByText(/exact bytes a sign-off would approve/),
    ).toBeVisible();
  });

  it("renders an open draft as a preview that nothing has frozen", async () => {
    renderReview(
      reviewView({
        attempt: {
          status: "draft",
          proposedSnapshotId: null,
          planHash: null,
          compiledDefinitionHash: null,
          candidateId: null,
        },
      }),
    );

    expect(await screen.findByText("Open draft")).toBeVisible();
    expect(screen.getByText(/is not frozen/)).toBeVisible();
  });

  it("renders an approved attempt as the bytes a launch will run", async () => {
    renderReview(
      reviewView({
        attempt: { status: "approved" },
        approval: {
          candidateId: "candidate-2",
          planHash: "sha256:plan-2",
          compiledDefinitionHash: "sha256:compiled-2",
          snapshotId: "snapshot-2",
          approvedAt: "2026-08-08T10:00:00.000Z",
          approvedBy: { kind: "human" },
        },
      }),
    );

    expect(await screen.findByText("Approved")).toBeVisible();
    expect(
      screen.getByText(/A launch runs exactly this definition/),
    ).toBeVisible();
  });

  it("starts the approved candidate without sending a legacy scope", async () => {
    const user = userEvent.setup();
    const approved = reviewView({
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
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { deliveryProjection: _deliveryProjection, ...execution } =
      executionViewFixture({
        revisionId: "revision-7",
        revisionNumber: 7,
        state: "running",
      });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/actions/start-execution")) {
        return Response.json({
          execution,
          definition: createWorkflowDefinitionRecord({
            id: "workflow-definition-1",
          }),
          deliveryPlan: {
            attemptId: "attempt-dpa-1",
            candidateId: "candidate-2",
            planHash: "sha256:plan-2",
            compiledDefinitionHash: "sha256:compiled-2",
          },
        });
      }
      return Response.json(approved);
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SpecDeliveryPlanReview
          projectName="command-center"
          slug="native-sdd"
        />
      </QueryClientProvider>,
    );

    const sessionName = await screen.findByLabelText("Session name");
    const start = screen.getByRole("button", { name: "Start execution" });
    expect(start).toBeDisabled();
    await user.click(start);
    expect(
      requests.some((request) =>
        request.url.endsWith("/actions/start-execution"),
      ),
    ).toBe(false);

    await user.type(sessionName, "dpa-run");
    expect(start).toBeEnabled();
    await user.click(start);

    await waitFor(() => {
      expect(
        requests.some((request) =>
          request.url.endsWith("/actions/start-execution"),
        ),
      ).toBe(true);
    });
    const launch = requests.find((request) =>
      request.url.endsWith("/actions/start-execution"),
    );
    expect(launch?.url).toBe(
      "/api/specs/command-center/native-sdd/actions/start-execution",
    );
    expect(JSON.parse(String(launch?.init?.body))).toEqual({
      revisionId: "revision-7",
      sessionName: "dpa-run",
    });
    expect(
      await screen.findByText(/candidate-2.*sha256:compiled-2/),
    ).toBeVisible();
  });

  it("lays the contexts out in dependency waves with their owned-criterion counts", async () => {
    renderReview(reviewView());

    const graph = await screen.findByRole("region", { name: "Context graph" });
    expect(within(graph).getByText("Wave 1")).toBeVisible();
    expect(within(graph).getByText("Wave 2")).toBeVisible();
    expect(within(graph).getByText("2 owned criteria · 2 tasks")).toBeVisible();
    expect(
      within(graph).getByText("dpa-document → dpa-closeout"),
    ).toBeVisible();
  });

  it("shows each context's owned criteria in full, its contract, and its ordered tasks", async () => {
    renderReview(reviewView());

    await screen.findByRole("region", { name: "Contexts" });
    const card = document.querySelector<HTMLElement>(
      '[data-context-card="dpa-document"]',
    );
    expect(card).not.toBeNull();
    if (card === null) return;

    expect(
      within(card).getByText(
        "The attempt document round-trips through the repository.",
      ),
    ).toBeVisible();
    expect(
      within(card).getByText(
        "Plan lint refuses an undisposed criterion by handle.",
      ),
    ).toBeVisible();
    const tasks = within(card).getAllByText(
      /Persist the attempt|Refuse an undisposed criterion/,
    );
    expect(tasks.map((node) => node.textContent)).toEqual([
      "Persist the attempt",
      "Refuse an undisposed criterion",
    ]);
  });

  /**
   * A context that owns no criterion is only legal when it is typed
   * integration or closeout, so the type is what the surface has to make
   * unmissable — otherwise it reads as the unowned context plan lint refuses.
   */
  it("badges a criterion-less context with its declared type", async () => {
    renderReview(reviewView());

    await screen.findByRole("region", { name: "Contexts" });
    const card = document.querySelector<HTMLElement>(
      '[data-context-card="dpa-closeout"]',
    );
    expect(card).not.toBeNull();
    if (card === null) return;

    expect(within(card).getByText("closeout")).toBeVisible();
    expect(
      within(card).getByText(/owns no criterion; its acceptance contract/),
    ).toBeVisible();
  });

  it("names the opening act when the spec has no attempt", async () => {
    renderReview("error");

    expect(
      await screen.findByText(/cctl spec plan open native-sdd/),
    ).toBeVisible();
  });
});
