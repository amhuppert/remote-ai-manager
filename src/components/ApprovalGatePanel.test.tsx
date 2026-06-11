// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ApprovalGatePanel from "./ApprovalGatePanel";

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

  it("submits the rejection on Cmd+Enter when the message is non-empty", () => {
    const onReject = vi.fn();
    render(<ApprovalGatePanel {...defaultProps} onReject={onReject} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "  Tighten the tests " } });
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });
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
