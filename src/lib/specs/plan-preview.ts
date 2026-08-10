/**
 * Read-only compatibility preview for an evergreen revision and execution
 * scope. Active planning previews a DeliveryPlanAttempt instead, and active
 * start never consumes this compiler output.
 */
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  materializeSpecExecutionPlan,
  readCompiledOriginMap,
  type CompileSpecExecutionPlanInput,
} from "./compiler";
import { evidenceProducerFor } from "./evidence-producers";
import type { SpecRevisionSnapshot, ValidationStrategy } from "./schemas";

export type SpecPlanPreviewInput = CompileSpecExecutionPlanInput;

/** How many criterion briefs one context section prints before it truncates. */
export const PLAN_PREVIEW_BRIEF_LIMIT = 20;

export interface EvidenceProducerRow {
  kind: string;
  /**
   * The production event that actually mints this evidence kind, or `null`
   * when nothing in the ingest path does — a criterion requiring an unproduced
   * kind can never be proved, so the gap is named rather than implied.
   */
  producer: string | null;
  detail: string;
}

export interface SpecPlanPreviewCriterionBrief {
  criterionElementId: string;
  criterionHandle: string;
  /** The criterion's own approved text, as the pinned revision carries it. */
  text: string;
  /**
   * The validator brief the compiler assembled for this criterion, verbatim —
   * the context contract is the union of these, so a reader comparing the
   * preview with what a lane receives compares the same bytes.
   */
  brief: string;
  strategyNote: string | null;
  evidence: EvidenceProducerRow[];
}

export interface SpecPlanPreviewContext {
  contextId: string;
  title: string;
  description: string | null;
  /** The context contract the compiler assembled from its task briefs. */
  acceptanceCriteria: string;
  taskHandles: string[];
  criterionBriefs: SpecPlanPreviewCriterionBrief[];
}

export interface SpecPlanPreviewEdge {
  id: string;
  sourceContextId: string;
  targetContextId: string;
}

export interface SpecPlanPreviewRevision {
  id: string;
  number: number;
  state: SpecRevisionSnapshot["revision"]["state"];
  authoringStage: SpecRevisionSnapshot["revision"]["authoringStage"];
}

export interface SpecPlanPreview {
  spec: { id: string; slug: string; name: string };
  revision: SpecPlanPreviewRevision;
  scopeHash: string;
  approvalRequired: boolean;
  /** The exact definition the legacy evergreen compiler would return. */
  definition: WorkflowSemanticDefinition;
  /** The compiled contexts decomposed per criterion, in context-id order. */
  contexts: SpecPlanPreviewContext[];
  edges: SpecPlanPreviewEdge[];
  /** Distinct strategy kinds in this scope that no producer mints. */
  evidenceGaps: string[];
}

export function resolveEvidenceProducers(
  kinds: readonly string[],
): EvidenceProducerRow[] {
  return kinds.map((kind) => {
    const producer = evidenceProducerFor(kind);
    if (producer === null) {
      return {
        kind,
        producer: null,
        detail: `no evidence producer mints ${kind}; a criterion requiring it can never reach a proof — narrow the strategy to a produced kind`,
      };
    }
    return {
      kind,
      producer: producer.sourceEvent,
      detail: producer.detail,
    };
  });
}

export function buildSpecPlanPreview(
  input: SpecPlanPreviewInput,
): SpecPlanPreview {
  const definition = materializeSpecExecutionPlan(input);
  const origins = readCompiledOriginMap(definition);
  const criterionText = new Map(
    input.revisionSnapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [[element.id, version.payload.text] as const]
        : [],
    ),
  );
  const contexts = definition.executionContexts
    .map((context): SpecPlanPreviewContext => {
      const contextOrigins = origins.filter(
        (origin) => origin.contextId === context.id,
      );
      return {
        contextId: context.id,
        title: context.title,
        description: context.description ?? null,
        acceptanceCriteria: context.acceptanceCriteria,
        taskHandles: contextOrigins.map((origin) => origin.taskHandle),
        criterionBriefs: criterionBriefsFor(contextOrigins, criterionText),
      };
    })
    // Sections read in context-id order so two previews of the same plan are
    // textually identical; the definition keeps the compiler's own ordering.
    .sort((left, right) => left.contextId.localeCompare(right.contextId));
  const evidenceGaps = [
    ...new Set(
      contexts.flatMap((context) =>
        context.criterionBriefs.flatMap((brief) =>
          brief.evidence.flatMap((row) =>
            row.producer === null ? [row.kind] : [],
          ),
        ),
      ),
    ),
  ].sort();

  return {
    spec: input.spec,
    revision: {
      id: input.revisionSnapshot.revision.id,
      number: input.revisionSnapshot.revision.number,
      state: input.revisionSnapshot.revision.state,
      authoringStage: input.revisionSnapshot.revision.authoringStage,
    },
    scopeHash: input.scopeHash,
    approvalRequired: input.approvalRequired,
    definition,
    contexts,
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      sourceContextId: edge.sourceContextId,
      targetContextId: edge.targetContextId,
    })),
    evidenceGaps,
  };
}

