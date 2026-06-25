// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadioGroup, RadioGroupItem, RadioGroupOption } from "./RadioGroup";

// Radix moves real focus / captures the pointer; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Group({
  value,
  onValueChange,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
}): React.JSX.Element {
  return (
    <RadioGroup
      aria-label="Backend"
      value={value}
      onValueChange={onValueChange}
    >
      <RadioGroupItem value="claude" aria-label="Claude" />
      <RadioGroupItem value="codex" aria-label="Codex" />
      <RadioGroupItem value="off" aria-label="Off" disabled />
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("exposes the APG radiogroup with radio children", () => {
    render(<Group value="claude" />);
    expect(screen.getByRole("radiogroup", { name: "Backend" })).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("reflects the selected value with aria-checked", () => {
    render(<Group value="codex" />);
    expect(
      screen.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "Claude" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("gives the item the circular CC recipe + cyan checked border + canonical focus outline", () => {
    render(<Group value="claude" />);
    const item = screen.getByRole("radio", { name: "Claude" });
    expect(item.className).toContain("size-[16px]");
    expect(item.className).toContain("rounded-full");
    expect(item.className).toContain("border-border-default");
    expect(item.className).toContain("data-[state=checked]:border-cyan");
    expect(item.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("moves focus across enabled items with arrow keys and skips disabled (roving tabindex)", async () => {
    const user = userEvent.setup();
    render(<Group value="claude" />);
    const claude = screen.getByRole("radio", { name: "Claude" });
    const codex = screen.getByRole("radio", { name: "Codex" });
    claude.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(codex);
    // The disabled Off is skipped: from the last enabled item arrow wraps back.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(claude);
  });

  // Selection-follows-focus on arrow / Space is Radix behaviour that is
  // browser-timing-dependent (it relies on a document-level keydown ref that
  // jsdom orders differently); it is verified in the live Storybook keyboard
  // pass. Click selection is deterministic in jsdom and asserted here.
  it("selects a value on click and fires onValueChange", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Group value="claude" onValueChange={onValueChange} />);
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    expect(onValueChange).toHaveBeenCalledWith("codex");
  });

  it("disabled item maps to data-disabled styling", () => {
    render(<Group value="claude" />);
    const off = screen.getByRole("radio", { name: "Off" });
    expect(off.hasAttribute("disabled")).toBe(true);
    expect(off.className).toContain("data-[disabled]:opacity-40");
  });

  it("appends layoutClassName last on both root and item", () => {
    render(
      <RadioGroup aria-label="x" value="a" layoutClassName="mt-lg">
        <RadioGroupItem value="a" aria-label="a" layoutClassName="ml-auto" />
      </RadioGroup>,
    );
    const group = screen.getByRole("radiogroup");
    expect(group.className.trim().endsWith("mt-lg")).toBe(true);
    expect(screen.getByRole("radio").className.trim().endsWith("ml-auto")).toBe(
      true,
    );
  });

  it("RadioGroupOption renders an associated label + description", () => {
    render(
      <RadioGroup aria-label="Mode" value="fast">
        <RadioGroupOption
          value="fast"
          label="Fast"
          description="Minimal review"
        />
        <RadioGroupOption value="focus" label="Focus" />
      </RadioGroup>,
    );
    expect(screen.getByRole("radio", { name: /Fast/ })).not.toBeNull();
    expect(screen.getByText("Minimal review")).not.toBeNull();
  });
});
