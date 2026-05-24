// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CCCheckbox from "./CCCheckbox";

describe("CCCheckbox", () => {
  it("renders unchecked by default", () => {
    render(<CCCheckbox checked={false} onChange={() => {}} />);
    const cb = screen.getByRole("checkbox");
    expect(cb).toHaveAttribute("aria-checked", "false");
  });

  it("renders checked when checked=true", () => {
    render(<CCCheckbox checked={true} onChange={() => {}} />);
    const cb = screen.getByRole("checkbox");
    expect(cb).toHaveAttribute("aria-checked", "true");
    expect(cb.className).toContain("checked");
  });

  it('renders aria-checked="mixed" when indeterminate and not checked', () => {
    render(<CCCheckbox checked={false} indeterminate onChange={() => {}} />);
    const cb = screen.getByRole("checkbox");
    expect(cb).toHaveAttribute("aria-checked", "mixed");
    expect(cb.className).toContain("indeterminate");
  });

  it("calls onChange(!checked) on click and stops propagation", () => {
    const onChange = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <CCCheckbox checked={false} onChange={onChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("uses aria-label when provided", () => {
    render(
      <CCCheckbox checked={false} onChange={() => {}} ariaLabel="Select row" />,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-label",
      "Select row",
    );
  });
});
