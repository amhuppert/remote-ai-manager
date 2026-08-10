import { createLogger } from "@/lib/logging";
import type {
  GraphWorkflowEventRecord,
  GraphWorkflowEventsRepo,
} from "@/lib/state-store/graph-workflow-events-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  evidenceKindsForSourceEvent,
  isEvidenceSourceEvent,
} from "./evidence-producers";
import type { EvidenceKind, ValidationStrategy } from "./schemas";
import type { SpecExecutionRow } from "./schemas";
import type { SpecExecutionOriginMapEntry } from "./execution-origin-map";
import type { EvidenceService } from "./evidence-service";

const logger = createLogger("specs.evidence-ingest");

export interface EvidenceIngestDeps {
  repo: SpecDeliveryRepo;
  workflowEvents: Pick<
    GraphWorkflowEventsRepo,
    "findRecordsByExecution" | "findRecordById"
  >;
  evidenceService: Pick<
    EvidenceService,
    "attachEvidence" | "recordProofVerdict"
  >;
  writeQueue: WriteQueue;
  validatedTreeHash(
    execution: SpecExecutionRow,
    commitSha: string,
    relevantPaths: readonly string[],
  ): Promise<string>;
  loadOriginMap(
    workflowDefinitionId: string,
    execution: SpecExecutionRow,
  ): Promise<SpecExecutionOriginMapEntry[]>;
  /**
   * The linked graph workflow's live status (`null` when the run was deleted
   * from both the active slot and the archive). Terminality for the deferred
   * stamp MUST come from here rather than from the spec execution's own state:
   * the real terminal ingest paths (workflow-completed reconciliation,
   * markDelivered) run while the spec execution is still `running`, so a
   * spec-state-only predicate would defer a followerless final validation
   * forever.
   */
  getWorkflowExecutionStatus(
    workflowExecutionId: string,
  ): Promise<GraphWorkflowStatus | null>;
}

export interface IngestSummary {
  scannedEventCount: number;
  ignoredEventCount: number;
  materializedEvidenceCount: number;
  existingEvidenceCount: number;
}

export type BestEffortIngestResult =
  | { status: "ingested"; summary: IngestSummary }
  | { status: "contended" }
  | { status: "failed" };

export interface EvidenceIngestService {
  ingestAuthoritatively(specExecutionId: string): Promise<IngestSummary>;
  ingestBestEffort(specExecutionId: string): Promise<BestEffortIngestResult>;
}

interface EvidenceCandidate {
  kind: EvidenceKind;
  criterionElementId: string;
  contextId: string;
  eventRecord: GraphWorkflowEventRecord;
  commitSha?: string;
  relevantPaths: string[];
}

interface ProofCandidate {
  criterionElementId: string;
  strategy: ValidationStrategy;
  validationRecord: GraphWorkflowEventRecord;
  sealingCommitRecord: GraphWorkflowEventRecord;
}

interface IngestCandidates {
  evidence: EvidenceCandidate[];
  proof: ProofCandidate[];
}

