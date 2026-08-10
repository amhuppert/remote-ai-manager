// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { installFetchFixture } from "@/test/fetch-fixture";
import WorkflowInspectorPanel from "./WorkflowInspectorPanel";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";

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
//
// The disclosure trigger is identified by the section label it wraps, not by
// `aria-expanded` alone: an expanded body contains comboboxes (the profile
// picker) that carry the same attribute, and clicking one of those would open a
// Radix listbox that hides the rest of the tree from the accessibility tree.
function expandBlock(block: HTMLElement): HTMLElement {
  const head = Array.from(
    block.querySelectorAll<HTMLElement>("button[aria-expanded='false']"),
  ).find((candidate) => candidate.querySelector("[data-section-label]"));
  if (head) fireEvent.click(head);
  return block;
}

describe("WorkflowInspectorPanel — persistent tab strip", () => {
  it("tracks selection across its accessible Workflow and Context tabs", () => {
    resetStore();
    setupStore({ selectedContextId: null });

    const { container, rerender } = render(
      <WorkflowInspectorPanel {...defaultProps} />,
    );
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
    const workflowControls = workflowTab.getAttribute("aria-controls");
    expect(workflowControls).toBeTruthy();
    expect(document.getElementById(workflowControls!)).toHaveAttribute(
      "role",
      "tabpanel",
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });
    rerender(<WorkflowInspectorPanel {...defaultProps} />);

    const [selectedWorkflowTab, selectedContextTab] = getTabs(container);
    expect(selectedContextTab!.disabled).toBe(false);
    expect(selectedContextTab!.getAttribute("aria-selected")).toBe("true");
    expect(selectedWorkflowTab!.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector("header")?.textContent).toContain("Plan");

    // Radix Tabs.Trigger activates on mousedown/focus (APG automatic
    // activation), not on a bare synthetic click event.
    fireEvent.mouseDown(selectedWorkflowTab!);
    expect(selectedWorkflowTab!.getAttribute("aria-selected")).toBe("true");
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
  });
});

describe("WorkflowInspectorPanel — workflow tab body", () => {
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

  it("uses a default-off header switch to create a workflow collaboration override", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: "Workflow collaboration enabled",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(findBlockByLabel(container, "Collaboration")?.textContent).toContain(
      "off",
    );

    fireEvent.click(toggle);

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .collaboration,
    ).toHaveProperty("enabled", true);
  });

  it("creates and resets each workflow gate override", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const gates = [
      {
        name: /workflow human approval gate/i,
        label: "Human approval gate",
        read: () =>
          _useGraphWorkflowBuilderStore.getState().draftDefinition
            ?.workflowConfig.humanApprovalGate,
      },
      {
        name: /workflow ask user questions/i,
        label: "Ask user questions",
        read: () =>
          _useGraphWorkflowBuilderStore.getState().draftDefinition
            ?.workflowConfig.askUserQuestions,
      },
    ];

    for (const gate of gates) {
      const toggle = screen.getByRole("switch", { name: gate.name });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
      expect(gate.read()).toEqual({ enabled: true });

      const block = findBlockByLabel(container, gate.label)!;
      fireEvent.click(
        footButtons(block).find((b) => b.textContent === "Reset to inherit")!,
      );
      expect(gate.read()).toBeUndefined();
    }
  });

  it("uses command selection instead of a workflow Script validator switch", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Script validator")!;
    expect(within(block).queryByRole("switch")).not.toBeInTheDocument();
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

  it("override/reset on context plan repair writes and clears context.planRepair", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = expandBlock(findBlockByLabel(container, "Plan repair")!);
    expect(block.getAttribute("data-source")).toBe("global");
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Override")!,
    );

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    // The override snapshots the effective (inherited) policy.
    expect(ctx?.planRepair).toEqual({
      enabled: true,
      maxAttemptsPerContext: 2,
    });

    const blockAfter = findBlockByLabel(container, "Plan repair")!;
    fireEvent.click(
      footButtons(blockAfter).find(
        (b) => b.textContent === "Reset to inherit",
      )!,
    );
    const ctx2 = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx2?.planRepair).toBeUndefined();
  });

  it("creates each boolean context gate override", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    for (const name of [
      /context human approval gate/i,
      /context ask user questions/i,
    ]) {
      const toggle = screen.getByRole("switch", { name });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
    }

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.humanApprovalGate).toEqual({ enabled: true });
    expect(ctx?.askUserQuestions).toEqual({ enabled: true });
  });

  it("uses command selection instead of a context Script validator switch", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Script validator")!;
    expect(within(block).queryByRole("switch")).not.toBeInTheDocument();
  });

  /**
   * The mutability block carries two flags and the inspector surfaces one. An
   * editor that rebuilt the block from the flag it renders would silently strip
   * a context's runtime graph-expansion authority the next time anyone touched
   * the task-add switch (D4 R7.1) — pinned on both tiers the inspector edits.
   */
  it("preserves allowAgentContextAdd when the context task-add switch is toggled", () => {
    resetStore();
    const definition = createWorkflowDefinition();
    const plan = definition.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    if (plan) {
      plan.mutability = { allowAgentTaskAdd: true, allowAgentContextAdd: true };
    }
    setupStore({ selectedContextId: "context-plan", definition });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.click(
      screen.getByRole("switch", { name: "Allow agent task add" }),
    );

    expect(
      _useGraphWorkflowBuilderStore
        .getState()
        .draftDefinition?.executionContexts.find(
          (context) => context.id === "context-plan",
        )?.mutability,
    ).toEqual({ allowAgentTaskAdd: false, allowAgentContextAdd: true });
  });

  it("preserves allowAgentContextAdd when the workflow-tier task-add switch is toggled", () => {
    resetStore();
    const definition = createWorkflowDefinition();
    definition.workflowConfig = {
      mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
    };
    setupStore({ selectedContextId: null, definition });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.click(
      screen.getByRole("switch", { name: "Allow agent task add" }),
    );

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .mutability,
    ).toEqual({ allowAgentTaskAdd: true, allowAgentContextAdd: true });
  });

  it("creates a context collaboration override from the header switch", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: "Context collaboration enabled",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    const context = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find(
        (candidate) => candidate.id === "context-plan",
      );
    expect(context?.collaboration).toHaveProperty("enabled", true);
  });
});

