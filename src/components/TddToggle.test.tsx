// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import TddToggle from "./TddToggle";

expect.extend(matchers);

describe("TddToggle", () => {
  it("exposes a switch role with an accessible name and aria-checked reflecting state", () => {
    const { rerender } = render(
      <TddToggle enabled={false} onChange={vi.fn()} />,
    );
    const sw = screen.getByRole("switch", { name: /red-green tdd/i });
    expect(sw).toHaveAttribute("aria-checked", "false");

    rerender(<TddToggle enabled onChange={vi.fn()} />);
    expect(
      screen.getByRole("switch", { name: /red-green tdd/i }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("toggles via the switch (native keyboard/click — no hand-rolled aria-pressed button)", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: /red-green tdd/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

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

  it("does not double-toggle: a direct switch click fires onChange once", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: /red-green tdd/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire onChange when the pill is clicked while disabled", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} disabled />);
    const pill = screen.getByRole("switch", { name: /red-green tdd/i })
      .parentElement as HTMLElement;
    fireEvent.click(pill);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not fire onChange while disabled", () => {
    const onChange = vi.fn();
    render(<TddToggle enabled={false} onChange={onChange} disabled />);
    const sw = screen.getByRole("switch", { name: /red-green tdd/i });
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders the compact variant with the TDD label as a switch", () => {
    render(<TddToggle enabled={false} onChange={vi.fn()} compact />);
    const sw = screen.getByRole("switch", { name: /red-green tdd/i });
    expect(sw).toBeInTheDocument();
    expect(screen.getByText("TDD")).toBeInTheDocument();
    // Tooltip affordance is preserved on the compact pill.
    expect(
      within(document.body).getByText("TDD").closest("[data-tooltip]"),
    ).not.toBeNull();
  });
});
