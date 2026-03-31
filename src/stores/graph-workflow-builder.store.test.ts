import { beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "./graph-workflow-builder.store";

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

describe("graph workflow builder store", () => {
  beforeEach(resetStore);

  it("loads a persisted draft and clears dirty state", () => {
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.draftDefinition?.executionContexts).toHaveLength(3);
    expect(state.draftLayout?.workflowId).toBe("workflow-1");
  });

  it("marks the draft dirty when definition or layout changes", () => {
    const store = _useGraphWorkflowBuilderStore.getState();
    store.loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    store.updateDefinition(
      createWorkflowDefinition({
        tasks: [
          ...createWorkflowDefinition().tasks,
          {
            id: "task-extra",
            contextId: "context-plan",
            order: 2,
            title: "Extra",
            instructions: "Add more work.",
            source: "user",
          },
        ],
      }),
    );

    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);

    store.markSaved({
      definition: _useGraphWorkflowBuilderStore.getState().draftDefinition!,
      layout: _useGraphWorkflowBuilderStore.getState().draftLayout!,
    });

    store.updateLayout(
      createWorkflowLayout({
        contextPositions: {
          ...createWorkflowLayout().contextPositions,
          "context-plan": { x: 500, y: 250 },
        },
      }),
    );

    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);
  });

  it("tracks generated drafts, selection, validation errors, and reset", () => {
    const store = _useGraphWorkflowBuilderStore.getState();
    store.loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    store.applyGeneratedDraft({
      definition: createWorkflowDefinition({
        executionContexts: createWorkflowDefinition().executionContexts.slice(
          0,
          2,
        ),
      }),
      layout: createWorkflowLayout({
        contextPositions: {
          "context-plan": { x: 0, y: 0 },
          "context-implement": { x: 360, y: 0 },
        },
      }),
      validationErrors: [
        {
          code: "unknown-task-context",
          message: "Task references a missing context",
          taskId: "task-x",
        },
      ],
    });

    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);
    expect(
      _useGraphWorkflowBuilderStore.getState().validationErrors,
    ).toHaveLength(1);

    store.setSelectedContextId("context-plan");
    store.setSelectedTaskId("task-plan-1");
    expect(_useGraphWorkflowBuilderStore.getState().selectedTaskId).toBe(
      "task-plan-1",
    );

    store.resetToPersisted();

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.validationErrors).toEqual([]);
    expect(state.selectedContextId).toBeNull();
    expect(state.draftDefinition?.executionContexts).toHaveLength(3);
  });
});