describe("WorkflowInspectorPanel — validator cohort override footer", () => {
  // Turning validation off is a property of the cohort VALUE (`enabled:false`),
  // not a third cascade state, so the footer is the same two-state
  // Override/Reset every other block uses and the header switch carries on/off.
  const OVERRIDE_COHORT = {
    enabled: true,
    assignments: [
      {
        id: "security" as const,
        profile: { tier: "builtin" as const, id: "general-reviewer" },
        strategy: "conversation" as const,
        authority: "blocking" as const,
        agent: {
          backend: "claude" as const,
          model: "sonnet" as const,
          reasoningEffort: "medium" as const,
        },
        continuity: { enabled: true },
      },
    ],
  };

  function definitionWithPlanValidator(
    cohort: typeof OVERRIDE_COHORT | undefined,
  ) {
    const def = createWorkflowDefinition();
    return {
      ...def,
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan" ? { ...ctx, contextValidator: cohort } : ctx,
      ),
    };
  }

  it("Override pins the inherited cohort onto the context as a whole unit", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: definitionWithPlanValidator(undefined),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = expandBlock(
      findBlockByLabel(container, "Context validator")!,
    );
    const override = footButtons(block).find(
      (b) => b.textContent === "Override",
    )!;
    fireEvent.click(override);

    expect(planContext()?.contextValidator).toEqual(
      SEEDED_WORKFLOW_DEFAULTS.contextValidator,
    );
  });

  it("the header switch turns the cohort off while keeping its assignments", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: definitionWithPlanValidator(OVERRIDE_COHORT),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    fireEvent.click(within(block).getByLabelText("Context validator enabled"));

    expect(planContext()?.contextValidator).toEqual({
      enabled: false,
      assignments: OVERRIDE_COHORT.assignments,
    });
  });

  it("Reset to inherit drops the context override entirely", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: definitionWithPlanValidator(OVERRIDE_COHORT),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    const texts = footButtons(block).map((b) => b.textContent);
    expect(texts).toContain("Reset to inherit");
    expect(texts).not.toContain("Disable for this context");

    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Reset to inherit")!,
    );

    expect(planContext()?.contextValidator).toBeUndefined();
  });

  it("edits a validator's instructions through the shared editor", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: definitionWithPlanValidator(OVERRIDE_COHORT),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Context validator")!;
    fireEvent.change(within(block).getByLabelText("Mandate for security"), {
      target: { value: "auth boundaries" },
    });

    expect(planContext()?.contextValidator?.assignments[0]?.focus).toBe(
      "auth boundaries",
    );
  });
});

