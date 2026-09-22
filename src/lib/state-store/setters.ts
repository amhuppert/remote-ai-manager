import type {
  GraphWorkflowStorageMutation,
  GraphWorkflowStorageMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger, type Logger } from "@/lib/logging";
import { timed, timedSync } from "@/lib/logging/timed";
import {
  captureRepositoryLogs,
  releaseDeferredRepositoryLogs,
} from "@/lib/state-store/deferred-repo-logging";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { AgentCapabilityOverrides } from "@/lib/agent-capabilities/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { McpOverrides } from "@/lib/mcp/schemas";
import type { SessionMarkdownDocument } from "@/lib/documents/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowResultRecordedEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowEventDelivery,
  GraphWorkflowPushInfo,
} from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/execution-events";
import { projectGraphWorkflowBoundaryResult } from "@/lib/workflow-graph/execution-result-projection";
import type {
  GraphWorkflowExecution,
  GraphWorkflowPendingArtifacts,
  GraphWorkflowLeaseIncumbent,
  GraphWorkflowResultDelivery,
  SeededWorkflowDocument,
} from "@/lib/workflow-graph/schemas";
import {
  evaluateLeaseAdmission,
  type LeaseAdmissionDecision,
} from "@/lib/workflow-graph/lifecycle-classifier";
import { nextStructuralRevision } from "@/lib/workflow-graph/structural-revision";
import { nextSharedTicketRevision } from "./ticket-revision";

import type { GraphWorkflowArchivedExecutionRow } from "./graph-workflow-archived-executions-repo";
import type { GraphWorkflowEventRecord } from "./graph-workflow-events-repo";
import { jsonOrNull } from "./serialization";
import type { StateStoreCore } from "./schemas";
import type { CreateWorkflowNotificationInput } from "@/lib/notifications/repo";
import type { WorkflowNotification } from "@/lib/notifications/schemas";

/**
 * What an explicit archive attempt did. `guard_rejected` carries the execution
 * the guard actually saw, so the caller can report the run that really owns the
 * slot rather than the one it expected.
 */
export type GraphWorkflowArchiveOutcome =
  | {
      archived: true;
      execution: GraphWorkflowExecution;
      delivery?: GraphWorkflowEventDelivery;
    }
  | { archived: false; reason: "no_active" }
  | {
      archived: false;
      reason: "guard_rejected";
      execution: GraphWorkflowExecution;
    };

/**
 * The candidate a launch offers the lease reservation: the fully-built
 * execution and the pure event rows its installation appends. Inert DATA, not a
 * reducer — the reservation's whole point is that the ADMISSION decision
 * belongs to the serialized critical section, not to the caller, so there is
 * nothing left for a callback to decide.
 */
export interface GraphWorkflowExecutionReservation {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  pushes?: GraphWorkflowPushInfo[];
  /**
   * Caller-owned rows committed atomically with the winner's installation —
   * the native-SDD launch bridge writes its spec execution, binding snapshot,
   * and link here so a crash cannot leave a graph run without its spec
   * linkage. Runs inside the reserving transaction after the execution row is
   * installed; throwing refuses the launch and rolls everything back.
   */
  transactionAttachment?: (input: { executionId: string }) => void;
  /**
   * The launch's seeded documents WITH their contents, recorded in this same
   * transaction as the winner's outstanding-artifact record. The execution row
   * carries only registrations, and the `.cc` writes deliberately run after the
   * commit, so this is the only place the bytes a crash-time retry needs can
   * survive. A refused launch commits nothing, this record included.
   */
  seededDocuments?: readonly SeededWorkflowDocument[];
  /**
   * A caller-owned admission fact that is NOT in this row, re-checked at the
   * last possible moment: inside the reserving transaction, on the same
   * synchronous section that installs the lease. Returning admits; THROWING the
   * caller's own typed refusal declines, and the transaction commits nothing —
   * the same write-free decline as an explicit non-commit mutation decision.
   *
   * Evaluated here rather than by the caller before it awaits this seam because
   * an out-of-section check is stale by construction: whatever it read can
   * change while the reservation is queued, and the other party may then read
   * this session's lease, find it free, and proceed. Checked here, the two
   * orders are exhaustive — either the lease is committed first (and the other
   * party sees it) or the fact is registered first (and this refuses).
   *
   * Must be synchronous, pure and I/O-free (logging included): it runs on the
   * write queue, so anything slow here holds every other writer.
   */
  fence?(): void;
}

/**
 * What the authoritative reservation did. A refusal carries the classifier's
 * own refuse decision — incumbent facts plus remedy — so the caller renders the
 * standard blocker without re-reading the row it was just refused against
 * (which would be a fresh TOCTOU on the refusal path).
 *
 * `normalized` names a lease-free incumbent this reservation relocated into
 * History inside the same transaction; `null` means the row was already empty.
 * `normalizedExecution` is that same incumbent's WHOLE record, because the
 * winner's post-commit cleanup has to reach resources the summary cannot name —
 * lane worktrees for dev-server teardown, in particular. Relocating a legacy row
 * to History while its lane servers keep running beside the successor is the
 * failure this field exists to prevent.
 */
export type GraphWorkflowReservationOutcome =
  | {
      reserved: true;
      execution: GraphWorkflowExecution;
      delivery: GraphWorkflowEventDelivery;
      normalized: GraphWorkflowLeaseIncumbent | null;
      normalizedExecution: GraphWorkflowExecution | null;
    }
  | {
      reserved: false;
      refusal: Extract<LeaseAdmissionDecision, { kind: "refuse" }>;
    };

/** Audit reason for the release a launch's normalization performs (D7 R3.3). */
const NORMALIZED_ON_ADMISSION = "normalized_on_admission";

const logger = createLogger("state-store");

/**
 * Outcome a focused override-column mutator returns (project / session /
 * conversation `mcp_overrides` or `agent_capability_overrides`). `write: true`
 * persists `overrides` (or clears the column when `undefined`); `write: false`
 * commits nothing — the conflict/skip branch writes no column and touches no
 * timestamp — while still returning `result`. The mutator runs inside the write
 * queue and receives the FRESH persisted overrides, so a caller can fence
 * against a concurrent write or merge onto the latest committed value without
 * any O(total-state) read.
 */
export type FocusedOverridesMutation<TOverrides, TResult> =
  | { write: true; overrides: TOverrides | undefined; result: TResult }
  | { write: false; result: TResult };

/**
 * State-backed ancestor overrides read alongside a session's own
 * `agent_capability_overrides` inside the write queue. The capability effective
 * hash a caller fences against is derived from the whole cascade
 * (global-file → project → session), so a conflict-checked session patch must
 * fence not only its target but the state-backed ancestor (project) too — read
 * atomically here so a parent override that changed since the out-of-queue
 * precondition forces a retry instead of committing a stale hash. The
 * global-file layer is not state-backed and is fenced by the global store's own
 * write lock, so it is intentionally absent.
 */
export interface SessionCapabilityAncestors {
  project: AgentCapabilityOverrides | undefined;
}

/**
 * State-backed ancestor overrides for a session conversation's capability
 * effective hash: project and session (the conversation's own overrides are the
 * target). A conflict-checked conversation patch fences all three.
 */
export interface ConversationCapabilityAncestors {
  project: AgentCapabilityOverrides | undefined;
  session: AgentCapabilityOverrides | undefined;
}

