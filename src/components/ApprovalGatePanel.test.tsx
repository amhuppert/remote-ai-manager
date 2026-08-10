// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionDiff } from "@/lib/git/schemas";
import ApprovalGatePanel, {
  type ApprovalScopedChanges,
} from "./ApprovalGatePanel";

describe("ApprovalGatePanel", () => {
  const defaultProps = {
    contextTitle: "Implement auth flow",
    workflowName: "release-hardening",
    requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    isSubmitting: false,
    conversationBusy: false,
    executionSuspended: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };

  // =========================================================================
  // Rendering (Req 3.5)
  // =========================================================================

  it("renders Approve and Reject actions with context title and workflow name (Req 3.5)", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByText("Implement auth flow")).toBeInTheDocument();
    expect(screen.getByText("release-hardening")).toBeInTheDocument();
  });

  it("renders without context title and workflow name when null", () => {
    render(
      <ApprovalGatePanel
        {...defaultProps}
        contextTitle={null}
        workflowName={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  // =========================================================================
  // Approve (Req 3.5)
  // =========================================================================

  it("calls onApprove when Approve clicked", () => {
    const onApprove = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Reject flow (Req 5.1)
  // =========================================================================

  it("does not show the rejection textarea until Reject is clicked", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("expands a message textarea when Reject is clicked", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(
      screen.getByRole("textbox", { name: "Rejection feedback" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit rejection" }),
    ).toBeInTheDocument();
  });

  it("disables reject submit until the trimmed message is non-empty (Req 5.1)", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    const submit = screen.getByRole("button", { name: "Submit rejection" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "   " },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Missing error handling in the merge step" },
    });
    expect(submit).toBeEnabled();
  });

  it("calls onReject with the trimmed message on submit (Req 5.1)", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Fix the failing tests  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit rejection" }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith("Fix the failing tests");
  });

  it("collapses the reject flow on Cancel and restores Approve/Reject", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  // =========================================================================
  // Wait-time readout
  // =========================================================================

  it("shows how long the gate has been waiting, derived from requestedAt", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(screen.getByText("waiting 4m")).toBeInTheDocument();
  });

  it("hides the wait readout when requestedAt is not a valid date", () => {
    render(<ApprovalGatePanel {...defaultProps} requestedAt="not-a-date" />);
    expect(screen.queryByText(/^waiting /)).not.toBeInTheDocument();
  });

  // =========================================================================
  // Keyboard affordances in the reject editor
  // =========================================================================

  it("shows the keyboard hint in the reject action row", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByText("⌘↵ submit · esc cancel")).toBeInTheDocument();
  });

  it("submits the rejection on Ctrl+Enter when the message is non-empty", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "  Tighten the tests " } });
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
    expect(onReject).toHaveBeenCalledWith("Tighten the tests");
  });

  it("does not submit on Cmd+Enter while the message is empty", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      metaKey: true,
    });
    expect(onReject).not.toHaveBeenCalled();
  });

  it("cancels the reject flow on Escape", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  // =========================================================================
  // Busy / submitting disabling (Req 3.5)
  // =========================================================================

  it("disables actions and shows a hint while a chat turn is in flight", () => {
    render(<ApprovalGatePanel {...defaultProps} conversationBusy />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(
      screen.getByText(
        "Chat turn in progress — actions re-enable when it completes.",
      ),
    ).toBeInTheDocument();
  });

  it("disables actions while submitting", () => {
    render(<ApprovalGatePanel {...defaultProps} isSubmitting />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByText("Submitting decision…")).toBeInTheDocument();
  });

  it("disables reject submit while a chat turn is in flight even with a message", () => {
    const { rerender } = render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Needs more tests" },
    });
    rerender(<ApprovalGatePanel {...defaultProps} conversationBusy />);
    expect(
      screen.getByRole("button", { name: "Submit rejection" }),
    ).toBeDisabled();
  });

  // =========================================================================
  // Suspended execution (Req 3.5)
  // =========================================================================

  it("keeps actions enabled and shows an applies-on-resume hint when execution is suspended", () => {
    render(<ApprovalGatePanel {...defaultProps} executionSuspended />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(
      screen.getByText(
        "Execution suspended — the decision applies when the workflow resumes.",
      ),
    ).toBeInTheDocument();
  });

  it("does not show the suspended hint when execution is not suspended", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(
      screen.queryByText(
        "Execution suspended — the decision applies when the workflow resumes.",
      ),
    ).not.toBeInTheDocument();
  });
});

