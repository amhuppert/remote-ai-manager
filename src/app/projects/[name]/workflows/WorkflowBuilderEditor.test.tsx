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
  it("adds a context via toolbar and updates the store", () => {
    resetStore();
    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    const initialContextCount =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0;

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    const newContextCount =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0;
    expect(newContextCount).toBe(initialContextCount + 1);
    expect(
      _useGraphWorkflowBuilderStore.getState().selectedContextId,
    ).toBeTruthy();
  });

  it("saves the current draft when Save Draft is clicked", async () => {
    resetStore();
    const onSave = vi.fn();

    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    // Make the store dirty by adding a context
    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.any(Object),
        layout: expect.any(Object),
      }),
    );
  });

  it("shows unsaved changes indicator when store is dirty", () => {
    resetStore();
    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    // Initially shows saved status
    expect(screen.getByText("All changes saved")).toBeInTheDocument();

    // Make a change
    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("resets to persisted state when Reset is clicked", () => {
    resetStore();
    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    const initialCount =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0;

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));
    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0,
    ).toBe(initialCount + 1);

    fireEvent.click(screen.getByRole("button", { name: /Reset/i }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0,
    ).toBe(initialCount);
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
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
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

    await waitFor(() => {
      expect(
        _useGraphWorkflowBuilderStore.getState().validationErrors.length,
      ).toBeGreaterThan(0);
    });
    expect(onSave).not.toHaveBeenCalled();

    const codes = _useGraphWorkflowBuilderStore
      .getState()
      .validationErrors.map((e) => e.code);
    expect(codes).toContain("empty-context-title");
    expect(codes).toContain("empty-task-instructions");
  });

  it("save payload includes the new continuity shape and no legacy limit fields", async () => {
    resetStore();
    const onSave = vi.fn();

    render(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const [payload] = onSave.mock.calls[0] as [
      {
        definition: {
          executionContexts: Array<{
            iterationPolicy: { continuity: Record<string, unknown> };
          }>;
        };
      },
    ];

    // Every context must carry the new continuity object with an enabled flag
    for (const ctx of payload.definition.executionContexts) {
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
