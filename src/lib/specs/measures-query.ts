import { createLogger } from "@/lib/logging";
import type { GraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";

import type { CompiledOriginMapEntry } from "./compiler";
import {
  MEASURE_DEFINITIONS_VERSION,
  computeSpecMeasuresReport,
  specMeasureEventPayloadSchema,
  type LinkedWorkflowMeasureEvent,
  type SpecMeasureEvent,
  type SpecMeasuresReport,
} from "./measures";
import type { SpecEventRow } from "./schemas";

const logger = createLogger("specs.measures");

export interface MeasuresQueryDeps {
  specs: Pick<SpecsRepo, "listByProject">;
  events: Pick<SpecEventsRepo, "findBySpecId" | "append">;
  delivery: Pick<SpecDeliveryRepo, "findExecutionsBySpecId">;
  workflowEvents: Pick<GraphWorkflowEventsRepo, "findRecordsByExecution">;
  loadOriginMap(
    workflowDefinitionId: string,
    projectPath: string,
  ): Promise<CompiledOriginMapEntry[]>;
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

function taskIdsByContext(
  origins: readonly CompiledOriginMapEntry[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const origin of origins) {
    const taskIds = grouped.get(origin.contextId) ?? new Set<string>();
    taskIds.add(origin.taskElementId);
    grouped.set(origin.contextId, taskIds);
  }
  return new Map(
    [...grouped].map(([contextId, taskIds]) => [
      contextId,
      [...taskIds].sort(),
    ]),
  );
}

export function createMeasuresQuery(deps: MeasuresQueryDeps): MeasuresQuery {
  return {
    async forProject(projectPath) {
      const specs = await deps.specs.listByProject(projectPath);
      const measureEvents: SpecMeasureEvent[] = [];
      const linkedEvents: LinkedWorkflowMeasureEvent[] = [];
      let ignoredSpecEventCount = 0;

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
          const commitRecords = deps.workflowEvents
            .findRecordsByExecution(execution.workflow_execution_id)
            .filter(
              (record) => record.event.type === "graph-workflow-lane-commit",
            );
          if (commitRecords.length === 0) continue;
          const origins = await deps.loadOriginMap(
            execution.workflow_definition_id,
            projectPath,
          );
          const taskIdsForContext = taskIdsByContext(origins);
          for (const record of commitRecords) {
            if (record.event.type !== "graph-workflow-lane-commit") continue;
            const taskIds = taskIdsForContext.get(record.event.contextId);
            if (taskIds === undefined) {
              logger.warn("specs.measures.commit_context_unresolved", {
                specId: spec.id,
                specExecutionId: execution.id,
                workflowDefinitionId: execution.workflow_definition_id,
                workflowContextId: record.event.contextId,
                workflowEventId: record.id,
              });
              continue;
            }
            for (const taskId of taskIds) {
              linkedEvents.push({
                id: record.id,
                occurredAt: record.occurredAt,
                eventType: "task-commit-recorded",
                executionId: execution.id,
                taskId,
                commitSha: record.event.sha,
              });
            }
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
        deliveredCriterionCount:
          report.traceabilityCompleteness.deliveredInScopeCriterionCount,
      });
      return report;
    },
  };
}
