// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox, CheckboxField } from "./Checkbox";

// Radix moves real focus / captures the pointer; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("Checkbox", () => {
  it("renders the APG checkbox role with the CC box recipe + canonical focus outline", () => {
    render(<Checkbox aria-label="Accept" />);
    const box = screen.getByRole("checkbox", { name: "Accept" });
    expect(box.className).toContain("size-[16px]");
    expect(box.className).toContain("rounded-[3px]");
    expect(box.className).toContain("border-border-default");
    expect(box.className).toContain("bg-bg-base");
    expect(box.className).toContain("hover:border-cyan-dim");
    expect(box.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("reflects unchecked / checked / indeterminate via aria-checked", () => {
    const { rerender } = render(<Checkbox aria-label="x" checked={false} />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "false",
    );

    rerender(<Checkbox aria-label="x" checked />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );

    rerender(<Checkbox aria-label="x" checked="indeterminate" />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "mixed",
    );
  });

  it("paints the cyan fill in both checked and indeterminate states", () => {
    render(<Checkbox aria-label="x" checked />);
    const box = screen.getByRole("checkbox");
    expect(box.className).toContain("data-[state=checked]:border-cyan");
    expect(box.className).toContain("data-[state=checked]:bg-cyan");
    expect(box.className).toContain("data-[state=indeterminate]:border-cyan");
    expect(box.className).toContain("data-[state=indeterminate]:bg-cyan");
  });

  it("toggles on Space and fires onCheckedChange", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox
        aria-label="x"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const box = screen.getByRole("checkbox");
    box.focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("disabled maps to data-disabled styling and blocks interaction", () => {
    render(<Checkbox aria-label="x" disabled />);
    const box = screen.getByRole("checkbox");
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(box.className).toContain("data-[disabled]:opacity-40");
    expect(box.className).toContain("data-[disabled]:cursor-not-allowed");
  });

  it("appends layoutClassName last, after appearance utilities", () => {
    render(<Checkbox aria-label="x" layoutClassName="mt-xs" />);
    const box = screen.getByRole("checkbox");
    expect(box.className.trim().endsWith("mt-xs")).toBe(true);
  });

  it("CheckboxField associates a label and an optional description with the box", () => {
    render(
      <CheckboxField
        checked
        label="Enable feature"
        description="Turns the thing on"
      />,
    );
    // Clicking the visible label must toggle the associated box.
    const box = screen.getByRole("checkbox", { name: /Enable feature/ });
    expect(box).not.toBeNull();
    expect(screen.getByText("Turns the thing on")).not.toBeNull();
  });
});
