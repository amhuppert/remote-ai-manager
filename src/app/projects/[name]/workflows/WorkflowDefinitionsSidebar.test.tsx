// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";

const baseProps = {
  selectedId: null as string | null,
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  isLoading: false,
};

function getDot(): HTMLElement {
  const dots = document.querySelectorAll(".wb-def-item-dot");
  expect(dots.length).toBe(1);
  return dots[0] as HTMLElement;
}

describe("WorkflowDefinitionsSidebar dot indicator", () => {
  it("renders a green dot with 'All defaults' tooltip when no workflow or context overrides", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[
          {
            id: "wf-1",
            name: "All defaults",
            revision: 1,
            workflowConfig: {},
            executionContexts: [{}, {}],
          },
        ]}
      />,
    );
    const dot = getDot();
    expect(dot.classList.contains("wb-def-item-dot--default")).toBe(true);
    expect(dot.getAttribute("data-tooltip")).toBe("All defaults");
  });

  it("renders a green dot when workflowConfig/executionContexts are omitted entirely", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[{ id: "wf-1", name: "Bare", revision: 1 }]}
      />,
    );
    const dot = getDot();
    expect(dot.classList.contains("wb-def-item-dot--default")).toBe(true);
    expect(dot.getAttribute("data-tooltip")).toBe("All defaults");
  });

  it("renders a cyan dot with workflow-defaults tooltip when workflowConfig has keys and no per-context overrides", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[
          {
            id: "wf-2",
            name: "Workflow overrides",
            revision: 3,
            workflowConfig: {
              implementer: { backend: "claude", model: "opus" },
              iterationPolicy: { maxAttempts: 4 },
            },
            executionContexts: [{}, {}],
          },
        ]}
      />,
    );
    const dot = getDot();
    expect(dot.classList.contains("wb-def-item-dot--workflow")).toBe(true);
    expect(dot.getAttribute("data-tooltip")).toBe(
      "Custom workflow defaults (2 blocks overridden)",
    );
  });

  it("renders an amber dot with per-context tooltip when any context has overrides, even if workflowConfig also has keys", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[
          {
            id: "wf-3",
            name: "Context overrides",
            revision: 2,
            workflowConfig: { implementer: { backend: "codex" } },
            executionContexts: [
              {
                implementer: { backend: "claude" },
                iterationPolicy: { maxAttempts: 2 },
              },
              { mutability: { allowWrite: true } },
              {},
            ],
          },
        ]}
      />,
    );
    const dot = getDot();
    expect(dot.classList.contains("wb-def-item-dot--context")).toBe(true);
    expect(dot.getAttribute("data-tooltip")).toBe(
      "Custom per-context config (2 contexts, 3 overrides total)",
    );
  });

  it("renders the dot element with the correct BEM class variant", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[
          {
            id: "wf-4",
            name: "Dimensions",
            revision: 1,
            workflowConfig: { implementer: {} },
          },
        ]}
      />,
    );
    const dot = getDot();
    expect(dot.classList.contains("wb-def-item-dot")).toBe(true);
    expect(dot.classList.contains("wb-def-item-dot--workflow")).toBe(true);
  });

  it("CSS rules give .wb-def-item-dot width 6px and height 6px", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../../../globals.css"),
      "utf8",
    );
    const match = css.match(
      /\.wb-def-item-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;[^}]*\}/,
    );
    expect(match).not.toBeNull();
  });

  it("CSS rules define the three dot color variants", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../../../globals.css"),
      "utf8",
    );
    expect(
      /\.wb-def-item-dot--default\s*\{[^}]*background:\s*var\(--green\)/.test(
        css,
      ),
    ).toBe(true);
    expect(
      /\.wb-def-item-dot--workflow\s*\{[^}]*background:\s*var\(--cyan\)/.test(
        css,
      ),
    ).toBe(true);
    expect(
      /\.wb-def-item-dot--context\s*\{[^}]*background:\s*var\(--amber\)/.test(
        css,
      ),
    ).toBe(true);
  });

  it("places the dot after the revision chip within each row", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[{ id: "wf-5", name: "Order", revision: 7 }]}
      />,
    );
    const row = screen.getByRole("button", { name: /Order/ });
    const children = Array.from(row.children);
    const revisionIdx = children.findIndex((c) =>
      c.classList.contains("wb-def-revision"),
    );
    const dotIdx = children.findIndex((c) =>
      c.classList.contains("wb-def-item-dot"),
    );
    expect(revisionIdx).toBeGreaterThanOrEqual(0);
    expect(dotIdx).toBeGreaterThan(revisionIdx);
  });
});
