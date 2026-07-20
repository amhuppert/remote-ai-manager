"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TabsTriggerCount,
} from "@/components/ui/Tabs";
import { parseElementHandle } from "@/lib/specs/handles";
import {
  specQueries,
  type SpecDetailView,
  type SpecElementGetResponse,
} from "@/lib/specs/queries";
import type {
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";

import {
  SpecEvidencePanel,
  SpecLintPanel,
  TraceabilityGraph,
  type CriterionProofView,
  type TraceabilityInput,
} from "./SpecEvidenceLintTrace";
import SpecControlsPanel from "./SpecControls";
import SpecQuestionsAssumptionsPanel from "./SpecQuestionsAssumptions";

export type DetailView =
  | "content"
  | "evidence"
  | "lint"
  | "traceability"
  | "questions"
  | "controls";

interface CriterionDescriptor {
  elementId: string;
  handle: string;
  text: string;
  validationStrategy: Extract<
    SpecRevisionElement["version"]["payload"],
    { kind: "criterion" }
  >["validationStrategy"];
}

export interface EvidenceRevisionTarget {
  snapshot: SpecRevisionSnapshot;
  source: "pinned" | "approved";
  executionId: string | null;
}

export default function SpecDetailViews({
  detail,
  projectName,
  initialView = "content",
  children,
}: {
  detail: SpecDetailView;
  projectName: string;
  initialView?: DetailView;
  children: ReactNode;
}): React.JSX.Element {
  const [view, setView] = useState<DetailView>(initialView);
  const evidenceTarget = useMemo(
    () => selectEvidenceRevision(detail),
    [detail],
  );
  const traceSnapshot = evidenceTarget?.snapshot ?? detail.currentRevision;
  const criteria = useMemo(
    () => criterionDescriptors(evidenceTarget?.snapshot ?? null),
    [evidenceTarget],
  );
  const needsEvidence = view === "evidence" || view === "traceability";
  const needsLint = view === "lint" || view === "traceability";
  const elementQueries = useQueries({
    queries: criteria.map((criterion) => ({
      ...specQueries.element(
        projectName,
        detail.spec.slug,
        criterion.handle,
        undefined,
        evidenceTarget?.snapshot.revision.id,
      ),
      enabled: needsEvidence,
    })),
  });
  const lintQuery = useQuery({
    ...specQueries.lint(projectName, detail.spec.slug),
    enabled: needsLint,
  });
  const proofViews = criteria.map((criterion, index) =>
    toCriterionProofView(criterion, elementQueries[index]),
  );
  const lintFindings = lintQuery.data?.findings ?? [];
  // Open questions and undispositioned assumptions both wait on a human, so
  // the tab count surfaces exactly the records needing attention.
  const attentionCount =
    detail.questions.filter((question) => question.status === "open").length +
    detail.assumptions.filter(
      (assumption) => assumption.disposition === "proposed",
    ).length;
  const traceabilityInput = buildTraceabilityInput(
    detail,
    traceSnapshot,
    projectName,
    proofViews,
    lintFindings,
  );

  return (
    <TabsRoot
      value={view}
      onValueChange={(value) => setView(value as DetailView)}
    >
      <TabsList layoutClassName="mt-lg w-fit max-768:w-full max-768:overflow-x-auto">
        <TabsTrigger
          value="content"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Content
        </TabsTrigger>
        <TabsTrigger
          value="evidence"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Evidence
        </TabsTrigger>
        <TabsTrigger
          value="lint"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Lint
          {lintFindings.length > 0 && (
            <TabsTriggerCount>{lintFindings.length}</TabsTriggerCount>
          )}
        </TabsTrigger>
        <TabsTrigger
          value="traceability"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Traceability
        </TabsTrigger>
        <TabsTrigger
          value="questions"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Questions
          {attentionCount > 0 && (
            <TabsTriggerCount>{attentionCount}</TabsTriggerCount>
          )}
        </TabsTrigger>
        <TabsTrigger
          value="controls"
          fill
          layoutClassName="max-768:grow max-768:basis-0"
        >
          Controls
        </TabsTrigger>
      </TabsList>

      <TabsContent value="content" layoutClassName="mt-lg">
        {children}
      </TabsContent>
      <TabsContent value="evidence" layoutClassName="mt-lg">
        <SpecEvidencePanel
          criteria={proofViews}
          revisionLabel={
            evidenceTarget === null
              ? null
              : `${evidenceTarget.source === "pinned" ? "Pinned" : "Approved"} revision ${evidenceTarget.snapshot.revision.number}`
          }
          emptyMessage={
            evidenceTarget === null
              ? "No approved revision is available for proof evaluation."
              : undefined
          }
        />
      </TabsContent>
      <TabsContent value="lint" layoutClassName="mt-lg">
        <SpecLintPanel
          projectName={projectName}
          slug={detail.spec.slug}
          revisionId={lintQuery.data?.revisionId ?? null}
          findings={lintFindings}
          isPending={lintQuery.isPending || lintQuery.isFetching}
          error={
            lintQuery.error instanceof Error ? lintQuery.error.message : null
          }
        />
      </TabsContent>
      <TabsContent value="traceability" layoutClassName="mt-lg">
        <TraceabilityGraph input={traceabilityInput} />
      </TabsContent>
      <TabsContent value="questions" layoutClassName="mt-lg">
        <SpecQuestionsAssumptionsPanel
          detail={detail}
          projectName={projectName}
        />
      </TabsContent>
      <TabsContent value="controls" layoutClassName="mt-lg">
        <SpecControlsPanel detail={detail} projectName={projectName} />
      </TabsContent>
    </TabsRoot>
  );
}

// Q/A records render inside the Questions tab, so a ?el=Q1/?el=A1 deep link
// must open that tab or its scroll/focus target never mounts.
export function initialDetailViewForDeepLink(
  rawHandle: string | null,
  slug: string | undefined,
): DetailView {
  if (rawHandle === "execution_start") return "controls";
  if (rawHandle === null || slug === undefined) return "content";
  try {
    const kind = parseElementHandle(rawHandle, slug).kind;
    return kind === "question" || kind === "assumption"
      ? "questions"
      : "content";
  } catch {
    return "content";
  }
}

export function selectEvidenceRevision(
  detail: SpecDetailView,
): EvidenceRevisionTarget | null {
  const snapshots = [
    detail.currentRevision,
    detail.baseRevision,
    detail.currentApprovedRevision,
    ...detail.executionRevisionSnapshots,
  ].filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null);
  const activeExecution = detail.executions.find(
    (execution) =>
      execution.state === "definition_review" || execution.state === "running",
  );
  if (activeExecution !== undefined) {
    const pinned = snapshots.find(
      (snapshot) => snapshot.revision.id === activeExecution.revision_id,
    );
    if (pinned?.revision.state === "approved") {
      return {
        snapshot: pinned,
        source: "pinned",
        executionId: activeExecution.id,
      };
    }
  }
  if (detail.currentApprovedRevision === null) return null;
  return {
    snapshot: detail.currentApprovedRevision,
    source: "approved",
    executionId: null,
  };
}

