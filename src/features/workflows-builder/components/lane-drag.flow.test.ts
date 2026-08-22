import { beforeEach, describe, expect, it } from "vitest";
import { updateContextPosition } from "@/lib/workflow-graph/builder-draft";
import {
  computeLaneBandBoxes,
  type LaneBandNodeBox,
} from "@/lib/workflow-graph/lane-band-geometry";
import { deriveDefinitionLaneBands } from "@/lib/workflow-graph/lane-bands";
import { withEphemeralLaneBands } from "@/lib/workflow-graph/ephemeral-lanes";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  generateWorkflowLayout,
} from "@/lib/workflow-graph/layout";
import { createWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import {
  laneDropCalloutFor,
  resolveLaneDragDrop,
  resolveLaneDragHover,
  type LaneDragOrigin,
} from "./lane-drag";

/**
 * The whole gesture, end to end, at the level the canvas actually decides it
 * (README §2.1).
 *
 * React Flow drives node dragging through d3-drag, which needs a
 * `MouseEvent.view` jsdom refuses to construct across vitest realms — so the
 * pointer itself is unreachable from a unit test. What IS reachable is every
 * decision the gesture makes, and none of it is stubbed here: a real definition
 * lays out through the real layout generator, real bands derive from it, real
 * geometry turns them into boxes, the real hit-test picks the crossing, the
 * real validator decides the drop, and the real store takes the result.
 */

function loadDraft() {
  const definition = createWorkflowDefinition();
  const layout = generateWorkflowLayout(definition, null);
  _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
    definition,
    layout,
  });
  return { definition, layout };
}

function nodeBoxes(layout: ReturnType<typeof generateWorkflowLayout>) {
  return Object.entries(layout.contextPositions).map(
    ([id, position]): LaneBandNodeBox => ({
      id,
      x: position.x,
      y: position.y,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    }),
  );
}

/** What `handleNodeDragStart` captures: the origin, and the bands as they stand. */
function beginDrag(contextId: string) {
  const state = _useGraphWorkflowBuilderStore.getState();
  const definition = state.draftDefinition!;
  const layout = state.draftLayout!;
  const position = layout.contextPositions[contextId]!;
  const origin: LaneDragOrigin = {
    contextId,
    lane: definition.executionContexts.find(
      (context) => context.id === contextId,
    )!.placement!.lane,
    position,
    size: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
  };
  // The canvas hit-tests against the bands the author can SEE, empty ones
  // included — `withEphemeralLaneBands` is what puts a drawn-but-unsaved lane
  // among them, and it is the only way a context can ever land on one.
  const bands = withEphemeralLaneBands(
    deriveDefinitionLaneBands(definition),
    state.ephemeralLanes,
  );
  return {
    origin,
    boxes: computeLaneBandBoxes(bands, nodeBoxes(layout)),
  };
}

/** The top-left a card needs so its CENTRE lands inside `box`. */
function centreOn(box: { x: number; y: number; height: number }) {
  return {
    x: box.x + 200,
    y: box.y + box.height / 2 - DEFAULT_NODE_HEIGHT / 2,
  };
}

/** What `handleNodeDragStop` does with an accepted drop. */
function applyDrop(
  contextId: string,
  drop: ReturnType<typeof resolveLaneDragDrop>,
  position: { x: number; y: number },
) {
  const store = _useGraphWorkflowBuilderStore.getState();
  if (drop.kind === "refused") return;
  if (drop.kind === "replace") store.updateDefinition(drop.definition);
  store.updateLayout(
    updateContextPosition(store.draftLayout!, contextId, position),
  );
}

function placementOf(contextId: string) {
  return _useGraphWorkflowBuilderStore
    .getState()
    .draftDefinition?.executionContexts.find(
      (context) => context.id === contextId,
    )?.placement;
}

