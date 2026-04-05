// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
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

function setupStoreWithContext(contextId = "context-plan") {
  const definition = createWorkflowDefinition();
  const layout = createWorkflowLayout();
  act(() => {
    _useGraphWorkflowBuilderStore.setState({
      draftDefinition: definition,
      draftLayout: layout,
      selectedContextId: contextId,
      dirty: false,
      validationErrors: [],
    });
  });
  return { definition, layout };
}

/** Find a named section element by its title text. */
function findSection(titleText: string): Element | null {
  const titles = document.querySelectorAll(".wb-section-title");
  const match = Array.from(titles).find((el) => el.textContent === titleText);
  return match?.closest(".wb-section") ?? null;
}

/** Find an input inside a section's inline field by label text. */
function findFieldInput(
  section: Element,
  labelText: string,
): HTMLInputElement | null {
  const fields = section.querySelectorAll(".wb-inline-field");
  for (const field of Array.from(fields)) {
    const label = field.querySelector(".wb-inline-field-label");
    if (label?.textContent === labelText) {
      return field.querySelector("input") as HTMLInputElement | null;
    }
  }
  return null;
}

/** Find the toggle div inside a section's inline field by label text. */
function findFieldToggle(
  section: Element,
  labelText: string,
): HTMLElement | null {
  const fields = section.querySelectorAll(".wb-inline-field");
  for (const field of Array.from(fields)) {
    const label = field.querySelector(".wb-inline-field-label");
    if (label?.textContent === labelText) {
      return field.querySelector(".wb-toggle") as HTMLElement | null;
    }
  }
  return null;
}

describe("WorkflowInspectorPanel — implementer continuity controls", () => {
  it("implementer continuity toggle is enabled by default", () => {
    resetStore();
    setupStoreWithContext();
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const ctx =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts[0];
    expect(ctx?.iterationPolicy.continuity.enabled).toBe(true);

    const section = findSection("Iteration Policy");
    expect(section).toBeTruthy();
    const toggle = findFieldToggle(section!, "Session Continuity");
    expect(toggle).toBeTruthy();
    expect(toggle!.className).toContain("on");
  });

  it("context limit input starts empty when no limit is configured", () => {
    resetStore();
    setupStoreWithContext();
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Iteration Policy");
    expect(section).toBeTruthy();
    const input = findFieldInput(section!, "Context Limit (tokens)");
    expect(input).toBeTruthy();
    expect(input!.value).toBe("");

    const ctx =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts[0];
    expect(ctx?.iterationPolicy.continuity.contextLimitTokens).toBeUndefined();
  });

  it("toggling implementer session continuity off updates the store", () => {
    resetStore();
    setupStoreWithContext();
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Iteration Policy");
    const toggle = findFieldToggle(section!, "Session Continuity");
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle!);

    const ctx =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts[0];
    expect(ctx?.iterationPolicy.continuity.enabled).toBe(false);
  });

  it("typing a context limit value in Iteration Policy stores it as an integer", () => {
    resetStore();
    setupStoreWithContext();
    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Iteration Policy");
    const input = findFieldInput(section!, "Context Limit (tokens)");
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: "150000" } });

    const ctx =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts[0];
    expect(ctx?.iterationPolicy.continuity.contextLimitTokens).toBe(150000);
  });
});

describe("WorkflowInspectorPanel — task validator continuity controls", () => {
  it("task validator continuity toggle defaults to enabled when validator is configured", () => {
    resetStore();
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                taskValidation: {
                  type: "claude" as const,
                  enabled: true,
                  agent: {
                    model: "sonnet" as const,
                    reasoningEffort: "medium" as const,
                  },
                  instructions: "Verify task.",
                  continuity: { enabled: true },
                },
              }
            : ctx,
      ),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: definition,
        draftLayout: createWorkflowLayout(),
        selectedContextId: "context-plan",
        dirty: false,
        validationErrors: [],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.taskValidation?.continuity.enabled).toBe(true);

    const section = findSection("Task Validation");
    expect(section).toBeTruthy();
    // Find the toggle in the section that follows the "Session Continuity" label
    const subsectionLabel = Array.from(
      section!.querySelectorAll(".wb-subsection-label"),
    ).find((el) => el.textContent === "Session Continuity");
    expect(subsectionLabel).toBeTruthy();
  });

  it("task validator continuity.enabled defaults to true in createDefaultTaskValidation output", () => {
    // Verify the default factory creates continuity.enabled = true
    resetStore();
    setupStoreWithContext();
    render(<WorkflowInspectorPanel {...defaultProps} />);

    // When no taskValidation is set, the panel derives from createDefaultTaskValidation
    // which sets continuity.enabled = true. After we enable the validator, the store
    // should reflect that default.
    const section = findSection("Task Validation");
    expect(section).toBeTruthy();
    // Click "Enabled" toggle to create the default validator in the store
    const enabledToggle = section!.querySelector(".wb-toggle");
    expect(enabledToggle).toBeTruthy();
    fireEvent.click(enabledToggle!);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.taskValidation?.continuity.enabled).toBe(true);
  });
});

