import type { BackendCapabilityCatalogFacet } from "../capability-catalog";
import { CURSOR_BACKGROUND_WARNING } from "./background-tasks";
import type {
  ConversationExecutionPolicy,
  TaskExecutionPolicy,
} from "../execution-admission";
import type {
  AgentBackendDescriptor,
  AgentBackendMetadata,
  BackendModelCatalogFacet,
  BackendConversationCapabilities,
  BackendConversationTranscriptProjection,
} from "../descriptor";
import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import type { BackendRuntimeConfigAdapter } from "../runtime-config";
import type { AgentFailureClassifier } from "../errors";
import type { AgentTaskRunner } from "../task";
import type { McpBackendCapabilities } from "@/lib/agent-backends/mcp-capabilities";
import {
  listNativeMemoryExceptions,
  type BackendNativeMemory,
} from "../native-memory";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { CURSOR_DEFAULT_MODEL } from "./model-policy";
import { CURSOR_TURN_STALL_TIMEOUT_MS } from "./worker/bounds";

/**
 * The registered Cursor descriptor (spec D4, R2.2).
 *
 * Everything neutral Command Center knows about Cursor is here, and every
 * declaration is bounded by evidence the Phase 1 adapter actually produced.
 * The negative claims are the load-bearing ones: consumers gate on them
 * instead of branching on backend identity, so an over-claim would not fail
 * loudly — it would quietly let a surface act on a capability that does not
 * exist.
 */

export const cursorConversationExecution: ConversationExecutionPolicy = {
  classes: ["ordinary-conversation", "governed-execution"],
  instructionDelivery: "user-message",
};

export const cursorTaskExecution: TaskExecutionPolicy = {
  classes: ["nongoverned-task", "governed-execution"],
  profiles: ["standard", "isolated-one-shot"],
  instructionDelivery: "user-message",
};

/**
 * Cursor is the honest exception: nothing in the SDK turns its memories off.
 * `AgentOptions` carries no memory field, and the only memory switch reachable
 * anywhere in the package (`memoryDefaultEnabled`) is a field of the
 * server-delivered feature config the client receives — an embedder cannot set
 * it. `settingSources: []`, which the Phase 1 worker already passes, suppresses
 * the ambient RULES layers; it is not a memory lever and is not claimed as one.
 *
 * This is a `none` declaration rather than an omission precisely so the two
 * disclosure surfaces can say it out loud. Revisit when the SDK grows a lever.
 */
/**
 * Cost disclosure (ticket #120). The provider bills per turn but never ties a
 * billing entry to the run that produced it, so per-turn cost is inferred; an
 * account without the usage API keeps cost unknown rather than estimated.
 */
export const CURSOR_BILLING_WARNING =
  "Cost is Cursor's billed charge, fetched after each turn and settled late when billing lags. Per-turn attribution is inferred from the provider's usage entries and can stay unknown; accounts without the usage API report no cost at all.";

export const cursorNativeMemory: BackendNativeMemory = {
  mechanism: "none",
  reason:
    "Cursor native memory cannot be disabled or verified through the SDK. CC shared-memory policy is instruction-only; native memory may remain active.",
};

/**
 * Backend catalog metadata for Cursor.
 *
 * The tone token is Cursor's identity accent in the UI, distinct from Claude's
 * cyan and Codex's violet. `amber` is the remaining design-system accent the
 * existing chip/toggle tone maps already resolve; a genuinely new colour would
 * need its own token set, which is a design-system change rather than a
 * registration one.
 */
