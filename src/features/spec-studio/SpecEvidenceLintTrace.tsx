"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { cn } from "@/lib/ui/cn";
import { LINT_SEVERITY_LABEL, draftHealth } from "@/lib/specs/draft-health";
import type { LintFinding } from "@/lib/specs/lint";
import type {
  SpecCriterionDispositionRow,
  SpecEvidenceRow,
  SpecProofVerdictRow,
  SpecWaiverRow,
  ValidationStrategy,
} from "@/lib/specs/schemas";
import type { SpecExecutionView } from "@/lib/specs/view-schemas";

const logger = createClientLogger("spec-studio-proof");

export interface CriterionProofView {
  elementId: string;
  handle: string;
  text: string;
  validationStrategy: ValidationStrategy;
  evidence: SpecEvidenceRow[];
  verdicts: SpecProofVerdictRow[];
  waiver: SpecWaiverRow | null;
  isPending: boolean;
  error: string | null;
}

export interface TraceabilityRequirement {
  elementId: string;
  handle: string;
  label: string;
  criterionElementIds: string[];
  approval: "unapproved" | "valid" | "stale" | "closed";
}

export interface TraceabilityDecision {
  elementId: string;
  handle: string;
  label: string;
  tracedRequirementElementIds: string[];
}

export interface TraceabilityTask {
  elementId: string;
  handle: string;
  label: string;
  tracedRequirementElementIds: string[];
  tracedDecisionElementIds: string[];
  coveredCriterionElementIds: string[];
  isNewInRevision: boolean;
  revisionNumber: number;
}

export interface TraceabilityInput {
  projectName: string;
  slug: string;
  requirements: TraceabilityRequirement[];
  decisions: TraceabilityDecision[];
  tasks: TraceabilityTask[];
  executions: SpecExecutionView[];
  criteria: CriterionProofView[];
  findings: LintFinding[];
}

type TraceabilityNodeKind = "requirement" | "criterion" | "task";

type TraceabilityAccentTone = "green" | "amber" | "red" | "neutral";

interface TraceabilityNodeData extends Record<string, unknown> {
  kind: TraceabilityNodeKind;
  label: string;
  handle: string | null;
  href: string | null;
  findings: LintFinding[];
  glyph: "✓" | "○" | "↻" | null;
  subline: string | null;
  accentTone: TraceabilityAccentTone;
  traceState?: TraceNodeState;
  onSelect?: () => void;
}

export interface TraceabilityGraphNode {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  data: TraceabilityNodeData;
}

export interface TraceabilityGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface TraceabilityGraphModel {
  nodes: TraceabilityGraphNode[];
  edges: TraceabilityGraphEdge[];
  width: number;
  height: number;
}

const nodeTone: Record<TraceabilityNodeKind, StatusChipTone> = {
  requirement: "cyan",
  criterion: "neutral",
  task: "neutral",
};

const nodeLabel: Record<TraceabilityNodeKind, string> = {
  requirement: "Requirement",
  criterion: "Criterion",
  task: "Task",
};

const severityTone: Record<LintFinding["severity"], StatusChipTone> = {
  blocks_propose: "red",
  blocks_claim: "red",
  blocks_signoff: "red",
  advisory: "amber",
};

export function SpecEvidencePanel({
  criteria,
  dispositions = [],
  deliveredExternallyCriterionIds = [],
  initialFilter = "unproven",
  revisionLabel = null,
  emptyMessage = "No acceptance criteria are present in this revision.",
  showHeading = true,
}: {
  criteria: CriterionProofView[];
  dispositions?: SpecCriterionDispositionRow[];
  /**
   * The criteria an import's external-delivery record accounts for, named by
   * the delivery projection. The panel cannot derive this from a criterion's
   * evidence, because there is none: that is exactly the claim.
   */
  deliveredExternallyCriterionIds?: readonly string[];
  initialFilter?: EvidenceFilter;
  revisionLabel?: string | null;
  emptyMessage?: string;
  showHeading?: boolean;
}): React.JSX.Element {
  const [filter, setFilter] = useState<EvidenceFilter>(initialFilter);
  const dispositionByCriterion = latestDispositions(dispositions);
  const deliveredExternally = new Set(deliveredExternallyCriterionIds);
  const views = criteria.map((criterion) => ({
    criterion,
    state: criterionProofState(
      criterion,
      dispositionByCriterion.get(criterion.elementId),
      deliveredExternally.has(criterion.elementId),
    ),
  }));
  const inScope = views.filter(({ state }) => state.inScope);
  const provenCount = inScope.filter(
    ({ state }) => state.kind === "proven",
  ).length;
  const unresolvedCount = inScope.length - provenCount;
  const visibleViews = views.filter(
    ({ state }) => filter === "all" || state.kind !== "proven",
  );
  const groups = groupCriteriaByRequirement(visibleViews, views);

  function selectFilter(nextFilter: EvidenceFilter): void {
    setFilter(nextFilter);
    logger.info("spec_studio.evidence.filter_selected", {
      filter: nextFilter,
      visibleCriterionCount: views.filter(
        ({ state }) => nextFilter === "all" || state.kind !== "proven",
      ).length,
    });
  }

  return (
    <section
      aria-labelledby={showHeading ? "spec-evidence-heading" : undefined}
      aria-label={showHeading ? undefined : "Evidence by acceptance criterion"}
      className="mx-auto grid max-w-[1080px] gap-md"
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        {showHeading && (
          <div>
            <h2
              id="spec-evidence-heading"
              className="m-0 font-display text-[1rem] font-bold text-text-primary"
            >
              Evidence by acceptance criterion
            </h2>
            <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
              Proof is evaluated against each criterion&apos;s approved
              validation strategy.
            </p>
          </div>
        )}
        <div
          className={cn(
            "flex flex-wrap items-center justify-end gap-sm max-768:w-full max-768:justify-between",
            !showHeading && "ml-auto",
          )}
        >
          {revisionLabel !== null && (
            <StatusChip tone="neutral">{revisionLabel}</StatusChip>
          )}
          <SegmentedControl
            aria-label="Evidence filter"
            value={filter}
            onValueChange={(value) => selectFilter(value as EvidenceFilter)}
          >
            <SegmentedControlItem value="all" aria-label="All">
              All criteria
            </SegmentedControlItem>
            <SegmentedControlItem value="unproven" aria-label="Unproven">
              Unproven only
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      </div>

      {criteria.length > 0 && (
        <section
          aria-label="Evidence readiness"
          className="flex flex-wrap items-center gap-lg rounded-md border border-solid border-border-subtle bg-bg-surface px-lg py-md"
        >
          <div className="grid shrink-0 gap-2xs">
            <p className="m-0 font-mono text-[1.35rem] leading-none font-bold text-text-primary tabular-nums">
              {provenCount} / {inScope.length}
            </p>
            <p className="m-0 font-mono text-[0.66rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
              in-scope proven
            </p>
            <span className="sr-only">
              {provenCount} / {inScope.length} in-scope proven
            </span>
          </div>
          <span
            aria-hidden="true"
            className="h-[32px] w-px shrink-0 bg-border-subtle max-768:hidden"
          />
          <div className="min-w-[220px] flex-1">
            <p
              className={cn(
                "m-0 font-mono text-[0.82rem] font-semibold",
                unresolvedCount === 0 ? "text-green" : "text-amber",
              )}
            >
              {unresolvedCount === 0 ? "Proof complete" : "Proof incomplete"}
            </p>
            <p className="mt-2xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
              {readinessMessage(inScope.length, unresolvedCount)}
            </p>
          </div>
          <div className="w-[200px] shrink-0 max-768:w-full">
            <Progress
              aria-label="In-scope proof progress"
              max={Math.max(inScope.length, 1)}
              value={provenCount}
            />
          </div>
        </section>
      )}

      {criteria.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-dim bg-bg-base p-lg font-mono text-[0.72rem] text-text-tertiary">
          {emptyMessage}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-solid border-green-dim bg-green-glow p-lg font-mono text-[0.72rem] text-green">
          Every criterion in this revision is proven.
        </div>
      ) : (
        groups.map((group) => (
          <RequirementEvidenceGroup key={group.handle} group={group} />
        ))
      )}
    </section>
  );
}

