// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusChip } from "./StatusChip";

afterEach(cleanup);

describe("StatusChip — appearance axis", () => {
  it("defaults to the solid appearance (bordered pill)", () => {
    render(<StatusChip tone="cyan">Label</StatusChip>);
    const el = screen.getByText("Label");
    expect(el).toHaveClass("border-solid", "border");
    expect(el).toHaveClass("bg-cyan-glow", "text-cyan");
  });

  it("flat appearance drops the border and keeps the tone fill", () => {
    render(
      <StatusChip tone="green" appearance="flat">
        Fresh
      </StatusChip>,
    );
    const el = screen.getByText("Fresh");
    expect(el).toHaveClass("border-0");
    expect(el).toHaveClass("bg-green-glow", "text-green");
    expect(el).not.toHaveClass("border-solid");
  });

  it("ghost appearance renders a dashed transparent border that promotes to cyan on hover", () => {
    render(
      <StatusChip tone="neutral" appearance="ghost">
        No compact
      </StatusChip>,
    );
    const el = screen.getByText("No compact");
    expect(el).toHaveClass("border", "border-dashed");
    expect(el).toHaveClass("bg-transparent");
    expect(el).toHaveClass("hover:border-cyan", "hover:text-cyan");
    expect(el).not.toHaveClass("border-solid");
  });

  it("carries the appearance axis on the interactive (button) variant too", () => {
    render(
      <StatusChip as="button" tone="neutral" appearance="ghost">
        No compact
      </StatusChip>,
    );
    const el = screen.getByRole("button", { name: "No compact" });
    expect(el).toHaveClass("border-dashed", "bg-transparent");
    expect(el).toHaveClass("hover:border-cyan");
  });
});
