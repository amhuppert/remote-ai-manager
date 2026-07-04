"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import { cn } from "@/lib/ui/cn";
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

type WaitKind = ContextWaitState["kind"];

/**
 * Base appearance of the custom graph node. `graph-node` / `selected` survive as
 * rule-less class hooks because preserved React Flow rules in workflow-graph.css
 * (`.graph-node:hover .react-flow__handle`, `.graph-node.selected .react-flow__handle`)
 * still target the handle through them, and the handle reads the inherited
 * `--node-color` set here. The `::before`/`::after` decorative gradients are
 * carried as `before:`/`after:` utilities; their opacity is toggled per status.
 */
const NODE_BASE = cn(
  "graph-node",
  "relative w-[248px] overflow-hidden rounded-[14px] pt-[18px] pr-[16px] pb-[14px] pl-[16px]",
  "cursor-pointer border border-solid border-border-subtle transition-opacity duration-200",
  "bg-[linear-gradient(175deg,var(--cc-graph-node-grad-top)_0%,var(--cc-graph-node-grad-bottom)_100%)]",
  "[--node-color-glow:transparent] [--node-color:var(--border-subtle)]",
  "before:absolute before:top-[-1px] before:right-[10%] before:left-[10%] before:h-[2px] before:rounded-[2px] before:bg-[linear-gradient(90deg,transparent_0%,var(--node-color)_30%,var(--node-color)_70%,transparent_100%)] before:opacity-0 before:transition-opacity before:duration-300 before:content-['']",
  "after:pointer-events-none after:absolute after:top-0 after:right-[15%] after:left-[15%] after:h-[24px] after:bg-[radial-gradient(ellipse_at_top_center,var(--node-color-glow)_0%,transparent_70%)] after:opacity-0 after:transition-opacity after:duration-300 after:content-['']",
);

const HOVER_LIFT = "hover:shadow-[0_4px_20px_var(--cc-black-a35)]";

/** Effective node appearance per status when NOT selected (cascade resolved). */
const STATUS_UNSELECTED: Partial<Record<WaitKind, string>> = {
  running:
    "[--node-color:var(--cyan)] [--node-color-glow:var(--cyan-glow)] border-[var(--cc-cyan-a25)] [border-top-color:var(--cc-cyan-a50)] [animation:pulse-node_2s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  validating:
    "[--node-color:var(--amber)] [--node-color-glow:var(--amber-glow)] border-[var(--cc-amber-a30)] [border-top-color:var(--cc-amber-a55)] [animation:pulse-node_2s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  "awaiting-approval":
    "[--node-color:var(--amber)] [--node-color-glow:var(--amber-glow)] border-[var(--cc-amber-a40)] [border-top-color:var(--cc-amber-a60)] [animation:pulse-node_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  "awaiting-user-input":
    "[--node-color:var(--violet)] [--node-color-glow:var(--violet-glow)] border-[color-mix(in_srgb,var(--violet)_40%,transparent)] [border-top-color:color-mix(in_srgb,var(--violet)_60%,transparent)] [animation:pulse-node_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  completed:
    "[--node-color:var(--green)] [--node-color-glow:var(--cc-green-a10)] border-[var(--cc-green-a20)] [border-top-color:var(--cc-green-a45)] before:opacity-100 after:opacity-70 " +
    HOVER_LIFT,
  merging:
    "[--node-color:var(--green)] [--node-color-glow:var(--cc-green-a18)] border-[var(--cc-green-a32)] [border-top-color:var(--cc-green-a60)] [animation:pulse-node_1.6s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  halted:
    "[--node-color:var(--red)] [--node-color-glow:var(--red-glow)] border-[var(--cc-red-a20)] [border-top-color:var(--cc-red-a45)] before:opacity-100 after:opacity-70 " +
    HOVER_LIFT,
};

