import { createLogger } from "@/lib/logging";
import type {
  GraphWorkflowEventRecord,
  GraphWorkflowEventsRepo,
} from "@/lib/state-store/graph-workflow-events-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type { EvidenceKind } from "./schemas";
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
    const candidates = records.flatMap((record) =>
      evidenceCandidates(record, originsByContext),
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

function evidenceCandidates(
  record: GraphWorkflowEventRecord,
  originsByContext: ReadonlyMap<string, readonly CompiledOriginMapEntry[]>,
): EvidenceCandidate[] {
  const event = record.event;
  if (
    event.type !== "graph-workflow-validation-result" &&
    event.type !== "graph-workflow-lane-commit"
  ) {
    return [];
  }
  const origins = originsByContext.get(event.contextId);
  if (origins === undefined) return [];
  const criteria = contextCriteria(origins);

  if (event.type === "graph-workflow-lane-commit") {
    return criteria.map(({ criterionElementId }) => ({
      kind: "commit",
      criterionElementId,
      contextId: event.contextId,
      eventRecord: record,
      commitSha: event.sha,
    }));
  }

  return criteria.flatMap(({ criterionElementId, strategy }) => {
    const kinds: EvidenceKind[] = strategy?.kinds.includes("test_run")
      ? ["test_run", "validator_verdict"]
      : ["validator_verdict"];
    return kinds.map((kind) => ({
      kind,
      criterionElementId,
      contextId: event.contextId,
      eventRecord: record,
    }));
  });
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
