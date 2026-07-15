// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./Select";

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

  it("marks the scrim so the global ambient-animation freeze can detect it", () => {
    render(<Modal open />);
    const overlay = document.querySelector('[class*="cc-overlay-scrim"]');
    expect(overlay?.hasAttribute("data-cc-modal-scrim")).toBe(true);
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
    expect(card.className).toContain("max-768:max-h-[100dvh]");
    expect(card.className).toContain("max-768:overflow-y-auto");
    expect(card.className).toContain("max-768:overscroll-contain");
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

describe("DialogContent unstyled variant", () => {
  it("drops the padded card recipe but keeps Portal + focus trap + role/aria wiring", () => {
    render(
      <Dialog open>
        <DialogContent
          unstyled
          contentClassName="fixed top-0 right-0 bottom-0 w-[720px] bg-bg-base"
        >
          <DialogTitle>Slide-over</DialogTitle>
          <p>edge-anchored body</p>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Slide-over" });
    // Radix still owns behaviour: the content is portaled out to the body.
    expect(document.body.contains(dialog)).toBe(true);
    // No padded card recipe leaks onto the card — the consumer owns the box model.
    expect(dialog.className).not.toContain("p-xl");
    expect(dialog.className).not.toContain("max-w-[480px]");
    expect(dialog.className).not.toContain("bg-bg-surface");
    // The consumer's edge-anchored geometry + appearance is applied verbatim.
    expect(dialog.className).toContain("fixed");
    expect(dialog.className).toContain("w-[720px]");
    expect(dialog.className).toContain("bg-bg-base");
  });

  it("makes the centring layer full-bleed so an edge-anchored card can position itself", () => {
    render(
      <Dialog open>
        <DialogContent
          unstyled
          anchor="stretch"
          aria-label="Full-screen reader"
        >
          <p>immersive</p>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Full-screen reader" });
    // The card's positioning layer stretches to the viewport (inset-0) instead
    // of centring the card, so a `top-0 right-0 bottom-0` card docks to the edge.
    const layer = dialog.parentElement as HTMLElement;
    expect(layer.className).toContain("inset-0");
    expect(layer.className).not.toContain("items-center");
  });

  it("still renders the tokenized scrim by default in the unstyled variant", () => {
    render(
      <Dialog open>
        <DialogContent unstyled aria-label="Custom card">
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    const overlay = document.querySelector('[class*="cc-overlay-scrim"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.hasAttribute("data-cc-modal-scrim")).toBe(true);
  });

  it("applies a custom scrim appearance when scrimClassName is supplied", () => {
    render(
      <Dialog open>
        <DialogContent
          unstyled
          scrimClassName="fixed inset-0 z-dropdown bg-[var(--cc-bg-void-a60)] [backdrop-filter:blur(4px)_saturate(120%)]"
          aria-label="Drawer"
        >
          <p>body</p>
        </DialogContent>
      </Dialog>,
    );
    // The default tokenized scrim is replaced, not merged.
    expect(document.querySelector('[class*="cc-overlay-scrim"]')).toBeNull();
    const overlay = document.querySelector("[data-cc-modal-scrim]");
    expect(overlay?.className).toContain(
      "[backdrop-filter:blur(4px)_saturate(120%)]",
    );
  });
});

// While a nested overlay (Select listbox) is open, Radix disables pointer
// events on the dialog card but the scrim keeps `pointer-events: auto`, so a
// browser click aimed at the card hit-tests to the scrim. Dispatching the
// pointer sequence on the scrim models that. The dismissal decision must be
// made at pointerdown time (nested overlay open → dialog is not the top layer
// → not dismissable); deciding at click time closes the dialog together with
// the listbox.
describe("Dialog with a nested Select", () => {
  function ModalWithSelect({
    onOpenChange,
  }: {
    onOpenChange: (open: boolean) => void;
  }): React.JSX.Element {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-label={undefined}>
          <DialogTitle>New ticket</DialogTitle>
          <Select>
            <SelectTrigger aria-label="Work type">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="feature">Feature</SelectItem>
              <SelectItem value="bug">Bug</SelectItem>
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>
    );
  }

  function scrim(): Element {
    const node = document.querySelector("[data-cc-modal-scrim]");
    if (node === null) throw new Error("scrim not rendered");
    return node;
  }

  // Radix attaches its document-level outside-press listeners from a 0ms
  // timeout after a layer mounts; flush that (and the deferred dismissal's own
  // 0ms timeout) before/after dispatching events.
  async function flushTimers(): Promise<void> {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  }

  async function pressScrim(): Promise<void> {
    fireEvent.pointerDown(scrim(), { button: 0, pointerType: "mouse" });
    fireEvent.click(scrim(), { button: 0 });
    await flushTimers();
  }

  it("closes only the listbox when a press lands while the listbox is open", async () => {
    const onOpenChange = vi.fn();
    render(<ModalWithSelect onOpenChange={onOpenChange} />);
    await flushTimers();

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Work type" }), {
      button: 0,
      pointerType: "mouse",
    });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await flushTimers();

    await pressScrim();

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("dialog", { name: "New ticket" }),
    ).toBeInTheDocument();
  });

  it("still dismisses the dialog on a scrim press when no nested overlay is open", async () => {
    const onOpenChange = vi.fn();
    render(<ModalWithSelect onOpenChange={onOpenChange} />);
    await flushTimers();

    await pressScrim();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
