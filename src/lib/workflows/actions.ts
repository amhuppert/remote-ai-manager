/**
 * Generic XState action library for workflow machines.
 *
 * This module contains workflow-agnostic actions: snapshot persistence,
 * generic SSE broadcasting, and notification creation.
 *
 * All actions use the XState v5 named-actions-with-params pattern so they
 * can be provided/overridden via machine.provide() in tests.
 */

import type { SSEEvent, NotificationType, JobType } from "@/types";

// ============================================================
// Action parameter types
// ============================================================

/** Parameters for the generic broadcastWorkflowEvent action. */
export interface BroadcastWorkflowEventParams {
  /** The SSE event to broadcast. */
  event: SSEEvent;
}

export interface PersistSnapshotParams {
  projectPath: string;
  sessionName: string;
  snapshot: unknown;
  immediate?: boolean;
}

export interface CreateNotificationParams {
  type: NotificationType;
  title: string;
  message: string;
  projectName: string;
  sessionName: string;
  branchName: string;
  jobId: string;
  jobType: JobType;
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
    const sessionStatusBus: {
      publishSessionStatus: (event: SSEEvent) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("@/lib/workflows/primitives/default-session-status-bus");
    const persistence: {
      persistWorkflowSnapshot: WorkflowActionDeps["persistSnapshot"];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("@/lib/workflows/persistence");
    const notificationDb: {
      createNotification: WorkflowActionDeps["createNotification"];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("@/lib/notification-db");

    _deps = {
      broadcast: (event) => {
        sessionStatusBus.publishSessionStatus(event);
      },
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
// Generic Named Actions
// ============================================================

/**
 * Generic SSE event broadcaster.
 * Workflows can use this to broadcast any SSE event type without
 * needing a dedicated action function.
 */
export function broadcastWorkflowEvent(
  _actionContext: unknown,
  params: BroadcastWorkflowEventParams,
): void {
  getDefaultDeps().broadcast(params.event);
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