type EvidenceFilter = "all" | "unproven";

type CriterionProofStateKind =
  | "proven"
  | "pending"
  | "error"
  | "stale"
  | "waived"
  | "deferred"
  | "delivered_elsewhere"
  /**
   * Distinct from `delivered_elsewhere`, which is a delivery-plan disposition
   * this system recorded about its own work. This one is an import's testimony
   * that the criterion shipped before Command Center ever saw it.
   */
  | "delivered_externally"
  | "awaiting_verdict"
  | "unproven";

interface CriterionProofState {
  kind: CriterionProofStateKind;
  label: string;
  tone: StatusChipTone;
  inScope: boolean;
  disposition: SpecCriterionDispositionRow | undefined;
}

interface CriterionPresentation {
  criterion: CriterionProofView;
  state: CriterionProofState;
}

interface RequirementEvidenceGroupView {
  handle: string;
  criteria: CriterionPresentation[];
  provenCount: number;
  totalCount: number;
}

function RequirementEvidenceGroup({
  group,
}: {
  group: RequirementEvidenceGroupView;
}): React.JSX.Element {
  return (
    <section
      aria-label={`Requirement ${group.handle} evidence`}
      className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
          Requirement {group.handle}
        </h3>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {group.provenCount} / {group.totalCount} proven
        </span>
      </div>
      <div className="grid gap-2xs bg-border-dim">
        {group.criteria.map(({ criterion, state }) => (
          <CriterionProofCard
            key={criterion.elementId}
            criterion={criterion}
            state={state}
          />
        ))}
      </div>
    </section>
  );
}

function CriterionProofCard({
  criterion,
  state,
}: {
  criterion: CriterionProofView;
  state: CriterionProofState;
}): React.JSX.Element {
  const staleReason = criterion.verdicts.find(
    (verdict) => verdict.stale_at !== null && verdict.stale_reason !== null,
  )?.stale_reason;

  return (
    <article
      aria-label={`${criterion.handle} proof`}
      id={`proof-${criterion.handle}`}
      data-proof-state={state.kind}
      className="grid gap-xs bg-bg-surface px-md py-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="min-w-0">
          <span className="font-mono text-[0.7rem] font-semibold text-cyan">
            {criterion.handle}
          </span>
          <div className="mt-xs min-w-0">
            <CompactMarkdown content={criterion.text} />
          </div>
        </div>
        <StatusChip tone={state.tone}>{state.label}</StatusChip>
      </div>

      <div className="flex flex-wrap items-center gap-xs">
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          Strategy
        </span>
        {criterion.validationStrategy.kinds.map((kind) => (
          <StatusChip key={kind} tone="neutral">
            {formatEvidenceKind(kind)}
          </StatusChip>
        ))}
        {criterion.evidence.map((evidence) => (
          <EvidenceRecord key={evidence.id} evidence={evidence} />
        ))}
        {criterion.verdicts.map((verdict) => (
          <VerdictRecord key={verdict.id} verdict={verdict} />
        ))}
      </div>

      {criterion.validationStrategy.note !== undefined && (
        <div className="min-w-0">
          <CompactMarkdown content={criterion.validationStrategy.note} />
        </div>
      )}
      {criterion.isPending && (
        <p
          aria-live="polite"
          className="m-0 font-mono text-[0.7rem] text-amber"
        >
          Loading evidence…
        </p>
      )}
      {criterion.error !== null && (
        <p role="alert" className="m-0 font-mono text-[0.7rem] text-red">
          {criterion.error}
        </p>
      )}
      {state.kind === "unproven" && (
        <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
          Nothing proves this criterion yet.
        </p>
      )}
      {state.kind === "delivered_externally" && (
        <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
          Delivered outside this system, unproven here.
        </p>
      )}
      {state.kind === "awaiting_verdict" && (
        <p className="m-0 font-mono text-[0.7rem] text-amber">
          Evidence is attached, but no current verdict satisfies the strategy.
        </p>
      )}
      {state.kind === "stale" && staleReason !== undefined && (
        <p className="m-0 font-mono text-[0.7rem] text-amber">
          Proof became stale: {staleReason}
        </p>
      )}
      {state.kind === "waived" && criterion.waiver !== null && (
        <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-amber">
          Waiver recorded: {criterion.waiver.reason}
        </p>
      )}
      {state.kind === "delivered_elsewhere" &&
        state.disposition !== undefined &&
        state.disposition.delivered_by_execution_id !== null && (
          <p className="m-0 font-mono text-[0.7rem] text-green">
            Delivered by execution {state.disposition.delivered_by_execution_id}
          </p>
        )}
    </article>
  );
}

