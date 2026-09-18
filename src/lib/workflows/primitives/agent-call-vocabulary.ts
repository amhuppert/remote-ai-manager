import {
  executionIntentSchema,
  taskExecutionProfileSchema,
  backendAdmissionRefusalSchema,
} from "@/lib/agent-backends/execution-admission";
/**
 * Capability-aware execution vocabulary for the AgentCall primitive.
 *
 * Defines the shared request and normalized result shapes used by both the
 * conversation-oriented runtime and the task-oriented runner, plus the
 * backend capability view and structured logging fields every primitive in
 * this layer emits.
 *
 * The shapes deliberately preserve real backend differences (continuation
 * strength, structured-output enforcement source, MCP application boundary,
 * context metric availability, native mid-turn ask-user) so workflows can
 * branch on observed capabilities instead of assumed parity.
 */

import { z } from "zod";
import {
  agentBackendIdShapeSchema,
  agentSessionRefSchema,
} from "@/lib/shared/schemas";
import { agentTranscriptEntrySchema } from "@/lib/agent-backends/transcript";
import { fsWritePolicySchema } from "@/lib/agent-backends/task";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import { continuationDispositionSchema } from "@/lib/agent-backends/errors";
import { messageContentBlockSchema } from "@/lib/conversations/message-content-schemas";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";

export const laneRefSchema = z.object({
  workflowId: z.string().min(1),
  laneId: z.string().min(1),
});
export type LaneRef = z.infer<typeof laneRefSchema>;

/**
 * How an execution may touch the session worktree, which drives lane
 * scheduling:
 * - `read_only` — proven not to write; schedules without the write lock.
 * - `artifact_only` — writes confined to lane-scoped generated-artifact paths
 *   that are disjoint per (workflow, agent, phase), so concurrent
 *   artifact-only executions cannot collide; schedules without the write lock.
 * - `write_capable` — may write anywhere in the worktree; serialized per
 *   session.
 */
export const laneWriteCapabilitySchema = z.enum([
  "read_only",
  "artifact_only",
  "write_capable",
]);
export type LaneWriteCapability = z.infer<typeof laneWriteCapabilitySchema>;

/**
 * The write capability assumed when a caller does not specify one. The single
 * declaration every scheduling/continuity module imports: defaulting to
 * `write_capable` preserves the single-flight safety model — the layer never
 * silently relaxes worktree serialization for an unlabelled execution.
 */
export const DEFAULT_LANE_WRITE_CAPABILITY: LaneWriteCapability =
  "write_capable";

const conversationImageRefSchema = z.object({
  index: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  base64Data: z.string().min(1),
});

export const portableMcpConfigInputSchema = z.custom<PortableMcpConfig>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { servers?: unknown }).servers),
  { message: "tooling must be a PortableMcpConfig with a servers array" },
);

// Zod-generated JSON Schemas carry non-enumerable ~standard callbacks. Keep
// only JSON object members before z.record makes hidden properties enumerable.
export const outputSchemaInputSchema = z.preprocess(
  (value: Record<string, unknown>) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : value,
  z.record(z.string(), z.unknown()),
);
const structuredOutputRepairInputSchema = z.object({
  maxAttempts: z.number().int().min(0).max(1),
});

