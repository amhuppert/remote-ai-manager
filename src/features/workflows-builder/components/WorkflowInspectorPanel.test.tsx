// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import WorkflowInspectorPanel from "./WorkflowInspectorPanel";

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

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
    container.querySelectorAll('[role="tab"]'),
  ) as HTMLButtonElement[];
}

function findBlockByLabel(
  container: HTMLElement,
  label: string,
): HTMLElement | null {
  const blocks = container.querySelectorAll("[data-source]");
  for (const block of Array.from(blocks)) {
    const labelEl = block.querySelector("[data-section-label]");
    if (labelEl?.textContent === label) return block as HTMLElement;
  }
  return null;
}

// The block's foot holds the action Buttons; the only other <button> in a block
// is the collapse header (carries aria-expanded). Exclude it.
function footButtons(block: HTMLElement): HTMLButtonElement[] {
  return Array.from(block.querySelectorAll("button")).filter(
    (b) => !b.hasAttribute("aria-expanded"),
  ) as HTMLButtonElement[];
}

// Inherited blocks render collapsed and the Radix-backed disclosure unmounts the
// closed body (footer included). Expand before reading footer buttons; a no-op if
// already open.
function expandBlock(block: HTMLElement): HTMLElement {
  const head = block.querySelector<HTMLElement>(
    "button[aria-expanded='false']",
  );
  if (head) fireEvent.click(head);
  return block;
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
    expect(workflowTab.getAttribute("aria-selected")).toBe("true");
    expect(contextTab.textContent).toBe("Context");
    expect(contextTab.disabled).toBe(true);
    expect(contextTab.getAttribute("title")).toBe(
      "Select a context in the graph",
    );
  });

  it("enables the Context tab and shows the selected context title in the header", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });

    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);
    const tabs = getTabs(container);
    const contextTab = tabs[1]!;
    expect(contextTab.disabled).toBe(false);
    expect(contextTab.textContent).toBe("Context");
    // The selected context's title renders next to the tab strip.
    const header = container.querySelector("header");
    expect(header?.textContent).toContain("Plan");
  });

  it("context selection switches the active tab to Context", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container, rerender } = render(
      <WorkflowInspectorPanel {...defaultProps} />,
    );
    expect(getTabs(container)[0]!.getAttribute("aria-selected")).toBe("true");

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });
    rerender(<WorkflowInspectorPanel {...defaultProps} />);

    const [workflowTab, contextTab] = getTabs(container);
    expect(contextTab!.getAttribute("aria-selected")).toBe("true");
    expect(workflowTab!.getAttribute("aria-selected")).toBe("false");
  });

  it("clicking Workflow tab does not clear selection", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const workflowTab = getTabs(container)[0]!;
    // Radix Tabs.Trigger activates on mousedown/focus (APG automatic
    // activation), not on a bare synthetic click event.
    fireEvent.mouseDown(workflowTab);
    expect(workflowTab.getAttribute("aria-selected")).toBe("true");
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
  });
});

describe("WorkflowInspectorPanel — Radix tabpanel wiring", () => {
  it("wires the active tab to a role=tabpanel via aria-controls", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const workflowTab = getTabs(container)[0]!;
    expect(workflowTab.getAttribute("aria-selected")).toBe("true");
    const controls = workflowTab.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const panel = document.getElementById(controls!);
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("role")).toBe("tabpanel");
  });
});

describe("WorkflowInspectorPanel — workflow tab body", () => {
  it("renders exactly nine InspectorConfigBlocks and no AC, tasks, or delete", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const blocks = container.querySelectorAll("[data-source]");
    expect(blocks).toHaveLength(9);
    const labels = Array.from(
      container.querySelectorAll("[data-section-label]"),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "Implementer",
      "Collaboration",
      "Context validator",
      "Script validator",
      "Human approval gate",
      "Ask user questions",
      "Iteration policy",
      "Circuit breaker",
      "Agent task add",
    ]);

    expect(
      screen.queryByRole("button", { name: "Edit acceptance criteria" }),
    ).toBeNull();
    expect(container.querySelector('[data-section="tasks"]')).toBeNull();
    expect(
      container.querySelector('[data-section="delete-context"]'),
    ).toBeNull();
  });

  it("clicking Override then Reset on a workflow block mutates workflowConfig", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const implementer = expandBlock(
      findBlockByLabel(container, "Implementer")!,
    );
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

    const collab = expandBlock(findBlockByLabel(container, "Collaboration")!);
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

  it("toggling the workflow human approval gate creates and resets a workflow override", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /workflow human approval gate/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .humanApprovalGate,
    ).toEqual({ enabled: true });

    const block = findBlockByLabel(container, "Human approval gate")!;
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Reset to inherit")!,
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .humanApprovalGate,
    ).toBeUndefined();
  });

  it("toggling the workflow ask-user-questions gate creates and resets a workflow override", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /workflow ask user questions/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .askUserQuestions,
    ).toEqual({ enabled: true });

    const block = findBlockByLabel(container, "Ask user questions")!;
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Reset to inherit")!,
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .askUserQuestions,
    ).toBeUndefined();
  });
});

