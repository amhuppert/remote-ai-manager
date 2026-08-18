"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import { cn } from "@/lib/ui/cn";
import type {
  ContextDisplayPhase,
  ContextLoopDisplay,
  ContextProvenanceDisplay,
  ContextSkipDisplay,
  DisplayValidators,
  ExecutionContextNodeData,
} from "./derive-graph";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  getContextDisplayPhase,
  getDisplayApprovalGate,
  getDisplayValidators,
} from "./derive-graph";
import type { ContextWaitState } from "./derive-wait-state";
import { backendLabel, backendToneToken } from "@/lib/agent-backends/catalog";
import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import type { AgentBackendId } from "@/lib/shared/schemas";

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
  // Cyan, not amber: the cohort has released the candidate and the IMPLEMENTER
  // is the lane that runs. The slower pulse keeps it apart from `running`.
  "advisory-response":
    "[--node-color:var(--cyan)] [--node-color-glow:var(--cyan-glow)] border-[var(--cc-cyan-a25)] [border-top-color:var(--cc-cyan-a50)] [animation:pulse-node_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
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
  "advisory-response":
    "[--node-color:var(--cyan)] [--node-color-glow:var(--cyan-glow)] border-[var(--cc-cyan-a40)] [animation:pulse-node-selected_2.5s_ease-in-out_infinite] before:opacity-100 after:opacity-100",
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
  "advisory-response":
    "border border-dashed border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a08)] text-cyan",
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
  "advisory-response": "bg-cyan shadow-[0_0_6px_var(--cyan-glow)]",
  completed: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  halted: "bg-red",
  merging:
    "bg-[linear-gradient(90deg,var(--green)_0%,var(--cc-tdd-border-hover)_50%,var(--green)_100%)] [background-size:24px_100%] shadow-[0_0_6px_var(--green-glow)] [animation:merging-chevron_1.1s_linear_infinite]",
};

const FOOTER_COLOR: Partial<Record<WaitKind, string>> = {
  running: "text-text-secondary",
  validating: "text-amber",
  "advisory-response": "text-cyan",
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
  cyan: "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a06)] text-cyan",
  violet: "border-[var(--cc-codex-violet-a35)] bg-violet-glow text-violet",
  approval: "border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
} as const;

function agentPillToneClass(backend: AgentBackendId): string {
  return backendToneToken(backend) === "violet"
    ? VALIDATOR_PILL_VARIANT.violet
    : VALIDATOR_PILL_VARIANT.cyan;
}

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

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
    case "advisory-response":
      return { label: "Advisory Response", className: "advisory-response" };
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
    case "skipped":
      return { label: "Skipped", className: "pending" };
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
    case "advisory-response":
      return "Awaiting advisory response";
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
    case "skipped":
      return "Branch not taken";
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
  | { kind: "agent"; backend: AgentBackendId }
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
                  agentPillToneClass(pill.backend),
                )}
                title={`Agent validator: ${backendLabel(pill.backend)}`}
              >
                <span className="text-[0.7rem] leading-none" aria-hidden="true">
                  ◆
                </span>
                {backendLabel(pill.backend)}
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

// The output-contract indicator (handoff option B): a glyph beside the status
// badge rather than a fourth labelled row, because the node is already CC's
// densest surface and the graph's job is scanning. Hollow while a declared
// contract is still owed, filled green once the payload is banked, absent when
// no contract exists. `aria-label` — not just `title` — carries the meaning:
// a tooltip may not be the only route to it, and the inspector's Output group
// is the paired visible label.
const OUTPUT_GLYPH_BASE =
  "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-solid text-[0.72rem]";

const OUTPUT_GLYPH_TONE = {
  declared: "border-border-default bg-transparent text-text-tertiary",
  captured:
    "border-[var(--cc-green-border)] bg-[var(--cc-green-a08)] text-green",
} as const;

function OutputSchemaGlyph({
  outputSchema,
}: {
  outputSchema: ExecutionContextNodeData["outputSchema"];
}) {
  if (outputSchema === undefined) return null;
  const captured = outputSchema.captured;
  const label = captured
    ? "Output captured against this context's schema"
    : "Output schema declared — not yet captured";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="node-output-schema-glyph"
      data-captured={captured ? "true" : "false"}
      className={cn(
        OUTPUT_GLYPH_BASE,
        captured ? OUTPUT_GLYPH_TONE.captured : OUTPUT_GLYPH_TONE.declared,
      )}
    >
      <span aria-hidden="true">{captured ? "◈" : "◇"}</span>
    </span>
  );
}

