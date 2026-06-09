// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import WorkflowInspectorPanel from "./WorkflowInspectorPanel";

const defaultProps = {
  onSave: vi.fn(async () => {}),
  onDelete: vi.fn(),
  saving: false,
};

function resetStore() {
  _useGraphWorkflowBuilderStore.setState({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    validationErrors: [],
  });
}

function setupStore(options?: {
  selectedContextId?: string | null;
  definition?: ReturnType<typeof createWorkflowDefinition>;
}) {
  const definition = options?.definition ?? createWorkflowDefinition();
  const layout = createWorkflowLayout();
  act(() => {
    _useGraphWorkflowBuilderStore.setState({
      draftDefinition: definition,
      draftLayout: layout,
      selectedContextId: options?.selectedContextId ?? null,
      dirty: false,
      validationErrors: [],
    });
  });
  return { definition, layout };
}

function getTabs(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll(".cc-tab"),
  ) as HTMLButtonElement[];
}

function findBlockByLabel(
  container: HTMLElement,
  label: string,
): HTMLElement | null {
  const blocks = container.querySelectorAll(".wb-inspector-block");
  for (const block of Array.from(blocks)) {
    const labelEl = block.querySelector(".cc-section-label");
    if (labelEl?.textContent === label) return block as HTMLElement;
  }
  return null;
}

function footButtons(block: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    block.querySelectorAll(".wb-inspector-block__foot button"),
  ) as HTMLButtonElement[];
}

describe("WorkflowInspectorPanel — persistent tab strip", () => {
  it("renders two tabs with Workflow active and Context disabled when no selection", () => {
    resetStore();
    setupStore({ selectedContextId: null });

    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);
    const tabs = getTabs(container);
    expect(tabs).toHaveLength(2);

    const [workflowTab, contextTab] = tabs as [
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    expect(workflowTab.textContent).toBe("Workflow");
    expect(workflowTab.className).toContain("active");
    expect(contextTab.textContent).toBe("Context");
    expect(contextTab.disabled).toBe(true);
    expect(contextTab.getAttribute("title")).toBe(
      "Select a context in the graph",
    );
  });

  it("renders Context tab label from selected context title and enables it", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });

    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);
    const tabs = getTabs(container);
    const contextTab = tabs[1]!;
    expect(contextTab.disabled).toBe(false);
    expect(contextTab.textContent).toBe("Context: Plan");
  });

  it("context selection switches the active tab to Context", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container, rerender } = render(
      <WorkflowInspectorPanel {...defaultProps} />,
    );
    expect(getTabs(container)[0]!.className).toContain("active");

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });
    rerender(<WorkflowInspectorPanel {...defaultProps} />);

    const [workflowTab, contextTab] = getTabs(container);
    expect(contextTab!.className).toContain("active");
    expect(workflowTab!.className).not.toContain("active");
  });

  it("clicking Workflow tab does not clear selection", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const workflowTab = getTabs(container)[0]!;
    fireEvent.click(workflowTab);
    expect(workflowTab.className).toContain("active");
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
  });
});

describe("WorkflowInspectorPanel — workflow tab body", () => {
  it("renders exactly seven InspectorConfigBlocks and no AC, tasks, or delete", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const blocks = container.querySelectorAll(".wb-inspector-block");
    expect(blocks).toHaveLength(7);
    const labels = Array.from(
      container.querySelectorAll(".cc-section-label"),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "Implementer",
      "Collaboration",
      "Context validator",
      "Script validator",
      "Iteration policy",
      "Circuit breaker",
      "Mutability",
    ]);

    expect(container.querySelector("#context-acceptance-criteria")).toBeNull();
    expect(container.querySelector(".wb-task-list")).toBeNull();
    expect(
      container.querySelector('[data-section="delete-context"]'),
    ).toBeNull();
  });

  it("clicking Override then Reset on a workflow block mutates workflowConfig", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const implementer = findBlockByLabel(container, "Implementer")!;
    fireEvent.click(
      footButtons(implementer).find((b) => b.textContent === "Override")!,
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .implementer,
    ).toBeDefined();

    const implementerAfter = findBlockByLabel(container, "Implementer")!;
    const resetBtn = footButtons(implementerAfter).find(
      (b) => b.textContent === "Reset to inherit",
    )!;
    fireEvent.click(resetBtn);

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .implementer,
    ).toBeUndefined();
  });

  it("clicking Override then Reset on the Collaboration block mutates workflowConfig.collaboration", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const collab = findBlockByLabel(container, "Collaboration")!;
    expect(collab.getAttribute("data-source")).toBe("global");
    fireEvent.click(
      footButtons(collab).find((b) => b.textContent === "Override")!,
    );

    const overridden =
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .collaboration;
    expect(overridden).toBeDefined();
    expect(overridden?.negotiationRounds).toBe(3);
    expect(overridden?.secondAgent).toEqual({
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    });

    const collabAfter = findBlockByLabel(container, "Collaboration")!;
    fireEvent.click(
      footButtons(collabAfter).find(
        (b) => b.textContent === "Reset to inherit",
      )!,
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .collaboration,
    ).toBeUndefined();
  });

  it("toggling the workflow script validator creates and resets a workflow override", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /workflow script validator/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .scriptValidator,
    ).toEqual({ enabled: true });

    const block = findBlockByLabel(container, "Script validator")!;
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Reset to inherit")!,
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .scriptValidator,
    ).toBeUndefined();
  });
});

