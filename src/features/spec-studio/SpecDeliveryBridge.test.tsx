// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { specControlsDetailFixture } from "./SpecControls.fixtures";
import { reviewView } from "./delivery-plan-review.fixtures";
import SpecDeliveryBridge from "./SpecDeliveryBridge";

describe("SpecDeliveryBridge", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

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
    expect(
      await screen.findByText(/Plan review: changes requested/),
    ).toBeVisible();
    expect(
      screen.getByText("cctl workflow review --file <plan.json>"),
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
