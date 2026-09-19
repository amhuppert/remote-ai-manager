/**
 * Lane vocabulary for the workflow primitive layer.
 *
 * Models a long-lived agent continuity stream owned by a workflow scope. The
 * state is backend-neutral: the continuity handle is the opaque
 * `{backend, ref}` pair (the same identity `AgentSessionRef` carries — only
 * the owning backend's continuity adapter may interpret `ref`), and metrics
 * are a single normalized shape whose fields are optional because backends
 * genuinely differ in what they report (context-window occupancy, per-turn
 * token usage). Absent fields stay absent rather than collapsing into fake
 * defaults.
 *
 * `LaneRef` and `LaneWriteCapability` are sourced from the AgentCall
 * vocabulary so the execution facade and the lane service share one identity
 * type.
 */

import { z } from "zod";
import {
  agentBackendIdShapeSchema,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import {
  laneWriteCapabilitySchema,
  type LaneRef,
  type LaneWriteCapability,
} from "./agent-call-vocabulary";

export type { LaneRef, LaneWriteCapability };

export const lanePolicySchema = z.object({
  continuityEnabled: z.boolean(),
});
export type LanePolicy = z.infer<typeof lanePolicySchema>;

export const laneTurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type LaneTurnUsage = z.infer<typeof laneTurnUsageSchema>;

/**
 * Normalized per-lane metrics. Every field is optional: a backend that does not report a metric leaves it absent
 * (`lastTurnUsage: null` records "the turn reported no usage" for backends
 * that do report usage in general).
 */
export const laneMetricsSchema = z
  .object({
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindowMax: z.number().int().positive().optional(),
    lastTurnUsage: laneTurnUsageSchema.nullable().optional(),
  })
  .strict();
export type LaneMetrics = z.infer<typeof laneMetricsSchema>;

export const laneStateSchema = z.object({
  workflowId: z.string().min(1),
  laneId: z.string().min(1),
  backend: agentBackendIdShapeSchema,
  /**
   * Opaque continuity handle minted by the owning backend's adapter. Null
   * until the first backend session exists.
   */
  ref: z.string().min(1).nullable(),
  /** What owns `ref`; absent rows predate explicit reference semantics. */
  refKind: z.enum(["conversation", "backend"]).optional(),
  /**
   * CC conversation used to dispatch the lane. This is independent of `ref`:
   * a conversation-backed lane may use the same value for both, while a
   * headless backend can dispatch under a synthetic conversation id and keep
   * its native thread/session handle in `ref`.
   */
  conversationId: z.string().min(1).optional(),
  /** True when the persisted handle is known-stale (recovery pending). */
  staleSession: z.boolean().optional(),
  writeCapability: laneWriteCapabilitySchema,
  policy: lanePolicySchema,
  metrics: laneMetricsSchema,
  lastUsedAt: z.string().min(1),
});
export type LaneState = z.infer<typeof laneStateSchema>;

/** The lane's continuity handle as an `AgentSessionRef`, when one exists. */
export function laneSessionRef(state: LaneState): AgentSessionRef | null {
  return state.ref === null ? null : { backend: state.backend, ref: state.ref };
}

/**
 * Stable storage key for a lane within its owning workflow scope.
 *
 * The NUL separator is illegal in `workflowId` and `laneId` (both required
 * to be non-empty strings), so the encoding is unambiguous and immune to
 * collisions where `workflowId + laneId` would otherwise concatenate into a
 * shared key.
 */
export function laneStorageKey(ref: LaneRef): string {
  return `${ref.workflowId}\u0000${ref.laneId}`;
}