describe("WorkflowInspectorPanel — launch parameters editor", () => {
  it("binds the editor to draftDefinition.parameters", () => {
    resetStore();
    const def = createWorkflowDefinition();
    setupStore({
      selectedContextId: null,
      definition: {
        ...def,
        parameters: [
          {
            type: "string",
            name: "feature",
            label: "Feature name",
            required: true,
          },
        ],
      },
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    // The declared parameter's label value renders in its Label input.
    const labelInput = screen.getByDisplayValue("Feature name");
    expect(labelInput).toBeInTheDocument();
  });

  it("editing a parameter field writes the declarations onto the draft definition", () => {
    resetStore();
    setupStore({ selectedContextId: null });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    // Start from zero parameters → add one.
    fireEvent.click(screen.getByRole("button", { name: /add parameter/i }));

    const params =
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.parameters;
    expect(params).toHaveLength(1);
    expect(params?.[0]).toMatchObject({ type: "string", name: "", label: "" });
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);

    // Type a name into the new parameter's Name field.
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "feature" } });

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.parameters?.[0]
        ?.name,
    ).toBe("feature");
  });

  it("surfaces a save validation error for an undeclared reference as the editor saveError", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        validationErrors: [
          {
            code: "undeclared-parameter-reference",
            message:
              'Field "charter.mission" references undeclared parameter "feature"',
            field: "charter.mission",
            parameterName: "feature",
          },
        ],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      screen.getByText(
        'Field "charter.mission" references undeclared parameter "feature"',
      ),
    ).toBeInTheDocument();
  });
});

describe("WorkflowInspectorPanel — context tab body", () => {
  it("renders AC read view, nine blocks, tasks editor, and delete button", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: "Edit acceptance criteria" }),
    ).toBeInTheDocument();
    const blocks = container.querySelectorAll("[data-source]");
    expect(blocks).toHaveLength(9);

    expect(container.querySelector('[data-section="tasks"]')).not.toBeNull();
    expect(
      container.querySelector('[data-section="delete-context"]'),
    ).not.toBeNull();
  });

  it("renders the acceptance-criteria read view through the compact canonical adapter", async () => {
    resetStore();
    const definition = createWorkflowDefinition();
    const ctx = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    );
    if (ctx) ctx.acceptanceCriteria = "Ship ~~drafts~~ **canonical** rendering";
    setupStore({ selectedContextId: "context-plan", definition });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    // GFM strikethrough — only the canonical renderer produces <del>.
    const del = await screen.findByText("drafts", undefined, {
      timeout: 15000,
    });
    expect(del.tagName).toBe("DEL");
    expect(del.closest('[data-markdown-intent="compact"]')).not.toBeNull();
    expect(container.querySelector(".wb-markdown-inline")).toBeNull();
  });

  it("editing acceptance criteria through the focus sheet updates the store", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    // The focus sheet (and its textarea) mounts on demand from the read view.
    expect(container.querySelector("#context-acceptance-criteria")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /edit in focus view/i }),
    );

    const textarea = document.getElementById(
      "context-acceptance-criteria",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, {
      target: { value: "Updated acceptance criteria." },
    });

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.acceptanceCriteria).toBe("Updated acceptance criteria.");
  });

  it("editing the description through the focus sheet updates the store", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));

    const textarea = document.getElementById(
      "context-description",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, { target: { value: "A new description." } });

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.description).toBe("A new description.");
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

    render(<WorkflowInspectorPanel {...defaultProps} />);
    expect(
      screen.getByText("Acceptance criteria is required"),
    ).toBeInTheDocument();
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

    const block = expandBlock(findBlockByLabel(container, "Iteration policy")!);
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

  it("toggling the context human approval gate creates a context override", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /context human approval gate/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.humanApprovalGate).toEqual({ enabled: true });
  });

  it("toggling the context ask-user-questions gate creates a context override", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: /context ask user questions/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.askUserQuestions).toEqual({ enabled: true });
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

    const block = expandBlock(
      findBlockByLabel(container, "Context validator")!,
    );
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