describe("the drag gesture, start to store", () => {
  beforeEach(() => {
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
    });
  });

  it("moving a node inside its own lane writes layout and nothing else", () => {
    loadDraft();
    const { origin, boxes } = beginDrag("context-implement");
    const home = boxes.find((box) => box.laneName === "implement")!;
    const before = _useGraphWorkflowBuilderStore.getState().draftDefinition;

    // Same band, further right: the drag never crosses a boundary.
    const position = { x: origin.position.x + 260, y: home.y + 8 };
    const hover = resolveLaneDragHover({
      definition: before!,
      boxes,
      origin,
      position,
    });
    const drop = resolveLaneDragDrop({
      definition: before!,
      boxes,
      origin,
      position,
    });
    applyDrop("context-implement", drop, position);

    expect(hover.targetLane).toBeNull();
    expect(drop).toEqual({ kind: "layout" });
    expect(laneDropCalloutFor(drop)).toBeNull();
    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.draftDefinition).toEqual(before);
    expect(state.draftLayout?.contextPositions["context-implement"]).toEqual(
      position,
    );
  });

  it("crossing a lane boundary previews, then writes only placement.lane", () => {
    loadDraft();
    const { origin, boxes } = beginDrag("context-plan");
    const target = boxes.find((box) => box.laneName === "implement")!;
    const position = centreOn(target);
    const definition =
      _useGraphWorkflowBuilderStore.getState().draftDefinition!;

    const hover = resolveLaneDragHover({
      definition,
      boxes,
      origin,
      position,
    });
    expect(hover.targetLane).toBe("implement");
    expect(hover.evaluation?.previewLabel).toBe(
      "Re-place → lane: implement · grade: full · unchanged",
    );

    const drop = resolveLaneDragDrop({ definition, boxes, origin, position });
    applyDrop("context-plan", drop, position);

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.dirty).toBe(true);
    expect(placementOf("context-plan")).toEqual({
      lane: "implement",
      mode: "full",
    });
    // Nothing else about the draft moved: put the one field back and the two
    // definitions are identical.
    expect({
      ...state.draftDefinition,
      executionContexts: state.draftDefinition?.executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? { ...context, placement: { lane: "plan", mode: "full" } }
            : context,
      ),
    }).toEqual(definition);
  });

  // README §4 — a full member needs its lane to itself, so landing a second
  // write-capable member there is legal and still costs something.
  it("says what an accepted placement will cost once the lane is shared", () => {
    loadDraft();
    const { origin, boxes } = beginDrag("context-plan");
    const position = centreOn(
      boxes.find((box) => box.laneName === "implement")!,
    );

    const drop = resolveLaneDragDrop({
      definition: _useGraphWorkflowBuilderStore.getState().draftDefinition!,
      boxes,
      origin,
      position,
    });

    expect(drop.kind).toBe("replace");
    const callout = laneDropCalloutFor(drop);
    expect(callout?.tone).toBe("amber");
    expect(callout?.message).toMatch(/exclusive occupancy of lane implement/);
  });

  // The post-drop draft goes through the whole accept-time gate, not a lane
  // rule alone: re-placing a downstream context onto an upstream lane makes
  // the two lanes depend on each other, and the refusal says so.
  it("refuses a drop that would make two lanes depend on each other", () => {
    loadDraft();
    const { origin, boxes } = beginDrag("context-verify");
    const position = centreOn(boxes.find((box) => box.laneName === "plan")!);
    const before = _useGraphWorkflowBuilderStore.getState().draftDefinition;

    const drop = resolveLaneDragDrop({
      definition: before!,
      boxes,
      origin,
      position,
    });
    applyDrop("context-verify", drop, position);

    expect(drop.kind).toBe("refused");
    expect(laneDropCalloutFor(drop)?.message).toMatch(
      /Authored lane dependencies form a cycle/,
    );
    expect(_useGraphWorkflowBuilderStore.getState().draftDefinition).toEqual(
      before,
    );
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  // README §2.2 — an empty lane becomes real when a context is dragged into it.
  // The drawn band is the only target the gesture has for a lane the definition
  // does not name yet, so a drop on it has to write `placement.lane` like any
  // other crossing.
  it("lands a context on a drawn-but-empty lane and makes it real", () => {
    loadDraft();
    _useGraphWorkflowBuilderStore.getState().addEphemeralLane();
    const laneName =
      _useGraphWorkflowBuilderStore.getState().ephemeralLanes[0]!.name;

    const { origin, boxes } = beginDrag("context-plan");
    const target = boxes.find((box) => box.laneName === laneName)!;
    const position = centreOn(target);
    const definition =
      _useGraphWorkflowBuilderStore.getState().draftDefinition!;

    const hover = resolveLaneDragHover({
      definition,
      boxes,
      origin,
      position,
    });
    expect(hover.targetLane).toBe(laneName);

    const drop = resolveLaneDragDrop({ definition, boxes, origin, position });
    applyDrop("context-plan", drop, position);

    expect(drop.kind).toBe("replace");
    expect(placementOf("context-plan")).toEqual({
      lane: laneName,
      mode: "full",
    });
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);
  });

  it("refuses a write-capable context on the reserved session lane and leaves the draft alone", () => {
    const { definition } = loadDraft();
    // A read-only member puts a session band on the canvas to aim at.
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
      definition: {
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.id === "context-verify"
            ? {
                ...context,
                placement: { lane: "session", mode: "readOnly" as const },
                outputSchema: {
                  type: "object" as const,
                  properties: { summary: { type: "string" as const } },
                  required: ["summary"],
                },
              }
            : context,
        ),
      },
      layout: generateWorkflowLayout(definition, null),
    });
    const { origin, boxes } = beginDrag("context-implement");
    const position = centreOn(boxes.find((box) => box.laneName === "session")!);
    const before = _useGraphWorkflowBuilderStore.getState().draftDefinition;

    const drop = resolveLaneDragDrop({
      definition: before!,
      boxes,
      origin,
      position,
    });
    applyDrop("context-implement", drop, position);

    expect(drop.kind).toBe("refused");
    const callout = laneDropCalloutFor(drop)!;
    expect(callout.tone).toBe("red");
    expect(callout.message).toMatch(/admits only read-only contexts/);
    expect(callout.footnote).toMatch(/Nothing was written/);
    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.draftDefinition).toEqual(before);
    expect(state.dirty).toBe(false);
  });
});
