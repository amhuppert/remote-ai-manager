import type {
  GraphWorkflowEventsRepo,
  GraphWorkflowEventRecord,
} from "@/lib/state-store/graph-workflow-events-repo";
import type { GraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { GraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import type { GraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import type { SubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import type {
  GraphWorkflowExecution,
  GraphWorkflowResultDelivery,
} from "@/lib/workflow-graph/schemas";
import type {
  SourceCursor,
  SourceFact,
  SourceReadResult,
  SubscriptionRecipient,
} from "./schemas";
import type { TerminalSourceRead } from "./active-wait-schemas";
import { isTerminalStatus } from "@/lib/workflow-graph/lifecycle-classifier";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
import { stableStringify } from "@/lib/shared/stable-stringify";

export interface WorkflowSourceDeps {
  queries: SubscriptionSourceQueriesRepo;
  workflows: GraphWorkflowExecutionsRepo;
  archivedWorkflows: GraphWorkflowArchivedExecutionsRepo;
  workflowEvents: GraphWorkflowEventsRepo;
  resultDeliveries: GraphWorkflowResultDeliveriesRepo;
  now?(): string;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const outcomeKinds = new Set(["completion", "halt", "abandon", "abort"]);

export function projectRecordedWorkflowSourceFact(
  result: GraphWorkflowResultDelivery,
): SourceFact {
  const kind =
    typeof result.payload.boundaryKind === "string"
      ? result.payload.boundaryKind
      : "unknown";
  const status =
    typeof result.payload.status === "string"
      ? result.payload.status
      : "unknown";
  return {
    occurrenceId: String(result.boundarySeq),
    eventKind: `graph-workflow-boundary:${kind}`,
    category: outcomeKinds.has(kind) ? "outcome" : "decision",
    sourceTitle:
      typeof result.payload.name === "string"
        ? result.payload.name
        : `Workflow ${result.executionId}`,
    summary: `Workflow reached ${kind} (${status}).`,
    sourceText: stableStringify(result.payload),
    occurredAt: result.recordedAt,
    revision: null,
    outcome: status,
    retrievalHandle: `cctl workflow status --project=${quote(projectNameFromPath(result.projectPath))} --session=${quote(result.sessionName)} -- ${quote(result.executionId)}`,
    actorConversationId: null,
  };
}

export function projectWorkflowSourceFact(input: {
  execution: GraphWorkflowExecution;
  record: GraphWorkflowEventRecord;
  result: GraphWorkflowResultDelivery | null;
}): SourceFact {
  if (input.result) return projectRecordedWorkflowSourceFact(input.result);
  return projectLegacyWorkflowSourceFact(
    input.record,
    input.execution.launchDocument?.name ?? `Workflow ${input.execution.id}`,
  );
}

export function projectLegacyWorkflowSourceFact(
  record: GraphWorkflowEventRecord,
  title = `Workflow ${record.executionId}`,
): SourceFact {
  if (record.event.type !== "graph-workflow-boundary")
    throw Error("Expected a workflow boundary");
  return {
    occurrenceId: String(record.id),
    eventKind: `${record.event.type}:${record.event.boundaryKind}`,
    category: outcomeKinds.has(record.event.boundaryKind)
      ? "outcome"
      : "decision",
    sourceTitle: title,
    summary: `Workflow reached ${record.event.boundaryKind} (${record.event.workflowStatus}).`,
    sourceText: stableStringify({
      executionId: record.executionId,
      boundarySeq: record.id,
      recordedAt: record.occurredAt,
      evidence: "legacy-boundary-event",
      boundaryEvent: record.event,
      limitations:
        "No boundary-time execution identity or document snapshot was recorded.",
    }),
    occurredAt: record.occurredAt,
    revision: null,
    outcome: record.event.workflowStatus,
    retrievalHandle: `cctl workflow status --project=${quote(projectNameFromPath(record.projectPath))} --session=${quote(record.sessionName)} -- ${quote(record.executionId)}`,
    actorConversationId: null,
  };
}

function findExecution(
  deps: WorkflowSourceDeps,
  recipient: SubscriptionRecipient,
  source: { id: string },
) {
  const address = deps.queries.findWorkflowAddress(source.id);
  if (!address || address.projectPath !== recipient.projectPath) return null;
  const execution =
    deps.workflows.findByExecutionId(source.id) ??
    deps.archivedWorkflows.findByExecutionId(source.id);
  return execution ? { address, execution } : null;
}

export function createWorkflowSourceReader(deps: WorkflowSourceDeps) {
  return async (
    recipient: SubscriptionRecipient,
    source: { id: string },
    cursor: SourceCursor,
  ): Promise<SourceReadResult> => {
    const found = findExecution(deps, recipient, source);
    if (!found) return { cursor, facts: [], missing: true };
    const { address, execution } = found;
    if (cursor === null) {
      const latest = deps.workflowEvents.findPage(
        address.projectPath,
        address.sessionName,
        source.id,
        { limit: 1, direction: "desc" },
      ).records[0];
      return { cursor: String(latest?.id ?? 0), facts: [], missing: false };
    }
    let current = Number(cursor);
    if (!Number.isSafeInteger(current) || current < 0)
      throw Error("Invalid workflow event cursor");
    const facts: SourceFact[] = [];
    for (;;) {
      const page = deps.workflowEvents.findPage(
        address.projectPath,
        address.sessionName,
        source.id,
        { limit: 500, cursor: current, direction: "asc" },
      );
      for (const record of page.records) {
        current = record.id;
        if (record.event.type !== "graph-workflow-boundary") continue;
        facts.push(
          projectWorkflowSourceFact({
            execution,
            record,
            result: deps.resultDeliveries.findByBoundary(
              address.projectPath,
              address.sessionName,
              source.id,
              record.id,
            ),
          }),
        );
      }
      if (page.nextCursor === null) break;
    }
    return { cursor: String(current), facts, missing: false };
  };
}

export function createWorkflowTerminalSourceReader(deps: WorkflowSourceDeps) {
  return async (
    recipient: SubscriptionRecipient,
    source: { id: string },
  ): Promise<TerminalSourceRead> => {
    const found = findExecution(deps, recipient, source);
    if (!found) return { kind: "missing" };
    const { execution, address } = found;
    if (!isTerminalStatus(execution.status))
      return { kind: "pending", status: execution.status };
    let cursor: number | undefined;
    for (;;) {
      const page = deps.workflowEvents.findPage(
        address.projectPath,
        address.sessionName,
        source.id,
        { limit: 500, cursor, direction: "desc" },
      );
      const record = page.records.find(
        (candidate) =>
          candidate.event.type === "graph-workflow-boundary" &&
          outcomeKinds.has(candidate.event.boundaryKind) &&
          candidate.event.workflowStatus === execution.status &&
          (execution.abandonment === null ||
            candidate.event.boundaryKind === "abandon"),
      );
      if (record)
        return {
          kind: "terminal",
          fact: projectWorkflowSourceFact({
            execution,
            record,
            result: deps.resultDeliveries.findByBoundary(
              address.projectPath,
              address.sessionName,
              source.id,
              record.id,
            ),
          }),
        };
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return {
      kind: "terminal",
      fact: {
        occurrenceId: `one-time-terminal:workflow:${source.id}`,
        eventKind: "graph-workflow-terminal",
        category: "outcome",
        sourceTitle:
          execution.launchDocument?.name ?? `Workflow ${execution.id}`,
        summary: `Workflow ${execution.status}.`,
        sourceText: stableStringify({
          evidence: "legacy-terminal-observation",
          executionId: execution.id,
          status: execution.status,
          haltReason: execution.haltReason,
          abandonment: execution.abandonment,
          limitations:
            "No exact terminal boundary was recorded; boundary-time outputs and documents are unavailable.",
        }),
        occurredAt:
          execution.abandonment?.abandonedAt ??
          execution.completedAt ??
          deps.now?.() ??
          new Date().toISOString(),
        revision: null,
        outcome: execution.status,
        retrievalHandle: `cctl workflow wait --project=${quote(projectNameFromPath(address.projectPath))} --session=${quote(address.sessionName)} -- ${quote(source.id)}`,
        actorConversationId: null,
      },
    };
  };
}
