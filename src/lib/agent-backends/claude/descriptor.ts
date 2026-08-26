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
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./shared";

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
  defaultStallTimeoutMs: CLAUDE_DEFAULT_STALL_TIMEOUT_MS,
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

/**
 * Claude confines a restricted task run with the Agent SDK sandbox plus
 * path-scoped permission rules over the file-mutation tools — a mechanism the
 * agent cannot renegotiate from inside the turn.
 *
 * Exported as a literal (not read off the descriptor) because the descriptor
 * carries the server-only runner while definition validate runs client-side.
 */
export const claudeTaskFsWriteRestriction = "enforced" as const;

/**
 * The same claim for a CONVERSATION turn: `query-session` translates a
 * delivered policy onto the sandbox, path-scoped mutation rules, and a working
 * root outside the confined tree, and refuses to create the session at all for
 * a policy it cannot establish. Graph-workflow implementers dispatch through
 * this path, so this is the declaration that gates them.
 */
export const claudeConversationFsWriteRestriction = "enforced" as const;

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
    modelCatalog: {
      getCatalog: async ({ configuredSelection }) => {
        const { getStaticBackendModelCatalog } = await import("../catalog");
        return getStaticBackendModelCatalog("claude", configuredSelection);
      },
    },
    conversation: {
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: claudeConversationCapabilities,
      fsWriteRestriction: claudeConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: claudeConversationTranscriptProjection,
    },
    tasks: {
      runner: deps.taskRunner,
      structuredOutput: "post_validation",
      transcript: claudeTaskTranscriptProjection,
      fsWriteRestriction: claudeTaskFsWriteRestriction,
    },
    managedSkills: { conversations: "bundled", tasks: "bundled" },
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
