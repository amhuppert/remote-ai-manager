// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  // Radix AlertDialog-backed confirm/acknowledge prompt (migration contract §2).
  // Radix owns role=alertdialog, focus trap + return, Escape dismissal, and the
  // inert background; the deliberate behaviour change vs. the legacy hand-rolled
  // dialog is that there is no Enter→confirm shortcut and focus lands on the safe
  // Cancel action (verified live, not in jsdom). Outside-click does NOT dismiss
  // an alert dialog.
  // =========================================================================

  it("exposes an alertdialog labelled by its title when open", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(
      screen.getByRole("alertdialog", { name: "Delete Item" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure you want to delete this?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <ConfirmDialog {...defaultProps} open={false} />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("returns focus to the opener element on close (state-opened, no Radix trigger)", async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open confirm
          </button>
          <ConfirmDialog
            {...defaultProps}
            open={open}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "open confirm" });
    opener.focus();
    fireEvent.click(opener);
    expect(
      await screen.findByRole("alertdialog", { name: "Delete Item" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Delete Item" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("calls onConfirm when confirm button clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...defaultProps}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel (not onConfirm) when cancel button clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...defaultProps}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when Escape key pressed", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...defaultProps}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not dismiss on an outside pointer press (alert dialog semantics)", () => {
    const onCancel = vi.fn();
    render(
      <div>
        <ConfirmDialog {...defaultProps} onCancel={onCancel} />
        <button type="button">outside</button>
      </div>,
    );
    // Radix makes the background inert/aria-hidden while the alert dialog is
    // open, so the outside control is queried with `hidden`. An alert dialog
    // ignores outside-pointer dismissal, so neither callback fires.
    const outside = screen.getByRole("button", {
      name: "outside",
      hidden: true,
    });
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("uses custom confirm and cancel labels", () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="Yes, delete"
        cancelLabel="No, keep"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Yes, delete" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "No, keep" }),
    ).toBeInTheDocument();
  });

  it("hides the cancel button when hideCancel=true (acknowledge-only)", () => {
    render(
      <ConfirmDialog {...defaultProps} hideCancel confirmLabel="Got it" />,
    );
    expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("acknowledge-only still confirms on the single action", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        {...defaultProps}
        hideCancel
        confirmLabel="Got it"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
