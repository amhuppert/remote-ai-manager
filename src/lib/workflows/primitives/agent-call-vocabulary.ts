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
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import { continuationDispositionSchema } from "@/lib/agent-backends/errors";
import { messageContentBlockSchema } from "@/lib/conversations/message-content-schemas";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";

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

const portableMcpConfigInputSchema = z.custom<PortableMcpConfig>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { servers?: unknown }).servers),
  { message: "tooling must be a PortableMcpConfig with a servers array" },
);

const outputSchemaInputSchema = z.record(z.string(), z.unknown());

const baseRequestFields = {
  laneRef: laneRefSchema.optional(),
  prompt: z.string().min(1),
  tooling: portableMcpConfigInputSchema.optional(),
  outputSchema: outputSchemaInputSchema.optional(),
  writeCapability: laneWriteCapabilitySchema.optional(),
  // 0 is the project-wide "no timeout" sentinel; positive values cap the
  // turn. Both task runners (`claude/task-runner`, `codex/task-runner`) and
  // the conversation safety-net timer skip their timeout when this is 0.
  timeoutMs: z.number().int().nonnegative().optional(),
  // Optional per-call model selection. When set, callers (workflow agents,
  // collaborators) pass this through to the resolved task runner /
  // conversation runtime so the backend uses the configured model instead of
  // its default. Both fields are strings at this layer; backend-specific
  // validation happens at the runner.
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  imageRefs: z.array(conversationImageRefSchema).max(5).optional(),
} as const;

export const agentCallRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation_turn"),
    backend: agentBackendIdShapeSchema.optional(),
    ...baseRequestFields,
  }),
  z.object({
    kind: z.literal("task_run"),
    backend: agentBackendIdShapeSchema,
    systemInstructions: z.string().optional(),
    ...baseRequestFields,
  }),
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
  "backend_error",
  "aborted",
  "capability_unavailable",
  "stale_resume_ref",
  "session_died",
]);
export type NormalizedAgentCallFailureKind = z.infer<
  typeof normalizedAgentCallFailureKindSchema
>;

export const normalizedAgentCallErrorSchema = z.object({
  failureKind: normalizedAgentCallFailureKindSchema,
  backend: agentBackendSchema,
  message: z.string(),
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
  /** True when the backend auto-compacted context at least once this call. */
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
