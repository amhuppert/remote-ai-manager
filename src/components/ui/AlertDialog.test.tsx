// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogActions,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";

// Radix locks scroll / manages focus on open; jsdom implements neither of the
// pointer-capture APIs `react-remove-scroll` and the focus scope reach for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Confirm({
  open,
  danger,
  hideCancel,
  disabledActions,
}: {
  open?: boolean;
  danger?: boolean;
  hideCancel?: boolean;
  disabledActions?: boolean;
}): React.JSX.Element {
  return (
    <AlertDialog open={open}>
      <AlertDialogTrigger>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete session?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        <AlertDialogActions>
          {!hideCancel && (
            <AlertDialogCancel disabled={disabledActions}>
              Cancel
            </AlertDialogCancel>
          )}
          <AlertDialogAction danger={danger} disabled={disabledActions}>
            {danger ? "Delete" : "Confirm"}
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("AlertDialog", () => {
  it("exposes the alertdialog role with an accessible name and description", () => {
    render(<Confirm open />);
    const dialog = screen.getByRole("alertdialog", { name: "Delete session?" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("renders the confirm-width card on the CC surface recipe with the mobile sheet", () => {
    render(<Confirm open />);
    const card = screen.getByRole("alertdialog");
    expect(card.className).toContain("bg-bg-surface");
    expect(card.className).toContain("border-border-default");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("p-xl");
    expect(card.className).toContain("max-w-[400px]");
    expect(card.className).toContain("max-768:rounded-b-none");
  });

  it("renders the scrim overlay with the tokenized blur backdrop", () => {
    render(<Confirm open />);
    const overlay = document.querySelector('[class*="cc-overlay-scrim"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain("backdrop-blur-[8px]");
    expect(overlay?.className).toContain(
      "motion-safe:animate-[fadeIn_0.15s_ease]",
    );
  });

  it("marks the scrim so the global ambient-animation freeze can detect it", () => {
    render(<Confirm open />);
    const overlay = document.querySelector('[class*="cc-overlay-scrim"]');
    expect(overlay?.hasAttribute("data-cc-modal-scrim")).toBe(true);
  });

  it("renders a primary confirm action by default with the canonical focus ring", () => {
    render(<Confirm open />);
    const action = screen.getByRole("button", { name: "Confirm" });
    expect(action.className).toContain("bg-cyan");
    expect(action.className).toContain("text-text-inverse");
    expect(action.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("renders a destructive confirm action when danger is set", () => {
    render(<Confirm open danger />);
    const action = screen.getByRole("button", { name: "Delete" });
    expect(action.className).toContain("text-red");
    expect(action.className).toContain("border-[var(--cc-red-border)]");
    expect(action.className).not.toContain("bg-cyan");
  });

  it("renders the cancel affordance on the neutral default button", () => {
    render(<Confirm open />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).toContain("bg-bg-surface");
    expect(cancel.className).toContain("border-border-default");
    expect(cancel.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("supports an acknowledge-only dialog with no cancel button", () => {
    render(<Confirm open hideCancel />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("lands open focus on the safe cancel action by default", () => {
    render(<Confirm open />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
  });

  it("moves open focus onto the action when there is no cancel (acknowledge-only)", () => {
    render(<Confirm open hideCancel />);
    const dialog = screen.getByRole("alertdialog");
    const action = screen.getByRole("button", { name: "Confirm" });
    expect(document.activeElement).toBe(action);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("moves open focus onto the action when the cancel is disabled", () => {
    render(
      <AlertDialog open>
        <AlertDialogTrigger>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete session?</AlertDialogTitle>
          <AlertDialogActions>
            <AlertDialogCancel disabled>Cancel</AlertDialogCancel>
            <AlertDialogAction danger>Delete</AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Delete" }),
    );
  });

  it("keeps open focus inside the dialog when every action is disabled", () => {
    render(<Confirm open disabledActions />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("gives the title and description their CC recipes", () => {
    render(<Confirm open />);
    const title = screen.getByRole("heading", { name: "Delete session?" });
    expect(title.tagName).toBe("H2");
    expect(title.className).toContain("font-display");
    expect(title.className).toContain("font-bold");

    const desc = screen.getByText("This cannot be undone.");
    expect(desc.className).toContain("font-mono");
    expect(desc.className).toContain("text-text-secondary");
  });

  it("opens uncontrolled via defaultOpen", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogTrigger>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Uncontrolled</AlertDialogTitle>
          <AlertDialogActions>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(
      screen.getByRole("alertdialog", { name: "Uncontrolled" }),
    ).toBeInTheDocument();
  });

  it("registers the open dialog with the overlay scope and clears it on close", () => {
    const { rerender } = render(<Confirm open />);
    expect(isOverlayOpen()).toBe(true);

    rerender(<Confirm open={false} />);
    expect(isOverlayOpen()).toBe(false);
  });
});
