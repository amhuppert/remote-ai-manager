// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { specKeys } from "@/lib/specs/query-keys";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { specControlsDetailFixture } from "./SpecControls.fixtures";
import {
  pendingReaffirmationReview,
  reviewView,
} from "./delivery-plan-review.fixtures";
import SpecDeliveryBridge from "./SpecDeliveryBridge";

describe("SpecDeliveryBridge", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

  it("reaffirms all pending criteria directly without requiring selection", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      pendingReaffirmationReview(),
    );
    api.pending("POST", /actions\/plan-reaffirm-batch/);
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Reaffirm all (2)" }),
    );

    expect(
      api.requestsTo("POST", /actions\/plan-reaffirm-batch/)[0]?.jsonBody,
    ).toEqual({
      expectedDraftRevision: 2,
      criterionElementIds: ["criterion-1", "criterion-2"],
    });
    expect(
      await screen.findByRole("button", { name: "Reaffirming all…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reaffirm selected" }),
    ).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox).toBeDisabled();
  });

  it.each([false, true])(
    "reaffirms large plans in revision-checked batches (later batch fails: %s)",
    async (fails) => {
      const review = pendingReaffirmationReview();
      review.criteria = Array.from({ length: 501 }, (_, index) => ({
        criterionElementId: `criterion-${index}`,
        handle: `R1.${index + 1}`,
        text: `Criterion ${index + 1}`,
        disposition: "pending_reaffirmation" as const,
        deliveredByExecutionId: "earlier-execution",
        accountabilitySourceIds: [],
      }));
      review.document.binding.dispositions = review.criteria.map(
        ({ criterionElementId, deliveredByExecutionId }) => ({
          criterionElementId,
          deliveredByExecutionId,
          disposition: "pending_reaffirmation",
        }),
      );
      api.json(
        "GET",
        "/api/specs/command-center/native-sdd/plan/review",
        review,
      );
      let batch = 0;
      api.reply("POST", /actions\/plan-reaffirm-batch/, () => {
        batch += 1;
        if (batch === 2 && fails)
          return {
            status: 409,
            json: { error: "The plan changed. Review the remaining criteria." },
          };
        review.attempt.draftRevision += 1;
        for (const rows of [
          review.criteria,
          review.document.binding.dispositions,
        ]) {
          for (const row of rows.slice((batch - 1) * 500, batch * 500))
            row.disposition = "reaffirmed";
        }
        return { json: structuredClone(review) };
      });
      renderWithQuery(
        <SpecDeliveryBridge
          detail={specControlsDetailFixture()}
          projectName="command-center"
        />,
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Reaffirm all (501)" }),
      );
      if (fails) {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The plan changed.",
        );
        expect(
          await screen.findByRole("button", { name: "Reaffirm all (1)" }),
        ).toBeEnabled();
        expect(screen.queryByRole("status")).toBeNull();
      } else {
        expect(await screen.findByRole("status")).toHaveTextContent(
          "All pending criteria reaffirmed.",
        );
        expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      }
      const requests = api.requestsTo("POST", /actions\/plan-reaffirm-batch/);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.jsonBody).toEqual({
        expectedDraftRevision: 2,
        criterionElementIds: review.criteria
          .slice(0, 500)
          .map((row) => row.criterionElementId),
      });
      expect(requests[1]?.jsonBody).toEqual({
        expectedDraftRevision: 3,
        criterionElementIds: ["criterion-500"],
      });
    },
  );

  it("reaffirms only selected pending criteria at the displayed revision and refreshes the blocker", async () => {
    const review = pendingReaffirmationReview();
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", review);
    api.reply("POST", /actions\/plan-reaffirm-batch/, () => {
      const updated = structuredClone(review);
      updated.attempt.draftRevision += 1;
      for (const row of [
        ...updated.criteria,
        ...updated.document.binding.dispositions,
      ]) {
        if (row.criterionElementId === "criterion-1")
          row.disposition = "reaffirmed";
      }
      api.json(
        "GET",
        "/api/specs/command-center/native-sdd/plan/review",
        updated,
      );
      return { json: updated };
    });
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Acceptance criteria need reaffirmation",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Reaffirm selected" }),
    ).toBeDisabled();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(
      screen.getByText(
        "A successful checkpoint preserves the conversation identity and transcript.",
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: /R1.1/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Reaffirm selected (1)" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: /R1.1/ })).toBeNull(),
    );
    expect(
      api.requestsTo("POST", /actions\/plan-reaffirm-batch/)[0]?.jsonBody,
    ).toEqual({
      expectedDraftRevision: 2,
      criterionElementIds: ["criterion-1"],
    });
    expect(screen.getByRole("checkbox", { name: /R1.2/ })).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Reaffirm selected" }),
    ).toBeDisabled();
  });

  it("supports selecting all pending criteria and shows progress while submitting", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      pendingReaffirmationReview(),
    );
    api.pending("POST", /actions\/plan-reaffirm-batch/);
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Select all pending (2)" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reaffirm selected (2)" }),
    );
    expect(
      await screen.findByRole("button", { name: /Reaffirming/ }),
    ).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox).toBeDisabled();
    expect(
      api.requestsTo("POST", /actions\/plan-reaffirm-batch/)[0]?.jsonBody,
    ).toEqual({
      expectedDraftRevision: 2,
      criterionElementIds: ["criterion-1", "criterion-2"],
    });
  });

  it("shows a refusal without claiming success or losing the selection", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      pendingReaffirmationReview(),
    );
    api.reply("POST", /actions\/plan-reaffirm-batch/, {
      status: 409,
      json: {
        error: "The delivery plan changed. Review the current criteria.",
      },
    });
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /R1.1/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reaffirm selected (1)" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The delivery plan changed.",
    );
    expect(screen.getByRole("checkbox", { name: /R1.1/ })).toBeChecked();
  });

  it.each(["revision", "attempt"])(
    "clears a selection when the displayed %s changes",
    async (change) => {
      const client = createTestQueryClient();
      const review = pendingReaffirmationReview();
      api.json(
        "GET",
        "/api/specs/command-center/native-sdd/plan/review",
        review,
      );
      renderWithQuery(
        <SpecDeliveryBridge
          detail={specControlsDetailFixture()}
          projectName="command-center"
        />,
        client,
      );
      await userEvent.click(
        await screen.findByRole("checkbox", { name: /R1.1/ }),
      );
      const updated = structuredClone(review);
      if (change === "revision") updated.attempt.draftRevision += 1;
      else updated.attempt.id = "replacement-attempt";
      act(() =>
        client.setQueryData(
          specKeys.planReview("command-center", "native-sdd"),
          updated,
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("checkbox", { name: /R1.1/ }),
        ).not.toBeChecked(),
      );
      expect(
        screen.getByRole("button", { name: "Reaffirm selected" }),
      ).toBeDisabled();
    },
  );

  it("clears the blocker after all criteria are reaffirmed without claiming execution is approved", async () => {
    const review = pendingReaffirmationReview();
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", review);
    api.reply("POST", /actions\/plan-reaffirm-batch/, () => {
      const updated = structuredClone(review);
      updated.attempt.draftRevision += 1;
      for (const row of [
        ...updated.criteria,
        ...updated.document.binding.dispositions,
      ]) {
        if (row.disposition === "pending_reaffirmation")
          row.disposition = "reaffirmed";
      }
      api.json(
        "GET",
        "/api/specs/command-center/native-sdd/plan/review",
        updated,
      );
      return { json: updated };
    });
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Select all pending (2)" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reaffirm selected (2)" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Plan approval is still required",
    );
    expect(
      screen.queryByRole("heading", {
        name: "Acceptance criteria need reaffirmation",
      }),
    ).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("keeps abandoned specifications read-only even with a pending draft plan", async () => {
    const detail = specControlsDetailFixture();
    detail.spec.abandonedAt = "2026-09-18T00:00:00.000Z";
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      pendingReaffirmationReview(),
    );
    renderWithQuery(
      <SpecDeliveryBridge detail={detail} projectName="command-center" />,
    );
    await screen.findByRole("heading", {
      name: "Acceptance criteria need reaffirmation",
    });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /Reaffirm selected/ }),
    ).toBeNull();
    expect(screen.getByText(/abandoned.*read-only/i)).toBeVisible();
  });

  it("does not offer reaffirmation outside an editable draft", async () => {
    const review = pendingReaffirmationReview();
    review.attempt.status = "approved";
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", review);
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );
    expect(
      await screen.findByText(/Reopen this plan as a draft/),
    ).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reaffirm selected/ }),
    ).toBeNull();
  });

  it("creates an eligible plan and navigates directly to its workflow definition", async () => {
    const navigate = vi.fn();
    const opened = reviewView({ attempt: { status: "draft" } });
    const { criteria: _criteria, comments: _comments, ...openedPlan } = opened;
    api.reply("GET", "/api/specs/command-center/native-sdd/plan/review", {
      status: 404,
      json: { error: "No delivery plan" },
    });
    api.json("POST", "/api/specs/command-center/native-sdd/actions/plan-open", {
      ...openedPlan,
      previousHealth: null,
      invalidatedApproval: null,
      executionStartAdmission: null,
    });
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
        onNavigate={navigate}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Create delivery plan" }),
    );

    expect(api.requestsTo("POST", /actions\/plan-open/)[0]?.jsonBody).toEqual(
      {},
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "/projects/command-center/workflows?definition=candidate-2",
      ),
    );
  });

  it("says a draft without blockers is ready for sign-off in Workflow Builder", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      reviewView(),
    );
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(await screen.findByText("Ready for sign-off")).toBeVisible();
    expect(screen.getByText(/sign it off in Workflow Builder/)).toBeVisible();
    expect(screen.queryByText(/in review/i)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open in Workflow Builder" }),
    ).toHaveAttribute(
      "href",
      "/projects/command-center/workflows?definition=candidate-2",
    );
  });

  it("does not call a draft with blocking findings ready for sign-off", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      reviewView({
        health: {
          total: 1,
          blocking: 1,
          counts: [{ severity: "blocks_propose", count: 1 }],
          findings: [
            {
              ruleId: "coverage/selected-criterion-uncovered",
              severity: "blocks_propose",
              elementHandle: "R1.1",
              message: "R1.1 is selected but no context claims it.",
            },
          ],
        },
      }),
    );
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(
      await screen.findByText(
        "Configure and review this plan in Workflow Builder.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Ready for sign-off")).toBeNull();
  });

  it("shows the advisory review verdict and a way to read the findings", async () => {
    const review = reviewView();
    review.reviewStatus = {
      state: "changes_requested",
      reviewerConversationId: "reviewer",
      reviewedAt: "2026-09-05T12:00:00.000Z",
    };
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", review);
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );
    expect(await screen.findByText("changes requested")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open in Workflow Builder" }),
    ).toBeVisible();
  });

  it("links an existing attempt to the exact managed definition without plan controls", async () => {
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      reviewView(),
    );
    renderWithQuery(
      <SpecDeliveryBridge
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Open in Workflow Builder" }),
    ).toHaveAttribute(
      "href",
      "/projects/command-center/workflows?definition=candidate-2",
    );
    expect(screen.queryByText(/workflow configuration/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign off/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
  });

  it("links a launched attempt to its exact session execution", async () => {
    const detail = specControlsDetailFixture("running");
    const execution = detail.executions[0];
    if (!execution) throw new Error("Expected the fixture execution");
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd/plan/review",
      reviewView({
        attempt: {
          status: "launched",
          launchedExecutionId: execution.id,
        },
      }),
    );
    renderWithQuery(
      <SpecDeliveryBridge detail={detail} projectName="command-center" />,
    );

    expect(
      await screen.findByRole("link", { name: "Open execution" }),
    ).toHaveAttribute(
      "href",
      `/projects/command-center/${execution.sessionName}/workflow?execution=${execution.id}`,
    );
  });
});
