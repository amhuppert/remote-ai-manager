// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { SpecDetailView } from "@/lib/specs/queries";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecPostLaunchCapture from "./SpecPostLaunchCapture";

const WORKFLOW_EXECUTION_ID = "workflow-execution-1";

/**
 * A running spec execution always has a linked workflow lane, and the capture
 * action addresses it by that workflow execution id — never by the spec-side
 * row id, which is internal (design 3.5, decision D-B). The shared fixture
 * leaves the link null, so the running row is linked here.
 */
function runningDetail(): SpecDetailView {
  const detail = specControlsDetailFixture("running");
  return {
    ...detail,
    executions: detail.executions.map((execution) => ({
      ...execution,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
    })),
  };
}

describe("SpecPostLaunchCapture", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

  it("keeps post-launch discovery capture on Delivery without execution controls", async () => {
    api.json(
      "POST",
      "/api/specs/command-center/delivery-plan/actions/capture-scope-amendment",
      {
        discovery: {
          id: "discovery-1",
          executionId: "execution-1",
          workflowExecutionId: WORKFLOW_EXECUTION_ID,
          attemptId: "attempt-2",
          title: "Carry the edge forward",
        },
        restartRequired: false,
        replacement: null,
      },
    );
    renderWithQuery(
      <SpecPostLaunchCapture
        detail={runningDetail()}
        projectName="command-center"
      />,
    );

    const surface = screen.getByRole("region", { name: "Post-launch capture" });
    const discovery = within(surface).getByRole("region", {
      name: "Non-blocking discovery",
    });
    await userEvent.type(
      within(discovery).getByRole("textbox", { name: "Discovery title" }),
      "Carry the edge forward",
    );
    await userEvent.type(
      within(discovery).getByRole("textbox", {
        name: "Discovery instructions",
      }),
      "Include it in the next delivery delta.",
    );
    await userEvent.click(
      within(discovery).getByRole("button", { name: "Record discovery" }),
    );

    expect(
      api.requestsTo("POST", /capture-scope-amendment/)[0]?.jsonBody,
    ).toMatchObject({
      executionId: WORKFLOW_EXECUTION_ID,
      discoveredTask: { title: "Carry the edge forward" },
    });
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign off/i })).toBeNull();
  });

  it("renders nothing without a running execution", () => {
    const { container } = renderWithQuery(
      <SpecPostLaunchCapture
        detail={specControlsDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
