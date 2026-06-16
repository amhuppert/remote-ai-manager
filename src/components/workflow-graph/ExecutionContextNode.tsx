"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type {
  ContextDisplayPhase,
  DisplayValidators,
  ExecutionContextNodeData,
} from "./derive-graph";
import {
  getContextDisplayPhase,
  getDisplayApprovalGate,
  getDisplayValidators,
} from "./derive-graph";
import type { ContextWaitState } from "./derive-wait-state";

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

type AgentBackend = "claude" | "codex";

function getStatusBadge(
  mode: "builder" | "execution",
  waitState: ContextWaitState | undefined,
): { label: string; className: string } {
  if (mode === "builder") {
    return { label: "Draft", className: "pending" };
  }
  if (!waitState) {
    return { label: "Pending", className: "pending" };
  }
  switch (waitState.kind) {
    case "running":
      return { label: "Running", className: "running" };
    case "validating":
      return { label: "Validating", className: "validating" };
    case "merging":
      return { label: "Merging", className: "merging" };
    case "completed":
      return { label: "Completed", className: "completed" };
    case "published":
      return { label: "Published", className: "completed" };
    case "halted":
      return { label: "Halted", className: "halted" };
    case "awaiting-approval":
      return { label: "Awaiting Approval", className: "awaiting-approval" };
    case "ready":
      return { label: "Ready", className: "pending" };
    case "waiting-for-lane":
      return { label: "Queued", className: "pending" };
    case "waiting-for-join":
      return { label: "Queued", className: "pending" };
    case "waiting-for-capacity":
      return { label: "Queued", className: "pending" };
    case "dependency-blocked":
      return { label: "Blocked", className: "pending" };
  }
}

function getFooterText(
  mode: "builder" | "execution",
  taskCount: number,
  waitState: ContextWaitState | undefined,
  completedCount?: number,
  totalCount?: number,
): string {
  if (mode === "builder") {
    return `${taskCount} tasks`;
  }
  if (!waitState) {
    return `${taskCount} tasks`;
  }
  switch (waitState.kind) {
    case "dependency-blocked": {
      const count = waitState.unmetDependencyIds.length;
      return count === 1
        ? `Waiting on 1 upstream context`
        : `Waiting on ${count} upstream contexts`;
    }
    case "waiting-for-lane":
      return "Waiting for lane";
    case "waiting-for-join":
      return "Waiting for join";
    case "waiting-for-capacity":
      return "Waiting for capacity";
    case "ready":
      return "Ready to start";
    case "running":
      return `Running task ${(completedCount ?? 0) + 1}/${totalCount ?? taskCount}`;
    case "validating":
      return "Validating context";
    case "awaiting-approval":
      return "Awaiting your approval";
    case "merging":
      return waitState.targetBranch
        ? `Merging → ${waitState.targetBranch}`
        : "Merging";
    case "completed":
      return "Completed";
    case "published":
      return "Published to session";
    case "halted":
      return "Halted";
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

function ValidatorPills({
  validators,
  approvalGate,
}: {
  validators: DisplayValidators;
  approvalGate: boolean;
}) {
  const pills: ValidatorInfo[] = [];
  if (validators.script) pills.push({ kind: "script" });
  if (validators.agent)
    pills.push({ kind: "agent", backend: validators.agent });

  return (
    <div className="graph-node-validators">
      <div className="graph-node-validators-label">Validators</div>
      <div className="graph-node-validator-pills">
        {pills.length === 0 ? (
          <span className="graph-node-validator-pill graph-node-validator-pill--empty">
            none
          </span>
        ) : (
          pills.map((pill, idx) =>
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
          )
        )}
      </div>
      {approvalGate && (
        <div className="graph-node-gate">
          <span
            className="graph-node-validator-pill graph-node-validator-pill--approval"
            title="Human approval gate — requires manual sign-off before this context can complete"
          >
            <span className="graph-node-validator-glyph" aria-hidden="true">
              ✓
            </span>
            Human approval
          </span>
        </div>
      )}
    </div>
  );
}

export default function ExecutionContextNode({
  data,
  selected,
}: NodeProps<ExecutionContextNodeType>) {
  const { context, tasks, mode, contextState, waitState } = data;
  const phase = getContextDisplayPhase(contextState);
  const badge = getStatusBadge(mode, waitState);
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const completedCount = contextState?.completedTaskCount ?? 0;

  const footerText = getFooterText(
    mode,
    tasks.length,
    waitState,
    completedCount,
    totalCount,
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
  const approvalGate = getDisplayApprovalGate(context);

  const nodeClassName = [
    "graph-node",
    selected && "selected",
    waitState && `status-${waitState.kind}`,
    waitState?.kind === "dependency-blocked" &&
      waitState.blockedByApproval &&
      "gate-blocked",
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

      <ValidatorPills validators={validators} approvalGate={approvalGate} />

      <div className="graph-node-progress">
        <div
          className={`graph-node-progress-fill ${progressStatus}`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className={`graph-node-footer ${waitState?.kind ?? ""}`}>
        {footerText}
      </div>
    </div>
  );
}
