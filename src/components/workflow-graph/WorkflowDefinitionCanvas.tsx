"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import type { WorkflowDefaults } from "@/lib/config/schemas";
import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";

import { deriveDefinitionLaneBands } from "@/lib/workflow-graph/lane-bands";
import { CANVAS_FIT_VIEW_PADDING } from "@/lib/workflow-graph/lane-band-geometry";

import CanvasControls from "./CanvasControls";
import ContextEdge from "./ContextEdge";
import {
  deriveEdges,
  deriveNodes,
  type ContextEdgeData,
  type ExecutionContextNodeData,
} from "./derive-graph";
import ExecutionContextNode from "./ExecutionContextNode";
import LaneBandLayer from "./LaneBandLayer";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

export interface WorkflowDefinitionCanvasProps {
  readonly launch: WorkflowDefinitionMutation;
  readonly onSelectContext?: (contextId: string | null) => void;
  /**
   * The global tier this preview would launch against, so each context renders
   * the crew the cascade would give it. Required rather than optional: an
   * authored context that inherits its implementer declares none, and a caller
   * that forgot this would silently preview a workflow with no crew at all.
   * `useGlobalDefaults()` is where a caller gets it.
   */
  readonly globalDefaults: WorkflowDefaults;
}

export default function WorkflowDefinitionCanvas(
  props: WorkflowDefinitionCanvasProps,
): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <WorkflowDefinitionCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowDefinitionCanvasInner({
  launch,
  onSelectContext,
  globalDefaults,
}: WorkflowDefinitionCanvasProps): React.JSX.Element {
  const { definition, layout } = launch;
  const [nodes, setNodes, onNodesChange] = useNodesState<
    Node<ExecutionContextNodeData>
  >([]);
  const [edges, setEdges] = useEdgesState<Edge<ContextEdgeData>>([]);

  // The launch document IS the authored draft here, so it serves both jobs: it
  // is what says which blocks each context sets on itself, and — with the
  // global tier — what the cascade resolves into the crew the card shows.
  const derivedNodes = useMemo(
    () =>
      deriveNodes(definition, layout, null, {
        authoredDefinition: definition,
        workflowDefaults: globalDefaults,
      }),
    [definition, layout, globalDefaults],
  );
  const derivedEdges = useMemo(() => deriveEdges(definition), [definition]);
  // A definition preview has no runtime, so its bands read as draft lanes.
  const bands = useMemo(
    () => deriveDefinitionLaneBands(definition),
    [definition],
  );

  useEffect(() => {
    setNodes(derivedNodes);
  }, [derivedNodes, setNodes]);

  useEffect(() => {
    setEdges(derivedEdges);
  }, [derivedEdges, setEdges]);

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      onSelectContext?.(selectedNodes[0]?.id ?? null);
    },
    [onSelectContext],
  );

  return (
    <div
      data-testid="workflow-definition-canvas"
      data-workflow-id={layout.workflowId}
      className="relative min-h-96 min-w-0 overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={onSelectContext !== undefined}
        onSelectionChange={handleSelectionChange}
        defaultEdgeOptions={{ type: "contextEdge" }}
        fitView
        fitViewOptions={{ padding: CANVAS_FIT_VIEW_PADDING }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <LaneBandLayer
          bands={bands}
          mode="builder"
          loopGroups={definition.loopGroups}
        />
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--border-default)"
          gap={20}
          size={2}
        />
        <CanvasControls />
      </ReactFlow>
    </div>
  );
}
