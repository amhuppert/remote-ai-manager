"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { ExecutionContextNodeData } from "./derive-graph";

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

function getStatusBadge(
  mode: "builder" | "execution",
  status?: string,
): { label: string; className: string } {
  if (mode === "builder") {
    return { label: "Draft", className: "pending" };
  }
  switch (status) {
    case "running":
      return { label: "Running", className: "running" };
    case "completed":
      return { label: "Completed", className: "completed" };
    case "halted":
      return { label: "Halted", className: "halted" };
    case "ready":
      return { label: "Ready", className: "pending" };
    default:
      return { label: "Pending", className: "pending" };
  }
}

function getFooterText(
  mode: "builder" | "execution",
  taskCount: number,
  status?: string,
  completedCount?: number,
  totalCount?: number,
): string {
  if (mode === "builder") {
    return `${taskCount} tasks`;
  }
  switch (status) {
    case "pending":
      return "Waiting on upstream";
    case "ready":
      return "Ready to start";
    case "running":
      return `Running task ${(completedCount ?? 0) + 1}/${totalCount ?? taskCount}`;
    case "completed":
      return "Completed";
    case "halted":
      return "Halted";
    default:
      return `${taskCount} tasks`;
  }
}

function getProgressPercent(
  mode: "builder" | "execution",
  completedCount?: number,
  totalCount?: number,
): number {
  if (mode === "builder" || !totalCount) return 0;
  return Math.round(((completedCount ?? 0) / totalCount) * 100);
}

export default function ExecutionContextNode({
  data,
  selected,
}: NodeProps<ExecutionContextNodeType>) {
  const { context, tasks, mode, contextState } = data;
  const status = contextState?.status;
  const badge = getStatusBadge(mode, status);
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const completedCount = contextState?.completedTaskCount ?? 0;

  const footerText = getFooterText(
    mode,
    tasks.length,
    status,
    completedCount,
    totalCount,
  );
  const progressPercent = getProgressPercent(mode, completedCount, totalCount);
  const progressStatus = status ?? "pending";

  const validatorCount = [context.taskValidation?.enabled].filter(
    Boolean,
  ).length;

  const nodeClassName = [
    "graph-node",
    selected && "selected",
    status && `status-${status}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={nodeClassName}>
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />

      <div className="graph-node-header">
        <span className="graph-node-title">{context.title}</span>
        <span className={`graph-node-badge ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {context.description && (
        <div className="graph-node-desc">{context.description}</div>
      )}

      <div className="graph-node-stats">
        <div className="graph-node-stat">
          <div className="graph-node-stat-label">Tasks</div>
          <div className="graph-node-stat-value">
            {mode === "execution"
              ? `${completedCount}/${totalCount}`
              : `0/${totalCount}`}
          </div>
        </div>
        <div className="graph-node-stat">
          <div className="graph-node-stat-label">Validators</div>
          <div className="graph-node-stat-value">{validatorCount}</div>
        </div>
      </div>

      <div className="graph-node-progress">
        <div
          className={`graph-node-progress-fill ${progressStatus}`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className={`graph-node-footer ${status ?? ""}`}>{footerText}</div>
    </div>
  );
}
