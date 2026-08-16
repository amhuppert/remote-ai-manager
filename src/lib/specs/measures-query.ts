import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";

import {
  MEASURE_DEFINITIONS_VERSION,
  computeSpecMeasuresReport,
  specMeasureEventPayloadSchema,
  type LinkedWorkflowMeasureEvent,
  type SpecMeasureEvent,
  type SpecMeasuresReport,
} from "./measures";
import { deliveryVerdictMatchesExecutionBinding } from "./delivery-verdict-identity";
import type { SpecEventRow } from "./schemas";

const logger = createLogger("specs.measures");

export interface MeasuresQueryDeps {
  specs: Pick<SpecsRepo, "listByProject">;
  events: Pick<SpecEventsRepo, "findBySpecId" | "append">;
  delivery: Pick<
    SpecDeliveryRepo,
    "findExecutionsBySpecId" | "findDeliveryVerdictsBySpecExecutionId"
  >;
  executionBindings: Pick<SpecExecutionBindingRepo, "findBySpecExecutionId">;
  now(): string;
}

export interface MeasuresQuery {
  forProject(projectPath: string): Promise<SpecMeasuresReport>;
}

function decodePayload(row: SpecEventRow): unknown {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    logger.warn("specs.measures.event_payload_invalid", {
      specId: row.spec_id,
      specEventId: row.id,
    });
    return null;
  }
}

function toMeasureEvents(
  row: SpecEventRow,
  payload: unknown,
): SpecMeasureEvent[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("measureEvents" in payload) ||
    !Array.isArray(payload.measureEvents)
  ) {
    return [];
  }
  return payload.measureEvents.flatMap((candidate) => {
    const parsed = specMeasureEventPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.warn("specs.measures.measure_event_invalid", {
        specId: row.spec_id,
        specEventId: row.id,
        issues: parsed.error.issues,
      });
      return [];
    }
    return [
      {
        id: row.id,
        specId: row.spec_id,
        occurredAt: row.occurred_at,
        eventType: row.event_type,
        payload: parsed.data,
      },
    ];
  });
}

function isDefinitionsFreeze(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    payload.kind === "measure-definitions-frozen" &&
    "definitionsVersion" in payload &&
    payload.definitionsVersion === MEASURE_DEFINITIONS_VERSION
  );
}

function mergeEvent(
  row: SpecEventRow,
  payload: unknown,
): LinkedWorkflowMeasureEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("kind" in payload) || payload.kind !== "execution_delivered") {
    return null;
  }
  if (
    !("executionId" in payload) ||
    typeof payload.executionId !== "string" ||
    !("mergeHash" in payload) ||
    typeof payload.mergeHash !== "string"
  ) {
    return null;
  }
  const mergeId =
    "mergeId" in payload && typeof payload.mergeId === "string"
      ? payload.mergeId
      : `spec-event-${row.id}`;
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    eventType: "merge-completed",
    executionId: payload.executionId,
    mergeId,
    mergeCommitSha: payload.mergeHash,
  };
}

export function createMeasuresQuery(deps: MeasuresQueryDeps): MeasuresQuery {
  return {
    async forProject(projectPath) {
      const specs = await deps.specs.listByProject(projectPath);
      const measureEvents: SpecMeasureEvent[] = [];
      const linkedEvents: LinkedWorkflowMeasureEvent[] = [];
      let ignoredSpecEventCount = 0;
      let ignoredDeliveryVerdictCount = 0;

      for (const spec of specs) {
        const rows = deps.events.findBySpecId(spec.id);
        const decodedRows = rows.map((row) => ({
          row,
          payload: decodePayload(row),
        }));
        for (const { row, payload } of decodedRows) {
          const events = toMeasureEvents(row, payload);
          if (events.length === 0) {
            ignoredSpecEventCount += 1;
          } else {
            measureEvents.push(...events);
          }
          const delivered = mergeEvent(row, payload);
          if (delivered !== null) linkedEvents.push(delivered);
        }

        if (!decodedRows.some(({ payload }) => isDefinitionsFreeze(payload))) {
          deps.events.append({
            spec_id: spec.id,
            occurred_at: deps.now(),
            event_type: "spec-changed",
            actor_json: stableStringify({ kind: "system" }),
            payload_json: stableStringify({
              kind: "measure-definitions-frozen",
              definitionsVersion: MEASURE_DEFINITIONS_VERSION,
            }),
          });
        }

        for (const execution of deps.delivery.findExecutionsBySpecId(spec.id)) {
          if (execution.workflow_execution_id === null) continue;
          const linkedBinding = deps.executionBindings.findBySpecExecutionId(
            execution.id,
          );
          const deliveryVerdicts =
            deps.delivery.findDeliveryVerdictsBySpecExecutionId(execution.id);
          for (const [index, verdict] of deliveryVerdicts.entries()) {
            if (
              !deliveryVerdictMatchesExecutionBinding(
                verdict,
                execution,
                linkedBinding,
              )
            ) {
              ignoredDeliveryVerdictCount += 1;
              continue;
            }
            measureEvents.push({
              id: Number.MAX_SAFE_INTEGER - index,
              specId: spec.id,
              occurredAt: verdict.verdict_at,
              eventType: "spec-execution-changed",
              payload: {
                kind: "delivery-verdict-recorded",
                verdictId: verdict.id,
                criterionId: verdict.criterion_element_id,
                revisionId: execution.revision_id,
                executionId: execution.id,
                workflowExecutionId: verdict.workflow_execution_id,
                candidateId: verdict.candidate_id,
                candidateHash: verdict.candidate_hash,
                satisfyingContextId: verdict.satisfying_context_id,
              },
            });
          }
        }
      }

      const report = computeSpecMeasuresReport(measureEvents, linkedEvents);
      logger.info("specs.measures.computed", {
        projectPath,
        definitionsVersion: report.definitionsVersion,
        specCount: specs.length,
        measureEventCount: measureEvents.length,
        linkedEventCount: linkedEvents.length,
        ignoredSpecEventCount,
        ignoredDeliveryVerdictCount,
        deliveredCriterionCount:
          report.traceabilityCompleteness.deliveredInScopeCriterionCount,
      });
      return report;
    },
  };
}