describe("WorkflowInspectorPanel — validation command selectors", () => {
  // The selected-name lists live inside a role section; scope queries to it so
  // the two roles' identical mode radios cannot collide.
  function roleSection(
    block: HTMLElement,
    role: "implementer" | "contextValidator",
  ): HTMLElement {
    const section = block.querySelector(`[data-role="${role}"]`);
    if (!(section instanceof HTMLElement)) {
      throw new Error(`No ${role} role section rendered`);
    }
    return section;
  }

  it("renders the workflow lane-merge block with strategy plus command selection", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    // The fixture definition carries a workflow-tier laneMergeValidation
    // override, so the block reads as overridden and opens by default.
    const block = findBlockByLabel(container, "Lane-merge validation")!;
    expect(block.getAttribute("data-source")).toBe("context-override");
    expect(
      within(block).getByRole("radio", { name: "final-only" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(block).getByRole("radio", { name: "Project default" }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(block).getByRole("radio", { name: "every-merge" }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .laneMergeValidation,
    ).toEqual({
      strategy: "every-merge",
      commands: { mode: "project" },
    });
  });

  it("switches lane-merge commands to a custom list while preserving the strategy leaf", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Lane-merge validation")!;
    fireEvent.click(within(block).getByRole("radio", { name: "Custom list" }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .laneMergeValidation,
    ).toEqual({
      strategy: "final-only",
      commands: { mode: "only", commands: [] },
    });
    // {mode:"only", commands: []} means lane-merge validation is disabled.
    expect(block.textContent).toContain(
      "Empty list — lane-merge validation is disabled.",
    );
  });

  it("keeps lane-merge validation out of the context override UI", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(container.querySelector('[data-scope="context"]')).not.toBeNull();
    expect(findBlockByLabel(container, "Lane-merge validation")).toBeNull();
  });

  it("adds a command to the workflow script validator's ordered list", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = findBlockByLabel(container, "Script validator")!;
    fireEvent.change(
      within(block).getByLabelText("Add script validator command"),
      { target: { value: "typecheck" } },
    );
    fireEvent.click(within(block).getByRole("button", { name: "Add" }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .scriptValidator,
    ).toEqual({ commands: ["typecheck"] });

    // Removing the last command keeps `commands: []` (explicitly-off): the
    // empty selection must round-trip, never collapse to legacy-on.
    fireEvent.click(
      within(block).getByRole("button", { name: "Remove typecheck" }),
    );
    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
        .scriptValidator,
    ).toEqual({ commands: [] });
  });

  it("feeds the registry into a command multi-select when the endpoint responds", async () => {
    const api = installFetchFixture();
    try {
      api.json("GET", "/api/validation-commands", {
        projects: [
          {
            projectName: "alpha",
            commands: [
              {
                name: "typecheck",
                cost: 2,
                pathArgs: "forbid",
                changedScope: "full_fallback",
              },
              {
                name: "test",
                cost: 4,
                pathArgs: "paths",
                changedScope: "native",
              },
            ],
          },
        ],
      });
      resetStore();
      setupStore({ selectedContextId: null });
      const { container } = render(
        <WorkflowInspectorPanel {...defaultProps} projectName="alpha" />,
      );

      const block = findBlockByLabel(container, "Script validator")!;
      // Registry loaded → checkboxes replace the free-form add input.
      const checkbox = await within(block).findByRole("checkbox", {
        name: "typecheck",
      });
      expect(
        within(block).queryByLabelText("Add script validator command"),
      ).not.toBeInTheDocument();

      fireEvent.click(checkbox);
      expect(
        _useGraphWorkflowBuilderStore.getState().draftDefinition?.workflowConfig
          .scriptValidator,
      ).toEqual({ commands: ["typecheck"] });
    } finally {
      api.restore();
    }
  });

  it("editing a context role selector writes only that role into the override", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = expandBlock(findBlockByLabel(container, "Agent validation")!);
    expect(block.getAttribute("data-source")).toBe("global");

    fireEvent.click(
      within(roleSection(block, "implementer")).getByRole("radio", {
        name: "Only",
      }),
    );

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    // Per-leaf: contextValidator stays absent so it keeps inheriting.
    expect(ctx?.agentValidation).toEqual({
      implementer: { mode: "only", commands: [] },
    });
  });

  it("shows per-role provenance for global, workflow, and context sources", () => {
    resetStore();
    const def = createWorkflowDefinition();
    const layered = {
      ...def,
      workflowConfig: {
        ...def.workflowConfig,
        agentValidation: {
          contextValidator: { mode: "only" as const, commands: [] },
        },
      },
      executionContexts: def.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              agentValidation: {
                implementer: { mode: "only" as const, commands: [] },
              },
            }
          : ctx,
      ),
    };
    setupStore({ selectedContextId: "context-plan", definition: layered });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    // The context override marks the block overridden, so it opens by default.
    const block = findBlockByLabel(container, "Agent validation")!;
    expect(block.getAttribute("data-source")).toBe("context-override");
    expect(
      within(block).getByTestId("agent-validation-source-implementer"),
    ).toHaveTextContent("Context");
    expect(
      within(block).getByTestId("agent-validation-source-context-validator"),
    ).toHaveTextContent("Workflow");

    // A context with neither tier configured resolves both roles to global.
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-verify",
        draftDefinition: {
          ...layered,
          workflowConfig: { ...def.workflowConfig },
        },
      });
    });
    const globalBlock = expandBlock(
      findBlockByLabel(container, "Agent validation")!,
    );
    expect(
      within(globalBlock).getByTestId("agent-validation-source-implementer"),
    ).toHaveTextContent("Global");
    expect(
      within(globalBlock).getByTestId(
        "agent-validation-source-context-validator",
      ),
    ).toHaveTextContent("Global");
  });
});

