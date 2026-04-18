"use client";

import { useEffect, useRef } from "react";
import { useReactFlow, useNodesInitialized, type Node } from "@xyflow/react";
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

interface AutoLayoutProps {
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition;
  onLayout: (layout: GraphWorkflowVisualLayout) => void;
}

export default function AutoLayout({ definition, onLayout }: AutoLayoutProps) {
  const { getNodes } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!nodesInitialized || appliedRef.current) return;
    appliedRef.current = true;

    const dims = collectNodeDimensions(getNodes());
    if (dims.size === 0) return;

    onLayout(generateWorkflowLayout(definition, null, dims));
  }, [nodesInitialized, definition, onLayout, getNodes]);

  return null;
}