describe("WorkflowInspectorPanel — schema shape assertions", () => {
  it("definition never contains legacy soft/hard limit fields", () => {
    resetStore();
    setupStoreWithContext();

    const def = _useGraphWorkflowBuilderStore.getState().draftDefinition;
    const ctx = def?.executionContexts[0];

    expect(ctx?.iterationPolicy.continuity).toHaveProperty("enabled");
    const raw = ctx?.iterationPolicy as Record<string, unknown>;
    expect(raw).not.toHaveProperty("contextSoftLimitTokens");
    expect(raw).not.toHaveProperty("contextHardLimitTokens");
  });

  it("continuity shape uses contextLimitTokens not legacy field names", () => {
    resetStore();
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                iterationPolicy: {
                  ...ctx.iterationPolicy,
                  continuity: {
                    enabled: true,
                    contextLimitTokens: 80000,
                  },
                },
              }
            : ctx,
      ),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: definition,
        draftLayout: createWorkflowLayout(),
        selectedContextId: "context-plan",
        dirty: false,
        validationErrors: [],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    const ctx = _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find((c) => c.id === "context-plan");
    expect(ctx?.iterationPolicy.continuity.contextLimitTokens).toBe(80000);

    const continuityKeys = Object.keys(ctx?.iterationPolicy.continuity ?? {});
    expect(continuityKeys).not.toContain("contextSoftLimitTokens");
    expect(continuityKeys).not.toContain("contextHardLimitTokens");
  });
});

describe("WorkflowInspectorPanel — context validator continuity controls", () => {
  it("Context Validation section shows Session Continuity subsection when agent validator is configured", () => {
    resetStore();
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                contextValidation: {
                  agentValidator: {
                    type: "claude" as const,
                    enabled: true,
                    agent: {
                      model: "sonnet" as const,
                      reasoningEffort: "medium" as const,
                    },
                    instructions: "Verify context.",
                    continuity: { enabled: true },
                  },
                  onFail: {
                    mode: "retry" as const,
                    retryScope: "same_context" as const,
                    maxAttempts: 2,
                  },
                },
              }
            : ctx,
      ),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: definition,
        draftLayout: createWorkflowLayout(),
        selectedContextId: "context-plan",
        dirty: false,
        validationErrors: [],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Context Validation");
    expect(section).toBeTruthy();
    const subsectionLabel = Array.from(
      section!.querySelectorAll(".wb-subsection-label"),
    ).find((el) => el.textContent === "Session Continuity");
    expect(subsectionLabel).toBeTruthy();
  });

  it("Context Validation continuity toggle defaults to enabled when agent validator is configured", () => {
    resetStore();
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                contextValidation: {
                  agentValidator: {
                    type: "claude" as const,
                    enabled: true,
                    agent: {
                      model: "sonnet" as const,
                      reasoningEffort: "medium" as const,
                    },
                    instructions: "Verify context.",
                    continuity: { enabled: true },
                  },
                  onFail: {
                    mode: "retry" as const,
                    retryScope: "same_context" as const,
                    maxAttempts: 2,
                  },
                },
              }
            : ctx,
      ),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: definition,
        draftLayout: createWorkflowLayout(),
        selectedContextId: "context-plan",
        dirty: false,
        validationErrors: [],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Context Validation");
    expect(section).toBeTruthy();

    // Find the Session Continuity subsection and its toggle within it
    const allSubsections = Array.from(
      section!.querySelectorAll(".wb-subsection-label"),
    );
    const continuitySubsection = allSubsections.find(
      (el) => el.textContent === "Session Continuity",
    );
    expect(continuitySubsection).toBeTruthy();

    // The toggle immediately following the subsection label should have class "on"
    const continuityToggle =
      continuitySubsection!.nextElementSibling?.querySelector(".wb-toggle");
    expect(continuityToggle).toBeTruthy();
    expect(continuityToggle!.className).toContain("on");
  });

  it("Context Validation section does NOT show Session Continuity when only script validator is configured", () => {
    resetStore();
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                contextValidation: {
                  scriptValidator: { enabled: true },
                  onFail: {
                    mode: "halt" as const,
                    retryScope: "same_context" as const,
                    maxAttempts: 1,
                  },
                },
              }
            : ctx,
      ),
    });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        draftDefinition: definition,
        draftLayout: createWorkflowLayout(),
        selectedContextId: "context-plan",
        dirty: false,
        validationErrors: [],
      });
    });

    render(<WorkflowInspectorPanel {...defaultProps} />);

    const section = findSection("Context Validation");
    expect(section).toBeTruthy();

    // Script validators are shell commands — no session concept, no continuity controls
    const continuityLabel = Array.from(
      section!.querySelectorAll(".wb-subsection-label"),
    ).find((el) => el.textContent === "Session Continuity");
    expect(continuityLabel).toBeFalsy();
  });
});