// A context carrying nothing the cascade resolves — so the resolved-setup
// strip's override count is 0 and any drift caused by outputSchema is visible.
function bareContextDefinition(
  outputSchema?: Record<string, unknown>,
): ReturnType<typeof createWorkflowDefinition> {
  const base = createWorkflowDefinition();
  return {
    ...base,
    executionContexts: [
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Plan is documented",
        placement: { lane: "context-plan", mode: "full" },
        ...(outputSchema ? { outputSchema } : {}),
      },
    ],
    tasks: base.tasks.filter((task) => task.contextId === "context-plan"),
    edges: [],
  };
}

function schemaTextarea(): HTMLTextAreaElement {
  const element = screen.getByLabelText("Output schema JSON");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("The output schema editor is not a textarea");
  }
  return element;
}

// The resolved-setup strip carries no role or accessible name of its own, so it
// is addressed by section marker and narrowed rather than asserted.
function resolvedSetupStrip(container: HTMLElement): HTMLElement {
  const strip = container.querySelector('[data-section="resolved-setup"]');
  if (!(strip instanceof HTMLElement)) {
    throw new Error("No resolved-setup strip rendered");
  }
  return strip;
}

function planContext() {
  return _useGraphWorkflowBuilderStore
    .getState()
    .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
}

describe("WorkflowInspectorPanel — context output schema", () => {
  // R7.1: the field flattens to and diffs into the saved-tier context update.
  it("writes a valid edited schema into the draft definition", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: bareContextDefinition({ type: "object" }),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const field = screen.getByTestId("output-schema-field");
    const brief = container.querySelector('[data-section="header"]');
    if (!(brief instanceof HTMLElement)) {
      throw new Error("No Brief group rendered");
    }
    expect(brief.contains(field)).toBe(true);
    expect(field.closest("[data-source]")).toBeNull();
    expect(within(field).queryByRole("switch")).not.toBeInTheDocument();

    fireEvent.change(schemaTextarea(), {
      target: {
        value:
          '{ "type": "object", "properties": { "verdict": { "type": "string" } } }',
      },
    });

    expect(planContext()?.outputSchema).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
    });
  });

  it("leaves the draft definition untouched while the text is invalid", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: bareContextDefinition({ type: "object" }),
    });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.change(schemaTextarea(), { target: { value: '{ "type": ' } });

    expect(planContext()?.outputSchema).toEqual({ type: "object" });
    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "invalid-json",
    );
  });

  // R7.4: the header Save is blocked while the schema text cannot be accepted.
  it("disables the header Save while the schema text is invalid", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: bareContextDefinition({ type: "object" }),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    fireEvent.change(schemaTextarea(), { target: { value: "{ oops" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(schemaTextarea(), {
      target: { value: '{ "type": "object" }' },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  // R7.4: neutral Schema chip in the resolved-setup strip, only when set.
  it("shows the Schema chip in the resolved-setup strip only when a schema is set", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: bareContextDefinition(),
    });
    const { container, rerender } = render(
      <WorkflowInspectorPanel {...defaultProps} />,
    );

    const strip = () => resolvedSetupStrip(container);
    expect(within(strip()).queryByText("Schema")).not.toBeInTheDocument();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: bareContextDefinition({ type: "object" }),
      });
    });
    rerender(<WorkflowInspectorPanel {...defaultProps} />);
    expect(within(strip()).getByText("Schema")).toBeInTheDocument();
  });

  // R7.4: outputSchema is identity, not a cascade source — it must never move
  // the override readout.
  it("excludes outputSchema from the context override count", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: bareContextDefinition({ type: "object" }),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      within(resolvedSetupStrip(container)).getByText("0 overrides"),
    ).toBeInTheDocument();
  });
});

