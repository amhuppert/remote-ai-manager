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
} from "@/lib/workflow-graph/definition-schemas";
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

function samePositions(
  a: GraphWorkflowVisualLayout,
  b: GraphWorkflowVisualLayout,
): boolean {
  const left = a.contextPositions;
  const right = b.contextPositions;
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    if (left[id]?.x !== right[id]?.x || left[id]?.y !== right[id]?.y) {
      return false;
    }
  }
  return true;
}

interface AutoLayoutProps {
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition;
  /**
   * The layout as it stands. Its explicit positions WIN: measurement re-runs
   * the geometry for contexts that have none, and never re-places one a human
   * dragged or a Re-layout committed. Required rather than optional — a canvas
   * that forgot it would silently discard its saved layout on every mount, so
   * a canvas with nothing to preserve passes `null` and says so.
   */
  existingLayout: GraphWorkflowVisualLayout | null;
  onLayout: (layout: GraphWorkflowVisualLayout) => void;
}

export default function AutoLayout({
  definition,
  existingLayout,
  onLayout,
}: AutoLayoutProps) {
  const nodes = useNodes();
  const nodesInitialized = useNodesInitialized();
  const lastInputsRef = useRef<{
    dimensions: string;
    definition: AutoLayoutProps["definition"];
    existingLayout: AutoLayoutProps["existingLayout"];
  } | null>(null);

  useEffect(() => {
    if (!nodesInitialized) return;

    const dims = collectNodeDimensions(nodes);
    if (dims.size === 0) return;

    const key = dimensionsKey(dims);
    const previous = lastInputsRef.current;
    if (
      key === previous?.dimensions &&
      definition === previous.definition &&
      existingLayout === previous.existingLayout
    )
      return;
    lastInputsRef.current = { dimensions: key, definition, existingLayout };

    const next = generateWorkflowLayout(definition, existingLayout, dims);
    // A layout that places nothing new is not an edit: reporting it would mark
    // a clean draft dirty on every mount.
    if (existingLayout && samePositions(next, existingLayout)) return;
    onLayout(next);
  }, [nodes, nodesInitialized, definition, existingLayout, onLayout]);

  return null;
}
