// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MermaidDiagram from "./MermaidDiagram";

// A real Mermaid render needs layout measurement (getBBox / text metrics) that
// jsdom does not implement, so `mermaid.render` rejects here. That drives the
// component down its genuine catch/fallback branch — the accessible error state
// the canonical engine must preserve — with no mocking of the mermaid library.
const DIAGRAM = "flowchart LR\n  Contract --> Renderer";

afterEach(cleanup);

describe("MermaidDiagram fallback and accessibility", () => {
  it("falls back to a labeled source block when rendering fails", async () => {
    const { container } = render(<MermaidDiagram code={DIAGRAM} />);

    await waitFor(
      () => {
        expect(
          container.querySelector(".mermaid-diagram--error"),
        ).not.toBeNull();
      },
      { timeout: 8000 },
    );

    expect(screen.getByText("Mermaid diagram error")).toBeInTheDocument();
    const fallback = container.querySelector(".mermaid-diagram-fallback");
    expect(fallback?.tagName).toBe("PRE");
    expect(fallback?.textContent).toContain("Contract --> Renderer");
  });
});
