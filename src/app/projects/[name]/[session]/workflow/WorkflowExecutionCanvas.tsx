"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import ExecutionContextNode from "@/components/workflow-graph/ExecutionContextNode";
import ContextEdge from "@/components/workflow-graph/ContextEdge";
import {
  deriveNodes,
  deriveEdges,
  type ExecutionContextNodeData,
  type ContextEdgeData,
} from "@/components/workflow-graph/derive-graph";
import type {
  GraphWorkflowExecution,
  GraphWorkflowVisualLayout,
} from "@/types";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

interface WorkflowExecutionCanvasProps {
  execution: GraphWorkflowExecution;
  layout: GraphWorkflowVisualLayout;
  onSelectContext: (contextId: string | null) => void;
}

export default function WorkflowExecutionCanvas({
  execution,
  layout,
  onSelectContext,
}: WorkflowExecutionCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<
    Node<ExecutionContextNodeData>
  >([]);
  const [edges, setEdges] = useEdgesState<Edge<ContextEdgeData>>([]);

  const derivedNodes = useMemo(
    () => deriveNodes(execution.workingDefinition, layout, execution),
    [execution, layout],
  );

  const derivedEdges = useMemo(
    () => deriveEdges(execution.workingDefinition, execution),
    [execution],
  );

  useEffect(() => {
    setNodes(derivedNodes);
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

  return (
    <div className="wb-canvas-wrapper">
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
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="rgba(255,255,255,0.15)"
          gap={20}
          size={2}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
