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
    refusedEdits: [],
    pendingOutputSchemaText: {},
    ephemeralLanes: [],
    highlightedContextIds: [],
  });
}

function loadDraft() {
  const store = _useGraphWorkflowBuilderStore.getState();
  store.loadPersistedDraft({
    definition: createWorkflowDefinition(),
    layout: createWorkflowLayout(),
  });
  return store;
}

function laneNames() {
  return _useGraphWorkflowBuilderStore
    .getState()
    .ephemeralLanes.map((lane) => lane.name);
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

  it("keeps criterion claimant highlights ephemeral and clears them with the draft", () => {
    const store = loadDraft();

    store.setHighlightedContextIds(["context-plan", "context-implement"]);
    expect(
      _useGraphWorkflowBuilderStore.getState().highlightedContextIds,
    ).toEqual(["context-plan", "context-implement"]);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);

    store.loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
    expect(
      _useGraphWorkflowBuilderStore.getState().highlightedContextIds,
    ).toEqual([]);
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

  // A refused edit is feedback about an attempt the draft never took. The next
  // accepted edit makes it describe a draft that no longer exists, so it must
  // not survive to keep refusing a save.
  it("drops refused edits once the draft moves on", () => {
    const store = _useGraphWorkflowBuilderStore.getState();
    store.loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
    store.setRefusedEdits([
      { code: "duplicate-edge", message: "Dependency already exists" },
    ]);
    expect(_useGraphWorkflowBuilderStore.getState().refusedEdits).toHaveLength(
      1,
    );

    store.updateDefinition(createWorkflowDefinition());

    expect(_useGraphWorkflowBuilderStore.getState().refusedEdits).toEqual([]);
  });

  it("keeps pending output-schema text with the draft and clears it on save and reset", () => {
    const store = _useGraphWorkflowBuilderStore.getState();
    store.loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    store.setPendingOutputSchemaText("context-plan", {
      text: '{ "type": ',
      committed: "",
    });
    expect(
      _useGraphWorkflowBuilderStore.getState().pendingOutputSchemaText[
        "context-plan"
      ]?.text,
    ).toBe('{ "type": ');

    // An accepted edit elsewhere must not discard text the author is still
    // working on — only leaving the draft behind does.
    store.updateDefinition(createWorkflowDefinition());
    expect(
      _useGraphWorkflowBuilderStore.getState().pendingOutputSchemaText[
        "context-plan"
      ],
    ).toBeDefined();

    store.resetToPersisted();
    expect(
      _useGraphWorkflowBuilderStore.getState().pendingOutputSchemaText,
    ).toEqual({});
  });

  it("tracks generated drafts, selection, refused edits, and reset", () => {
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
    expect(_useGraphWorkflowBuilderStore.getState().refusedEdits).toHaveLength(
      1,
    );

    store.setSelectedContextId("context-plan");
    store.setSelectedTaskId("task-plan-1");
    expect(_useGraphWorkflowBuilderStore.getState().selectedTaskId).toBe(
      "task-plan-1",
    );

    store.resetToPersisted();

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.refusedEdits).toEqual([]);
    expect(state.selectedContextId).toBeNull();
    expect(state.draftDefinition?.executionContexts).toHaveLength(3);
  });
});

// README §2.2 — an empty lane is client-only draft UI. It is not an authored
// entity, so it lives beside the draft rather than in it: nothing about it can
// reach the definition, and nothing about it can survive leaving the draft.
describe("ephemeral lanes", () => {
  beforeEach(resetStore);

  it("adds an empty lane without dirtying the definition", () => {
    const store = loadDraft();

    store.addEphemeralLane();

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.ephemeralLanes).toHaveLength(1);
    expect(state.dirty).toBe(false);
    // The band exists nowhere in the semantic draft — there is no lane entity.
    expect(JSON.stringify(state.draftDefinition)).not.toContain("new-lane");
  });

  it("names each new lane past the draft's lanes and the bands already drawn", () => {
    const store = loadDraft();

    store.addEphemeralLane();
    store.addEphemeralLane();

    expect(laneNames()).toEqual(["new-lane", "new-lane-2"]);
  });

  it("renames a lane by id and leaves the definition clean", () => {
    const store = loadDraft();
    store.addEphemeralLane();
    const id = _useGraphWorkflowBuilderStore.getState().ephemeralLanes[0]!.id;

    store.renameEphemeralLane(id, "rollback");

    expect(laneNames()).toEqual(["rollback"]);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  it("removes a lane by id", () => {
    const store = loadDraft();
    store.addEphemeralLane();
    store.addEphemeralLane();
    const id = _useGraphWorkflowBuilderStore.getState().ephemeralLanes[0]!.id;

    store.removeEphemeralLane(id);

    expect(laneNames()).toEqual(["new-lane-2"]);
  });

  it("reuses a freed name once its band is gone", () => {
    const store = loadDraft();
    store.addEphemeralLane();
    const id = _useGraphWorkflowBuilderStore.getState().ephemeralLanes[0]!.id;
    store.removeEphemeralLane(id);

    store.addEphemeralLane();

    expect(laneNames()).toEqual(["new-lane"]);
  });

  // Reset, reload, workflow switch and Save all land on one of these three
  // actions, and §2.2 says an empty lane survives none of them.
  it.each([
    [
      "reset",
      () => _useGraphWorkflowBuilderStore.getState().resetToPersisted(),
    ],
    [
      "save",
      () =>
        _useGraphWorkflowBuilderStore.getState().markSaved({
          definition: createWorkflowDefinition(),
          layout: createWorkflowLayout(),
        }),
    ],
    [
      "loading another workflow",
      () =>
        _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
          definition: createWorkflowDefinition(),
          layout: createWorkflowLayout(),
        }),
    ],
  ])("drops every empty lane on %s", (_label, act) => {
    const store = loadDraft();
    store.addEphemeralLane();
    expect(
      _useGraphWorkflowBuilderStore.getState().ephemeralLanes,
    ).toHaveLength(1);

    act();

    expect(_useGraphWorkflowBuilderStore.getState().ephemeralLanes).toEqual([]);
  });

  it("drops every empty lane when a generated draft replaces the canvas", () => {
    const store = loadDraft();
    store.addEphemeralLane();

    store.applyGeneratedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
      validationErrors: [],
    });

    expect(_useGraphWorkflowBuilderStore.getState().ephemeralLanes).toEqual([]);
  });

  it("does not draw a band over a lane the draft already has", () => {
    const store = loadDraft();
    store.addEphemeralLane();
    const id = _useGraphWorkflowBuilderStore.getState().ephemeralLanes[0]!.id;
    store.renameEphemeralLane(id, "new-lane-2");

    store.addEphemeralLane();

    expect(laneNames()).toEqual(["new-lane-2", "new-lane"]);
  });
});
