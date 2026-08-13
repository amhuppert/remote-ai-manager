// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./Select";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Picker({
  open,
  value,
  contentLayer,
}: {
  open?: boolean;
  value?: string;
  contentLayer?: "menu" | "popover";
}): React.JSX.Element {
  return (
    <Select open={open} value={value}>
      <SelectTrigger aria-label="Model">
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent contentLayer={contentLayer}>
        <SelectItem value="opus" description="Highly capable">
          Opus
        </SelectItem>
        <SelectItem value="haiku" description="Fastest">
          Haiku
        </SelectItem>
        <SelectItem value="sonnet" disabled>
          Sonnet
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select", () => {
  it("registers the open listbox with the overlay scope and clears it on close", () => {
    const { rerender } = render(<Picker open value="opus" />);
    expect(isOverlayOpen()).toBe(true);

    rerender(<Picker open={false} value="opus" />);
    expect(isOverlayOpen()).toBe(false);
  });

  it("renders the trigger with the CC recipe + canonical focus outline", () => {
    render(<Picker />);
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger.className).toContain("bg-bg-surface");
    expect(trigger.className).toContain("border-border-default");
    expect(trigger.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    expect(trigger.className).toContain(
      "data-[placeholder]:text-text-tertiary",
    );
  });

  it("gives the selected option the cyan-glow checked tint", () => {
    render(<Picker open value="opus" />);
    // Scope to the styled listbox option (Radix also renders a hidden native
    // <option> for form participation, which has no data-state).
    const checked = document.querySelector(
      '[role="option"][data-state="checked"]',
    );
    expect(checked).not.toBeNull();
    expect(checked?.textContent).toContain("Opus");
    expect(checked?.className).toContain("data-[state=checked]:bg-cyan-glow");
    expect(checked?.className).toContain("data-[state=checked]:text-cyan");
  });

  it("renders the listbox on the canonical elevated surface", () => {
    render(<Picker open value="opus" />);
    const listbox = screen.getByRole("listbox");
    expect(listbox.className).toContain("bg-bg-elevated");
    expect(listbox.className).toContain("shadow-menu");
    expect(listbox.className).toContain("z-menu");
  });

  it("can elevate nested listboxes to the popover layer", () => {
    render(<Picker open value="opus" contentLayer="popover" />);
    const listbox = screen.getByRole("listbox");

    expect(listbox.className).toContain("z-popover");
    expect(listbox.className).not.toContain("z-menu");
  });
});
