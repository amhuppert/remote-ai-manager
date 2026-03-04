/**
 * Reusable XState action library for workflow machines.
 *
 * All actions use the XState v5 named-actions-with-params pattern so they
 * can be provided/overridden via machine.provide() in tests.
 *
 * Usage in setup():
 *   setup({
 *     actions: workflowActions,
 *     ...
 *   })
 *
 * Usage in machine config:
 *   entry: {
 *     type: 'broadcastStatus',
 *     params: ({ context }) => ({ ... }),
 *   }
 */

import type {
  SSEEvent,
  WorkflowStatus,
  HaltReason,
  FixPlanTask,
} from "@/types";
import type { RalphLoopIterationMeta, CircuitBreakerState } from "@/types";

// ============================================================
// Action parameter types
// ============================================================

export interface BroadcastStatusParams {
  projectName: string;
  sessionName: string;
  workflowStatus: WorkflowStatus;
  iterationCount: number;
  maxIterations: number;
  taskProgress: {
    total: number;
    completed: number;
    skipped: number;
    pending: number;
  };
  haltReason: HaltReason | null;
}

export interface BroadcastIterationCompleteParams {
  projectName: string;
  sessionName: string;
  iteration: RalphLoopIterationMeta;
}

export interface BroadcastFixPlanUpdatedParams {
  projectName: string;
  sessionName: string;
  fixPlan: FixPlanTask[];
  source: "tool" | "user";
}

export interface BroadcastCircuitBreakerParams {
  projectName: string;
  sessionName: string;
  circuitBreaker: CircuitBreakerState;
}

export interface PersistSnapshotParams {
  projectPath: string;
  sessionName: string;
  snapshot: unknown;
  immediate?: boolean;
}

export interface CreateNotificationParams {
  type:
    | "merge-completed"
    | "merge-failed"
    | "merge-conflicts"
    | "commit-completed"
    | "commit-failed"
    | "resolve-completed"
    | "resolve-failed";
  title: string;
  message: string;
  projectName: string;
  sessionName: string;
  branchName: string;
  jobId: string;
  jobType: "commit" | "merge" | "resolve-conflicts";
  errorMessage?: string;
}

// ============================================================
// Dependencies (injected for testability)
// ============================================================

export interface WorkflowActionDeps {
  broadcast: (event: SSEEvent) => void;
  persistSnapshot: (
    projectPath: string,
    sessionName: string,
    snapshot: unknown,
    options?: { immediate?: boolean },
  ) => void;
  createNotification: (input: CreateNotificationParams) => void;
}

// Default production dependencies (lazily loaded to avoid circular imports)
let _deps: WorkflowActionDeps | null = null;

function getDefaultDeps(): WorkflowActionDeps {
  if (!_deps) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sseBroadcaster = require("@/lib/sse-broadcaster");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const persistence = require("@/lib/workflows/persistence");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notificationDb = require("@/lib/notification-db");

    _deps = {
      broadcast: sseBroadcaster.broadcast,
      persistSnapshot: persistence.persistWorkflowSnapshot,
      createNotification: notificationDb.createNotification,
    };
  }
  return _deps;
}

/** Override dependencies (for testing). */
export function setActionDeps(deps: WorkflowActionDeps): void {
  _deps = deps;
}

/** Reset to default dependencies. */
export function _resetDepsForTesting(): void {
  _deps = null;
}

// ============================================================
// Named actions (for use in setup({ actions: ... }))
// ============================================================

/**
 * Broadcast a workflow-status SSE event.
 */
export function broadcastStatus(
  _actionContext: unknown,
  params: BroadcastStatusParams,
): void {
  getDefaultDeps().broadcast({
    type: "workflow-status",
    ...params,
  });
}

/**
 * Broadcast a workflow-iteration-complete SSE event.
 */
export function broadcastIterationComplete(
  _actionContext: unknown,
  params: BroadcastIterationCompleteParams,
): void {
  getDefaultDeps().broadcast({
    type: "workflow-iteration-complete",
    ...params,
  });
}

/**
 * Broadcast a workflow-fix-plan-updated SSE event.
 */
export function broadcastFixPlanUpdated(
  _actionContext: unknown,
  params: BroadcastFixPlanUpdatedParams,
): void {
  getDefaultDeps().broadcast({
    type: "workflow-fix-plan-updated",
    ...params,
  });
}

/**
 * Broadcast a workflow-circuit-breaker SSE event.
 */
export function broadcastCircuitBreaker(
  _actionContext: unknown,
  params: BroadcastCircuitBreakerParams,
): void {
  getDefaultDeps().broadcast({
    type: "workflow-circuit-breaker",
    ...params,
  });
}

/**
 * Persist the current actor snapshot to disk.
 */
export function persistSnapshot(
  _actionContext: unknown,
  params: PersistSnapshotParams,
): void {
  getDefaultDeps().persistSnapshot(
    params.projectPath,
    params.sessionName,
    params.snapshot,
    { immediate: params.immediate },
  );
}

/**
 * Create a notification (typically for terminal workflow states).
 */
export function createNotificationAction(
  _actionContext: unknown,
  params: CreateNotificationParams,
): void {
  getDefaultDeps().createNotification(params);
}

/**
 * All workflow actions as a record for use in setup({ actions }).
 *
 * Usage:
 *   import { workflowActions } from '@/lib/workflows/actions';
 *   const machine = setup({ actions: { ...workflowActions } }).createMachine(...)
 */
export const workflowActions = {
  broadcastStatus,
  broadcastIterationComplete,
  broadcastFixPlanUpdated,
  broadcastCircuitBreaker,
  persistSnapshot,
  createNotificationAction,
} as const;
