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
    expect(screen.getByText("Delete Item")).toBeDefined();
    expect(
      screen.getByText("Are you sure you want to delete this?"),
    ).toBeDefined();
    expect(screen.getByText("Confirm")).toBeDefined();
    expect(screen.getByText("Cancel")).toBeDefined();
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

  it("calls onCancel when overlay backdrop clicked (Req 7.3)", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog {...defaultProps} onCancel={onCancel} />,
    );
    const overlay = container.querySelector(".modal-overlay")!;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("applies danger styling when danger=true (Req 7.4)", () => {
    render(<ConfirmDialog {...defaultProps} danger />);
    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn.className).toContain("btn-danger");
  });

  it("applies primary styling when danger=false (Req 7.4)", () => {
    render(<ConfirmDialog {...defaultProps} danger={false} />);
    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn.className).toContain("btn-primary");
  });

  it("uses custom confirm and cancel labels", () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="Yes, delete"
        cancelLabel="No, keep"
      />,
    );
    expect(screen.getByText("Yes, delete")).toBeDefined();
    expect(screen.getByText("No, keep")).toBeDefined();
  });
});
