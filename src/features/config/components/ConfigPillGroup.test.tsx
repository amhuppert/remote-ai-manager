// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigPillGroup } from "./ConfigPillGroup";

describe("ConfigPillGroup", () => {
  it("renders one button per option and marks the selected one active", () => {
    render(
      <ConfigPillGroup
        value="b"
        options={["a", "b", "c"] as const}
        onChange={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["a", "b", "c"]);
    expect(buttons[1]!.className).toContain("active");
    expect(buttons[0]!.className).not.toContain("active");
  });

  it("calls onChange with the clicked option", () => {
    const onChange = vi.fn();
    render(
      <ConfigPillGroup
        value="a"
        options={["a", "b"] as const}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("does not call onChange when disabled", () => {
    const onChange = vi.fn();
    render(
      <ConfigPillGroup
        value="a"
        options={["a", "b"] as const}
        onChange={onChange}
        disabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