/** Effective node appearance per status when selected (compound rules resolved). */
const STATUS_SELECTED: Partial<Record<WaitKind, string>> = {
  running:
    "[--node-color:var(--cyan)] [--node-color-glow:var(--cyan-glow)] border-[var(--cc-cyan-a40)] [animation:pulse-node-selected_2s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  validating:
    "[--node-color:var(--amber)] [--node-color-glow:var(--amber-glow)] border-[var(--cc-amber-a45)] [animation:pulse-node-validating-selected_2s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  "awaiting-approval":
    "[--node-color:var(--amber)] [--node-color-glow:var(--amber-glow)] border-[var(--cc-amber-a40)] [border-top-color:var(--cc-amber-a60)] [animation:pulse-node_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  "awaiting-user-input":
    "[--node-color:var(--violet)] [--node-color-glow:var(--violet-glow)] border-[color-mix(in_srgb,var(--violet)_45%,transparent)] [border-top-color:color-mix(in_srgb,var(--violet)_60%,transparent)] [animation:pulse-node_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  completed:
    "[--node-color:var(--green)] [--node-color-glow:var(--cc-green-a10)] border-[var(--cc-green-a20)] [border-top-color:var(--cc-green-a45)] shadow-[0_0_20px_var(--cyan-glow)] before:opacity-100 after:opacity-70",
  merging:
    "[--node-color:var(--green)] [--node-color-glow:var(--cc-green-a18)] border-[color-mix(in_srgb,var(--green)_50%,transparent)] [animation:pulse-node-merging-selected_1.6s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
  halted:
    "[--node-color:var(--red)] [--node-color-glow:var(--red-glow)] border-[var(--cc-red-a20)] [border-top-color:var(--cc-red-a45)] shadow-[0_0_20px_var(--cyan-glow)] before:opacity-100 after:opacity-70",
};

/** Selected with a status that has no status-specific styling (e.g. ready). */
const SELECTED_BASE =
  "[--node-color:var(--cyan)] [--node-color-glow:var(--cc-cyan-a12)] border-[var(--cc-cyan-a35)] shadow-[0_0_20px_var(--cyan-glow)] before:opacity-100 after:opacity-100";

function nodeAppearance(kind: WaitKind | undefined, selected: boolean): string {
  if (!selected) {
    return (kind && STATUS_UNSELECTED[kind]) ?? HOVER_LIFT;
  }
  return (kind && STATUS_SELECTED[kind]) ?? SELECTED_BASE;
}

const BADGE_BASE =
  "mt-[2px] shrink-0 whitespace-nowrap rounded-[20px] px-[10px] py-[4px] text-[0.7rem] font-semibold uppercase tracking-[0.06em]";

const BADGE_VARIANT: Record<string, string> = {
  pending:
    "border border-solid border-border-default bg-transparent text-text-tertiary",
  running:
    "border border-solid border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a08)] text-cyan",
  validating:
    "border border-solid border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] text-amber",
  completed:
    "border border-solid border-[var(--cc-green-border)] bg-[var(--cc-green-a08)] text-green",
  halted:
    "border border-solid border-[var(--cc-red-a25)] bg-[var(--cc-red-a08)] text-red",
  "awaiting-approval":
    "border border-solid border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] text-amber",
  "awaiting-user-input":
    "border border-solid border-[color-mix(in_srgb,var(--violet)_35%,transparent)] bg-[var(--violet-glow)] text-violet",
  merging:
    "border border-solid border-[var(--cc-green-a35)] bg-[var(--cc-green-a10)] text-green",
};

const PROGRESS_FILL_BASE =
  "h-full rounded-[4px] transition-[width] duration-[400ms] ease-[ease]";

const PROGRESS_FILL_VARIANT: Record<string, string> = {
  pending: "bg-border-default",
  running: "bg-cyan shadow-[0_0_6px_var(--cyan-glow)]",
  validating: "bg-amber shadow-[0_0_6px_var(--amber-glow)]",
  completed: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  halted: "bg-red",
  merging:
    "bg-[linear-gradient(90deg,var(--green)_0%,var(--cc-tdd-border-hover)_50%,var(--green)_100%)] [background-size:24px_100%] shadow-[0_0_6px_var(--green-glow)] [animation:merging-chevron_1.1s_linear_infinite]",
};

const FOOTER_COLOR: Partial<Record<WaitKind, string>> = {
  running: "text-text-secondary",
  validating: "text-amber",
  "awaiting-user-input": "text-violet",
  completed: "text-text-secondary",
  halted: "text-text-secondary",
};

const VALIDATOR_PILL_BASE =
  "inline-flex items-center gap-[4px] rounded-[4px] border border-solid px-[8px] py-[3px] text-[0.68rem] font-semibold uppercase tracking-[0.05em]";

