// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigToggle } from "./ConfigToggle";

describe("ConfigToggle", () => {
  it("renders ON when value is true", () => {
    render(<ConfigToggle value={true} onChange={() => {}} />);
    expect(screen.getByText("ON")).toBeVisible();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("renders OFF when value is false", () => {
    render(<ConfigToggle value={false} onChange={() => {}} />);
    expect(screen.getByText("OFF")).toBeVisible();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with toggled value on click", () => {
    const onChange = vi.fn();
    render(<ConfigToggle value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with toggled value on Enter key", () => {
    const onChange = vi.fn();
    render(<ConfigToggle value={true} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("switch"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not call onChange when disabled", () => {
    const onChange = vi.fn();
    render(<ConfigToggle value={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.keyDown(screen.getByRole("switch"), { key: " " });
    expect(onChange).not.toHaveBeenCalled();
  });
});
