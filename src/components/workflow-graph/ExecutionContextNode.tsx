"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type {
  ContextDisplayPhase,
  ExecutionContextNodeData,
} from "./derive-graph";
import { getContextDisplayPhase } from "./derive-graph";

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

function getStatusBadge(
  mode: "builder" | "execution",
  phase?: ContextDisplayPhase,
): { label: string; className: string } {
  if (mode === "builder") {
    return { label: "Draft", className: "pending" };
  }
  switch (phase) {
    case "running":
      return { label: "Running", className: "running" };
    case "validating":
      return { label: "Validating", className: "validating" };
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
  phase?: ContextDisplayPhase,
  completedCount?: number,
  totalCount?: number,
): string {
  if (mode === "builder") {
    return `${taskCount} tasks`;
  }
  switch (phase) {
    case "pending":
      return "Waiting on upstream";
    case "ready":
      return "Ready to start";
    case "running":
      return `Running task ${(completedCount ?? 0) + 1}/${totalCount ?? taskCount}`;
    case "validating":
      return "Validating context";
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
  const phase = getContextDisplayPhase(contextState);
  const badge = getStatusBadge(mode, phase);
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const completedCount = contextState?.completedTaskCount ?? 0;

  const footerText = getFooterText(
    mode,
    tasks.length,
    phase,
    completedCount,
    totalCount,
  );
  const progressPercent = getProgressPercent(mode, completedCount, totalCount);
  const progressStatus = phase ?? "pending";

  const contextValidator =
    "contextValidator" in context ? context.contextValidator : undefined;
  const validatorEnabled =
    contextValidator &&
    (typeof contextValidator === "object" && contextValidator !== null
      ? "enabled" in contextValidator
        ? contextValidator.enabled
        : contextValidator.kind === "use"
      : false);
  const validatorCount = validatorEnabled ? 1 : 0;

  const implementer =
    "implementer" in context ? context.implementer : undefined;
  const implementerBackend = implementer?.backend ?? "claude";

  const nodeClassName = [
    "graph-node",
    selected && "selected",
    phase && `status-${phase}`,
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

      <span className={`graph-node-backend-badge ${implementerBackend}`}>
        {implementerBackend === "codex" ? "Codex" : "Claude"}
      </span>

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

      <div className={`graph-node-footer ${phase ?? ""}`}>{footerText}</div>
    </div>
  );
}
