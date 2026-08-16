"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
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

import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";

import ContextEdge from "./ContextEdge";
import {
  deriveEdges,
  deriveNodes,
  type ContextEdgeData,
  type ExecutionContextNodeData,
} from "./derive-graph";
import ExecutionContextNode from "./ExecutionContextNode";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

export interface WorkflowDefinitionCanvasProps {
  readonly launch: WorkflowDefinitionMutation;
  readonly onSelectContext?: (contextId: string | null) => void;
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
}: WorkflowDefinitionCanvasProps): React.JSX.Element {
  const { definition, layout } = launch;
  const [nodes, setNodes, onNodesChange] = useNodesState<
    Node<ExecutionContextNodeData>
  >([]);
  const [edges, setEdges] = useEdgesState<Edge<ContextEdgeData>>([]);

  const derivedNodes = useMemo(
    () => deriveNodes(definition, layout),
    [definition, layout],
  );
  const derivedEdges = useMemo(() => deriveEdges(definition), [definition]);

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
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--border-default)"
          gap={20}
          size={2}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
