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
    expect(screen.getByRole("button", { name: "a" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "b" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  it("can render a display label while reporting the option value", () => {
    const onChange = vi.fn();
    render(
      <ConfigPillGroup
        value="opus"
        options={["opus", "sonnet"] as const}
        getOptionLabel={(option) => (option === "opus" ? "Opus 5" : "Sonnet")}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sonnet" }));
    expect(screen.getByRole("button", { name: "Opus 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onChange).toHaveBeenCalledWith("sonnet");
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

  it("uses the minimum touch-target height on mobile", () => {
    render(
      <ConfigPillGroup
        value="a"
        options={["a", "b"] as const}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "a" }).className).toContain(
      "max-768:min-h-[var(--touch-target-min)]",
    );
  });

  it("exposes an accessible name for the related choices", () => {
    render(
      <ConfigPillGroup
        value="a"
        options={["a", "b"] as const}
        onChange={() => {}}
        aria-label="Default backend"
      />,
    );

    expect(
      screen.getByRole("group", { name: "Default backend" }),
    ).toContainElement(screen.getByRole("button", { name: "a" }));
  });
});
