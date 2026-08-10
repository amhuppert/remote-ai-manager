// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import TddToggle from "./TddToggle";

expect.extend(matchers);

// Radix's tooltip trigger (compact variant) captures the pointer on press;
// jsdom implements none of these.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

describe("TddToggle", () => {
  it("toggles when the visible label is clicked", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled onChange={onChange} />);
    fireEvent.click(screen.getByText("Red-green TDD"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("toggles when the surrounding pill (not the switch or label) is clicked", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} />);
    // The wrapper pill is the element carrying both the switch and the label.
    const pill = screen.getByRole("switch", { name: /red-green tdd/i })
      .parentElement as HTMLElement;
    fireEvent.click(pill);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle from the surrounding pill while disabled", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} disabled />);
    const pill = screen.getByRole("switch", { name: /red-green tdd/i })
      .parentElement as HTMLElement;
    fireEvent.click(pill);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not double-toggle: a direct switch click fires onChange once", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: /red-green tdd/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders the compact variant with the TDD label as a switch", () => {
    render(<TddToggle enabled={false} onChange={vi.fn()} compact />);
    const sw = screen.getByRole("switch", { name: /red-green tdd/i });
    expect(sw).toBeInTheDocument();
    expect(screen.getByText("TDD")).toBeInTheDocument();
    // Tooltip affordance is preserved on the compact pill: the pill wrapper is a
    // Radix tooltip trigger (stamped with its own data-state) rather than the
    // legacy data-tooltip attribute.
    const pill = within(document.body)
      .getByText("TDD")
      .closest("[data-on]") as HTMLElement;
    expect(pill).toHaveAttribute("data-state");
  });
});