export function createEvidenceIngestService(
  deps: EvidenceIngestDeps,
): EvidenceIngestService {
  async function materialize(specExecutionId: string): Promise<IngestSummary> {
    const execution = deps.repo.findExecutionById(specExecutionId);
    if (execution === null) {
      throw new Error(`Spec execution ${specExecutionId} was not found.`);
    }
    if (execution.workflow_execution_id === null) {
      return emptySummary();
    }

    const originMap = await deps.loadOriginMap(
      execution.workflow_definition_id,
      execution,
    );
    const originsByContext = groupOriginsByContext(originMap);
    const records = deps.workflowEvents.findRecordsByExecution(
      execution.workflow_execution_id,
    );
    const workflowStatus = await deps.getWorkflowExecutionStatus(
      execution.workflow_execution_id,
    );
    const candidates = collectIngestCandidates(
      records,
      originsByContext,
      // Terminality witnesses that no further same-context lane-commit can
      // decide a deferred validation, so undecided candidates materialize
      // unstamped instead of leaking forever. A completed/aborted/deleted
      // graph workflow is terminal even while the spec execution still runs
      // (reconciliation and markDelivered both ingest before the state flip);
      // a halted or paused run can resume, so it stays decidable-later. The
      // spec execution's own terminal states cover a run abandoned while its
      // workflow record lingers.
      workflowStatus === "completed" ||
        workflowStatus === "aborted" ||
        workflowStatus === null ||
        execution.state === "delivered" ||
        execution.state === "abandoned",
    );
    let materializedEvidenceCount = 0;
    let existingEvidenceCount = 0;
    const treeHashes = new Map<string, Promise<string>>();

    for (const candidate of candidates.evidence) {
      const existing = deps.repo.findEvidenceByIngestKey(
        candidate.eventRecord.id,
        candidate.criterionElementId,
        candidate.kind,
      );
      if (existing !== null) {
        existingEvidenceCount += 1;
        continue;
      }

      let relevantTreeHash: string | undefined;
      if (candidate.kind !== "commit" && candidate.commitSha !== undefined) {
        const treeHashKey = JSON.stringify([
          candidate.commitSha,
          candidate.relevantPaths,
        ]);
        let pending = treeHashes.get(treeHashKey);
        if (pending === undefined) {
          pending = deps.validatedTreeHash(
            execution,
            candidate.commitSha,
            candidate.relevantPaths,
          );
          treeHashes.set(treeHashKey, pending);
        }
        relevantTreeHash = await pending;
      }

      const attached = await deps.evidenceService.attachEvidence({
        specId: execution.spec_id,
        criterionElementId: candidate.criterionElementId,
        revisionId: execution.revision_id,
        kind: candidate.kind,
        ref:
          candidate.kind === "commit" && candidate.commitSha !== undefined
            ? { type: "git_object", objectId: candidate.commitSha }
            : {
                type: "workflow_event",
                workflowExecutionId: execution.workflow_execution_id,
                eventId: candidate.eventRecord.id,
                contextId: candidate.contextId,
              },
        evaluatedState: {
          ...(candidate.commitSha === undefined
            ? {}
            : { commitSha: candidate.commitSha }),
          relevantPaths: candidate.relevantPaths,
          ...(relevantTreeHash === undefined ? {} : { relevantTreeHash }),
        },
        producer: producerForEvent(candidate.eventRecord),
        executionId: execution.id,
        sourceEventId: candidate.eventRecord.id,
      });
      if (!attached.ok) {
        throw new Error(
          `Workflow evidence event ${candidate.eventRecord.id} was refused: ${attached.refusal.code}.`,
        );
      }
      materializedEvidenceCount += 1;
    }

    await materializeProofVerdicts(deps, execution, candidates.proof);

    const summary = {
      scannedEventCount: records.length,
      ignoredEventCount:
        records.length -
        new Set(
          candidates.evidence.map((candidate) => candidate.eventRecord.id),
        ).size,
      materializedEvidenceCount,
      existingEvidenceCount,
    };
    logger.info("specs.evidence-ingest.completed", {
      specExecutionId,
      workflowExecutionId: execution.workflow_execution_id,
      ...summary,
    });
    return summary;
  }

  return {
    ingestAuthoritatively(specExecutionId) {
      return deps.writeQueue.withWriteQueue(
        `spec-evidence-ingest[${specExecutionId}]`,
        () => materialize(specExecutionId),
      );
    },
    async ingestBestEffort(specExecutionId) {
      try {
        const attempt = await deps.writeQueue.tryWithWriteQueue(
          `spec-evidence-ingest-best-effort[${specExecutionId}]`,
          () => materialize(specExecutionId),
        );
        if (!attempt.acquired) {
          logger.info("specs.evidence-ingest.best-effort-contended", {
            specExecutionId,
          });
          return { status: "contended" };
        }
        return { status: "ingested", summary: attempt.value };
      } catch (error) {
        logger.warn("specs.evidence-ingest.best-effort-failed", {
          specExecutionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { status: "failed" };
      }
    },
  };
}

function collectIngestCandidates(
  records: readonly GraphWorkflowEventRecord[],
  originsByContext: ReadonlyMap<string, readonly SpecExecutionOriginMapEntry[]>,
  executionIsTerminal: boolean,
): IngestCandidates {
  const evidence: EvidenceCandidate[] = [];
  const proof: ProofCandidate[] = [];
  for (const [index, record] of records.entries()) {
    const event = record.event;
    if (!isEvidenceSourceEvent(event)) continue;
    const origins = originsByContext.get(event.contextId);
    if (origins === undefined) continue;
    const criteria = contextCriteria(origins);

    if (event.type === "graph-workflow-lane-commit") {
      for (const { criterionElementId } of criteria) {
        for (const kind of evidenceKindsForSourceEvent(event.type, undefined)) {
          evidence.push({
            kind,
            criterionElementId,
            contextId: event.contextId,
            eventRecord: record,
            commitSha: event.sha,
            relevantPaths: [],
          });
        }
      }
      continue;
    }

    // Forward correlation (production ordering is the source of truth): a
    // context completes on its last passing validation and the commit phase
    // then seals exactly the lane tree that validation saw. The commit event
    // that FOLLOWS a validation therefore names the sha it validated; a
    // validation followed by another validation was remediated away and its
    // sha claim would be false.
    const sealing = nextSameContextOutcome(records, index, event.contextId);
    if (sealing.outcome === "undecided" && !executionIsTerminal) {
      // Not yet decidable: skip without writing — the ingest key is
      // append-once, so a row frozen now could never gain its stamp. Ingest
      // re-runs at every claim/gate/status touchpoint.
      continue;
    }
    for (const { criterionElementId, strategy, relevantPaths } of criteria) {
      if (
        event.kind === "context_validation" &&
        event.pass &&
        strategy !== undefined &&
        sealing.outcome === "sealed"
      ) {
        proof.push({
          criterionElementId,
          strategy,
          validationRecord: record,
          sealingCommitRecord: sealing.record,
        });
      }
      const kinds = evidenceKindsForSourceEvent(event.type, strategy);
      for (const kind of kinds) {
        evidence.push({
          kind,
          criterionElementId,
          contextId: event.contextId,
          eventRecord: record,
          ...(sealing.outcome === "sealed" ? { commitSha: sealing.sha } : {}),
          relevantPaths: sealing.outcome === "sealed" ? relevantPaths : [],
        });
      }
    }
  }
  return { evidence, proof };
}

type ValidationSealingOutcome =
  | {
      outcome: "sealed";
      sha: string;
      record: GraphWorkflowEventRecord;
    }
  | { outcome: "superseded" }
  | { outcome: "undecided" };

function nextSameContextOutcome(
  records: readonly GraphWorkflowEventRecord[],
  fromIndex: number,
  contextId: string,
): ValidationSealingOutcome {
  for (const record of records.slice(fromIndex + 1)) {
    const event = record.event;
    if (
      event.type === "graph-workflow-lane-commit" &&
      event.contextId === contextId
    ) {
      return { outcome: "sealed", sha: event.sha, record };
    }
    if (
      event.type === "graph-workflow-validation-result" &&
      event.contextId === contextId
    ) {
      return { outcome: "superseded" };
    }
  }
  return { outcome: "undecided" };
}

async function materializeProofVerdicts(
  deps: EvidenceIngestDeps,
  execution: SpecExecutionRow,
  candidates: readonly ProofCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    const evidenceIds: string[] = [];
    for (const kind of [...new Set(candidate.strategy.kinds)]) {
      const sourceEventId =
        kind === "commit"
          ? candidate.sealingCommitRecord.id
          : candidate.validationRecord.id;
      const evidence = deps.repo.findEvidenceByIngestKey(
        sourceEventId,
        candidate.criterionElementId,
        kind,
      );
      if (evidence === null) {
        throw new Error(
          `Proof evidence ${sourceEventId}:${candidate.criterionElementId}:${kind} was not materialized.`,
        );
      }
      evidenceIds.push(evidence.id);
    }

    if (
      verdictAlreadyCitesEvidence(
        deps.repo,
        execution,
        candidate.criterionElementId,
        evidenceIds,
      )
    ) {
      continue;
    }

    const recorded = await deps.evidenceService.recordProofVerdict({
      specId: execution.spec_id,
      criterionElementId: candidate.criterionElementId,
      revisionId: execution.revision_id,
      executionId: execution.id,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: producerForEvent(candidate.validationRecord),
      evidenceIds,
      validationStrategy: candidate.strategy,
      strategyAssessment: { adequate: true },
    });
    if (!recorded.ok) {
      throw new Error(
        `Workflow proof event ${candidate.validationRecord.id} was refused: ${recorded.refusal.code}.`,
      );
    }
  }
}

function verdictAlreadyCitesEvidence(
  repo: SpecDeliveryRepo,
  execution: SpecExecutionRow,
  criterionElementId: string,
  evidenceIds: readonly string[],
): boolean {
  const expected = [...new Set(evidenceIds)].sort();
  return repo
    .findProofVerdictsByCriterionRevision(
      criterionElementId,
      execution.revision_id,
    )
    .some((verdict) => {
      if (
        verdict.execution_id !== execution.id ||
        verdict.verdict_kind !== "agent_validator"
      ) {
        return false;
      }
      const actual = parseEvidenceIds(verdict.evidence_ids_json);
      return (
        actual !== null &&
        actual.length === expected.length &&
        actual.every((id, index) => id === expected[index])
      );
    });
}

function parseEvidenceIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry): entry is string => typeof entry === "string")
    ) {
      return null;
    }
    return [...new Set(parsed)].sort();
  } catch {
    return null;
  }
}

