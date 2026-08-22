"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import { cn } from "@/lib/ui/cn";
import type {
  ContextLoopDisplay,
  ContextProvenanceDisplay,
  ContextSkipDisplay,
  ExecutionContextNodeData,
} from "./derive-graph";
import { contextNodeAccessibleName } from "./derive-graph";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  backendIsCodexToned,
  contextNodeCrew,
  contextNodeGrade,
  contextNodeNotice,
  contextNodeStatus,
  ownedPathsText,
  type NodeCrewSeat,
  type NodeGradeKey,
  type NodeStatusKey,
} from "./node-presentation";
import type { LaneBandState } from "@/lib/workflow-graph/lane-bands";
import type { ContextWaitState } from "./derive-wait-state";

/**
 * The context node card (design bundle, `Context Node.dc.html`).
 *
 * Anatomy top to bottom: title + status pill · lane / grade / owned-path chips ·
 * crew ledger (who implements, who reviews) · progress · footer · an optional
 * notice. `graph-node` / `selected` survive as rule-less class hooks because
 * preserved React Flow rules in workflow-graph.css target the connection handle
 * through them and read the inherited `--node-color` set here.
 */
const NODE_BASE = cn(
  "graph-node",
  "relative w-[264px] overflow-hidden rounded-[10px] px-[13px] pt-[11px] pb-[10px]",
  "cursor-pointer border border-solid bg-[var(--cc-graph-node-grad-bottom)]",
  "font-mono transition-opacity duration-200",
  "[--node-color:var(--border-subtle)]",
);

/** Border, top-edge accent and glow per status — the card's whole tone. */
const STATUS_EDGE: Record<NodeStatusKey, string> = {
  pending:
    "[--node-color:var(--border-default)] border-border-subtle [border-top-color:var(--border-default)]",
  draft:
    "[--node-color:var(--border-default)] border-border-subtle [border-top-color:var(--border-subtle)]",
  running:
    "[--node-color:var(--cyan)] border-[var(--cc-cyan-a25)] [border-top-color:var(--cc-cyan-a50)]",
  validating:
    "[--node-color:var(--amber)] border-[var(--cc-amber-a30)] [border-top-color:var(--cc-amber-a55)]",
  "advisory-response":
    "[--node-color:var(--cyan)] border-[var(--cc-cyan-a25)] [border-top-color:var(--cc-cyan-a50)]",
  merging:
    "[--node-color:var(--green)] border-[var(--cc-green-a32)] [border-top-color:var(--cc-green-a60)]",
  completed:
    "[--node-color:var(--green)] border-[var(--cc-green-a20)] [border-top-color:var(--cc-green-a45)]",
  published:
    "[--node-color:var(--green)] border-[var(--cc-green-a20)] [border-top-color:var(--cc-green-a45)]",
  halted:
    "[--node-color:var(--red)] border-[var(--cc-red-a40)] [border-top-color:var(--cc-red-a40)]",
  "awaiting-approval":
    "[--node-color:var(--amber)] border-[var(--amber-dim)] [border-top-color:var(--cc-amber-a30)]",
  // Violet is the Codex tone and nothing else, so a state that means "waiting
  // on a person" takes the amber family and is distinguished by its rim.
  "awaiting-user-input":
    "[--node-color:var(--amber)] border-dashed border-[var(--amber-dim)] [border-top-color:var(--cc-amber-a30)]",
  skipped:
    "[--node-color:var(--border-default)] border-border-subtle [border-top-color:var(--border-subtle)]",
};

/** The selected treatment: cyan ring and lift, whatever the status. */
const SELECTED_EDGE =
  "[--node-color:var(--cyan)] border-[var(--cc-cyan-a40)] [border-top-color:var(--cyan)] shadow-[0_0_0_2px_var(--cc-cyan-a25),0_14px_36px_var(--cc-black-a55)]";

const STATUS_PILL_BASE =
  "shrink-0 rounded-full border border-solid px-[8px] py-px text-[0.7rem] font-medium tracking-[0.05em] whitespace-nowrap uppercase";

