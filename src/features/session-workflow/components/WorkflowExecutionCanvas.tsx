"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import { classifyConfigAffordance } from "@/components/workflow-config-panel/execution-affordance";
import { nodeAgentPatch } from "@/components/workflow-graph/node-agent-edit";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import AutoLayout from "@/components/workflow-graph/AutoLayout";
import ExecutionContextNode from "@/components/workflow-graph/ExecutionContextNode";
import CanvasControls from "@/components/workflow-graph/CanvasControls";
import WorkflowMobileGraph from "@/components/workflow-graph/WorkflowMobileGraph";
import ContextEdge from "@/components/workflow-graph/ContextEdge";
import LaneBandLayer from "@/components/workflow-graph/LaneBandLayer";
import { deriveJoinConflictSummary } from "@/components/workflow-graph/join-conflict-summary";
import {
  deriveExecutionLaneBands,
  deriveExecutionPublication,
} from "@/lib/workflow-graph/lane-bands";
import { CANVAS_FIT_VIEW_PADDING } from "@/lib/workflow-graph/lane-band-geometry";
import {
  deriveNodes,
  deriveEdges,
  type ExecutionContextNodeData,
  type ContextEdgeData,
} from "@/components/workflow-graph/derive-graph";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowVisualLayout } from "@/lib/workflow-graph/definition-schemas";
const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

/** Stable empty map, so the merge memo below does not re-run every render. */
const NO_MEASURED_POSITIONS: GraphWorkflowVisualLayout["contextPositions"] = {};

export function mergeMeasuredExecutionLayout(
  layout: GraphWorkflowVisualLayout,
  measuredPositions: GraphWorkflowVisualLayout["contextPositions"],
): GraphWorkflowVisualLayout {
  if (Object.keys(measuredPositions).length === 0) return layout;
  return {
    ...layout,
    contextPositions: {
      ...layout.contextPositions,
      ...measuredPositions,
    },
  };
}

// `min-h-0` is load-bearing below 768px: the row becomes a column there, and a
// flex child without it grows past the viewport, carrying the stacked list's
// floating controls off-screen with it.
const CANVAS_WRAPPER_CLASS =
  "relative flex min-h-0 min-w-0 flex-1 flex-col max-768:[.app[data-page=workflow][data-mobile-panel=inspector]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=log]_&]:hidden";

interface WorkflowExecutionCanvasProps {
  execution: GraphWorkflowExecution;
  layout: GraphWorkflowVisualLayout;
  onSelectContext: (contextId: string | null) => void;
  /** History renders the authored launch layout exactly as it was recorded. */
  preserveLayout?: boolean;
  /**
   * At the mobile breakpoint the Graph panel is the stacked lane list (M2)
   * rather than a pannable viewport — the same substitution the builder makes,
   * for the same reason: a phone-sized window onto a canvas shows too little of
   * the graph to read its shape.
   */
  isMobile?: boolean;
  /** Which card the stacked list marks as current; React Flow owns its own. */
  selectedContextId?: string | null;
  /**
   * The blocked join member's two ways out, threaded from the panel so the lane
   * rail's join card reaches the same config destinations the halt card's
   * recovery card does (README §11).
   */
  onOpenLaneWorktree?: (contextId: string) => void;
  onEditOwnership?: (contextId: string) => void;
  onSaveContextConfig?: (operations: WorkflowLiveEditOperation[]) => void;
  isSavingConfig?: boolean;
  configSaveFromNode?: boolean;
  configEditError?: string | null;
  configEditConflict?: boolean;
}