describe("ApprovalGatePanel scoped change set (R15.2)", () => {
  const SCOPED_DIFF: SessionDiff = {
    files: [
      {
        filePath: "src/api/handler.ts",
        additions: 2,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,2 +1,3 @@",
            lines: [
              { type: "hunk-header", content: "@@ -1,2 +1,3 @@" },
              { type: "remove", content: "export const handler = 1;" },
              { type: "add", content: "export const handler = 2;" },
            ],
          },
        ],
      },
    ],
    totalAdditions: 2,
    totalDeletions: 1,
  };

  function renderPanel(scopedChanges: ApprovalScopedChanges | null) {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalGatePanel
        contextTitle="Implement"
        workflowName="release-hardening"
        requestedAt={new Date(Date.now() - 60_000).toISOString()}
        isSubmitting={false}
        conversationBusy={false}
        executionSuspended={false}
        scopedChanges={scopedChanges}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    return { onApprove, onReject };
  }

  it("renders the frozen owned-path change set for an enveloped context", () => {
    renderPanel({
      status: "ready",
      ownedPaths: ["src/api"],
      diff: SCOPED_DIFF,
    });

    const changes = screen.getByTestId("approval-gate-scoped-changes");
    expect(changes).toHaveTextContent("src/api/handler.ts");
    expect(changes).toHaveTextContent("+2");
    expect(changes).toHaveTextContent("-1");
    // The ownership the artifact was frozen under, so a reviewer can tell a
    // scoped change set from an incomplete one.
    expect(changes).toHaveTextContent("owned: src/api");
    expect(changes).toHaveTextContent("export const handler = 2;");
  });

  it("renders nothing extra for a full-access member on the whole-tree view", () => {
    renderPanel(null);

    expect(
      screen.queryByTestId("approval-gate-scoped-changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("states that an enveloped context changed nothing it owns", () => {
    renderPanel({
      status: "ready",
      ownedPaths: ["src/api"],
      diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
    });

    expect(
      screen.getByTestId("approval-gate-scoped-changes"),
    ).toHaveTextContent(/no changes inside the paths this context owns/i);
  });

  it("refuses to render a change set that is no longer the frozen candidate", () => {
    renderPanel({ status: "drifted" });

    const changes = screen.getByTestId("approval-gate-scoped-changes");
    expect(changes).toHaveTextContent(/have changed since it entered review/i);
    expect(changes).not.toHaveTextContent("src/api/handler.ts");
  });

  it("reports an unavailable artifact rather than an empty change set", () => {
    renderPanel({
      status: "unavailable",
      reason: "the candidate tree could not be read",
    });

    expect(
      screen.getByTestId("approval-gate-scoped-changes"),
    ).toHaveTextContent("the candidate tree could not be read");
  });

  // Approving is a decision ABOUT the frozen artifact, so it stays unavailable
  // until that artifact is actually on screen. Rejecting never is: it is the
  // documented way out of drift, and it risks nothing.
  it.each([
    ["loading", { status: "loading" as const }],
    ["drifted", { status: "drifted" as const }],
    [
      "unavailable",
      { status: "unavailable" as const, reason: "could not be read" },
    ],
  ])(
    "disables Approve while the frozen artifact is %s, keeping Reject available",
    (_label, scopedChanges) => {
      renderPanel(scopedChanges);

      expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    },
  );

  it("enables Approve once the frozen artifact is rendered", () => {
    renderPanel({
      status: "ready",
      ownedPaths: ["src/api"],
      diff: SCOPED_DIFF,
    });

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("keeps approve and reject working alongside the scoped change set", () => {
    const { onApprove, onReject } = renderPanel({
      status: "ready",
      ownedPaths: ["src/api"],
      diff: SCOPED_DIFF,
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "needs more tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit rejection" }));
    expect(onReject).toHaveBeenCalledWith("needs more tests");
  });
});
