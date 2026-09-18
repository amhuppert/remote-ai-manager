// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  ReactFlowProvider,
  useReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import WorkflowBuilderCanvas from "./WorkflowBuilderCanvas";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

function loadDraft() {
  act(() => {
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
  });
}

function renderCanvas() {
  return renderWithQuery(
    <ReactFlowProvider>
      <WorkflowBuilderCanvas />
    </ReactFlowProvider>,
  );
}

function contextIds(): string[] {
  return (
    _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.map((context) => context.id) ?? []
  );
}

function edgeIds(): string[] {
  return (
    _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.edges.map((edge) => edge.id) ?? []
  );
}

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

// README §5: "Node / edge deletion — Select + Delete key, or the node's context
// menu". The Delete key is React Flow's own; the menu is the pointer path, and
// the only one a reader discovers without knowing the keyboard contract.
describe("WorkflowBuilderCanvas — context menu", () => {
  beforeEach(resetStore);

  // React Flow paints edges only once it has measured node dimensions, which
  // jsdom reports as zero — so the edge branch of the same wiring is covered
  // against the menu itself in `CanvasContextMenu.test.tsx`.
  it("deletes a context from its node's menu", async () => {
    loadDraft();
    const { container } = renderCanvas();

    const node = container.querySelector(
      '.react-flow__node[data-id="context-plan"]',
    );
    expect(node).not.toBeNull();
    fireEvent.contextMenu(node!);

    const item = await screen.findByRole("menuitem", {
      name: /Delete “Plan”/,
    });
    fireEvent.click(item);

    await waitFor(() => expect(contextIds()).not.toContain("context-plan"));
    // Deleting a context takes its dependencies with it — the builder-draft
    // helper owns that, and the menu must route through it rather than
    // stripping the node alone.
    expect(edgeIds()).not.toContain("edge-plan-implement");
  });

  // A node drag itself is not reachable from jsdom: React Flow drives it
  // through d3-drag, whose `MouseEvent.view` jsdom refuses to construct here.
  // The gesture's decisions are covered as a model instead — `lane-drag.test.ts`
  // for the crossing and the drop, `lane-drop.test.ts` for the verdict.
  it("offers no menu on empty canvas", async () => {
    loadDraft();
    const { container } = renderCanvas();

    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.contextMenu(pane!);

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });
});

