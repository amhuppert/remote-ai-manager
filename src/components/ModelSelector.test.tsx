// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelSelector, { getModelsForBackend } from "./ModelSelector";

describe("getModelsForBackend", () => {
  it("includes the Fable model for the claude backend", () => {
    const ids = getModelsForBackend("claude").map((m) => m.id);
    expect(ids).toContain("fable");
    expect(ids).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
  });

  it("does not offer Fable for the codex backend", () => {
    const ids = getModelsForBackend("codex").map((m) => m.id);
    expect(ids).not.toContain("fable");
  });
});

describe("ModelSelector", () => {
  const defaultProps = { value: "sonnet" as const, onChange: vi.fn() };

  it("opens dropdown on trigger click", () => {
    render(<ModelSelector {...defaultProps} />);
    const trigger = screen.getByTitle(/model/i);
    fireEvent.click(trigger);
    // The dropdown div should get the "open" class
    const dropdown = document.querySelector(".model-selector-dropdown.open");
    expect(dropdown).toBeTruthy();
  });

  it("renders dropdown via portal outside the model-selector container", () => {
    render(<ModelSelector {...defaultProps} />);
    const trigger = screen.getByTitle(/model/i);
    fireEvent.click(trigger);

    const container = document.querySelector(".model-selector");
    const dropdown = document.querySelector(".model-selector-dropdown.open");
    expect(dropdown).toBeTruthy();
    // The dropdown must NOT be a child of .model-selector (rendered via portal)
    expect(container!.contains(dropdown)).toBe(false);
  });

  it("positions dropdown portal near the trigger button", () => {
    render(<ModelSelector {...defaultProps} />);
    const trigger = screen.getByTitle(/model/i);
    fireEvent.click(trigger);

    const dropdown = document.querySelector(
      ".model-selector-dropdown.open",
    ) as HTMLElement;
    expect(dropdown).toBeTruthy();
    // Portal dropdown should have inline position styles
    expect(dropdown.style.position).toBe("fixed");
  });

  it("closes portal dropdown on outside click", () => {
    render(<ModelSelector {...defaultProps} />);
    const trigger = screen.getByTitle(/model/i);
    fireEvent.click(trigger);
    expect(
      document.querySelector(".model-selector-dropdown.open"),
    ).toBeTruthy();

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(document.querySelector(".model-selector-dropdown.open")).toBeFalsy();
  });
});