// R7.8: the builder's rows are DEFINITION-derived — the author sees what the
// context will receive before anything runs.
describe("WorkflowInspectorPanel — upstream inputs", () => {
  function definitionWithPlanSchema() {
    const base = createWorkflowDefinition();
    return {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  risks: { type: "array", items: { type: "string" } },
                },
                required: ["summary"],
              },
            }
          : context,
      ),
    };
  }

  it("lists the selected context's direct predecessors in the Brief group", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-implement",
      definition: definitionWithPlanSchema(),
    });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = screen.getByTestId("upstream-inputs");
    const brief = container.querySelector('[data-section="header"]');
    if (!(brief instanceof HTMLElement)) {
      throw new Error("No Brief group rendered");
    }
    expect(brief.contains(block)).toBe(true);

    const rows = within(block).getAllByTestId("upstream-input-row");
    expect(rows.map((row) => row.dataset.contextId)).toEqual(["context-plan"]);
    expect(
      within(rows[0]!)
        .getAllByTestId("upstream-input-field")
        .map((chip) => chip.textContent),
    ).toEqual(["summary", "risks"]);
    // Nothing has run, so no definition-tier row can claim a captured output.
    expect(rows[0]!.dataset.captured).toBe("false");
  });

  it("omits the block entirely for a root context", () => {
    resetStore();
    setupStore({
      selectedContextId: "context-plan",
      definition: definitionWithPlanSchema(),
    });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(screen.queryByTestId("upstream-inputs")).toBeNull();
  });

  it("follows the graph as edges change, without a component change", () => {
    resetStore();
    const definition = definitionWithPlanSchema();
    setupStore({
      selectedContextId: "context-verify",
      definition,
    });
    const { rerender } = render(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      screen
        .getAllByTestId("upstream-input-row")
        .map((row) => row.dataset.contextId),
    ).toEqual(["context-implement"]);

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: {
          ...definition,
          edges: [
            ...definition.edges,
            {
              id: "edge-plan-verify",
              sourceContextId: "context-plan",
              targetContextId: "context-verify",
            },
          ],
        },
      });
    });
    rerender(<WorkflowInspectorPanel {...defaultProps} />);

    expect(
      screen
        .getAllByTestId("upstream-input-row")
        .map((row) => row.dataset.contextId),
    ).toEqual(["context-plan", "context-implement"]);
  });
});

/**
 * The cohort editor on the workflow-DEFINITION surface (R12.1). The same
 * component is asserted on the Settings surface in
 * `src/features/config/sections/WorkflowSection.test.tsx`; between them they
 * cover every cascade state a cohort can be in.
 */