const STATUS_PILL: Record<NodeStatusKey, string> = {
  pending: "border-border-default bg-transparent text-text-tertiary",
  draft: "border-border-default bg-transparent text-text-tertiary",
  running: "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a08)] text-cyan",
  validating:
    "border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] text-amber",
  "advisory-response":
    "border-dashed border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a08)] text-cyan",
  merging: "border-[var(--cc-green-a35)] bg-[var(--cc-green-a10)] text-green",
  completed:
    "border-[var(--cc-green-border)] bg-[var(--cc-green-a08)] text-green",
  published:
    "border-[var(--cc-green-border)] bg-[var(--cc-green-a08)] text-green",
  halted: "border-[var(--cc-red-a40)] bg-[var(--cc-red-a10)] text-red",
  "awaiting-approval":
    "border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
  "awaiting-user-input":
    "border-dashed border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
  skipped: "border-border-default bg-transparent text-text-tertiary",
};

/** The lane chip's colour square — the band's state, not the context's. */
const LANE_SWATCH: Record<LaneBandState, string> = {
  active: "bg-cyan",
  merged: "bg-green",
  pending: "bg-[var(--text-tertiary)]",
  session: "bg-[var(--text-tertiary)]",
};

const GRADE_CHIP: Record<NodeGradeKey, string> = {
  full: "border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
  owned: "border-border-default bg-transparent text-text-secondary",
  readOnly: "border-border-default bg-transparent text-text-secondary",
};

const PROGRESS_FILL: Record<NodeStatusKey, string> = {
  pending: "bg-border-default",
  draft: "bg-border-default",
  running: "bg-cyan",
  validating: "bg-amber",
  "advisory-response": "bg-cyan",
  merging: "bg-green",
  completed: "bg-green",
  published: "bg-green",
  halted: "bg-red",
  "awaiting-approval": "bg-amber",
  "awaiting-user-input": "bg-amber",
  skipped: "bg-border-default",
};

const NOTICE_TONE = {
  amber: "border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] text-amber",
  red: "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] text-red",
} as const;

const AUTHORITY_PILL = {
  blocking: "border-[var(--amber-dim)] bg-[var(--amber-glow)] text-amber",
  advisory: "border-border-default bg-transparent text-text-secondary",
} as const;

const CHIP_BASE =
  "rounded-[4px] border border-solid px-[6px] py-px text-[0.7rem] font-medium";

const LEDGER_SLOT =
  "w-[30px] shrink-0 text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase";

function backendDotClass(backend: NodeCrewSeat["backend"]): string {
  return backendIsCodexToned(backend) ? "bg-violet" : "bg-cyan";
}

type ExecutionContextNodeType = Node<
  ExecutionContextNodeData,
  "executionContext"
>;

function getFooterText(
  mode: "builder" | "execution",
  taskCount: number,
  waitState: ContextWaitState | undefined,
  completedCount?: number,
  totalCount?: number,
): string {
  if (mode === "builder" || !waitState) {
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
  statusKey: NodeStatusKey,
  completedCount: number,
  totalCount: number,
): number {
  if (mode === "builder" || totalCount === 0) return 0;
  if (
    statusKey === "merging" ||
    statusKey === "completed" ||
    statusKey === "published"
  ) {
    return 100;
  }
  return Math.round((completedCount / totalCount) * 100);
}

/**
 * The node's marks are drawn, never typed: a functional icon is an SVG so it
 * scales with the card, takes `currentColor`, and never depends on a font
 * carrying a particular code point.
 */
function DiamondIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.6 14.4 8 8 14.4 1.6 8Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.7-3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13.4 1.6v3.4h-3.4Z" fill="currentColor" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.4 9.6 6.4 14.6 8 9.6 9.6 8 14.6 6.4 9.6 1.4 8 6.4 6.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3.8 3.8 12.2 12.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// The output-contract indicator (handoff option B): a glyph beside the status
// pill rather than a labelled row, because the node is already CC's densest
// surface and the graph's job is scanning. Hollow while a declared contract is
// still owed, filled green once the payload is banked, absent when no contract
// exists. `aria-label` — not just `title` — carries the meaning.
const OUTPUT_GLYPH_BASE =
  "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-solid text-[0.7rem]";

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
      <DiamondIcon filled={captured} />
    </span>
  );
}

