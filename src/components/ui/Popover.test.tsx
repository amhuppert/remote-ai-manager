// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import { Button } from "./Button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
} from "./Popover";

// Radix focuses content / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

/** A minimal open popover with the given panel content (non-modal). */
function openPopover(
  content: React.ReactNode,
  contentProps?: React.ComponentProps<typeof PopoverContent>,
) {
  return render(
    <Popover open>
      <PopoverTrigger>trigger</PopoverTrigger>
      <PopoverContent {...contentProps}>{content}</PopoverContent>
    </Popover>,
  );
}

describe("Popover", () => {
  it("registers the open panel with the global overlay scope and clears it on close", () => {
    const { rerender } = openPopover(<p>details</p>);
    expect(isOverlayOpen()).toBe(true);

    rerender(
      <Popover open={false}>
        <PopoverTrigger>trigger</PopoverTrigger>
        <PopoverContent>
          <p>details</p>
        </PopoverContent>
      </Popover>,
    );
    expect(isOverlayOpen()).toBe(false);
  });

  it("tracks uncontrolled open state through the overlay scope (defaultOpen)", () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>trigger</PopoverTrigger>
        <PopoverContent>
          <p>details</p>
          <PopoverClose aria-label="dismiss">x</PopoverClose>
        </PopoverContent>
      </Popover>,
    );
    expect(isOverlayOpen()).toBe(true);

    // Clicking the baked-in close part dismisses the uncontrolled popover and
    // the overlay scope clears — proving the wrapper owns the open state, not
    // just a controlled prop.
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(isOverlayOpen()).toBe(false);
  });

  it("portals the panel out to document.body", () => {
    const { container } = openPopover(<p>portaled</p>);
    const panel = screen.getByText("portaled");
    // The content escapes the React render container (Radix Portal → body).
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });

  it("content carries the elevated floating-panel surface and z-popover tier", () => {
    openPopover(<p>x</p>);
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("bg-bg-elevated");
    expect(panel.className).toContain("border-border-default");
    expect(panel.className).toContain("shadow-menu");
    expect(panel.className).toContain("z-popover");
    expect(panel.className).toContain("rounded-md");
    // Restrained motion-safe entry animation gated on the open data-state.
    expect(panel.className).toContain(
      "data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]",
    );
  });

  it("appends layoutClassName last (external geometry wins source order)", () => {
    openPopover(<p>x</p>, { layoutClassName: "w-[320px]" });
    const panel = screen.getByRole("dialog");
    expect(panel.className.trim().endsWith("w-[320px]")).toBe(true);
  });

  it("routes the panel through Radix's collision-aware popper positioner", () => {
    // Bakes the side-offset / collision-padding contract: the panel renders
    // inside Radix's popper wrapper (so the side offset + collision padding the
    // wrapper applies are in effect) and defaults to the bottom side. The exact
    // numeric offset (6px gap) and edge-flip behaviour need real layout, which
    // jsdom does not compute — those are exercised in the live Storybook pass
    // (Popover.stories.tsx → AlignmentSides / collision verification).
    openPopover(<p>x</p>);
    const wrapper = document.querySelector(
      "[data-radix-popper-content-wrapper]",
    );
    expect(wrapper).not.toBeNull();
    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("bottom");
  });

  it("composes with the Button primitive as an asChild trigger (focus ring + open state)", () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button>Details</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p>panel</p>
        </PopoverContent>
      </Popover>,
    );

    const trigger = screen.getByRole("button", { name: "Details" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    // data-state=open on the underlying <button> proves the asChild ref/prop
    // merge reached the Button primitive's DOM node.
    expect(trigger.getAttribute("data-state")).toBe("open");
    // The Button keeps its canonical cyan focus-visible ring through the merge.
    expect(trigger.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    expect(screen.getByText("panel")).toBeInTheDocument();
  });
});
