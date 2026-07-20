"use client";

import Link from "next/link";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type { LintFinding } from "@/lib/specs/lint";
import type {
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecProofVerdictRow,
  SpecWaiverRow,
  ValidationStrategy,
} from "@/lib/specs/schemas";

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
}

export interface TraceabilityInput {
  projectName: string;
  slug: string;
  requirements: TraceabilityRequirement[];
  decisions: TraceabilityDecision[];
  tasks: TraceabilityTask[];
  executions: SpecExecutionRow[];
  criteria: CriterionProofView[];
  findings: LintFinding[];
}

type TraceabilityNodeKind =
  | "requirement"
  | "decision"
  | "task"
  | "execution"
  | "evidence"
  | "finding";

interface TraceabilityNodeData extends Record<string, unknown> {
  kind: TraceabilityNodeKind;
  label: string;
  handle: string | null;
  href: string | null;
  findings: LintFinding[];
}

export interface TraceabilityGraphModel {
  nodes: Array<Node<TraceabilityNodeData>>;
  edges: Edge[];
}

const nodeTone: Record<TraceabilityNodeKind, StatusChipTone> = {
  requirement: "cyan",
  decision: "neutral",
  task: "amber",
  execution: "cyan",
  evidence: "green",
  finding: "red",
};

const nodeLabel: Record<TraceabilityNodeKind, string> = {
  requirement: "Requirement",
  decision: "Decision",
  task: "Task",
  execution: "Execution",
  evidence: "Evidence",
  finding: "Lint finding",
};

const severityTone: Record<LintFinding["severity"], StatusChipTone> = {
  blocks_propose: "red",
  blocks_claim: "red",
  blocks_signoff: "red",
  advisory: "amber",
};

const severityLabel: Record<LintFinding["severity"], string> = {
  blocks_propose: "Blocks propose",
  blocks_claim: "Blocks claim",
  blocks_signoff: "Blocks sign-off",
  advisory: "Advisory",
};

export function SpecEvidencePanel({
  criteria,
  revisionLabel = null,
  emptyMessage = "No acceptance criteria are present in this revision.",
}: {
  criteria: CriterionProofView[];
  revisionLabel?: string | null;
  emptyMessage?: string;
}): React.JSX.Element {
  return (
    <section aria-labelledby="spec-evidence-heading" className="grid gap-md">
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div>
          <h2
            id="spec-evidence-heading"
            className="m-0 font-display text-[0.95rem] font-bold text-text-primary"
          >
            Evidence by acceptance criterion
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
            Proof is evaluated against each criterion&apos;s approved validation
            strategy.
          </p>
        </div>
        {revisionLabel !== null && (
          <StatusChip tone="neutral">{revisionLabel}</StatusChip>
        )}
      </div>

      {criteria.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-dim bg-bg-base p-lg font-mono text-[0.72rem] text-text-tertiary">
          {emptyMessage}
        </div>
      ) : (
        criteria.map((criterion) => (
          <CriterionProofCard key={criterion.elementId} criterion={criterion} />
        ))
      )}
    </section>
  );
}

