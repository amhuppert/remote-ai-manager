"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  useNodesState,
  useEdgesState,
  type Connection,
  type OnSelectionChangeParams,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import AutoLayout from "@/components/workflow-graph/AutoLayout";
import ExecutionContextNode from "@/components/workflow-graph/ExecutionContextNode";
import ContextEdge from "@/components/workflow-graph/ContextEdge";
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
const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;
const edgeTypes = { contextEdge: ContextEdge } as unknown as EdgeTypes;

const CANVAS_WRAPPER_CLASS =
  "relative flex min-w-0 flex-1 flex-col max-768:[.app[data-page=workflow-builder][data-mobile-panel=inspector]_&]:hidden";

interface WorkflowBuilderCanvasProps {
  onSelectContext?: (contextId: string | null) => void;
  globalDefaults?: WorkflowDefaults;
}

export default function WorkflowBuilderCanvas({
  onSelectContext,
  globalDefaults,
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
  const setValidationErrors = _useGraphWorkflowBuilderStore(
    (s) => s.setValidationErrors,
  );

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
    return deriveNodes(resolved, draftLayout);
  }, [draftDefinition, draftLayout, globalDefaults]);

  const derivedEdges = useMemo(() => {
    if (!draftDefinition) return [];
    return deriveEdges(draftDefinition);
  }, [draftDefinition]);

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

  const handleNodeDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback(
    (
      _event: React.MouseEvent,
      node: { id: string; position: { x: number; y: number } },
    ) => {
      isDraggingRef.current = false;
      if (!draftLayout) return;
      updateLayout(updateContextPosition(draftLayout, node.id, node.position));
    },
    [draftLayout, updateLayout],
  );

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
        setValidationErrors([]);
      } else {
        setValidationErrors(result.errors);
      }
    },
    [draftDefinition, updateDefinition, setValidationErrors],
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

  return (
    <div className={CANVAS_WRAPPER_CLASS}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onSelectionChange={handleSelectionChange}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
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
        <AutoLayout definition={draftDefinition} onLayout={updateLayout} />
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