describe("WorkflowInspectorPanel — validator cohort editor", () => {
  function cohortBlock(container: HTMLElement): HTMLElement {
    return expandBlock(findBlockByLabel(container, "Context validator")!);
  }

  function renderContextTab() {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    return render(<WorkflowInspectorPanel {...defaultProps} />);
  }

  function overrideCohort(container: HTMLElement): HTMLElement {
    const block = cohortBlock(container);
    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Override")!,
    );
    return cohortBlock(container);
  }

  function contextCohort() {
    const context = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition!.executionContexts.find((c) => c.id === "context-plan")!;
    return context.contextValidator;
  }

  it("adds a second validator and reorders the cohort", () => {
    const { container } = renderContextTab();
    fireEvent.click(
      within(overrideCohort(container)).getByRole("button", {
        name: "Add validator",
      }),
    );
    const added = contextCohort()!.assignments.map((a) => a.id);
    expect(added).toHaveLength(2);
    expect(added[0]).toBe("general");

    fireEvent.click(
      within(cohortBlock(container)).getByLabelText(`Move ${added[1]} up`),
    );
    expect(contextCohort()!.assignments.map((a) => a.id)).toEqual([
      added[1],
      added[0],
    ]);
  });

  it("edits one assignment's instructions and runtime", () => {
    const { container } = renderContextTab();
    const block = overrideCohort(container);

    // The seeded seat is blocking, so its instructions field reads as the
    // assignment's mandate (R12.2).
    fireEvent.change(within(block).getByLabelText("Mandate for general"), {
      target: { value: "auth boundaries" },
    });
    expect(contextCohort()!.assignments[0]?.focus).toBe("auth boundaries");

    fireEvent.click(
      within(within(block).getByTestId("cohort-assignment-general")).getByRole(
        "button",
        { name: /codex/i },
      ),
    );
    expect(contextCohort()!.assignments[0]?.agent.backend).toBe("codex");
  });

  it("authors the cohort on the workflow tab too", () => {
    resetStore();
    setupStore({ selectedContextId: null });
    const { container } = render(<WorkflowInspectorPanel {...defaultProps} />);

    const block = expandBlock(
      findBlockByLabel(container, "Context validator")!,
    );
    expect(within(block).getByTestId("cohort-cascade")).toHaveAttribute(
      "data-cascade-state",
      "inherit",
    );

    fireEvent.click(
      footButtons(block).find((b) => b.textContent === "Override")!,
    );
    const overridden = expandBlock(
      findBlockByLabel(container, "Context validator")!,
    );
    fireEvent.click(
      within(overridden).getByRole("button", { name: "Add validator" }),
    );

    const workflowCohort =
      _useGraphWorkflowBuilderStore.getState().draftDefinition!.workflowConfig
        .contextValidator;
    expect(workflowCohort?.assignments).toHaveLength(2);
  });
});

describe("WorkflowInspectorPanel — lane placement (lwp R1)", () => {
  function selectedPlacement() {
    return _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan")
      ?.placement;
  }

  it("shows the authored lane and grade rather than inferring them from the context id", () => {
    resetStore();
    const definition = createWorkflowDefinition();
    const planned = definition.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            placement: {
              lane: "delivery",
              mode: "owned" as const,
              ownedPaths: ["docs"],
            },
          }
        : context,
    );
    setupStore({
      selectedContextId: "context-plan",
      definition: { ...definition, executionContexts: planned },
    });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const editor = screen.getByTestId("placement-editor");
    expect(within(editor).getByLabelText("Lane name")).toHaveValue("delivery");
    expect(within(editor).getByText("docs")).toBeInTheDocument();
  });

  it("authors a lane rename into the draft definition", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Lane name"), {
      target: { value: "delivery" },
    });

    expect(selectedPlacement()).toEqual({ lane: "delivery", mode: "full" });
  });

  it("authors an owning grade and its owned paths", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.click(screen.getByRole("radio", { name: "Owning" }));
    expect(selectedPlacement()).toEqual({
      lane: "plan",
      mode: "owned",
      ownedPaths: [],
    });
    // An owning grade with no paths is incomplete, and the editor says so
    // rather than letting the author push a definition the gate would refuse.
    expect(screen.getByTestId("placement-issue")).toBeInTheDocument();

    const editor = screen.getByTestId("placement-editor");
    fireEvent.change(within(editor).getByLabelText("Add owned path"), {
      target: { value: "src/feature" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));

    expect(selectedPlacement()).toEqual({
      lane: "plan",
      mode: "owned",
      ownedPaths: ["src/feature"],
    });
    expect(screen.queryByTestId("placement-issue")).not.toBeInTheDocument();
  });

  it("flags a lane name that cannot become a branch segment", () => {
    resetStore();
    setupStore({ selectedContextId: "context-plan" });
    render(<WorkflowInspectorPanel {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Lane name"), {
      target: { value: "-illegal" },
    });

    expect(screen.getByTestId("placement-issue")).toHaveTextContent(
      "branch and worktree path segments",
    );
  });
});