// The D4 chip row (R13): loop pass, expansion provenance, and — on a skipped
// node — the edges that decided the skip. These are tone-coded status pills, so
// they go through the StatusChip primitive rather than the card's own chip
// recipe; they render only when the run actually produced one, which the
// canonical fixture never does.
function LoopPassChip({ loop }: { loop: ContextLoopDisplay }) {
  const label = `Loop ${loop.loopGroupId} — pass ${loop.pass} of ${loop.maxPasses}, ${loop.activation}`;
  return (
    <StatusChip
      tone="neutral"
      data-testid="node-loop-badge"
      data-activation={loop.activation}
      aria-label={label}
      title={label}
      icon={<LoopIcon />}
    >
      Pass {loop.pass}/{loop.maxPasses}
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
      icon={<SparkIcon />}
    >
      Added at runtime
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
      icon={<SkipIcon />}
    >
      {edges.length > 0 ? edges.join(", ") : "no route activated"}
    </StatusChip>
  );
}

function D4ChipRow({ data }: { data: ExecutionContextNodeData }) {
  if (!data.loop && !data.provenance && !data.skip) return null;
  return (
    <div className="mb-[9px] flex flex-wrap gap-[4px]">
      {data.loop && <LoopPassChip loop={data.loop} />}
      {data.provenance && <ProvenanceChip provenance={data.provenance} />}
      {data.skip && <SkipReasonChip skip={data.skip} />}
    </div>
  );
}

function NoticeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-px shrink-0"
    >
      <path
        d="M8 2.8 14.2 13.2H1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.6v3M8 11.4v.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ExecutionContextNode({
  data,
  selected,
}: NodeProps<ExecutionContextNodeType>) {
  return (
    <ContextNodeCard
      data={data}
      selected={selected === true}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="left" />
          <Handle type="source" position={Position.Right} id="right" />
        </>
      }
    />
  );
}

/**
 * The context card itself, independent of React Flow.
 *
 * The canvas node is this card plus its connection handles; the mobile lane
 * list is the same card with none. Keeping one implementation is what stops the
 * two surfaces from drifting into two different accounts of a context.
 */