describe("WorkflowInspectorPanel — context tab body", () => {
  it("renders AC header, seven blocks, tasks editor, and delete button", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      container.querySelector("#context-acceptance-criteria"),
    ).not.toBeNull();
    const blocks = container.querySelectorAll(".wb-inspector-block");
    expect(blocks).toHaveLength(7);

    expect(container.querySelector(".wb-task-list")).not.toBeNull();
    expect(
      container.querySelector('[data-section="delete-context"]'),
    ).not.toBeNull();
  });

  it("editing acceptance criteria updates the context in the store", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const textarea = container.querySelector(
      "#context-acceptance-criteria",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "Updated acceptance criteria." },
    });

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.acceptanceCriteria).toBe("Updated acceptance criteria.");
  });

  it("shows FieldError for empty-context-acceptance-criteria", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        validationErrors: [
          {
            code: "empty-context-acceptance-criteria",
            message: "Acceptance criteria is required",
            contextId: "context-plan",
          },
        ],
      });
    });

    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);
    const error = container.querySelector(".wb-field-error");
    expect(error?.textContent).toBe("Acceptance criteria is required");
  });

  it("override/reset on context iteration policy uses setContextBlockOverride/clearContextBlockOverride", () => {
    resetStore();
    const def = createWorkflowDefinition();
    const withoutPolicy = {
      ...def,
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? { ...ctx, iterationPolicy: undefined }
          : ctx,
      ),
    };
    setupStore({
      selectedContextId: "context-plan",
      definition: withoutPolicy,
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Iteration policy")!;
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Override")!,
    );

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.iterationPolicy).toBeDefined();

    const blockAfter = findBlockByLabel(container, "Iteration policy")!;
    fireEvent.click(
      footButtons(blockAfter).find(
        (b) => b.textContent === "Reset to inherit",
      )!,
    );
    const ctx2 = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx2?.iterationPolicy).toBeUndefined();
  });

  it("toggling the context script validator creates a context override", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /context script validator/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.scriptValidator).toEqual({ enabled: true });
  });
});

describe("WorkflowInspectorPanel — validator three-state footer", () => {
  it("inherited → Override creates a use-kind override, Disable creates disabled marker", () => {
    resetStore();
    const def = createWorkflowDefinition();
    const withoutValidator = {
      ...def,
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? { ...ctx, contextValidator: undefined }
          : ctx,
      ),
    };
    setupStore({
      selectedContextId: "context-plan",
      definition: withoutValidator,
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    const buttons = footButtons(block);
    const override = buttons.find((b) => b.textContent === "Override")!;
    const disable = buttons.find(
      (b) => b.textContent === "Disable for this context",
    )!;
    expect(override).toBeDefined();
    expect(disable).toBeDefined();

    fireEvent.click(override);
    let ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.contextValidator?.kind).toBe("use");

    // Reset back to inherit, then click Disable
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: withoutValidator,
      });
    });
    const block2 = findBlockByLabel(container, "Context validator")!;
    const disable2 = footButtons(block2).find(
      (b) => b.textContent === "Disable for this context",
    )!;
    fireEvent.click(disable2);

    ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.contextValidator?.kind).toBe("disabled");
  });

  it("overridden validator shows Reset to inherit + Disable for this context", () => {
    resetStore();
    const def = createWorkflowDefinition();
    const overridden = {
      ...def,
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              contextValidator: {
                kind: "use" as const,
                value: {
                  type: "claude" as const,
                  enabled: true,
                  continuity: { enabled: true },
                  agent: {
                    backend: "claude" as const,
                    model: "sonnet" as const,
                    reasoningEffort: "medium" as const,
                  },
                },
              },
            }
          : ctx,
      ),
    };
    setupStore({
      selectedContextId: "context-plan",
      definition: overridden,
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    const texts = footButtons(block).map((b) => b.textContent);
    expect(texts).toContain("Reset to inherit");
    expect(texts).toContain("Disable for this context");

    const reset = footButtons(block).find(
      (b) => b.textContent === "Reset to inherit",
    )!;
    fireEvent.click(reset);
    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.contextValidator).toBeUndefined();
  });

  it("disabled validator shows Re-enable (inherit) + Override with custom validator", () => {
    resetStore();
    const def = createWorkflowDefinition();
    const disabled = {
      ...def,
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              contextValidator: { kind: "disabled" as const },
            }
          : ctx,
      ),
    };
    setupStore({
      selectedContextId: "context-plan",
      definition: disabled,
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    const texts = footButtons(block).map((b) => b.textContent);
    expect(texts).toContain("Re-enable (inherit)");
    expect(texts).toContain("Override with custom validator");

    const reenable = footButtons(block).find(
      (b) => b.textContent === "Re-enable (inherit)",
    )!;
    fireEvent.click(reenable);
    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.contextValidator).toBeUndefined();
  });
});

describe("WorkflowInspectorPanel — schema shape assertions", () => {
  it("definition never contains legacy soft/hard limit fields", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });

    const def = _useGraphWorkflowBuilderStore.getState().draftDefinition;
    const ctx = def?.executionContexts[0];

    expect(ctx?.iterationPolicy?.continuity).toHaveProperty("enabled");
    const raw = ctx?.iterationPolicy as unknown as Record<string, unknown>;
    expect(raw).not.toHaveProperty("contextSoftLimitTokens");
    expect(raw).not.toHaveProperty("contextHardLimitTokens");
  });
});
