"use client";

import { useEffect, useRef } from "react";
import { useNodes, useNodesInitialized, type Node } from "@xyflow/react";
import {
  generateWorkflowLayout,
  type NodeDimensions,
} from "@/lib/workflow-graph/layout";
import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/types";

export function collectNodeDimensions(nodes: Node[]): NodeDimensions {
  const dims: NodeDimensions = new Map();
  for (const node of nodes) {
    if (node.measured?.width != null && node.measured?.height != null) {
      dims.set(node.id, {
        width: node.measured.width,
        height: node.measured.height,
      });
    }
  }
  return dims;
}

function dimensionsKey(dims: NodeDimensions): string {
  return [...dims.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { width, height }]) => `${id}:${width}x${height}`)
    .join("|");
}

interface AutoLayoutProps {
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition;
  onLayout: (layout: GraphWorkflowVisualLayout) => void;
}

export default function AutoLayout({ definition, onLayout }: AutoLayoutProps) {
  const nodes = useNodes();
  const nodesInitialized = useNodesInitialized();
  const lastDimsKeyRef = useRef<string>("");

  useEffect(() => {
    if (!nodesInitialized) return;

    const dims = collectNodeDimensions(nodes);
    if (dims.size === 0) return;

    const key = dimensionsKey(dims);
    if (key === lastDimsKeyRef.current) return;
    lastDimsKeyRef.current = key;

    onLayout(generateWorkflowLayout(definition, null, dims));
  }, [nodes, nodesInitialized, definition, onLayout]);

  return null;
}