export function ContextNodeCard({
  data,
  selected,
  handles,
}: {
  data: ExecutionContextNodeData;
  selected: boolean;
  /** React Flow's connection handles, when the card is a canvas node. */
  handles?: React.ReactNode;
}): React.JSX.Element {
  const { context, tasks, mode, contextState, waitState } = data;
  const status = contextNodeStatus(mode, waitState);
  const grade = contextNodeGrade(context.placement);
  const paths = ownedPathsText(context.placement);
  const crew = contextNodeCrew(context);
  const notice = contextNodeNotice({ placement: context.placement, waitState });

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
    status.key,
    completedCount,
    totalCount,
  );

  const overrideReason =
    data.configOverrides.length > 0
      ? `Set on this context: ${data.configOverrides.join(", ")}`
      : null;

  // A not-taken branch is ghosted rather than hidden: the graph must still show
  // the shape the planner authored, with the untaken part visibly inert.
  const isSkipped = status.key === "skipped";

  return (
    <div
      role="group"
      aria-label={contextNodeAccessibleName(data)}
      data-testid="context-node"
      data-status={status.key}
      {...(isSkipped ? { "data-skipped": "true" } : {})}
      className={cn(
        NODE_BASE,
        selected ? SELECTED_EDGE : STATUS_EDGE[status.key],
        // React Flow marks its own wrapper, not this card; the preserved
        // handle rules select the card, so the hook has to be spelled here.
        selected && "selected",
        // Pulse belongs to live work only, and the reduced-motion rule in
        // workflow-graph.css disables it for readers who ask.
        status.live && !selected && "node-live-pulse",
        isSkipped && "border-dashed opacity-[0.45] grayscale-[0.6]",
      )}
    >
      {handles}

      <div className="mb-[5px] flex items-start justify-between gap-[8px]">
        <span className="text-[0.8rem] leading-[1.25] font-semibold text-text-primary">
          {context.title}
        </span>
        <div className="flex shrink-0 items-center gap-[4px]">
          <OutputSchemaGlyph outputSchema={data.outputSchema} />
          <span className={cn(STATUS_PILL_BASE, STATUS_PILL[status.key])}>
            {status.label}
          </span>
        </div>
      </div>

      <div className="mb-[9px] flex flex-wrap items-center gap-[5px]">
        <span
          data-testid="node-lane-chip"
          data-lane-state={data.laneState}
          className={cn(
            CHIP_BASE,
            "inline-flex items-center gap-[5px] border-border-subtle text-text-secondary",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-[5px] w-[5px] rounded-[1px]",
              LANE_SWATCH[data.laneState],
            )}
          />
          {context.placement.lane}
        </span>
        <span
          data-testid="node-grade-chip"
          title={grade.title}
          className={cn(CHIP_BASE, GRADE_CHIP[grade.key])}
        >
          {grade.label}
        </span>
        {paths && (
          <span
            data-testid="node-owned-paths"
            title={paths}
            className="min-w-0 overflow-hidden text-[0.7rem] font-normal text-ellipsis whitespace-nowrap text-text-tertiary"
          >
            {paths}
          </span>
        )}
        {data.laneCreatedAtRuntime && (
          <span
            data-testid="node-runtime-lane"
            title="Lane created at runtime by expansion"
            className="text-[0.7rem] font-medium text-cyan"
          >
            runtime
          </span>
        )}
      </div>

      <D4ChipRow data={data} />

      {crew.implementer && (
        <div
          data-testid="node-crew"
          className="mb-[9px] overflow-hidden rounded-[6px] border border-solid border-border-subtle bg-[var(--cc-graph-ink-a55)]"
        >
          <div className="flex items-center gap-[6px] px-[9px] py-[6px]">
            <span className={LEDGER_SLOT}>Impl</span>
            <span
              aria-hidden="true"
              className={cn(
                "h-[6px] w-[6px] rounded-full",
                backendDotClass(crew.implementer.backend),
              )}
            />
            <span className="text-[0.72rem] font-medium whitespace-nowrap text-text-primary">
              {crew.implementer.modelLabel}
            </span>
            {overrideReason && (
              <span
                aria-hidden="true"
                data-testid="node-set-here-marker"
                title={overrideReason}
                className="h-[5px] w-[5px] shrink-0 rounded-full bg-cyan"
              />
            )}
            <span className="ml-auto rounded-full border border-solid border-border-default px-[7px] text-[0.7rem] font-medium text-text-secondary uppercase">
              {crew.implementer.effort}
            </span>
          </div>
          {crew.seats.map((seat, index) => (
            <div
              key={seat.seatId}
              data-testid="node-crew-seat"
              className="flex flex-col gap-[2px] border-x-0 border-t border-b-0 border-solid border-border-dim px-[9px] py-[5px]"
            >
              <div className="flex items-center gap-[6px]">
                <span className={LEDGER_SLOT}>{index === 0 ? "Val" : ""}</span>
                <span className="min-w-0 overflow-hidden text-[0.72rem] font-medium text-ellipsis whitespace-nowrap text-text-primary">
                  {seat.seatId}
                </span>
                <span
                  className={cn(
                    "ml-auto shrink-0 rounded-full border border-solid px-[7px] text-[0.7rem] font-medium",
                    AUTHORITY_PILL[seat.authority],
                  )}
                >
                  {seat.authority}
                </span>
              </div>
              <div className="flex items-center gap-[6px] pl-[30px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-[6px] w-[6px] shrink-0 rounded-full",
                    backendDotClass(seat.backend),
                  )}
                />
                <span className="text-[0.7rem] font-normal whitespace-nowrap text-text-secondary">
                  {seat.modelLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalCount > 0 && (
        <div className="mb-[7px] h-[3px] overflow-hidden rounded-[2px] bg-[var(--cc-graph-ink-a50)]">
          <div
            className={cn(
              "h-full rounded-[2px] transition-[width] duration-[400ms]",
              PROGRESS_FILL[status.key],
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      <div className="text-[0.7rem] font-normal text-text-tertiary">
        {footerText}
      </div>

      {notice && (
        <div
          data-testid="node-notice"
          data-tone={notice.tone}
          className={cn(
            "mt-[9px] flex items-start gap-[7px] rounded-[6px] border border-solid px-[9px] py-[7px]",
            NOTICE_TONE[notice.tone],
          )}
        >
          <NoticeIcon />
          <span className="text-[0.7rem] leading-[1.45] font-normal">
            {notice.text}
          </span>
        </div>
      )}
    </div>
  );
}
