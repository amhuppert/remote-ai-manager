// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ModeDot from "./ModeDot";

describe("ModeDot", () => {
  it("labels a normal session 'N' with a normal-session title", () => {
    render(<ModeDot mode="normal" />);
    const dot = screen.getByText("N");
    expect(dot).toBeInTheDocument();
    expect(dot.getAttribute("title")).toBe("Normal session");
  });

  it("labels an optimistic session 'O'", () => {
    render(<ModeDot mode="optimistic" />);
    const dot = screen.getByText("O");
    expect(dot).toBeInTheDocument();
    expect(dot.getAttribute("title")).toBe("Optimistic session");
  });

  it("labels a merged session with a check", () => {
    render(<ModeDot mode="merged" />);
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("renders no focus badge or label", () => {
    const { container: normal } = render(<ModeDot mode="normal" />);
    const { container: optimistic } = render(<ModeDot mode="optimistic" />);
    const { container: merged } = render(<ModeDot mode="merged" />);

    // The retired focus badge glyph and its title must not appear for any mode.
    for (const c of [normal, optimistic, merged]) {
      expect(c.textContent).not.toContain("★");
      expect(c.innerHTML).not.toContain("Focus session");
    }
    expect(screen.queryByTitle("Focus session")).toBeNull();
  });

  it("renders an em dash placeholder when mode is absent", () => {
    render(<ModeDot mode={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
