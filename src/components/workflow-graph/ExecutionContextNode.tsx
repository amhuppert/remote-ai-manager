"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type {
  ContextDisplayPhase,
  DisplayValidators,
  ExecutionContextNodeData,
} from "./derive-graph";
import { getContextDisplayPhase, getDisplayValidators } from "./derive-graph";

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

type AgentBackend = "claude" | "codex";

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
    case "merging":
      return { label: "Merging", className: "merging" };
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
  targetBranch?: string | null,
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
    case "merging":
      return targetBranch ? `Merging → ${targetBranch}` : "Merging";
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
  phase?: ContextDisplayPhase,
): number {
  if (mode === "builder" || !totalCount) return 0;
  if (phase === "merging" || phase === "completed") return 100;
  return Math.round(((completedCount ?? 0) / totalCount) * 100);
}

type ValidatorInfo =
  | { kind: "agent"; backend: AgentBackend }
  | { kind: "script" };

function ValidatorPills({ validators }: { validators: DisplayValidators }) {
  const pills: ValidatorInfo[] = [];
  if (validators.script) pills.push({ kind: "script" });
  if (validators.agent)
    pills.push({ kind: "agent", backend: validators.agent });

  if (pills.length === 0) {
    return (
      <div className="graph-node-validators">
        <div className="graph-node-validators-label">Validators</div>
        <div className="graph-node-validator-pills">
          <span className="graph-node-validator-pill graph-node-validator-pill--empty">
            none
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-node-validators">
      <div className="graph-node-validators-label">Validators</div>
      <div className="graph-node-validator-pills">
        {pills.map((pill, idx) =>
          pill.kind === "script" ? (
            <span
              key={`script-${idx}`}
              className="graph-node-validator-pill graph-node-validator-pill--script"
              title="Script validator enabled"
            >
              <span className="graph-node-validator-glyph" aria-hidden="true">
                ▣
              </span>
              Script
            </span>
          ) : (
            <span
              key={`agent-${idx}`}
              className={`graph-node-validator-pill graph-node-validator-pill--${pill.backend}`}
              title={`Agent validator: ${pill.backend === "codex" ? "Codex" : "Claude"}`}
            >
              <span className="graph-node-validator-glyph" aria-hidden="true">
                ◆
              </span>
              {pill.backend === "codex" ? "Codex" : "Claude"}
            </span>
          ),
        )}
      </div>
    </div>
  );
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
  const targetBranch = contextState?.branchName ?? null;

  const footerText = getFooterText(
    mode,
    tasks.length,
    phase,
    completedCount,
    totalCount,
    targetBranch,
  );
  const progressPercent = getProgressPercent(
    mode,
    completedCount,
    totalCount,
    phase,
  );
  const progressStatus = phase ?? "pending";

  const implementer =
    "implementer" in context ? context.implementer : undefined;
  const implementerBackend: AgentBackend = implementer?.backend ?? "claude";

  const validators = getDisplayValidators(context);

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
          <div className="graph-node-stat-label">Implementer</div>
          <div
            className={`graph-node-stat-value graph-node-stat-value--agent graph-node-stat-value--${implementerBackend}`}
          >
            <span className="graph-node-validator-glyph" aria-hidden="true">
              ◆
            </span>
            {implementerBackend === "codex" ? "Codex" : "Claude"}
          </div>
        </div>
      </div>

      <ValidatorPills validators={validators} />

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
