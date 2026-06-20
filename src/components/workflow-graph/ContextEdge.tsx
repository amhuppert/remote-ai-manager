"use client";

import { getBezierPath } from "@xyflow/react";
import type { EdgeProps, Edge } from "@xyflow/react";
import { cn } from "@/lib/ui/cn";
import type { ContextEdgeData } from "./derive-graph";

type ContextEdgeType = Edge<ContextEdgeData>;
type EdgeStatus = "default" | "active" | "completed";

function getEdgeStatus(
  sourceStatus?: string,
  targetStatus?: string,
): EdgeStatus {
  if (!sourceStatus) return "default";

  const sourceCompleted = sourceStatus === "completed";
  const targetCompleted = targetStatus === "completed";
  const targetRunning = targetStatus === "running";
  const targetReady = targetStatus === "ready";

  if (sourceCompleted && targetCompleted) return "completed";
  if (sourceCompleted && (targetRunning || targetReady)) return "active";
  if ((sourceStatus === "running" || sourceCompleted) && targetRunning)
    return "active";

  return "default";
}

// `edge-line` survives as a rule-less hook: the preserved
// `.react-flow__edge.selected .edge-line` rule (workflow-graph.css) recolours the
// path on selection via the React Flow wrapper's `.selected` class.
const EDGE_LINE_BASE =
  "edge-line fill-none stroke-2 transition-[stroke] duration-300";

const EDGE_LINE_STATUS: Record<EdgeStatus, string> = {
  default: "stroke-border-default",
  active:
    "stroke-cyan [stroke-dasharray:8_4] [animation:dash-flow_1s_linear_infinite]",
  completed: "stroke-green-dim",
};

const EDGE_ARROW_STATUS: Record<EdgeStatus, string> = {
  default: "fill-border-default",
  active: "fill-cyan",
  completed: "fill-green-dim",
};

export default function ContextEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ContextEdgeType>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const status = getEdgeStatus(data?.sourceStatus, data?.targetStatus);
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
          <path d="M 0 0 L 8 4 L 0 8 Z" className={EDGE_ARROW_STATUS[status]} />
        </marker>
      </defs>
      <path
        id={id}
        d={edgePath}
        className={cn(EDGE_LINE_BASE, EDGE_LINE_STATUS[status])}
        markerEnd={`url(#${markerId})`}
      />
    </>
  );
}
