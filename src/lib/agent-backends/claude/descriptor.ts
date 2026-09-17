import type {
  ConversationExecutionPolicy,
  TaskExecutionPolicy,
} from "../execution-admission";
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
import type { BackendNativeMemory } from "../native-memory";
import { getDefaultClaudeModel, getEffortLevelsForModel } from "../schemas";
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./shared";

export const claudeConversationExecution: ConversationExecutionPolicy = {
  classes: ["ordinary-conversation", "governed-execution"],
  instructionDelivery: "privileged",
};

export const claudeTaskExecution: TaskExecutionPolicy = {
  classes: ["nongoverned-task", "governed-execution"],
  instructionDelivery: "privileged",
  profiles: ["standard", "isolated-one-shot"],
};

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
  // Enabled on this adapter's own passing continuation evidence (D9): three
  // checkpoint cycles with a queued delivery, in both scopes, clearing both
  // halves of the bar — no structural failure and every independently authored
  // expectation satisfied (9/9 in each scope).
  // scripts/probes/run-checkpoint-continuation.sh.
  checkpoint: true,
  checkpointFork: true,
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

/**
 * Claude's auto-memory is off in every environment Command Center launches.
 * The Agent SDK exposes the lever on the `Settings` layer CC already supplies,
 * which overrides user and project settings on CC's unmanaged hosts.
 * The shared launch check reads these flags once for the server process.
 * `autoDreamEnabled` is the same switch for the background consolidation pass
 * — leaving it on would keep a writer running against a store nothing reads.
 *
 * Exported as a literal (not read off the descriptor) because the descriptor
 * carries the server-only runner while the catalog projection is
 * client-imported.
 */
export const claudeNativeMemory: BackendNativeMemory = {
  mechanism: "disabled",
  lever:
    "SDK Settings autoMemoryEnabled=false, autoDreamEnabled=false; launch refused if the shared flags are unreadable",
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
    modelCatalog: {
      getCatalog: async ({ configuredSelection }) => {
        const { getStaticBackendModelCatalog } = await import("../catalog");
        return getStaticBackendModelCatalog("claude", configuredSelection);
      },
    },
    conversation: {
      execution: claudeConversationExecution,
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: claudeConversationCapabilities,
      fsWriteRestriction: claudeConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: claudeConversationTranscriptProjection,
    },
    tasks: {
      execution: claudeTaskExecution,
      runner: deps.taskRunner,
      structuredOutput: "post_validation",
      transcript: claudeTaskTranscriptProjection,
      fsWriteRestriction: claudeTaskFsWriteRestriction,
    },
    managedSkills: { conversations: "bundled", tasks: "bundled" },
    nativeMemory: claudeNativeMemory,
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
