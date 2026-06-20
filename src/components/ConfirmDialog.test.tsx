// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  const defaultProps = {
    open: true,
    title: "Delete Item",
    message: "Are you sure you want to delete this?",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  // =========================================================================
  // 6.1 – ConfirmDialog (Req 7.1–7.4)
  // =========================================================================

  it("renders title, message, and buttons when open=true (Req 7.1)", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete Item")).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure you want to delete this?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("renders nothing when open=false (Req 7.1)", () => {
    const { container } = render(
      <ConfirmDialog {...defaultProps} open={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("calls onConfirm when confirm button clicked (Req 7.2)", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked (Req 7.3)", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape key pressed (Req 7.3)", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call onCancel when overlay backdrop clicked", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    const overlay = screen.getByTestId("modal-overlay");
    fireEvent.click(overlay);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("applies danger styling when danger=true (Req 7.4)", () => {
    render(<ConfirmDialog {...defaultProps} danger />);
    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn.className).toContain("text-red");
    expect(confirmBtn.className).toContain("border-[var(--cc-red-border)]");
  });

  it("applies primary styling when danger=false (Req 7.4)", () => {
    render(<ConfirmDialog {...defaultProps} danger={false} />);
    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn.className).toContain("bg-cyan");
    expect(confirmBtn.className).toContain("text-text-inverse");
  });

  it("uses custom confirm and cancel labels", () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="Yes, delete"
        cancelLabel="No, keep"
      />,
    );
    expect(screen.getByText("Yes, delete")).toBeInTheDocument();
    expect(screen.getByText("No, keep")).toBeInTheDocument();
  });

  it("hides the cancel button when hideCancel=true (acknowledge-only)", () => {
    render(
      <ConfirmDialog {...defaultProps} hideCancel confirmLabel="Got it" />,
    );
    expect(screen.getByText("Got it")).toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("focuses the confirm button when opened", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Send anyway" />);
    expect(document.activeElement).toBe(screen.getByText("Send anyway"));
  });

  it("calls onConfirm when Enter key is pressed", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.keyDown(screen.getByText("Confirm"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("prevents Enter from reaching handlers outside the modal", () => {
    const onConfirm = vi.fn();
    const outerHandler = vi.fn();
    document.addEventListener("keydown", outerHandler);
    try {
      render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
      fireEvent.keyDown(screen.getByText("Confirm"), { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(outerHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outerHandler);
    }
  });
});
