import type {
  AgentBackendDescriptor,
  AgentBackendMetadata,
  BackendConversationCapabilities,
  BackendConversationTranscriptProjection,
  BackendTaskTranscriptProjection,
} from "../descriptor";
import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import type { BackendRuntimeConfigAdapter } from "../runtime-config";
import type { AgentTaskRunner } from "../task";
import type { AgentFailureClassifier } from "../errors";
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";
import { getDefaultClaudeModel, getEffortLevelsForModel } from "../schemas";

/**
 * Backend catalog metadata for Claude — the single source for model labels,
 * descriptions, tone, and skill-trigger prefix rendered by the UI catalog.
 * Model ids and effort levels stay sourced from the validation schemas in
 * `../schemas` so catalog and validation cannot drift.
 */
export const claudeBackendMetadata: AgentBackendMetadata = {
  label: "Claude",
  toneToken: "cyan",
  skillTriggerPrefix: "/",
  models: [
    {
      id: "fable",
      label: "Fable",
      description: "Most capable",
      effortLevels: getEffortLevelsForModel("fable"),
    },
    {
      id: "opus",
      label: "Opus 5",
      description: "Complex reasoning",
      effortLevels: getEffortLevelsForModel("opus"),
    },
    {
      id: "sonnet",
      label: "Sonnet",
      description: "Balanced",
      effortLevels: getEffortLevelsForModel("sonnet"),
    },
    {
      id: "haiku",
      label: "Haiku",
      description: "Fastest",
      effortLevels: getEffortLevelsForModel("haiku"),
    },
  ],
  defaultModelId: getDefaultClaudeModel(),
  defaultTimeoutMs: null,
  // Disabled: Claude turns legitimately go quiet during background-task
  // waits, and the configured safety-net timeout already bounds a hung turn.
  defaultStallTimeoutMs: null,
};

export const claudeConversationCapabilities: BackendConversationCapabilities = {
  queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },
  continuationStrength: "precise_session",
  fork: "native",
  structuredOutput: "post_validation",
  contextWindowMetrics: true,
  nativeMidTurnAskUser: true,
  externalTurns: true,
  capabilityKinds: [
    { kind: "skills", applyTiming: "idle_live" },
    { kind: "plugins", applyTiming: "idle_live" },
    { kind: "agents", applyTiming: "next_conversation" },
  ],
};

export const claudeConversationTranscriptProjection: BackendConversationTranscriptProjection =
  {
    persistContentEvents: false,
    projectBackendInit: () => null,
    projectTurnResult: () => null,
  };

export const claudeTaskTranscriptProjection: BackendTaskTranscriptProjection = {
  projectAssistantMetadata: () => undefined,
};

export interface ClaudeDescriptorDeps {
  conversationFactory: ConversationBackendFactory;
  /** `createClaudeContinuityAdapter(...)` in production; injected so the
   * conformance suite can drive it against fake SDK/service ports. */
  continuity: BackendContinuityAdapter;
  /** `createClaudeRuntimeConfigAdapter()` in production; injected because the
   * adapter is server-only while this module's literals are client-imported. */
  runtimeConfig: BackendRuntimeConfigAdapter;
  taskRunner: AgentTaskRunner;
  /** `claudeMcpCapabilities` in production; injected because the MCP registry
   * module is server-only while this module's literals are client-imported. */
  mcp: McpBackendCapabilities;
  failureClassifier: AgentFailureClassifier;
}

export function createClaudeBackendDescriptor(
  deps: ClaudeDescriptorDeps,
): AgentBackendDescriptor {
  return {
    id: "claude",
    metadata: claudeBackendMetadata,
    conversation: {
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: claudeConversationCapabilities,
      runtimeConfig: deps.runtimeConfig,
      transcript: claudeConversationTranscriptProjection,
    },
    tasks: {
      runner: deps.taskRunner,
      structuredOutput: "post_validation",
      transcript: claudeTaskTranscriptProjection,
    },
    managedSkills: { conversations: "bundled", tasks: "bundled" },
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