function EvidenceRecord({
  evidence,
}: {
  evidence: SpecEvidenceRow;
}): React.JSX.Element {
  return (
    <StatusChip tone="cyan" wrap>
      <span aria-hidden="true">
        {formatEvidenceKind(evidence.kind)} · {evidence.id}
      </span>
      <span className="sr-only">
        {formatEvidenceKind(evidence.kind)} {evidence.id}:{" "}
        {evidenceReferenceLabel(evidence.ref_json)}
      </span>
    </StatusChip>
  );
}

function VerdictRecord({
  verdict,
}: {
  verdict: SpecProofVerdictRow;
}): React.JSX.Element {
  return (
    <StatusChip tone={verdict.stale_at === null ? "green" : "amber"}>
      <span aria-hidden="true">{formatVerdictKind(verdict.verdict_kind)}</span>
      <span className="sr-only">
        {formatVerdictKind(verdict.verdict_kind)},{" "}
        {verdict.stale_at === null ? "current verdict" : "stale verdict"},{" "}
        {parseStringList(verdict.evidence_ids_json).length} cited evidence
        records
      </span>
    </StatusChip>
  );
}

function latestDispositions(
  dispositions: SpecCriterionDispositionRow[],
): Map<string, SpecCriterionDispositionRow> {
  const byCriterion = new Map<string, SpecCriterionDispositionRow>();
  for (const disposition of dispositions) {
    const current = byCriterion.get(disposition.criterion_element_id);
    if (current === undefined || current.updated_at < disposition.updated_at) {
      byCriterion.set(disposition.criterion_element_id, disposition);
    }
  }
  return byCriterion;
}

function criterionProofState(
  criterion: CriterionProofView,
  disposition: SpecCriterionDispositionRow | undefined,
  deliveredExternally = false,
): CriterionProofState {
  const inScope =
    disposition === undefined || disposition.disposition === "in_scope";
  if (disposition?.disposition === "delivered_elsewhere") {
    return {
      kind: "delivered_elsewhere",
      label: "Delivered elsewhere",
      tone: "green",
      inScope,
      disposition,
    };
  }
  if (disposition?.disposition === "deferred") {
    return {
      kind: "deferred",
      label: "Deferred",
      tone: "neutral",
      inScope,
      disposition,
    };
  }
  if (disposition?.disposition === "waived") {
    return {
      kind: "waived",
      label: "Waived — not proof",
      tone: "amber",
      inScope,
      disposition,
    };
  }
  if (criterion.error !== null) {
    return { kind: "error", label: "Error", tone: "red", inScope, disposition };
  }
  if (criterion.verdicts.some((verdict) => verdict.stale_at === null)) {
    return {
      kind: "proven",
      label: "Proven",
      tone: "green",
      inScope,
      disposition,
    };
  }
  if (criterion.waiver?.stale === 0) {
    return {
      kind: "waived",
      label: "Waived — not proof",
      tone: "amber",
      inScope,
      disposition,
    };
  }
  // Below proof and waiver on purpose: anything this system recorded about the
  // criterion outranks the import's account of it. Neutral rather than the
  // green this card gives merged work — the state is settled, not verified.
  if (deliveredExternally) {
    return {
      kind: "delivered_externally",
      label: "Delivered externally",
      tone: "neutral",
      inScope,
      disposition,
    };
  }
  if (
    criterion.verdicts.some((verdict) => verdict.stale_at !== null) ||
    criterion.waiver?.stale === 1
  ) {
    return {
      kind: "stale",
      label: "Stale",
      tone: "amber",
      inScope,
      disposition,
    };
  }
  if (criterion.evidence.length > 0) {
    return {
      kind: "awaiting_verdict",
      label: "Awaiting verdict",
      tone: "amber",
      inScope,
      disposition,
    };
  }
  if (criterion.isPending) {
    return {
      kind: "pending",
      label: "Pending",
      tone: "amber",
      inScope,
      disposition,
    };
  }
  return {
    kind: "unproven",
    label: "Unproven",
    tone: "neutral",
    inScope,
    disposition,
  };
}

function groupCriteriaByRequirement(
  visibleViews: CriterionPresentation[],
  allViews: CriterionPresentation[],
): RequirementEvidenceGroupView[] {
  const totals = new Map<string, { provenCount: number; totalCount: number }>();
  for (const view of allViews) {
    const handle = requirementHandle(view.criterion.handle);
    const current = totals.get(handle) ?? { provenCount: 0, totalCount: 0 };
    current.totalCount += 1;
    if (view.state.kind === "proven") current.provenCount += 1;
    totals.set(handle, current);
  }
  const groups = new Map<string, CriterionPresentation[]>();
  for (const view of visibleViews) {
    const handle = requirementHandle(view.criterion.handle);
    const current = groups.get(handle) ?? [];
    current.push(view);
    groups.set(handle, current);
  }
  return [...groups].map(([handle, criteria]) => ({
    handle,
    criteria,
    provenCount: totals.get(handle)?.provenCount ?? 0,
    totalCount: totals.get(handle)?.totalCount ?? criteria.length,
  }));
}

function requirementHandle(criterionHandle: string): string {
  const separator = criterionHandle.indexOf(".");
  return separator === -1
    ? criterionHandle
    : criterionHandle.slice(0, separator);
}

function readinessMessage(total: number, unresolved: number): string {
  if (total === 0) return "No criteria are in scope for this execution.";
  if (unresolved === 0) {
    return "All in-scope criteria have current proof; candidate freshness is checked at publish.";
  }
  return `${unresolved} in-scope ${unresolved === 1 ? "criterion" : "criteria"} still need proof.`;
}

