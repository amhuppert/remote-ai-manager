// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl, SegmentedControlItem } from "./SegmentedControl";

// Radix moves real focus / captures the pointer; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Seg({
  value,
  onValueChange,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
}): React.JSX.Element {
  return (
    <SegmentedControl
      aria-label="Group by"
      value={value}
      onValueChange={onValueChange}
    >
      <SegmentedControlItem value="project">Project</SegmentedControlItem>
      <SegmentedControlItem value="session">Session</SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("SegmentedControl", () => {
  it("is a radiogroup of radio segments (value-select semantics, not Tabs)", () => {
    render(<Seg value="project" />);
    // Distinguishes it from Tabs: segments are role=radio, not role=tab, and the
    // container is a radiogroup, not a tablist.
    expect(screen.getByRole("radiogroup", { name: "Group by" })).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("carries the segmented container recipe", () => {
    render(<Seg value="project" />);
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("rounded-sm");
    expect(group.className).toContain("border-border-default");
    expect(group.className).toContain("bg-bg-surface");
    expect(group.className).toContain("p-[2px]");
  });

  it("active segment takes the cyan-glow tint; inactive keeps the hover promotion", () => {
    render(<Seg value="project" />);
    const item = screen.getByRole("radio", { name: "Project" });
    expect(item.className).toContain("data-[state=checked]:bg-cyan-glow");
    expect(item.className).toContain("data-[state=checked]:text-cyan");
    expect(item.className).toContain(
      "data-[state=unchecked]:hover:text-text-primary",
    );
    expect(item.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    // Per the design system, selection is a glow tint — never a full cyan fill.
    expect(item.className).not.toContain("data-[state=checked]:bg-cyan ");
  });

  it("reflects the active value with aria-checked", () => {
    render(<Seg value="session" />);
    expect(
      screen
        .getByRole("radio", { name: "Session" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("moves focus across segments with arrow keys (horizontal roving)", async () => {
    const user = userEvent.setup();
    render(<Seg value="project" />);
    const project = screen.getByRole("radio", { name: "Project" });
    const session = screen.getByRole("radio", { name: "Session" });
    project.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(session);
  });

  // Selection-follows-focus on arrow / Space is Radix behaviour ordered
  // differently under jsdom; it is verified in the live Storybook keyboard pass.
  // Click selection is deterministic in jsdom and asserted here.
  it("selects a segment on click and fires onValueChange", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Seg value="project" onValueChange={onValueChange} />);
    await user.click(screen.getByRole("radio", { name: "Session" }));
    expect(onValueChange).toHaveBeenCalledWith("session");
  });

  it("grows to a mobile touch target", () => {
    render(<Seg value="project" />);
    const item = screen.getByRole("radio", { name: "Project" });
    expect(item.className).toContain("max-768:min-h-[var(--touch-target-min)]");
  });

  it("disabled segment maps to data-disabled styling", () => {
    render(
      <SegmentedControl aria-label="x" value="a">
        <SegmentedControlItem value="a">A</SegmentedControlItem>
        <SegmentedControlItem value="b" disabled>
          B
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    const b = screen.getByRole("radio", { name: "B" });
    expect(b.hasAttribute("disabled")).toBe(true);
    expect(b.className).toContain("data-[disabled]:opacity-40");
  });

  it("appends layoutClassName last on root and item", () => {
    render(
      <SegmentedControl aria-label="x" value="a" layoutClassName="w-full">
        <SegmentedControlItem value="a" layoutClassName="flex-1">
          A
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    expect(
      screen.getByRole("radiogroup").className.trim().endsWith("w-full"),
    ).toBe(true);
    expect(screen.getByRole("radio").className.trim().endsWith("flex-1")).toBe(
      true,
    );
  });
});