const baseRequestFields = {
  ...executionIntentSchema.shape,
  laneRef: laneRefSchema.optional(),
  prompt: z.string().min(1),
  // Governing instructions for the call, expressed uniformly across
  // transports: each dispatch path maps this onto its own governance channel
  // (the task runner's `systemInstructions`, the conversation runtime's
  // session instructions) rather than folding it into the prompt.
  systemInstructions: z.string().optional(),
  tooling: portableMcpConfigInputSchema.optional(),
  outputSchema: outputSchemaInputSchema.optional(),
  structuredOutputRepair: structuredOutputRepairInputSchema.optional(),
  writeCapability: laneWriteCapabilitySchema.optional(),
  // 0 is the project-wide "no timeout" sentinel; positive values cap the
  // turn. Both task runners (`claude/task-runner`, `codex/task-runner`) and
  // the conversation safety-net timer skip their timeout when this is 0.
  timeoutMs: z.number().int().nonnegative().optional(),
  // Complete per-call selection. Backend-specific validation happens at the
  // runner, but the bundle is never split or partially merged at this layer.
  modelSelection: backendModelSelectionSchema.optional(),
  modelId: z.never().optional(),
  reasoningEffort: z.never().optional(),
  codexFastMode: z.never().optional(),
  imageRefs: z.array(conversationImageRefSchema).max(5).optional(),
  // Declared on the shared base because BOTH dispatch paths now establish it
  // natively: the task runner on its own sandbox, and the conversation runtimes
  // on theirs (D6). A path that could carry the field without honouring it
  // would be the one hop where a policy silently evaporates, so a runtime that
  // cannot establish a present policy fails the turn instead.
  fsWritePolicy: fsWritePolicySchema.optional(),
} as const;

export const agentCallRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("conversation_turn"),
      backend: agentBackendIdShapeSchema.optional(),
      ...baseRequestFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_run"),
      executionProfile: taskExecutionProfileSchema.optional(),
      backend: agentBackendIdShapeSchema,
      ...baseRequestFields,
    })
    .strict(),
]);
export type AgentCallRequest = z.infer<typeof agentCallRequestSchema>;
type AgentCallRequestKind = AgentCallRequest["kind"];

const continuationStrengthSchema = z.enum([
  "precise_session",
  "synthetic_thread",
  "none",
]);

const structuredOutputEnforcementSchema = z.enum([
  "backend_native",
  "post_validation",
  "unsupported",
]);

const mcpApplicationBoundarySchema = z.enum([
  "startup_only",
  "between_turns",
  "per_request",
  "unsupported",
]);

export const backendCapabilityViewSchema = z.object({
  backend: agentBackendSchema,
  continuationStrength: continuationStrengthSchema,
  structuredOutputEnforcement: structuredOutputEnforcementSchema,
  mcpApplicationBoundary: mcpApplicationBoundarySchema,
  contextMetricsAvailable: z.boolean(),
  nativeMidTurnAskUser: z.boolean(),
});
export type BackendCapabilityView = z.infer<typeof backendCapabilityViewSchema>;

const agentCallUsageMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  contextTokens: z.number().int().nonnegative().optional(),
  contextWindowMax: z.number().int().positive().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** Lineage-cumulative cost snapshot (never summed); backend-cumulative
   * providers only. */
  cumulativeCostUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AgentCallUsageMetrics = z.infer<typeof agentCallUsageMetricsSchema>;

const artifactRefSchema = z.object({
  kind: z.string().min(1),
  relativePath: z.string().min(1),
  description: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const normalizedAgentCallFailureKindSchema = z.enum([
  "timeout",
  "schema_validation",
  "structured_output_exhausted",
  "backend_error",
  "aborted",
  "capability_unavailable",
  "stale_resume_ref",
  "session_died",
  "quota_exhausted",
]);
export type NormalizedAgentCallFailureKind = z.infer<
  typeof normalizedAgentCallFailureKindSchema
>;

export const normalizedAgentCallErrorSchema = z.object({
  code: backendAdmissionRefusalSchema.shape.code.optional(),
  failureKind: normalizedAgentCallFailureKindSchema,
  backend: agentBackendSchema,
  message: z.string(),
  /**
   * Whether re-running the call could plausibly succeed, as the backend's
   * classifier decided from the error value. The kind alone cannot answer it —
   * a session that died before delivering the prompt is safe to re-dispatch
   * while one that died mid-turn is not — so a caller's retry policy reads this
   * rather than mapping the kind. Absent where the failure was minted without a
   * classifier (a refused capability, a facade-level guard).
   */
  retryable: z.boolean().optional(),
  /** Opaque provider text naming when capacity returns (the classification's
   *  `retryAfterHint`). Display-only — never parsed for scheduling. */
  retryAfterHint: z.string().optional(),
  backendDetails: z.unknown().optional(),
});

export const pauseKindSchema = z.enum(["mid_turn", "post_turn"]);
export type PauseKind = z.infer<typeof pauseKindSchema>;

/**
 * Where the structured-output gate found the accepted payload, in the shared
 * extraction-precedence vocabulary (`agent-backends/structured-output`).
 */
export const agentCallStructuredOutputParseSchema = z.object({
  source: z.enum(["native", "raw_json", "fenced"]),
  repaired: z.boolean().optional(),
  repairAttempts: z.number().int().positive().optional(),
});
export type AgentCallStructuredOutputParse = z.infer<
  typeof agentCallStructuredOutputParseSchema
>;

const backgroundWaitSummaryInputSchema = z.custom<BackgroundWaitSummary>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { waitedTaskIds?: unknown }).waitedTaskIds),
  { message: "backgroundWait must be a BackgroundWaitSummary" },
);

const agentCallOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    text: z.string().nullable(),
    structuredOutput: z.unknown().optional(),
    transcript: agentTranscriptEntrySchema.array().optional(),
    /** Number of agentic turns the backend reported for this call. */
    numTurns: z.number().int().nonnegative().optional(),
    /** Full assistant content of the turn, in transcript block vocabulary. */
    contentBlocks: messageContentBlockSchema.array().optional(),
    /** Set by the structured-output gate when it accepted a candidate. */
    parse: agentCallStructuredOutputParseSchema.optional(),
  }),
  z.object({
    kind: z.literal("paused"),
    pauseKind: pauseKindSchema,
    resumeToken: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    transcript: agentTranscriptEntrySchema.array().optional(),
    error: normalizedAgentCallErrorSchema,
    numTurns: z.number().int().nonnegative().optional(),
    /**
     * Partial assistant content produced before the failure. Present (possibly
     * empty) exactly when the backend produced a turn result the failure was
     * derived from; absent when dispatch failed without a turn result (thrown
     * error, pre-dispatch gate).
     */
    contentBlocks: messageContentBlockSchema.array().optional(),
  }),
]);
type AgentCallOutcome = z.infer<typeof agentCallOutcomeSchema>;
type AgentCallOutcomeKind = AgentCallOutcome["kind"];

export const agentCallResultSchema = z.object({
  backend: agentBackendSchema,
  backendRef: agentSessionRefSchema.nullable(),
  capabilities: backendCapabilityViewSchema,
  usage: agentCallUsageMetricsSchema,
  artifacts: z.array(artifactRefSchema),
  outcome: agentCallOutcomeSchema,
  /**
   * Whether the persisted continuation ref is still usable after this call:
   * the adapter's own verdict when it produced a result. Turnless failures
   * retain the prior continuation because no adapter invalidation exists.
   */
  continuationDisposition: continuationDispositionSchema.optional(),
  /** Native compaction observed; may be a summary without confirmed replacement. */
  compacted: z.boolean().optional(),
  /** Bounded background-task wait the turn performed, when one occurred. */
  backgroundWait: backgroundWaitSummaryInputSchema.optional(),
});
export type AgentCallResult = z.infer<typeof agentCallResultSchema>;

export interface AgentCallLogFieldsInput {
  requestKind: AgentCallRequestKind;
  backend: AgentBackendId;
  workflowId?: string;
  laneId?: string;
  artifactKinds?: readonly string[];
  outcome?: AgentCallOutcomeKind;
}

/**
 * Build the structured logging field set every AgentCall primitive emits.
 * Optional fields are omitted when absent rather than serialized as `null`
 * so log analyzers can rely on field presence as a signal.
 */
export function buildAgentCallLogFields(
  input: AgentCallLogFieldsInput,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    requestKind: input.requestKind,
    backend: input.backend,
  };
  if (input.workflowId !== undefined) fields["workflowId"] = input.workflowId;
  if (input.laneId !== undefined) fields["laneId"] = input.laneId;
  if (input.outcome !== undefined) fields["outcome"] = input.outcome;
  if (input.artifactKinds !== undefined) {
    fields["artifactKinds"] = input.artifactKinds;
  }
  return fields;
}
