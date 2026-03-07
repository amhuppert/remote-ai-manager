/**
 * Ralph Loop-specific XState action library.
 *
 * These actions are specific to the Ralph Loop workflow and broadcast
 * SSE events for iteration progress, fix plan updates, and circuit breaker
 * state changes.
 *
 * Generic workflow actions (persistSnapshot, broadcastWorkflowEvent,
 * createNotificationAction) live in the parent `workflows/actions.ts`.
 */

import type {
  RalphLoopIterationMeta,
  CircuitBreakerState,
  FixPlanTask,
} from "@/types";
import { getActionDeps } from "../actions";

// ============================================================
// Parameter Types
// ============================================================

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

// ============================================================
// Named Actions
// ============================================================

/**
 * Broadcast a workflow-iteration-complete SSE event.
 */
export function broadcastIterationComplete(
  _actionContext: unknown,
  params: BroadcastIterationCompleteParams,
): void {
  getActionDeps().broadcast({
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
  getActionDeps().broadcast({
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
  getActionDeps().broadcast({
    type: "workflow-circuit-breaker",
    ...params,
  });
}

/**
 * Ralph Loop-specific actions for use in setup({ actions }).
 */
export const ralphLoopActions = {
  broadcastIterationComplete,
  broadcastFixPlanUpdated,
  broadcastCircuitBreaker,
} as const;
