import type {
  AgentBackendDescriptor,
  AgentBackendMetadata,
  BackendConversationCapabilities,
  BackendConversationTranscriptProjection,
  BackendModelInfo,
  BackendTaskTranscriptProjection,
} from "../descriptor";
import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import type { BackendRuntimeConfigAdapter } from "../runtime-config";
import type { AgentTaskRunner } from "../task";
import type { AgentFailureClassifier } from "../errors";
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";
import {
  getDefaultCodexModel,
  getCodexReasoningLevelsForModel,
} from "../schemas";
import { CODEX_DEFAULT_STALL_TIMEOUT_MS } from "./shared";

function codexModel(
  id: string,
  label: string,
  description: string,
): BackendModelInfo {
  return {
    id,
    label,
    description,
    effortLevels: getCodexReasoningLevelsForModel(id) ?? [],
  };
}

/**
 * Backend catalog metadata for Codex — the single source for model labels,
 * descriptions, tone, and skill-trigger prefix rendered by the UI catalog.
 * Model ids and reasoning levels stay sourced from the validation schemas in
 * `../schemas` so catalog and validation cannot drift.
 */
export const codexBackendMetadata: AgentBackendMetadata = {
  label: "Codex",
  toneToken: "violet",
  skillTriggerPrefix: "$",
  models: [
    codexModel("gpt-5.6-sol", "GPT-5.6 Sol", "Flagship"),
    codexModel("gpt-5.6-terra", "GPT-5.6 Terra", "Balanced"),
    codexModel("gpt-5.6-luna", "GPT-5.6 Luna", "Fast & affordable"),
    codexModel("gpt-5.5", "GPT-5.5", "Previous flagship"),
    codexModel("gpt-5.4", "GPT-5.4", "Previous generation"),
    codexModel("gpt-5.4-mini", "GPT-5.4 Mini", "Balanced"),
    codexModel("gpt-5.4-nano", "GPT-5.4 Nano", "Fastest"),
    codexModel(
      "gpt-5.3-codex-spark",
      "GPT-5.3 Codex Spark",
      "Ultra-fast coding model",
    ),
  ],
  defaultModelId: getDefaultCodexModel(),
  defaultTimeoutMs: null,
  // Codex turns stream thread events steadily (reasoning, command start/end),
  // so dead air beyond a long command's duration means the model stream hung
  // (incident 2026-07-18: 9h37m of silence from a live process with no
  // whole-turn timeout configured). 20 minutes is ~2x the longest observed
  // legitimate quiet gap (a full pre-merge gate run as one command).
  defaultStallTimeoutMs: CODEX_DEFAULT_STALL_TIMEOUT_MS,
};

export const codexConversationCapabilities: BackendConversationCapabilities = {
  queue: { acceptsWhileRunning: true, deliveryTiming: "next_turn" },
  continuationStrength: "synthetic_thread",
  fork: "synthetic",
  structuredOutput: "backend_native",
  contextWindowMetrics: false,
  nativeMidTurnAskUser: false,
  externalTurns: false,
  capabilityKinds: [
    { kind: "skills", applyTiming: "next_turn" },
    { kind: "plugins", applyTiming: "next_turn" },
  ],
};

export const codexConversationTranscriptProjection: BackendConversationTranscriptProjection =
  {
    persistContentEvents: true,
    projectBackendInit: ({ timestamp, backendRef }) => ({
      timestamp,
      type: "system",
      raw: {
        subtype: "init",
        backend: backendRef.backend,
        thread_id: backendRef.ref,
      },
    }),
    projectTurnResult: (input) => ({
      timestamp: input.timestamp,
      type: "result",
      raw: {
        backend: input.backendRef?.backend ?? "codex",
        backendRef: input.backendRef,
        durationMs: input.durationMs,
        numTurns: input.numTurns,
        contextTokens: input.contextTokens,
        contextWindowMax: input.contextWindowMax,
        // Thread-cumulative, matching every pre-existing codex frame — the
        // usage projector reads this as cumulative-per-lineage.
        costUsd: input.cumulativeCostUsd ?? input.costUsd,
        turnCostUsd: input.costUsd,
        aborted: input.aborted,
        error: input.error,
      },
    }),
  };

export const codexTaskTranscriptProjection: BackendTaskTranscriptProjection = {
  projectAssistantMetadata: (backendRef) =>
    backendRef === null
      ? undefined
      : { backend: backendRef.backend, threadId: backendRef.ref },
};

/**
 * Codex confines a restricted task run with its native sandbox: workspace-write
 * with the writable roots set to exactly the policy allowlist.
 *
 * Exported as a literal (not read off the descriptor) because the descriptor
 * carries the server-only runner while definition validate runs client-side.
 */
export const codexTaskFsWriteRestriction = "enforced" as const;

/**
 * The same claim for a CONVERSATION turn: the conversation runtime replaces
 * danger-full-access with a `workspace-write` sandbox whose writable roots are
 * exactly the delivered allowlist, moves the run out of the target worktree,
 * and fails the turn for a policy it cannot establish. Graph-workflow
 * implementers dispatch through this path, so this is the declaration that
 * gates them.
 */
export const codexConversationFsWriteRestriction = "enforced" as const;

export interface CodexDescriptorDeps {
  conversationFactory: ConversationBackendFactory;
  /** `createCodexContinuityAdapter(...)` in production; injected so the
   * conformance suite can drive it against fake seed-builder ports. */
  continuity: BackendContinuityAdapter;
  /** `createCodexRuntimeConfigAdapter()` in production; injected because the
   * adapter is server-only while this module's literals are client-imported. */
  runtimeConfig: BackendRuntimeConfigAdapter;
  taskRunner: AgentTaskRunner;
  prepareManagedSkillsCheckout(checkoutPath: string): Promise<void>;
  /** `codexMcpCapabilities` in production; injected because the MCP registry
   * module is server-only while this module's literals are client-imported. */
  mcp: McpBackendCapabilities;
  failureClassifier: AgentFailureClassifier;
}

export function createCodexBackendDescriptor(
  deps: CodexDescriptorDeps,
): AgentBackendDescriptor {
  return {
    id: "codex",
    metadata: codexBackendMetadata,
    conversation: {
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: codexConversationCapabilities,
      fsWriteRestriction: codexConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: codexConversationTranscriptProjection,
    },
    tasks: {
      runner: deps.taskRunner,
      structuredOutput: "backend_native",
      transcript: codexTaskTranscriptProjection,
      fsWriteRestriction: codexTaskFsWriteRestriction,
    },
    managedSkills: {
      conversations: "bundled",
      tasks: "bundled",
      prepareCheckout: deps.prepareManagedSkillsCheckout,
    },
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
