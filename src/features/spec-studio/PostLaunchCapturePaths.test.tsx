// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import PostLaunchCapturePaths from "./PostLaunchCapturePaths";

const baseProps = {
  projectName: "command-center",
  slug: "native-sdd",
  executionId: "execution-1",
  state: "running" as const,
  capturePending: false,
  captureOutcomePath: null,
  captureReceipt: null,
  captureFailure: null,
  onCapture: vi.fn(),
};

describe("PostLaunchCapturePaths", () => {
  it("presents the non-mutating post-launch paths as one operator surface", () => {
    render(<PostLaunchCapturePaths {...baseProps} />);

    const surface = screen.getByRole("region", { name: "Post-launch capture" });
    expect(surface).toHaveAttribute("data-layout", "capture-paths");
    expect(
      within(surface).getByRole("region", { name: "Non-blocking discovery" }),
    ).toBeVisible();
    expect(
      within(surface).getByRole("region", { name: "Blocking replan" }),
    ).toBeVisible();
  });

  it("records a non-blocking discovery through the capture callback", async () => {
    const onCapture = vi.fn();
    const user = userEvent.setup();
    render(<PostLaunchCapturePaths {...baseProps} onCapture={onCapture} />);

    const card = screen.getByRole("region", {
      name: "Non-blocking discovery",
    });
    await user.type(
      within(card).getByRole("textbox", { name: "Discovery title" }),
      "Document the migration edge",
    );
    await user.type(
      within(card).getByRole("textbox", { name: "Discovery instructions" }),
      "Carry the edge into the next attempt.",
    );
    await user.click(
      within(card).getByRole("button", { name: "Record discovery" }),
    );

    expect(onCapture).toHaveBeenCalledWith("discovery", {
      executionId: "execution-1",
      discoveredTask: {
        title: "Document the migration edge",
        instructions: "Carry the edge into the next attempt.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
    });
  });

  it("confirms blocking replan by naming the exact execution before calling the coordinator path", async () => {
    const onCapture = vi.fn();
    const user = userEvent.setup();
    render(<PostLaunchCapturePaths {...baseProps} onCapture={onCapture} />);

    const card = screen.getByRole("region", { name: "Blocking replan" });
    await user.type(
      within(card).getByRole("textbox", { name: "Replan task title" }),
      "Replace the migration order",
    );
    await user.type(
      within(card).getByRole("textbox", { name: "Replan task instructions" }),
      "Seed the replacement attempt with the corrected order.",
    );
    await user.type(
      within(card).getByRole("textbox", { name: "Blocking reason" }),
      "The current dependency order cannot complete.",
    );
    await user.click(
      within(card).getByRole("button", { name: "Replan execution" }),
    );

    expect(onCapture).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", {
      name: "Abandon execution execution-1?",
    });
    expect(
      within(dialog).getByText(/execution-1 is abandoned before/),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Abandon execution-1 and open seeded plan",
      }),
    );

    expect(onCapture).toHaveBeenCalledWith("replan", {
      executionId: "execution-1",
      discoveredTask: {
        title: "Replace the migration order",
        instructions: "Seed the replacement attempt with the corrected order.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      blockingReason: "The current dependency order cannot complete.",
    });
  });

  it("shows durable discovery and blocking replacement receipts from the server", () => {
    const { rerender } = render(
      <PostLaunchCapturePaths
        {...baseProps}
        captureOutcomePath="discovery"
        captureReceipt={{
          discovery: {
            id: "discovery-7",
            executionId: "execution-1",
            attemptId: "attempt-3",
            title: "Document the migration edge",
          },
          restartRequired: false,
          replacement: null,
        }}
      />,
    );

    expect(screen.getByText("Durable discovery recorded")).toBeVisible();
    expect(screen.getByText(/discovery-7/)).toBeVisible();
    expect(screen.getByText(/attempt-3/)).toBeVisible();

    rerender(
      <PostLaunchCapturePaths
        {...baseProps}
        captureOutcomePath="replan"
        captureReceipt={{
          discovery: {
            id: "discovery-8",
            executionId: "execution-1",
            attemptId: "attempt-3",
            title: "Replace the migration order",
          },
          restartRequired: true,
          replacement: {
            abandonedExecutionId: "execution-1",
            replacementAttemptId: "attempt-4",
          },
        }}
      />,
    );

    expect(screen.getByText("Seeded replacement opened")).toBeVisible();
    expect(screen.getByText(/abandoned execution-1/)).toBeVisible();
    expect(screen.getByText(/new attempt-4/)).toBeVisible();
  });

  it("renders production refusals and exact remedies inline", () => {
    render(
      <PostLaunchCapturePaths
        {...baseProps}
        state="unlaunched"
        captureOutcomePath="discovery"
        captureFailure={{
          message:
            "Delivery plan attempt attempt-3 is approved and has launched no execution.",
          instruction:
            "Nothing was captured. Add the discovered work to the plan itself with `cctl spec plan reopen native-sdd --reason <why>`.",
        }}
      />,
    );

    expect(
      screen.getByText(/attempt-3 is approved and has launched no execution/),
    ).toBeVisible();
    expect(screen.getByText(/cctl spec plan reopen native-sdd/)).toBeVisible();
    expect(
      within(
        screen.getByRole("region", { name: "Non-blocking discovery" }),
      ).getByRole("link", { name: "Open delivery plan" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?view=plan");
  });
});