// The D4 chip row (R13): loop pass, expansion provenance, and — on a skipped
// node — the edges that decided the skip. These are tone-coded status pills, so
// they go through the StatusChip primitive rather than the node's hand-rolled
// badge recipe; the status badge above stays as-is because it is one pill with
// a per-status appearance cascade, not a tone.
function LoopPassChip({ loop }: { loop: ContextLoopDisplay }) {
  const label = `Loop ${loop.loopGroupId} — pass ${loop.pass} of ${loop.maxPasses}, ${loop.activation}`;
  return (
    <StatusChip
      tone="violet"
      data-testid="node-loop-badge"
      data-activation={loop.activation}
      aria-label={label}
      title={label}
    >
      ↻ Pass {loop.pass}/{loop.maxPasses}
    </StatusChip>
  );
}

function ProvenanceChip({
  provenance,
}: {
  provenance: ContextProvenanceDisplay;
}) {
  // The rationale is what makes a generated node auditable at a glance, so it
  // rides the accessible name rather than living only in a tooltip.
  const label = `Added at runtime by ${provenance.invokerContextId}: ${provenance.rationale}`;
  return (
    <StatusChip
      tone="cyan"
      data-testid="node-provenance-badge"
      aria-label={label}
      title={label}
    >
      ✦ Added at runtime
    </StatusChip>
  );
}

function SkipReasonChip({ skip }: { skip: ContextSkipDisplay }) {
  const edges = skip.decidingEdgeIds;
  const label =
    edges.length > 0
      ? `Branch not taken — guard resolved false on ${edges.join(", ")}`
      : "Branch not taken — no incoming route activated";
  return (
    <StatusChip
      tone="neutral"
      wrap
      data-testid="node-skip-reason"
      aria-label={label}
      title={label}
    >
      ⊘ {edges.length > 0 ? edges.join(", ") : "no route activated"}
    </StatusChip>
  );
}

function D4ChipRow({ data }: { data: ExecutionContextNodeData }) {
  if (!data.loop && !data.provenance && !data.skip) return null;
  return (
    <div className="relative z-[1] mb-[10px] flex flex-wrap gap-[4px]">
      {data.loop && <LoopPassChip loop={data.loop} />}
      {data.provenance && <ProvenanceChip provenance={data.provenance} />}
      {data.skip && <SkipReasonChip skip={data.skip} />}
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
  const implementerBackend: AgentBackendId =
    implementer?.agent.backend ?? "claude";

  const validators = getDisplayValidators(context);
  const approvalGate = getDisplayApprovalGate(context);

  const gateBlocked =
    waitState?.kind === "dependency-blocked" && waitState.blockedByApproval;

  // A not-taken branch is ghosted rather than hidden: the graph must still show
  // the shape the planner authored, with the untaken part visibly inert.
  const isSkipped = waitState?.kind === "skipped";

  return (
    <div
      {...(isSkipped ? { "data-skipped": "true" } : {})}
      className={cn(
        NODE_BASE,
        selected && "selected",
        nodeAppearance(waitState?.kind, selected ?? false),
        gateBlocked && "opacity-[0.55]",
        isSkipped && "border-dashed opacity-[0.45] grayscale-[0.6]",
      )}
    >
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="source" position={Position.Right} id="right" />

      <div className="relative z-[1] mb-[6px] flex items-start justify-between gap-[8px]">
        <span className="text-[0.95rem] leading-[1.2] font-bold text-text-primary">
          {context.title}
        </span>
        <div className="flex shrink-0 items-center gap-[4px]">
          <OutputSchemaGlyph outputSchema={data.outputSchema} />
          <span className={cn(BADGE_BASE, BADGE_VARIANT[badge.className])}>
            {badge.label}
          </span>
        </div>
      </div>

      {context.description && (
        <div className="relative z-[1] mb-[14px] line-clamp-3 overflow-hidden text-[0.72rem] leading-[1.5] font-normal text-text-secondary">
          {context.description}
        </div>
      )}

      {/* The canonical criteria rendering (#69 change 4 stage 1): numbered
          `[id]` lines for records, the prose verbatim for legacy values.
          Clamped like the description — the node is a scanning surface, and
          the inspector's Brief group carries the full list. Blank output (the
          builder's empty-prose seed) renders no block rather than a bare
          header. */}
      {acceptanceCriteriaText(context.acceptanceCriteria).trim() && (
        <div className="relative z-[1] mb-[10px]" data-testid="node-criteria">
          <div className="mb-[3px] text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Criteria
          </div>
          <div className="line-clamp-3 overflow-hidden text-[0.68rem] leading-[1.5] whitespace-pre-line text-text-secondary">
            {acceptanceCriteriaText(context.acceptanceCriteria)}
          </div>
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
              backendToneToken(implementerBackend) === "violet"
                ? "text-violet"
                : "text-cyan",
            )}
          >
            <span className="text-[0.7rem] leading-none" aria-hidden="true">
              ◆
            </span>
            {backendLabel(implementerBackend)}
          </div>
        </div>
      </div>

      <D4ChipRow data={data} />

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
