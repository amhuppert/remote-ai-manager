// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CCCheckbox from "./CCCheckbox";

describe("CCCheckbox", () => {
  it('renders aria-checked="mixed" when indeterminate and not checked', () => {
    render(<CCCheckbox checked={false} indeterminate onChange={() => {}} />);
    const cb = screen.getByRole("checkbox");
    expect(cb).toHaveAttribute("aria-checked", "mixed");
  });

  it("calls onChange(!checked) on click and stops propagation", () => {
    const onChange = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <CCCheckbox
          checked={false}
          onChange={onChange}
          ariaLabel="Select row"
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
