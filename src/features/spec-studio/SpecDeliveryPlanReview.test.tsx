// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";
import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import { specKeys } from "@/lib/specs/query-keys";

import { reviewView } from "./delivery-plan-review.fixtures";
import SpecDeliveryPlanReview, {
  SpecDeliveryPlanReviewContent,
} from "./SpecDeliveryPlanReview";

function finalizedPreview(): DeliveryPlanPreviewView {
  const launch = finalizeDeliveryPlanLaunch({
    specId: "spec-native-sdd",
    specSlug: "native-sdd",
    attemptId: "attempt-2",
    candidateId: "candidate-2",
    launch: createMaximalAuthoredWorkflowLaunchFixture(),
  });

  return {
    stage: "proposed",
    attemptId: "attempt-2",
    specSlug: "native-sdd",
    draftRevision: 2,
    pinnedRevisionId: "revision-2",
    candidateId: "candidate-2",
    candidateHash: "sha256:candidate-2",
    snapshotId: "snapshot-2",
    approvable: true,
    approvability: "Finalized candidate is ready for sign-off.",
    launch,
    binding: {
      dispositions: [],
      claims: [
        {
          contextId: "context-integrate",
          criterionElementIds: ["criterion-1"],
        },
      ],
    },
  };
}

function renderReview() {
  const preview = finalizedPreview();
  const review = reviewView({
    document: {
      schemaVersion: 2,
      launch: preview.launch,
      binding: preview.binding,
    },
    snapshots: [
      {
        id: "snapshot-1",
        draftRevision: 1,
        candidateId: "candidate-1",
        candidateHash: "sha256:candidate-1",
        proposedAt: "2026-08-13T00:00:00.000Z",
      },
      {
        id: "snapshot-2",
        draftRevision: 2,
        candidateId: "candidate-2",
        candidateHash: "sha256:candidate-2",
        proposedAt: "2026-08-14T00:00:00.000Z",
      },
    ],
    criteria: [
      {
        criterionElementId: "criterion-waived",
        handle: "R1",
        text: "A human may waive this criterion.",
        disposition: "waived",
        deliveredByExecutionId: null,
        accountabilitySourceIds: ["context-integrate"],
      },
      {
        criterionElementId: "criterion-reaffirm",
        handle: "R2",
        text: "A prior delivery needs an explicit reaffirmation.",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-previous",
        accountabilitySourceIds: ["context-integrate"],
      },
    ],
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    specKeys.planDiff("demo", "native-sdd", "snapshot-1", "snapshot-2"),
    {
      from: review.snapshots[0],
      to: review.snapshots[1],
      diff: { launchChanged: true, bindingChanged: false },
    },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <SpecDeliveryPlanReviewContent
        projectName="demo"
        preview={preview}
        review={review}
      />
    </QueryClientProvider>,
  );

  return preview;
}

/**
 * The race the panel must survive: a re-propose lands between the review read
 * and the preview read, so the graph on screen belongs to a candidate the
 * sign-off would not be approving.
 */
function renderMismatchedIdentity() {
  const preview = finalizedPreview();
  const review = reviewView({
    attempt: {
      candidateId: "candidate-3",
      candidateHash: "sha256:candidate-3",
      proposedSnapshotId: "snapshot-3",
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SpecDeliveryPlanReviewContent
        projectName="demo"
        preview={preview}
        review={review}
      />
    </QueryClientProvider>,
  );
}

function requestBody(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  if (typeof init !== "object" || init === null || !("body" in init)) {
    throw new Error("The request carried no body.");
  }
  const body = (init as { body: unknown }).body;
  if (typeof body !== "string") throw new Error("The body was not JSON text.");
  return JSON.parse(body);
}

function renderDraftWithPendingReaffirmation() {
  const launch = createMaximalAuthoredWorkflowLaunchFixture();
  const preview: DeliveryPlanPreviewView = {
    stage: "draft",
    attemptId: "attempt-2",
    specSlug: "native-sdd",
    draftRevision: 3,
    pinnedRevisionId: "revision-2",
    candidateId: null,
    candidateHash: null,
    snapshotId: null,
    approvable: false,
    approvability: "Drafts must be finalized before sign-off.",
    launch,
    binding: {
      dispositions: [],
      claims: [],
    },
  };
  const review = reviewView({
    attempt: {
      status: "draft",
      draftRevision: 3,
      proposedSnapshotId: null,
      candidateId: null,
      candidateHash: null,
    },
    criteria: [
      {
        criterionElementId: "criterion-pending",
        handle: "R2",
        text: "A stale external delivery needs a human confirmation.",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: "execution-previous",
        accountabilitySourceIds: ["context-integrate"],
      },
      {
        criterionElementId: "criterion-external",
        handle: "R3",
        text: "A current external delivery remains valid.",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-current",
        accountabilitySourceIds: ["context-integrate"],
      },
    ],
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SpecDeliveryPlanReviewContent
        projectName="demo"
        preview={preview}
        review={review}
      />
    </QueryClientProvider>,
  );
}

describe("SpecDeliveryPlanReview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the finalized ordinary graph beside the immutable spec binding", () => {
    const preview = renderReview();

    expect(screen.getByText("Finalized candidate")).toBeVisible();
    expect(screen.getByText("native-sdd-pinned-spec")).toBeVisible();
    expect(screen.getByText("native-sdd-claims")).toBeVisible();
    expect(
      screen.getByText(preview.launch.definition.origin!.sourceUri),
    ).toBeVisible();
    expect(screen.getByText("approvalRequired: false")).toBeVisible();
    expect(screen.getByText("Immutable delivery binding")).toBeVisible();
    expect(screen.getByText("Lifecycle state")).toBeVisible();
    expect(screen.getByText("Candidate change summary")).toBeVisible();
    expect(screen.getByText("Launch changed")).toBeVisible();
    expect(screen.getByText("Binding unchanged")).toBeVisible();
    expect(screen.getByText("Waivers")).toBeVisible();
    expect(screen.getByText("External delivery")).toBeVisible();
    expect(
      screen.getByText(/R2 is attributed to execution-previous/),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Binding comments" }),
    ).toBeVisible();
    expect(screen.getByTestId("workflow-definition-canvas")).toHaveAttribute(
      "data-workflow-id",
      preview.launch.layout.workflowId,
    );
  });

  it("reports sign-off as pending immediately", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));
    renderReview();

    fireEvent.click(
      screen.getByRole("button", { name: "Sign off this candidate" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/specs/demo/native-sdd/actions/plan-sign-off",
        expect.anything(),
      ),
    );

    expect(await screen.findByText("Recording sign-off…")).toBeVisible();
  });

  it("signs off the exact candidate its preview displayed", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));
    const preview = renderReview();

    fireEvent.click(
      screen.getByRole("button", { name: "Sign off this candidate" }),
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(requestBody(fetch.mock.calls[0])).toEqual({
      candidateId: preview.candidateId,
      candidateHash: preview.candidateHash,
    });
  });

  it("reads the launch preview for the draft revision it reviewed", async () => {
    const review = reviewView();
    const preview = finalizedPreview();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      const body = url.includes("plan-preview") ? preview : review;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SpecDeliveryPlanReview projectName="demo" slug="native-sdd" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        fetch.mock.calls.some((call) =>
          String(call[0]).includes(
            "plan-preview?stage=proposed&expectedDraftRevision=2",
          ),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Finalized candidate")).toBeVisible();
  });

  it("blocks sign-off when the preview and the review name different candidates", () => {
    renderMismatchedIdentity();

    expect(
      screen.queryByRole("button", { name: "Sign off this candidate" }),
    ).toBeNull();
    const conflict = screen.getByRole("region", {
      name: "Delivery plan conflict",
    });
    expect(conflict).toHaveTextContent("candidate-3");
    expect(conflict).toHaveTextContent("candidate-2");
    expect(
      screen.getByRole("button", { name: "Re-read the delivery plan" }),
    ).toBeVisible();
  });

  it("keeps current external delivery separate from a pending human reaffirmation", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));
    renderDraftWithPendingReaffirmation();

    expect(screen.getByText("External delivery")).toBeVisible();
    expect(
      screen.getByText(/R3 is attributed to execution-current/),
    ).toBeVisible();
    expect(screen.getByText("Pending reaffirmation")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reaffirm R2" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/specs/demo/native-sdd/actions/plan-reaffirm",
        expect.anything(),
      ),
    );
    // The reaffirmation is a judgment about the draft the human read, so it
    // states that draft revision and refuses if the draft moved.
    expect(requestBody(fetch.mock.calls[0])).toEqual({
      criterionElementId: "criterion-pending",
      expectedDraftRevision: 3,
    });
    expect(await screen.findByText("Reaffirming R2…")).toBeVisible();
  });
});
