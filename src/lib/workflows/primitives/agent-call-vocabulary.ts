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
import { agentBackendSchema, agentSessionRefSchema } from "@/lib/schemas";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";

export const laneRefSchema = z.object({
  workflowId: z.string().min(1),
  laneId: z.string().min(1),
});
export type LaneRef = z.infer<typeof laneRefSchema>;

export const laneWriteCapabilitySchema = z.enum(["read_only", "write_capable"]);
export type LaneWriteCapability = z.infer<typeof laneWriteCapabilitySchema>;

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
  timeoutMs: z.number().int().positive().optional(),
} as const;

export const agentCallRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation_turn"),
    backend: agentBackendSchema.optional(),
    ...baseRequestFields,
  }),
  z.object({
    kind: z.literal("task_run"),
    backend: agentBackendSchema,
    systemInstructions: z.string().optional(),
    ...baseRequestFields,
  }),
]);
export type AgentCallRequest = z.infer<typeof agentCallRequestSchema>;
export type AgentCallRequestKind = AgentCallRequest["kind"];

export const continuationStrengthSchema = z.enum([
  "precise_session",
  "synthetic_thread",
  "none",
]);
export type ContinuationStrength = z.infer<typeof continuationStrengthSchema>;

export const structuredOutputEnforcementSchema = z.enum([
  "backend_native",
  "post_validation",
  "unsupported",
]);
export type StructuredOutputEnforcement = z.infer<
  typeof structuredOutputEnforcementSchema
>;

export const mcpApplicationBoundarySchema = z.enum([
  "startup_only",
  "between_turns",
  "per_request",
  "unsupported",
]);
export type McpApplicationBoundary = z.infer<
  typeof mcpApplicationBoundarySchema
>;

export const backendCapabilityViewSchema = z.object({
  backend: agentBackendSchema,
  continuationStrength: continuationStrengthSchema,
  structuredOutputEnforcement: structuredOutputEnforcementSchema,
  mcpApplicationBoundary: mcpApplicationBoundarySchema,
  contextMetricsAvailable: z.boolean(),
  nativeMidTurnAskUser: z.boolean(),
});
export type BackendCapabilityView = z.infer<typeof backendCapabilityViewSchema>;

export const agentCallUsageMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  contextTokens: z.number().int().nonnegative().optional(),
  contextWindowMax: z.number().int().positive().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AgentCallUsageMetrics = z.infer<typeof agentCallUsageMetricsSchema>;

export const artifactRefSchema = z.object({
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
export type NormalizedAgentCallError = z.infer<
  typeof normalizedAgentCallErrorSchema
>;

export const pauseKindSchema = z.enum(["mid_turn", "post_turn"]);
export type PauseKind = z.infer<typeof pauseKindSchema>;

const agentCallOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    text: z.string().nullable(),
    structuredOutput: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("paused"),
    pauseKind: pauseKindSchema,
    resumeToken: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    error: normalizedAgentCallErrorSchema,
  }),
]);
export type AgentCallOutcome = z.infer<typeof agentCallOutcomeSchema>;
export type AgentCallOutcomeKind = AgentCallOutcome["kind"];

export const agentCallResultSchema = z.object({
  backend: agentBackendSchema,
  backendRef: agentSessionRefSchema.nullable(),
  capabilities: backendCapabilityViewSchema,
  usage: agentCallUsageMetricsSchema,
  artifacts: z.array(artifactRefSchema),
  outcome: agentCallOutcomeSchema,
});
export type AgentCallResult = z.infer<typeof agentCallResultSchema>;

export interface AgentCallLogFieldsInput {
  requestKind: AgentCallRequestKind;
  backend: import("@/types").AgentBackendId;
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

export interface AgentCallService {
  execute(request: AgentCallRequest): Promise<AgentCallResult>;
}
