// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import type { GlobalConfig } from "@/lib/config/schemas";
import { buildDefaultImplementerConfig } from "../WorkflowsBuilderPage";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";

const defaultHeaderProps = {
  workflowName: "Test Workflow",
  revision: 1 as number | null,
  onRename: vi.fn(),
  onDelete: vi.fn(),
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

describe("WorkflowBuilderEditor", () => {
  it("adds an inherited context, marks the draft dirty, and resets it", () => {
    resetStore();
    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        defaultImplementerConfig={{
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
        }}
      />,
    );

    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    const initialContextCount =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0;

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    const state = _useGraphWorkflowBuilderStore.getState();
    const added = state.draftDefinition?.executionContexts.at(-1);
    expect(state.draftDefinition?.executionContexts).toHaveLength(
      initialContextCount + 1,
    );
    expect(state.selectedContextId).toBeTruthy();
    expect(added).toBeDefined();
    expect(added?.implementer).toBeUndefined();
    expect(added?.contextValidator).toBeUndefined();
    expect(added?.iterationPolicy).toBeUndefined();
    expect(added?.circuitBreaker).toBeUndefined();
    expect(added?.mutability).toBeUndefined();
    expect(added?.acceptanceCriteria).toBe("");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reset/i }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0,
    ).toBe(initialContextCount);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  it("displays save error when provided", () => {
    resetStore();
    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        saveError="Network error"
      />,
    );

    expect(screen.getByText("Network error")).toBeInTheDocument();
  });

  it("blocks save and sets validation errors when definition has empty required fields", async () => {
    resetStore();
    const onSave = vi.fn();

    const invalidDefinition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "",
          acceptanceCriteria: "Some criteria",
          implementer: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 4,
            continuity: { enabled: true },
          },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "A task",
          instructions: "",
          source: "user",
        },
      ],
      edges: [],
    });

    const record = createWorkflowDefinitionRecord({
      definition: invalidDefinition,
    });

    render(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    // Make dirty so Save Draft is enabled
    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));

    await waitFor(
      () => {
        expect(
          _useGraphWorkflowBuilderStore.getState().validationErrors.length,
        ).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );
    expect(onSave).not.toHaveBeenCalled();

    const codes = _useGraphWorkflowBuilderStore
      .getState()
      .validationErrors.map((e) => e.code);
    expect(codes).toContain("empty-context-title");
    expect(codes).toContain("empty-task-instructions");
  }, 30000);

  it("blocks save and surfaces the accept-time parameter lint error when content references an undeclared parameter", async () => {
    resetStore();
    const onSave = vi.fn();

    // Structurally valid definition whose task instruction references an
    // undeclared parameter — only the accept-time lint (not the structural
    // validator) rejects it. This pins R8.3: the builder save must run the
    // full accept-time validation so the undeclared-reference error lands in
    // the store and surfaces in the parameter editor.
    const definitionWithUndeclaredRef = createWorkflowDefinition({
      parameters: [],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Inspect code",
          instructions: "Implement {{inputs.feature}} carefully.",
          source: "user",
        },
        {
          id: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          title: "Write code",
          instructions: "Implement the feature.",
          source: "user",
        },
        {
          id: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          title: "Run checks",
          instructions: "Verify behavior.",
          source: "user",
        },
      ],
    });

    const record = createWorkflowDefinitionRecord({
      definition: definitionWithUndeclaredRef,
    });

    render(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));

    await waitFor(() => {
      expect(
        _useGraphWorkflowBuilderStore.getState().validationErrors.length,
      ).toBeGreaterThan(0);
    });
    expect(onSave).not.toHaveBeenCalled();

    const undeclared = _useGraphWorkflowBuilderStore
      .getState()
      .validationErrors.find(
        (error) => error.code === "undeclared-parameter-reference",
      );
    expect(undeclared?.parameterName).toBe("feature");
    expect(undeclared?.field).toContain("instructions");

    // R8.3: the error surfaces in the parameter editor (the Workflow tab is the
    // default, so the parameter-declaration editor is mounted), naming the
    // offending field and undeclared parameter.
    expect(
      screen.getByText(/references undeclared parameter "feature"/),
    ).toBeInTheDocument();
  });

  it("saves the draft while preserving seeded context continuity", async () => {
    resetStore();
    const onSave = vi.fn();

    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.any(Object),
        layout: expect.any(Object),
      }),
    );

    const [payload] = onSave.mock.calls[0] as [
      {
        definition: {
          executionContexts: Array<{
            iterationPolicy?: { continuity?: Record<string, unknown> };
          }>;
        };
      },
    ];

    for (const ctx of payload.definition.executionContexts) {
      if (!ctx.iterationPolicy) continue;
      expect(ctx.iterationPolicy.continuity).toHaveProperty("enabled");
      expect(ctx.iterationPolicy.continuity).not.toHaveProperty(
        "contextSoftLimitTokens",
      );
      expect(ctx.iterationPolicy.continuity).not.toHaveProperty(
        "contextHardLimitTokens",
      );
    }
  });
});

const BASE_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  claudeTimeoutMs: 3600000,
  defaultModel: "opus",
  defaultAgentBackend: "claude",
};

describe("buildDefaultImplementerConfig", () => {
  it("returns claude config when defaultAgentBackend is claude", () => {
    const result = buildDefaultImplementerConfig(BASE_CONFIG);

    expect(result.backend).toBe("claude");
    expect(result.model).toBe("opus");
    expect(result.reasoningEffort).toBe("medium");
  });

  it("returns codex config with validated model when defaultAgentBackend is codex", () => {
    const result = buildDefaultImplementerConfig({
      ...BASE_CONFIG,
      defaultAgentBackend: "codex",
      codex: { enabled: true, model: "gpt-5.4-mini" },
    });

    expect(result.backend).toBe("codex");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.reasoningEffort).toBe("high");
  });

  it("falls back to default codex model when config model is invalid", () => {
    const result = buildDefaultImplementerConfig({
      ...BASE_CONFIG,
      defaultAgentBackend: "codex",
      codex: { enabled: true, model: "invalid-model" },
    });

    expect(result.backend).toBe("codex");
    expect(result.model).toBe("gpt-5.4");
  });

  it("uses codex reasoning effort from config when valid", () => {
    const result = buildDefaultImplementerConfig({
      ...BASE_CONFIG,
      defaultAgentBackend: "codex",
      codex: { enabled: true, model: "gpt-5.4", reasoningEffort: "xhigh" },
    });

    expect(result.backend).toBe("codex");
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("falls back to default codex model and effort when codex config is absent", () => {
    const result = buildDefaultImplementerConfig({
      ...BASE_CONFIG,
      defaultAgentBackend: "codex",
    });

    expect(result.backend).toBe("codex");
    expect(result.model).toBe("gpt-5.4");
    expect(result.reasoningEffort).toBe("high");
  });
});
