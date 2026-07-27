import { createLogger } from "@/lib/logging";
import type {
  GraphWorkflowEventRecord,
  GraphWorkflowEventsRepo,
} from "@/lib/state-store/graph-workflow-events-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  type EvidenceKind,
} from "./schemas";
import type { SpecExecutionRow } from "./schemas";
import type { CompiledOriginMapEntry } from "./compiler";
import type { EvidenceService } from "./evidence-service";

const logger = createLogger("specs.evidence-ingest");

export interface EvidenceIngestDeps {
  repo: SpecDeliveryRepo;
  workflowEvents: Pick<
    GraphWorkflowEventsRepo,
    "findRecordsByExecution" | "findRecordById"
  >;
  evidenceService: Pick<EvidenceService, "attachEvidence">;
  writeQueue: WriteQueue;
  loadOriginMap(
    workflowDefinitionId: string,
    execution: SpecExecutionRow,
  ): Promise<CompiledOriginMapEntry[]>;
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
    const candidates = collectEvidenceCandidates(
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

    for (const candidate of candidates) {
      const existing = deps.repo.findEvidenceByIngestKey(
        candidate.eventRecord.id,
        candidate.criterionElementId,
        candidate.kind,
      );
      if (existing !== null) {
        existingEvidenceCount += 1;
        continue;
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
          relevantPaths: [],
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

    const summary = {
      scannedEventCount: records.length,
      ignoredEventCount:
        records.length -
        new Set(candidates.map((candidate) => candidate.eventRecord.id)).size,
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

function collectEvidenceCandidates(
  records: readonly GraphWorkflowEventRecord[],
  originsByContext: ReadonlyMap<string, readonly CompiledOriginMapEntry[]>,
  executionIsTerminal: boolean,
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const [index, record] of records.entries()) {
    const event = record.event;
    if (
      event.type !== "graph-workflow-validation-result" &&
      event.type !== "graph-workflow-lane-commit"
    ) {
      continue;
    }
    const origins = originsByContext.get(event.contextId);
    if (origins === undefined) continue;
    const criteria = contextCriteria(origins);

    if (event.type === "graph-workflow-lane-commit") {
      for (const { criterionElementId } of criteria) {
        candidates.push({
          kind: "commit",
          criterionElementId,
          contextId: event.contextId,
          eventRecord: record,
          commitSha: event.sha,
        });
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
    for (const { criterionElementId, strategy } of criteria) {
      const kinds: EvidenceKind[] = strategy?.kinds.includes("test_run")
        ? [...MACHINE_VALIDATION_EVIDENCE_KINDS]
        : ["validator_verdict"];
      for (const kind of kinds) {
        candidates.push({
          kind,
          criterionElementId,
          contextId: event.contextId,
          eventRecord: record,
          ...(sealing.outcome === "sealed" ? { commitSha: sealing.sha } : {}),
        });
      }
    }
  }
  return candidates;
}

type ValidationSealingOutcome =
  | { outcome: "sealed"; sha: string }
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
      return { outcome: "sealed", sha: event.sha };
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

function groupOriginsByContext(
  origins: readonly CompiledOriginMapEntry[],
): Map<string, CompiledOriginMapEntry[]> {
  const grouped = new Map<string, CompiledOriginMapEntry[]>();
  for (const origin of origins) {
    const entries = grouped.get(origin.contextId) ?? [];
    entries.push(origin);
    grouped.set(origin.contextId, entries);
  }
  return grouped;
}

function contextCriteria(origins: readonly CompiledOriginMapEntry[]): Array<{
  criterionElementId: string;
  strategy: CompiledOriginMapEntry["validationStrategies"][string] | undefined;
}> {
  const criteria = new Map<
    string,
    CompiledOriginMapEntry["validationStrategies"][string] | undefined
  >();
  for (const origin of origins) {
    for (const criterionElementId of origin.criterionElementIds) {
      if (criteria.has(criterionElementId)) continue;
      criteria.set(
        criterionElementId,
        origin.validationStrategies[criterionElementId],
      );
    }
  }
  return [...criteria].map(([criterionElementId, strategy]) => ({
    criterionElementId,
    strategy,
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