export default function WorkflowExecutionCanvas({
  execution,
  layout,
  onSelectContext,
  preserveLayout = false,
  isMobile = false,
  selectedContextId = null,
  onOpenLaneWorktree,
  onEditOwnership,
  onSaveContextConfig,
  isSavingConfig = false,
  configSaveFromNode = true,
  configEditError,
  configEditConflict = false,
}: WorkflowExecutionCanvasProps) {
  // Positions AutoLayout generated from measured cards, tagged with the
  // execution they were measured for so another execution's geometry can never
  // be drawn. The incoming layout remains a prop so a runtime-added context can
  // use its server-provided position until the next measurement pass reflows
  // the complete live graph.
  const [measured, setMeasured] = useState<{
    executionId: string;
    contextPositions: GraphWorkflowVisualLayout["contextPositions"];
  }>({ executionId: execution.id, contextPositions: {} });

  const measuredPositions =
    measured.executionId === execution.id
      ? measured.contextPositions
      : NO_MEASURED_POSITIONS;

  // Live cards change height as their execution state changes, so measured
  // positions win wherever they exist. The incoming layout still supplies the
  // first frame and any runtime-added context that has not been measured yet.
  const effectiveLayout = useMemo(
    () => mergeMeasuredExecutionLayout(layout, measuredPositions),
    [layout, measuredPositions],
  );

  const setEffectiveLayout = useCallback(
    (next: GraphWorkflowVisualLayout) => {
      setMeasured({
        executionId: execution.id,
        contextPositions: next.contextPositions,
      });
    },
    [execution.id],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<
    Node<ExecutionContextNodeData>
  >([]);
  const [edges, setEdges] = useEdgesState<Edge<ContextEdgeData>>([]);

  // The working definition is already resolved, so it carries the effective
  // crew — but the cascade has flattened away WHICH tier set each block. The
  // launch document is the pre-cascade source that still says so, and it is
  // what lights the set-on-this-context marker with an exact reason. A run
  // seeded before the snapshot existed has none, and falls back to the partial
  // provenance the resolved context records.
  const authoredDefinition = execution.launchDocument?.definition;

  const [editingContext, setEditingContext] = useState<{
    executionId: string;
    contextId: string;
  } | null>(null);
  const editingContextId =
    editingContext?.executionId === execution.id
      ? editingContext.contextId
      : null;

  const derivedNodes = useMemo(
    () =>
      deriveNodes(execution.workingDefinition, effectiveLayout, execution, {
        ...(authoredDefinition ? { authoredDefinition } : {}),
      }).map(
        (node) =>
          ({
            ...node,
            data: {
              ...node.data,
              agentEditor: onSaveContextConfig
                ? {
                    disabled: isSavingConfig,
                    pending:
                      configSaveFromNode &&
                      isSavingConfig &&
                      editingContextId === node.id,
                    error:
                      configSaveFromNode && editingContextId === node.id
                        ? configEditConflict
                          ? "Configuration changed elsewhere. Choose the value again to retry."
                          : configEditError
                        : null,
                    onChange:
                      classifyConfigAffordance(execution, node.id)
                        .affordance === "editable"
                        ? (target, agent) => {
                            if (
                              isSavingConfig ||
                              classifyConfigAffordance(execution, node.id)
                                .affordance !== "editable"
                            )
                              return;
                            const context =
                              execution.workingDefinition.executionContexts.find(
                                (entry) => entry.id === node.id,
                              );
                            if (!context) return;
                            const patch = nodeAgentPatch(
                              context,
                              target,
                              agent,
                            );
                            if (Object.keys(patch).length === 0) return;
                            setEditingContext({
                              executionId: execution.id,
                              contextId: node.id,
                            });
                            onSaveContextConfig([
                              {
                                type: "update-context",
                                contextId: node.id,
                                ...patch,
                              },
                            ]);
                          }
                        : undefined,
                  }
                : undefined,
            },
          }) satisfies Node<ExecutionContextNodeData>,
      ),
    [
      execution,
      effectiveLayout,
      authoredDefinition,
      onSaveContextConfig,
      isSavingConfig,
      configSaveFromNode,
      editingContextId,
      configEditConflict,
      configEditError,
    ],
  );

  const derivedEdges = useMemo(
    () => deriveEdges(execution.workingDefinition, execution),
    [execution],
  );

  const bands = useMemo(() => deriveExecutionLaneBands(execution), [execution]);
  const publication = useMemo(
    () => deriveExecutionPublication(execution),
    [execution],
  );
  // Null on every run that is not halted on a join — the summary's own owner
  // decides that, so the canvas never re-reads a halt reason to guess.
  const joinConflict = useMemo(
    () =>
      execution.haltReason === null
        ? null
        : deriveJoinConflictSummary(execution, execution.haltReason),
    [execution],
  );

  useEffect(() => {
    setNodes((current) => {
      const selectedIds = new Set(
        current.filter((node) => node.selected).map((node) => node.id),
      );
      return derivedNodes.map((node) => ({
        ...node,
        selected: selectedIds.has(node.id),
      }));
    });
  }, [derivedNodes, setNodes]);

  useEffect(() => {
    setEdges(derivedEdges);
  }, [derivedEdges, setEdges]);

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      onSelectContext(selectedNodes[0]?.id ?? null);
    },
    [onSelectContext],
  );

  if (isMobile) {
    return (
      <div className={CANVAS_WRAPPER_CLASS}>
        <WorkflowMobileGraph
          bands={bands}
          mode="execution"
          nodes={derivedNodes}
          selectedContextId={selectedContextId}
          onSelectContext={onSelectContext}
          joinConflict={joinConflict}
          {...(onOpenLaneWorktree ? { onOpenLaneWorktree } : {})}
          {...(onEditOwnership ? { onEditOwnership } : {})}
        />
      </div>
    );
  }

  return (
    <div className={CANVAS_WRAPPER_CLASS}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        onSelectionChange={handleSelectionChange}
        defaultEdgeOptions={{ type: "contextEdge" }}
        fitView
        fitViewOptions={{ padding: CANVAS_FIT_VIEW_PADDING }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        {!preserveLayout && (
          // The builder owns authored positions, but a live execution owns
          // dynamic card heights. Recompute every live position from measured
          // geometry so a growing card also moves every lane beneath it.
          <AutoLayout
            definition={execution.workingDefinition}
            existingLayout={null}
            onLayout={setEffectiveLayout}
          />
        )}
        <LaneBandLayer
          bands={bands}
          mode="execution"
          publication={publication}
          joinConflict={joinConflict}
          onOpenLaneWorktree={onOpenLaneWorktree}
          onEditOwnership={onEditOwnership}
        />
        <Background
          variant={BackgroundVariant.Dots}
          color="rgba(255,255,255,0.15)"
          gap={20}
          size={2}
        />
        <CanvasControls />
      </ReactFlow>
    </div>
  );
}
