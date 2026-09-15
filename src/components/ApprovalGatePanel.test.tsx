// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionDiff } from "@/lib/git/schemas";
import ApprovalGatePanel, {
  type ApprovalScopedChanges,
} from "./ApprovalGatePanel";

function feedbackBox(): HTMLElement {
  return screen.getByRole("textbox", { name: "Rejection feedback" });
}

describe("ApprovalGatePanel", () => {
  const defaultProps = {
    contextTitle: "Implement auth flow",
    workflowName: "release-hardening",
    requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    isSubmitting: false,
    conversationBusy: false,
    executionSuspended: false,
    // Every parked gate resolves a candidate state; the whole-tree one is the
    // minimum a production host can hand this panel.
    scopedChanges: {
      status: "ready",
      candidate: {
        scope: "whole_tree",
        diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
      },
    } satisfies ApprovalScopedChanges,
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };

  // =========================================================================
  // The card (E2 · README §10)
  // =========================================================================

  it("names the context approval and the iteration its candidate belongs to", () => {
    render(<ApprovalGatePanel {...defaultProps} iteration={2} />);

    expect(
      screen.getByText("Context approval — Implement auth flow"),
    ).toBeInTheDocument();
    expect(screen.getByText("iteration 2")).toBeInTheDocument();
    expect(screen.getByText(/release-hardening/)).toBeInTheDocument();
  });

  it("states that approval continues orchestration rather than landing the lane", () => {
    render(<ApprovalGatePanel {...defaultProps} />);

    const panel = screen.getByTestId("approval-gate-panel");
    expect(panel).toHaveTextContent(
      "You are reviewing the candidate frozen for this gate. Approving lets orchestration continue; it does not land the lane or publish it.",
    );
    expect(panel).toHaveTextContent(
      "Sibling contexts keep running — nothing here pauses the run.",
    );
    expect(panel).toHaveTextContent("rejection reruns validators");
  });

  it("renders Approve and Reject actions with context title and workflow name (Req 3.5)", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reject — needs feedback" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Implement auth flow/)).toBeInTheDocument();
    expect(screen.getByText(/release-hardening/)).toBeInTheDocument();
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
    expect(screen.getByText("Context approval")).toBeInTheDocument();
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

  it("offers the rejection feedback field up front, naming who receives it", () => {
    render(<ApprovalGatePanel {...defaultProps} />);

    expect(feedbackBox()).toHaveAttribute(
      "placeholder",
      "Required to reject — returned to the implementer",
    );
  });

  it("keeps Reject disabled until the trimmed feedback is non-empty (Req 5.1)", () => {
    render(<ApprovalGatePanel {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: "Reject — needs feedback" }),
    ).toBeDisabled();

    fireEvent.change(feedbackBox(), { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: "Reject — needs feedback" }),
    ).toBeDisabled();

    fireEvent.change(feedbackBox(), {
      target: { value: "Missing error handling in the merge step" },
    });
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("calls onReject with the trimmed message (Req 5.1)", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.change(feedbackBox(), {
      target: { value: "  Fix the failing tests  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith("Fix the failing tests");
  });

  it("clears an abandoned draft on Escape", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.change(feedbackBox(), { target: { value: "draft" } });
    fireEvent.keyDown(feedbackBox(), { key: "Escape" });

    expect(feedbackBox()).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Reject — needs feedback" }),
    ).toBeDisabled();
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

  it("shows the keyboard hint beside the decision", () => {
    render(<ApprovalGatePanel {...defaultProps} />);
    expect(screen.getByText("⌘↵ reject · esc clear")).toBeInTheDocument();
  });

  it("submits the rejection on Ctrl+Enter when the message is non-empty", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.change(feedbackBox(), {
      target: { value: "  Tighten the tests " },
    });
    fireEvent.keyDown(feedbackBox(), { key: "Enter", ctrlKey: true });
    expect(onReject).toHaveBeenCalledWith("Tighten the tests");
  });

  it("does not submit on Cmd+Enter while the message is empty", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.keyDown(feedbackBox(), { key: "Enter", metaKey: true });
    expect(onReject).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Busy / submitting disabling (Req 3.5)
  // =========================================================================

  it("disables actions and shows a hint while a chat turn is in flight", () => {
    render(<ApprovalGatePanel {...defaultProps} conversationBusy />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject/ })).toBeDisabled();
    expect(
      screen.getByText(
        "Chat turn in progress — actions re-enable when it completes.",
      ),
    ).toBeInTheDocument();
  });

  it("disables actions while submitting", () => {
    render(<ApprovalGatePanel {...defaultProps} isSubmitting />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject/ })).toBeDisabled();
    expect(screen.getByText("Submitting decision…")).toBeInTheDocument();
  });

  it("disables reject while a chat turn is in flight even with feedback", () => {
    const { rerender } = render(<ApprovalGatePanel {...defaultProps} />);
    fireEvent.change(feedbackBox(), { target: { value: "Needs more tests" } });
    rerender(<ApprovalGatePanel {...defaultProps} conversationBusy />);
    expect(screen.getByRole("button", { name: /^Reject/ })).toBeDisabled();
  });

  // =========================================================================
  // Suspended execution (Req 3.5)
  // =========================================================================

  it("keeps actions enabled and shows an applies-on-resume hint when execution is suspended", () => {
    render(<ApprovalGatePanel {...defaultProps} executionSuspended />);
    fireEvent.change(feedbackBox(), { target: { value: "send it back" } });
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

describe("ApprovalGatePanel candidate states (E2 · R15.2)", () => {
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

  it("summarises a ready candidate by files, lines and the paths it is scoped to", () => {
    renderPanel({
      status: "ready",
      candidate: {
        scope: "owned",
        ownedPaths: ["src/api", "src/risk"],
        diff: SCOPED_DIFF,
      },
    });

    const state = screen.getByTestId("approval-candidate-state");
    expect(state).toHaveTextContent("Candidate ready");
    expect(state).toHaveTextContent(
      "1 file · +2 −1 · scoped to src/api, src/risk",
    );
  });

  it("renders the frozen owned-path change set for an enveloped context", () => {
    renderPanel({
      status: "ready",
      candidate: { scope: "owned", ownedPaths: ["src/api"], diff: SCOPED_DIFF },
    });

    const changes = screen.getByTestId("approval-gate-scoped-changes");
    expect(changes).toHaveTextContent("src/api/handler.ts");
    expect(changes).toHaveTextContent("+2");
    expect(changes).toHaveTextContent("-1");
    expect(changes).toHaveTextContent("export const handler = 2;");
  });

  it("renders the frozen baseline-relative patch for a full-access member", () => {
    renderPanel({
      status: "ready",
      candidate: { scope: "whole_tree", diff: SCOPED_DIFF },
    });
    const state = screen.getByTestId("approval-candidate-state");
    expect(state).toHaveAttribute("data-candidate-status", "ready");
    expect(state).toHaveTextContent("Candidate ready");
    expect(state).toHaveTextContent("whole lane worktree");
    const changes = screen.getByTestId("approval-gate-scoped-changes");
    expect(changes).toHaveTextContent("src/api/handler.ts");
    expect(changes).toHaveTextContent("export const handler = 2;");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  // The panel is the last line of defence: a host that wires no candidate
  // resolution at all must not thereby hand out a blind Approve.
  it("withholds Approve when no candidate state was resolved", () => {
    renderPanel(null);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject/ })).toBeInTheDocument();
  });

  it("states that an enveloped context changed nothing it owns", () => {
    renderPanel({
      status: "ready",
      candidate: {
        scope: "owned",
        ownedPaths: ["src/api"],
        diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
      },
    });

    expect(
      screen.getByTestId("approval-gate-scoped-changes"),
    ).toHaveTextContent(/no changes inside the paths this context owns/i);
  });

  it("says the candidate is still loading and holds Approve back", () => {
    renderPanel({ status: "loading" });

    const state = screen.getByTestId("approval-candidate-state");
    expect(state).toHaveTextContent("Loading the candidate…");
    expect(state).toHaveTextContent("Approve disabled");
  });

  it("names drift as the tree moving since the freeze", () => {
    renderPanel({ status: "drifted" });

    const state = screen.getByTestId("approval-candidate-state");
    expect(state).toHaveTextContent(
      "Drifted — the tree moved since the freeze",
    );
    expect(state).toHaveTextContent("Approve disabled · Reject available");
    expect(
      screen.queryByTestId("approval-gate-scoped-changes"),
    ).not.toBeInTheDocument();
  });

  it("reports an unavailable candidate and points at the way out", () => {
    renderPanel({
      status: "unavailable",
      reason: "the candidate tree could not be read",
    });

    const state = screen.getByTestId("approval-candidate-state");
    expect(state).toHaveTextContent(
      "Unavailable — candidate could not be assembled",
    );
    expect(state).toHaveTextContent("Reject is the way out");
    expect(state).toHaveTextContent("the candidate tree could not be read");
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
      fireEvent.change(feedbackBox(), { target: { value: "send it back" } });
      expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    },
  );

  it("enables Approve once the frozen artifact is rendered", () => {
    renderPanel({
      status: "ready",
      candidate: { scope: "owned", ownedPaths: ["src/api"], diff: SCOPED_DIFF },
    });

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("keeps approve and reject working alongside the scoped change set", () => {
    const { onApprove, onReject } = renderPanel({
      status: "ready",
      candidate: { scope: "owned", ownedPaths: ["src/api"], diff: SCOPED_DIFF },
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.change(feedbackBox(), { target: { value: "needs more tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("needs more tests");
  });
});