export const cursorBackendMetadata: AgentBackendMetadata = {
  label: "Cursor",
  executionWarnings: [
    "Live steering accepts text; attachments and rejected input wait for the next turn. Unconfirmed deliveries require review. Mid-turn questions use CC's question tool and expire after five minutes; native Cursor questions are unavailable.",
    ...listNativeMemoryExceptions([
      {
        id: CURSOR_BACKEND_ID,
        label: "Cursor",
        nativeMemory: cursorNativeMemory,
      },
    ]).map(({ reason }) => reason),
    CURSOR_BACKGROUND_WARNING,
    "Network and native tool-approval limits are not enforced.",
    CURSOR_BILLING_WARNING,
  ],
  toneToken: "amber",
  skillTriggerPrefix: "/",
  models: [
    {
      id: CURSOR_DEFAULT_MODEL,
      label: "Composer 2.5",
      description: "Cursor's agent model",
      // Composer takes no reasoning-effort parameter, and an empty list is the
      // catalog's way of saying effort does not apply (see BackendModelInfo).
      effortLevels: [],
    },
  ],
  defaultModelId: CURSOR_DEFAULT_MODEL,
  defaultTimeoutMs: null,
  defaultStallTimeoutMs: CURSOR_TURN_STALL_TIMEOUT_MS,
};

/**
 * Cursor conversation capabilities.
 *
 * - `queue`: text can be steered into the running turn. Attachments and
 *   provider refusals use the next turn; unconfirmed deliveries require review.
 * - `continuationStrength: "precise_session"`: a Cursor agent id is a real,
 *   probeable handle the SDK issues at create — resume returns to that exact
 *   session rather than replaying a reconstructed thread.
 * - `fork: "synthetic"`: bounded transcript text seeds an independent agent
 *   and store; provider checkpoints and hidden state are not inherited.
 * - `structuredOutput: "post_validation"`: the shared contract is rendered into
 *   the prompt and validated afterwards; no native schema is forwarded.
 * - `contextWindowMetrics`, `nativeMidTurnAskUser`, `externalTurns`: the SDK
 *   surfaces no context-window figures, its interactive tools are denied by the
 *   Phase 1 policy, and it produces no turns Command Center did not start.
 * - Capability selection is fixed at conversation creation. CC supplies skill
 *   metadata and explicit agent definitions while ambient settings stay off.
 */
export const cursorConversationCapabilities: BackendConversationCapabilities = {
  queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },
  continuationStrength: "precise_session",
  fork: "synthetic",
  structuredOutput: "post_validation",
  // Public usage is billing, not occupancy. Enable only when the provider
  // exposes current tokens + effective window with post-compaction/resume
  // freshness; native summary observation alone cannot measure either.
  contextWindowMetrics: false,
  nativeMidTurnAskUser: false,
  externalTurns: false,
  // Disabled until backend-continuation-probes holds real continuation evidence.
  checkpoint: false,
  checkpointFork: false,
  handoffCapture: {
    available: false,
    mode: null,
    reason: "Capture is unavailable",
  },
  capabilityKinds: [
    {
      kind: "skills",
      applyTiming: "next_conversation",
      catalog: {
        discoverySupport: "available",
        runtimeVisibility: "source-only",
        compositionSupport: "translator",
        support: {
          configurable: true,
          notes: [
            "Skill selection is fixed for this conversation. Changes apply in a new conversation.",
          ],
        },
      },
    },
    {
      kind: "plugins",
      applyTiming: "next_conversation",
      catalog: {
        discoverySupport: "available",
        runtimeVisibility: "source-only",
        compositionSupport: "translator",
        support: {
          configurable: true,
          notes: [
            "Supported plugin skills and agents are available. Native hooks, rules, and plugin MCP are not delivered; configure needed servers in CC's MCP settings.",
            "Plugin selection is fixed for this conversation. Changes apply in a new conversation.",
          ],
        },
      },
    },
    {
      kind: "agents",
      applyTiming: "next_conversation",
      catalog: {
        discoverySupport: "available",
        runtimeVisibility: "source-only",
        compositionSupport: "translator",
        support: {
          configurable: true,
          notes: [
            "Agent definitions are fixed for this conversation. Changes apply in a new conversation.",
          ],
        },
      },
    },
  ],
};