describe("WorkflowBuilderCanvas — mobile dependencies", () => {
  beforeEach(resetStore);

  it("removes and restores an incoming dependency through touch controls", async () => {
    loadDraft();
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile />
      </ReactFlowProvider>,
    );
    const trigger = screen.getByRole("button", {
      name: "Dependencies for Implement",
    });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove dependency from Plan" }),
    );
    expect(edgeIds()).not.toContain("edge-plan-implement");
    fireEvent.click(
      screen.getByRole("button", { name: "Add dependency from Plan" }),
    );
    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition?.edges,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not expose dependency editing in read-only mode", () => {
    loadDraft();
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile readOnly />
      </ReactFlowProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Dependencies for/ }),
    ).not.toBeInTheDocument();
  });

  it("lets a phone user rename and remove an empty lane", () => {
    loadDraft();
    act(() =>
      _useGraphWorkflowBuilderStore.setState({
        ephemeralLanes: [{ id: "empty-lane", name: "draft-lane" }],
      }),
    );
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile />
      </ReactFlowProvider>,
    );
    const name = screen.getByRole("textbox", { name: "Lane name" });
    fireEvent.change(name, { target: { value: "release" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(_useGraphWorkflowBuilderStore.getState().ephemeralLanes).toEqual([
      { id: "empty-lane", name: "release" },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove lane release" }),
    );
    expect(_useGraphWorkflowBuilderStore.getState().ephemeralLanes).toEqual([]);
  });
});

describe("WorkflowBuilderCanvas — scope highlights", () => {
  beforeEach(resetStore);

  it("highlights every claimant context and clears the set on blank canvas", async () => {
    loadDraft();
    act(() => {
      _useGraphWorkflowBuilderStore
        .getState()
        .setHighlightedContextIds(["context-plan", "context-implement"]);
    });
    const { container } = renderCanvas();

    await waitFor(() => {
      expect(
        container.querySelector(
          '.react-flow__node[data-id="context-plan"] [data-scope-highlighted="true"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '.react-flow__node[data-id="context-implement"] [data-scope-highlighted="true"]',
        ),
      ).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__pane")!);
    expect(
      _useGraphWorkflowBuilderStore.getState().highlightedContextIds,
    ).toEqual([]);
  });
});

// README §2.2 — an empty lane is client-only draft UI. These tests are about
// the canvas's half of that: what an author sees, and what the draft does NOT
// gain as a result.
describe("WorkflowBuilderCanvas — ephemeral lanes", () => {
  beforeEach(resetStore);

  function addLane() {
    act(() => _useGraphWorkflowBuilderStore.getState().addEphemeralLane());
  }

  it("draws an empty band without dirtying the definition", async () => {
    loadDraft();
    renderCanvas();

    addLane();

    expect(
      await screen.findByTestId("ephemeral-lane-band"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Lane name")).toHaveValue("new-lane");
    expect(
      screen.getByText("0 members · nothing to save yet"),
    ).toBeInTheDocument();
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  it("stacks the band below the bands the draft already has", async () => {
    loadDraft();
    renderCanvas();

    addLane();

    const band = await screen.findByTestId("ephemeral-lane-band");
    const lastDraftBand = screen.getAllByTestId("lane-band").at(-1)!;
    expect(Number.parseFloat(band.style.top)).toBeGreaterThan(
      Number.parseFloat(lastDraftBand.style.top),
    );
  });

  it("merges into an existing lane instead of drawing a duplicate band", async () => {
    loadDraft();
    renderCanvas();
    addLane();

    const input = await screen.findByLabelText("Lane name");
    fireEvent.change(input, { target: { value: "implement" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.queryByTestId("ephemeral-lane-band"),
      ).not.toBeInTheDocument(),
    );
    const callout = screen.getByTestId("lane-drop-callout");
    expect(callout).toHaveAttribute("data-tone", "amber");
    expect(callout).toHaveTextContent(/use the existing lane/);
    // Merging an empty band writes nothing: there was never a lane to remove.
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  it("keeps a band whose name the lane rules refuse", async () => {
    loadDraft();
    renderCanvas();
    addLane();

    const input = await screen.findByLabelText("Lane name");
    fireEvent.change(input, { target: { value: "session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /read-only contexts only/,
    );
    expect(screen.getByTestId("ephemeral-lane-band")).toBeInTheDocument();
  });

  it("discards the band on Reset", async () => {
    loadDraft();
    renderCanvas();
    addLane();
    expect(
      await screen.findByTestId("ephemeral-lane-band"),
    ).toBeInTheDocument();

    act(() => _useGraphWorkflowBuilderStore.getState().resetToPersisted());

    await waitFor(() =>
      expect(
        screen.queryByTestId("ephemeral-lane-band"),
      ).not.toBeInTheDocument(),
    );
  });

  // "Moving the last context out of a lane removes the lane from the canvas."
  // Bands are derived from placements, so this is a property of the derivation
  // rather than a rule anything has to enforce — and it has to stay one.
  it("drops a band once its last member leaves the lane", async () => {
    loadDraft();
    renderCanvas();
    expect(
      screen.getAllByTestId("lane-band").map((band) => band.dataset.laneName),
    ).toContain("verify");

    const definition =
      _useGraphWorkflowBuilderStore.getState().draftDefinition!;
    act(() =>
      _useGraphWorkflowBuilderStore.getState().updateDefinition({
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.placement?.lane === "verify"
            ? { ...context, placement: { ...context.placement, lane: "plan" } }
            : context,
        ),
      }),
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("lane-band").map((band) => band.dataset.laneName),
      ).not.toContain("verify"),
    );
  });
});

// README §2.2 — "It becomes real only when a context is added or dragged into
// it." Both routes write the same field, so the band retires on the placement
// itself rather than on the gesture that produced it. This is the ADD route,
// which is what the Placement screen's lane field does.
describe("WorkflowBuilderCanvas — an empty lane becoming real", () => {
  beforeEach(resetStore);

  function placeOnLane(contextId: string, lane: string) {
    const definition =
      _useGraphWorkflowBuilderStore.getState().draftDefinition!;
    act(() =>
      _useGraphWorkflowBuilderStore.getState().updateDefinition({
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.id === contextId && context.placement
            ? { ...context, placement: { ...context.placement, lane } }
            : context,
        ),
      }),
    );
  }

  it("retires the empty band and dirties the draft once a context lands on it", async () => {
    loadDraft();
    renderCanvas();
    act(() => _useGraphWorkflowBuilderStore.getState().addEphemeralLane());
    expect(
      await screen.findByTestId("ephemeral-lane-band"),
    ).toBeInTheDocument();

    placeOnLane("context-plan", "new-lane");

    await waitFor(() =>
      expect(
        screen.queryByTestId("ephemeral-lane-band"),
      ).not.toBeInTheDocument(),
    );
    // Exactly one band for the lane, and it is the derived one.
    expect(
      screen
        .getAllByTestId("lane-band")
        .filter((band) => band.dataset.laneName === "new-lane"),
    ).toHaveLength(1);

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.ephemeralLanes).toEqual([]);
    // Save persists the placement change and nothing else about the lane:
    // there is no lane record anywhere in the definition to persist.
    expect(
      state.draftDefinition?.executionContexts.find(
        (context) => context.id === "context-plan",
      )?.placement,
    ).toEqual({ lane: "new-lane", mode: "full" });
  });
});

// README §12 — "Re-placement on touch is a long-press on the node, then a lane
// picker: the same validation, the same refusal copy." These assert that the
// picker's verdicts land on the DRAFT the same way a drag's do, which is the
// only thing that makes the two gestures interchangeable.
describe("WorkflowBuilderCanvas — touch re-placement", () => {
  beforeEach(resetStore);

  /** Two lanes, one member each — the smallest graph a re-placement needs. */
  function loadTwoLaneDraft() {
    const base = createWorkflowDefinition();
    act(() => {
      _useGraphWorkflowBuilderStore.getState().loadPersistedDraft({
        definition: {
          ...base,
          executionContexts: [
            {
              id: "ctx_checkout",
              title: "Implement checkout",
              acceptanceCriteria: "Checkout works",
              placement: {
                lane: "delivery",
                mode: "owned",
                ownedPaths: ["src/checkout"],
              },
            },
            {
              id: "ctx_notes",
              title: "Release notes",
              acceptanceCriteria: "Notes are written",
              placement: { lane: "session", mode: "readOnly" },
              outputSchema: {
                type: "object",
                properties: { summary: { type: "string" } },
                required: ["summary"],
              },
            },
          ],
          tasks: [],
          edges: [],
        },
        layout: createWorkflowLayout({
          contextPositions: {
            ctx_checkout: { x: 0, y: 0 },
            ctx_notes: { x: 360, y: 0 },
          },
        }),
      });
    });
  }

  function renderMobileCanvas() {
    return renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile />
      </ReactFlowProvider>,
    );
  }

  function memberCard(contextId: string): HTMLElement {
    const card = document.querySelector<HTMLElement>(
      `[data-testid="mobile-lane-member"][data-context-id="${contextId}"]`,
    );
    expect(card).not.toBeNull();
    return card as HTMLElement;
  }

  function laneOption(laneName: string): HTMLElement {
    const option = document.querySelector<HTMLElement>(
      `[data-lane-option="${laneName}"]`,
    );
    expect(option).not.toBeNull();
    return option as HTMLElement;
  }

  function placementOf(contextId: string) {
    return _useGraphWorkflowBuilderStore
      .getState()
      .draftDefinition?.executionContexts.find(
        (context) => context.id === contextId,
      )?.placement;
  }

  it("opens the lane picker on a long-press, without selecting the context", async () => {
    loadTwoLaneDraft();
    renderMobileCanvas();

    fireEvent.pointerDown(memberCard("ctx_notes"));

    expect(await screen.findByTestId("lane-move-picker")).toHaveTextContent(
      "Release notes",
    );
    fireEvent.pointerUp(memberCard("ctx_notes"));
    fireEvent.click(memberCard("ctx_notes"));
    expect(
      _useGraphWorkflowBuilderStore.getState().selectedContextId,
    ).toBeNull();
  });

  it("writes only placement.lane when a lane is chosen", async () => {
    loadTwoLaneDraft();
    renderMobileCanvas();

    fireEvent.pointerDown(memberCard("ctx_notes"));
    await screen.findByTestId("lane-move-picker");
    fireEvent.click(laneOption("delivery"));

    await waitFor(() =>
      expect(placementOf("ctx_notes")).toEqual({
        lane: "delivery",
        mode: "readOnly",
      }),
    );
  });

  it("writes nothing on a refused choice and states reason and remedy", async () => {
    loadTwoLaneDraft();
    renderMobileCanvas();

    fireEvent.pointerDown(memberCard("ctx_checkout"));
    await screen.findByTestId("lane-move-picker");
    fireEvent.click(laneOption("session"));

    const callout = await screen.findByTestId("lane-drop-callout");
    expect(callout).toHaveAttribute("data-tone", "red");
    expect(callout).toHaveTextContent("admits only read-only contexts");
    expect(callout).toHaveTextContent("Change its grade to read-only");
    expect(placementOf("ctx_checkout")).toEqual({
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/checkout"],
    });
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  // A long-press is a pointer gesture with no keyboard or screen-reader
  // equivalent, so the same picker has to be reachable as a real control.
  it("reaches the same picker from each card's own control", async () => {
    loadTwoLaneDraft();
    renderMobileCanvas();

    fireEvent.click(
      screen.getByRole("button", { name: "Move “Release notes” to a lane" }),
    );

    expect(await screen.findByTestId("lane-move-picker")).toHaveTextContent(
      "Release notes",
    );
  });

  it("reaches the same picker from the node's context menu on a pointer canvas", async () => {
    loadTwoLaneDraft();
    const { container } = renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas />
      </ReactFlowProvider>,
    );

    const node = container.querySelector(
      '.react-flow__node[data-id="ctx_notes"]',
    );
    expect(node).not.toBeNull();
    fireEvent.contextMenu(node!);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Move to lane/ }),
    );

    expect(await screen.findByTestId("lane-move-picker")).toHaveTextContent(
      "Release notes",
    );
  });
});

describe("WorkflowBuilderCanvas inline agent configuration", () => {
  beforeEach(resetStore);

  it("creates a context override from an inherited implementer and marks the draft dirty", () => {
    const definition = createWorkflowDefinition();
    const implementer = definition.executionContexts[0]!.implementer!;
    definition.workflowConfig = { ...definition.workflowConfig, implementer };
    delete definition.executionContexts[0]!.implementer;
    _useGraphWorkflowBuilderStore
      .getState()
      .loadPersistedDraft({ definition, layout: createWorkflowLayout() });
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile />
      </ReactFlowProvider>,
    );
    const card = screen.getAllByTestId("context-node")[0]!;
    fireEvent.keyDown(
      within(card).getByRole("combobox", { name: "Implementer level" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("option", { name: "Low" }));
    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.draftDefinition?.executionContexts[0]?.implementer).toEqual({
      ...implementer,
      agent: {
        ...implementer.agent,
        modelSelection: {
          ...implementer.agent.modelSelection,
          parameters: { effort: "low" },
        },
      },
    });
    expect(state.draftDefinition?.workflowConfig?.implementer).toEqual(
      implementer,
    );
    expect(state.dirty).toBe(true);
    expect(state.selectedContextId).toBeNull();
    expect(card.closest("button")).toBeNull();
  });

  it("keeps a read-only builder free of configuration controls", () => {
    loadDraft();
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas isMobile readOnly />
      </ReactFlowProvider>,
    );
    expect(
      screen.queryByRole("combobox", { name: "Implementer level" }),
    ).toBeNull();
  });
});

function NodesProbe({ onReady }: { onReady(flow: ReactFlowInstance): void }) {
  const flow = useReactFlow();
  useEffect(() => onReady(flow), [flow, onReady]);
  return null;
}

function EditablePreview({
  onReady,
}: {
  onReady(flow: ReactFlowInstance): void;
}) {
  const [readOnly, setReadOnly] = useState(true);
  return (
    <ReactFlowProvider>
      <button onClick={() => setReadOnly(false)}>Edit preview</button>
      <WorkflowBuilderCanvas readOnly={readOnly} />
      <NodesProbe onReady={onReady} />
    </ReactFlowProvider>
  );
}

async function measureCards(flow: ReactFlowInstance) {
  await act(async () => {
    flow.setNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        measured: { width: 264, height: 420 },
      })),
    );
  });
}