export function SpecLintPanel({
  projectName,
  slug,
  revisionId,
  findings,
  isPending,
  error,
}: {
  projectName: string;
  slug: string;
  revisionId: string | null;
  findings: LintFinding[];
  isPending: boolean;
  error: string | null;
}): React.JSX.Element {
  // The same projection `cctl spec lint`, the status tier, and the propose
  // refusal read: grouping, ranking, and what counts as blocking are decided
  // once, so this tab cannot rank or count a draft differently from the CLI.
  const health = draftHealth(findings);
  return (
    <section aria-labelledby="spec-lint-heading" className="grid gap-md">
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div>
          <h2
            id="spec-lint-heading"
            className="m-0 font-display text-[0.95rem] font-bold text-text-primary"
          >
            Deterministic lint
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            This is the same finding list returned when propose is refused.
          </p>
        </div>
        {revisionId !== null && (
          <StatusChip tone="neutral">Draft {revisionId}</StatusChip>
        )}
      </div>

      {isPending ? (
        <p
          aria-live="polite"
          className="m-0 rounded-lg border border-solid border-border-dim bg-bg-base p-md font-mono text-[0.72rem] text-text-tertiary"
        >
          Running lint…
        </p>
      ) : error !== null ? (
        <p
          role="alert"
          className="m-0 rounded-lg border border-solid border-red-dim bg-red-glow p-md font-mono text-[0.72rem] text-red"
        >
          {error}
        </p>
      ) : health.total === 0 ? (
        <p className="m-0 rounded-lg border border-solid border-green-dim bg-green-glow p-md font-mono text-[0.72rem] text-green">
          No lint findings for this draft.
        </p>
      ) : (
        <>
          <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
            {`${health.blocking} of ${health.total} would block propose`}
          </p>
          {health.groups.map((group) => (
            <section
              key={group.severity}
              role="group"
              aria-label={`${LINT_SEVERITY_LABEL[group.severity]} (${group.findings.length})`}
              className="grid gap-sm"
            >
              <ol className="m-0 grid list-none gap-sm p-0">
                {group.findings.map((finding, index) => (
                  <li
                    key={`${finding.ruleId}-${finding.elementHandle}-${index}`}
                    className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-md"
                  >
                    <div className="flex flex-wrap items-center gap-sm">
                      <StatusChip tone={severityTone[finding.severity]}>
                        {LINT_SEVERITY_LABEL[finding.severity]}
                      </StatusChip>
                      <span className="font-mono text-[0.64rem] text-text-tertiary">
                        {finding.ruleId}
                      </span>
                      {finding.elementHandle.length > 0 && (
                        <Link
                          href={elementHref(
                            projectName,
                            slug,
                            finding.elementHandle,
                          )}
                          className="ml-auto font-mono text-[0.7rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                        >
                          {finding.elementHandle} · Open element
                        </Link>
                      )}
                    </div>
                    <p
                      data-testid="lint-finding-message"
                      className="mt-sm mb-0 text-[0.76rem] leading-relaxed text-text-primary"
                    >
                      {finding.message}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

export function TraceabilityGraph({
  input,
  showHeading = true,
}: {
  input: TraceabilityInput;
  showHeading?: boolean;
}): React.JSX.Element {
  const [focus, setFocus] = useState<string>("all");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const focusedInput = useMemo(
    () => focusTraceabilityInput(input, focus),
    [focus, input],
  );
  const graph = useMemo(
    () => buildTraceabilityGraph(focusedInput),
    [focusedInput],
  );
  const selectedNode =
    graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const chainNodeIds =
    selectedNode === null
      ? new Set<string>()
      : traceChainNodeIds(graph, selectedNode.id);
  const presentedNodes = graph.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      traceState: traceNodeState(node.id, selectedNode?.id, chainNodeIds),
      onSelect: () => selectNode(node.id),
    },
  }));
  const nodesById = new Map(
    presentedNodes.map((node) => [node.id, node] as const),
  );
  const traceColumns = [
    { label: "Requirement", x: 16 },
    { label: "Criteria", x: 252 },
    { label: "Tasks — plan", x: 532 },
  ];

  function selectFocus(nextFocus: string): void {
    setFocus(nextFocus);
    setSelectedNodeId(null);
    logger.info("spec_studio.trace.focus_selected", {
      focus: nextFocus,
      slug: input.slug,
    });
  }

  function selectNode(nodeId: string): void {
    setSelectedNodeId(nodeId);
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    logger.info("spec_studio.trace.node_selected", {
      nodeId,
      kind: node?.data.kind ?? "unknown",
      handle: node?.data.handle ?? null,
      slug: input.slug,
    });
  }

  function openElement(handle: string): void {
    logger.info("spec_studio.trace.element_opened", {
      handle,
      slug: input.slug,
    });
  }

  return (
    <section
      aria-labelledby={showHeading ? "traceability-heading" : undefined}
      aria-label={showHeading ? undefined : "Traceability graph"}
      className="mx-auto grid max-w-[1300px] gap-md"
    >
      {showHeading && (
        <div>
          <h2
            id="traceability-heading"
            className="m-0 font-display text-[1rem] font-bold text-text-primary"
          >
            Traceability
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            Requirement → criteria → tasks
          </p>
        </div>
      )}

      {graph.nodes.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border-dim bg-bg-base p-lg font-mono text-[0.72rem] text-text-tertiary">
          No structured elements are available to trace.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-sm">
            <span className="mr-xs font-mono text-[0.64rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
              Focus
            </span>
            <div
              role="group"
              aria-label="Trace focus"
              className="flex flex-wrap items-center gap-xs"
            >
              <TraceFocusButton
                active={focus === "all"}
                onClick={() => selectFocus("all")}
              >
                All
              </TraceFocusButton>
              {input.requirements.map((requirement) => (
                <TraceFocusButton
                  key={requirement.elementId}
                  active={focus === requirement.elementId}
                  onClick={() => selectFocus(requirement.elementId)}
                >
                  {requirement.handle}
                </TraceFocusButton>
              ))}
            </div>
            <span className="ml-auto font-mono text-[0.64rem] text-text-tertiary max-768:w-full">
              glyphs: ✓ approved · ○ pending · ↻ stale — click a node to inspect
              it
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-lg max-1180:grid-cols-1">
            <div
              role="region"
              aria-label="Fixed trace graph"
              data-viewport-behavior="static"
              className="min-w-0 overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-base"
            >
              <div
                data-testid="trace-static-layout"
                className="relative max-768:hidden"
                style={{ width: graph.width, height: graph.height }}
              >
                {traceColumns.map((column) => (
                  <span
                    key={column.label}
                    data-column-x={column.x}
                    className="absolute top-[12px] font-mono text-[0.6rem] font-bold tracking-[0.12em] text-text-tertiary uppercase"
                    style={{ left: column.x }}
                  >
                    {column.label}
                  </span>
                ))}
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  width={graph.width}
                  height={graph.height}
                  viewBox={`0 0 ${graph.width} ${graph.height}`}
                >
                  {graph.edges.map((edge) => {
                    const source = nodesById.get(edge.source);
                    const target = nodesById.get(edge.target);
                    if (source === undefined || target === undefined) {
                      return null;
                    }
                    const inChain =
                      chainNodeIds.has(edge.source) &&
                      chainNodeIds.has(edge.target);
                    const dimmed = selectedNode !== null && !inChain;
                    return (
                      <path
                        key={edge.id}
                        d={traceEdgePath(source, target)}
                        fill="none"
                        stroke={
                          inChain
                            ? "var(--color-cyan)"
                            : "var(--color-border-strong)"
                        }
                        strokeWidth={inChain ? 2 : 1.5}
                        opacity={dimmed ? 0.2 : inChain ? 0.95 : 0.55}
                      />
                    );
                  })}
                </svg>
                {presentedNodes.map((node) => (
                  <TraceabilityNode key={node.id} node={node} />
                ))}
              </div>
              <div
                aria-label="Trace columns"
                className="hidden min-h-[120px] content-center gap-sm p-md text-center font-mono text-[0.64rem] font-semibold text-text-tertiary max-768:grid"
              >
                <span>Requirement → Criteria → Tasks</span>
                <p className="m-0 leading-relaxed font-normal">
                  The fixed trace canvas is available on wider screens. Use the
                  trace index below to inspect every element.
                </p>
              </div>
            </div>
            {selectedNode !== null && (
              <TraceInspector
                node={selectedNode}
                chainSize={chainNodeIds.size}
                onOpenElement={openElement}
              />
            )}
            {selectedNode === null && <TraceInspectorEmpty />}
          </div>
          <TraceabilityIndex
            nodes={graph.nodes}
            selectedNodeId={selectedNode?.id ?? null}
            onSelect={selectNode}
          />
        </>
      )}
    </section>
  );
}

function TraceFocusButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-[22px] cursor-pointer items-center rounded-full border border-solid px-sm font-mono text-[0.66rem] font-semibold transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
        active
          ? "border-cyan-glow-strong bg-cyan-glow text-cyan"
          : "border-border-default bg-transparent text-text-secondary hover:border-border-strong hover:text-text-primary",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function focusTraceabilityInput(
  input: TraceabilityInput,
  focus: string,
): TraceabilityInput {
  if (focus === "all") return input;
  const requirement = input.requirements.find(
    (candidate) => candidate.elementId === focus,
  );
  if (requirement === undefined) return input;

  const criterionIds = new Set(requirement.criterionElementIds);
  const decisions = input.decisions.filter((decision) =>
    decision.tracedRequirementElementIds.includes(requirement.elementId),
  );
  const decisionIds = new Set(decisions.map((decision) => decision.elementId));
  const tasks = input.tasks.filter(
    (task) =>
      task.tracedRequirementElementIds.includes(requirement.elementId) ||
      task.coveredCriterionElementIds.some((id) => criterionIds.has(id)) ||
      task.tracedDecisionElementIds.some((id) => decisionIds.has(id)),
  );
  const taskIds = new Set(tasks.map((task) => task.elementId));
  const criteria = input.criteria.filter((criterion) =>
    criterionIds.has(criterion.elementId),
  );
  const handles = new Set([
    requirement.handle,
    ...decisions.map((decision) => decision.handle),
    ...tasks.map((task) => task.handle),
    ...criteria.map((criterion) => criterion.handle),
  ]);

  return {
    ...input,
    requirements: [requirement],
    decisions,
    tasks,
    executions: input.executions.filter((execution) =>
      (execution.scope?.selectedTaskIds ?? []).some((id) => taskIds.has(id)),
    ),
    criteria,
    findings: input.findings.filter((finding) =>
      handles.has(finding.elementHandle),
    ),
  };
}

function TraceInspectorEmpty(): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Trace inspector"
      className="sticky top-[60px] grid min-h-[180px] content-center gap-sm rounded-lg border border-dashed border-border-default bg-bg-base p-lg max-1180:static"
    >
      <p className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Trace inspector
      </p>
      <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
        <span>Select a node to inspect its chain.</span>{" "}
        <span>The full statement, state, and connections appear here.</span>
      </p>
    </div>
  );
}

type TraceNodeState = "idle" | "chain" | "selected";

function traceNodeState(
  nodeId: string,
  selectedNodeId: string | undefined,
  chainNodeIds: ReadonlySet<string>,
): TraceNodeState {
  if (nodeId === selectedNodeId) return "selected";
  if (chainNodeIds.has(nodeId)) return "chain";
  return "idle";
}

export function traceChainNodeIds(
  graph: TraceabilityGraphModel,
  selectedNodeId: string,
): Set<string> {
  const chain = new Set<string>([selectedNodeId]);
  const visit = (direction: "ancestors" | "descendants") => {
    const queue = [selectedNodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      for (const edge of graph.edges) {
        const next =
          direction === "ancestors" && edge.target === current
            ? edge.source
            : direction === "descendants" && edge.source === current
              ? edge.target
              : null;
        if (next === null || chain.has(next)) continue;
        chain.add(next);
        queue.push(next);
      }
    }
  };
  visit("ancestors");
  visit("descendants");
  return chain;
}

function TraceInspector({
  node,
  chainSize,
  onOpenElement,
}: {
  node: TraceabilityGraphNode;
  chainSize: number;
  onOpenElement: (handle: string) => void;
}): React.JSX.Element {
  const title = node.data.handle ?? nodeLabel[node.data.kind];

  return (
    <div
      role="group"
      aria-label="Trace inspector"
      aria-live="polite"
      className="sticky top-[60px] grid gap-md rounded-lg border border-solid border-border-default bg-bg-surface px-lg py-md max-1180:static"
    >
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <p className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Trace inspector
        </p>
        <StatusChip tone={nodeTone[node.data.kind]}>
          {nodeLabel[node.data.kind]}
        </StatusChip>
      </div>
      <div>
        <h3 className="m-0 font-mono text-[0.9rem] font-semibold text-text-primary">
          {title}
        </h3>
        <div className="mt-sm min-w-0">
          <CompactMarkdown content={node.data.label} />
        </div>
      </div>
      <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        {chainSize} {chainSize === 1 ? "node" : "nodes"} in the selected chain
      </p>
      {node.data.findings.map((finding) => (
        <p
          key={`${finding.ruleId}-${finding.elementHandle}-${finding.message}`}
          className="m-0 rounded-md border border-solid border-red-dim bg-red-glow p-sm font-mono text-[0.7rem] leading-relaxed text-red"
        >
          {finding.message}
        </p>
      ))}
      {node.data.href !== null && (
        <Link
          href={node.data.href}
          className="font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          onClick={() => {
            if (node.data.handle !== null) {
              onOpenElement(node.data.handle);
            }
          }}
        >
          Open {title}
        </Link>
      )}
    </div>
  );
}

function TraceabilityIndex({
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: TraceabilityGraphNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}): React.JSX.Element {
  return (
    <nav
      aria-label="Traceability elements"
      className="sr-only max-768:not-sr-only max-768:rounded-lg max-768:border max-768:border-solid max-768:border-border-subtle max-768:bg-bg-base max-768:p-md"
    >
      <div className="mb-sm flex flex-wrap items-center justify-between gap-sm">
        <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
          Accessible trace index
        </h3>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {nodes.length} nodes
        </span>
      </div>
      <ul className="m-0 grid list-none grid-cols-4 gap-xs p-0 max-768:grid-cols-1 max-1180:grid-cols-3">
        {nodes.map((node) => {
          const title = node.data.handle ?? nodeLabel[node.data.kind];
          const selected = node.id === selectedNodeId;
          return (
            <li key={node.id}>
              <Button
                variant={selected ? "default" : "ghost"}
                size="sm"
                touch
                aria-label={`Select ${title} from trace index`}
                aria-pressed={selected}
                layoutClassName="w-full"
                onClick={() => onSelect(node.id)}
              >
                {title} · {nodeLabel[node.data.kind]}
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function buildTraceabilityGraph(
  input: TraceabilityInput,
): TraceabilityGraphModel {
  const nodes = new Map<string, TraceabilityGraphNode>();
  const edges = new Map<string, TraceabilityGraphEdge>();
  const findingsByHandle = groupFindingsByHandle(input.findings);

  input.requirements.forEach((requirement) => {
    const requirementFindings = findingsByHandle.get(requirement.handle) ?? [];
    const presentation = requirementTracePresentation(
      requirement.approval,
      requirementFindings,
    );
    nodes.set(
      requirementNodeId(requirement.elementId),
      graphNode({
        id: requirementNodeId(requirement.elementId),
        kind: "requirement",
        label: requirement.label,
        handle: requirement.handle,
        href: elementHref(input.projectName, input.slug, requirement.handle),
        findings: requirementFindings,
        ...presentation,
      }),
    );
  });

  input.criteria.forEach((criterion) => {
    const criterionId = criterionNodeId(criterion.elementId);
    const criterionFindings = findingsByHandle.get(criterion.handle) ?? [];
    const presentation = criterionTracePresentation(
      criterion,
      criterionFindings,
    );
    nodes.set(
      criterionId,
      graphNode({
        id: criterionId,
        kind: "criterion",
        label: criterion.text,
        handle: criterion.handle,
        href: elementHref(input.projectName, input.slug, criterion.handle),
        findings: criterionFindings,
        ...presentation,
      }),
    );

    const parent = input.requirements.find((requirement) =>
      requirement.criterionElementIds.includes(criterion.elementId),
    );
    if (parent !== undefined) {
      addEdge(edges, requirementNodeId(parent.elementId), criterionId);
    }
  });

  const requirementIdsByDecision = new Map(
    input.decisions.map((decision) => [
      decision.elementId,
      decision.tracedRequirementElementIds,
    ]),
  );

  input.tasks.forEach((task) => {
    const taskId = taskNodeId(task.elementId);
    const taskFindings = findingsByHandle.get(task.handle) ?? [];
    const presentation = taskTracePresentation(task, taskFindings);
    nodes.set(
      taskId,
      graphNode({
        id: taskId,
        kind: "task",
        label: task.label,
        handle: task.handle,
        href: elementHref(input.projectName, input.slug, task.handle),
        findings: taskFindings,
        ...presentation,
      }),
    );

    let linkedToCriterion = false;
    for (const criterionId of task.coveredCriterionElementIds) {
      const criterionIdForGraph = criterionNodeId(criterionId);
      if (nodes.has(criterionIdForGraph)) {
        addEdge(edges, criterionIdForGraph, taskId);
        linkedToCriterion = true;
      }
    }
    if (linkedToCriterion) return;

    const tracedRequirementIds = new Set(task.tracedRequirementElementIds);
    for (const decisionId of task.tracedDecisionElementIds) {
      for (const requirementId of requirementIdsByDecision.get(decisionId) ??
        []) {
        tracedRequirementIds.add(requirementId);
      }
    }
    for (const requirementId of tracedRequirementIds) {
      const sourceId = requirementNodeId(requirementId);
      if (nodes.has(sourceId)) addEdge(edges, sourceId, taskId);
    }
  });

  const laidOutNodes = layoutTraceabilityNodes(nodes, edges, input);
  const height = Math.max(
    120,
    ...laidOutNodes.map((node) => node.position.y + node.height + 30),
  );
  return {
    nodes: laidOutNodes,
    edges: [...edges.values()],
    width: TRACE_GRAPH_WIDTH,
    height,
  };
}

function TraceabilityNode({
  node,
}: {
  node: TraceabilityGraphNode;
}): React.JSX.Element {
  const { data } = node;
  const title = data.handle ?? data.label;
  const traceState = data.traceState ?? "idle";
  const accentColor = traceAccentColor[data.accentTone];

  return (
    <article
      aria-label={`${nodeLabel[data.kind]} ${title}`}
      data-trace-state={traceState}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.width,
        height: node.height,
      }}
      className={cn(
        "absolute box-border rounded-lg border border-solid border-border-subtle bg-[linear-gradient(175deg,var(--cc-trace-node-grad-top),var(--cc-trace-node-grad-bottom))] px-[9px] py-[7px] transition-colors duration-150",
        "data-[trace-state=chain]:border-border-strong data-[trace-state=selected]:border-cyan data-[trace-state=selected]:shadow-[0_0_20px_var(--color-cyan-glow)]",
      )}
    >
      <span
        data-node-accent
        aria-hidden="true"
        className="absolute top-[-1px] right-[10%] left-[10%] h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
        }}
      />
      <button
        type="button"
        aria-label={`Select ${nodeLabel[data.kind].toLowerCase()} ${title}`}
        aria-pressed={traceState === "selected"}
        className="flex h-[18px] w-full cursor-pointer items-center gap-xs rounded-sm border-0 bg-transparent p-0 text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        onClick={data.onSelect}
      >
        {data.handle !== null && (
          <span className="shrink-0 font-mono text-[0.66rem] font-bold text-text-secondary">
            {data.handle}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[0.68rem] text-text-primary">
          {data.label}
        </span>
        {data.glyph !== null && (
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0 font-mono text-[0.72rem] font-bold",
              traceToneText[data.accentTone],
            )}
          >
            {data.glyph}
          </span>
        )}
      </button>
      {data.href !== null && (
        <Link href={data.href} className="sr-only">
          {data.handle === null ? "" : `${data.handle} · `}
          {data.label}
        </Link>
      )}
      {data.subline !== null && (
        <p
          className={cn(
            "mt-[2px] mb-0 truncate font-mono text-[0.58rem] font-semibold tracking-[0.04em] uppercase",
            traceToneText[data.accentTone],
          )}
        >
          {data.subline}
        </p>
      )}
    </article>
  );
}

const TRACE_GRAPH_WIDTH = 762;
const TRACE_START_Y = 44;
const traceNodePosition: Record<
  TraceabilityNodeKind,
  { x: number; width: number }
> = {
  requirement: { x: 16, width: 206 },
  criterion: { x: 252, width: 246 },
  task: { x: 532, width: 194 },
};

const traceAccentColor: Record<TraceabilityAccentTone, string> = {
  green: "var(--color-green)",
  amber: "var(--color-amber)",
  red: "var(--color-red)",
  neutral: "var(--color-border-strong)",
};

const traceToneText: Record<TraceabilityAccentTone, string> = {
  green: "text-green",
  amber: "text-amber",
  red: "text-red",
  neutral: "text-text-tertiary",
};

function graphNode(input: {
  id: string;
  kind: TraceabilityNodeKind;
  label: string;
  handle: string | null;
  href: string | null;
  findings: LintFinding[];
  glyph: TraceabilityNodeData["glyph"];
  subline: string | null;
  accentTone: TraceabilityAccentTone;
}): TraceabilityGraphNode {
  const dimensions = traceNodePosition[input.kind];
  const height = traceNodeHeight(input.kind, input.subline);
  return {
    id: input.id,
    position: { x: dimensions.x, y: TRACE_START_Y },
    width: dimensions.width,
    height,
    data: {
      kind: input.kind,
      label: input.label,
      handle: input.handle,
      href: input.href,
      findings: input.findings,
      glyph: input.glyph,
      subline: input.subline,
      accentTone: input.accentTone,
    },
  };
}

function addEdge(
  edges: Map<string, TraceabilityGraphEdge>,
  source: string,
  target: string,
): void {
  const id = `${source}->${target}`;
  edges.set(id, {
    id,
    source,
    target,
  });
}

function requirementTracePresentation(
  approval: TraceabilityRequirement["approval"],
  findings: LintFinding[],
): Pick<TraceabilityNodeData, "accentTone" | "glyph" | "subline"> {
  const finding = highestPriorityFinding(findings);
  if (finding !== null) {
    return {
      glyph: "↻",
      subline: finding.message,
      accentTone: finding.severity === "advisory" ? "amber" : "red",
    };
  }
  if (approval === "valid") {
    return { glyph: "✓", subline: null, accentTone: "green" };
  }
  if (approval === "stale") {
    return { glyph: "↻", subline: "Approval stale", accentTone: "amber" };
  }
  if (approval === "closed") {
    return { glyph: "○", subline: "Approval closed", accentTone: "neutral" };
  }
  return { glyph: "○", subline: null, accentTone: "neutral" };
}

function criterionTracePresentation(
  criterion: CriterionProofView,
  findings: LintFinding[],
): Pick<TraceabilityNodeData, "accentTone" | "glyph" | "subline"> {
  const finding = highestPriorityFinding(findings);
  if (finding !== null) {
    return {
      glyph: "↻",
      subline: finding.message,
      accentTone: finding.severity === "advisory" ? "amber" : "red",
    };
  }
  if (criterion.verdicts.some((verdict) => verdict.stale_at !== null)) {
    return { glyph: "↻", subline: "Verdict stale", accentTone: "amber" };
  }
  if (
    criterion.waiver !== null ||
    criterion.verdicts.length > 0 ||
    criterion.evidence.length > 0
  ) {
    return { glyph: "✓", subline: null, accentTone: "green" };
  }
  if (criterion.isPending) {
    return { glyph: "○", subline: "Verdict pending", accentTone: "neutral" };
  }
  return { glyph: null, subline: null, accentTone: "neutral" };
}

function taskTracePresentation(
  task: TraceabilityTask,
  findings: LintFinding[],
): Pick<TraceabilityNodeData, "accentTone" | "glyph" | "subline"> {
  const finding = highestPriorityFinding(findings);
  if (finding !== null) {
    return {
      glyph: "↻",
      subline: finding.message,
      accentTone: finding.severity === "advisory" ? "amber" : "red",
    };
  }
  if (task.isNewInRevision) {
    return {
      glyph: null,
      subline: `New · rev ${task.revisionNumber}`,
      accentTone: "amber",
    };
  }
  return { glyph: null, subline: null, accentTone: "neutral" };
}

function highestPriorityFinding(findings: LintFinding[]): LintFinding | null {
  return (
    findings.find((finding) => finding.severity !== "advisory") ??
    findings[0] ??
    null
  );
}

function traceNodeHeight(
  kind: TraceabilityNodeKind,
  subline: string | null,
): number {
  if (subline !== null) return 46;
  if (kind === "requirement") return 40;
  if (kind === "criterion") return 34;
  return 32;
}

function layoutTraceabilityNodes(
  nodes: Map<string, TraceabilityGraphNode>,
  edges: Map<string, TraceabilityGraphEdge>,
  input: TraceabilityInput,
): TraceabilityGraphNode[] {
  const nodesById = new Map(
    [...nodes].map(([id, node]) => [
      id,
      { ...node, position: { ...node.position } },
    ]),
  );
  const positionedCriteria = new Set<string>();
  let nextGroupTop = TRACE_START_Y;

  for (const requirement of input.requirements) {
    const requirementNode = nodesById.get(
      requirementNodeId(requirement.elementId),
    );
    if (requirementNode === undefined) continue;

    const criterionNodes = requirement.criterionElementIds.flatMap(
      (criterionId) => {
        const node = nodesById.get(criterionNodeId(criterionId));
        if (node === undefined || positionedCriteria.has(node.id)) return [];
        positionedCriteria.add(node.id);
        return [node];
      },
    );

    if (criterionNodes.length === 0) {
      requirementNode.position.y = nextGroupTop;
      nextGroupTop += requirementNode.height + 14;
      continue;
    }

    const criteriaGroupTop = nextGroupTop;
    for (const criterionNode of criterionNodes) {
      criterionNode.position.y = nextGroupTop;
      nextGroupTop += criterionNode.height + 10;
    }
    const criteriaGroupBottom = nextGroupTop - 10;
    requirementNode.position.y =
      criteriaGroupTop +
      Math.max(
        0,
        Math.round(
          (criteriaGroupBottom - criteriaGroupTop - requirementNode.height) / 2,
        ),
      );
    nextGroupTop =
      Math.max(
        criteriaGroupBottom,
        requirementNode.position.y + requirementNode.height,
      ) + 14;
  }

  for (const criterion of input.criteria) {
    const criterionNode = nodesById.get(criterionNodeId(criterion.elementId));
    if (
      criterionNode === undefined ||
      positionedCriteria.has(criterionNode.id)
    ) {
      continue;
    }
    criterionNode.position.y = nextGroupTop;
    positionedCriteria.add(criterionNode.id);
    nextGroupTop += criterionNode.height + 10;
  }

  const incomingByTarget = new Map<string, TraceabilityGraphNode[]>();
  for (const edge of edges.values()) {
    const source = nodesById.get(edge.source);
    if (source === undefined) continue;
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(source);
    incomingByTarget.set(edge.target, incoming);
  }
  const taskPlacements = input.tasks.flatMap((task, index) => {
    const node = nodesById.get(taskNodeId(task.elementId));
    if (node === undefined) return [];
    const incoming = incomingByTarget.get(node.id) ?? [];
    const desiredCenter =
      incoming.length === 0
        ? TRACE_START_Y + node.height / 2
        : incoming.reduce(
            (sum, source) => sum + source.position.y + source.height / 2,
            0,
          ) / incoming.length;
    return [
      {
        index,
        node,
        desiredTop: Math.max(
          TRACE_START_Y,
          Math.round(desiredCenter - node.height / 2),
        ),
      },
    ];
  });
  taskPlacements.sort(
    (left, right) =>
      left.desiredTop - right.desiredTop || left.index - right.index,
  );
  let previousTaskBottom = TRACE_START_Y - 8;
  for (const placement of taskPlacements) {
    placement.node.position.y = Math.max(
      placement.desiredTop,
      previousTaskBottom + 8,
    );
    previousTaskBottom = placement.node.position.y + placement.node.height;
  }

  return [...nodesById.values()];
}

function traceEdgePath(
  source: TraceabilityGraphNode,
  target: TraceabilityGraphNode,
): string {
  const sourceX = source.position.x + source.width;
  const sourceY = source.position.y + source.height / 2;
  const targetX = target.position.x;
  const targetY = target.position.y + target.height / 2;
  const controlOffset = Math.max(24, Math.min(70, (targetX - sourceX) / 2));
  return `M ${sourceX} ${sourceY} C ${sourceX + controlOffset} ${sourceY}, ${targetX - controlOffset} ${targetY}, ${targetX} ${targetY}`;
}

function groupFindingsByHandle(
  findings: LintFinding[],
): Map<string, LintFinding[]> {
  const grouped = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const current = grouped.get(finding.elementHandle) ?? [];
    current.push(finding);
    grouped.set(finding.elementHandle, current);
  }
  return grouped;
}

function requirementNodeId(elementId: string): string {
  return `requirement:${elementId}`;
}

function criterionNodeId(elementId: string): string {
  return `criterion:${elementId}`;
}

function taskNodeId(elementId: string): string {
  return `task:${elementId}`;
}

function elementHref(
  projectName: string,
  slug: string,
  handle: string,
): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?el=${encodeURIComponent(handle)}`;
}

export function formatEvidenceKind(kind: SpecEvidenceRow["kind"]): string {
  const labels: Record<SpecEvidenceRow["kind"], string> = {
    commit: "Commit",
    test_run: "Test run",
    validator_verdict: "Validator verdict",
  };
  return labels[kind];
}

function formatVerdictKind(kind: SpecProofVerdictRow["verdict_kind"]): string {
  const labels: Record<SpecProofVerdictRow["verdict_kind"], string> = {
    deterministic_validator: "Deterministic validator",
    agent_validator: "Agent validator",
    human: "Human judgment",
  };
  return labels[kind];
}

function evidenceReferenceLabel(value: string): string {
  try {
    const reference = JSON.parse(value) as Record<string, unknown>;
    if (reference.type === "workflow_event") {
      return `Workflow event ${String(reference.eventId)} · ${String(reference.contextId)}`;
    }
    if (reference.type === "git_object") {
      return `Git object ${String(reference.objectId)}`;
    }
    if (reference.type === "merge_validation") {
      return `Merge validation ${String(reference.validationRef)}`;
    }
  } catch {
    return "Unparseable evidence reference";
  }
  return "Evidence reference";
}

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