function groupOriginsByContext(
  origins: readonly SpecExecutionOriginMapEntry[],
): Map<string, SpecExecutionOriginMapEntry[]> {
  const grouped = new Map<string, SpecExecutionOriginMapEntry[]>();
  for (const origin of origins) {
    const entries = grouped.get(origin.contextId) ?? [];
    entries.push(origin);
    grouped.set(origin.contextId, entries);
  }
  return grouped;
}

function contextCriteria(
  origins: readonly SpecExecutionOriginMapEntry[],
): Array<{
  criterionElementId: string;
  strategy:
    | SpecExecutionOriginMapEntry["validationStrategies"][string]
    | undefined;
  relevantPaths: string[];
}> {
  const criteria = new Map<
    string,
    {
      strategy:
        | SpecExecutionOriginMapEntry["validationStrategies"][string]
        | undefined;
      relevantPaths: Set<string>;
      fullTree: boolean;
    }
  >();
  for (const origin of origins) {
    for (const criterionElementId of origin.criterionElementIds) {
      const existing = criteria.get(criterionElementId);
      if (existing === undefined) {
        criteria.set(criterionElementId, {
          strategy: origin.validationStrategies[criterionElementId],
          relevantPaths: new Set(origin.touchedPaths),
          fullTree: origin.touchedPaths.length === 0,
        });
        continue;
      }
      if (existing.fullTree) continue;
      if (origin.touchedPaths.length === 0) {
        existing.fullTree = true;
        existing.relevantPaths.clear();
        continue;
      }
      for (const path of origin.touchedPaths) existing.relevantPaths.add(path);
    }
  }
  return [...criteria].map(([criterionElementId, value]) => ({
    criterionElementId,
    strategy: value.strategy,
    relevantPaths: value.fullTree ? [] : [...value.relevantPaths].sort(),
  }));
}

function producerForEvent(record: GraphWorkflowEventRecord): {
  kind: "agent";
  conversationId: string;
  backend?: string;
} {
  const event = record.event;
  if (event.type === "graph-workflow-validation-result" && event.sessionRef) {
    return {
      kind: "agent",
      conversationId:
        event.sessionRef.workflowConversationId ?? event.sessionRef.ref,
      backend: event.sessionRef.backend,
    };
  }
  return {
    kind: "agent",
    conversationId: `workflow:${record.executionId}`,
  };
}

function emptySummary(): IngestSummary {
  return {
    scannedEventCount: 0,
    ignoredEventCount: 0,
    materializedEvidenceCount: 0,
    existingEvidenceCount: 0,
  };
}