describe("WorkflowBuilderCanvas read-only layout", () => {
  it("separates unpositioned cards using measured sizes without editing the draft", async () => {
    const record = createWorkflowDefinitionRecord();
    record.layout.contextPositions = {};
    record.definition.edges = [];
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft(record);
    let instance: ReactFlowInstance | undefined;
    const observe = (flow: ReactFlowInstance) => {
      instance = flow;
    };

    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas readOnly />
        <NodesProbe onReady={observe} />
      </ReactFlowProvider>,
    );

    if (!instance) throw new Error("React Flow did not mount");
    const flow = instance;
    // jsdom cannot measure cards; supply the measurements through React
    // Flow's public API so the real AutoLayout observes tall crew cards.
    await measureCards(flow);

    await waitFor(() => {
      const renderedNodes = flow.getNodes();
      expect(renderedNodes).toHaveLength(
        record.definition.executionContexts.length,
      );
      expect(renderedNodes.length).toBeGreaterThan(1);
      for (const [index, node] of renderedNodes.entries()) {
        for (const other of renderedNodes.slice(index + 1)) {
          const overlap =
            node.position.x < other.position.x + 264 &&
            node.position.x + 264 > other.position.x &&
            node.position.y < other.position.y + 420 &&
            node.position.y + 420 > other.position.y;
          expect(overlap, `${node.id} overlaps ${other.id}`).toBe(false);
        }
      }
    });

    const state = _useGraphWorkflowBuilderStore.getState();
    expect(state.draftLayout).toEqual(record.layout);
    expect(state.draftDefinition).toEqual(record.definition);
    expect(state.dirty).toBe(false);
  });

  it("generates editable positions when the same read-only draft becomes editable", async () => {
    const record = createWorkflowDefinitionRecord();
    record.layout.contextPositions = {};
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft(record);
    let instance: ReactFlowInstance | undefined;
    renderWithQuery(
      <EditablePreview
        onReady={(flow) => {
          instance = flow;
        }}
      />,
    );
    if (!instance) throw new Error("React Flow did not mount");
    const flow = instance;
    await measureCards(flow);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Edit preview" }));
    await measureCards(flow);

    await waitFor(() => {
      expect(
        Object.keys(
          _useGraphWorkflowBuilderStore.getState().draftLayout
            ?.contextPositions ?? {},
        ),
      ).toHaveLength(record.definition.executionContexts.length);
    });
  });

  it("preserves saved positions and recalculates a different draft with matching card sizes", async () => {
    const record = createWorkflowDefinitionRecord();
    record.layout.contextPositions = { "context-plan": { x: 900, y: 40 } };
    _useGraphWorkflowBuilderStore.getState().loadPersistedDraft(record);
    let instance: ReactFlowInstance | undefined;
    renderWithQuery(
      <ReactFlowProvider>
        <WorkflowBuilderCanvas readOnly />
        <NodesProbe
          onReady={(flow) => {
            instance = flow;
          }}
        />
      </ReactFlowProvider>,
    );
    if (!instance) throw new Error("React Flow did not mount");
    const flow = instance;
    await measureCards(flow);
    expect(flow.getNode("context-plan")?.position).toEqual({ x: 900, y: 40 });
    expect(_useGraphWorkflowBuilderStore.getState().draftLayout).toEqual(
      record.layout,
    );

    const next = createWorkflowDefinitionRecord();
    next.layout.contextPositions = {};
    next.definition.edges = [];
    next.definition.executionContexts.reverse();
    act(() =>
      _useGraphWorkflowBuilderStore.getState().loadPersistedDraft(next),
    );
    await measureCards(flow);

    await waitFor(() => {
      const plan = flow.getNode("context-plan");
      const verify = flow.getNode("context-verify");
      expect(plan).toBeDefined();
      expect(verify).toBeDefined();
      expect(plan?.position).not.toEqual({ x: 900, y: 40 });
      expect(
        (plan?.position.y ?? 0) - (verify?.position.y ?? 0),
      ).toBeGreaterThan(420 * 2);
    });
    expect(_useGraphWorkflowBuilderStore.getState().draftLayout).toEqual(
      next.layout,
    );
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });
});
