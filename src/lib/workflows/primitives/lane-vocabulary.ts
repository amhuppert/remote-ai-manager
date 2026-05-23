/**
 * Lane vocabulary for the workflow primitive layer.
 *
 * Models a long-lived agent continuity stream owned by a workflow scope.
 * The state shape preserves backend-specific continuity references and
 * metrics through discriminated unions so unsupported fields stay absent
 * rather than collapsing into fake defaults (Codex never carries
 * context-window metrics; Claude never carries Codex turn-usage rollups).
 *
 * `LaneRef` and `LaneWriteCapability` are sourced from the AgentCall
 * vocabulary so the execution facade and the lane service share one identity
 * type.
 */

import { z } from "zod";
import { agentBackendSchema } from "@/lib/schemas";
import {
  laneWriteCapabilitySchema,
  type LaneRef,
  type LaneWriteCapability,
} from "./agent-call-vocabulary";

export type { LaneRef, LaneWriteCapability };

export const lanePolicySchema = z.object({
  continuityEnabled: z.boolean(),
  contextLimitTokens: z.number().int().positive().optional(),
});
export type LanePolicy = z.infer<typeof lanePolicySchema>;

const claudeLaneBackendStateSchema = z
  .object({
    backend: z.literal("claude"),
    conversationId: z.string().min(1).optional(),
    staleSession: z.boolean().optional(),
  })
  .strict();

const codexLaneBackendStateSchema = z
  .object({
    backend: z.literal("codex"),
    threadId: z.string().min(1).optional(),
    staleSession: z.boolean().optional(),
  })
  .strict();

export const laneBackendStateSchema = z.discriminatedUnion("backend", [
  claudeLaneBackendStateSchema,
  codexLaneBackendStateSchema,
]);

const codexLaneTurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type CodexLaneTurnUsage = z.infer<typeof codexLaneTurnUsageSchema>;

const claudeLaneMetricsSchema = z
  .object({
    backend: z.literal("claude"),
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindowMax: z.number().int().positive().optional(),
    rotateBeforeNextTurn: z.boolean(),
  })
  .strict();

const codexLaneMetricsSchema = z
  .object({
    backend: z.literal("codex"),
    lastTurnUsage: codexLaneTurnUsageSchema.nullable().optional(),
    rotateBeforeNextTurn: z.boolean(),
  })
  .strict();

export const laneMetricsSchema = z.discriminatedUnion("backend", [
  claudeLaneMetricsSchema,
  codexLaneMetricsSchema,
]);
export type LaneMetrics = z.infer<typeof laneMetricsSchema>;

export const laneStateSchema = z
  .object({
    workflowId: z.string().min(1),
    laneId: z.string().min(1),
    backend: agentBackendSchema,
    writeCapability: laneWriteCapabilitySchema,
    policy: lanePolicySchema,
    backendState: laneBackendStateSchema,
    metrics: laneMetricsSchema,
    lastUsedAt: z.string().min(1),
  })
  .superRefine((state, ctx) => {
    if (state.backendState.backend !== state.backend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `backendState.backend (${state.backendState.backend}) must match backend (${state.backend})`,
        path: ["backendState", "backend"],
      });
    }
    if (state.metrics.backend !== state.backend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metrics.backend (${state.metrics.backend}) must match backend (${state.backend})`,
        path: ["metrics", "backend"],
      });
    }
  });
export type LaneState = z.infer<typeof laneStateSchema>;

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
