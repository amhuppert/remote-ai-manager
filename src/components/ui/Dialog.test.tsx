// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import { IconButton } from "./IconButton";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogActions,
  DialogClose,
} from "./Dialog";

// Radix locks scroll / manages focus on open; jsdom implements neither of the
// pointer-capture APIs `react-remove-scroll` and the focus scope reach for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Modal({
  open,
  size,
  mobileSheet,
}: {
  open?: boolean;
  size?: "default" | "confirm";
  mobileSheet?: boolean;
}): React.JSX.Element {
  return (
    <Dialog open={open}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent
        size={size}
        mobileSheet={mobileSheet}
        aria-label={undefined}
      >
        <DialogTitle>Edit session</DialogTitle>
        <DialogDescription>Change the session name.</DialogDescription>
        <DialogActions>
          <DialogClose asChild>
            <IconButton aria-label="Close" />
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("exposes the modal dialog role with an accessible name from the title and a description", () => {
    render(<Modal open />);
    const dialog = screen.getByRole("dialog", { name: "Edit session" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("renders the card on the CC surface recipe with the default 480px width", () => {
    render(<Modal open />);
    const card = screen.getByRole("dialog");
    expect(card.className).toContain("bg-bg-surface");
    expect(card.className).toContain("border-border-default");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("p-xl");
    expect(card.className).toContain("max-w-[480px]");
    expect(card.className).toContain("motion-safe:animate-[slideUp_0.2s_ease]");
  });

  it("renders the scrim overlay with the tokenized blur backdrop", () => {
    render(<Modal open />);
    const overlay = document.querySelector('[class*="cc-overlay-scrim"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain("fixed");
    expect(overlay?.className).toContain("inset-0");
    expect(overlay?.className).toContain("backdrop-blur-[8px]");
    expect(overlay?.className).toContain(
      "motion-safe:animate-[fadeIn_0.15s_ease]",
    );
  });

  it("narrows the card to 400px in the confirm size", () => {
    render(<Modal open size="confirm" />);
    const card = screen.getByRole("dialog");
    expect(card.className).toContain("max-w-[400px]");
    expect(card.className).not.toContain("max-w-[480px]");
  });

  it("adds the mobile bottom-sheet treatment only when opted in", () => {
    const { rerender } = render(<Modal open size="confirm" />);
    expect(screen.getByRole("dialog").className).not.toContain(
      "max-768:rounded-b-none",
    );

    rerender(<Modal open size="confirm" mobileSheet />);
    const card = screen.getByRole("dialog");
    expect(card.className).toContain("max-768:max-w-full");
    expect(card.className).toContain("max-768:rounded-b-none");
    expect(card.className).toContain(
      "max-768:motion-safe:animate-[slideUpSheet_0.25s_ease]",
    );
  });

  it("gives the title and description their CC recipes", () => {
    render(<Modal open />);
    const title = screen.getByRole("heading", { name: "Edit session" });
    expect(title.tagName).toBe("H2");
    expect(title.className).toContain("font-display");
    expect(title.className).toContain("font-bold");
    expect(title.className).toContain("text-[1.2rem]");

    const desc = screen.getByText("Change the session name.");
    expect(desc.className).toContain("font-mono");
    expect(desc.className).toContain("text-text-secondary");
  });

  it("right-aligns the actions row", () => {
    render(<Modal open />);
    const close = screen.getByRole("button", { name: "Close" });
    const actions = close.parentElement as HTMLElement;
    expect(actions.className).toContain("flex");
    expect(actions.className).toContain("justify-end");
    expect(actions.className).toContain("gap-sm");
  });

  it("carries the canonical cyan focus ring on the composed close control", () => {
    render(<Modal open />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("opens uncontrolled via defaultOpen", () => {
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Uncontrolled</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(
      screen.getByRole("dialog", { name: "Uncontrolled" }),
    ).toBeInTheDocument();
  });

  it("registers the open dialog with the overlay scope and clears it on close", () => {
    const { rerender } = render(<Modal open />);
    expect(isOverlayOpen()).toBe(true);

    rerender(<Modal open={false} />);
    expect(isOverlayOpen()).toBe(false);
  });
});
