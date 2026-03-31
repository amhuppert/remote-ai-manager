"use client";

import { getBezierPath } from "@xyflow/react";
import type { EdgeProps, Edge } from "@xyflow/react";
import type { ContextEdgeData } from "./derive-graph";

type ContextEdgeType = Edge<ContextEdgeData>;

function getEdgeStatusClass(
  sourceStatus?: string,
  targetStatus?: string,
): string {
  if (!sourceStatus) return "edge-line";

  const sourceCompleted = sourceStatus === "completed";
  const targetCompleted = targetStatus === "completed";
  const targetRunning = targetStatus === "running";
  const targetReady = targetStatus === "ready";

  if (sourceCompleted && targetCompleted) return "edge-line completed";
  if (sourceCompleted && (targetRunning || targetReady))
    return "edge-line active";
  if ((sourceStatus === "running" || sourceCompleted) && targetRunning)
    return "edge-line active";

  return "edge-line";
}

function getArrowClass(lineClass: string): string {
  if (lineClass.includes("completed")) return "edge-arrow completed";
  if (lineClass.includes("active")) return "edge-arrow active";
  return "edge-arrow";
}

export default function ContextEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<ContextEdgeType>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const lineClass = getEdgeStatusClass(data?.sourceStatus, data?.targetStatus);
  const arrowClass = getArrowClass(lineClass);
  const markerId = `arrow-${id}`;

  return (
    <>
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="8"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 Z" className={arrowClass} />
        </marker>
      </defs>
      <path
        id={id}
        d={edgePath}
        className={`${lineClass}${selected ? " selected" : ""}`}
        markerEnd={`url(#${markerId})`}
      />
    </>
  );
}