export interface BoundedSpecPlanPreviewContext extends SpecPlanPreviewContext {
  totalBriefCount: number;
  shownBriefCount: number;
  omittedBriefCount: number;
}

export interface BoundedSpecPlanPreview {
  spec: SpecPlanPreview["spec"];
  revision: SpecPlanPreviewRevision;
  scopeHash: string;
  approvalRequired: boolean;
  charter: WorkflowSemanticDefinition["charter"];
  totalContextCount: number;
  shownContextCount: number;
  taskCount: number;
  criterionCount: number;
  contexts: BoundedSpecPlanPreviewContext[];
  edges: SpecPlanPreviewEdge[];
  evidenceGaps: string[];
  briefLimit: number;
}

export type BoundSpecPlanPreviewResult =
  | { ok: true; value: BoundedSpecPlanPreview }
  | { ok: false; knownContextIds: string[] };

/**
 * The one bounding projection behind both the human text and the `--json`
 * payload, so the two renderings cannot disagree about what was omitted.
 * `contextId` names the full-result path: that context prints complete.
 */
export function boundSpecPlanPreview(
  preview: SpecPlanPreview,
  options: { contextId?: string },
): BoundSpecPlanPreviewResult {
  const selected =
    options.contextId === undefined
      ? preview.contexts
      : preview.contexts.filter(
          (context) => context.contextId === options.contextId,
        );
  if (options.contextId !== undefined && selected.length === 0) {
    return {
      ok: false,
      knownContextIds: preview.contexts.map((context) => context.contextId),
    };
  }
  const unbounded = options.contextId !== undefined;
  const criterionCount = new Set(
    preview.contexts.flatMap((context) =>
      context.criterionBriefs.map((brief) => brief.criterionElementId),
    ),
  ).size;

  return {
    ok: true,
    value: {
      spec: preview.spec,
      revision: preview.revision,
      scopeHash: preview.scopeHash,
      approvalRequired: preview.approvalRequired,
      charter: preview.definition.charter,
      totalContextCount: preview.contexts.length,
      shownContextCount: selected.length,
      taskCount: preview.definition.tasks.length,
      criterionCount,
      contexts: selected.map((context) => {
        const shown = unbounded
          ? context.criterionBriefs
          : context.criterionBriefs.slice(0, PLAN_PREVIEW_BRIEF_LIMIT);
        return {
          ...context,
          criterionBriefs: shown,
          totalBriefCount: context.criterionBriefs.length,
          shownBriefCount: shown.length,
          omittedBriefCount: context.criterionBriefs.length - shown.length,
        };
      }),
      edges: preview.edges,
      evidenceGaps: preview.evidenceGaps,
      briefLimit: PLAN_PREVIEW_BRIEF_LIMIT,
    },
  };
}

/**
 * A context's criteria in first-owning-task order, deduped the same way the
 * compiled context contract dedupes them — regrouping must never make a
 * criterion appear twice or in a different place than the contract it powers.
 */
function criterionBriefsFor(
  contextOrigins: readonly ReturnType<typeof readCompiledOriginMap>[number][],
  criterionText: ReadonlyMap<string, string>,
): SpecPlanPreviewCriterionBrief[] {
  const briefs: SpecPlanPreviewCriterionBrief[] = [];
  const seen = new Set<string>();
  for (const origin of contextOrigins) {
    for (const [index, criterionId] of origin.criterionElementIds.entries()) {
      if (seen.has(criterionId)) continue;
      seen.add(criterionId);
      const strategy: ValidationStrategy | undefined =
        origin.validationStrategies[criterionId];
      briefs.push({
        criterionElementId: criterionId,
        criterionHandle: origin.criterionHandles[index] ?? criterionId,
        text: criterionText.get(criterionId) ?? "",
        brief: origin.criterionBriefs[criterionId] ?? "",
        strategyNote: strategy?.note ?? null,
        evidence: resolveEvidenceProducers(strategy?.kinds ?? []),
      });
    }
  }
  return briefs;
}
