// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ModelSelector from "./ModelSelector";

/** Extract z-index value for a CSS selector from globals.css */
function getZIndex(css: string, selector: string): number | null {
  // Match the selector followed by its block
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "m");
  const match = css.match(re);
  return match ? Number(match[1]) : null;
}

const globals = readFileSync(resolve(__dirname, "../app/globals.css"), "utf-8");

describe("ModelSelector", () => {
  const defaultProps = { value: "sonnet" as const, onChange: vi.fn() };

  it("dropdown z-index is above panel layers but below tooltips", () => {
    const dropdownZ = getZIndex(globals, ".model-selector-dropdown");
    // Panels use z-index 80–91, unified panel is 91
    // Tooltips and overlays are 9999
    expect(dropdownZ).not.toBeNull();
    expect(dropdownZ!).toBeGreaterThan(91);
    expect(dropdownZ!).toBeLessThan(9999);
  });

  it("opens dropdown on trigger click", () => {
    render(<ModelSelector {...defaultProps} />);
    const trigger = screen.getByTitle(/model/i);
    fireEvent.click(trigger);
    // The dropdown div should get the "open" class
    const dropdown = document.querySelector(".model-selector-dropdown.open");
    expect(dropdown).toBeTruthy();
  });
});
