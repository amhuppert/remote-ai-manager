// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigNumericInput } from "./ConfigNumericInput";

describe("ConfigNumericInput", () => {
  it("displays the value as-is when not in minutes mode", () => {
    render(<ConfigNumericInput value={42} onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("42");
  });

  it("converts ms to minutes for display when displayAsMinutes", () => {
    render(
      <ConfigNumericInput
        value={120_000}
        onChange={() => {}}
        displayAsMinutes
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("2");
  });

  it("calls onChange with parsed number on valid input", () => {
    const onChange = vi.fn();
    render(<ConfigNumericInput value={null} onChange={onChange} positive />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("converts minutes input back to ms when displayAsMinutes", () => {
    const onChange = vi.fn();
    render(
      <ConfigNumericInput value={null} onChange={onChange} displayAsMinutes />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith(180_000);
  });

  it("shows error message and skips onChange on invalid input", () => {
    const onChange = vi.fn();
    render(<ConfigNumericInput value={null} onChange={onChange} positive />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } });
    expect(screen.getByText("Must be a number")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("syncs displayed value when the prop changes", () => {
    const { rerender } = render(
      <ConfigNumericInput value={1} onChange={() => {}} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("1");
    rerender(<ConfigNumericInput value={9} onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("9");
  });
});