export interface MutationFns {
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T>;
}

export function createSetters(
  core: StateStoreCore,
  mutations: MutationFns,
  // Timing logger for the focused capability setters' `state.mutate` wrapper.
  // These setters wrap `timed()` around the queue CALL (not nested inside the
  // callback), so the completion log — a synchronous `appendFileSync` in the
  // production logger — is emitted only after the write queue releases
  // (no-slow-work-in-critical-section). Injectable so the critical-section
  // ordering test can observe the emit lands after `queue:exit`; defaults to the
  // module logger in production.
  storeLogger: Logger = logger,
) {
  const { db, writeQueue, repos } = core;
  const { mutateSession } = mutations;

  function recordBoundaryResultDeliveries(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    records: readonly GraphWorkflowEventRecord[],
  ): {
    publications: GraphWorkflowSSEEvent[];
    resultEffects: NonNullable<GraphWorkflowEventDelivery["resultEffects"]>;
  } {
    if (execution.ownerConversationId === null) {
      return { publications: [], resultEffects: [] };
    }
    const publications: GraphWorkflowSSEEvent[] = [];
    const resultEffects: NonNullable<
      GraphWorkflowEventDelivery["resultEffects"]
    > = [];
    for (const record of records) {
      if (record.event.type !== "graph-workflow-boundary") continue;
      const projection = projectGraphWorkflowBoundaryResult({
        execution,
        event: record.event,
        cursor: record.id,
        occurredAt: record.occurredAt,
      });
      const inserted = repos.graphWorkflowResultDeliveries.record({
        executionId: execution.id,
        boundarySeq: record.id,
        projectPath,
        sessionName,
        originConversationId: execution.ownerConversationId,
        payload: { ...projection },
        recordedAt: record.occurredAt,
        state: "pending",
        attemptId: null,
        attemptCount: 0,
        deliveredAt: null,
        effectsDeliveredAt: null,
      });
      if (!inserted) {
        throw new Error(
          `Boundary result ${execution.id}::${record.id} already exists`,
        );
      }
      const event: GraphWorkflowResultRecordedEvent = {
        type: "graph-workflow-result-recorded",
        projectName: record.event.projectName,
        sessionName,
        executionId: execution.id,
        originConversationId: execution.ownerConversationId,
        boundaryCursor: record.id,
      };
      publications.push(event);
      resultEffects.push({ projectPath, event });
    }
    return { publications, resultEffects };
  }

  async function claimGraphWorkflowResultDeliveries(
    projectPath: string,
    sessionName: string,
    originConversationId: string,
    attemptId: string,
  ): Promise<GraphWorkflowResultDelivery[]> {
    let flushRepositoryLogs: () => void = () => {};
    let claimed: GraphWorkflowResultDelivery[];
    try {
      claimed = await writeQueue.withWriteQueueSync(
        `claimGraphWorkflowResultDeliveries[${originConversationId}]`,
        () => {
          const captured = captureRepositoryLogs(() =>
            db.transaction(() => {
              const pending =
                repos.graphWorkflowResultDeliveries.listUndeliveredForConversation(
                  projectPath,
                  sessionName,
                  originConversationId,
                );
              const rows: GraphWorkflowResultDelivery[] = [];
              for (const delivery of pending) {
                const didClaim =
                  repos.graphWorkflowResultDeliveries.markDelivering(
                    projectPath,
                    sessionName,
                    delivery.executionId,
                    delivery.boundarySeq,
                    attemptId,
                  );
                if (!didClaim) continue;
                rows.push({
                  ...delivery,
                  state: "delivering",
                  attemptId,
                  attemptCount: delivery.attemptCount + 1,
                });
              }
              return rows;
            })(),
          );
          flushRepositoryLogs = captured.flush;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      throw err;
    }
    flushRepositoryLogs();
    return claimed;
  }

  async function settleGraphWorkflowResultDeliveries(
    projectPath: string,
    sessionName: string,
    originConversationId: string,
    attemptId: string,
  ): Promise<number> {
    const deliveredAt = new Date().toISOString();
    let flushRepositoryLogs: () => void = () => {};
    let settled: number;
    try {
      settled = await writeQueue.withWriteQueueSync(
        `settleGraphWorkflowResultDeliveries[${originConversationId}]`,
        () => {
          const captured = captureRepositoryLogs(() =>
            db.transaction(() => {
              const claimed = repos.graphWorkflowResultDeliveries
                .listUndeliveredForConversation(
                  projectPath,
                  sessionName,
                  originConversationId,
                )
                .filter(
                  (delivery) =>
                    delivery.state === "delivering" &&
                    delivery.attemptId === attemptId,
                );
              let count = 0;
              for (const delivery of claimed) {
                if (
                  repos.graphWorkflowResultDeliveries.markDelivered(
                    projectPath,
                    sessionName,
                    delivery.executionId,
                    delivery.boundarySeq,
                    attemptId,
                    deliveredAt,
                  )
                ) {
                  count++;
                }
              }
              return count;
            })(),
          );
          flushRepositoryLogs = captured.flush;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      throw err;
    }
    flushRepositoryLogs();
    if (settled > 0) {
      storeLogger.info("state.workflow_result_claims_settled", {
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
        settled,
      });
    }
    return settled;
  }

  async function releaseGraphWorkflowResultDeliveries(
    projectPath: string,
    sessionName: string,
    originConversationId: string,
    attemptId: string,
  ): Promise<number> {
    const released = await writeQueue.withWriteQueueSync(
      `releaseGraphWorkflowResultDeliveries[${originConversationId}]`,
      () =>
        repos.graphWorkflowResultDeliveries.resetAttemptToPending(
          projectPath,
          sessionName,
          originConversationId,
          attemptId,
        ),
    );
    if (released > 0) {
      storeLogger.info("state.workflow_result_claims_released", {
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
        released,
      });
    }
    return released;
  }

  async function settleGraphWorkflowResultDeliveryFallback(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
  ): Promise<boolean> {
    let flushRepositoryLogs: () => void = () => {};
    let settled: boolean;
    try {
      settled = await writeQueue.withWriteQueueSync(
        `settleGraphWorkflowResultDeliveryFallback[${executionId}::${boundarySeq}]`,
        () => {
          const captured = captureRepositoryLogs(() =>
            db.transaction(() => {
              const delivery =
                repos.graphWorkflowResultDeliveries.findByBoundary(
                  projectPath,
                  sessionName,
                  executionId,
                  boundarySeq,
                );
              if (delivery === null) return false;
              return (
                repos.graphWorkflowResultDeliveries.markExecutionFallbackDelivered(
                  projectPath,
                  sessionName,
                  executionId,
                  delivery.originConversationId,
                  new Date().toISOString(),
                ) > 0
              );
            })(),
          );
          flushRepositoryLogs = captured.flush;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      throw err;
    }
    flushRepositoryLogs();
    if (settled) {
      storeLogger.info("state.workflow_result_fallback_settled", {
        projectPath,
        sessionName,
        executionId,
        boundarySeq,
      });
    }
    return settled;
  }

  async function commitGraphWorkflowMissingOriginFallback(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    notificationInput: CreateWorkflowNotificationInput,
  ): Promise<{
    notification: WorkflowNotification;
    created: boolean;
    settled: boolean;
  }> {
    let flushRepositoryLogs: () => void = () => {};
    let committed: {
      notification: WorkflowNotification;
      created: boolean;
      settled: boolean;
    };
    try {
      committed = await writeQueue.withWriteQueueSync(
        `commitGraphWorkflowMissingOriginFallback[${executionId}::${boundarySeq}]`,
        () => {
          const captured = captureRepositoryLogs(() =>
            db.transaction(() => {
              const delivery =
                repos.graphWorkflowResultDeliveries.findByBoundary(
                  projectPath,
                  sessionName,
                  executionId,
                  boundarySeq,
                );
              if (delivery === null) {
                throw new Error(
                  `Workflow result ${executionId}::${boundarySeq} was not found`,
                );
              }
              const result =
                repos.notifications.createWorkflowNotificationInTransaction(
                  notificationInput,
                );
              const settledCount =
                repos.graphWorkflowResultDeliveries.markExecutionFallbackDelivered(
                  projectPath,
                  sessionName,
                  executionId,
                  delivery.originConversationId,
                  new Date().toISOString(),
                );
              if (settledCount === 0 && delivery.state !== "delivered") {
                throw new Error(
                  `Workflow result ${executionId}::${boundarySeq} could not be settled`,
                );
              }
              return { ...result, settled: settledCount > 0 };
            })(),
          );
          flushRepositoryLogs = captured.flush;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      throw err;
    }
    flushRepositoryLogs();
    storeLogger.info("state.workflow_result_missing_origin_committed", {
      projectPath,
      sessionName,
      executionId,
      boundarySeq,
      notificationId: committed.notification.id,
      notificationCreated: committed.created,
      settled: committed.settled,
    });
    return committed;
  }

  async function markGraphWorkflowResultEffectDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
  ): Promise<boolean> {
    const marked = await writeQueue.withWriteQueueSync(
      `markGraphWorkflowResultEffectDelivered[${executionId}::${boundarySeq}]`,
      () =>
        repos.graphWorkflowResultDeliveries.markEffectsDelivered(
          projectPath,
          sessionName,
          executionId,
          boundarySeq,
          new Date().toISOString(),
        ),
    );
    if (marked) {
      storeLogger.info("state.workflow_result_effect_delivered", {
        projectPath,
        sessionName,
        executionId,
        boundarySeq,
      });
    }
    return marked;
  }

  async function recoverGraphWorkflowResultDeliveries(
    projectPath: string,
    sessionName: string,
  ): Promise<number> {
    const recovered = await writeQueue.withWriteQueueSync(
      `recoverGraphWorkflowResultDeliveries[${sessionName}]`,
      () =>
        repos.graphWorkflowResultDeliveries.resetDeliveringToPending(
          projectPath,
          sessionName,
        ),
    );
    if (recovered > 0) {
      storeLogger.info("state.workflow_result_claims_recovered", {
        projectPath,
        sessionName,
        recovered,
      });
    }
    return recovered;
  }

  /**
   * Focused session creation: insert one session row plus its initial child
   * conversations and reference documents in one transaction, ensuring the FK
   * parent project row exists first. The aggregate is never read, cloned,
   * validated, or diffed, so the write-queue hold is O(1) in total-state. The
   * caller runs the slow provisioning (git worktree add, init script) OUTSIDE
   * this critical section (no-slow-work-in-critical-section); the synchronous
   * callback makes awaiting external work while holding the lock a compile
   * error.
   */
  async function createSessionRow(
    projectPath: string,
    session: SessionState,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync(
      `createSession[${session.sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          {
            label: "createSession",
            projectPath,
            sessionName: session.sessionName,
          },
          () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.sessions.upsert(projectPath, session);
              for (const conversation of session.conversations) {
                repos.conversations.upsert(
                  projectPath,
                  session.sessionName,
                  conversation,
                );
              }
              for (const doc of session.referenceDocuments) {
                repos.referenceDocuments.upsert(
                  projectPath,
                  session.sessionName,
                  doc,
                );
              }
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Focused single-session delete (the provisioning-rollback path). Removes only
   * the target session row; the FK `ON DELETE CASCADE` removes its conversations,
   * graph-workflow execution, and reference documents at the SQL layer. Those
   * cascaded rows never route through the child repos' own `delete`, so their
   * parsed-row caches are invalidated explicitly here (O(1) version bumps).
   * Idempotent — a missing row is a no-op. Synchronous callback.
   */
  async function deleteSessionRow(
    projectPath: string,
    sessionName: string,
    label: string,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () =>
      timedSync(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        () => {
          repos.sessions.delete(projectPath, sessionName);
          repos.conversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  /**
   * Focused retarget: point every direct child of `parentSessionName` at `main`
   * and clear its parent link, via a single scoped UPDATE. Synchronous callback.
   */
  async function retargetChildrenToMain(
    projectPath: string,
    parentSessionName: string,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync("retargetChildrenToMain", () =>
      timedSync(
        logger,
        "state.mutate",
        { label: "retargetChildrenToMain", projectPath },
        () => {
          repos.sessions.retargetChildrenOfParents(projectPath, [
            parentSessionName,
          ]);
        },
      ),
    );
  }

  /**
   * Focused fused delete: retarget the children of every deleted parent and
   * delete those sessions in one transaction. The FK `ON DELETE CASCADE` removes
   * each session's conversations, graph-workflow execution, and reference
   * documents at the SQL layer, so a batch delete pays O(1) whole-state cost.
   * Those cascaded rows bypass the child repos' own `delete`, so their
   * parsed-row caches are invalidated explicitly after the commit. Idempotent —
   * names that no longer exist are skipped. Synchronous callback.
   */
  async function applyFusedSessionDelete(
    projectPath: string,
    deletedSessionNames: Iterable<string>,
    label: string,
  ): Promise<void> {
    const names = [...new Set(deletedSessionNames)];
    if (names.length === 0) return;
    return writeQueue.withWriteQueueSync(label, () =>
      timedSync(
        logger,
        "state.mutate",
        { label, projectPath, sessionCount: names.length },
        () => {
          const txn = db.transaction(() => {
            repos.sessions.retargetChildrenOfParents(projectPath, names);
            for (const name of names) {
              repos.sessions.delete(projectPath, name);
            }
          });
          txn.immediate();
          repos.conversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  const findTicketRevisionForProjectDeleteStmt = db.prepare(
    "SELECT id, updated_at FROM tickets WHERE id = ?",
  );
  const updateTicketRevisionForProjectDeleteStmt = db.prepare(
    "UPDATE tickets SET updated_at = ? WHERE id = ?",
  );

  /**
   * Focused project delete: remove the project row; the FK `ON DELETE CASCADE`
   * removes its sessions (and their conversations, graph-workflow executions, and
   * reference documents), its project conversations, and every other
   * project-scoped row. Archived/pinned membership is derived from the project
   * row, so it drops automatically. The projects repo holds no parsed-row cache,
   * and the cascaded child rows bypass their repos' own `delete`, so every
   * affected child cache is invalidated explicitly. Synchronous callback.
   */
  async function deleteProjectRow(
    projectPath: string,
    externalNeighborTicketIds: readonly string[],
    updatedAt: string,
  ): Promise<void> {
    const uniqueExternalNeighborIds = [...new Set(externalNeighborTicketIds)];
    return writeQueue.withWriteQueueSync("deleteProject", () =>
      timedSync(
        logger,
        "state.mutate",
        {
          label: "deleteProject",
          projectPath,
          externalNeighborCount: uniqueExternalNeighborIds.length,
        },
        () => {
          const transaction = db.transaction(() => {
            const survivingExternalNeighbors = uniqueExternalNeighborIds
              .map((ticketId) =>
                findTicketRevisionForProjectDeleteStmt.get(ticketId),
              )
              .filter(
                (
                  row,
                ): row is {
                  id: string;
                  updated_at: string;
                } =>
                  typeof row === "object" &&
                  row !== null &&
                  "id" in row &&
                  typeof row.id === "string" &&
                  "updated_at" in row &&
                  typeof row.updated_at === "string",
              );
            if (survivingExternalNeighbors.length > 0) {
              const revision = nextSharedTicketRevision(
                survivingExternalNeighbors.map((row) => row.updated_at),
                updatedAt,
              );
              for (const neighbor of survivingExternalNeighbors) {
                updateTicketRevisionForProjectDeleteStmt.run(
                  revision,
                  neighbor.id,
                );
              }
            }
            repos.projects.delete(projectPath);
          });
          transaction.immediate();
          repos.sessions.invalidateCache();
          repos.conversations.invalidateCache();
          repos.projectConversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  /**
   * Focused single-column mutation of a project's `mcp_overrides`. Loads only
   * the target project row inside the write queue, hands the SYNCHRONOUS
   * mutator the currently-persisted overrides, and — when the mutator elects to
   * write — persists the returned overrides (or clears the column) via the
   * repo's focused setter: no aggregate read/clone/validate/diff and no
   * O(total-state) hold. The mutator is synchronous (the sync WriteQueue entry
   * makes awaiting external work while holding the lock a compile error), so
   * callers resolve any discovery/hash I/O BEFORE calling and either compute
   * from the fresh `current` inside the mutator or fence against it.
   */
  async function mutateProjectMcpOverrides<T>(
    projectPath: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    // The callback returns the mutation OUTCOME (a plain union, never a
    // Promise), so the sync-queue guard accepts it while `result` still carries
    // the caller's arbitrary `T` back out of the critical section.
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${projectPath}]`,
      () =>
        timedSync(logger, "state.mutate", { label, projectPath }, () => {
          const project = repos.projects.findByRootPath(projectPath);
          if (!project) {
            throw new Error(`Project "${projectPath}" not found`);
          }
          const result = mutate(project.mcpOverrides);
          if (result.write) {
            repos.projects.setMcpOverrides(projectPath, result.overrides);
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a project's `agent_capability_overrides`.
   * Same focused-write rationale and synchronous-mutator contract as
   * `mutateProjectMcpOverrides`. The mutator receives the FRESH persisted
   * overrides, so the common no-conflict path can merge concurrent patches
   * atomically and the conflict-detection path can fence against a value that
   * changed since it resolved outside the lock.
   */
  async function mutateProjectAgentCapabilityOverrides<T>(
    projectPath: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback: its completion log is a
    // synchronous `appendFileSync` in the production logger, so nesting it
    // inside the callback would emit it with the write lock held
    // (no-slow-work-in-critical-section). Awaiting the queue defers the emit
    // until after the critical section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${projectPath}]`, () => {
          const project = repos.projects.findByRootPath(projectPath);
          if (!project) {
            throw new Error(`Project "${projectPath}" not found`);
          }
          const result = mutate(project.agentCapabilityOverrides);
          if (result.write) {
            repos.projects.setAgentCapabilityOverrides(
              projectPath,
              result.overrides,
            );
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session's `mcp_overrides`. Loads only
   * the target session row inside the write queue, hands the SYNCHRONOUS mutator
   * the currently-persisted overrides, and — when the mutator writes — updates
   * only the `mcp_overrides` column via the focused per-column setter, leaving
   * every sibling column and `last_activity_at` untouched (an override edit is a
   * config change, not activity). `write: false` (conflict/skip) writes nothing.
   * Callers resolve any discovery/hash I/O BEFORE calling and either compute
   * from the fresh `current` inside the mutator or fence against it.
   */
  async function mutateSessionMcpOverrides<T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          { label, projectPath, sessionName },
          () => {
            const session = repos.sessions.findByKey(projectPath, sessionName);
            if (!session) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}"`,
              );
            }
            const result = mutate(session.mcpOverrides);
            if (result.write) {
              repos.sessions.updateChangedColumns(projectPath, sessionName, {
                mcp_overrides: jsonOrNull(result.overrides),
              });
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a conversation's `mcp_overrides`. Loads
   * only the target conversation row inside the write queue, hands the
   * SYNCHRONOUS mutator the currently-persisted overrides, and — when the mutator
   * writes — updates only the `mcp_overrides` column via the no-touch per-column
   * setter, leaving every sibling column, the conversation's own
   * `last_activity_at`, and the owning session's activity untouched (an override
   * edit is a config change, not activity, and must not reorder conversations).
   * `write: false` (conflict/skip) writes nothing. Callers resolve any
   * discovery/hash I/O BEFORE calling and either compute from the fresh
   * `current` inside the mutator or fence against it.
   */
  async function mutateConversationMcpOverrides<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          { label, projectPath, sessionName, conversationId },
          () => {
            const conversation = isProjectSentinel(sessionName)
              ? repos.projectConversations.findByKey(
                  projectPath,
                  conversationId,
                )
              : repos.conversations.findByKey(
                  projectPath,
                  sessionName,
                  conversationId,
                );
            if (!conversation) {
              throw new Error(
                `Conversation "${conversationId}" not found in session "${sessionName}"`,
              );
            }
            const result = mutate(conversation.mcpOverrides);
            if (result.write) {
              if (isProjectSentinel(sessionName)) {
                repos.projectConversations.setMcpOverrides(
                  projectPath,
                  conversationId,
                  result.overrides,
                );
              } else {
                repos.conversations.updateChangedColumns(
                  projectPath,
                  sessionName,
                  conversationId,
                  { mcp_overrides: jsonOrNull(result.overrides) },
                );
              }
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session's `agent_capability_overrides`.
   * The synchronous mutator receives the FRESH persisted target overrides plus
   * the state-backed ancestor (project) overrides — both read atomically inside
   * the write queue — so a conflict-checked caller can fence the target AND the
   * ancestor the effective hash depends on. `write: true` persists only the
   * `agent_capability_overrides` column (siblings and `last_activity_at`
   * untouched — an override edit is config, not activity); `write: false`
   * (conflict/skip) writes nothing, so a raced conflict cannot restamp activity.
   * Callers resolve the expected-hash precondition BEFORE calling (its discovery
   * + whole-chain I/O must not run in the critical section).
   */
  async function mutateSessionAgentCapabilityOverrides<T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: SessionCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, sessionName },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}"`,
            );
          }
          const project = repos.projects.findByRootPath(projectPath);
          const result = mutate(session.agentCapabilityOverrides, {
            project: project?.agentCapabilityOverrides,
          });
          if (result.write) {
            repos.sessions.updateChangedColumns(projectPath, sessionName, {
              agent_capability_overrides: jsonOrNull(result.overrides),
            });
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session conversation's
   * `agent_capability_overrides`. Same contract as
   * `mutateSessionAgentCapabilityOverrides`, with the conversation as target and
   * project + session read as the state-backed ancestors the effective hash
   * depends on. Writes only the `agent_capability_overrides` column via the
   * no-touch per-column setter, so neither the conversation's own
   * `last_activity_at` nor the owning session's activity moves.
   */
  async function mutateConversationAgentCapabilityOverrides<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: ConversationCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, sessionName, conversationId },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () => {
          const conversation = repos.conversations.findByKey(
            projectPath,
            sessionName,
            conversationId,
          );
          if (!conversation) {
            throw new Error(
              `Conversation "${conversationId}" not found in session "${sessionName}"`,
            );
          }
          const session = repos.sessions.findByKey(projectPath, sessionName);
          const project = repos.projects.findByRootPath(projectPath);
          const result = mutate(conversation.agentCapabilityOverrides, {
            project: project?.agentCapabilityOverrides,
            session: session?.agentCapabilityOverrides,
          });
          if (result.write) {
            repos.conversations.updateChangedColumns(
              projectPath,
              sessionName,
              conversationId,
              { agent_capability_overrides: jsonOrNull(result.overrides) },
            );
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session-less project conversation's
   * `agent_capability_overrides`. The project-conversation cascade skips the
   * session layer, so only the project ancestor is fenced. Writes only the
   * `agent_capability_overrides` column via the project-conversation repo's
   * no-touch focused setter, so the PLC's `last_activity_at` is never restamped
   * by a config edit.
   */
  async function mutateProjectConversationAgentCapabilityOverrides<T>(
    projectPath: string,
    conversationId: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: SessionCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, conversationId },
      () =>
        writeQueue.withWriteQueueSync(
          `${label}[project::${conversationId}]`,
          () => {
            const conversation = repos.projectConversations.findByKey(
              projectPath,
              conversationId,
            );
            if (!conversation) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
            const project = repos.projects.findByRootPath(projectPath);
            const result = mutate(conversation.agentCapabilityOverrides, {
              project: project?.agentCapabilityOverrides,
            });
            if (result.write) {
              repos.projectConversations.setAgentCapabilityOverrides(
                projectPath,
                conversationId,
                result.overrides,
              );
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  async function setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionArchived",
      (session) => {
        session.archived = archived;
      },
    );
  }

  async function setSessionTddEnabled(
    projectPath: string,
    sessionName: string,
    tddEnabled: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionTddEnabled",
      (session) => {
        session.tddEnabled = tddEnabled;
      },
    );
  }

  async function setSessionFinished(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionFinished",
      (session) => {
        session.finished = true;
        session.archived = true;
      },
    );
  }

  async function setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    if (isProjectSentinel(sessionName)) {
      return setProjectConversationPendingPromptText(
        projectPath,
        conversationId,
        text,
      );
    }
    return writeQueue.withWriteQueue(
      `setConversationPendingPromptText[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setConversationPendingPromptText",
            projectPath,
            sessionName,
            conversationId,
          },
          async () => {
            const updated = repos.conversations.setPendingPromptText(
              projectPath,
              sessionName,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Conversation "${conversationId}" not found in session "${sessionName}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationPendingPromptText(
    projectPath: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationPendingPromptText[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationPendingPromptText",
            projectPath,
            conversationId,
          },
          async () => {
            const updated = repos.projectConversations.setPendingPromptText(
              projectPath,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function createProjectConversation(
    projectPath: string,
    conversation: ConversationState,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `createProjectConversation[${conversation.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "createProjectConversation",
            projectPath,
            conversationId: conversation.id,
          },
          async () => {
            // project_conversations has an FK to projects(root_path). A freshly
            // configured repo with no prior session/pin/archive state has no
            // projects row yet, so ensure one exists before the insert.
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projectConversations.upsert(projectPath, conversation);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationArchived[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationArchived",
            projectPath,
            conversationId,
            archived,
          },
          async () => {
            const updated = repos.projectConversations.setArchived(
              projectPath,
              conversationId,
              archived,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationOpen[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationOpen",
            projectPath,
            conversationId,
            open,
          },
          async () => {
            const updated = repos.projectConversations.setOpen(
              projectPath,
              conversationId,
              open,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectArchived(
    projectPath: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectArchived[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectArchived", projectPath, archived },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setArchived(projectPath, archived);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectPinned(
    projectPath: string,
    pinned: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectPinned[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectPinned", projectPath, pinned },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setPinned(projectPath, pinned);
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Tag a session with its `from chat` origin. One-time focused single-column
   * write at chat-spawn creation (Pattern 2: no whole-state read / no
   * per-keystroke mutate*).
   */
  async function setSessionSpawnedFrom(
    projectPath: string,
    sessionName: string,
    spawnedFrom: SpawnedFrom,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setSessionSpawnedFrom[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setSessionSpawnedFrom", projectPath, sessionName },
          async () => {
            const updated = repos.sessions.setSpawnedFrom(
              projectPath,
              sessionName,
              spawnedFrom,
            );
            if (!updated) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Append spawned session names to a project conversation's back-link. Batched
   * single-row append performed once after the spawn-create loop (Pattern 2).
   */
  async function addPlcSpawnedSessionIds(
    projectPath: string,
    conversationId: string,
    sessionNames: string[],
  ): Promise<void> {
    if (sessionNames.length === 0) return;
    return writeQueue.withWriteQueue(
      `addPlcSpawnedSessionIds[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "addPlcSpawnedSessionIds", projectPath, conversationId },
          async () => {
            const updated = repos.projectConversations.appendSpawnedSessionIds(
              projectPath,
              conversationId,
              sessionNames,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Atomically write the active graph-workflow execution blob (history-free)
   * and append its computed append-only event rows to `graph_workflow_events`,
   * inside a single write-queue critical section. The mutator receives the
   * currently-persisted execution and returns the next execution, the event rows
   * to append, and optional pure push descriptors — inert DATA, never a
   * callable, so the reducer cannot broadcast.
   *
   * This seam performs NO external delivery and NO logging inside the critical
   * section: the queue callback is limited to repo writes and pure computation
   * (`no-slow-work-in-critical-section`). It returns the committed execution and
   * the delivery DATA (rows whose inner SSE events must be broadcast + the push
   * descriptors); the graph-workflow repository — which owns the broadcaster and
   * push dispatcher — performs delivery only AFTER this resolves, i.e. after
   * `txn.immediate()` has committed (Design 3.2, `post-commit-delivery`). A
   * thrown commit rejects here with nothing delivered, so a mutation that did
   * not persist can never have told a client it did. The `state.mutate` timing
   * is measured with a pure clock read inside the lock but emitted afterward.
   */
  async function mutateActiveGraphWorkflowExecution<Value = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: GraphWorkflowExecution | null,
    ) => GraphWorkflowStorageMutation<Value>,
  ): Promise<GraphWorkflowStorageMutationOutcome<Value>> {
    let committed: GraphWorkflowStorageMutationOutcome<Value>;
    let holdMs = 0;
    let flushRepositoryLogs: () => void = () => {};
    try {
      committed = await writeQueue.withWriteQueueSync(
        `${label}[${sessionName}]`,
        () => {
          const startedAt = Date.now();
          const captured = captureRepositoryLogs(() =>
            db
              .transaction(() => {
                const session = repos.sessions.findByKey(
                  projectPath,
                  sessionName,
                );
                if (!session) {
                  throw new Error(
                    `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
                  );
                }
                const current = repos.graphWorkflowExecutions.getActive(
                  projectPath,
                  sessionName,
                );
                const decision = mutate(current);
                if (decision.kind === "no_commit")
                  return {
                    kind: "not_committed" as const,
                    execution: current,
                    value: decision.value,
                  };
                const { execution: reduced, events, pushes } = decision;
                // Stamp the structural fence HERE, at the durable-write boundary,
                // not only at the execution-repository seam above it. `setActive`
                // skips rewriting `definition_json` whenever this revision has not
                // moved, so a reducer that edits the graph without advancing it
                // would have its edit silently dropped on the floor. Deriving it
                // from the values makes that impossible for every caller of this
                // API, including the ones that never went through the seam.
                // Idempotent: the seam derives the same number from the same
                // `current`, so a commit that already carries it re-derives it
                // unchanged.
                const execution =
                  current === null
                    ? reduced
                    : {
                        ...reduced,
                        executionStateRevision:
                          current.executionStateRevision + 1,
                        structuralRevision: nextStructuralRevision(
                          current,
                          reduced,
                        ),
                      };
                const now = new Date().toISOString();
                let publications: GraphWorkflowSSEEvent[] = [];
                let resultEffects: NonNullable<
                  GraphWorkflowEventDelivery["resultEffects"]
                > = [];
                for (const contextId of decision.preResetContextIds ?? []) {
                  repos.graphWorkflowEvents.markPreReset(
                    projectPath,
                    sessionName,
                    execution.id,
                    contextId,
                    Number.MAX_SAFE_INTEGER,
                  );
                }
                repos.graphWorkflowExecutions.setActive(
                  projectPath,
                  sessionName,
                  execution,
                  now,
                );
                const eventRecords = repos.graphWorkflowEvents.appendMany(
                  projectPath,
                  sessionName,
                  execution.id,
                  now,
                  events,
                );
                ({ publications, resultEffects } =
                  recordBoundaryResultDeliveries(
                    projectPath,
                    sessionName,
                    execution,
                    eventRecords,
                  ));
                return {
                  kind: "committed" as const,
                  value: decision.value,
                  execution,
                  delivery: {
                    events,
                    pushes: pushes ?? [],
                    publications,
                    resultEffects,
                  },
                };
              })
              .immediate(),
          );
          flushRepositoryLogs = captured.flush;
          holdMs = Date.now() - startedAt;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      logger.warn("state.mutate.error", {
        label,
        projectPath,
        sessionName,
        error: err instanceof Error ? err : String(err),
      });
      throw err;
    }
    flushRepositoryLogs();
    // Emitted post-critical-section so the queue callback itself does no I/O.
    logger.info("state.mutate.complete", {
      label,
      projectPath,
      sessionName,
      durationMs: holdMs,
    });
    return committed;
  }

  /**
   * THE authoritative lease reservation (D7 R3.1-R3.5, R5.2): the first — and,
   * on a refusal, the only — thing a launch does. It reads the incumbent inside
   * the write-queue critical section, decides admission with the one shared
   * `evaluateLeaseAdmission`, and either commits the winner or returns a
   * write-free refusal.
   *
   * Reserving BEFORE any out-of-row materialization is the point. Building the
   * charter and seeded documents first (as the launch path did) let a losing
   * concurrent racer write files into `.cc` and then lose, leaving artifacts
   * behind and possibly overwriting the winner's — a partial record that no row
   * inventory would catch. Here a loser touches nothing at all.
   *
   * Normalization of a lease-free incumbent rides the SAME transaction as the
   * winner's installation. Split across two commits it would be possible to
   * observe a session with neither run: the relocation and the replacement are
   * one state change, so they are one transaction.
   */
  async function reserveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    reservation: GraphWorkflowExecutionReservation,
  ): Promise<GraphWorkflowReservationOutcome> {
    let committed: GraphWorkflowReservationOutcome | undefined;
    let holdMs = 0;
    let flushRepositoryLogs: () => void = () => {};
    function runReservationTransaction(): GraphWorkflowReservationOutcome {
      // The incumbent read, the admission decision, the normalization and the
      // winner's installation ALL run inside one immediate transaction.
      // Deciding admission outside it and only writing inside would leave a
      // window where two connections both read a free lease, both decide admit,
      // and then install different winners in sequence — two callers each told
      // they won, each free to materialize. The in-process write queue
      // serializes only THIS process's callers, while the lease is a claim about
      // the database, so the compare and the swap have to hold at the database.
      // `BEGIN IMMEDIATE` takes the write lock up front, so a second connection
      // blocks here and reads the winner's row rather than the emptiness that
      // preceded it.
      const txn = db.transaction((): GraphWorkflowReservationOutcome => {
        // Deliberately the AUTHORITATIVE read, not the cached one. Holding the
        // write lock only guarantees that nobody writes while we decide; it
        // guarantees nothing about what this connection last saw. The advisory
        // read a launch performs before getting here caches "no incumbent", so a
        // cached read inside the lock would decide against a snapshot taken
        // before the winner existed.
        const incumbent = repos.graphWorkflowExecutions.getActiveAuthoritative(
          projectPath,
          sessionName,
        );
        const admission = evaluateLeaseAdmission(incumbent);
        if (admission.kind === "refuse") {
          return { reserved: false, refusal: admission };
        }
        // After the lease question, before any write: a lease holder reports the
        // more specific refusal, and a fenced launch still normalizes nothing.
        reservation.fence?.();

        const now = new Date().toISOString();
        // A normalization decision implies a non-null incumbent, but only the
        // row itself proves it to the type system.
        const normalizedRow =
          admission.kind === "admit-with-normalization" && incumbent !== null
            ? incumbent
            : null;
        const normalizedEvents: GraphWorkflowExecutionEvent[] = [];
        if (normalizedRow !== null) {
          normalizedEvents.push({
            occurredAt: now,
            preReset: false,
            event: {
              type: "graph-workflow-execution-released",
              projectName: path.basename(projectPath),
              sessionName,
              executionId: normalizedRow.id,
              status: normalizedRow.status,
              reason: NORMALIZED_ON_ADMISSION,
              actor: null,
            },
          });
          repos.graphWorkflowEvents.appendMany(
            projectPath,
            sessionName,
            normalizedRow.id,
            now,
            normalizedEvents,
          );
          repos.graphWorkflowArchivedExecutions.insert({
            projectPath,
            sessionName,
            executionId: normalizedRow.id,
            archivedAt: now,
            status: normalizedRow.status,
            startedAt: normalizedRow.startedAt,
            completedAt: normalizedRow.completedAt,
            execution: normalizedRow,
          });
        }
        repos.graphWorkflowExecutions.setActive(
          projectPath,
          sessionName,
          reservation.execution,
          now,
        );
        const eventRecords = repos.graphWorkflowEvents.appendMany(
          projectPath,
          sessionName,
          reservation.execution.id,
          now,
          reservation.events,
        );
        const { publications, resultEffects } = recordBoundaryResultDeliveries(
          projectPath,
          sessionName,
          reservation.execution,
          eventRecords,
        );
        // Committed with the row it belongs to, and only for the winner: the
        // artifacts this launch still owes the filesystem, contents included. A
        // crash after this commit is exactly the case the record exists for, and
        // a rolled-back loser takes it with it.
        repos.graphWorkflowPendingArtifacts.record({
          executionId: reservation.execution.id,
          projectPath,
          sessionName,
          documents: [...(reservation.seededDocuments ?? [])],
          recordedAt: now,
        });
        reservation.transactionAttachment?.({
          executionId: reservation.execution.id,
        });
        return {
          reserved: true,
          execution: reservation.execution,
          delivery: {
            events: [...normalizedEvents, ...reservation.events],
            pushes: reservation.pushes ?? [],
            publications,
            resultEffects,
          },
          normalized:
            admission.kind === "admit-with-normalization"
              ? admission.incumbent
              : null,
          normalizedExecution: normalizedRow,
        };
      });
      return txn.immediate();
    }

    try {
      committed = await writeQueue.withWriteQueueSync(
        `${label}[${sessionName}]`,
        () => {
          const startedAt = Date.now();
          // The capture opens around the WHOLE section, not just the
          // transaction. Every repository called here logs its own per-operation
          // timing, and `createLogger` appends to disk synchronously — including
          // the session lookup below, which runs while this section holds the
          // write queue but before `BEGIN IMMEDIATE`, so a transaction-scoped
          // capture would step right over it. The queued lines are emitted after
          // the callback returns.
          const captured = captureRepositoryLogs(() => {
            const session = repos.sessions.findByKey(projectPath, sessionName);
            if (!session) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
              );
            }
            return runReservationTransaction();
          });
          flushRepositoryLogs = captured.flush;
          holdMs = Date.now() - startedAt;
          return captured.value;
        },
      );
    } catch (err) {
      // The failing operation's own timing is the most useful line here, and a
      // capture whose section threw never handed back a flush.
      releaseDeferredRepositoryLogs();
      logger.warn("state.mutate.error", {
        label,
        projectPath,
        sessionName,
        error: err instanceof Error ? err : String(err),
      });
      throw err;
    }

    flushRepositoryLogs();
    // Emitted post-critical-section so the queue callback itself does no I/O.
    if (committed.reserved) {
      logger.info("graph-workflow.execution.lease_reserved", {
        label,
        projectPath,
        sessionName,
        executionId: committed.execution.id,
        normalizedExecutionId: committed.normalized?.executionId ?? null,
        durationMs: holdMs,
      });
    } else {
      logger.info("graph-workflow.execution.lease_refused", {
        label,
        projectPath,
        sessionName,
        attemptedExecutionId: reservation.execution.id,
        activeExecutionId: committed.refusal.incumbent.executionId,
        activeStatus: committed.refusal.incumbent.status,
        remedy: committed.refusal.remedy,
        durationMs: holdMs,
      });
    }
    return committed;
  }

  /**
   * Settle only the reconstruction record whose bytes reached disk. A later
   * record for the same execution must survive an older publisher finishing.
   */
  async function clearGraphWorkflowPendingArtifacts(
    expected: GraphWorkflowPendingArtifacts,
    owner: Pick<GraphWorkflowExecution, "loopEpoch" | "status">,
  ): Promise<boolean> {
    const cleared = await writeQueue.withWriteQueueSync(
      `graphWorkflowPendingArtifacts.clear[${expected.executionId}]`,
      () => repos.graphWorkflowPendingArtifacts.clear(expected, owner),
    );
    logger.debug("graph-workflow.artifacts.debt_settled", {
      executionId: expected.executionId,
      cleared,
      recordedAt: expected.recordedAt,
      loopEpoch: owner.loopEpoch,
      status: owner.status,
    });
    return cleared;
  }

  /**
   * Move the active graph-workflow execution into the archived-executions table
   * (control-state only; its events stay in `graph_workflow_events` keyed by the
   * same execution id) and null the active blob, inside one write-queue section.
   */
  /**
   * `audit` records the explicit archive act. It is appended inside the SAME
   * transaction that moves the execution out of the active slot: releasing IS
   * the state change, so a release whose audit row could be lost separately
   * would leave no durable answer to "who released this session's run".
   *
   * `stamp` is the record change the release itself decides — the abandonment
   * audit, in particular. It runs inside the same transaction for the same
   * reason: a stamp committed in a write of its own is a lifecycle boundary
   * with no delivery record, and one that has already released the lease, so a
   * concurrent launch can normalize the row out from under the relocation this
   * caller is about to attempt and still be told the act succeeded.
   *
   * The deciding READ is inside that transaction too, and it is the
   * authoritative one. The write queue serializes only this process's callers,
   * while eligibility here is a claim about the database: another connection
   * can resume the halted run this caller means to abandon, and a decision
   * taken from what this connection last parsed would archive a snapshot that
   * no longer exists and delete the successor's row on the way out. Read,
   * guard, stamp, audit, insert, and clear therefore share one
   * `BEGIN IMMEDIATE` — the same structure the lease CAS uses, for the same
   * reason.
   */
  async function archiveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
    stamp?: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowArchiveOutcome> {
    const label = "archiveGraphWorkflowExecution";
    let holdMs = 0;
    let flushRepositoryLogs: () => void = () => {};
    let outcome: GraphWorkflowArchiveOutcome;
    try {
      outcome = await writeQueue.withWriteQueueSync(
        `${label}[${sessionName}]`,
        () => {
          const startedAt = Date.now();
          const captured = captureRepositoryLogs(() => {
            const txn = db.transaction((): GraphWorkflowArchiveOutcome => {
              // Deliberately the AUTHORITATIVE read: holding the write lock
              // stops anyone from writing while we decide, and says nothing
              // about what this connection last saw. Every caller of this seam
              // has already read the row advisorily to decide it wants to
              // archive, so a cached read in here would re-answer from that
              // very snapshot.
              const execution =
                repos.graphWorkflowExecutions.getActiveAuthoritative(
                  projectPath,
                  sessionName,
                );
              if (!execution) return { archived: false, reason: "no_active" };
              // The caller's expected-id and lifecycle-eligibility test is
              // re-applied HERE, against the row as it is right now. Checking
              // before the lock is a TOCTOU: a concurrent resume can turn an
              // eligible `paused` run into `running`, and a concurrent start
              // can install a different execution, either of which the stale
              // decision would then archive. The guard is pure by contract, so
              // it is legal in here.
              if (guard !== undefined && !guard(execution)) {
                return { archived: false, reason: "guard_rejected", execution };
              }
              // Applied to the row the guard just admitted, so the record that
              // lands in History is the one the act decided on. Pure by
              // contract, like the guard above.
              const released =
                stamp === undefined ? execution : stamp(execution);
              const now = new Date().toISOString();
              const row: GraphWorkflowArchivedExecutionRow = {
                projectPath,
                sessionName,
                executionId: released.id,
                archivedAt: now,
                status: released.status,
                startedAt: released.startedAt,
                completedAt: released.completedAt,
                execution: released,
              };
              const archiveEvents: GraphWorkflowExecutionEvent[] = [];
              if (audit !== undefined) {
                archiveEvents.push({
                  occurredAt: now,
                  preReset: false,
                  event: {
                    type: "graph-workflow-execution-released",
                    projectName: path.basename(projectPath),
                    sessionName,
                    executionId: released.id,
                    status: released.status,
                    reason: audit.reason,
                    actor: audit.actor,
                  },
                });
              }
              if (
                execution.abandonment === null &&
                released.abandonment !== null
              ) {
                const event: GraphWorkflowSSEEvent =
                  createGraphWorkflowBoundaryEvent({
                    projectPath,
                    sessionName,
                    execution: released,
                    boundaryKind: "abandon",
                  });
                archiveEvents.push({
                  occurredAt: now,
                  preReset: false,
                  event,
                });
              }
              const eventRecords = repos.graphWorkflowEvents.appendMany(
                projectPath,
                sessionName,
                released.id,
                now,
                archiveEvents,
              );
              const { publications, resultEffects } =
                recordBoundaryResultDeliveries(
                  projectPath,
                  sessionName,
                  released,
                  eventRecords,
                );
              repos.graphWorkflowArchivedExecutions.insert(row);
              repos.graphWorkflowExecutions.setActive(
                projectPath,
                sessionName,
                null,
                now,
              );
              return {
                archived: true,
                execution: released,
                delivery: {
                  events: archiveEvents,
                  pushes: [],
                  publications,
                  resultEffects,
                },
              };
            });
            return txn.immediate();
          });
          flushRepositoryLogs = captured.flush;
          holdMs = Date.now() - startedAt;
          return captured.value;
        },
      );
    } catch (err) {
      releaseDeferredRepositoryLogs();
      logger.warn("state.mutate.error", {
        label,
        projectPath,
        sessionName,
        error: err instanceof Error ? err : String(err),
      });
      throw err;
    }
    flushRepositoryLogs();
    logger.info("state.mutate.complete", {
      label,
      projectPath,
      sessionName,
      durationMs: holdMs,
    });
    return outcome;
  }

  /**
   * Focused single-column write of the session's `workflow_lanes` map. Loads
   * only the target session, hands the mutator the existing lane map (mutated
   * in place), and persists via the repo's focused setter — skipping the
   * whole-state read / clone / Zod-validate / sibling-canonicalize cycle that
   * `mutateSession` runs and the full-row re-serialization of every other
   * session column (including the large `graph_workflow_execution` blob). Stays
   * inside the write queue so concurrent same-session writes serialize.
   */
  async function mutateSessionWorkflowLanes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (lanes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const lanes = session.workflowLanes ?? {};
          const result = await mutate(lanes);
          repos.sessions.setSessionWorkflowLanes(
            projectPath,
            sessionName,
            lanes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  /**
   * Focused single-column write of the session's `workflow_envelopes` map.
   * Same focused-write rationale as `mutateSessionWorkflowLanes`.
   */
  async function mutateSessionWorkflowEnvelopes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (envelopes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const envelopes = session.workflowEnvelopes ?? {};
          const result = await mutate(envelopes);
          repos.sessions.setSessionWorkflowEnvelopes(
            projectPath,
            sessionName,
            envelopes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  async function createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument> {
    return mutateSession<ReferenceDocument>(
      projectPath,
      sessionName,
      "createReferenceDocument",
      (session) => {
        const existing = session.referenceDocuments.find(
          (d) => d.filePath === filePath,
        );
        if (existing) {
          existing.description = description;
          // Return a plain snapshot, not the draft element: the focused mutate
          // path finalizes the draft after the mutator returns, revoking every
          // draft proxy — including this one — so returning it directly would
          // throw on first access by the caller.
          return {
            id: existing.id,
            filePath: existing.filePath,
            description: existing.description,
            createdAt: existing.createdAt,
          };
        }
        const doc: ReferenceDocument = {
          id: randomUUID(),
          filePath,
          description,
          createdAt: new Date().toISOString(),
        };
        session.referenceDocuments.push(doc);
        return doc;
      },
    );
  }

  async function deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null> {
    return mutateSession<ReferenceDocument | null>(
      projectPath,
      sessionName,
      "deleteReferenceDocument",
      (session) => {
        const index = session.referenceDocuments.findIndex(
          (d) => d.id === documentId,
        );
        if (index === -1) return null;
        const removed = session.referenceDocuments[index]!;
        // Snapshot into a plain object before splicing: the focused mutate path
        // runs the mutator against an Immer draft, and a spliced-off element is
        // not part of the finalized `next`, so its proxy is revoked when the
        // draft finishes — returning it directly would throw on first access.
        const snapshot: ReferenceDocument = {
          id: removed.id,
          filePath: removed.filePath,
          description: removed.description,
          createdAt: removed.createdAt,
        };
        session.referenceDocuments.splice(index, 1);
        return snapshot;
      },
    );
  }

  async function upsertSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
    documents: readonly SessionMarkdownDocument[],
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertSessionMarkdownDocuments[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertSessionMarkdownDocuments",
            projectPath,
            sessionName,
            documentCount: documents.length,
          },
          async () => {
            repos.sessionMarkdownDocuments.upsertMany(
              projectPath,
              sessionName,
              documents,
            );
          },
        ),
    );
  }

  /** Upsert a document comment through the serialized write queue. */
  async function upsertDocumentComment(
    comment: DocumentComment,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertDocumentComment[${comment.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertDocumentComment",
            projectPath: comment.projectPath,
            sessionName: comment.sessionName,
          },
          async () => {
            repos.documentComments.upsert(comment);
          },
        ),
    );
  }

  async function deleteDocumentComment(id: string): Promise<void> {
    return writeQueue.withWriteQueue(`deleteDocumentComment[${id}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label: "deleteDocumentComment", id },
        async () => {
          repos.documentComments.delete(id);
        },
      ),
    );
  }

  return {
    createSessionRow,
    deleteSessionRow,
    retargetChildrenToMain,
    applyFusedSessionDelete,
    deleteProjectRow,
    mutateProjectMcpOverrides,
    mutateProjectAgentCapabilityOverrides,
    mutateSessionMcpOverrides,
    mutateConversationMcpOverrides,
    mutateSessionAgentCapabilityOverrides,
    mutateConversationAgentCapabilityOverrides,
    mutateProjectConversationAgentCapabilityOverrides,
    setSessionArchived,
    setSessionTddEnabled,
    setSessionFinished,
    setConversationPendingPromptText,
    createProjectConversation,
    setProjectConversationPendingPromptText,
    setProjectConversationArchived,
    setProjectConversationOpen,
    setProjectArchived,
    setProjectPinned,
    setSessionSpawnedFrom,
    addPlcSpawnedSessionIds,
    mutateActiveGraphWorkflowExecution,
    reserveActiveGraphWorkflowExecution,
    clearGraphWorkflowPendingArtifacts,
    archiveActiveGraphWorkflowExecution,

    mutateSessionWorkflowLanes,
    mutateSessionWorkflowEnvelopes,
    claimGraphWorkflowResultDeliveries,
    settleGraphWorkflowResultDeliveries,
    releaseGraphWorkflowResultDeliveries,
    settleGraphWorkflowResultDeliveryFallback,
    commitGraphWorkflowMissingOriginFallback,
    markGraphWorkflowResultEffectDelivered,
    recoverGraphWorkflowResultDeliveries,
    createReferenceDocument,
    deleteReferenceDocument,
    upsertSessionMarkdownDocuments,
    upsertDocumentComment,
    deleteDocumentComment,
  };
}
