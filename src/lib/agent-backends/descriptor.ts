import { z } from "zod";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationBackendFactory } from "./conversation";
import type { BackendContinuityAdapter } from "./continuity";
import type { BackendRuntimeConfigAdapter } from "./runtime-config";
import type { AgentTaskRunner } from "./task";
import type { AgentFailureClassifier } from "./errors";
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";
import type { EffortLevel } from "./schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";

export const queueDeliveryTimingSchema = z.enum(["in_turn", "next_turn"]);
export type QueueDeliveryTiming = z.infer<typeof queueDeliveryTimingSchema>;

export interface QueueCapability {
  acceptsWhileRunning: boolean;
  deliveryTiming: QueueDeliveryTiming;
}

export const capabilityKindSchema = z.enum(["skills", "plugins", "agents"]);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

/**
 * When a runtime-capability config change for a kind reaches the live agent:
 * "idle_live" = live-apply when idle, staged when a turn is active;
 * "next_turn" = staged, promoted at the next turn boundary;
 * "next_conversation" = binding fixed at session creation.
 * Timing is declared per capability kind because a single backend's kinds
 * genuinely differ (Claude skills/plugins are idle-live while agents bind at
 * session creation via canUseTool).
 */
export const capabilityApplyTimingSchema = z.enum([
  "idle_live",
  "next_turn",
  "next_conversation",
]);
export type CapabilityApplyTiming = z.infer<typeof capabilityApplyTimingSchema>;

export interface BackendCapabilityKindSupport {
  kind: CapabilityKind;
  applyTiming: CapabilityApplyTiming;
}

export const continuationStrengthSchema = z.enum([
  "precise_session",
  "synthetic_thread",
  "none",
]);
export type ContinuationStrength = z.infer<typeof continuationStrengthSchema>;

export const forkSupportSchema = z.enum(["native", "synthetic", "unsupported"]);
export type ForkSupport = z.infer<typeof forkSupportSchema>;

export const structuredOutputSupportSchema = z.enum([
  "backend_native",
  "post_validation",
  "unsupported",
]);
export type StructuredOutputSupport = z.infer<
  typeof structuredOutputSupportSchema
>;

export interface BackendConversationCapabilities {
  queue: QueueCapability;
  continuationStrength: ContinuationStrength;
  fork: ForkSupport;
  structuredOutput: StructuredOutputSupport;
  contextWindowMetrics: boolean;
  nativeMidTurnAskUser: boolean;
  externalTurns: boolean;
  capabilityKinds: readonly BackendCapabilityKindSupport[];
}

export interface BackendTranscriptEntry {
  timestamp: string;
  type: string;
  raw?: unknown;
}

export interface BackendTurnResultProjectionInput {
  timestamp: string;
  backendRef: AgentSessionRef | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  costUsd: number | null;
  aborted: boolean;
  error: string | null;
}

/**
 * Projects normalized conversation events into Command Center's transcript
 * compatibility records. Provider-native transcript interpretation remains
 * in runtime adapters; this seam owns only the legacy records CC adds around
 * a turn.
 */
export interface BackendConversationTranscriptProjection {
  persistContentEvents: boolean;
  projectBackendInit(input: {
    timestamp: string;
    backendRef: AgentSessionRef;
  }): BackendTranscriptEntry | null;
  projectTurnResult(
    input: BackendTurnResultProjectionInput,
  ): BackendTranscriptEntry | null;
}

/** Projects a task continuation ref into optional assistant-row metadata. */
export interface BackendTaskTranscriptProjection {
  projectAssistantMetadata(backendRef: AgentSessionRef | null): unknown;
}

export interface BackendModelInfo {
  id: string;
  label: string;
  description: string;
  /** Empty = effort not applicable to this model. */
  effortLevels: readonly EffortLevel[];
}

export const skillTriggerPrefixSchema = z.enum(["/", "$"]);
export type SkillTriggerPrefix = z.infer<typeof skillTriggerPrefixSchema>;

export interface AgentBackendMetadata {
  label: string;
  /** Design-system tone name driving UI chip/accent color (e.g. "cyan"). */
  toneToken: string;
  skillTriggerPrefix: SkillTriggerPrefix;
  models: readonly BackendModelInfo[];
  defaultModelId: string;
  defaultTimeoutMs: number | null;
}

export interface AgentBackendConversationFacet {
  factory: ConversationBackendFactory;
  /** Session/thread lifecycle (start/validate/resumeOrRecover/fork). */
  continuity: BackendContinuityAdapter;
  capabilities: BackendConversationCapabilities;
  /** Neutral capability-cascade apply seam; translation happens inside. */
  runtimeConfig: BackendRuntimeConfigAdapter;
  transcript: BackendConversationTranscriptProjection;
}

export interface AgentBackendTaskFacet {
  runner: AgentTaskRunner;
  structuredOutput: StructuredOutputSupport;
  transcript: BackendTaskTranscriptProjection;
}

export interface AgentBackendDescriptor {
  id: AgentBackendId;
  metadata: AgentBackendMetadata;
  conversation?: AgentBackendConversationFacet;
  tasks?: AgentBackendTaskFacet;
  mcp: McpBackendCapabilities;
  errors: AgentFailureClassifier;
}