function CriterionProofCard({
  criterion,
}: {
  criterion: CriterionProofView;
}): React.JSX.Element {
  const currentVerdicts = criterion.verdicts.filter(
    (verdict) => verdict.stale_at === null,
  );
  const hasCurrentProof = currentVerdicts.length > 0;
  const currentWaiver = criterion.waiver?.stale === 0;
  const proofTone: StatusChipTone = hasCurrentProof
    ? "green"
    : currentWaiver
      ? "amber"
      : "neutral";
  const proofLabel = hasCurrentProof
    ? "Proven"
    : currentWaiver
      ? "Waived — not proof"
      : criterion.evidence.length > 0
        ? "Awaiting verdict"
        : "Unproven";

  return (
    <article
      aria-label={`${criterion.handle} proof`}
      id={`proof-${criterion.handle}`}
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <div className="min-w-0">
          <span className="font-mono text-[0.7rem] font-semibold text-cyan">
            {criterion.handle}
          </span>
          <p className="mt-xs mb-0 text-[0.78rem] leading-relaxed text-text-primary">
            {criterion.text}
          </p>
        </div>
        <StatusChip tone={proofTone}>{proofLabel}</StatusChip>
      </div>

      <div className="grid gap-md p-md">
        <div>
          <span className="font-mono text-[0.66rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Approved validation strategy
          </span>
          <div className="mt-sm flex flex-wrap gap-xs">
            {criterion.validationStrategy.kinds.map((kind) => (
              <StatusChip key={kind} tone="neutral">
                {formatEvidenceKind(kind)}
              </StatusChip>
            ))}
          </div>
          {criterion.validationStrategy.note !== undefined && (
            <p className="mt-sm mb-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
              {criterion.validationStrategy.note}
            </p>
          )}
        </div>

        {criterion.isPending ? (
          <p
            aria-live="polite"
            className="m-0 rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm font-mono text-[0.7rem] text-text-tertiary"
          >
            Loading evidence…
          </p>
        ) : criterion.error !== null ? (
          <p
            role="alert"
            className="m-0 rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.7rem] text-red"
          >
            {criterion.error}
          </p>
        ) : criterion.evidence.length === 0 && currentVerdicts.length === 0 ? (
          <p className="m-0 rounded-md border border-dashed border-border-dim bg-bg-base px-md py-sm font-mono text-[0.72rem] text-text-tertiary">
            Nothing proves this criterion yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-md max-900:grid-cols-1">
            <div>
              <span className="font-mono text-[0.66rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                Attached evidence
              </span>
              <div className="mt-sm grid gap-sm">
                {criterion.evidence.map((evidence) => (
                  <EvidenceRecord key={evidence.id} evidence={evidence} />
                ))}
              </div>
            </div>
            <div>
              <span className="font-mono text-[0.66rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                Proof verdicts
              </span>
              <div className="mt-sm grid gap-sm">
                {criterion.verdicts.length === 0 ? (
                  <p className="m-0 rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.7rem] text-text-tertiary">
                    Evidence is attached, but no proof verdict satisfies the
                    strategy yet.
                  </p>
                ) : (
                  criterion.verdicts.map((verdict) => (
                    <VerdictRecord key={verdict.id} verdict={verdict} />
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {currentWaiver && criterion.waiver !== null && (
          <p className="m-0 rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm font-mono text-[0.7rem] leading-relaxed text-amber">
            Waiver recorded: {criterion.waiver.reason}
          </p>
        )}
      </div>
    </article>
  );
}

function EvidenceRecord({
  evidence,
}: {
  evidence: SpecEvidenceRow;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <StatusChip tone="neutral">
          {formatEvidenceKind(evidence.kind)}
        </StatusChip>
        <span className="font-mono text-[0.64rem] text-text-tertiary">
          {evidence.id}
        </span>
      </div>
      <p className="mt-sm mb-0 font-mono text-[0.68rem] leading-relaxed break-all text-text-secondary">
        {evidenceReferenceLabel(evidence.ref_json)}
      </p>
    </div>
  );
}

function VerdictRecord({
  verdict,
}: {
  verdict: SpecProofVerdictRow;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span className="font-mono text-[0.7rem] text-text-primary">
          {formatVerdictKind(verdict.verdict_kind)}
        </span>
        <StatusChip tone={verdict.stale_at === null ? "green" : "amber"}>
          {verdict.stale_at === null ? "Current" : "Stale"}
        </StatusChip>
      </div>
      <p className="mt-sm mb-0 font-mono text-[0.66rem] text-text-tertiary">
        {parseStringList(verdict.evidence_ids_json).length} cited evidence
        record
        {parseStringList(verdict.evidence_ids_json).length === 1 ? "" : "s"}
      </p>
    </div>
  );
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
      ) : findings.length === 0 ? (
        <p className="m-0 rounded-lg border border-solid border-green-dim bg-green-glow p-md font-mono text-[0.72rem] text-green">
          No lint findings for this draft.
        </p>
      ) : (
        <ol className="m-0 grid list-none gap-sm p-0">
          {findings.map((finding, index) => (
            <li
              key={`${finding.ruleId}-${finding.elementHandle}-${index}`}
              className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-md"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <StatusChip tone={severityTone[finding.severity]}>
                  {severityLabel[finding.severity]}
                </StatusChip>
                <span className="font-mono text-[0.64rem] text-text-tertiary">
                  {finding.ruleId}
                </span>
                {finding.elementHandle.length > 0 && (
                  <Link
                    href={elementHref(projectName, slug, finding.elementHandle)}
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
      )}
    </section>
  );
}

export function TraceabilityGraph({
  input,
}: {
  input: TraceabilityInput;
}): React.JSX.Element {
  const graph = buildTraceabilityGraph(input);

  return (
    <section aria-labelledby="traceability-heading" className="grid gap-md">
      <div>
        <h2
          id="traceability-heading"
          className="m-0 font-display text-[0.95rem] font-bold text-text-primary"
        >
          Traceability
        </h2>
        <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
          Requirement → decision → task → execution → evidence
        </p>
      </div>

      {graph.nodes.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border-dim bg-bg-base p-lg font-mono text-[0.72rem] text-text-tertiary">
          No structured elements are available to trace.
        </p>
      ) : (
        <div className="h-[520px] min-w-0 overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-base max-768:h-[440px]">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={traceabilityNodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.25}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--color-border-dim)" gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}

export function buildTraceabilityGraph(
  input: TraceabilityInput,
): TraceabilityGraphModel {
  const nodes = new Map<string, Node<TraceabilityNodeData>>();
  const edges = new Map<string, Edge>();
  const proofByCriterion = new Map(
    input.criteria.map((criterion) => [criterion.elementId, criterion]),
  );
  const findingsByHandle = groupFindingsByHandle(input.findings);
  const surfacedFindings = new Set<LintFinding>();

  input.requirements.forEach((requirement, index) => {
    const childHandles = input.criteria
      .filter((criterion) =>
        requirement.criterionElementIds.includes(criterion.elementId),
      )
      .map((criterion) => criterion.handle);
    const requirementFindings = [
      ...(findingsByHandle.get(requirement.handle) ?? []),
      ...childHandles.flatMap((handle) => findingsByHandle.get(handle) ?? []),
    ];
    requirementFindings.forEach((finding) => surfacedFindings.add(finding));
    nodes.set(
      requirementNodeId(requirement.elementId),
      graphNode({
        id: requirementNodeId(requirement.elementId),
        kind: "requirement",
        label: requirement.label,
        handle: requirement.handle,
        href: elementHref(input.projectName, input.slug, requirement.handle),
        findings: requirementFindings,
        column: 0,
        row: index,
      }),
    );
  });

  input.decisions.forEach((decision, index) => {
    const decisionId = decisionNodeId(decision.elementId);
    const decisionFindings = findingsByHandle.get(decision.handle) ?? [];
    decisionFindings.forEach((finding) => surfacedFindings.add(finding));
    nodes.set(
      decisionId,
      graphNode({
        id: decisionId,
        kind: "decision",
        label: decision.label,
        handle: decision.handle,
        href: elementHref(input.projectName, input.slug, decision.handle),
        findings: decisionFindings,
        column: 1,
        row: index,
      }),
    );

    for (const requirementId of decision.tracedRequirementElementIds) {
      const requirementIdForGraph = requirementNodeId(requirementId);
      if (nodes.has(requirementIdForGraph)) {
        addEdge(edges, requirementIdForGraph, decisionId);
      }
    }
  });

  input.tasks.forEach((task, index) => {
    const taskId = taskNodeId(task.elementId);
    const taskFindings = findingsByHandle.get(task.handle) ?? [];
    taskFindings.forEach((finding) => surfacedFindings.add(finding));
    nodes.set(
      taskId,
      graphNode({
        id: taskId,
        kind: "task",
        label: task.label,
        handle: task.handle,
        href: elementHref(input.projectName, input.slug, task.handle),
        findings: taskFindings,
        column: 2,
        row: index,
      }),
    );

    for (const requirementId of task.tracedRequirementElementIds) {
      const requirementIdForGraph = requirementNodeId(requirementId);
      if (!nodes.has(requirementIdForGraph)) continue;
      addEdge(edges, requirementIdForGraph, taskId);
    }
    for (const decisionId of task.tracedDecisionElementIds) {
      const decisionIdForGraph = decisionNodeId(decisionId);
      if (nodes.has(decisionIdForGraph)) {
        addEdge(edges, decisionIdForGraph, taskId);
      }
    }
  });

  input.executions.forEach((execution, index) => {
    const executionIdForGraph = executionNodeId(execution.id);
    nodes.set(
      executionIdForGraph,
      graphNode({
        id: executionIdForGraph,
        kind: "execution",
        label: `Execution ${execution.id} · ${formatExecutionState(execution.state)}`,
        handle: null,
        href: `/projects/${encodeURIComponent(input.projectName)}/workflows?definition=${encodeURIComponent(execution.workflow_definition_id)}`,
        findings: [],
        column: 3,
        row: index,
      }),
    );
    for (const taskElementId of selectedTaskIds(execution.scope_json)) {
      const taskId = taskNodeId(taskElementId);
      if (nodes.has(taskId)) addEdge(edges, taskId, executionIdForGraph);
    }
  });

  for (const criterion of proofByCriterion.values()) {
    for (const record of criterion.evidence) {
      const executionId =
        record.execution_id ?? `human-${record.criterion_element_id}`;
      const executionIdForGraph = executionNodeId(executionId);
      if (!nodes.has(executionIdForGraph)) {
        nodes.set(
          executionIdForGraph,
          graphNode({
            id: executionIdForGraph,
            kind: "execution",
            label:
              record.execution_id === null
                ? "Human review"
                : `Execution ${record.execution_id}`,
            handle: null,
            href: null,
            findings: [],
            column: 3,
            row: nodesOfKind(nodes, "execution"),
          }),
        );
      }
      const evidenceIdForGraph = evidenceNodeId(record.id);
      if (!nodes.has(evidenceIdForGraph)) {
        nodes.set(
          evidenceIdForGraph,
          graphNode({
            id: evidenceIdForGraph,
            kind: "evidence",
            label: `Evidence ${record.id}`,
            handle: criterion.handle,
            href: elementHref(input.projectName, input.slug, criterion.handle),
            findings: [],
            column: 4,
            row: nodesOfKind(nodes, "evidence"),
          }),
        );
      }
      addEdge(edges, executionIdForGraph, evidenceIdForGraph);
    }
  }

  input.findings.forEach((finding, index) => {
    if (surfacedFindings.has(finding)) return;
    nodes.set(
      findingNodeId(finding, index),
      graphNode({
        id: findingNodeId(finding, index),
        kind: "finding",
        label: finding.message,
        handle: finding.elementHandle.length > 0 ? finding.elementHandle : null,
        href:
          finding.elementHandle.length > 0
            ? elementHref(input.projectName, input.slug, finding.elementHandle)
            : null,
        findings: [],
        column: 5,
        row: nodesOfKind(nodes, "finding"),
      }),
    );
  });

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function TraceabilityNode({
  data,
}: NodeProps<Node<TraceabilityNodeData>>): React.JSX.Element {
  return (
    <div className="w-[190px] rounded-lg border border-solid border-border-default bg-bg-surface p-sm shadow-dropdown">
      {data.kind !== "requirement" && data.kind !== "finding" && (
        <Handle type="target" position={Position.Left} />
      )}
      <div className="flex items-center justify-between gap-sm">
        <StatusChip tone={nodeTone[data.kind]}>
          {nodeLabel[data.kind]}
        </StatusChip>
        {data.handle !== null && (
          <span className="font-mono text-[0.66rem] font-semibold text-cyan">
            {data.handle}
          </span>
        )}
      </div>
      {data.href === null ? (
        <p className="mt-sm mb-0 font-mono text-[0.7rem] leading-snug text-text-primary">
          {data.label}
        </p>
      ) : (
        <Link
          href={data.href}
          className="mt-sm block font-mono text-[0.7rem] leading-snug text-text-primary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          {data.handle} · {data.label}
        </Link>
      )}
      {data.findings.map((finding) => (
        <p
          key={`${finding.ruleId}-${finding.elementHandle}-${finding.message}`}
          className="mt-sm mb-0 rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.64rem] leading-snug text-red"
        >
          {finding.message}
        </p>
      ))}
      {data.kind !== "evidence" && data.kind !== "finding" && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const traceabilityNodeTypes = {
  traceability: TraceabilityNode,
} as unknown as NodeTypes;

function graphNode(input: {
  id: string;
  kind: TraceabilityNodeKind;
  label: string;
  handle: string | null;
  href: string | null;
  findings: LintFinding[];
  column: number;
  row: number;
}): Node<TraceabilityNodeData> {
  return {
    id: input.id,
    type: "traceability",
    position: { x: input.column * 260, y: input.row * 150 },
    data: {
      kind: input.kind,
      label: input.label,
      handle: input.handle,
      href: input.href,
      findings: input.findings,
    },
  };
}

function addEdge(
  edges: Map<string, Edge>,
  source: string,
  target: string,
): void {
  const id = `${source}->${target}`;
  edges.set(id, {
    id,
    source,
    target,
    markerEnd: { type: MarkerType.ArrowClosed },
  });
}

function nodesOfKind(
  nodes: Map<string, Node<TraceabilityNodeData>>,
  kind: TraceabilityNodeKind,
): number {
  return [...nodes.values()].filter((node) => node.data.kind === kind).length;
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

function decisionNodeId(elementId: string): string {
  return `decision:${elementId}`;
}

function taskNodeId(elementId: string): string {
  return `task:${elementId}`;
}

function executionNodeId(executionId: string): string {
  return `execution:${executionId}`;
}

function evidenceNodeId(evidenceId: string): string {
  return `evidence:${evidenceId}`;
}

function findingNodeId(finding: LintFinding, index: number): string {
  return `finding:${finding.ruleId}:${finding.elementHandle}:${index}`;
}

function selectedTaskIds(scopeJson: string): string[] {
  try {
    const scope = JSON.parse(scopeJson) as Record<string, unknown>;
    return Array.isArray(scope.selectedTaskIds)
      ? scope.selectedTaskIds.filter(
          (taskId): taskId is string => typeof taskId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function formatExecutionState(state: SpecExecutionRow["state"]): string {
  return state.replaceAll("_", " ");
}

function elementHref(
  projectName: string,
  slug: string,
  handle: string,
): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?el=${encodeURIComponent(handle)}`;
}

function formatEvidenceKind(kind: SpecEvidenceRow["kind"]): string {
  const labels: Record<SpecEvidenceRow["kind"], string> = {
    commit: "Commit",
    diff: "Diff",
    test_run: "Test run",
    validator_verdict: "Validator verdict",
    screenshot: "Screenshot",
    human_signoff: "Human sign-off",
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
    if (reference.type === "content_store") {
      return `Capture ${String(reference.objectKey)}`;
    }
    if (reference.type === "human_actor") {
      return `Human sign-off ${String(reference.actorId)}`;
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
