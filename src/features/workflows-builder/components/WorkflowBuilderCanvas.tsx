"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  type Connection,
  type OnSelectionChangeParams,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import { LayoutIcon } from "@/components/icons";
import AutoLayout from "@/components/workflow-graph/AutoLayout";
import ExecutionContextNode from "@/components/workflow-graph/ExecutionContextNode";
import CanvasControls from "@/components/workflow-graph/CanvasControls";
import ContextEdge from "@/components/workflow-graph/ContextEdge";
import LaneBandLayer from "@/components/workflow-graph/LaneBandLayer";
import LaneDropOverlay from "@/components/workflow-graph/LaneDropOverlay";
import WorkflowMobileGraph from "@/components/workflow-graph/WorkflowMobileGraph";
import { deriveDefinitionLaneBands } from "@/lib/workflow-graph/lane-bands";
import { withEphemeralLaneBands } from "@/lib/workflow-graph/ephemeral-lanes";
import {
  computeLaneBandBoxes,
  type LaneBandBox,
} from "@/lib/workflow-graph/lane-band-geometry";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@/lib/workflow-graph/layout";
import {
  deriveNodes,
  deriveEdges,
  type ExecutionContextNodeData,
  type ContextEdgeData,
} from "@/components/workflow-graph/derive-graph";
import {
  addContextDependency,
  removeContextDependency,
  deleteExecutionContext,
  updateContextPosition,
} from "@/lib/workflow-graph/builder-draft";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import CanvasContextMenu, {
  type CanvasContextMenuTarget,
} from "./CanvasContextMenu";
import LaneDropCallout, { type LaneDropCalloutTone } from "./LaneDropCallout";
import LaneMovePicker from "./LaneMovePicker";
import {
  laneDropCalloutFor,
  resolveLaneDragDrop,
  resolveLaneDragHover,
  type LaneDragDrop,
  type LaneDragOrigin,
} from "./lane-drag";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

// `min-h-0` is load-bearing below 768px: the row becomes a column there, and a
// flex child without it grows past the viewport, carrying the floating graph
// controls off-screen with it.
const CANVAS_WRAPPER_CLASS =
  "relative flex min-h-0 min-w-0 flex-1 flex-col max-768:[.app[data-page=workflow-builder][data-mobile-panel=inspector]_&]:hidden";

interface WorkflowBuilderCanvasProps {
  onSelectContext?: (contextId: string | null) => void;
  globalDefaults?: WorkflowDefaults;
  /**
   * At the mobile breakpoint the Graph panel is the stacked lane list (M1)
   * rather than a pannable viewport — a phone-sized window onto a canvas shows
   * too little of the graph to read its shape.
   */
  isMobile?: boolean;
}

/**
 * A node drag in flight (README §2.1). The bands are captured at drag START and
 * held for the whole gesture: they are the geometry the drop is judged against,
 * and re-deriving them mid-drag would let the band the node is leaving follow
 * it across the canvas.
 */
interface LaneDragState {
  origin: LaneDragOrigin;
  boxes: LaneBandBox[];
  position: { x: number; y: number };
  /** The band being crossed into, or null while the drag stays home. */
  targetLane: string | null;
  accepted: boolean;
  previewLabel: string;
  /** Escape during the gesture: the drop writes nothing at all. */
  cancelled: boolean;
}

interface LaneDropCalloutState {
  tone: LaneDropCalloutTone;
  title: string;
  message: string;
  footnote: string | null;
}

const EPHEMERAL_MERGE_FOOTNOTE =
  "Nothing was written: an empty lane is draft UI, so there was no duplicate to remove from the definition.";

function nodeSize(node: {
  measured?: { width?: number | null; height?: number | null };
  width?: number | null;
  height?: number | null;
}): { width: number; height: number } {
  return {
    width: node.measured?.width || node.width || DEFAULT_NODE_WIDTH,
    height: node.measured?.height || node.height || DEFAULT_NODE_HEIGHT,
  };
}