/**
 * Cursor adds no Command Center-authored content frames around a turn.
 *
 * Its runtime persists every complete native SDK object as a lossless envelope
 * (D7), and those envelopes are already full transcript frames: content-worthy
 * events carry their visible blocks, and the usage event carries the turn's
 * token counts. Persisting the projected `content` events again would duplicate
 * every assistant block, and a token record in a result frame would compete
 * with the native usage record (D17).
 *
 * Billed COST is the one figure the native envelopes cannot carry — the
 * provider reports it through a separate endpoint, after the turn — so a turn
 * whose lineage has a billed figure leaves one result frame with the lineage
 * cumulative, the same shape every cost-reporting backend persists. A turn
 * without one (billing unavailable, or not yet settled) leaves nothing.
 */
export const cursorConversationTranscriptProjection: BackendConversationTranscriptProjection =
  {
    persistContentEvents: false,
    projectBackendInit: () => null,
    projectTurnResult: (input) =>
      input.cumulativeCostUsd === null
        ? null
        : {
            timestamp: input.timestamp,
            type: "result",
            raw: {
              backend: CURSOR_BACKEND_ID,
              backendRef: input.backendRef,
              costUsd: input.costUsd,
              cumulativeCostUsd: input.cumulativeCostUsd,
              numTurns: input.numTurns,
              durationMs: input.durationMs,
              aborted: input.aborted,
              error: input.error,
            },
          },
  };

/**
 * Cursor delivers filesystem limits as instructions. Its worker runs without
 * mechanical filesystem confinement. Literals keep capability disclosure
 * available to client consumers without importing the server-only factory.
 */
export const cursorConversationFsWriteRestriction = "instruction-only" as const;
export const cursorTaskFsWriteRestriction = "instruction-only" as const;

/** No native schema is forwarded for tasks either; the shared contract is
 *  rendered into the prompt and validated afterwards. */
export const cursorTaskStructuredOutput = "post_validation" as const;

/** Command Center's own skill bundle reaches both facets through the immutable
 *  managed bundle, not through ambient provider settings. */
export const cursorManagedSkills = {
  conversations: "bundled",
  tasks: "bundled",
} as const;

export interface CursorDescriptorDeps {
  taskRunner: AgentTaskRunner;
  capabilityCatalog?: BackendCapabilityCatalogFacet;
  conversationFactory: ConversationBackendFactory;
  modelCatalog: BackendModelCatalogFacet;
  /** `createCursorContinuityAdapter(...)` in production; injected so the
   *  conformance suite can drive it against a scripted worker transport. */
  continuity: BackendContinuityAdapter;
  runtimeConfig: BackendRuntimeConfigAdapter;
  /** `cursorMcpCapabilities` in production; injected because the MCP registry
   *  module is server-only while this module's literals are client-imported. */
  mcp: McpBackendCapabilities;
  failureClassifier: AgentFailureClassifier;
}

export function createCursorBackendDescriptor(
  deps: CursorDescriptorDeps,
): AgentBackendDescriptor {
  return {
    id: CURSOR_BACKEND_ID,
    capabilityCatalog: deps.capabilityCatalog,
    metadata: cursorBackendMetadata,
    modelCatalog: deps.modelCatalog,
    conversation: {
      execution: cursorConversationExecution,
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: cursorConversationCapabilities,
      fsWriteRestriction: cursorConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: cursorConversationTranscriptProjection,
    },
    tasks: {
      runner: deps.taskRunner,
      execution: cursorTaskExecution,
      structuredOutput: cursorTaskStructuredOutput,
      fsWriteRestriction: cursorTaskFsWriteRestriction,
      transcript: {
        projectAssistantMetadata: (backendRef) =>
          backendRef ? { backendRef } : undefined,
      },
    },
    managedSkills: cursorManagedSkills,
    nativeMemory: cursorNativeMemory,
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
