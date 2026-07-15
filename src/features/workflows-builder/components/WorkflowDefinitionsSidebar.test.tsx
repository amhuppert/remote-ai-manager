// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";

const baseProps = {
  selectedId: null as string | null,
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  isLoading: false,
};

// The override-source indicator is rendered as role="img" with its meaning
// carried by aria-label (its accessible name; the WithTooltip hover label mirrors
// it, and the visual color is a styling concern).
function getDot(): HTMLElement {
  const dots = document.querySelectorAll('[role="img"]');
  expect(dots.length).toBe(1);
  return dots[0] as HTMLElement;
}

describe("WorkflowDefinitionsSidebar dot indicator", () => {
  it("shows the 'All defaults' tooltip when no workflow or context overrides", () => {
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
    expect(getDot().getAttribute("aria-label")).toBe("All defaults");
  });

  it("shows the 'All defaults' tooltip when workflowConfig/executionContexts are omitted entirely", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[{ id: "wf-1", name: "Bare", revision: 1 }]}
      />,
    );
    expect(getDot().getAttribute("aria-label")).toBe("All defaults");
  });

  it("shows the workflow-defaults tooltip when workflowConfig has keys and no per-context overrides", () => {
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
    expect(getDot().getAttribute("aria-label")).toBe(
      "Custom workflow defaults (2 blocks overridden)",
    );
  });

  it("shows the per-context tooltip when any context has overrides, even if workflowConfig also has keys", () => {
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
    expect(getDot().getAttribute("aria-label")).toBe(
      "Custom per-context config (2 contexts, 3 overrides total)",
    );
  });

  it("shows Creating… and disables the create button while creation is in flight", () => {
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={[]} isCreating />,
    );
    const createBtn = screen.getByRole("button", { name: /creating…/i });
    expect(createBtn).toBeDisabled();
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
      c.textContent?.includes("r7"),
    );
    const dotIdx = children.findIndex((c) => c.getAttribute("role") === "img");
    expect(revisionIdx).toBeGreaterThanOrEqual(0);
    expect(dotIdx).toBeGreaterThan(revisionIdx);
  });
});