const VALIDATOR_PILL_VARIANT = {
  empty:
    "border-dashed border-border-subtle bg-[var(--cc-graph-ink-a55)] normal-case italic tracking-normal text-text-tertiary",
  script:
    "border-border-default bg-[var(--cc-graph-ink-a55)] text-text-primary",
  claude: "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a06)] text-cyan",
  codex: "border-[var(--cc-codex-violet-a35)] bg-violet-glow text-violet",
  approval: "border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
} as const;

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
    case "awaiting-user-input":
      return { label: "Awaiting Input", className: "awaiting-user-input" };
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
    case "awaiting-user-input":
      return "Awaiting your answer";
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
    <div className="relative z-[1] mb-[10px]">
      <div className="mb-[4px] text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Validators
      </div>
      <div className="flex flex-wrap gap-[4px]">
        {pills.length === 0 ? (
          <span
            className={cn(VALIDATOR_PILL_BASE, VALIDATOR_PILL_VARIANT.empty)}
          >
            none
          </span>
        ) : (
          pills.map((pill, idx) =>
            pill.kind === "script" ? (
              <span
                key={`script-${idx}`}
                className={cn(
                  VALIDATOR_PILL_BASE,
                  VALIDATOR_PILL_VARIANT.script,
                )}
                title="Script validator enabled"
              >
                <span className="text-[0.7rem] leading-none" aria-hidden="true">
                  ▣
                </span>
                Script
              </span>
            ) : (
              <span
                key={`agent-${idx}`}
                className={cn(
                  VALIDATOR_PILL_BASE,
                  VALIDATOR_PILL_VARIANT[pill.backend],
                )}
                title={`Agent validator: ${pill.backend === "codex" ? "Codex" : "Claude"}`}
              >
                <span className="text-[0.7rem] leading-none" aria-hidden="true">
                  ◆
                </span>
                {pill.backend === "codex" ? "Codex" : "Claude"}
              </span>
            ),
          )
        )}
      </div>
      {approvalGate && (
        <div className="relative mt-[8px] pt-[8px] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,var(--amber-dim),transparent_70%)] before:opacity-60 before:content-['']">
          <span
            className={cn(VALIDATOR_PILL_BASE, VALIDATOR_PILL_VARIANT.approval)}
            title="Human approval gate — requires manual sign-off before this context can complete"
          >
            <span className="text-[0.7rem] leading-none" aria-hidden="true">
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

  const gateBlocked =
    waitState?.kind === "dependency-blocked" && waitState.blockedByApproval;

  return (
    <div
      className={cn(
        NODE_BASE,
        selected && "selected",
        nodeAppearance(waitState?.kind, selected ?? false),
        gateBlocked && "opacity-[0.55]",
      )}
    >
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />

      <div className="relative z-[1] mb-[6px] flex items-start justify-between gap-[8px]">
        <span className="text-[0.95rem] leading-[1.2] font-bold text-text-primary">
          {context.title}
        </span>
        <span className={cn(BADGE_BASE, BADGE_VARIANT[badge.className])}>
          {badge.label}
        </span>
      </div>

      {context.description && (
        <div className="relative z-[1] mb-[14px] line-clamp-3 overflow-hidden text-[0.72rem] leading-[1.5] font-normal text-text-secondary">
          {context.description}
        </div>
      )}

      <div className="relative z-[1] mb-[10px] flex gap-[8px]">
        <div className="min-w-0 flex-1 rounded-[10px] border border-solid border-border-subtle bg-[var(--cc-graph-ink-a55)] px-[12px] py-[8px]">
          <div className="mb-[3px] text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Tasks
          </div>
          <div className="text-[0.88rem] font-bold text-text-primary">
            {mode === "execution"
              ? `${completedCount}/${totalCount}`
              : `0/${totalCount}`}
          </div>
        </div>
        <div className="min-w-0 flex-1 rounded-[10px] border border-solid border-border-subtle bg-[var(--cc-graph-ink-a55)] px-[12px] py-[8px]">
          <div className="mb-[3px] text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Implementer
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-[5px] text-[0.78rem] font-semibold tracking-[0.05em] uppercase",
              implementerBackend === "codex" ? "text-violet" : "text-cyan",
            )}
          >
            <span className="text-[0.7rem] leading-none" aria-hidden="true">
              ◆
            </span>
            {implementerBackend === "codex" ? "Codex" : "Claude"}
          </div>
        </div>
      </div>

      <ValidatorPills validators={validators} approvalGate={approvalGate} />

      <div className="relative z-[1] mb-[10px] h-[4px] overflow-hidden rounded-[4px] bg-[var(--cc-graph-ink-a50)]">
        <div
          className={cn(
            PROGRESS_FILL_BASE,
            PROGRESS_FILL_VARIANT[progressStatus],
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div
        className={cn(
          "relative z-[1] text-[0.7rem] font-medium",
          (waitState && FOOTER_COLOR[waitState.kind]) ?? "text-text-tertiary",
        )}
      >
        {footerText}
      </div>
    </div>
  );
}