export default function WorkflowBuilderCanvas({
  onSelectContext,
  globalDefaults,
  isMobile = false,
}: WorkflowBuilderCanvasProps) {
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (s) => s.draftDefinition,
  );
  const draftLayout = _useGraphWorkflowBuilderStore((s) => s.draftLayout);
  const updateDefinition = _useGraphWorkflowBuilderStore(
    (s) => s.updateDefinition,
  );
  const updateLayout = _useGraphWorkflowBuilderStore((s) => s.updateLayout);
  const setSelectedContextId = _useGraphWorkflowBuilderStore(
    (s) => s.setSelectedContextId,
  );
  const setRefusedEdits = _useGraphWorkflowBuilderStore(
    (s) => s.setRefusedEdits,
  );
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (s) => s.selectedContextId,
  );
  const ephemeralLanes = _useGraphWorkflowBuilderStore((s) => s.ephemeralLanes);
  const renameEphemeralLane = _useGraphWorkflowBuilderStore(
    (s) => s.renameEphemeralLane,
  );
  const removeEphemeralLane = _useGraphWorkflowBuilderStore(
    (s) => s.removeEphemeralLane,
  );
  const [menuTarget, setMenuTarget] = useState<CanvasContextMenuTarget | null>(
    null,
  );
  const [laneDrag, setLaneDrag] = useState<LaneDragState | null>(null);
  const [dropCallout, setDropCallout] = useState<LaneDropCalloutState | null>(
    null,
  );
  /** The context whose lane picker is open — touch re-placement (README §12). */
  const [movingContextId, setMovingContextId] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<
    Node<ExecutionContextNodeData>
  >([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<ContextEdgeData>>(
    [],
  );

  const isDraggingRef = useRef(false);

  const derivedNodes = useMemo(() => {
    if (!draftDefinition || !draftLayout) return [];
    const resolved = resolveWorkflowDefinition(
      { workflowDefaults: globalDefaults } as GlobalConfig,
      draftDefinition,
    );
    // The authored draft is what says which fields were set on the context
    // itself, so the set-here marker is exact here rather than inferred from
    // the resolved definition's per-field provenance.
    return deriveNodes(resolved, draftLayout, null, {
      authoredDefinition: draftDefinition,
    });
  }, [draftDefinition, draftLayout, globalDefaults]);

  const derivedEdges = useMemo(() => {
    if (!draftDefinition) return [];
    return deriveEdges(draftDefinition);
  }, [draftDefinition]);

  const bands = useMemo(
    () => (draftDefinition ? deriveDefinitionLaneBands(draftDefinition) : []),
    [draftDefinition],
  );

  // A lane the draft now names is a REAL lane: its band is derived from the
  // placement that named it, so the client-only copy has become a duplicate.
  // Promotion is decided here rather than in the drop handler because a drop is
  // not the only way a context reaches a lane — the Placement screen's lane
  // field writes the same field, and either route must retire the band.
  const emptyLanes = useMemo(() => {
    const real = new Set(bands.map((band) => band.laneName));
    return ephemeralLanes.filter((lane) => !real.has(lane.name));
  }, [bands, ephemeralLanes]);

  useEffect(() => {
    for (const lane of ephemeralLanes) {
      if (!emptyLanes.includes(lane)) removeEphemeralLane(lane.id);
    }
  }, [emptyLanes, ephemeralLanes, removeEphemeralLane]);

  // Hit-testing runs over the bands the author can SEE, empty ones included:
  // an ephemeral lane is a drop target from the moment it is drawn, which is
  // the only way a context can ever land on it (README §2.2).
  const dragBands = useMemo(
    () => withEphemeralLaneBands(bands, emptyLanes),
    [bands, emptyLanes],
  );

  useEffect(() => {
    if (!isDraggingRef.current) {
      // Preserve React Flow's selected state when updating nodes from store changes,
      // otherwise re-deriving nodes clears selection and deselects the inspector panel
      setNodes((currentNodes) => {
        const selectedIds = new Set(
          currentNodes.filter((n) => n.selected).map((n) => n.id),
        );
        if (selectedIds.size === 0) return derivedNodes;
        return derivedNodes.map((node) =>
          selectedIds.has(node.id) ? { ...node, selected: true } : node,
        );
      });
    }
  }, [derivedNodes, setNodes]);

  useEffect(() => {
    setEdges(derivedEdges);
  }, [derivedEdges, setEdges]);

  const handleNodeDragStart = useCallback(
    (_event: React.MouseEvent, node: Node<ExecutionContextNodeData>) => {
      isDraggingRef.current = true;
      setDropCallout(null);
      const lane = draftDefinition?.executionContexts.find(
        (context) => context.id === node.id,
      )?.placement?.lane;
      if (lane === undefined) return;

      setLaneDrag({
        origin: {
          contextId: node.id,
          lane,
          position: node.position,
          size: nodeSize(node),
        },
        boxes: computeLaneBandBoxes(
          dragBands,
          nodes.map((entry) => ({
            id: entry.id,
            x: entry.position.x,
            y: entry.position.y,
            ...nodeSize(entry),
          })),
        ),
        position: node.position,
        targetLane: null,
        accepted: false,
        previewLabel: "",
        cancelled: false,
      });
    },
    [dragBands, draftDefinition, nodes],
  );

  const handleNodeDrag = useCallback(
    (
      _event: React.MouseEvent,
      node: { id: string; position: { x: number; y: number } },
    ) => {
      if (!draftDefinition) return;
      setLaneDrag((current) => {
        if (
          !current ||
          current.cancelled ||
          current.origin.contextId !== node.id
        ) {
          return current;
        }
        const hover = resolveLaneDragHover({
          definition: draftDefinition,
          boxes: current.boxes,
          origin: current.origin,
          position: node.position,
        });
        return {
          ...current,
          position: node.position,
          targetLane: hover.targetLane,
          accepted: hover.evaluation?.outcome === "accepted",
          previewLabel: hover.evaluation?.previewLabel ?? "",
        };
      });
    },
    [draftDefinition],
  );

  /** Put a refused — or cancelled — node back where the gesture started. */
  const returnNodeToLane = useCallback(
    (drag: LaneDragState) => {
      setNodes((currentNodes) =>
        currentNodes.map((node) =>
          node.id === drag.origin.contextId
            ? { ...node, position: { ...drag.origin.position } }
            : node,
        ),
      );
    },
    [setNodes],
  );

  const handleNodeDragStop = useCallback(
    (
      _event: React.MouseEvent,
      node: { id: string; position: { x: number; y: number } },
    ) => {
      isDraggingRef.current = false;
      const drag = laneDrag;
      setLaneDrag(null);
      if (!draftLayout) return;

      if (drag?.cancelled) {
        returnNodeToLane(drag);
        return;
      }

      const drop =
        drag && draftDefinition
          ? resolveLaneDragDrop({
              definition: draftDefinition,
              boxes: drag.boxes,
              origin: drag.origin,
              position: node.position,
            })
          : ({ kind: "layout" } as const);

      setDropCallout(laneDropCalloutFor(drop));

      if (drop.kind === "refused") {
        // The draft is untouched: only the card and the node's own position
        // change, so a refusal can never leave a half-applied placement.
        if (drag) returnNodeToLane(drag);
        return;
      }

      if (drop.kind === "replace") {
        updateDefinition(drop.definition);
      }
      updateLayout(updateContextPosition(draftLayout, node.id, node.position));
    },
    [
      draftDefinition,
      draftLayout,
      laneDrag,
      returnNodeToLane,
      updateDefinition,
      updateLayout,
    ],
  );

  const handleMergeEphemeralLane = useCallback(
    (id: string, notice: string) => {
      removeEphemeralLane(id);
      setDropCallout({
        tone: "amber",
        title: "Lane already exists",
        message: notice,
        footnote: EPHEMERAL_MERGE_FOOTNOTE,
      });
    },
    [removeEphemeralLane],
  );

  // Escape abandons the gesture: the pointer is still down, so the drop that
  // follows has to know it was cancelled rather than aimed.
  useEffect(() => {
    if (!laneDrag || laneDrag.cancelled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLaneDrag((current) =>
        current ? { ...current, cancelled: true, targetLane: null } : current,
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [laneDrag]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!draftDefinition || !connection.source || !connection.target) return;
      const result = addContextDependency(
        draftDefinition,
        connection.source,
        connection.target,
      );
      if (result.ok) {
        updateDefinition(result.definition);
      } else {
        setRefusedEdits(result.errors);
      }
    },
    [draftDefinition, updateDefinition, setRefusedEdits],
  );

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      const id = selectedNodes[0]?.id ?? null;
      setSelectedContextId(id);
      onSelectContext?.(id);
    },
    [setSelectedContextId, onSelectContext],
  );

  const handleNodesDelete = useCallback(
    (deletedNodes: { id: string }[]) => {
      if (!draftDefinition || !draftLayout) return;
      let def = draftDefinition;
      let lay = draftLayout;
      for (const node of deletedNodes) {
        const result = deleteExecutionContext(
          { definition: def, layout: lay },
          node.id,
        );
        def = result.definition;
        lay = result.layout;
      }
      updateDefinition(def);
      updateLayout(lay);
      setSelectedContextId(null);
    },
    [
      draftDefinition,
      draftLayout,
      updateDefinition,
      updateLayout,
      setSelectedContextId,
    ],
  );

  const handleEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      if (!draftDefinition) return;
      let def = draftDefinition;
      for (const edge of deletedEdges) {
        def = removeContextDependency(def, edge.id);
      }
      updateDefinition(def);
    },
    [draftDefinition, updateDefinition],
  );

  // React Flow reports a right-click as an event on the node or edge under the
  // pointer; the menu it opens is the same deletion the Delete key performs, so
  // both routes run through the handlers above rather than a second recipe.
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node<ExecutionContextNodeData>) => {
      event.preventDefault();
      setMenuTarget({
        kind: "node",
        id: node.id,
        title: node.data.context.title,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [],
  );

  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge<ContextEdgeData>) => {
      event.preventDefault();
      setMenuTarget({
        kind: "edge",
        id: edge.id,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [],
  );

  const closeMenu = useCallback(() => setMenuTarget(null), []);

  // The mobile list has no React Flow selection to piggyback on, so it writes
  // the store's selection directly — the same field the canvas's selection
  // change handler sets, so the inspector cannot tell the two routes apart.
  const handleSelectMobileContext = useCallback(
    (contextId: string) => {
      setSelectedContextId(contextId);
      onSelectContext?.(contextId);
    },
    [onSelectContext, setSelectedContextId],
  );

  const handleMenuDeleteContext = useCallback(
    (contextId: string) => {
      setMenuTarget(null);
      handleNodesDelete([{ id: contextId }]);
    },
    [handleNodesDelete],
  );

  const handleMenuDeleteDependency = useCallback(
    (edgeId: string) => {
      setMenuTarget(null);
      handleEdgesDelete([{ id: edgeId }]);
    },
    [handleEdgesDelete],
  );

  // The picker's verdict IS the drag's verdict (README §12), so it is applied
  // the same way: an accepted drop writes the draft it carries, a refusal writes
  // nothing at all, and both speak through the card a released drag leaves.
  const handleLaneChoice = useCallback(
    (drop: LaneDragDrop) => {
      setDropCallout(laneDropCalloutFor(drop));
      if (drop.kind === "replace") updateDefinition(drop.definition);
    },
    [updateDefinition],
  );

  const handleMenuMoveContext = useCallback((contextId: string) => {
    setMenuTarget(null);
    setMovingContextId(contextId);
  }, []);

  const closeLanePicker = useCallback(() => setMovingContextId(null), []);

  // The picker offers the same set of lanes a drag can hit: every band on the
  // canvas, empty ones included.
  const pickerLaneNames = useMemo(
    () => dragBands.map((band) => band.laneName),
    [dragBands],
  );

  // A long-press has no keyboard or screen-reader equivalent, so each mobile
  // card carries the same route as a real control.
  const renderMemberMoveAction = useCallback(
    (contextId: string) => {
      const title =
        draftDefinition?.executionContexts.find(
          (context) => context.id === contextId,
        )?.title ?? contextId;
      return (
        <button
          type="button"
          aria-label={`Move “${title}” to a lane`}
          onClick={() => setMovingContextId(contextId)}
          className="inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-xs rounded-md border border-solid border-border-subtle bg-bg-surface px-[10px] py-[6px] font-mono text-[0.7rem] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]"
        >
          <LayoutIcon size={12} />
          Move to lane…
        </button>
      );
    },
    [draftDefinition],
  );

  // Faithful transcription of the legacy `.wb-empty-state`/`-text` recipe
  // (full-height, gap-md, 0.82rem/500). This is NOT the `EmptyState` primitive
  // recipe (`.empty-state*`: padded, text-center, bold 1.1rem display title) —
  // swapping to it would change appearance, so parity keeps this builder-local
  // form. Only SessionWorkflowPage, which used the real `.empty-state*`, uses it.
  if (!draftDefinition || !draftLayout) {
    return (
      <div className={CANVAS_WRAPPER_CLASS}>
        <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
          <span className="text-[0.82rem] font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  if (draftDefinition.executionContexts.length === 0) {
    return (
      <div className={CANVAS_WRAPPER_CLASS}>
        <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
          <span className="text-[0.82rem] font-medium">
            Add your first execution context
          </span>
        </div>
      </div>
    );
  }

  const lanePicker = (
    <LaneMovePicker
      definition={draftDefinition}
      contextId={movingContextId}
      laneNames={pickerLaneNames}
      onResolve={handleLaneChoice}
      onClose={closeLanePicker}
    />
  );

  const callout = dropCallout && (
    <LaneDropCallout
      tone={dropCallout.tone}
      title={dropCallout.title}
      message={dropCallout.message}
      footnote={dropCallout.footnote}
      onDismiss={() => setDropCallout(null)}
    />
  );

  if (isMobile) {
    return (
      <div className={CANVAS_WRAPPER_CLASS}>
        <WorkflowMobileGraph
          bands={bands}
          mode="builder"
          nodes={derivedNodes}
          selectedContextId={selectedContextId}
          onSelectContext={handleSelectMobileContext}
          emptyLaneNames={emptyLanes.map((lane) => lane.name)}
          onLongPressContext={setMovingContextId}
          renderMemberActions={renderMemberMoveAction}
        />
        {callout}
        {lanePicker}
      </div>
    );
  }

  return (
    <div className={CANVAS_WRAPPER_CLASS}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onSelectionChange={handleSelectionChange}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "contextEdge" }}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={120}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        {/* The draft layout wins: mounting the canvas measures cards, it does
            not re-place contexts the author already positioned. Regenerating
            the whole graph is Re-layout's act, in the toolbar. */}
        <AutoLayout
          definition={draftDefinition}
          existingLayout={draftLayout}
          onLayout={updateLayout}
        />
        <LaneBandLayer
          bands={bands}
          mode="builder"
          dropTarget={
            laneDrag?.targetLane
              ? { laneName: laneDrag.targetLane, accepted: laneDrag.accepted }
              : null
          }
          pinnedNode={
            laneDrag
              ? {
                  id: laneDrag.origin.contextId,
                  x: laneDrag.origin.position.x,
                  y: laneDrag.origin.position.y,
                }
              : null
          }
          ephemeralLanes={emptyLanes}
          onRenameEphemeralLane={renameEphemeralLane}
          onMergeEphemeralLane={handleMergeEphemeralLane}
          onRemoveEphemeralLane={removeEphemeralLane}
        />
        {laneDrag?.targetLane && (
          <LaneDropOverlay
            ghost={{
              x: laneDrag.origin.position.x,
              y: laneDrag.origin.position.y,
              width: laneDrag.origin.size.width,
              height: laneDrag.origin.size.height,
              laneName: laneDrag.origin.lane,
            }}
            preview={{
              x: laneDrag.position.x,
              y: laneDrag.position.y,
              label: laneDrag.previewLabel,
              accepted: laneDrag.accepted,
            }}
          />
        )}
        <Background
          variant={BackgroundVariant.Dots}
          color="rgba(255,255,255,0.15)"
          gap={20}
          size={2}
        />
        <CanvasControls />
      </ReactFlow>
      {callout}
      <CanvasContextMenu
        target={menuTarget}
        onClose={closeMenu}
        onDeleteContext={handleMenuDeleteContext}
        onDeleteDependency={handleMenuDeleteDependency}
        onMoveContext={handleMenuMoveContext}
      />
      {lanePicker}
    </div>
  );
}