function criterionDescriptors(
  snapshot: SpecRevisionSnapshot | null,
): CriterionDescriptor[] {
  if (snapshot === null) return [];
  const requirements = new Map(
    snapshot.elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "requirement" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [[entry.element.id, `R${entry.element.number}`] as const];
    }),
  );

  return snapshot.elements.flatMap((entry): CriterionDescriptor[] => {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      return [];
    }
    const requirementHandle = requirements.get(entry.element.parentElementId);
    if (requirementHandle === undefined) return [];
    return [
      {
        elementId: entry.element.id,
        handle: `${requirementHandle}.${entry.element.number}`,
        text: entry.version.payload.text,
        validationStrategy: entry.version.payload.validationStrategy,
      },
    ];
  });
}

function toCriterionProofView(
  descriptor: CriterionDescriptor,
  query:
    | {
        data?: SpecElementGetResponse;
        isPending: boolean;
        isFetching: boolean;
        error: unknown;
      }
    | undefined,
): CriterionProofView {
  // Criterion handles always resolve to revision elements; the Q/A branch of
  // the union carries no evidence state.
  const state =
    query?.data !== undefined && "evidenceState" in query.data
      ? query.data.evidenceState.find(
          (candidate) => candidate.criterionElementId === descriptor.elementId,
        )
      : undefined;
  return {
    ...descriptor,
    evidence: state?.evidence ?? [],
    verdicts: state?.verdicts ?? [],
    waiver: state?.waiver ?? null,
    isPending: query?.isPending === true || query?.isFetching === true,
    error: query?.error instanceof Error ? query.error.message : null,
  };
}

function buildTraceabilityInput(
  detail: SpecDetailView,
  snapshot: SpecRevisionSnapshot | null,
  projectName: string,
  criteria: CriterionProofView[],
  findings: TraceabilityInput["findings"],
): TraceabilityInput {
  const elements = snapshot?.elements ?? [];
  const criteriaByRequirement = new Map<string, string[]>();
  for (const criterion of elements) {
    if (
      criterion.version.payload.kind !== "criterion" ||
      criterion.element.parentElementId === null
    ) {
      continue;
    }
    const ids =
      criteriaByRequirement.get(criterion.element.parentElementId) ?? [];
    ids.push(criterion.element.id);
    criteriaByRequirement.set(criterion.element.parentElementId, ids);
  }

  return {
    projectName,
    slug: detail.spec.slug,
    requirements: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "requirement" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `R${entry.element.number}`,
          label: entry.version.payload.statement,
          criterionElementIds:
            criteriaByRequirement.get(entry.element.id) ?? [],
        },
      ];
    }),
    decisions: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "decision" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `D${entry.element.number}`,
          label: entry.version.payload.title,
          tracedRequirementElementIds:
            entry.version.payload.tracedRequirementElementIds,
        },
      ];
    }),
    tasks: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "task" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `T${entry.element.number}`,
          label: entry.version.payload.title,
          tracedRequirementElementIds:
            entry.version.payload.tracedRequirementElementIds,
          tracedDecisionElementIds:
            entry.version.payload.tracedDecisionElementIds,
          coveredCriterionElementIds:
            entry.version.payload.coveredCriterionElementIds,
        },
      ];
    }),
    executions: detail.executions,
    criteria,
    findings,
  };
}
